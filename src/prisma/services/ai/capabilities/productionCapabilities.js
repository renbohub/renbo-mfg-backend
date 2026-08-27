"use strict";

function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function round(value) { return Math.round(number(value) * 100) / 100; }
function day(value) { if (!value) return null; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10); }
function source(entityType, entityId, label, href) { return { entityType, entityId: String(entityId), label: String(label), href }; }

async function loadSchedules(prisma, input = {}) {
  const scheduleDate = input.scheduleDate ? new Date(`${input.scheduleDate}T00:00:00.000Z`) : null;
  return prisma.dailyProductionSchedule.findMany({
    where: { isDeleted: false, ...(input.scheduleId ? { id: input.scheduleId } : {}), ...(scheduleDate ? { scheduleDate: { gte: scheduleDate, lt: new Date(scheduleDate.getTime() + 86400000) } } : {}), ...(input.machineCode ? { OR: [{ machineId: input.machineCode }] } : {}) },
    include: { productionLogs: { where: { isDeleted: false }, include: { downtimeLogs: { where: { isDeleted: false } }, qualityInspections: { where: { isDeleted: false } } } } },
    orderBy: [{ scheduleDate: "asc" }, { sequence: "asc" }], take: Math.min(Math.max(number(input.limit) || 100, 1), 100),
  });
}

function mapProgress(row) {
  const logs = Array.isArray(row.productionLogs) ? row.productionLogs : [];
  const goodQty = round(logs.reduce((sum, log) => sum + number(log.qtyGood), 0));
  const ngQty = round(logs.reduce((sum, log) => sum + number(log.qtyReject), 0));
  const downtimeMinutes = round(logs.reduce((sum, log) => sum + number(log.downtime) + (log.downtimeLogs || []).reduce((total, downtime) => total + number(downtime.durationMinutes), 0), 0));
  const openNgDispositionQty = round(logs.reduce((sum, log) => sum + (log.qualityInspections || []).filter((inspection) => !["Accepted", "Rejected", "Rework"].includes(inspection.decision)).reduce((total, inspection) => total + number(inspection.qtyFailed), 0), 0));
  const remainingQty = round(Math.max(number(row.plannedQty) - goodQty, 0));
  const fgRequiredDate = day(row.fgRequiredDate || row.customerTargetDate);
  const projectedFinishAt = row.plannedEndTime ? `${day(row.scheduleDate)}T${row.plannedEndTime}` : null;
  const atRisk = remainingQty > 0 && (openNgDispositionQty > 0 || downtimeMinutes > 0 || ["WARNING", "LATE", "BLOCKER"].includes(String(row.lateRisk || "").toUpperCase()));
  const sources = [source("DAILY_PRODUCTION_SCHEDULE", row.id, row.scheduleNumber, `/modules/production/daily-production-schedules/${encodeURIComponent(row.scheduleNumber)}`), ...logs.map((log) => source("PRODUCTION_LOG", log.id, log.logNumber, `/modules/production/production-logs/${encodeURIComponent(log.logNumber)}`))];
  if (row.deliveryPhaseId) sources.push(source("FG_DELIVERY_PHASE", row.deliveryPhaseId, `${row.partCode || "FG"} · ${fgRequiredDate || "required"}`, `/modules/planning-ppic/demand-planning/delivery-workbench?deliveryTargetId=${encodeURIComponent(row.deliveryPhaseId)}`));
  return {
    scheduleId: row.id, scheduleDate: day(row.scheduleDate), machineCode: row.machineCode || row.machineId || null, workOrderNumber: row.woNumber || null, partCode: row.partCode || null, processCode: row.processCode || row.processId || null,
    plannedQty: round(row.plannedQty), goodQty, ngQty, remainingQty, downtimeMinutes, projectedFinishAt, fgRequiredDate, riskStatus: atRisk ? "AT_RISK" : remainingQty > 0 ? "IN_PROGRESS" : "ON_TRACK",
    downstreamImpact: { fgRequiredDate, deliveryPhaseId: row.deliveryPhaseId || null, openNgDispositionQty, goodOutputOnly: goodQty, note: openNgDispositionQty > 0 ? "NG belum disposition tidak tersedia untuk proses berikutnya." : "Hanya output good dihitung tersedia untuk proses berikutnya." }, sources,
  };
}

async function getDailyProgress({ prisma, input }) { const items = (await loadSchedules(prisma, input)).map(mapProgress); return { items, sources: items.flatMap((row) => row.sources).slice(0, 100) }; }
async function analyzeNgAndDowntime({ prisma, input }) { const result = await getDailyProgress({ prisma, input }); result.items = result.items.filter((row) => row.ngQty > 0 || row.downtimeMinutes > 0 || row.riskStatus === "AT_RISK"); result.sources = result.items.flatMap((row) => row.sources).slice(0, 100); return result; }

function assertChoice(value, choices, label) {
  if (!Array.isArray(choices) || !choices.map(String).includes(String(value))) throw Object.assign(new Error(`${label} bukan pilihan ERP yang diizinkan.`), { code: "AI_RECOVERY_CHOICE_INVALID", statusCode: 422 });
}

async function createRecoveryDraft({ prisma, input, user }) {
  assertChoice(input.targetMachineId, input.allowedMachineIds, "Mesin"); assertChoice(input.targetShift, input.allowedShifts, "Shift"); assertChoice(input.targetDate, input.allowedDates, "Tanggal");
  const [schedule] = await loadSchedules(prisma, { scheduleId: input.scheduleId, limit: 1 });
  if (!schedule) throw Object.assign(new Error("Daily Production Schedule tidak ditemukan."), { code: "AI_DAILY_PLAN_SOURCE_NOT_FOUND", statusCode: 404 });
  const sourceReferences = [source("DAILY_PRODUCTION_SCHEDULE", schedule.id, schedule.scheduleNumber, `/modules/production/daily-production-schedules/${encodeURIComponent(schedule.scheduleNumber)}`)];
  return prisma.aiDraft.create({ data: {
    conversationId: input.conversationId, requestId: input.requestId, userId: String(user?.id || ""), moduleCode: "production", pageCode: "daily-production-schedules", draftType: "DAILY_PLAN_RECOVERY", generationSource: "AI_GENERATED", status: "WAITING_CONFIRMATION",
    payload: { owner: input.owner, revisionNote: input.revisionNote, targetMachineId: input.targetMachineId, targetShift: input.targetShift, targetDate: input.targetDate, sourceReferences }, sourceRefs: sourceReferences,
    validationSummary: { valid: true, issues: [], restrictions: ["RELEASE_REMAINS_MANUAL"] }, expiresAt: new Date(Date.now() + 2 * 86400000),
  } });
}

function createProductionCapabilityDefinitions() {
  const readPermission = { moduleCode: "production", pageCode: "*", resourceCode: "dailyProductionSchedules", action: "read" };
  const commonInput = { type: "object", additionalProperties: false, properties: { scheduleDate: { type: "string", format: "date" }, machineCode: { type: "string", maxLength: 100 }, limit: { type: "integer", minimum: 1, maximum: 100 } } };
  return [
    { code: "production.get_daily_progress", operationClass: "READ", permission: readPermission, maxRows: 100, fieldAllowlist: ["items", "sources"], inputSchema: commonInput, outputSchema: { type: "object" }, execute: getDailyProgress },
    { code: "production.analyze_ng_and_downtime", operationClass: "ANALYZE", permission: readPermission, maxRows: 100, fieldAllowlist: ["items", "sources"], inputSchema: commonInput, outputSchema: { type: "object" }, execute: analyzeNgAndDowntime },
    { code: "production.create_recovery_draft", operationClass: "DRAFT", permission: { ...readPermission, action: "update" }, maxRows: 100, fieldAllowlist: ["id", "status", "draftType", "payload", "sourceRefs", "expiresAt"], inputSchema: { type: "object", additionalProperties: false, required: ["conversationId", "requestId", "scheduleId", "owner", "revisionNote", "targetMachineId", "targetShift", "targetDate", "allowedMachineIds", "allowedShifts", "allowedDates"], properties: { conversationId: { type: "string", minLength: 1 }, requestId: { type: "string", minLength: 1 }, scheduleId: { type: "string", minLength: 1 }, owner: { type: "string", minLength: 1, maxLength: 120 }, revisionNote: { type: "string", minLength: 3, maxLength: 1000 }, targetMachineId: { type: "string" }, targetShift: { type: "string" }, targetDate: { type: "string", format: "date" }, allowedMachineIds: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } }, allowedShifts: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } }, allowedDates: { type: "array", minItems: 1, maxItems: 31, items: { type: "string", format: "date" } } } }, outputSchema: { type: "object" }, execute: createRecoveryDraft },
  ];
}

function registerProductionCapabilities(registry) { for (const definition of createProductionCapabilityDefinitions()) if (!registry.has(definition.code)) registry.register(definition); return registry; }
module.exports = { createProductionCapabilityDefinitions, registerProductionCapabilities };
