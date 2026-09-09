const crypto = require('crypto');
const approvals = require('../approvalRuleService');

const KEY = { moduleCode: 'sales', pageCode: 'sales-orders', actionCode: 'approve' };
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
async function lockSalesOrder(tx, soNumber) {
  // The same lock is used by editing, attachments, submission and decisions.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sales-order:${soNumber}`}))`;
}
function assertDraftInput(body = {}) {
  if (body.status != null && body.status !== 'Draft') throw fail('Status SO hanya dapat diubah melalui workflow approval.', 400);
}
function fingerprint(doc) {
  const header = ['soNumber','customerPoNumber','soDate','quotationNumber','customerCode','customerName','contact','phone','email','billingAddress','shippingAddress','paymentTerms','taxId','currencyCode','deliveryDate','totalAmount','notes'];
  const detail = ['id','partCode','qty','unitPrice','discount','discountType','tax','totalAmount','deliveryDate'];
  return crypto.createHash('sha256').update(JSON.stringify({
    header: header.map(key => doc[key] ?? null),
    details: (doc.details || []).map(row => ({ values: detail.map(key => row[key] ?? null), targets: (row.deliveryTargets || []).map(t => [t.id,t.targetDate,t.qty]) })),
    attachments: (doc.attachments || []).map(a => [a.id,a.files]).sort((a,b) => a[0].localeCompare(b[0])),
  })).digest('hex');
}
function assertRule(rule) {
  if (!rule || rule.steps.length < 2 || !rule.requireSequential || rule.allowSelfApproval) {
    throw fail('Konfigurasikan approval SO sales/sales-orders: minimal dua tahap aktif, berurutan, tanpa self approval.');
  }
}
async function activeRequest(tx, doc) {
  return tx.approvalRequest.findFirst({ where: { ...KEY, documentId: doc.id, isDeleted: false, status: { in: approvals.ACTIVE_REQUEST_STATUSES } }, include: approvals.REQUEST_INCLUDE });
}
async function notify(tx, doc, request, actor, action) {
  const recipients = new Set(request.requestedByUserId ? [request.requestedByUserId] : []);
  if (approvals.ACTIVE_REQUEST_STATUSES.includes(request.status)) {
    const open = approvals.incompleteSteps(request);
    const next = open.filter(step => step.stepOrder === Math.min(...open.map(s => s.stepOrder)));
    const users = await tx.user.findMany({ where: { isDeleted: false, partnerAccess: { is: null } }, select: { id: true, username: true, email: true, isSuperAdmin: true, listMenu: true } });
    for (const user of users) {
      if (user.id === request.requestedByUserId && !approvals.isDemoSalesOrderApproval(request)) continue;
      for (const step of next) if (await approvals.canApproveStep(user, request, step, tx)) { recipients.add(user.id); break; }
    }
  }
  const result = [];
  for (const userId of recipients) result.push(await tx.notification.create({ data: {
    type: 'sales_order', title: `Sales Order ${action}`, message: `${doc.soNumber}: ${action}. Status ${doc.status}${approvals.ACTIVE_REQUEST_STATUSES.includes(request.status) ? `, tahap ${request.currentStep}` : ''}.`,
    entityId: doc.soNumber, entityUrl: `/modules/sales/sales-orders/${encodeURIComponent(doc.soNumber)}`, userId,
    metadata: { requestNumber: request.requestNumber, status: doc.status, step: request.currentStep }, createdBy: actor?.username || actor?.email || 'system',
  } }));
  return result;
}
function broadcast(notifications) {
  for (const notification of notifications || []) global.io?.to(`user:${notification.userId}`).emit('notification', notification);
}
async function submit(tx, doc, user) {
  if (doc.status !== 'Draft') throw fail('Hanya SO Draft yang dapat diajukan.');
  if (await activeRequest(tx, doc)) throw fail('SO sudah memiliki approval aktif.');
  const context = { ...Object.fromEntries(Object.entries(doc).filter(([key]) => !['details','attachments','deliverySchedules','customer','currency','quotation'].includes(key))), source: 'sales-order-workflow-v1', fingerprint: fingerprint(doc) };
  const rule = await approvals.resolveApprovalRule({ ...KEY, documentType: 'SalesOrderHeader', amount: doc.totalAmount, currencyCode: doc.currencyCode, context, tx });
  assertRule(rule);
  const request = await approvals.createApprovalRequest({ ...KEY, rule, documentType: 'SalesOrderHeader', documentId: doc.id, documentNumber: doc.soNumber, amount: doc.totalAmount, currencyCode: doc.currencyCode, context: JSON.parse(JSON.stringify(context)), requestedByUserId: user?.id, requestedBy: user?.username || user?.email, tx });
  const updated = await tx.salesOrderHeader.update({ where: { id: doc.id }, data: { status: 'In Approval' } });
  return { document: updated, request, notifications: await notify(tx, updated, request, user, 'diajukan') };
}
async function decide(tx, doc, user, decision, notes, postConfirm) {
  if (doc.status !== 'In Approval') throw fail('SO harus diajukan sebelum approval.');
  const request = await activeRequest(tx, doc);
  if (!request || request.context?.source !== 'sales-order-workflow-v1' || request.context?.fingerprint !== fingerprint(doc)) throw fail('Versi SO berbeda dari dokumen yang diajukan; approval diblokir.');
  assertRule(request.rule);
  if (!approvals.isDemoSalesOrderApproval(request) && request.actions.some(action => action.action === 'Approved' && action.actedByUserId === user?.id && action.stepOrder !== request.currentStep)) throw fail('Tahap berikutnya harus disetujui pengguna yang berbeda.', 403);
  if (decision === 'Rejected' && !String(notes || '').trim()) throw fail('Alasan penolakan wajib diisi.', 400);
  const result = await approvals.processApprovalAction({ requestId: request.id, user, decision, notes, tx, deferFinalDocumentStatus: true });
  let document = doc;
  if (result.final && decision === 'Approved') document = await postConfirm(tx, doc);
  else if (result.final) document = await tx.salesOrderHeader.update({ where: { id: doc.id }, data: { status: 'Draft', approvedBy: null, approvedDate: null } });
  return { document, request: result.request, final: result.final, notifications: await notify(tx, document, result.request, user, decision === 'Rejected' ? 'dikembalikan untuk revisi' : result.final ? 'dikonfirmasi' : 'disetujui tahap berikutnya') };
}
async function withdraw(tx, doc, user, notes) {
  const request = await activeRequest(tx, doc);
  if (doc.status !== 'In Approval' || !request) throw fail('Approval aktif tidak ditemukan.');
  if (request.requestedByUserId !== user?.id && !user?.isSuperAdmin) throw fail('Hanya pengaju atau administrator yang dapat menarik pengajuan.', 403);
  if (!String(notes || '').trim()) throw fail('Alasan penarikan wajib diisi.', 400);
  await tx.approvalAction.create({ data: { requestId: request.id, stepOrder: request.currentStep, action: 'Cancelled', actedByUserId: user?.id, actedBy: user?.username || user?.email, notes } });
  const cancelled = await tx.approvalRequest.update({ where: { id: request.id }, data: { status: 'Cancelled', completedAt: new Date() }, include: approvals.REQUEST_INCLUDE });
  const document = await tx.salesOrderHeader.update({ where: { id: doc.id }, data: { status: 'Draft' } });
  return { document, request: cancelled, notifications: await notify(tx, document, cancelled, user, 'pengajuan ditarik') };
}
module.exports = { KEY, lockSalesOrder, assertDraftInput, fingerprint, assertRule, submit, decide, withdraw, broadcast };
