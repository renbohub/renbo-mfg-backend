"use strict";
const { createHash } = require('node:crypto');
const { businessNow } = require('../../utils/businessClock');
const { assertPeriodOpen } = require('./periodClosingService');
const { resolveRoutingExecutionPolicy, loadRoutingExecutionContext, executionPolicyErrorsForSelection } = require('./routingExecutionPolicy');
const { buildCapacitySnapshot } = require('./capacityPlanningService');
const { buildMaterialReadinessSnapshot } = require('./materialReadinessService');
const { syncVendorProcessDraftPrForPlan } = require('./vendorProcessPrService');
const { isDiscreteUom } = require('../../utils/uomQuantity');

const TYPE = 'MONTHLY_PLAN_EXECUTOR';
const EPS = 0.000001;
const active = row => row && !row.isDeleted && !['Cancelled', 'Canceled'].includes(row.status);
const day = value => value ? new Date(value).toISOString().slice(0, 10) : null;
const plain = value => JSON.parse(JSON.stringify(value));
const fail = (message, code = 'EXECUTOR_INVALID', statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const issue = (code, message) => ({ code, message });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const routeInclude = { process: true, machine: true, mbomDetail: { include: { part: true, children: { where: { isDeleted: false }, include: { part: true } } } } };
const allocationsWhere = planId => ({ planId, isDeleted: false, status: { in: ['Draft', 'Published'] }, planningMode: 'PRODUCTION' });

async function affectedDocuments(db, allocation, successors = []) {
  if (!allocation) return [];
  const { isVendorPrProtected } = require('./vendorProcessPrService');
  const live = row => row && !row.isDeleted && !['CANCELLED', 'CANCELED', 'REJECTED'].includes(String(row.status || '').toUpperCase());
  const scoped = [allocation, ...successors];
  const ids = [...new Set(scoped.map(row => row.id))];
  const planIds = [...new Set(scoped.map(row => row.planId).filter(Boolean))];
  const plans = await db.monthlyProductionPlan.findMany({ where: { id: { in: planIds } }, select: { id: true, planNumber: true } });
  const planNumberById = new Map(plans.map(row => [row.id, row.planNumber]));
  const monthlyOrders = await db.manufacturingOrder.findMany({ where: { monthlyProductionPlanNumber: { in: plans.map(row => row.planNumber) } }, select: { id: true, monthlyProductionPlanNumber: true } });
  const routeScope = scoped.filter(row => row.mbomProcessId && planNumberById.has(row.planId)).map(row => ({
    mbomProcessId: row.mbomProcessId,
    moId: { in: monthlyOrders.filter(mo => mo.monthlyProductionPlanNumber === planNumberById.get(row.planId)).map(mo => mo.id) },
  }));
  const logEvidence = { where: { isDeleted: false, status: { notIn: ['Cancelled', 'Canceled', 'Rejected'] } }, select: { id: true } };
  const [details, schedules, vendorOrders, workOrders] = await Promise.all([
    db.purchaseRequisitionDetail.findMany({ where: { OR: [
      { sources: { some: { sourceType: 'CAPACITY_ALLOCATION', sourceNumber: { in: ids } } } },
      ...ids.map(id => ({ notes: { contains: `[CAPACITY-ALLOCATION:${id}]` } })),
    ] }, include: { pr: { include: { purchaseOrders: { include: { po: true } } } }, poDetails: { include: { po: true } }, sourcingAllocations: true } }),
    db.dailyProductionSchedule.findMany({ where: { OR: [
      { productionPlanAllocationId: { in: ids } },
      // Fallback for old generated schedules without allocation FK.
      ...scoped.map(row => ({ productionPlanId: row.planId, mbomProcessId: row.mbomProcessId, productionPlanAllocationId: null })),
    ] }, include: { productionLogs: logEvidence } }),
    db.vendorProcessOrder.findMany({ where: { OR: [
      ...ids.map(id => ({ notes: { contains: `[CAPACITY-VENDOR:${id}]` } })),
      // Old BOM-generated orders do not have an allocation marker. Their exact
      // Monthly Plan MO + routing occurrence still reserves this process.
      ...routeScope.map(scope => ({ ...scope, OR: [{ notes: null }, { notes: { not: { contains: '[CAPACITY-VENDOR:' } } }] })),
    ] } }),
    routeScope.length ? db.workOrder.findMany({ where: { OR: routeScope }, include: { productionLogs: logEvidence } }) : [],
  ]);
  const workOrderIds = [...new Set([...workOrders.map(row => row.id), ...schedules.map(row => row.woId)].filter(Boolean))];
  const issueScope = [
    ...(workOrderIds.length ? [{ woId: { in: workOrderIds } }] : []),
    ...schedules.map(row => ({ notes: { contains: `[DPS-CONSUME:${row.scheduleNumber}]` } })),
  ];
  const materialIssues = issueScope.length ? await db.materialIssue.findMany({ where: { OR: issueScope }, include: { details: true } }) : [];
  const docs = [];
  const add = (type, row, number, url, blocking, executed = false) => docs.push({ type, id: row.id, number, status: row.status, updatedAt: row.updatedAt, url, blocking, executed });
  for (const detail of details) {
    for (const row of detail.poDetails) if (live(row) && live(row.po) || Number(row.qtyReceived) > EPS) add('PO Vendor', row.po, row.poNumber, `/modules/purchasing/purchase-order/${encodeURIComponent(row.poNumber)}`, true, Number(row.qtyReceived) > EPS);
    for (const link of detail.pr.purchaseOrders || []) if (live(link.po)) add('PO Vendor', link.po, link.po.poNumber, `/modules/purchasing/purchase-order/${encodeURIComponent(link.po.poNumber)}`, true);
    const protectedPr = isVendorPrProtected({ ...detail.pr, details: [detail] });
    if (live(detail) && live(detail.pr) || protectedPr) add('PR Vendor', detail.pr, detail.prNumber, `/modules/purchasing/purchase-requisitions/${encodeURIComponent(detail.prNumber)}`, protectedPr);
  }
  for (const row of schedules) {
    const executed = Number(row.actualQty) > EPS || row.productionLogs.length > 0;
    if (live(row) || executed) add('Daily Plan', row, row.scheduleNumber, `/modules/production/daily-production-schedules/${encodeURIComponent(row.scheduleNumber)}`, row.status !== 'Draft' || executed, executed);
  }
  for (const row of vendorOrders) {
    const executed = Number(row.qtySent) > EPS || Number(row.qtyReceived) > EPS || Boolean(row.sentAt);
    if (live(row) || executed) add('Order Vendor', row, row.orderNumber, `/modules/production/vendor-process-orders/${encodeURIComponent(row.orderNumber)}`, true, executed);
  }
  for (const row of workOrders) {
    const executed = Number(row.qtyProduced) > EPS || Boolean(row.startTime) || row.productionLogs.length > 0;
    if (live(row) || executed) add('Work Order', row, row.woNumber, `/modules/production/work-orders/${encodeURIComponent(row.woNumber)}`, !['Draft', 'Planned'].includes(row.status) || executed, executed);
  }
  for (const row of materialIssues) {
    // Cancellation of a Daily Plan does not reverse its issued inventory.
    const issued = row.details.reduce((sum, detail) => sum + Math.max(Number(detail.qtyIssued || 0) - Number(detail.qtyReturned || 0), 0), 0);
    const executed = issued > EPS || (!row.details.length && ['Issued', 'Partially Returned', 'Closed'].includes(row.status));
    if (live(row) || executed) add('Material Issue', row, row.issueNumber, `/modules/inventory/material-issues/${encodeURIComponent(row.issueNumber)}`, true, executed);
  }
  const unique = new Map();
  for (const row of docs) {
    const key = `${row.type}:${row.id}`, previous = unique.get(key);
    unique.set(key, { ...row, blocking: row.blocking || Boolean(previous?.blocking), executed: row.executed || Boolean(previous?.executed) });
  }
  return [...unique.values()].sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));
}

async function loadContext(db, planNumber, input = {}) {
  const plan = await db.monthlyProductionPlan.findFirst({ where: { planNumber, isDeleted: false }, include: { details: { where: { isDeleted: false } } } });
  if (!plan) throw fail('Monthly Plan tidak ditemukan.', 'EXECUTOR_PLAN_NOT_FOUND', 404);
  const allocations = await db.productionPlanAllocation.findMany({ where: allocationsWhere(plan.id), orderBy: { id: 'asc' } });
  const source = input.allocationId ? allocations.find(row => row.id === input.allocationId) : null;
  if (input.allocationId && !source) throw fail('Alokasi sudah berubah. Muat ulang Monthly Plan.', 'EXECUTOR_SOURCE_CHANGED');
  const lineNumber = source?.lineNumber || Number(input.lineNumber);
  const mbomProcessId = source?.mbomProcessId || input.mbomProcessId;
  if (source && (input.lineNumber && Number(input.lineNumber) !== source.lineNumber || input.mbomProcessId && input.mbomProcessId !== source.mbomProcessId)) throw fail('Identitas batch/proses tidak sesuai alokasi sumber.');
  const line = plan.details.find(row => row.lineNumber === lineNumber && row.status !== 'Cancelled');
  if (!line || !mbomProcessId) throw fail('Pilih child part/proses pada Monthly Plan.');
  const route = await db.mBOMProcess.findFirst({ where: { id: mbomProcessId, isDeleted: false }, include: routeInclude });
  if (!route) throw fail('Routing BOM tidak tersedia.');
  if (!source && route.mbomDetail?.partId !== line.partId && route.mbomDetail?.part?.partCode !== line.partCode) throw fail('Routing tidak sesuai child part pada plan.');
  const peers = allocations.filter(row => row.lineNumber === lineNumber && row.mbomProcessId === mbomProcessId);
  const qty = source ? Number(source.plannedQty) : Math.max(Number(line.qtyPlanned) - peers.reduce((sum, row) => sum + Number(row.plannedQty), 0), 0);
  const successors = source ? await db.productionPlanAllocation.findMany({ where: { isDeleted: false, status: { in: ['Draft', 'Published'] }, planningMode: 'PRODUCTION', predecessorAllocationIds: { array_contains: [source.id] } }, orderBy: { id: 'asc' } }) : [];
  const [masters, documents, sessions] = await Promise.all([
    loadRoutingExecutionContext(db), affectedDocuments(db, source, successors),
    db.capacityEditSession.count({ where: { planId: plan.id, status: 'OPEN' } }),
  ]);
  const policy = resolveRoutingExecutionPolicy(route, { ...masters, period: { start: plan.periodStart, end: plan.periodEnd } });
  const scope = { allocationId: source?.id || null, lineNumber, mbomProcessId, partCode: route.mbomDetail?.part?.partCode || line.partCode, partName: route.mbomDetail?.part?.partName, processCode: route.occurrenceCode || route.process?.processCode, processName: route.process?.processName, qty, uomCode: line.uomCode };
  const relatedPlans = successors.length ? await db.monthlyProductionPlan.findMany({ where: { id: { in: [...new Set(successors.map(row => row.planId).filter(id => id !== plan.id))] } } }) : [];
  return { plan, source, line, route, allocations, peers, successors, relatedPlans, masters, documents, sessions, policy, scope };
}

function publicContext(ctx) {
  const eligibleMachines = new Set((ctx.policy.machinePolicy?.resources || []).map(row => row.machineId));
  return { planNumber: ctx.plan.planNumber, planUpdatedAt: ctx.plan.updatedAt, scope: ctx.scope, currentAllocations: ctx.source ? [ctx.source] : ctx.peers,
    policy: { defaultMode: ctx.policy.defaultMode, allowedModes: ctx.policy.allowedModes, allowSplit: ctx.policy.allowSplit, errors: ctx.policy.globalErrors || ctx.policy.errors, errorsByMode: ctx.policy.errorsByMode, errorsByVendor: ctx.policy.errorsByVendor, bomNoReg: ctx.route.noReg },
    machines: ctx.masters.machines.filter(row => eligibleMachines.has(row.id)), machineResources: ctx.policy.machinePolicy?.resources || [], vendors: ctx.masters.vendors.filter(row => ctx.policy.eligibleVendorIds.includes(row.id)),
    dies: ctx.masters.dies.filter(row => row.status === 'Active'), shifts: ['1', '2', '3'], periodStart: ctx.plan.periodStart, periodEnd: ctx.plan.periodEnd,
    affectedDocuments: ctx.documents, requiresReplan: requiresReplan(ctx),
  };
}
function requiresReplan(ctx) { return ctx.source?.status === 'Published' || ctx.successors.some(row => row.status === 'Published') || [ctx.plan, ...ctx.relatedPlans].some(plan => ['Released', 'In Progress'].includes(plan.status)) || ctx.documents.some(row => row.blocking || row.type === 'PR Vendor'); }

function parseDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail(`${label} harus diisi.`, 'EXECUTOR_DATE', 400);
  const result = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(result.getTime()) || day(result) !== value) throw fail(`${label} tidak valid.`, 'EXECUTOR_DATE', 400);
  return result;
}

function normalizeProposal(ctx, input) {
  if (!String(input.reason || '').trim()) throw fail('Isi alasan perubahan pelaksana.', 'EXECUTOR_REASON', 400);
  if (!Array.isArray(input.allocations) || !input.allocations.length || input.allocations.length > 30) throw fail('Isi 1–30 pembagian batch.', 'EXECUTOR_SPLIT', 400);
  const allocations = input.allocations.map(row => {
    const routingMode = String(row.routingMode || '').toUpperCase();
    if (!ctx.policy.allowedModes.includes(routingMode)) throw fail('Pelaksana ini belum diizinkan di BOM. Atur alternatif pada routing BOM terlebih dahulu.', 'EXECUTOR_MODE_NOT_ALLOWED');
    const plannedQty = Number(row.plannedQty);
    if (!Number.isFinite(plannedQty) || plannedQty <= 0 || isDiscreteUom(ctx.scope.uomCode) && !Number.isInteger(plannedQty)) throw fail('Qty harus lebih dari nol dan berupa bilangan bulat untuk PCS.', 'EXECUTOR_QTY', 400);
    const scheduleDate = parseDate(routingMode === 'VENDOR' ? row.vendorSendDate || row.scheduleDate : row.scheduleDate, routingMode === 'VENDOR' ? 'Tanggal kirim' : 'Tanggal produksi');
    const vendorReturnDate = routingMode === 'VENDOR' ? parseDate(row.vendorReturnDate, 'ETA kembali') : null;
    if (day(scheduleDate) < day(ctx.plan.periodStart) || day(scheduleDate) > day(ctx.plan.periodEnd)) throw fail('Tanggal mulai harus berada dalam periode Monthly Plan.', 'EXECUTOR_PERIOD');
    if (vendorReturnDate && vendorReturnDate < scheduleDate) throw fail('ETA kembali tidak boleh sebelum tanggal kirim.', 'EXECUTOR_DATE', 400);
    const resource = routingMode === 'INHOUSE' ? ctx.policy.machinePolicy?.resources.find(item => item.machineId === row.machineId) : null;
    if (routingMode === 'INHOUSE' && !resource) throw fail('Mesin belum dikualifikasi pada aturan mesin/tooling BOM.', 'EXECUTOR_MACHINE');
    if (routingMode === 'VENDOR' && !ctx.policy.eligibleVendorIds.includes(row.vendorId)) throw fail('Vendor belum diizinkan pada proses BOM ini.', 'EXECUTOR_VENDOR');
    if (routingMode === 'INHOUSE' && !['1', '2', '3'].includes(String(row.shift))) throw fail('Pilih shift produksi.', 'EXECUTOR_SHIFT', 400);
    if (row.diesId && resource && row.diesId !== resource.diesId) throw fail('Dies harus mengikuti pasangan mesin/tooling yang dikualifikasi di BOM.', 'EXECUTOR_DIES');
    const original = ctx.source;
    const sameWindow = original && original.routingMode === routingMode && day(original.scheduleDate) === day(scheduleDate) && (routingMode === 'VENDOR'
      ? original.vendorId === row.vendorId && day(original.vendorReturnDate) === day(vendorReturnDate)
      : original.machineId === row.machineId && String(original.shift) === String(row.shift));
    return { routingMode, plannedQty, scheduleDate, shift: routingMode === 'VENDOR' ? 'VENDOR' : String(row.shift), machineId: resource?.machineId || null, diesId: resource?.diesId || null, vendorId: routingMode === 'VENDOR' ? row.vendorId : null,
      plannedStartTime: sameWindow ? original.plannedStartTime || null : null, plannedEndTime: sameWindow ? original.plannedEndTime || null : null, capacityMode: sameWindow ? original.capacityMode || null : null,
      vendorSendDate: routingMode === 'VENDOR' ? scheduleDate : null, vendorReturnDate, vendorLeadTimeDays: vendorReturnDate ? Math.ceil((vendorReturnDate - scheduleDate) / 86400000) : null, expectedReturnQty: vendorReturnDate ? plannedQty : null,
    };
  });
  if (Math.abs(allocations.reduce((sum, row) => sum + row.plannedQty, 0) - ctx.scope.qty) > EPS) throw fail(`Total pembagian harus tepat ${ctx.scope.qty} ${ctx.scope.uomCode || ''}.`, 'EXECUTOR_QTY_CONSERVATION', 400);
  if (new Set(allocations.map(row => row.routingMode)).size > 1 && !ctx.policy.allowSplit) throw fail('Pembagian in-house dan vendor belum diizinkan pada BOM.', 'EXECUTOR_SPLIT_NOT_ALLOWED');
  const internalMachines = new Set(allocations.filter(row => row.routingMode === 'INHOUSE').map(row => row.machineId));
  if (internalMachines.size > 1 && ctx.policy.machinePolicy?.mode !== 'PARALLEL') throw fail('Routing ini hanya mengizinkan satu mesin utama per batch.', 'EXECUTOR_PARALLEL_NOT_ALLOWED');
  return { allocationId: ctx.scope.allocationId, lineNumber: ctx.scope.lineNumber, mbomProcessId: ctx.scope.mbomProcessId, reason: String(input.reason).trim(), allocations };
}

function previewToken(ctx, proposal) {
  return hash(plain({ proposal, plan: ctx.plan.updatedAt, relatedPlans: ctx.relatedPlans, route: ctx.route.updatedAt, policy: ctx.policy, allocations: ctx.allocations, successors: ctx.successors, documents: ctx.documents, machines: ctx.masters.machines, dies: ctx.masters.dies, vendors: ctx.masters.vendors }));
}

async function replaceAllocations(tx, ctx, proposal, actor, preview = false) {
  if (ctx.source) await tx.productionPlanAllocation.update({ where: { id: ctx.source.id }, data: { status: 'Cancelled', isDeleted: true } });
  const ids = [ctx.source?.id, ...ctx.successors.map(row => row.id)].filter(Boolean);
  if (ids.length) await tx.dailyProductionSchedule.updateMany({ where: { productionPlanAllocationId: { in: ids }, isDeleted: false, ...(preview ? {} : { status: 'Draft' }), actualQty: 0, productionLogs: { none: { isDeleted: false, status: { not: 'Cancelled' } } } }, data: { status: 'Cancelled', isDeleted: true } });
  const created = [];
  for (const row of proposal.allocations) {
    const source = ctx.source || ctx.line;
    created.push(await tx.productionPlanAllocation.create({ data: {
      ...row, planId: ctx.plan.id, lineNumber: ctx.scope.lineNumber, mbomProcessId: ctx.scope.mbomProcessId, uomCode: ctx.scope.uomCode,
      status: 'Draft', planningMode: 'PRODUCTION', allocationSource: 'EXECUTOR_CHANGE', createdBy: actor,
      deliveryPhaseId: source.deliveryPhaseId || null, deliveryPhaseNumber: source.deliveryPhaseNumber || null, transferBatchNumber: source.transferBatchNumber || null,
      predecessorAllocationIds: ctx.source?.predecessorAllocationIds || undefined,
      demandSourceType: source.demandSourceType || null, demandSourceNumber: source.demandSourceNumber || null, customerCode: source.customerCode || null,
      customerTargetDate: source.customerTargetDate || null, fgRequiredDate: source.fgRequiredDate || null, priorityScore: source.priorityScore || null, priorityClass: source.priorityClass || null,
      latestStartDate: source.latestStartDate || null, latestFinishDate: source.latestFinishDate || null,
      notes: `[EXECUTOR-CHANGE:${ctx.source?.id || 'UNALLOCATED'}] ${proposal.reason}`,
    } }));
  }
  for (const successor of ctx.successors) {
    const refs = [...new Set(successor.predecessorAllocationIds.flatMap(id => id === ctx.source.id ? created.map(row => row.id) : [id]))];
    await tx.productionPlanAllocation.update({ where: { id: successor.id }, data: { predecessorAllocationIds: refs, ...(successor.status === 'Published' ? { status: 'Draft', publishedAt: null, publishedBy: null } : {}) } });
  }
  return created;
}

function basicBlockers(ctx, proposal) {
  const blockers = executionPolicyErrorsForSelection(ctx.policy, proposal.allocations).map(message => issue('EXECUTOR_BOM_POLICY', message));
  if (!['Draft', 'Confirmed', 'Released', 'In Progress'].includes(ctx.plan.status)) blockers.push(issue('EXECUTOR_PLAN_STATUS', `Plan berstatus ${ctx.plan.status} tidak dapat diubah.`));
  if (ctx.sessions) blockers.push(issue('EXECUTOR_EDITOR_OPEN', 'Selesaikan atau batalkan draft editor kapasitas sebelum mengubah pelaksana.'));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(businessNow());
  if (ctx.source && day(ctx.source.scheduleDate) < today || proposal.allocations.some(row => day(row.scheduleDate) < today)) blockers.push(issue('EXECUTOR_HISTORY_LOCKED', 'Alokasi pada tanggal lampau sudah menjadi histori produksi.'));
  const frozen = (plan, dates) => {
    const fence = new Date(`${today}T00:00:00.000Z`);
    fence.setUTCDate(fence.getUTCDate() + Math.max(Math.trunc(Number(plan.freezeFenceDays) || 0), 0));
    return dates.some(date => date && day(date) <= day(fence));
  };
  const touchedPlans = [ctx.plan, ...ctx.relatedPlans].filter(plan => frozen(plan, plan.id === ctx.plan.id
    ? [ctx.source?.scheduleDate, ...proposal.allocations.map(row => row.scheduleDate), ...ctx.successors.filter(row => row.planId === plan.id).map(row => row.scheduleDate)]
    : ctx.successors.filter(row => row.planId === plan.id).map(row => row.scheduleDate)));
  if (touchedPlans.length && proposal.reason.length < 10) blockers.push(issue('CAPACITY_FREEZE_FENCE', 'Perubahan dalam freeze fence membutuhkan alasan minimal 10 karakter.'));
  if (touchedPlans.some(plan => ['Released', 'In Progress'].includes(plan.status) && plan.capacityOverrideApproved !== true)) blockers.push(issue('DPP_FREEZE_OVERRIDE_APPROVAL_REQUIRED', 'Plan yang sudah dirilis dalam freeze fence memerlukan persetujuan override kapasitas sebelum pelaksana diubah.'));
  if (ctx.documents.some(row => row.executed)) blockers.push(issue('EXECUTOR_ALREADY_EXECUTED', 'Batch sudah memiliki hasil produksi, pengiriman vendor, atau penerimaan. Pisahkan sisa yang belum dikerjakan melalui replan dokumen sumber.'));
  const finish = Math.max(...proposal.allocations.map(row => new Date(row.vendorReturnDate || row.scheduleDate).getTime()));
  for (const successor of ctx.successors) if (new Date(successor.vendorSendDate || successor.scheduleDate).getTime() < finish) blockers.push(issue('EXECUTOR_SUCCESSOR_EARLY', `Proses berikutnya dijadwalkan ${day(successor.scheduleDate)}, sebelum seluruh batch selesai ${day(finish)}. Replan jadwal proses berikutnya terlebih dahulu.`));
  if (ctx.relatedPlans.some(plan => !['Draft', 'Confirmed', 'Released', 'In Progress'].includes(plan.status))) blockers.push(issue('EXECUTOR_SUCCESSOR_PLAN_LOCKED', 'Plan proses berikutnya sudah ditutup/dibatalkan; tinjau referensi sebelum mengubah batch.'));
  return blockers;
}

async function inspectProposal(tx, ctx, proposal, actor, { capacityBuilder = buildCapacitySnapshot, materialBuilder = buildMaterialReadinessSnapshot, previewOnly = false } = {}) {
  const context = publicContext(ctx);
  const blockers = basicBlockers(ctx, proposal);
  const result = { context, previewToken: previewToken(ctx, proposal), allocations: proposal.allocations, affectedDocuments: ctx.documents, requiresReplan: requiresReplan(ctx), blockers, warnings: [], checks: {}, totals: { sourceQty: ctx.scope.qty, proposedQty: proposal.allocations.reduce((sum, row) => sum + row.plannedQty, 0) } };
  if (blockers.length) return { ...result, canApply: false };
  const endDate = new Date(Math.max(new Date(ctx.plan.periodEnd).getTime(), ...proposal.allocations.map(row => new Date(row.vendorReturnDate || row.scheduleDate).getTime()), ...ctx.successors.map(row => new Date(row.vendorReturnDate || row.scheduleDate).getTime())));
  const query = { planNumber: ctx.plan.planNumber, startDate: ctx.plan.periodStart, endDate, manualAllocation: true, ignoreDraftDailyPlans: true };
  const baseline = await capacityBuilder(tx, query);
  const rows = await replaceAllocations(tx, ctx, proposal, actor, previewOnly);
  const capacity = await capacityBuilder(tx, query);
  const material = await materialBuilder(tx, ctx.plan);
  const key = row => `${row.code}|${row.planNumber || ''}|${row.lineNumber || ''}|${row.machineCode || ''}|${row.message}`;
  const oldIssues = new Set((baseline.readiness?.issues || []).map(key));
  for (const row of capacity.readiness?.issues || []) {
    const formatted = { ...row, message: row.message || row.code };
    if (['blocking', 'overridable'].includes(row.severity) && !oldIssues.has(key(row))) blockers.push(formatted);
    else result.warnings.push(formatted);
  }
  if (material.ready === false) result.warnings.push(issue('EXECUTOR_MATERIAL_NOT_READY', 'Material belum sepenuhnya siap; lihat hasil pemeriksaan dan selesaikan sebelum material issue.'));
  result.checks = { capacity: { summary: capacity.summary, readiness: capacity.readiness }, material, sequence: { issues: (capacity.readiness?.issues || []).filter(row => /PREDECESSOR|SUCCESSOR|DEPENDENCY|VENDOR_RETURN|DELIVERY/.test(row.code || '')), deliveryCoverage: capacity.deliveryCoverage } };
  return { ...result, canApply: blockers.length === 0, _created: rows };
}

async function withPreviewTransaction(db, callback) {
  const rollback = new Error('EXECUTOR_PREVIEW_ROLLBACK'); let result;
  try { await db.$transaction(async tx => { result = await callback(tx); throw rollback; }, { timeout: 45000 }); }
  catch (error) { if (error !== rollback) throw error; }
  return result;
}
async function options(db, planNumber, input) { const ctx = await loadContext(db, planNumber, input); return { ...publicContext(ctx), history: await history(db, planNumber) }; }
async function preview(db, planNumber, input, actor, dependencies) {
  return withPreviewTransaction(db, async tx => {
    const ctx = await loadContext(tx, planNumber, input);
    await assertPeriodOpen(tx, day(ctx.plan.periodStart).slice(0, 7));
    for (const plan of ctx.relatedPlans) await assertPeriodOpen(tx, day(plan.periodStart).slice(0, 7));
    const result = await inspectProposal(tx, ctx, normalizeProposal(ctx, input), actor, { ...dependencies, previewOnly: true });
    delete result._created; return plain(result);
  });
}
async function history(db, planNumber) {
  return db.planningChangeImpact.findMany({ where: { sourceType: TYPE, sourceNumber: planNumber, changeType: 'EXECUTOR_CHANGE' }, orderBy: { changedAt: 'desc' }, take: 100 });
}

async function apply(db, planNumber, input, actor, dependencies) {
  if (!input.previewToken) throw fail('Periksa dampak perubahan sebelum menyimpan.', 'EXECUTOR_PREVIEW_REQUIRED');
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`executor-plan:${planNumber}`}))`;
    const previous = await tx.planningChangeImpact.findFirst({ where: { sourceType: TYPE, sourceNumber: planNumber, changeType: 'EXECUTOR_CHANGE', newValue: { path: ['previewToken'], equals: input.previewToken } } });
    if (previous && ['APPLIED', 'PENDING_REPLAN'].includes(previous.status)) return { status: previous.status, changeId: previous.id, message: previous.status === 'APPLIED' ? 'Perubahan ini sudah diterapkan.' : 'Usulan Replan ini sudah tersimpan.', affectedDocuments: previous.newValue?.affectedDocuments || [], requiresResolution: previous.status === 'PENDING_REPLAN' };
    let ctx = await loadContext(tx, planNumber, input);
    // Lock the records that the established document actions update, then read
    // status again. A released schedule must never be cancelled as a draft.
    for (const id of [ctx.plan.id, ...ctx.relatedPlans.map(plan => plan.id)].sort()) await tx.$executeRaw`SELECT id FROM tbl_monthly_production_plan WHERE id = ${id} FOR UPDATE`;
    for (const id of [ctx.source?.id, ...ctx.successors.map(row => row.id)].filter(Boolean).sort()) await tx.$executeRaw`SELECT id FROM tbl_production_plan_allocation WHERE id = ${id} FOR UPDATE`;
    for (const doc of ctx.documents) {
      if (doc.type === 'Daily Plan') await tx.$executeRaw`SELECT id FROM tbl_daily_production_schedule WHERE id = ${doc.id} FOR UPDATE`;
      if (doc.type === 'PR Vendor') await tx.$executeRaw`SELECT id FROM tbl_purchase_requisition WHERE id = ${doc.id} FOR UPDATE`;
      if (doc.type === 'PO Vendor') await tx.$executeRaw`SELECT id FROM tbl_purchase_order WHERE id = ${doc.id} FOR UPDATE`;
      if (doc.type === 'Order Vendor') await tx.$executeRaw`SELECT id FROM tbl_vendor_process_order WHERE id = ${doc.id} FOR UPDATE`;
      if (doc.type === 'Work Order') await tx.$executeRaw`SELECT id FROM tbl_work_order WHERE id = ${doc.id} FOR UPDATE`;
      if (doc.type === 'Material Issue') await tx.$executeRaw`SELECT id FROM tbl_material_issue WHERE id = ${doc.id} FOR UPDATE`;
    }
    ctx = await loadContext(tx, planNumber, input);
    await assertPeriodOpen(tx, day(ctx.plan.periodStart).slice(0, 7));
    for (const plan of ctx.relatedPlans) await assertPeriodOpen(tx, day(plan.periodStart).slice(0, 7));
    const proposal = normalizeProposal(ctx, input);
    if (input.previewToken !== previewToken(ctx, proposal)) throw fail('Plan, BOM, atau dokumen terkait berubah. Periksa dampaknya kembali.', 'EXECUTOR_STALE_PREVIEW');
    const blockers = basicBlockers(ctx, proposal);
    if (blockers.length) throw fail(blockers.map(row => row.message).join(' '));
    if (requiresReplan(ctx) && input.replan !== true) throw fail('Perubahan ini wajib melalui Replan.', 'EXECUTOR_REPLAN_REQUIRED');
    const pending = input.changeId ? await tx.planningChangeImpact.findFirst({ where: { id: input.changeId, sourceType: TYPE, sourceNumber: planNumber, status: 'PENDING_REPLAN' } }) : null;
    if (input.changeId && !pending) throw fail('Usulan Replan sudah selesai atau tidak ditemukan.', 'EXECUTOR_REPLAN_CHANGED');
    if (pending && (pending.newValue?.proposal?.allocationId !== proposal.allocationId || pending.newValue?.proposal?.lineNumber !== proposal.lineNumber || pending.newValue?.proposal?.mbomProcessId !== proposal.mbomProcessId)) throw fail('Usulan Replan terikat pada batch dan proses asalnya. Buat usulan terpisah untuk batch lain.', 'EXECUTOR_REPLAN_SCOPE');
    const protectedDocs = ctx.documents.filter(row => row.blocking);
    const recordData = { changeType: 'EXECUTOR_CHANGE', sourceType: TYPE, sourceNumber: planNumber, sourceLineId: ctx.line.id, partCode: ctx.scope.partCode,
      oldValue: plain({ allocations: ctx.source ? [ctx.source] : [], successors: ctx.successors, planReplanRequired: ctx.plan.replanRequired, planReplanReason: ctx.plan.replanReason }),
      newValue: plain({ proposal, previewToken: input.previewToken, affectedDocuments: ctx.documents }), affectedPlanNumbers: [planNumber, ...ctx.relatedPlans.map(plan => plan.planNumber)], changedBy: actor,
    };
    if (protectedDocs.length) {
      const record = pending ? await tx.planningChangeImpact.update({ where: { id: pending.id }, data: { newValue: recordData.newValue } }) : await tx.planningChangeImpact.create({ data: { ...recordData, status: 'PENDING_REPLAN' } });
      await tx.monthlyProductionPlan.update({ where: { id: ctx.plan.id }, data: { replanRequired: true, replanReason: ctx.plan.replanRequired ? ctx.plan.replanReason : '[EXECUTOR_CHANGE] Selesaikan dokumen terdampak lalu lanjutkan usulan Replan.' } });
      return { status: 'PENDING_REPLAN', changeId: record.id, requiresResolution: true, affectedDocuments: ctx.documents, message: 'Usulan Replan tersimpan. Alokasi belum berubah. Selesaikan pembatalan/revisi dokumen terkait, lalu pilih Lanjutkan Replan pada riwayat.' };
    }
    // Revalidate the actual proposed allocation in the same transaction that
    // commits it; preview uses this same path but always rolls back.
    const result = await inspectProposal(tx, ctx, proposal, actor, dependencies);
    if (!result.canApply) throw fail(result.blockers.map(row => row.message).join(' '), 'EXECUTOR_VALIDATION_FAILED');
    const created = result._created;
    // inspectProposal only cancels schedules after protected docs have cleared.
    const pr = await syncVendorProcessDraftPrForPlan(tx, ctx.plan.id, actor);
    const update = { status: 'APPLIED', newValue: plain({ ...recordData.newValue, allocationIds: created.map(row => row.id), checks: result.checks, warnings: result.warnings }), resolvedBy: actor, resolvedAt: new Date(), resolutionNotes: proposal.reason };
    const record = pending ? await tx.planningChangeImpact.update({ where: { id: pending.id }, data: update }) : await tx.planningChangeImpact.create({ data: { ...recordData, ...update } });
    const remaining = await tx.planningChangeImpact.count({ where: { sourceType: TYPE, sourceNumber: planNumber, status: 'PENDING_REPLAN' } });
    const clearReplan = !remaining && String(ctx.plan.replanReason || '').startsWith('[EXECUTOR_CHANGE]');
    await tx.monthlyProductionPlan.update({ where: { id: ctx.plan.id }, data: { lastReplannedAt: input.replan ? new Date() : undefined, ...(clearReplan ? { replanRequired: false, replanReason: null } : {}), recommendationSummary: { ...(ctx.plan.recommendationSummary || {}), executorChange: { id: record.id, changedAt: new Date().toISOString(), changedBy: actor } } } });
    for (const related of ctx.relatedPlans) await tx.monthlyProductionPlan.update({ where: { id: related.id }, data: { lastReplannedAt: new Date(), recommendationSummary: { ...(related.recommendationSummary || {}), executorDependencyChange: { id: record.id, sourcePlanNumber: planNumber, changedBy: actor } } } });
    const republish = ctx.source?.status === 'Published' || ctx.successors.some(row => row.status === 'Published');
    return { status: 'APPLIED', changeId: record.id, allocations: created, vendorProcessPr: pr, warnings: result.warnings, message: 'Pelaksana dan pembagian qty berhasil diperbarui. Draft PR vendor disinkronkan; jadwal vendor tersedia untuk konfirmasi ETA.' + (republish ? ' Publikasikan ulang batch yang berubah dan proses berikutnya untuk memperbarui Daily Plan.' : '') };
  }, { timeout: 45000, isolationLevel: 'Serializable' });
}

async function cancel(db, planNumber, changeId, actor) {
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`executor-plan:${planNumber}`}))`;
    const record = await tx.planningChangeImpact.findFirst({ where: { id: changeId, sourceType: TYPE, sourceNumber: planNumber, status: 'PENDING_REPLAN' } });
    if (!record) throw fail('Usulan Replan sudah selesai atau tidak ditemukan.');
    const plan = await tx.monthlyProductionPlan.findUnique({ where: { planNumber } });
    await assertPeriodOpen(tx, day(plan.periodStart).slice(0, 7));
    await tx.planningChangeImpact.update({ where: { id: changeId }, data: { status: 'CANCELLED', resolvedAt: new Date(), resolvedBy: actor, resolutionNotes: 'Usulan dibatalkan; alokasi existing dipertahankan.' } });
    const remaining = await tx.planningChangeImpact.count({ where: { sourceType: TYPE, sourceNumber: planNumber, status: 'PENDING_REPLAN' } });
    if (!remaining && String(plan.replanReason || '').startsWith('[EXECUTOR_CHANGE]')) await tx.monthlyProductionPlan.update({ where: { id: plan.id }, data: { replanRequired: false, replanReason: null } });
    return { status: 'CANCELLED', changeId, message: 'Usulan Replan dibatalkan. Alokasi existing tetap.' };
  });
}
module.exports = { options, preview, apply, history, cancel, normalizeProposal, affectedDocuments, loadContext, publicContext, basicBlockers, previewToken, replaceAllocations, inspectProposal };
