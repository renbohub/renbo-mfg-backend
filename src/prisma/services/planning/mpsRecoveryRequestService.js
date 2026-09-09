"use strict";

const { userHasPermission } = require("../ai/permissionEvaluator");
const { deliverySuggestion, VERSION } = require("./mpsProductionChecksheetService");
const CHECKPOINTS = Object.freeze({
  MASTER_DATA: { title: "Correct Master Data", department: "PPIC", codes: ["MASTER_DATA_READY", "LOT_BATCH_YIELD_VALID", "BUFFER_POLICY_MET"] },
  PRODUCTION_CAPACITY: { title: "Review kapasitas / overtime / alternatif line", department: "Production", codes: ["MPS_CAPACITY", "CAPACITY_AVAILABLE", "RESOURCE_CALENDAR_AVAILABLE", "ROUTING_SEQUENCE_VALID"] },
  MATERIAL_SUPPLY: { title: "Pemenuhan material / percepatan pembelian", department: "Purchasing", codes: ["MPS_MATERIAL", "FG_COVERAGE_AT_DUE_DATE", "MATERIAL_READY_BY_START"] },
  VENDOR_PROCESS: { title: "Percepatan proses / alternatif vendor", department: "Purchasing", codes: ["MPS_VENDOR", "FIRM_SUPPLY_ON_TIME", "QUALITY_RELEASE_READY"] },
  DELIVERY_SCHEDULE: { title: "Review Delivery Target", department: "Sales", codes: ["LEAD_TIME_AND_FINISH_FIT", "DELIVERY_SLOT_AVAILABLE"] },
});
const STATUSES = new Set(["OPEN", "IN_PROGRESS", "WAITING", "DONE"]);
const json = (value) => JSON.parse(JSON.stringify(value));
const fail = (status, message) => { throw Object.assign(new Error(message), { status, statusCode: status }); };
const hasMps = (user, action = "read") => !user?.isDeleted && userHasPermission(user, { resourceCode: "mps", action }, { moduleCode: "planning-ppic", pageCode: "master-production-schedule" });
const activeEmployee = (employee) => employee && !employee.isDeleted && String(employee.status).toLowerCase() === "active" && !employee.department?.isDeleted;
function canFeedback(user, request, employee) {
  if (!user || user.isDeleted) return false;
  return user.isSuperAdmin === true || (activeEmployee(employee) && employee.departmentId === request.departmentId && (request.recipientIds || []).includes(user.id));
}
async function employeeFor(db, user) {
  if (!user?.employeeId) return null;
  return db.employee.findUnique({ where: { employeeId: user.employeeId }, select: { departmentId: true, status: true, isDeleted: true, department: { select: { isDeleted: true } } } });
}
async function departments(db) {
  const users = await db.user.findMany({ where: { isDeleted: false, employee: { is: { isDeleted: false, status: "Active", department: { is: { isDeleted: false } } } } }, select: { id: true, employee: { select: { departmentId: true, department: { select: { id: true, departmentCode: true, departmentName: true } } } } } });
  const groups = new Map();
  for (const user of users) {
    const dept = user.employee?.department;
    if (!dept) continue;
    if (!groups.has(dept.id)) groups.set(dept.id, { id: dept.id, code: dept.departmentCode, name: dept.departmentName || dept.departmentCode, recipientIds: [] });
    groups.get(dept.id).recipientIds.push(user.id);
  }
  return [...groups.values()];
}
function publicRequest(row, user, employee) {
  const { recipientIds, ...data } = row;
  return { ...data, recoveryOutcome: row.history?.at(-1)?.recoveryOutcome || "UNDECIDED", kind: "CHECKLIST_REQUEST", recipientCount: (recipientIds || []).length, canFeedback: canFeedback(user, row, employee), dept: row.departmentName, recovery: row.title, planStatus: "DEPARTMENT_FOLLOW_UP" };
}
async function listRequests(db, user, filters = {}) {
  const employee = await employeeFor(db, user);
  const where = {};
  if (filters.month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(filters.month)) fail(400, "Bulan planning tidak valid.");
    where.planningMonth = filters.month;
  }
  if (filters.lineId) where.lineId = filters.lineId;
  if (!hasMps(user)) {
    if (!activeEmployee(employee)) return [];
    where.departmentId = employee.departmentId;
  }
  const rows = await db.mpsRecoveryRequest.findMany({ where, orderBy: { updatedAt: "desc" }, take: 1000 });
  return rows.filter((row) => hasMps(user) || (row.recipientIds || []).includes(user.id)).map((row) => publicRequest(row, user, employee));
}
async function requestContext(db, user, lineId, month) {
  if (!hasMps(user)) fail(403, "Akses baca MPS diperlukan.");
  const [items, choices] = await Promise.all([listRequests(db, user, { lineId, month }), departments(db)]);
  return { items, canRequest: hasMps(user, "update"), departments: choices.map(({ recipientIds, ...dept }) => ({ ...dept, recipientCount: recipientIds.length })), checkpoints: CHECKPOINTS };
}
function validateRequest(input, assessment, requests = []) {
  const checkpoint = CHECKPOINTS[input.checkpointCode];
  if (!checkpoint) fail(400, "Checkpoint tidak dikenal.");
  if (!assessment || assessment.identity?.lineId !== input.lineId) fail(404, "Baris checklist tidak ditemukan.");
  const isDeliveryReview = input.checkpointCode === "DELIVERY_SCHEDULE" && assessment.summary?.rulesVersion === VERSION;
  const checks = isDeliveryReview ? assessment.checks || [] : (assessment.checks || []).filter((check) => checkpoint.codes.includes(check.code));
  if (isDeliveryReview) {
    const gate = deliverySuggestion(assessment, requests);
    if (!gate.eligible) fail(409, gate.reason);
  } else if (!checks.some((check) => !["PASS", "NA"].includes(check.status))) fail(409, "Checkpoint tidak memiliki masalah yang membutuhkan recovery.");
  const notes = String(input.notes || "").trim();
  if (!notes || notes.length > 4000) fail(400, "Isi permintaan recovery (maksimal 4000 karakter).");
  let targetDate = null;
  if (input.targetDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.targetDate)) fail(400, "Tanggal target tidak valid.");
    targetDate = new Date(`${input.targetDate}T00:00:00.000Z`);
    if (!Number.isFinite(targetDate.getTime()) || targetDate.toISOString().slice(0, 10) !== input.targetDate) fail(400, "Tanggal target tidak valid.");
  }
  return { checkpoint, checks, notes, targetDate };
}
async function createRequest(db, user, input, assessment, broadcast = () => {}) {
  if (!hasMps(user, "update")) fail(403, "Akses update MPS diperlukan untuk meminta recovery.");
  const loadRecovery = (client) => input.checkpointCode === "DELIVERY_SCHEDULE" ? client.mpsRecoveryRequest.findMany({ where: { lineId: input.lineId, mpsNumber: assessment?.identity?.mpsNumber, mpsRevision: assessment?.identity?.mpsRevision } }) : [];
  const { checkpoint, checks, notes, targetDate } = validateRequest(input, assessment, await loadRecovery(db));
  const selected = (await departments(db)).find((dept) => dept.id === input.departmentId);
  if (!selected?.recipientIds.length) fail(409, "Departemen belum memiliki akun karyawan aktif. Hubungkan akun ke karyawan dan departemen terlebih dahulu.");
  const detail = await db.mPSDetail.findFirst({ where: { id: input.lineId.split("::")[0], isDeleted: false }, select: { partCode: true, mpsNumber: true, mps: { select: { revision: true, isDeleted: true, status: true, replanRequired: true } } } });
  if (!detail || detail.mps.isDeleted || detail.mps.status === "Superseded") fail(409, "Revisi MPS sudah tidak aktif. Muat ulang checklist.");
  const identity = assessment.identity || {};
  if (identity.mpsNumber !== detail.mpsNumber || identity.mpsRevision !== detail.mps.revision) fail(409, "Revisi MPS berubah selama evaluasi. Muat ulang checklist.");
  const key = { mpsNumber: detail.mpsNumber, mpsRevision: detail.mps.revision, lineId: input.lineId, checkpointCode: input.checkpointCode };
  const unique = { mpsNumber_mpsRevision_lineId_checkpointCode: key };
  const existing = await db.mpsRecoveryRequest.findUnique({ where: unique });
  if (existing) return { item: publicRequest(existing, user, await employeeFor(db, user)), duplicate: true, message: "Permintaan pada revisi ini sudah ada. Lihat feedback di Recovery Kanban." };
  const now = new Date();
  let result;
  try {
    result = await db.$transaction(async (tx) => {
      validateRequest(input, assessment, await loadRecovery(tx));
      const current = await tx.mPSDetail.findFirst({ where: { id: input.lineId.split("::")[0], isDeleted: false }, select: { mpsNumber: true, mps: { select: { revision: true, isDeleted: true, status: true } } } });
      if (!current || current.mpsNumber !== key.mpsNumber || current.mps.revision !== key.mpsRevision || current.mps.isDeleted || current.mps.status === "Superseded") fail(409, "Revisi MPS berubah. Muat ulang checklist.");
      const item = await tx.mpsRecoveryRequest.create({ data: { ...key, planningMonth: identity.period, partCode: detail.partCode, title: checkpoint.title, departmentId: selected.id, departmentName: selected.name, recipientIds: selected.recipientIds, sourceSnapshot: json({ identity, checks, decisionSupport: assessment.decisionSupport, mpsCalculation: assessment.mpsCalculation, summary: assessment.summary }), notes, targetDate, requestedBy: user.id, history: [{ status: "OPEN", by: user.id, at: now.toISOString(), notes }] } });
      const notifications = [];
      for (const userId of selected.recipientIds) notifications.push(await tx.notification.create({ data: {
        type: "mps_recovery", title: `Recovery MPS · ${checkpoint.title}`, message: `${detail.mpsNumber} · ${detail.partCode}: ${notes}`, userId, entityId: item.id,
        entityUrl: `/modules/planning-ppic/mps/recovery-kanban?month=${encodeURIComponent(identity.period)}&request=${encodeURIComponent(item.id)}`,
        metadata: { requestId: item.id, departmentId: selected.id, lineId: input.lineId }, createdBy: user.username || user.id,
      } }));
      return { item, notifications };
    });
  } catch (error) {
    if (error.code !== "P2002") throw error;
    const duplicate = await db.mpsRecoveryRequest.findUnique({ where: unique });
    if (!duplicate) throw error;
    return { item: publicRequest(duplicate, user, await employeeFor(db, user)), duplicate: true, message: "Permintaan sudah tersimpan." };
  }
  result.notifications.forEach((notification) => broadcast(notification));
  return { item: publicRequest(result.item, user, await employeeFor(db, user)), duplicate: false, message: `Recovery dikirim ke ${selected.recipientIds.length} akun ${selected.name}.` };
}
async function updateFeedback(db, user, id, input, broadcast = () => {}) {
  const status = String(input.feedbackStatus || "").toUpperCase();
  if (!STATUSES.has(status)) fail(400, "Feedback status tidak valid.");
  const notes = String(input.feedbackNotes || "").trim();
  const evidence = String(input.evidenceReference || "").trim();
  const recoveryOutcome = String(input.recoveryOutcome || "UNDECIDED").toUpperCase();
  if (!["UNDECIDED", "FEASIBLE", "NOT_FEASIBLE"].includes(recoveryOutcome)) fail(400, "Hasil recovery tidak valid.");
  if (recoveryOutcome !== "UNDECIDED" && status !== "DONE") fail(400, "Tandai Done untuk menyimpulkan hasil recovery.");
  if (recoveryOutcome === "NOT_FEASIBLE" && (!notes || !evidence)) fail(400, "Isi alasan dan referensi bukti saat recovery tidak memungkinkan.");
  if (notes.length > 4000 || evidence.length > 1000) fail(400, "Catatan atau bukti terlalu panjang.");
  if (["WAITING", "DONE"].includes(status) && !notes) fail(400, "Catatan hasil atau kendala wajib untuk Waiting / Done.");
  const employee = await employeeFor(db, user);
  const result = await db.$transaction(async (tx) => {
    const row = await tx.mpsRecoveryRequest.findUnique({ where: { id } });
    if (!row) fail(404, "Permintaan recovery tidak ditemukan.");
    if (!canFeedback(user, row, employee)) fail(403, "Hanya akun penerima di departemen terkait yang dapat memberi feedback.");
    if (input.updatedAt !== row.updatedAt.toISOString()) fail(409, "Feedback sudah diperbarui. Muat ulang sebelum menyimpan.");
    const history = [...(Array.isArray(row.history) ? row.history : []), { status, by: user.id, at: new Date().toISOString(), notes, evidenceReference: evidence, recoveryOutcome }];
    const changed = await tx.mpsRecoveryRequest.updateMany({ where: { id, updatedAt: row.updatedAt }, data: { feedbackStatus: status, feedbackNotes: notes, evidenceReference: evidence, updatedBy: user.id, history } });
    if (!changed.count) fail(409, "Feedback berubah bersamaan. Muat ulang.");
    const item = await tx.mpsRecoveryRequest.findUnique({ where: { id } });
    const notification = row.requestedBy !== user.id ? await tx.notification.create({ data: { type: "mps_recovery", title: `Feedback recovery · ${status}`, message: `${row.mpsNumber} · ${row.title}: ${notes || status}. Hitung ulang MPS untuk memeriksa kelayakan.`, userId: row.requestedBy, entityId: row.id, entityUrl: `/modules/planning-ppic/mps/recovery-kanban?month=${row.planningMonth}&request=${encodeURIComponent(row.id)}`, metadata: { requestId: row.id }, createdBy: user.username || user.id } }) : null;
    return { item, notification };
  });
  if (result.notification) broadcast(result.notification);
  return publicRequest(result.item, user, employee);
}
module.exports = { CHECKPOINTS, hasMps, canFeedback, validateRequest, listRequests, requestContext, createRequest, updateFeedback };
