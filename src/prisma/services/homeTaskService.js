const { userHasPermission } = require("./ai/permissionEvaluator");
const { ACTIVE_REQUEST_STATUSES, REQUEST_INCLUDE, canApproveStep, incompleteSteps } = require("./approvalRuleService");
const { listRequests } = require("./planning/mpsRecoveryRequestService");
const { businessNow } = require("../utils/businessClock");
const LIMIT = 100;
const normalize = (value) => String(value || "").trim().toLowerCase();

async function approvalTasks(db, user) {
  const cache = new Map();
  const cached = (model) => ({ findMany(args) {
    const key = model + JSON.stringify(args);
    if (!cache.has(key)) cache.set(key, db[model].findMany(args));
    return cache.get(key);
  } });
  const permissionDb = { userRole: cached("userRole"), rolePermission: cached("rolePermission") };
  const rows = await db.approvalRequest.findMany({ where: { isDeleted: false, status: { in: ACTIVE_REQUEST_STATUSES } }, include: REQUEST_INCLUDE, orderBy: { requestedAt: "asc" }, take: 1000 });
  const items = [];
  for (const row of rows) {
    if (!row.rule || (!row.rule.allowSelfApproval && (row.requestedByUserId === user.id || (row.requestedBy && normalize(row.requestedBy) === normalize(user.username || user.email))))) continue;
    const open = incompleteSteps(row);
    const steps = row.rule.requireSequential ? open.filter((step) => step.stepOrder === Math.min(...open.map((item) => item.stepOrder))) : open;
    for (const step of steps) {
      if ((row.actions || []).some((action) => action.stepOrder === step.stepOrder && action.action === "Approved" && action.actedByUserId === user.id)) continue;
      if (!(await canApproveStep(user, row, step, permissionDb))) continue;
      items.push({ id: row.id, kind: "approval", title: row.documentNumber || row.requestNumber, description: `${row.documentType || "Dokumen"} menunggu persetujuan tahap ${step.stepOrder}.`, module: row.moduleCode, page: row.pageCode, record: row.documentNumber || row.documentId, status: row.status, actor: row.requestedBy, date: row.requestedAt, amount: row.amount, currency: row.currencyCode, reference: row.requestNumber });
      break;
    }
  }
  return { items: items.slice(0, LIMIT), total: items.length, limited: rows.length === 1000 || items.length > LIMIT };
}
async function recoveryTasks(db, user) {
  const rows = (await listRequests(db, user)).filter((row) => row.canFeedback && row.feedbackStatus !== "DONE");
  return { items: rows.slice(0, LIMIT).map((row) => ({ id: row.id, kind: "recovery", title: row.title, description: row.notes, reference: row.mpsNumber, actor: row.departmentName, status: row.feedbackStatus || "OPEN", date: row.updatedAt, dueDate: row.targetDate, url: `/modules/planning-ppic/mps/recovery-kanban?month=${encodeURIComponent(row.planningMonth)}&request=${encodeURIComponent(row.id)}` })), total: rows.length, limited: rows.length >= LIMIT };
}
async function commentTasks(db, user) {
  const rows = await db.pageComment.findMany({ where: { isDeleted: false, NOT: { userId: user.id } }, orderBy: { createdAt: "desc" }, take: 1000 });
  const allowed = rows.filter((row) => userHasPermission(user, { resourceCode: row.pageCode, action: "read" }, { moduleCode: row.moduleCode, pageCode: row.pageCode }));
  return { items: allowed.slice(0, LIMIT).map((row) => ({ id: row.id, kind: "comment", title: row.recordKey || row.pageCode, description: row.message, module: row.moduleCode, page: row.pageCode, record: row.recordKey, actor: row.username, date: row.createdAt, status: "Diskusi" })), total: allowed.length, limited: rows.length === 1000 || allowed.length > LIMIT };
}
async function notificationTasks(db, user) {
  const where = { OR: [{ userId: user.id }, { userId: null }], isRead: false };
  const [rows, total] = await Promise.all([db.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: LIMIT }), db.notification.count({ where })]);
  return { items: rows.map((row) => ({ id: row.id, kind: "notification", title: row.title, description: row.message, date: row.createdAt, actor: row.createdBy || "Sistem", status: "Belum dibaca", url: row.entityUrl, canMarkRead: row.userId === user.id })), total, limited: total > LIMIT };
}
async function getHomeTasks(db, user) {
  const names = ["approval", "recovery", "comment", "notification"];
  const results = await Promise.allSettled([approvalTasks(db, user), recoveryTasks(db, user), commentTasks(db, user), notificationTasks(db, user)]);
  const sources = Object.fromEntries(results.map((result, index) => [names[index], result.status === "fulfilled" ? { ...result.value, available: true } : { available: false, items: [], total: null, message: "Data belum dapat dimuat. Coba muat ulang." }]));
  return { sources, currentDate: businessNow().toISOString().slice(0, 10), refreshedAt: new Date().toISOString() };
}
module.exports = { getHomeTasks, approvalTasks, recoveryTasks, commentTasks, notificationTasks };
