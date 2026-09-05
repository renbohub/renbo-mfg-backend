const { prisma } = require("../../index");
const { buildCapacitySnapshot, findRouteWorkOrder } = require("../../services/planning/capacityPlanningService");
const { buildMonthlyProductionMatrix } = require("../../services/planning/monthlyProductionMatrixService");
const { getMpsWorkbench } = require("../../services/planning/mpsWorkbenchService");
const { recommendMonthlyCapacity, VERSION: CAPACITY_RECOMMENDATION_VERSION } = require("../../services/planning/capacityRecommendationService");
const {
  uniqueBlockers: uniqueCapacityBlockers,
  visibleStoredRecommendationBlockers,
  buildAuthoritativePhaseResults,
  mergeAuthoritativeRecommendationSummary,
} = require("../../services/planning/capacityRecommendationValidationService");
const { findPreset, activatePreset } = require("../../services/planning/capacitySimulationPresetService");
const { resolveDiesAssignment } = require("../../services/planning/diesCapacityService");
const { refreshDraftForMps } = require("../purchasing/PurchaseSuggestionController");
const dailyProductionScheduleController = require("../production/DailyProductionScheduleController");
const dailyPlanRevisionService = require("../../services/planning/dailyPlanRevisionService");
const {
  generateVendorProcessOrdersFromRouting,
} = require("../production/VendorProcessOrderController");
const {
  buildMaterialReadinessSnapshot,
  planningMaterialDisposition,
} = require("../../services/planning/materialReadinessService");
const {
  syncVendorProcessDraftPrForPlan,
} = require("../../services/planning/vendorProcessPrService");
const {
  planningMonthKey: monthKey,
  utcMonthStart: monthStart,
  utcMonthEnd: monthEnd,
  utcMonthEndInstant,
} = require("../../utils/planningMonth");
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const { isDiscreteUom, normalizeQuantity } = require("../../utils/uomQuantity");
const { scheduleDailyReleaseAllocations } = require("../../services/planning/dailyReleaseSchedulingService");
const { invalidateRccpByMachineCalendar } = require("../../services/planning/rccpService");
const {
  openPersistentSession,
  stagePersistentChange,
  cancelPersistentSession,
  undoPersistentChange,
  getPersistentSession,
  previewPersistentSession,
  commitPersistentSession,
} = require("../../services/planning/capacityEditSessionService");
const include = { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } };

const text = (value) => String(value ?? "").trim() || null;
const CAPACITY_FLOW_METHODS = new Set(["FULL_SEQUENTIAL", "SPLIT_PHASE", "SPLIT_BATCH", "CONTINUOUS_FLOW"]);
const CAPACITY_ALGORITHM_PROFILES = new Set(["FULL_COMPLETION_SEQUENCE", "SHIFT_CAPACITY_TRANSFER", "CUSTOM"]);
const CAPACITY_RELEASE_CONDITIONS = new Set(["QUANTITY_REACHED", "QC_RELEASE", "MATERIAL_MOVED", "PREVIOUS_PROCESS_CLOSED"]);
const boundedNumber = (value, min, max, fallback = 0) => Math.min(Math.max(Number.isFinite(Number(value)) ? Number(value) : fallback, min), max);
const enumValue = (value, allowed, fallback) => allowed.includes(String(value || "").trim().toUpperCase()) ? String(value).trim().toUpperCase() : fallback;
function normalizeCapacityFlowRule(input = {}) {
  const flowMethod = CAPACITY_FLOW_METHODS.has(String(input.flowMethod || "").toUpperCase()) ? String(input.flowMethod).toUpperCase() : "FULL_SEQUENTIAL";
  const flow = input.flow || {};
  const delay = input.interProcessDelay || {};
  const wip = input.wip || {};
  const shift = input.shift || {};
  const machine = input.machine || {};
  const lot = input.lot || {};
  const setup = input.setup || {};
  const quality = input.quality || {};
  const ngOutput = input.ngOutput || {};
  const delivery = input.delivery || {};
  const releaseConditions = [...new Set((Array.isArray(input.releaseConditions) ? input.releaseConditions : [])
    .map((item) => String(item || "").toUpperCase()).filter((item) => CAPACITY_RELEASE_CONDITIONS.has(item)))];
  return {
    version: 1,
    name: text(input.name)?.slice(0, 100) || "Aturan Aliran Produksi",
    algorithmProfile: CAPACITY_ALGORITHM_PROFILES.has(String(input.algorithmProfile || "").toUpperCase())
      ? String(input.algorithmProfile).toUpperCase()
      : "SHIFT_CAPACITY_TRANSFER",
    flowMethod,
    flow: {
      nextProcessStart: enumValue(flow.nextProcessStart, ["IMMEDIATE", "NEXT_SHIFT", "NEXT_DAY"], "IMMEDIATE"),
      phaseCount: Math.trunc(boundedNumber(flow.phaseCount, 2, 50, 2)),
      phaseDistribution: enumValue(flow.phaseDistribution, ["EQUAL", "PERCENTAGE"], "EQUAL"),
      phasePercentages: (Array.isArray(flow.phasePercentages) ? flow.phasePercentages : []).slice(0, 50).map((value) => boundedNumber(value, 0, 100, 0)),
      transferBatchQuantity: boundedNumber(flow.transferBatchQuantity, 0, 1e12, 0),
      minimumReleaseBatchQuantity: boundedNumber(flow.minimumReleaseBatchQuantity, 0, 1e12, 0),
      minimumWip: boundedNumber(flow.minimumWip, 0, 1e12, 0),
      maximumWip: boundedNumber(flow.maximumWip, 0, 1e12, 0),
    },
    interProcessDelay: {
      mode: enumValue(delay.mode, ["NONE", "FIXED", "ROUTING_PROCESS"], "FIXED"),
      value: boundedNumber(delay.value, 0, 1e9, 120),
      unit: enumValue(delay.unit, ["MINUTE", "HOUR", "DAY"], "MINUTE"),
    },
    releaseConditions,
    wip: {
      minimum: boundedNumber(wip.minimum, 0, 1e12, 0),
      maximum: boundedNumber(wip.maximum, 0, 1e12, 0),
      onMaximum: enumValue(wip.onMaximum, ["WARNING", "STOP_PREVIOUS"], "WARNING"),
    },
    shift: {
      allowCrossShift: Boolean(shift.allowCrossShift),
      allowOvernightWip: Boolean(shift.allowOvernightWip),
      nextProcessStart: enumValue(shift.nextProcessStart, ["IMMEDIATE", "SHIFT_START", "NEXT_DAY"], "IMMEDIATE"),
    },
    machine: {
      placement: enumValue(machine.placement, ["PRIMARY", "ALTERNATIVE", "FASTEST_AVAILABLE"], "FASTEST_AVAILABLE"),
      allowSplitMachines: Boolean(machine.allowSplitMachines),
      maximumMachines: Math.trunc(boundedNumber(machine.maximumMachines, 1, 50, 1)),
    },
    lot: {
      policy: enumValue(lot.policy, ["KEEP_TOGETHER", "ALLOW_SPLIT", "ALLOW_MERGE"], "KEEP_TOGETHER"),
      minimumSplitQuantity: boundedNumber(lot.minimumSplitQuantity, 0, 1e12, 0),
      preserveMaterialLotTraceability: lot.preserveMaterialLotTraceability !== false,
    },
    setup: {
      trigger: enumValue(setup.trigger, ["PRODUCTION_START", "EACH_PHASE", "EACH_BATCH", "MACHINE_CHANGE"], "PRODUCTION_START"),
      skipWhenSameTooling: Boolean(setup.skipWhenSameTooling),
    },
    quality: { gate: enumValue(quality.gate, ["NONE", "SAMPLE", "FULL_BATCH", "APPROVAL"], "NONE") },
    delivery: {
      fgCompletionDaysBefore: Math.trunc(boundedNumber(delivery.fgCompletionDaysBefore, 0, 365, 0)),
      schedulePolicy: enumValue(delivery.schedulePolicy, ["DELIVERY_JIT", "EARLIEST"], "DELIVERY_JIT"),
      jitSafetyDays: Math.trunc(boundedNumber(delivery.jitSafetyDays, 0, 30, 2)),
    },
    ngOutput: {
      goodQuantityAction: enumValue(ngOutput.goodQuantityAction, ["CONTINUE", "WAIT_REPAIR", "WAIT_ALL_COMPLETE"], "CONTINUE"),
      outputPriority: enumValue(ngOutput.outputPriority, ["NEAREST_DELIVERY", "FIFO", "CUSTOMER_PRIORITY", "PROPORTIONAL", "MANUAL"], "NEAREST_DELIVERY"),
    },
  };
}
function assertCapacityFlowRule(rule) {
  if (rule.algorithmProfile !== "CUSTOM") return;
  if (rule.flowMethod === "SPLIT_BATCH" && rule.flow.transferBatchQuantity <= 0) throw Object.assign(new Error("Transfer batch quantity wajib lebih dari nol untuk metode Split Batch."), { statusCode: 400 });
  if (rule.flowMethod === "SPLIT_PHASE" && rule.flow.phaseDistribution === "PERCENTAGE") {
    const total = rule.flow.phasePercentages.reduce((sum, value) => sum + value, 0);
    if (rule.flow.phasePercentages.length !== rule.flow.phaseCount || Math.abs(total - 100) > 0.01) throw Object.assign(new Error("Persentase phase harus sesuai jumlah phase dan totalnya 100%."), { statusCode: 400 });
  }
  if (rule.flowMethod === "CONTINUOUS_FLOW" && rule.flow.maximumWip > 0 && rule.flow.minimumWip > rule.flow.maximumWip) throw Object.assign(new Error("Minimum WIP Continuous Flow tidak boleh melebihi Maximum WIP."), { statusCode: 400 });
  if (rule.wip.maximum > 0 && rule.wip.minimum > rule.wip.maximum) throw Object.assign(new Error("Minimum WIP tidak boleh melebihi Maximum WIP."), { statusCode: 400 });
}
const dateOnly = (value) => {
  const input = value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString().slice(0, 10)
    : String(value || "").slice(0, 10);
  const parsed = new Date(`${input}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const jakartaTodayDate = () => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return dateOnly(`${values.year}-${values.month}-${values.day}`);
};
function assertCapacityDateEditable(value) {
  const allocationDate = value instanceof Date ? dateOnly(value) : dateOnly(value);
  if (allocationDate && allocationDate < jakartaTodayDate()) {
    throw Object.assign(new Error(`Capacity ${allocationDate.toISOString().slice(0, 10)} sudah menjadi histori Production dan tidak dapat diubah.`), { statusCode: 409, code: "CAPACITY_HISTORY_LOCKED" });
  }
  return allocationDate;
}
const executionShift = (value) => {
  const normalized = String(value || "").trim().toUpperCase();
  return ({ "1": "1A", "2": "2A", "3": "3A" })[normalized] || normalized;
};
const calendarDaysBetween = (start, end) => Math.max(Math.ceil((end - start) / 86400000), 0);
const freezeFenceDate = (days) => { const value = new Date(); value.setUTCHours(0, 0, 0, 0); value.setUTCDate(value.getUTCDate() + Math.max(Math.trunc(number(days)), 0)); return value; };
function requireFreezeOverride(plan, allocationDate, planningMode, body) {
  assertCapacityDateEditable(allocationDate);
  if (planningMode !== "PRODUCTION" || !allocationDate || allocationDate > freezeFenceDate(plan.freezeFenceDays)) return null;
  const reason = text(body?.freezeOverrideReason || body?.overrideReason);
  if (!reason || reason.length < 10) throw Object.assign(new Error(`Tanggal berada dalam freeze fence ${number(plan.freezeFenceDays)} hari. Isi alasan override minimal 10 karakter.`), { statusCode: 409, code: "CAPACITY_FREEZE_FENCE" });
  if (plan.status === "Released" && plan.capacityOverrideApproved !== true && body?.freezeOverrideApproved !== true) {
    throw Object.assign(new Error("Released DPP dalam freeze fence memerlukan override approval sebelum jadwal diubah."), { statusCode: 409, code: "DPP_FREEZE_OVERRIDE_APPROVAL_REQUIRED" });
  }
  return reason;
}
const isGeneratedProcess = (row) => String(row?.notes || "").includes("[MRP-PRODUCTION]");
const isChildFgReceipt = (row) => isGeneratedProcess(row)
  && String(row?.part?.itemType || "").trim().toUpperCase() === "FG";
const sourceMrpRunNumber = (row) => String(row?.notes || "").match(/\[MRP-RUN:([^\]]+)\]/)?.[1] || null;
const sourceMrpRunNumbers = (plan) => {
  const detailRunNumbers = [...new Set(
    (Array.isArray(plan?.details) ? plan.details : []).map(sourceMrpRunNumber).filter(Boolean),
  )];
  // Detail rows are the executable snapshot and therefore authoritative. The
  // recommendation audit is only a fallback for older plans without markers;
  // combining both can create a false mismatch after the details were already
  // synchronized to a newer MRP revision.
  if (detailRunNumbers.length) return detailRunNumbers;
  const auditRunNumber = plan?.recommendationSummary?.sourcePlanSync?.sourceMrpRunNumber;
  return auditRunNumber ? [auditRunNumber] : [];
};

function canonicalMrpExecutionNotes(notes, runNumber, targetKey, executionMonth) {
  const preserved = String(notes || "")
    .replace(/\s*\[MRP-(?:RUN|TARGET|ORDER-MONTH):[^\]]+\]/g, "")
    .trim();
  return [
    preserved,
    `[MRP-RUN:${runNumber}]`,
    `[MRP-TARGET:${targetKey}]`,
    `[MRP-ORDER-MONTH:${executionMonth}]`,
  ].filter(Boolean).join(" ");
}

function capacityHorizonEnd(plan) {
  const dates = [plan?.periodEnd, ...(plan?.details || []).map((detail) => detail.requiredDate)]
    .map(dateOnly)
    .filter(Boolean);
  return dates.length ? new Date(Math.max(...dates.map((value) => value.getTime()))) : dateOnly(plan?.periodEnd);
}

function scheduleTimingSnapshot(plan, officialAllocations = []) {
  const active = ["Draft", "Confirmed"].includes(String(plan?.status || ""));
  const outstandingLines = (Array.isArray(plan?.details) ? plan.details : [])
    .filter((row) => number(row.qtyPlanned) > number(row.qtyReleased) + 0.000001);
  const executableAllocations = (Array.isArray(officialAllocations) ? officialAllocations : [])
    .filter((row) => !row.isDeleted && row.status !== "Cancelled")
    .filter((row) => number(row.plannedQty) > 0);
  const allocationStarts = executableAllocations
    .map((row) => dateOnly(String(row.routingMode || "").toUpperCase() === "VENDOR" ? (row.vendorSendDate || row.scheduleDate) : row.scheduleDate))
    .filter(Boolean);
  const backwardStarts = outstandingLines.map((row) => dateOnly(row.latestStartDate)).filter(Boolean);
  const starts = allocationStarts.length ? allocationStarts : backwardStarts;
  const estimatedStart = starts.length ? new Date(Math.min(...starts.map((value) => value.getTime()))) : null;
  const today = jakartaTodayDate();
  const activeRule = plan?.recommendationSummary?.capacityFlowRule?.active;
  const deliveryJitProtected = activeRule?.delivery?.schedulePolicy === "DELIVERY_JIT"
    && plan?.recommendationVersion === CAPACITY_RECOMMENDATION_VERSION
    && number(plan?.recommendationSummary?.blockerCount) === 0
    && number(plan?.recommendationSummary?.allocationCount) > 0;
  const daysLate = active && !deliveryJitProtected && estimatedStart && estimatedStart < today
    ? Math.ceil((today.getTime() - estimatedStart.getTime()) / 86400000)
    : 0;
  return {
    estimatedStart,
    today,
    daysLate,
    late: daysLate > 0,
    active,
    deliveryJitProtected,
    source: allocationStarts.length ? "OFFICIAL_ALLOCATION" : "BACKWARD_REQUIREMENT",
    outstandingLineCount: outstandingLines.length,
    officialAllocationCount: executableAllocations.length,
  };
}

function officialAllocationSelect() {
  return {
    scheduleDate: true,
    vendorSendDate: true,
    routingMode: true,
    plannedQty: true,
    status: true,
    isDeleted: true,
  };
}

function loadOfficialAllocations(planId) {
  if (!planId) return Promise.resolve([]);
  return prisma.productionPlanAllocation.findMany({
    where: { planId, isDeleted: false, status: { not: "Cancelled" } },
    select: officialAllocationSelect(),
  });
}

function capacityUnscheduledNotices(capacity, planNumber = null) {
  return (capacity?.unscheduled || [])
    .filter((row) => !planNumber || row.reference === planNumber || row.planNumber === planNumber)
    .map((row) => ({
      code: "UNSCHEDULED_FOLLOW_UP",
      severity: "WARNING",
      partCode: row.partCode || null,
      processCode: row.processCode || null,
      qty: number(row.qty),
      uomCode: row.uomCode || null,
      reason: row.reason || "Belum memperoleh jadwal executable.",
      message: `${row.partCode || row.reference || "Load"}${row.processCode ? ` · ${row.processCode}` : ""} belum terjadwal dan wajib ditindaklanjuti pada review berikutnya.`,
    }));
}

async function nextPlanNumber(tx, value) {
  const date = dateOnly(value) || new Date();
  const prefix = `PP-${date.getUTCFullYear()}-`;
  const last = await tx.monthlyProductionPlan.findFirst({ where: { planNumber: { startsWith: prefix } }, orderBy: { planNumber: "desc" }, select: { planNumber: true } });
  const sequence = Number(last?.planNumber?.split("-").pop() || 0) + 1;
  return `${prefix}${String(sequence).padStart(4, "0")}`;
}

async function nextDailyPlanNumber(tx, value) {
  const date = value instanceof Date ? value : new Date(value);
  const prefix = `DPS-${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}-`;
  const last = await tx.dailyProductionSchedule.findFirst({
    where: { scheduleNumber: { startsWith: prefix } },
    orderBy: { scheduleNumber: "desc" },
    select: { scheduleNumber: true },
  });
  const sequence = number(last?.scheduleNumber?.split("-").pop()) + 1;
  return `${prefix}${String(sequence).padStart(3, "0")}`;
}

async function nextWorkOrderNumber(tx, value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const prefix = `WO-${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}-`;
  const last = await tx.workOrder.findFirst({
    where: { woNumber: { startsWith: prefix } },
    orderBy: { woNumber: "desc" },
    select: { woNumber: true },
  });
  return `${prefix}${String(number(last?.woNumber?.split("-").pop()) + 1).padStart(3, "0")}`;
}

function dailyPlanMarker(planNumber, allocation, moNumber) {
  return `[PPIC-DPP:${planNumber}:${allocation.lineNumber}:${allocation.mbomProcessId}:${allocation.scheduleDate}:${allocation.shift}:${moNumber}:${allocation.routingMode}]`;
}

function serialize(plan) {
  if (!plan) return plan;
  const supersededByPlanNumber = String(plan.notes || "").match(/\[SUPERSEDED-BY:([^\]]+)\]/)?.[1] || null;
  const receiptLines = plan.details.filter((row) => !isGeneratedProcess(row));
  const childReceiptLines = plan.details.filter(isChildFgReceipt);
  const processLines = plan.details.filter((row) => isGeneratedProcess(row) && !isChildFgReceipt(row));
  const productionStarts = plan.details.map((row) => dateOnly(row.latestStartDate || row.requiredDate)).filter(Boolean);
  const productionEnds = plan.details.map((row) => dateOnly(row.customerTargetDate || row.fgRequiredDate || row.requiredDate)).filter(Boolean);
  const deliveryDates = receiptLines.map((row) => dateOnly(row.customerTargetDate || row.fgRequiredDate || row.requiredDate)).filter(Boolean);
  const planningHorizonStart = productionStarts.length
    ? new Date(Math.min(...productionStarts.map((value) => value.getTime())))
    : dateOnly(plan.periodStart);
  const planningHorizonEnd = productionEnds.length
    ? new Date(Math.max(...productionEnds.map((value) => value.getTime())))
    : capacityHorizonEnd(plan);
  const deliveryCoverageStart = deliveryDates.length ? new Date(Math.min(...deliveryDates.map((value) => value.getTime()))) : null;
  const deliveryCoverageEnd = deliveryDates.length ? new Date(Math.max(...deliveryDates.map((value) => value.getTime()))) : null;
  return {
    ...plan,
    documentType: "PRODUCTION_PLAN",
    planningIdentity: {
      ownershipRule: "DEMAND_PHASE_HORIZON",
      monthRole: "CALENDAR_FILTER_ONLY",
      sourceMpsNumber: String(plan.sourceType || "").startsWith("MPS:") ? String(plan.sourceType).slice(4) : null,
      horizonStart: planningHorizonStart,
      horizonEnd: planningHorizonEnd,
      deliveryCoverageStart,
      deliveryCoverageEnd,
      crossMonth: Boolean(planningHorizonStart && planningHorizonEnd && monthKey(planningHorizonStart) !== monthKey(planningHorizonEnd)),
      legacyMonthlyNumber: String(plan.planNumber || "").startsWith("MPP-") ? plan.planNumber : null,
      supersededByPlanNumber,
    },
    schedulingHorizonEnd: capacityHorizonEnd(plan),
    targetQty: receiptLines.reduce((sum, row) => sum + number(row.qtyPlanned), 0),
    actualQty: receiptLines.reduce((sum, row) => sum + number(row.qtyReleased), 0),
    forecastQty: receiptLines.reduce((sum, row) => sum + number(row.phaseForecastQty ?? row.forecastQty), 0),
    bufferQty: receiptLines.reduce((sum, row) => sum + number(row.phaseBufferQty ?? row.bufferQty), 0),
    actualSalesOrderQty: receiptLines.reduce((sum, row) => sum + number(row.phaseActualSalesOrderQty ?? row.actualSalesOrderQty), 0),
    lineCount: plan.details.length,
    receiptLineCount: receiptLines.length,
    childReceiptLineCount: childReceiptLines.length,
    processLineCount: processLines.length,
    sourceMpsNumber: String(plan.sourceType || "").startsWith("MPS:") ? String(plan.sourceType).slice(4) : null,
  };
}

function detailFromMps(row, lineNumber) {
  const uomCode = row.part?.productionUomCode
    || row.part?.baseUomCode
    || row.part?.stockUomCode
    || row.mbom?.uomCode
    || (["FG", "WIP"].includes(String(row.part?.itemType || "").trim().toUpperCase()) ? "PCS" : null);
  return {
    lineNumber,
    plannedOrderNumber: null,
    mrpRequirementId: row.mrpRequirementId || null,
    mrpRequirementIds: Array.isArray(row.mrpRequirementIds) ? row.mrpRequirementIds : undefined,
    mrpRootRequirementId: row.mrpRootRequirementId || null,
    partCode: row.partCode,
    partId: row.partId || row.part?.id || null,
    mpsDetailId: row.id,
    forecastQty: number(row.forecastQty),
    actualSalesOrderQty: number(row.actualSalesOrderQty),
    bufferBaseQty: number(row.bufferBaseQty),
    bufferPercent: number(row.bufferPercent),
    bufferQty: number(row.bufferQty),
    productionPercent: number(row.productionPercent || 100),
    effectiveDemandQty: number(row.effectiveDemandQty),
    qtyPlanned: normalizeQuantity(row.qtyPlanned, uomCode),
    uomCode,
    requiredDate: row.endDate,
    priority: number(row.priority) || 1,
    deliveryPhaseId: row.deliveryPhaseId || null,
    customerCode: row.customerCode || null,
    customerTargetDate: row.customerTargetDate || row.endDate || null,
    fgRequiredDate: row.fgRequiredDate || row.endDate || null,
    priorityScore: row.priorityScore ?? null,
    priorityClass: row.priorityClass || null,
    latestStartDate: row.startDate || null,
    latestFinishDate: row.fgRequiredDate || row.endDate || null,
    status: "Planned",
    notes: `[MPS-LINE:${row.lineNumber}] ${row.notes || ""}`.trim(),
  };
}

function sourcePartCode(row) {
  return String(row?.notes || "").match(/;\s*source\s+(.+?)(?:;|$)/i)?.[1]?.trim() || null;
}

function sourceMpsDetailId(row) {
  return String(row?.notes || "").match(/\[MPS-SOURCE:([^\]]+)\]/)?.[1] || null;
}

function mrpTargetKeyFromDetail(row) {
  return String(row?.notes || "").match(/\[MRP-TARGET:([^\]]+)\]/)?.[1] || null;
}

function mrpOrderMonthFromDetail(row) {
  return String(row?.notes || "").match(/\[MRP-ORDER-MONTH:(\d{4}-\d{2})\]/)?.[1] || null;
}

function planningMonthForMpsDetail(row, mpsDetailById = new Map()) {
  const executionMonth = mrpOrderMonthFromDetail(row);
  if (executionMonth) return executionMonth;
  const parentSource = mpsDetailById.get(sourceMpsDetailId(row));
  // Legacy/non-split rows stay with the parent FG. Current MRP process rows
  // carry their authoritative execution month in the marker above.
  return monthKey(parentSource?.startDate || row.startDate);
}

function stableMpsPlanDetailMatch(existingDetail, mpsRow, sourceLineMarker) {
  if (!existingDetail || !mpsRow) return false;
  if (String(existingDetail.partCode || "") !== String(mpsRow.partCode || "")) return false;

  const existingIsProcess = isGeneratedProcess(existingDetail);
  const rowIsProcess = isGeneratedProcess(mpsRow);
  if (existingIsProcess !== rowIsProcess) return false;
  const existingTarget = mrpTargetKeyFromDetail(existingDetail);
  const rowTarget = mrpTargetKeyFromDetail(mpsRow);
  const existingMonth = mrpOrderMonthFromDetail(existingDetail);
  const rowMonth = mrpOrderMonthFromDetail(mpsRow);
  if (existingDetail.mpsDetailId === mpsRow.id && !rowIsProcess) {
    if (existingTarget || rowTarget || existingMonth || rowMonth) {
      return existingTarget === rowTarget && existingMonth === rowMonth;
    }
    return true;
  }

  // Generated MPS ids and line numbers are recreated on every MRP revision.
  // Parent MPS id + part + pegged target/month is the stable execution identity.
  if (rowIsProcess) {
    const existingSourceId = sourceMpsDetailId(existingDetail);
    const rowSourceId = sourceMpsDetailId(mpsRow);
    if (existingSourceId && rowSourceId && existingSourceId === rowSourceId) {
      if (existingTarget || rowTarget || existingMonth || rowMonth) {
        return existingTarget === rowTarget && existingMonth === rowMonth;
      }
      return true;
    }
    if (existingTarget || rowTarget || existingMonth || rowMonth) return false;
  }

  return Boolean(sourceLineMarker && String(existingDetail.notes || "").includes(sourceLineMarker));
}

async function nextMonthlyPlanDetailLineNumber(tx, planId) {
  // Soft-deleted detail rows still participate in the database unique key
  // (plan_id, line_number). Serialize allocation per plan and derive the next
  // number from the complete history so a re-sync never reuses a retired line.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`MPP_DETAIL_LINE:${planId}`}, 0))`;
  const aggregate = await tx.monthlyProductionPlanDetail.aggregate({
    where: { planId },
    _max: { lineNumber: true },
  });
  return number(aggregate?._max?.lineNumber) + 1;
}

// Production Plan is an execution proposal: PPIC may reduce/increase the
// forecast portion here without changing the approved MPS.  Actual SO remains
// a hard floor, and child/SFG quantities follow their parent FG proportionally.
function derivePlanDetails(mpsDetails, productionPercent, netProductionByMpsDetail = new Map()) {
  const ratio = productionPercent / 100;
  const isProcess = (row) => isGeneratedProcess(row);
  const receipts = mpsDetails.filter((row) => !isProcess(row));
  const receiptById = new Map(receipts.map((row) => [row.id, row]));
  const receiptByLegacyKey = new Map(receipts.map((row) => [`${row.customerCode || ""}|${row.partCode}|${row.forecastPeriodOffset || ""}`, row]));
  const receiptByMonth = new Map(receipts.map((row) => [`${row.customerCode || ""}|${row.partCode}|${monthKey(row.startDate)}`, row]));
  const adjustedReceiptQty = new Map(receipts.map((row) => {
    const mrpNetQty = netProductionByMpsDetail.get(row.id);
    const baseQty = mrpNetQty == null
      ? Math.max(number(row.effectiveDemandQty), number(row.actualSalesOrderQty))
      : number(mrpNetQty);
    const uomCode = row.part?.productionUomCode || row.part?.baseUomCode || row.part?.stockUomCode || (["FG", "WIP"].includes(String(row.part?.itemType || "").trim().toUpperCase()) ? "PCS" : null);
    return [row.id, normalizeQuantity(baseQty * ratio, uomCode)];
  }));
  return mpsDetails.map((row) => {
    if (!isProcess(row)) {
      const rowUomCode = row.part?.productionUomCode
        || row.part?.baseUomCode
        || row.part?.stockUomCode
        || (["FG", "WIP"].includes(String(row.part?.itemType || "").trim().toUpperCase()) ? "PCS" : row.uomCode);
      return {
        ...row,
        // Carry the canonical UOM into phase splitting. Discrete quantities
        // must be rounded while distributing the total so the final phase
        // receives the remainder (for example 280 -> 93 + 93 + 94), instead
        // of rounding every persisted phase independently to 93.
        uomCode: rowUomCode,
        productionPercent,
        qtyPlanned: adjustedReceiptQty.get(row.id),
      };
    }
    const sourceId = String(row.notes || "").match(/\[MPS-SOURCE:([^\]]+)\]/)?.[1];
    const source = receiptById.get(sourceId) || receiptByLegacyKey.get(`${row.customerCode || ""}|${sourcePartCode(row) || ""}|${row.forecastPeriodOffset || ""}`) || receiptByMonth.get(`${row.customerCode || ""}|${sourcePartCode(row) || ""}|${monthKey(row.startDate)}`);
    if (!source) {
      const rowUom = row.part?.productionUomCode || row.part?.baseUomCode || row.part?.stockUomCode || (["FG", "WIP"].includes(String(row.part?.itemType || "").trim().toUpperCase()) ? "PCS" : row.uomCode);
      return { ...row, uomCode: row.uomCode || rowUom, qtyPlanned: normalizeQuantity(number(row.qtyPlanned) * ratio, rowUom) };
    }
    const sourceOriginalQty = Math.max(number(source.qtyPlanned), 0);
    const childFactor = sourceOriginalQty > 0 ? number(row.qtyPlanned) / sourceOriginalQty : 1;
    return {
      ...row,
      uomCode: row.uomCode || row.part?.productionUomCode || row.part?.baseUomCode || row.part?.stockUomCode || (["FG", "WIP"].includes(String(row.part?.itemType || "").trim().toUpperCase()) ? "PCS" : null),
      forecastQty: number(row.forecastQty) || number(source.forecastQty), actualSalesOrderQty: number(row.actualSalesOrderQty) || number(source.actualSalesOrderQty), bufferBaseQty: number(row.bufferBaseQty) || number(source.bufferBaseQty), bufferPercent: number(row.bufferPercent) || number(source.bufferPercent), bufferQty: number(row.bufferQty) || number(source.bufferQty), effectiveDemandQty: number(row.effectiveDemandQty) || number(source.effectiveDemandQty), productionPercent,
      // Generated MPS process rows already contain the MRP-netted production
      // quantity. Only apply PPIC's explicit production percentage here.
      qtyPlanned: normalizeQuantity(netProductionByMpsDetail.has(source.id)
        ? number(row.qtyPlanned) * ratio
        : Math.max(adjustedReceiptQty.get(source.id) * childFactor, number(source.actualSalesOrderQty) * childFactor), row.part?.productionUomCode || row.part?.baseUomCode || row.part?.stockUomCode || (["FG", "WIP"].includes(String(row.part?.itemType || "").trim().toUpperCase()) ? "PCS" : row.uomCode)),
    };
  });
}
async function currentCompletedMrpForMps(mps) {
  const anchorMonth = mps.planningAnchorMonth || mps.periodStart;
  const anchorMonthEnd = new Date(anchorMonth);
  anchorMonthEnd.setUTCMonth(anchorMonthEnd.getUTCMonth() + 1, 1);
  anchorMonthEnd.setUTCHours(0, 0, 0, 0);
  const candidates = await prisma.mRPRun.findMany({
    where: {
      isDeleted: false,
      isCurrentPlan: true,
      status: "Completed",
      OR: [
        { mpsNumber: mps.mpsNumber },
        { planningMonth: { gte: monthStart(anchorMonth), lt: anchorMonthEnd } },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { runNumber: true, mpsNumber: true, planRevision: true, planningMonth: true, scenarioAssumptions: true },
  });
  return candidates.find((run) => {
    const sourceMpsNumbers = Array.isArray(run.scenarioAssumptions?.sourceMpsNumbers)
      ? run.scenarioAssumptions.sourceMpsNumbers
      : [run.mpsNumber];
    return run.mpsNumber === mps.mpsNumber || sourceMpsNumbers.includes(mps.mpsNumber);
  }) || null;
}

async function netProductionByMpsDetailForRun(runNumber) {
  const rootRequirements = await prisma.mRPRequirement.findMany({
    where: {
      runNumber,
      isDeleted: false,
      orderType: "Production",
      requirementType: "Independent",
      levelMBOM: 0,
      mpsDetailId: { not: null },
    },
    select: { mpsDetailId: true, plannedOrderQty: true, adjustedOrderQty: true, netRequirement: true },
  });
  const result = new Map();
  for (const row of rootRequirements) {
    const qty = number(row.adjustedOrderQty || row.plannedOrderQty || row.netRequirement);
    result.set(row.mpsDetailId, number(result.get(row.mpsDetailId)) + qty);
  }
  return result;
}

function requirementTargetKey(row) {
  const deliveryTargetId = text(row?.deliveryTargetId);
  if (deliveryTargetId) return deliveryTargetId;
  const targetDate = row?.targetDeliveryDate || row?.requiredDate || row?.productionRequiredDate;
  const date = targetDate ? new Date(targetDate).toISOString().slice(0, 10) : "UNSCHEDULED";
  return String(row?.rootDemandSourceType || "TARGET").toUpperCase() + ":" + date;
}

function requirementExecutionQty(row = {}) {
  // Independent FG rows already carry the authoritative MPS/MRP net
  // production quantity. Dependent production rows represent a process
  // output: only stock of that exact output can remove the operation. Stock
  // at an earlier child stage still needs the downstream transformation.
  if (String(row.requirementType || "").toUpperCase() === "DEPENDENT"
    && number(row.levelMBOM) > 0) {
    return Math.max(
      number(row.netRequirement),
      number(row.grossRequirement) - number(row.onHandQty),
      0,
    );
  }
  return Math.max(number(row.netRequirement), 0);
}

function consolidateGeneratedExecutionDetails(rows = []) {
  const result = [];
  const generatedByKey = new Map();
  for (const row of rows) {
    if (!isGeneratedProcess(row)) {
      result.push(row);
      continue;
    }
    const key = [
      sourceMpsDetailId(row) || row.mpsDetailId || row.id || "-",
      row.partCode || "-",
      mrpTargetKeyFromDetail(row) || "-",
      mrpOrderMonthFromDetail(row) || monthKey(row.startDate || row.requiredDate),
    ].join("|");
    const current = generatedByKey.get(key);
    if (!current) {
      const consolidated = { ...row };
      generatedByKey.set(key, consolidated);
      result.push(consolidated);
      continue;
    }
    current.qtyPlanned = normalizeQuantity(number(current.qtyPlanned) + number(row.qtyPlanned), current.uomCode || row.uomCode);
    if (row.startDate && (!current.startDate || new Date(row.startDate) < new Date(current.startDate))) current.startDate = row.startDate;
    if (row.endDate && (!current.endDate || new Date(row.endDate) > new Date(current.endDate))) current.endDate = row.endDate;
    if (row.latestStartDate && (!current.latestStartDate || new Date(row.latestStartDate) < new Date(current.latestStartDate))) current.latestStartDate = row.latestStartDate;
  }
  return result;
}

async function splitPlanDetailsByMrpExecutionMonth(runNumber, planDetails) {
  const detailSourceId = (detail) => isGeneratedProcess(detail) ? sourceMpsDetailId(detail) : detail.id;
  const sourceIds = [...new Set(planDetails.map(detailSourceId).filter(Boolean))];
  const partCodes = [...new Set(planDetails.map((row) => row.partCode).filter(Boolean))];
  if (!sourceIds.length || !partCodes.length) return planDetails;

  const requirements = await prisma.mRPRequirement.findMany({
    where: {
      runNumber,
      isDeleted: false,
      orderType: "Production",
      requirementType: { in: ["Independent", "Dependent"] },
      levelMBOM: { gte: 0 },
      grossRequirement: { gt: 0.000001 },
      mpsDetailId: { in: sourceIds },
      partCode: { in: partCodes },
    },
    select: {
      id: true,
      rootRequirementId: true,
      mpsDetailId: true,
      partCode: true,
      requirementType: true,
      levelMBOM: true,
      deliveryTargetId: true,
      targetDeliveryDate: true,
      rootDemandSourceType: true,
      orderDate: true,
      materialRequiredDate: true,
      productionRequiredDate: true,
      requiredDate: true,
      grossRequirement: true,
      onHandQty: true,
      forecastQty: true,
      soConsumedQty: true,
      effectiveDemandQty: true,
      bufferBaseQty: true,
      bufferPercent: true,
      bufferQty: true,
      netRequirement: true,
      priorityScore: true,
      priorityClass: true,
      customerCode: true,
    },
  });
  const groupsByProcess = new Map();
  for (const requirement of requirements) {
    const executionQty = requirementExecutionQty(requirement);
    if (executionQty <= 0.000001) continue;
    const executionDate = requirement.orderDate || requirement.materialRequiredDate || requirement.productionRequiredDate || requirement.requiredDate;
    if (!executionDate) continue;
    const executionMonth = monthKey(executionDate);
    const targetKey = requirementTargetKey(requirement);
    const processKey = requirement.mpsDetailId + "|" + requirement.partCode;
    if (!groupsByProcess.has(processKey)) groupsByProcess.set(processKey, new Map());
    const campaignKey = targetKey + "|" + executionMonth;
    const processGroups = groupsByProcess.get(processKey);
    const current = processGroups.get(campaignKey) || {
      targetKey,
      executionMonth,
      qty: 0,
      startDate: executionDate,
      finishDate: requirement.productionRequiredDate || requirement.requiredDate || requirement.targetDeliveryDate || executionDate,
      targetDeliveryDate: requirement.targetDeliveryDate || requirement.requiredDate || null,
      priorityScore: requirement.priorityScore,
      priorityClass: requirement.priorityClass,
      customerCode: requirement.customerCode,
      grossRequirement: 0,
      forecastQty: 0,
      soConsumedQty: 0,
      effectiveDemandQty: 0,
      bufferBaseQty: 0,
      bufferPercent: requirement.bufferPercent,
      bufferQty: 0,
      mrpRequirementIds: [],
      mrpRootRequirementId: null,
    };
    current.qty += executionQty;
    current.grossRequirement += number(requirement.grossRequirement);
    current.forecastQty += number(requirement.forecastQty);
    current.soConsumedQty += number(requirement.soConsumedQty);
    current.effectiveDemandQty += number(requirement.effectiveDemandQty);
    current.bufferBaseQty += number(requirement.bufferBaseQty);
    current.bufferQty += number(requirement.bufferQty);
    current.mrpRequirementIds.push(requirement.id);
    current.mrpRootRequirementId = current.mrpRootRequirementId || requirement.rootRequirementId || requirement.id;
    if (new Date(executionDate) < new Date(current.startDate)) current.startDate = executionDate;
    const finishDate = requirement.productionRequiredDate || requirement.requiredDate || requirement.targetDeliveryDate || executionDate;
    if (new Date(finishDate) > new Date(current.finishDate)) current.finishDate = finishDate;
    processGroups.set(campaignKey, current);
  }

  const splitDetails = planDetails.flatMap((detail) => {
    const generatedProcess = isGeneratedProcess(detail);
    const processGroups = groupsByProcess.get(detailSourceId(detail) + "|" + detail.partCode);
    const groups = processGroups ? [...processGroups.values()] : [];
    groups.sort((left, right) => new Date(left.startDate) - new Date(right.startDate)
      || new Date(left.targetDeliveryDate || left.finishDate) - new Date(right.targetDeliveryDate || right.finishDate)
      || left.targetKey.localeCompare(right.targetKey));
    if (!groups.length) return [detail];
    const totalRequirement = groups.reduce((sum, group) => sum + number(group.qty), 0);
    const plannedTotal = Math.max(number(detail.qtyPlanned), 0);
    const ratio = totalRequirement > 0 ? plannedTotal / totalRequirement : 0;
    let assigned = 0;
    return groups.map((group, index) => {
      const qtyPlanned = index === groups.length - 1
        ? normalizeQuantity(Math.max(plannedTotal - assigned, 0), detail.uomCode)
        : normalizeQuantity(number(group.qty) * ratio, detail.uomCode);
      assigned += qtyPlanned;
      return {
        ...detail,
        qtyPlanned,
        startDate: group.startDate,
        endDate: generatedProcess ? group.finishDate : group.targetDeliveryDate || group.finishDate,
        customerTargetDate: group.targetDeliveryDate || detail.customerTargetDate,
        fgRequiredDate: group.targetDeliveryDate || detail.fgRequiredDate,
        priorityScore: group.priorityScore ?? detail.priorityScore,
        priorityClass: group.priorityClass || detail.priorityClass,
        customerCode: group.customerCode || detail.customerCode,
        mrpRequirementId: group.mrpRequirementIds[0] || null,
        mrpRequirementIds: group.mrpRequirementIds,
        mrpRootRequirementId: group.mrpRootRequirementId || null,
        ...(!generatedProcess ? {
          forecastQty: group.forecastQty,
          actualSalesOrderQty: group.soConsumedQty,
          bufferBaseQty: group.bufferBaseQty,
          bufferPercent: number(group.bufferPercent),
          bufferQty: group.bufferQty,
          effectiveDemandQty: group.grossRequirement || group.effectiveDemandQty,
        } : {}),
        // Revision-scoped MRP markers are replaceable provenance, not an
        // append-only history. Keeping R005 next to R006 makes a fully synced
        // plan look stale even when phase and quantity are identical.
        notes: canonicalMrpExecutionNotes(detail.notes, runNumber, group.targetKey, group.executionMonth),
      };
    }).filter((row) => number(row.qtyPlanned) > 0.000001);
  });
  // MRP can produce more than one technical MPS row for the same physical
  // part/output operation. MPP capacity is executed per MBOM operation, so
  // keep one phase-scoped execution line with the summed quantity. Otherwise
  // an allocation may be persisted against only one fractional line and look
  // larger than its predecessor/target during authoritative validation.
  return consolidateGeneratedExecutionDetails(splitDetails);
}

function productionPlanHorizon(details = [], ownerMonth = null) {
  const starts = details.map((row) => dateOnly(row.startDate || row.latestStartDate || row.endDate)).filter(Boolean);
  const ends = details.map((row) => dateOnly(row.customerTargetDate || row.fgRequiredDate || row.endDate || row.startDate)).filter(Boolean);
  const horizonStart = starts.length ? new Date(Math.min(...starts.map((value) => value.getTime()))) : jakartaTodayDate();
  const horizonEndCandidate = ends.length ? new Date(Math.max(...ends.map((value) => value.getTime()))) : horizonStart;
  const horizonEnd = horizonEndCandidate < horizonStart ? horizonStart : horizonEndCandidate;
  const ownerDate = dateOnly(ownerMonth)
    || (ends.length ? new Date(Math.min(...ends.map((value) => value.getTime()))) : horizonStart);
  return {
    horizonStart,
    horizonEnd,
    // The document belongs to the MPS/delivery month. An earlier predecessor
    // operation is a cross-month schedule, not a reason to relabel September
    // demand as an August Production Plan.
    ownerKey: monthKey(ownerDate),
    crossMonth: monthKey(horizonStart) !== monthKey(horizonEnd),
  };
}

function groupDetailsIntoProductionHorizon(details = [], ownerMonth = null) {
  const horizon = productionPlanHorizon(details, ownerMonth);
  return { horizon, grouped: new Map([[horizon.ownerKey, details]]) };
}

function productionPlanOwnerWindow(horizon) {
  const startDate = monthStart(horizon?.ownerKey);
  const endDate = monthEnd(horizon?.ownerKey);
  if (!startDate || !endDate) throw new Error("Owner month Production Plan tidak valid.");
  return { startDate, endDate };
}

async function syncDraftPlanWithCurrentMps(planNumber, actor = "system") {
  const plan = await prisma.monthlyProductionPlan.findFirst({
    where: { planNumber, isDeleted: false },
    include,
  });
  if (!plan) throw Object.assign(new Error("Monthly Production Plan tidak ditemukan."), { statusCode: 404 });
  if (plan.status !== "Draft") return { synced: false, reason: "PLAN_NOT_DRAFT", planStatus: plan.status };

  const mpsNumber = String(plan.sourceType || "").startsWith("MPS:")
    ? String(plan.sourceType).slice(4)
    : null;
  if (!mpsNumber) return { synced: false, reason: "PLAN_NOT_MPS_SOURCED" };
  const mps = await prisma.mPS.findFirst({
    where: { mpsNumber, isDeleted: false },
    include: {
      details: {
        where: { isDeleted: false, status: { not: "Cancelled" } },
        include: { part: true, mbom: true },
        orderBy: [{ startDate: "asc" }, { lineNumber: "asc" }],
      },
    },
  });
  if (!mps) throw Object.assign(new Error("MPS sumber " + mpsNumber + " tidak ditemukan."), { statusCode: 409, code: "MPS_SOURCE_NOT_FOUND" });
  if (mps.status !== "Confirmed") throw Object.assign(new Error("MPS sumber " + mpsNumber + " harus Confirmed sebelum auto recommendation."), { statusCode: 409, code: "MPS_SOURCE_NOT_CONFIRMED" });
  const completedMrp = await currentCompletedMrpForMps(mps);
  if (!completedMrp) throw Object.assign(new Error("MRP current yang Completed untuk " + mpsNumber + " tidak ditemukan."), { statusCode: 409, code: "CURRENT_MRP_REQUIRED" });

  const netProductionByMpsDetail = await netProductionByMpsDetailForRun(completedMrp.runNumber);
  const receiptProductionPercents = plan.details
    .filter((row) => !isGeneratedProcess(row))
    .map((row) => number(row.productionPercent))
    .filter((value) => value >= 0 && value <= 100);
  const productionPercent = receiptProductionPercents[0] ?? 100;
  const executionDetails = await splitPlanDetailsByMrpExecutionMonth(
    completedMrp.runNumber,
    derivePlanDetails(mps.details, productionPercent, netProductionByMpsDetail),
  );
  const currentPlanDetails = executionDetails;
  const horizon = productionPlanHorizon(currentPlanDetails, mps.planningAnchorMonth || mps.periodStart);
  const ownerWindow = productionPlanOwnerWindow(horizon);
  if (!currentPlanDetails.length) throw Object.assign(new Error("MPS " + mpsNumber + " tidak memiliki detail aktif pada planning horizon."), { statusCode: 409, code: "MPS_HORIZON_DETAIL_NOT_FOUND" });

  return prisma.$transaction(async (tx) => {
    const current = await tx.monthlyProductionPlan.findUnique({ where: { id: plan.id }, include });
    let nextLineNumber = await nextMonthlyPlanDetailLineNumber(tx, current.id);
    const matchedIds = new Set();
    const createdPartCodes = [];
    const updatedPartCodes = [];
    for (const row of currentPlanDetails) {
      const sourceLineMarker = "[MPS-LINE:" + row.lineNumber + "]";
      const matched = current.details.find((detail) =>
        !matchedIds.has(detail.id)
        && stableMpsPlanDetailMatch(detail, row, sourceLineMarker));
      const data = detailFromMps(row, matched?.lineNumber || nextLineNumber++);
      if (matched) {
        matchedIds.add(matched.id);
        await tx.monthlyProductionPlanDetail.update({ where: { id: matched.id }, data });
        updatedPartCodes.push(row.partCode);
      } else {
        await tx.monthlyProductionPlanDetail.create({ data: { ...data, planId: current.id } });
        createdPartCodes.push(row.partCode);
      }
    }
    const stale = current.details.filter((detail) => !matchedIds.has(detail.id));
    const protectedStale = stale.filter((detail) => number(detail.qtyReleased) > 0.000001);
    if (protectedStale.length) throw Object.assign(new Error("MPP memiliki " + protectedStale.length + " detail released yang sudah tidak ada di " + mpsNumber + "; batalkan/review eksekusi sebelum replan."), { statusCode: 409, code: "RELEASED_MPP_DETAIL_SOURCE_MISMATCH" });
    if (stale.length) await tx.monthlyProductionPlanDetail.updateMany({
      where: { id: { in: stale.map((detail) => detail.id) } },
      data: { isDeleted: true, status: "Cancelled", notes: "Synchronized from " + mpsNumber + ": MPS line no longer active" },
    });
    const audit = {
      synced: true,
      syncedAt: new Date().toISOString(),
      syncedBy: actor,
      sourceMpsNumber: mpsNumber,
      sourceMrpRunNumber: completedMrp.runNumber,
      productionPercent,
      activeDetailCount: currentPlanDetails.length,
      ownershipRule: "DEMAND_PHASE_HORIZON",
      horizonStart: horizon.horizonStart.toISOString(),
      horizonEnd: horizon.horizonEnd.toISOString(),
      createdCount: createdPartCodes.length,
      updatedCount: updatedPartCodes.length,
      retiredCount: stale.length,
      createdPartCodes,
      retiredPartCodes: stale.map((detail) => detail.partCode),
    };
    const currentSummary = current.recommendationSummary && typeof current.recommendationSummary === "object" && !Array.isArray(current.recommendationSummary)
      ? current.recommendationSummary
      : {};
    await tx.monthlyProductionPlan.update({
      where: { id: current.id },
      data: {
        planMonth: monthStart(horizon.ownerKey),
        periodStart: ownerWindow.startDate,
        periodEnd: ownerWindow.endDate,
        recommendationSummary: { ...currentSummary, sourcePlanSync: audit },
      },
    });
    return audit;
  });
}

function reconciliationPhaseKey(row) {
  const target = mrpTargetKeyFromDetail(row)
    || row.deliveryPhaseId
    || String(row.fgRequiredDate || row.customerTargetDate || row.requiredDate || "").slice(0, 10)
    || "UNSCHEDULED";
  return [row.partCode || "-", target].join("|");
}

async function buildSourceReconciliation(plan) {
  const mpsNumber = String(plan?.sourceType || "").startsWith("MPS:")
    ? String(plan.sourceType).slice(4)
    : null;
  const storedMrpRunNumbers = sourceMrpRunNumbers(plan);
  const actualReceipts = (Array.isArray(plan?.details) ? plan.details : []).filter((row) => !isGeneratedProcess(row));
  const actualFgQty = actualReceipts.reduce((sum, row) => sum + number(row.qtyPlanned), 0);
  const base = {
    mpsNumber,
    storedMrpRunNumbers,
    storedMrpRunNumber: storedMrpRunNumbers.length === 1 ? storedMrpRunNumbers[0] : null,
    actualReceiptCount: actualReceipts.length,
    actualFgQty,
  };
  if (!mpsNumber) return { ...base, current: true, status: "NOT_APPLICABLE", reasons: [] };
  const mps = await prisma.mPS.findFirst({
    where: { mpsNumber, isDeleted: false },
    include: {
      details: {
        where: { isDeleted: false, status: { not: "Cancelled" } },
        include: { part: true, mbom: true },
        orderBy: [{ startDate: "asc" }, { lineNumber: "asc" }],
      },
    },
  });
  if (!mps) return { ...base, current: false, status: "MPS_MISSING", reasons: ["MPS_SOURCE_NOT_FOUND"] };
  const currentMrp = await currentCompletedMrpForMps(mps);
  if (!currentMrp) return { ...base, current: false, status: "MRP_MISSING", reasons: ["CURRENT_MRP_NOT_FOUND"] };

  const netProductionByMpsDetail = await netProductionByMpsDetailForRun(currentMrp.runNumber);
  const receiptPercent = actualReceipts.map((row) => number(row.productionPercent)).find((value) => value >= 0 && value <= 100) ?? 100;
  const currentDetails = await splitPlanDetailsByMrpExecutionMonth(
    currentMrp.runNumber,
    derivePlanDetails(mps.details, receiptPercent, netProductionByMpsDetail),
  );
  const expectedReceipts = currentDetails.filter((row) => !isGeneratedProcess(row));
  const expectedFgQty = expectedReceipts.reduce((sum, row) => sum + number(row.qtyPlanned), 0);
  const actualPhaseKeys = new Set(actualReceipts.map(reconciliationPhaseKey));
  const expectedPhaseKeys = new Set(expectedReceipts.map(reconciliationPhaseKey));
  const missingPhaseKeys = [...expectedPhaseKeys].filter((key) => !actualPhaseKeys.has(key));
  const obsoletePhaseKeys = [...actualPhaseKeys].filter((key) => !expectedPhaseKeys.has(key));
  const quantityDelta = expectedFgQty - actualFgQty;
  const revisionCurrent = storedMrpRunNumbers.length === 1 && storedMrpRunNumbers[0] === currentMrp.runNumber;
  const phasesCurrent = missingPhaseKeys.length === 0 && obsoletePhaseKeys.length === 0;
  const quantityCurrent = Math.abs(quantityDelta) <= 0.000001;
  const reasons = [
    ...(!revisionCurrent ? ["MRP_REVISION_STALE"] : []),
    ...(!phasesCurrent ? ["DELIVERY_PHASE_MISMATCH"] : []),
    ...(!quantityCurrent ? ["FG_QTY_MISMATCH"] : []),
  ];
  return {
    ...base,
    currentMrpRunNumber: currentMrp.runNumber,
    currentMpsStatus: mps.status,
    expectedReceiptCount: expectedReceipts.length,
    expectedDetailCount: currentDetails.length,
    expectedFgQty,
    quantityDelta,
    missingPhaseKeys,
    obsoletePhaseKeys,
    revisionCurrent,
    phasesCurrent,
    quantityCurrent,
    current: reasons.length === 0,
    status: reasons.length ? "REPLAN_REQUIRED" : "CURRENT",
    reasons,
  };
}

function assertPlanSourceAndTimingReady(plan, reconciliation, officialAllocations = []) {
  if (reconciliation && reconciliation.current === false) {
    throw Object.assign(new Error(
      `Production Plan memakai ${reconciliation.storedMrpRunNumbers?.join(", ") || "snapshot MRP lama"}, sedangkan current MRP adalah ${reconciliation.currentMrpRunNumber || "belum tersedia"}. Sinkronkan ulang Production Plan sebelum dilanjutkan.`,
    ), { statusCode: 409, code: "MPP_SOURCE_REPLAN_REQUIRED", reconciliation });
  }
  const timing = scheduleTimingSnapshot(plan, officialAllocations);
  if (timing.late) {
    throw Object.assign(new Error(
      `Estimated production start ${timing.estimatedStart.toISOString().slice(0, 10)} sudah lewat ${timing.daysLate} hari. Production Plan memerlukan keputusan recovery: percepat capacity/vendor, split delivery, atau revisi target customer sebelum dilanjutkan.`,
    ), { statusCode: 409, code: "MPP_ESTIMATED_START_LATE", timing });
  }
}

async function withMpsSnapshot(plan) {
  const mpsNumber = String(plan?.sourceType || "").startsWith("MPS:") ? String(plan.sourceType).slice(4) : null;
  if (!mpsNumber) return plan;
  const mps = await prisma.mPS.findFirst({
    where: { mpsNumber, isDeleted: false },
    select: {
      details: {
        where: { isDeleted: false },
        select: {
          id: true,
          lineNumber: true,
          partCode: true,
          customerCode: true,
          startDate: true,
          notes: true,
          forecastQty: true,
          actualSalesOrderQty: true,
          bufferBaseQty: true,
          bufferPercent: true,
          bufferQty: true,
          productionPercent: true,
          effectiveDemandQty: true,
          qtyPlanned: true,
          part: { select: { partName: true, partNumber: true } },
        },
      },
    },
  });
  if (!mps) return plan;
  const byId = new Map(mps.details.map((row) => [row.id, row]));
  const byLineNumber = new Map(mps.details.map((row) => [String(row.lineNumber), row]));
  const byPartCode = new Map(mps.details.map((row) => [row.partCode, row]));
  return {
    ...plan,
    details: plan.details.map((detail) => {
      const sourceLine = String(detail.notes || "").match(/\[MPS-LINE:(\d+)\]/)?.[1];
      const notedParentPartCode = String(detail.notes || "").match(/(?:^|;)\s*source\s+([^;\s]+)/i)?.[1] || null;
      const source = byId.get(detail.mpsDetailId) || byLineNumber.get(sourceLine);
      if (!source) {
        return {
          ...detail,
          phaseDemandQty: isGeneratedProcess(detail)
            ? number(detail.qtyPlanned)
            : number(detail.effectiveDemandQty || detail.qtyPlanned),
          phaseForecastQty: number(detail.forecastQty),
          phaseActualSalesOrderQty: number(detail.actualSalesOrderQty),
          phaseBufferQty: number(detail.bufferQty),
          phaseEffectiveDemandQty: number(detail.effectiveDemandQty),
          parentFgPartCode: notedParentPartCode || detail.partCode,
        };
      }
      const parentSourceId = String(source.notes || "").match(/\[MPS-SOURCE:([^\]]+)\]/)?.[1];
      const parentSource = byId.get(parentSourceId) || byPartCode.get(notedParentPartCode) || source;
      const synced = {
        ...detail,
        // Keep a date-phased demand value for the MPP matrix before the
        // monthly MPS snapshot below replaces the summary demand fields.
        phaseDemandQty: isGeneratedProcess(detail)
          ? number(detail.qtyPlanned)
          : number(detail.effectiveDemandQty || detail.qtyPlanned),
        phaseForecastQty: number(detail.forecastQty),
        phaseActualSalesOrderQty: number(detail.actualSalesOrderQty),
        phaseBufferQty: number(detail.bufferQty),
        phaseEffectiveDemandQty: number(detail.effectiveDemandQty),
      };
      synced.planningCustomerCode = parentSource.customerCode || null;
      synced.planningMonth = parentSource.startDate || plan.planMonth;
      synced.parentFgPartCode = notedParentPartCode || parentSource.partCode || source.partCode || detail.partCode;
      synced.parentFgPartName = parentSource.part?.partName || parentSource.part?.partNumber || null;
      // Keep the persisted MPP execution quantity. createFromMps already
      // derives it from the current MRP net production; replacing it during a
      // read would incorrectly restore gross MPS demand and ignore FG stock.
      return synced;
    }),
  };
}

async function buildDeliveryPhaseTimeline(plan) {
  const mpsNumber = String(plan?.sourceType || "").startsWith("MPS:")
    ? String(plan.sourceType).slice(4)
    : null;
  if (!plan?.id || !mpsNumber || typeof prisma.mPSDeliveryPlan?.findMany !== "function") {
    return { scope: "DEMAND_PHASE_HORIZON", planNumber: plan?.planNumber || null, sourceMpsNumber: mpsNumber, dates: [], phases: [] };
  }

  const relatedPlans = await prisma.monthlyProductionPlan.findMany({
    where: {
      sourceType: plan.sourceType,
      isDeleted: false,
      OR: [{ id: plan.id }, { status: { in: ["Draft", "Confirmed", "Released", "In Progress"] } }],
    },
    select: {
      id: true,
      planNumber: true,
      periodStart: true,
      status: true,
      details: {
        where: { isDeleted: false, status: { not: "Cancelled" } },
        select: {
          partCode: true,
          qtyPlanned: true,
          fgRequiredDate: true,
          requiredDate: true,
          latestStartDate: true,
          notes: true,
        },
      },
    },
    orderBy: [{ periodStart: "asc" }, { createdAt: "asc" }],
  });
  const relatedPlanIds = relatedPlans.map((row) => row.id);
  const [phases, allocations] = await Promise.all([
    prisma.mPSDeliveryPlan.findMany({
      where: {
        mpsNumber,
        targetType: "CUSTOMER",
        isDeleted: false,
        status: { not: "Cancelled" },
      },
      orderBy: [{ plannedDate: "asc" }, { phaseNumber: "asc" }],
      select: {
        id: true,
        phaseNumber: true,
        targetCode: true,
        targetName: true,
        partCode: true,
        plannedDate: true,
        fgRequiredDate: true,
        qtyPlanned: true,
        uomCode: true,
        status: true,
        sourceDeliveryTargetId: true,
        sourceType: true,
        sourceNumber: true,
      },
    }),
    prisma.productionPlanAllocation.findMany({
      where: {
        planId: { in: relatedPlanIds.length ? relatedPlanIds : [plan.id] },
        planningMode: "PRODUCTION",
        isDeleted: false,
        status: { in: ["Draft", "Published"] },
        deliveryPhaseId: { not: null },
      },
      orderBy: [{ scheduleDate: "asc" }, { plannedStartTime: "asc" }, { transferBatchNumber: "asc" }],
      select: {
        id: true,
        planId: true,
        deliveryPhaseId: true,
        deliveryPhaseNumber: true,
        scheduleDate: true,
        shift: true,
        plannedStartTime: true,
        plannedEndTime: true,
        machineId: true,
        diesId: true,
        vendorId: true,
        vendorSendDate: true,
        vendorReturnDate: true,
        vendorLeadTimeDays: true,
        expectedReturnQty: true,
        routingMode: true,
        plannedQty: true,
        uomCode: true,
        status: true,
        allocationSource: true,
        transferBatchNumber: true,
        demandSourceType: true,
        demandSourceNumber: true,
        plan: { select: { planNumber: true, periodStart: true, periodEnd: true, status: true } },
        mbomProcess: {
          select: {
            sequence: true,
            process: { select: { processCode: true, processName: true } },
            mbomDetail: {
              select: {
                part: { select: { partCode: true, partNumber: true, partName: true, itemType: true, rawType: true } },
              },
            },
          },
        },
        machine: { select: { machineCode: true, machineName: true } },
        vendor: { select: { vendorCode: true, vendorName: true } },
      },
    }),
  ]);

  const parentPartCodes = [...new Set(phases.map((phase) => phase.partCode).filter(Boolean))];
  const parentParts = parentPartCodes.length
    ? await prisma.part.findMany({
      where: { partCode: { in: parentPartCodes }, isDeleted: false },
      select: { partCode: true, partNumber: true, partName: true, itemType: true, rawType: true },
    })
    : [];
  const parentPartByCode = new Map(parentParts.map((part) => [part.partCode, part]));
  const allocationsByPhaseId = new Map();
  const allocationsByPhaseNumber = new Map();
  for (const allocation of allocations) {
    if (allocation.deliveryPhaseId) {
      if (!allocationsByPhaseId.has(allocation.deliveryPhaseId)) allocationsByPhaseId.set(allocation.deliveryPhaseId, []);
      allocationsByPhaseId.get(allocation.deliveryPhaseId).push(allocation);
    }
    if (allocation.deliveryPhaseNumber != null) {
      if (!allocationsByPhaseNumber.has(allocation.deliveryPhaseNumber)) allocationsByPhaseNumber.set(allocation.deliveryPhaseNumber, []);
      allocationsByPhaseNumber.get(allocation.deliveryPhaseNumber).push(allocation);
    }
  }

  const isoDate = (value) => dateOnly(value)?.toISOString().slice(0, 10) || null;
  const dayGap = (left, right) => {
    const leftDate = dateOnly(left);
    const rightDate = dateOnly(right);
    return leftDate && rightDate ? Math.round((rightDate.getTime() - leftDate.getTime()) / 86400000) : null;
  };
  const receiptLines = relatedPlans.flatMap((relatedPlan) => relatedPlan.details
    .filter((detail) => !isGeneratedProcess(detail))
    .map((detail) => ({ ...detail, planNumber: relatedPlan.planNumber, executionMonth: isoDate(relatedPlan.periodStart)?.slice(0, 7) || null })));
  const planningLines = relatedPlans.flatMap((relatedPlan) => relatedPlan.details
    .map((detail) => ({ ...detail, planNumber: relatedPlan.planNumber, executionMonth: isoDate(relatedPlan.periodStart)?.slice(0, 7) || null })));
  const currentRelatedPlan = relatedPlans.find((row) => row.id === plan.id) || null;
  const currentPlanningLines = (currentRelatedPlan?.details || []).map((detail) => ({ ...detail, planNumber: plan.planNumber, executionMonth: isoDate(plan.periodStart)?.slice(0, 7) || null }));
  const currentAllocations = allocations.filter((row) => row.planId === plan.id);
  const scopedTargetKeys = new Set(currentPlanningLines.map(mrpTargetKeyFromDetail).filter(Boolean));
  const scopedAllocationPhaseIds = new Set(currentAllocations.map((row) => row.deliveryPhaseId).filter(Boolean));
  const scopedAllocationPhaseNumbers = new Set(currentAllocations
    .filter((row) => !row.deliveryPhaseId && row.deliveryPhaseNumber != null)
    .map((row) => row.deliveryPhaseNumber));
  const legacyPlanningDates = new Set(currentPlanningLines
    .map((detail) => isoDate(detail.fgRequiredDate || detail.requiredDate))
    .filter(Boolean));
  const activeDeliveryRule = plan.recommendationSummary?.capacityFlowRule?.active?.delivery || {};
  const supersededByPlanNumber = String(plan.notes || "").match(/\[SUPERSEDED-BY:([^\]]+)\]/)?.[1] || null;
  const deliveryJit = activeDeliveryRule.schedulePolicy === "DELIVERY_JIT"
    && plan.recommendationVersion === CAPACITY_RECOMMENDATION_VERSION;
  const scopedPhases = phases.filter((phase) =>
    scopedAllocationPhaseIds.has(phase.id)
    || scopedAllocationPhaseNumbers.has(phase.phaseNumber)
    || (phase.sourceDeliveryTargetId && scopedTargetKeys.has(phase.sourceDeliveryTargetId))
    || (!scopedTargetKeys.size && legacyPlanningDates.has(isoDate(phase.fgRequiredDate || phase.plannedDate))));
  const timelinePhases = scopedPhases.map((phase) => {
    const allPhaseAllocations = allocationsByPhaseId.get(phase.id)
      || allocationsByPhaseNumber.get(phase.phaseNumber)
      || [];
    const currentPhaseAllocations = allPhaseAllocations.filter((row) => row.planId === plan.id);
    const ownerAllocation = [...allPhaseAllocations].sort((left, right) =>
      dateOnly(left.scheduleDate) - dateOnly(right.scheduleDate)
      || dateOnly(left.plan?.periodStart) - dateOnly(right.plan?.periodStart))[0] || null;
    // Legacy month-split plans may have no remaining allocation after their
    // Draft rows are retired. Their explicit supersession marker remains the
    // authoritative owner so an unallocated phase is never counted twice.
    const ownerPlanNumber = ownerAllocation?.plan?.planNumber || supersededByPlanNumber || plan.planNumber;
    const planRole = ownerPlanNumber === plan.planNumber ? "OWNER" : "CARRY_OVER";
    const phaseAllocations = planRole === "OWNER" ? allPhaseAllocations : currentPhaseAllocations;
    const eventByKey = new Map();
    for (const allocation of phaseAllocations) {
      const process = allocation.mbomProcess?.process || {};
      const processPart = allocation.mbomProcess?.mbomDetail?.part || null;
      const eventDate = isoDate(allocation.scheduleDate);
      if (!eventDate) continue;
      const processCode = process.processCode || (allocation.routingMode === "VENDOR" ? "VENDOR" : "PROCESS");
      const key = [eventDate, processCode, allocation.routingMode, processPart?.partCode || ""].join("|");
      if (!eventByKey.has(key)) {
        eventByKey.set(key, {
          type: "PROCESS",
          date: eventDate,
          completionDate: isoDate(allocation.vendorReturnDate) || eventDate,
          processCode,
          processName: process.processName || processCode,
          sequence: allocation.mbomProcess?.sequence ?? 0,
          qty: 0,
          uomCode: allocation.uomCode || phase.uomCode || "PCS",
          routingMode: allocation.routingMode || "INHOUSE",
          part: processPart,
          machineCode: allocation.machine?.machineCode || null,
          machineName: allocation.machine?.machineName || null,
          vendorCode: allocation.vendor?.vendorCode || null,
          vendorName: allocation.vendor?.vendorName || null,
          vendorLeadTimeDays: allocation.vendorLeadTimeDays ?? null,
          startTime: allocation.plannedStartTime || null,
          endTime: allocation.plannedEndTime || null,
          status: allocation.status,
          planNumber: allocation.plan?.planNumber || null,
          executionMonth: isoDate(allocation.plan?.periodStart)?.slice(0, 7) || null,
          transferBatchCount: 0,
          allocations: [],
        });
      }
      const event = eventByKey.get(key);
      event.qty += number(allocation.plannedQty);
      event.transferBatchCount += 1;
      event.allocations.push({
        id: allocation.id,
        planNumber: allocation.plan?.planNumber || plan.planNumber,
        editable: allocation.status === "Draft",
        status: allocation.status,
        allocationSource: allocation.allocationSource,
        routingMode: allocation.routingMode || "INHOUSE",
        scheduleDate: eventDate,
        shift: allocation.shift || (allocation.routingMode === "VENDOR" ? "VENDOR" : "1"),
        plannedStartTime: allocation.plannedStartTime || null,
        plannedEndTime: allocation.plannedEndTime || null,
        plannedQty: number(allocation.plannedQty),
        expectedReturnQty: allocation.expectedReturnQty == null ? null : number(allocation.expectedReturnQty),
        uomCode: allocation.uomCode || phase.uomCode || "PCS",
        machineId: allocation.machineId || null,
        machineCode: allocation.machine?.machineCode || null,
        machineName: allocation.machine?.machineName || null,
        diesId: allocation.diesId || null,
        vendorId: allocation.vendorId || null,
        vendorCode: allocation.vendor?.vendorCode || null,
        vendorName: allocation.vendor?.vendorName || null,
        vendorSendDate: isoDate(allocation.vendorSendDate) || eventDate,
        vendorReturnDate: isoDate(allocation.vendorReturnDate),
        processCode,
        processName: process.processName || processCode,
        part: processPart,
      });
      if (isoDate(allocation.vendorReturnDate) && isoDate(allocation.vendorReturnDate) > event.completionDate) {
        event.completionDate = isoDate(allocation.vendorReturnDate);
      }
      if (allocation.routingMode === "VENDOR" && isoDate(allocation.vendorReturnDate)) {
        const returnDate = isoDate(allocation.vendorReturnDate);
        const returnKey = [returnDate, "VENDOR_RETURN", processCode, processPart?.partCode || "", allocation.vendor?.vendorCode || ""].join("|");
        if (!eventByKey.has(returnKey)) {
          eventByKey.set(returnKey, {
            type: "VENDOR_RETURN",
            date: returnDate,
            completionDate: returnDate,
            processCode: `RETURN ${processCode}`,
            processName: `${process.processName || processCode} selesai vendor`,
            sequence: (allocation.mbomProcess?.sequence ?? 0) + 0.5,
            qty: 0,
            uomCode: allocation.uomCode || phase.uomCode || "PCS",
            routingMode: "VENDOR_RETURN",
            part: processPart,
            vendorCode: allocation.vendor?.vendorCode || null,
            vendorName: allocation.vendor?.vendorName || null,
            vendorLeadTimeDays: allocation.vendorLeadTimeDays ?? null,
            status: allocation.status,
            planNumber: allocation.plan?.planNumber || null,
            executionMonth: isoDate(allocation.plan?.periodStart)?.slice(0, 7) || null,
            transferBatchCount: 0,
            allocations: [],
          });
        }
        const returnEvent = eventByKey.get(returnKey);
        returnEvent.qty += number(allocation.expectedReturnQty || allocation.plannedQty);
        returnEvent.transferBatchCount += 1;
      }
    }
    const firstAllocation = phaseAllocations[0] || null;
    const events = [...eventByKey.values()]
      .sort((left, right) => left.date.localeCompare(right.date) || number(left.sequence) - number(right.sequence));
    const phaseRequirementDate = isoDate(phase.fgRequiredDate || phase.plannedDate);
    const receipt = receiptLines.find((detail) => detail.partCode === phase.partCode
      && isoDate(detail.fgRequiredDate || detail.requiredDate) === phaseRequirementDate) || null;
    // The real production start is the earliest start across every routing line
    // feeding this FG requirement. Using only the FG receipt line makes a valid
    // long lead-time chain look artificially late/early in the UI.
    const recommendedStartDates = planningLines
      .filter((detail) => isoDate(detail.fgRequiredDate || detail.requiredDate) === phaseRequirementDate)
      .map((detail) => isoDate(detail.latestStartDate))
      .filter(Boolean)
      .sort();
    const phasePlanningLines = planningLines.filter((detail) =>
      isoDate(detail.fgRequiredDate || detail.requiredDate) === phaseRequirementDate);
    const phaseProcessLineCount = phasePlanningLines.filter(isGeneratedProcess).length;
    const firstProcessDate = events.length ? events[0].date : null;
    const recommendedStartDate = recommendedStartDates[0] || isoDate(receipt?.latestStartDate);
    const deliveryDate = isoDate(phase.plannedDate);
    const startVarianceDays = recommendedStartDate && firstProcessDate ? dayGap(firstProcessDate, recommendedStartDate) : null;
    const productionToDeliveryDays = firstProcessDate && deliveryDate ? dayGap(firstProcessDate, deliveryDate) : null;
    const scheduleHealth = !firstProcessDate
      ? "UNSCHEDULED"
      : deliveryJit
        ? "ON_TARGET"
      : startVarianceDays > 0
        ? "EARLY"
        : startVarianceDays < 0
          ? "LATE"
          : "ON_TARGET";
    const unscheduledReasonCode = firstProcessDate
      ? null
      : plan.replanRequired
        ? "MRP_REPLAN_REQUIRED"
        : phaseProcessLineCount === 0
          ? "PROCESS_DETAIL_MISSING"
          : "CAPACITY_ALLOCATION_MISSING";
    const unscheduledReason = unscheduledReasonCode === "MRP_REPLAN_REQUIRED"
      ? "MRP/MPP belum dihitung ulang setelah perubahan sumber atau stock."
      : unscheduledReasonCode === "PROCESS_DETAIL_MISSING"
        ? "MRP belum menghasilkan process detail untuk delivery phase ini."
        : unscheduledReasonCode === "CAPACITY_ALLOCATION_MISSING"
          ? "Process detail tersedia, tetapi belum mempunyai capacity allocation."
          : null;
    events.push({
      type: "DELIVERY",
      date: isoDate(phase.plannedDate),
      completionDate: isoDate(phase.plannedDate),
      processCode: "DELIVERY",
      processName: "Customer Delivery",
      sequence: 9999,
      qty: number(phase.qtyPlanned),
      uomCode: phase.uomCode || "PCS",
      routingMode: "CUSTOMER",
      part: parentPartByCode.get(phase.partCode) || { partCode: phase.partCode, partNumber: null, partName: null },
      status: phase.status,
    });
    return {
      id: phase.id,
      phaseNumber: phase.phaseNumber,
      sourceType: phase.sourceType || firstAllocation?.demandSourceType || null,
      sourceNumber: phase.sourceNumber || firstAllocation?.demandSourceNumber || null,
      customerCode: phase.targetCode || null,
      customerName: phase.targetName || null,
      fgRequiredDate: isoDate(phase.fgRequiredDate),
      deliveryDate,
      recommendedStartDate,
      firstProcessDate,
      startVarianceDays,
      productionToDeliveryDays,
      scheduleHealth,
      unscheduledReasonCode,
      unscheduledReason,
      processPlanLineCount: phaseProcessLineCount,
      executionPlanNumber: receipt?.planNumber || null,
      executionMonth: receipt?.executionMonth || null,
      ownerPlanNumber,
      planRole,
      crossPlanChain: new Set(allPhaseAllocations.map((row) => row.plan?.planNumber).filter(Boolean)).size > 1,
      qty: number(phase.qtyPlanned),
      uomCode: phase.uomCode || "PCS",
      fgParent: parentPartByCode.get(phase.partCode) || {
        partCode: phase.partCode,
        partNumber: null,
        partName: null,
      },
      events,
    };
  });
  const dates = [...new Set(timelinePhases.flatMap((phase) => phase.events.map((event) => event.date)).filter(Boolean))].sort();
  return {
    scope: "DEMAND_PHASE_HORIZON",
    planNumber: plan.planNumber,
    schedulePolicy: deliveryJit ? "DELIVERY_JIT" : "EARLIEST",
    jitSafetyDays: deliveryJit ? number(activeDeliveryRule.jitSafetyDays) : null,
    sourceMpsNumber: mpsNumber,
    editable: ["Draft", "Confirmed"].includes(String(plan.status || "")),
    ownershipRule: "DEMAND_PHASE_HORIZON",
    ownedPhaseCount: timelinePhases.filter((phase) => phase.planRole === "OWNER").length,
    carryOverPhaseCount: timelinePhases.filter((phase) => phase.planRole === "CARRY_OVER").length,
    dates,
    phases: timelinePhases,
  };
}

async function withManufacturingOrderTrace(plan) {
  if (!plan?.planNumber) return plan;
  const manufacturingOrders = await prisma.manufacturingOrder.findMany({
    where: {
      monthlyProductionPlanNumber: plan.planNumber,
      isDeleted: false,
    },
    select: {
      id: true,
      moNumber: true,
      monthlyProductionPlanLineNumber: true,
      qtyPlanned: true,
      qtyProduced: true,
      qtyGood: true,
      status: true,
      plannedStartDate: true,
      plannedEndDate: true,
      createdAt: true,
    },
    orderBy: [{ monthlyProductionPlanLineNumber: "asc" }, { createdAt: "asc" }],
  });
  const moIds = manufacturingOrders.map((mo) => mo.id).filter(Boolean);
  const moNumbers = manufacturingOrders.map((mo) => mo.moNumber).filter(Boolean);
  const dailyPlans = manufacturingOrders.length && (moIds.length || moNumbers.length) ? await prisma.dailyProductionSchedule.findMany({
    where: {
      isDeleted: false,
      OR: [
        ...(moIds.length ? [{ moId: { in: moIds } }] : []),
        ...(moNumbers.length ? [{ moNumber: { in: moNumbers } }] : []),
      ],
    },
    select: { scheduleNumber: true, scheduleDate: true, shift: true, moId: true, moNumber: true, woId: true, woNumber: true, partCode: true, processId: true, machineId: true, plannedQty: true, actualQty: true, status: true },
    orderBy: [{ scheduleDate: "asc" }, { shift: "asc" }],
  }) : [];
  const dailyByMo = new Map();
  for (const row of dailyPlans) {
    const key = row.moId || row.moNumber;
    if (!dailyByMo.has(key)) dailyByMo.set(key, []);
    dailyByMo.get(key).push(row);
  }
  const byLine = new Map();
  for (const mo of manufacturingOrders) {
    const key = Number(mo.monthlyProductionPlanLineNumber);
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(mo);
  }
  return {
    ...plan,
    manufacturingOrders,
    dailyProductionPlans: dailyPlans,
    details: plan.details.map((detail) => ({
      ...detail,
      manufacturingOrders: (byLine.get(Number(detail.lineNumber)) || []).map((mo) => ({ ...mo, dailyProductionPlans: dailyByMo.get(mo.moNumber) || dailyByMo.get(mo.id) || [] })),
    })),
  };
}

function displayReference(type, value, href, label = null) {
  if (!value) return null;
  return {
    type,
    value,
    label: label || String(value),
    href,
  };
}

async function withPlanDisplayReferences(plan) {
  const details = Array.isArray(plan?.details) ? plan.details : [];
  const partIds = [...new Set(details.map((row) => row.partId).filter(Boolean))];
  const partCodes = [...new Set(details.map((row) => row.partCode).filter(Boolean))];
  const sourceMpsNumber = String(plan?.sourceType || "").startsWith("MPS:")
    ? String(plan.sourceType).slice(4)
    : null;
  const snapshotMrpRunNumbers = sourceMrpRunNumbers(plan);
  const [parts, bomHeaders, processBoms, sourceMps, currentSourceMrp, stockBalances] = await Promise.all([
    partIds.length || partCodes.length
      ? prisma.part.findMany({
        where: {
          isDeleted: false,
          OR: [
            ...(partIds.length ? [{ id: { in: partIds } }] : []),
            ...(partCodes.length ? [{ partCode: { in: partCodes } }] : []),
          ],
        },
        select: {
          id: true,
          partCode: true,
          partNumber: true,
          partName: true,
          itemType: true,
          partType: true,
        },
      })
      : [],
    partIds.length
      ? prisma.mBOMHeader.findMany({
        where: { partId: { in: partIds }, isDeleted: false },
        orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
        select: { noReg: true, partId: true, revision: true },
      })
      : [],
    partIds.length
      ? prisma.mBOMProcess.findMany({
        where: {
          isDeleted: false,
          mbomDetail: { partId: { in: partIds } },
        },
        orderBy: [{ noReg: "desc" }, { sequence: "asc" }],
        select: {
          noReg: true,
          mbomDetail: { select: { partId: true } },
        },
      })
      : [],
    sourceMpsNumber
      ? prisma.mPS.findFirst({
        where: { mpsNumber: sourceMpsNumber, isDeleted: false },
        select: { mpsNumber: true, mpsName: true, forecastNumber: true },
      })
      : null,
    sourceMpsNumber
      ? prisma.mRPRun.findFirst({
        where: {
          mpsNumber: sourceMpsNumber,
          isDeleted: false,
          isCurrentPlan: true,
          status: "Completed",
        },
        orderBy: { createdAt: "desc" },
        select: { runNumber: true, runDate: true, status: true },
      })
      : null,
    partCodes.length
      ? prisma.stockBalance.findMany({
        where: { partCode: { in: partCodes }, isDeleted: false },
        select: { partCode: true, qtyOnHand: true, qtyReserved: true, qtyQC: true, qtyAvailable: true },
      })
      : [],
  ]);
  const partById = new Map(parts.map((part) => [part.id, part]));
  const partByCode = new Map(parts.map((part) => [part.partCode, part]));
  const stockByPartCode = new Map();
  for (const balance of stockBalances) {
    if (!balance.partCode) continue;
    const current = stockByPartCode.get(balance.partCode) || {
      qtyOnHand: 0,
      qtyReserved: 0,
      qtyQC: 0,
      qtyAvailable: 0,
    };
    current.qtyOnHand += number(balance.qtyOnHand);
    current.qtyReserved += number(balance.qtyReserved);
    current.qtyQC += number(balance.qtyQC);
    current.qtyAvailable += number(balance.qtyAvailable);
    stockByPartCode.set(balance.partCode, current);
  }
  const bomByPartId = new Map();
  for (const header of bomHeaders) {
    if (!bomByPartId.has(header.partId)) bomByPartId.set(header.partId, header);
  }
  for (const route of processBoms) {
    const partId = route.mbomDetail?.partId;
    if (partId && !bomByPartId.has(partId)) {
      bomByPartId.set(partId, { noReg: route.noReg, partId });
    }
  }
  const documentReferences = [
    displayReference(
      "FORECAST",
      sourceMps?.forecastNumber,
      sourceMps?.forecastNumber
        ? `/modules/sales/forecasts/${encodeURIComponent(sourceMps.forecastNumber)}`
        : null,
      sourceMps?.forecastNumber ? `Forecast ${sourceMps.forecastNumber}` : null,
    ),
    displayReference(
      "MPS",
      sourceMps?.mpsNumber || sourceMpsNumber,
      sourceMpsNumber
        ? `/modules/planning-ppic/mps/${encodeURIComponent(sourceMpsNumber)}`
        : null,
      sourceMpsNumber ? `Master Production Schedule ${sourceMpsNumber}` : null,
    ),
    ...snapshotMrpRunNumbers.map((runNumber) => displayReference(
      "MRP SNAPSHOT",
      runNumber,
      `/modules/planning-ppic/mrp/${encodeURIComponent(runNumber)}`,
      `Snapshot MRP ${runNumber}`,
    )),
    ...(currentSourceMrp?.runNumber && !snapshotMrpRunNumbers.includes(currentSourceMrp.runNumber)
      ? [displayReference(
        "MRP CURRENT",
        currentSourceMrp.runNumber,
        `/modules/planning-ppic/mrp/${encodeURIComponent(currentSourceMrp.runNumber)}`,
        `Current MRP ${currentSourceMrp.runNumber}`,
      )]
      : []),
  ].filter(Boolean);
  return {
    ...plan,
    sourceMpsNumber,
    sourceMrpNumber: snapshotMrpRunNumbers.length === 1 ? snapshotMrpRunNumbers[0] : null,
    sourceMrpNumbers: snapshotMrpRunNumbers,
    currentSourceMrpNumber: currentSourceMrp?.runNumber || null,
    sourceSnapshotStatus: snapshotMrpRunNumbers.length === 1 && snapshotMrpRunNumbers[0] === currentSourceMrp?.runNumber
      ? "CURRENT"
      : snapshotMrpRunNumbers.length > 1
        ? "MIXED"
        : "STALE",
    sourceForecastNumber: sourceMps?.forecastNumber || null,
    documentReferences,
    details: details.map((detail) => {
      const part = partById.get(detail.partId) || partByCode.get(detail.partCode) || null;
      const bom = part?.id ? bomByPartId.get(part.id) : null;
      const lineType = !isGeneratedProcess(detail)
        ? "FG Receipt"
        : String(part?.itemType || "").toUpperCase() === "FG"
          ? "Child FG Receipt"
          : "Production Process";
      const referenceLinks = [
        displayReference(
          "PART",
          part?.partCode || detail.partCode,
          `/master-data/parts/${encodeURIComponent(part?.partCode || detail.partCode)}/edit?key=${encodeURIComponent(part?.partCode || detail.partCode)}`,
          [part?.partCode || detail.partCode, part?.partName].filter(Boolean).join(" · "),
        ),
        displayReference(
          "BOM",
          bom?.noReg,
          bom?.noReg
            ? `/modules/manufacturing-bom/bill-of-materials/${encodeURIComponent(bom.noReg)}/edit`
            : null,
          bom?.noReg ? `Bill of Material ${bom.noReg}` : null,
        ),
        displayReference(
          "PLANNED_ORDER",
          detail.plannedOrderNumber,
          detail.plannedOrderNumber
            ? `/modules/planning-ppic/planned-orders/${encodeURIComponent(detail.plannedOrderNumber)}`
            : null,
          detail.plannedOrderNumber ? `Planned Order ${detail.plannedOrderNumber}` : null,
        ),
        ...(detail.manufacturingOrders || []).map((mo) => displayReference(
          "MO",
          mo.moNumber,
          `/modules/production/manufacturing-orders/${encodeURIComponent(mo.moNumber)}`,
          `Manufacturing Order ${mo.moNumber}`,
        )),
      ].filter(Boolean);
      return {
        ...detail,
        part,
        stock: stockByPartCode.get(part?.partCode || detail.partCode) || {
          qtyOnHand: 0,
          qtyReserved: 0,
          qtyQC: 0,
          qtyAvailable: 0,
        },
        bomNumber: bom?.noReg || null,
        lineType,
        displayName: part?.partName || part?.partNumber || detail.partCode,
        referenceLinks,
      };
    }),
  };
}

function planIssueReferences(issue, plan, sourceMrpNumber) {
  return [
    displayReference(
      "BOM",
      issue.bomNumber,
      issue.bomNumber
        ? `/modules/manufacturing-bom/bill-of-materials/${encodeURIComponent(issue.bomNumber)}/edit`
        : null,
      issue.bomNumber ? `Perbaiki BOM ${issue.bomNumber}` : null,
    ),
    displayReference(
      "PART",
      issue.partCode,
      issue.partCode
        ? `/master-data/parts/${encodeURIComponent(issue.partCode)}/edit?key=${encodeURIComponent(issue.partCode)}`
        : null,
      issue.partCode
        ? [issue.partCode, issue.partName].filter(Boolean).join(" · ")
        : null,
    ),
    displayReference(
      "PLANNED_ORDER",
      issue.orderNumber,
      issue.orderNumber
        ? `/modules/planning-ppic/planned-orders/${encodeURIComponent(issue.orderNumber)}`
        : null,
      issue.orderNumber ? `Planned Order ${issue.orderNumber}` : null,
    ),
    displayReference(
      "MRP",
      sourceMrpNumber,
      sourceMrpNumber
        ? `/modules/planning-ppic/mrp/${encodeURIComponent(sourceMrpNumber)}`
        : null,
      sourceMrpNumber ? `MRP ${sourceMrpNumber}` : null,
    ),
    displayReference(
      "CAPACITY",
      ["CAPACITY", "DELIVERY", "RECOMMENDATION"].includes(issue.source) ? plan.planNumber : null,
      ["CAPACITY", "DELIVERY", "RECOMMENDATION"].includes(issue.source)
        ? `/modules/planning-ppic/capacity-planning?planNumber=${encodeURIComponent(plan.planNumber)}`
        : null,
      ["CAPACITY", "DELIVERY", "RECOMMENDATION"].includes(issue.source) ? "Buka Capacity Planning" : null,
    ),
  ].filter(Boolean);
}

function buildPlanReadiness(plan, capacity, materialReadiness, officialAllocations = []) {
  const materialPartNames = new Map(
    (materialReadiness?.items || []).map((item) => [item.partCode, item.partName]),
  );
  const capacityIssues = (capacity?.readiness?.issues || [])
    .filter((issue) => ["blocking", "warning", "overridable"].includes(String(issue.severity || "").toLowerCase()))
    .filter((issue) => issue.planNumber === plan.planNumber || String(issue.code || "").startsWith("PLAN_"))
    .map((issue) => ({ ...issue, source: "CAPACITY" }));
  const materialIssues = (materialReadiness?.issues || []).map((issue) => ({
    ...issue,
    severity: "warning",
    partName: issue.partName || materialPartNames.get(issue.partCode) || null,
    source: "MATERIAL",
  }));
  const recommendationBlockers = visibleStoredRecommendationBlockers(plan, capacity).map((blocker) => ({
    ...blocker,
    severity: "blocking",
    source: "RECOMMENDATION",
    title: [
      blocker.phaseNumber ? `Phase ${blocker.phaseNumber}` : null,
      blocker.partCode,
      blocker.processCode,
    ].filter(Boolean).join(" Â· "),
    message: [
      `Rekomendasi kapasitas tidak dapat menempatkan ${number(blocker.qty)} pcs`,
      blocker.processCode ? `pada proses ${blocker.processCode}` : null,
      blocker.dueDate ? `sebelum due date ${blocker.dueDate}` : null,
      blocker.machineSpecificationCode ? `(spesifikasi mesin ${blocker.machineSpecificationCode})` : null,
    ].filter(Boolean).join(" ") + ".",
  }));
  const deliveryIssues = (capacity?.deliveryCoverage?.phases || [])
    .filter((phase) => String(phase.status || "").toUpperCase() !== "COVERED")
    .map((phase) => {
      const status = String(phase.status || "BLOCKED").toUpperCase();
      const code = status === "MISSING"
        ? "DELIVERY_PHASE_REQUIRED"
        : status === "INCOMPLETE"
          ? "DELIVERY_PHASE_QTY_SHORT"
          : "DELIVERY_PHASE_NOT_COVERED";
      const phaseLabel = phase.phaseNumber ? `Phase ${phase.phaseNumber}` : "Delivery phase";
      return {
        ...phase,
        code,
        severity: "blocking",
        source: "DELIVERY",
        dueDate: phase.plannedDate,
        title: `${phaseLabel} Â· ${phase.partCode || plan.planNumber}`,
        message: `${phaseLabel} ${phase.partCode || ""} membutuhkan kumulatif ${number(phase.cumulativeRequiredQty)} ${phase.uomCode || "pcs"} sampai ${phase.plannedDate || "due date"}, tetapi allocation yang selesai tepat waktu baru ${number(phase.plannedQtyByDueDate)}. Shortage ${number(phase.shortageQty)} ${phase.uomCode || "pcs"}.`,
      };
    });
  const sourceReconciliation = plan.sourceReconciliation || null;
  const sourceIssues = sourceReconciliation?.current === false ? [{
    code: "MPP_SOURCE_REPLAN_REQUIRED",
    severity: "blocking",
    source: "DATA INTEGRITY",
    title: "Snapshot MRP tidak sama dengan current plan",
    message: [
      `MPP memakai ${sourceReconciliation.storedMrpRunNumbers?.join(", ") || "snapshot yang tidak diketahui"}`,
      `sedangkan current MRP adalah ${sourceReconciliation.currentMrpRunNumber || "belum tersedia"}.`,
      `FG MPP ${number(sourceReconciliation.actualFgQty)} pcs vs current ${number(sourceReconciliation.expectedFgQty)} pcs;`,
      `${number(sourceReconciliation.actualReceiptCount)} receipt vs ${number(sourceReconciliation.expectedReceiptCount)} receipt.`,
      "Sinkronkan ulang MPP sebelum Confirm/Release.",
    ].join(" "),
  }] : [];
  const timing = scheduleTimingSnapshot(plan, officialAllocations);
  const timingIssues = timing.late ? [{
    code: "MPP_ESTIMATED_START_LATE",
    severity: "blocking",
    source: "SCHEDULE HEALTH",
    title: "Estimated production start sudah lewat",
    dueDate: timing.estimatedStart?.toISOString().slice(0, 10),
    message: `Start paling awal ${timing.estimatedStart.toISOString().slice(0, 10)} sudah lewat ${timing.daysLate} hari dan Production Plan masih ${plan.status}. Rerun tidak menghapus lead time fisik; pilih recovery capacity/vendor, split delivery, atau revisi target customer sebelum Confirm/Release.`,
  }] : [];
  const normalizedIssues = [
    ...sourceIssues,
    ...timingIssues,
    ...recommendationBlockers,
    ...deliveryIssues,
    ...capacityIssues,
    ...materialIssues,
  ].map((issue) => {
    const severity = String(issue.severity || "WARNING").toUpperCase();
    return {
      ...issue,
      severity,
      title: issue.title || [
        issue.partCode,
        issue.partName,
        issue.processName || issue.processCode,
        issue.machineName || issue.machineCode,
      ].filter(Boolean).join(" · ") || issue.code,
      references: planIssueReferences(issue, plan, materialReadiness?.mrpRunNumber),
    };
  });
  const issues = normalizedIssues.filter((issue, index, rows) => {
    const key = [
      issue.source,
      issue.code,
      issue.phaseId || issue.phaseNumber,
      issue.partCode,
      issue.processCode,
      issue.dueDate || issue.plannedDate,
      issue.message,
    ].map((value) => String(value ?? "")).join("|");
    return rows.findIndex((candidate) => [
      candidate.source,
      candidate.code,
      candidate.phaseId || candidate.phaseNumber,
      candidate.partCode,
      candidate.processCode,
      candidate.dueDate || candidate.plannedDate,
      candidate.message,
    ].map((value) => String(value ?? "")).join("|") === key) === index;
  });
  const blockingCount = issues.filter((issue) => issue.severity === "BLOCKING").length;
  const warningCount = issues.filter((issue) => issue.severity === "WARNING").length;
  const overridableCount = issues.filter((issue) => issue.severity === "OVERRIDABLE").length;
  const capacityOverrideRequired = overridableCount > 0 && plan.capacityOverrideApproved !== true;
  return {
    ready: blockingCount === 0 && !capacityOverrideRequired,
    releaseReady: blockingCount === 0 && !capacityOverrideRequired,
    capacityOverrideRequired,
    summary: {
      blocking: blockingCount,
      warning: warningCount,
      overridable: overridableCount,
      receiptOnlyFg: Number(capacity?.summary?.fgReceiptLineCount || 0),
      unscheduled: Number(capacity?.summary?.unscheduledCount || 0),
      recommendationBlockers: recommendationBlockers.length,
      deliveryBlockers: deliveryIssues.length,
      capacityBlockers: capacityIssues.filter((issue) => String(issue.severity || "").toLowerCase() === "blocking").length,
      materialBlockers: materialIssues.filter((issue) => String(issue.severity || "").toLowerCase() === "blocking").length,
      dataIntegrityBlockers: sourceIssues.length,
      timingBlockers: timingIssues.length,
    },
    issues,
    sourceReconciliation,
    scheduleTiming: timing,
  };
}

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(number(req.query.page) || 1, 1); const limit = Math.min(Math.max(number(req.query.limit) || 20, 1), 500); const q = String(req.query.q || req.query.search || "").trim();
    const calendarMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || "")) ? String(req.query.month) : null;
    const filterStart = calendarMonth ? monthStart(`${calendarMonth}-01`) : null;
    const filterEndExclusive = filterStart ? new Date(Date.UTC(filterStart.getUTCFullYear(), filterStart.getUTCMonth() + 1, 1)) : null;
    const where = {
      isDeleted: false,
      ...(req.query.status ? { status: String(req.query.status) } : {}),
      ...(filterStart ? { periodStart: { lt: filterEndExclusive }, periodEnd: { gte: filterStart } } : {}),
      ...(q ? { OR: [{ planNumber: { contains: q, mode: "insensitive" } }, { status: { contains: q, mode: "insensitive" } }] } : {}),
    };
    const [items, total] = await Promise.all([prisma.monthlyProductionPlan.findMany({ where, include, orderBy: { periodStart: "desc" }, skip: (page - 1) * limit, take: limit }), prisma.monthlyProductionPlan.count({ where })]);
    res.json({ items: items.map(serialize), total, page, limit });
  } catch (error) { next(error); }
};

exports.matrix = async (req, res, next) => {
  try {
    const requestedMonth = String(req.params?.month || req.query?.month || "");
    const calendarMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth)
      ? requestedMonth
      : monthKey(new Date());
    const startDate = monthStart(`${calendarMonth}-01`);
    const endDate = monthEnd(startDate);
    const requestedPlanNumber = text(req.query?.planNumber);
    const [snapshot, workCenters, mpsWorkbench] = await Promise.all([
      buildCapacitySnapshot(prisma, { startDate, endDate, planningMode: "PRODUCTION", ...(requestedPlanNumber ? { planNumber: requestedPlanNumber } : {}) }),
      prisma.workCenter.findMany({
        where: { isActive: true },
        orderBy: [{ lineCode: "asc" }, { workCenterCode: "asc" }],
        include: {
          machines: {
            include: {
              machine: {
                select: {
                  id: true,
                  machineCode: true,
                  machineName: true,
                  machineFamily: true,
                  machineSpecificationCode: true,
                  machineSpecificationName: true,
                  lineCode: true,
                  workingHourProfileId: true,
                },
              },
            },
          },
        },
      }),
      getMpsWorkbench(prisma, { month: calendarMonth, page: 1, pageSize: 100 }),
    ]);
    const sourcePlanNumbers = [...new Set([
      ...(requestedPlanNumber ? [requestedPlanNumber] : []),
      ...(snapshot.machines || []).flatMap((machine) => Object.values(machine.cells || {}).flatMap((cell) => (cell.items || []).map((item) => item.planNumber || item.reference))),
      ...(snapshot.vendorAssignments || []).map((item) => item.planNumber || item.reference),
      ...(snapshot.unscheduled || []).map((item) => item.planNumber || item.reference),
    ].filter(Boolean))];
    const sourcePlans = sourcePlanNumbers.length ? await prisma.monthlyProductionPlan.findMany({
      where: { isDeleted: false, planNumber: { in: sourcePlanNumbers } },
      select: {
        id: true,
        planNumber: true,
        status: true,
        updatedAt: true,
        recommendationSummary: true,
        details: {
          where: { isDeleted: false, status: { not: "Cancelled" } },
          select: {
            partCode: true,
            qtyPlanned: true,
            uomCode: true,
            requiredDate: true,
            deliveryPhaseId: true,
            customerTargetDate: true,
            fgRequiredDate: true,
            notes: true,
          },
        },
      },
    }) : [];
    const fgRequirements = sourcePlans.flatMap((plan) => plan.details
      .filter((detail) => !isGeneratedProcess(detail))
      .map((detail) => ({
        planNumber: plan.planNumber,
        deliveryPhaseId: detail.deliveryPhaseId || null,
        partCode: detail.partCode,
        qty: detail.qtyPlanned,
        uomCode: detail.uomCode || "PCS",
        fgRequiredDate: detail.fgRequiredDate || detail.customerTargetDate || detail.requiredDate,
      })));
    const partCodes = [...new Set([
      ...(snapshot.machines || []).flatMap((machine) => Object.values(machine.cells || {}).flatMap((cell) => (cell.items || []).map((item) => item.partCode))),
      ...(snapshot.vendorAssignments || []).map((item) => item.partCode),
      ...(snapshot.unscheduled || []).map((item) => item.partCode),
      ...fgRequirements.map((item) => item.partCode),
    ].filter(Boolean))];
    const partCatalog = partCodes.length ? await prisma.part.findMany({
      where: { isDeleted: false, partCode: { in: partCodes } },
      select: { partCode: true, partName: true, partNumber: true, itemType: true, partType: true },
    }) : [];
    const matrix = buildMonthlyProductionMatrix(snapshot, workCenters, partCatalog, fgRequirements, mpsWorkbench.items || []);
    const recommendationBlockers = sourcePlans.flatMap((plan) => Array.isArray(plan.recommendationSummary?.blockers)
      ? plan.recommendationSummary.blockers
      : []);
    matrix.summary.materialHoldCount = recommendationBlockers.filter((blocker) => String(blocker?.code || "").toUpperCase().includes("MATERIAL")).length;
    matrix.summary.recommendationCapacityBlockerCount = recommendationBlockers.filter((blocker) => /CAPACITY|MACHINE|DIES/.test(String(blocker?.code || "").toUpperCase())).length;
    const planIds = sourcePlans.map((plan) => plan.id);
    const queue = planIds.length ? await prisma.capacityQueueItem.findMany({
      where: { planId: { in: planIds }, status: "OPEN" },
      orderBy: [{ latestFinishDate: "asc" }, { createdAt: "asc" }],
      select: { id: true, planId: true, sourceAllocationId: true, partCode: true, processCode: true, qty: true, uomCode: true, earliestStartDate: true, latestFinishDate: true, fgRequiredDate: true, suggestions: true, reason: true },
    }) : [];
    res.json({
      month: calendarMonth,
      monthStart: dateOnly(startDate),
      monthEnd: dateOnly(endDate),
      ...matrix,
      editor: {
        defaultScope: "PLAN",
        globalScopeRequiresApproval: true,
        remainingAllocations: matrix.remainingAllocations || [],
        machines: (snapshot.machines || []).map((machine) => ({ id: machine.id, machineCode: machine.machineCode, machineName: machine.machineName, status: machine.status, machineSpecificationCode: machine.machineSpecificationCode })),
        vendors: snapshot.catalogs?.vendors || [],
        dies: snapshot.catalogs?.dies || [],
        plans: sourcePlans.map((plan) => ({ id: plan.id, planNumber: plan.planNumber, status: plan.status, version: plan.updatedAt.toISOString(), editable: ["Draft", "Confirmed", "Released", "In Progress"].includes(plan.status), requiresReplan: ["Released", "In Progress"].includes(plan.status) })),
        queue,
        permissions: { edit: true, forceMove: true, globalCalendar: Boolean(req.user?.isSuperAdmin) },
      },
      capacity: {
        availableMinutes: number(snapshot.summary?.totalAvailableMinutes),
        loadMinutes: number(snapshot.summary?.totalLoadMinutes),
        utilizationPercent: number(snapshot.summary?.utilizationPercent),
        overloadedCells: number(snapshot.summary?.overloadedCells),
        unscheduledCount: number(snapshot.summary?.unscheduledCount),
      },
    });
  } catch (error) { next(error); }
};

exports.listDailyPlans = (req, res, next) => {
  req.query = { ...(req.query || {}), sourceModule: "PPIC" };
  return dailyProductionScheduleController.list(req, res, next);
};

exports.getDailyPlan = (req, res, next) => {
  req.query = { ...(req.query || {}), sourceModule: "PPIC" };
  req.params.scheduleNumber = req.params.scheduleNumber || req.params.planNumber;
  return dailyProductionScheduleController.get(req, res, next);
};

exports.get = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber: req.params.planNumber, isDeleted: false }, include });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan" });
    const [snapshot, materialReadiness, capacity, sourceReconciliation, deliveryPhaseTimeline, officialAllocations] = await Promise.all([
      withMpsSnapshot(plan),
      buildMaterialReadinessSnapshot(prisma, plan),
      buildCapacitySnapshot(prisma, {
        planNumber: plan.planNumber,
        startDate: plan.periodStart,
        endDate: capacityHorizonEnd(plan),
      }),
      buildSourceReconciliation(plan),
      buildDeliveryPhaseTimeline(plan),
      loadOfficialAllocations(plan.id),
    ]);
    const traced = await withManufacturingOrderTrace({ ...snapshot, sourceReconciliation });
    const displayPlan = await withPlanDisplayReferences(traced);
    const timing = scheduleTimingSnapshot(displayPlan, officialAllocations);
    const derivedReplanRequired = displayPlan.replanRequired || sourceReconciliation.current === false || timing.late;
    const derivedReplanReason = displayPlan.replanReason
      || (sourceReconciliation.current === false ? "Snapshot MRP/phase/qty Production Plan tidak sama dengan current plan." : null)
      || (timing.late ? `Estimated production start sudah lewat ${timing.daysLate} hari.` : null);
    res.json({
      ...serialize(displayPlan),
      replanRequired: derivedReplanRequired,
      replanReason: derivedReplanReason,
      sourceReconciliation,
      materialReadiness,
      capacityReadiness: capacity.readiness,
      capacitySummary: capacity.summary,
      capacityUnscheduled: capacity.unscheduled,
      capacityManualAllocationCatalog: capacity.manualAllocationCatalog,
      capacityVendorAssignments: capacity.vendorAssignments,
      monthlyPlanningPolicy: {
        ownerMonth: monthKey(displayPlan.planMonth || displayPlan.periodStart),
        overloadHandling: "QUEUE_IN_OWNER_MONTH",
        automaticMonthOffset: false,
        vendorReturnMayCrossMonth: true,
      },
      deliveryCoverage: capacity.deliveryCoverage,
      deliveryPhaseTimeline,
      planReadiness: buildPlanReadiness(displayPlan, capacity, materialReadiness, officialAllocations),
    });
  } catch (error) { next(error); }
};

exports.materialReadiness = async (req, res, next) => {
  try {
    res.json(await buildMaterialReadinessSnapshot(prisma, req.params.planNumber));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
};

exports.previewFromMps = async (req, res, next) => {
  try {
    const mpsNumber = text(req.query?.mpsNumber || req.body?.mpsNumber);
    if (!mpsNumber) return res.status(400).json({ message: "MPS wajib dipilih." });
    const productionPercent = req.query?.productionPercent == null ? 100 : Number(req.query.productionPercent);
    if (!Number.isFinite(productionPercent) || productionPercent < 0 || productionPercent > 100) return res.status(400).json({ message: "Persentase Production Plan harus antara 0 sampai 100." });
    const mps = await prisma.mPS.findFirst({
      where: { mpsNumber, isDeleted: false },
      include: { details: { where: { isDeleted: false, status: { not: "Cancelled" } }, include: { part: true, mbom: true }, orderBy: [{ startDate: "asc" }, { lineNumber: "asc" }] } },
    });
    if (!mps) return res.status(404).json({ message: "MPS tidak ditemukan." });
    if (mps.status !== "Confirmed") return res.status(409).json({ message: "MPS harus Confirmed (Demand Frozen) sebelum preview Production Plan." });
    const completedMrp = await currentCompletedMrpForMps(mps);
    if (!completedMrp) return res.status(409).json({ message: "Current MRP harus Completed sebelum preview Production Plan." });
    const netProductionByMpsDetail = await netProductionByMpsDetailForRun(completedMrp.runNumber);
    const validDetails = await splitPlanDetailsByMrpExecutionMonth(
      completedMrp.runNumber,
      derivePlanDetails(mps.details, productionPercent, netProductionByMpsDetail),
    );
    if (!validDetails.length) return res.status(400).json({ message: "MPS belum mempunyai FG receipt atau child/SFG process." });
    const { grouped, horizon } = groupDetailsIntoProductionHorizon(validDetails, mps.planningAnchorMonth || mps.periodStart);
    const ownerWindow = productionPlanOwnerWindow(horizon);
    const sourceType = `MPS:${mps.mpsNumber}`;
    const existingPlans = await prisma.monthlyProductionPlan.findMany({
      where: { sourceType, isDeleted: false, status: { notIn: ["Cancelled", "Closed"] } },
      select: { planNumber: true, planMonth: true, periodStart: true, status: true },
      orderBy: { planMonth: "asc" },
    });
    const today = jakartaTodayDate();
    const items = [...grouped.entries()].map(([executionMonth, details]) => {
      const receiptRows = details.filter((row) => !isGeneratedProcess(row));
      const processRows = details.filter(isGeneratedProcess);
      const starts = details.map((row) => row.startDate).filter(Boolean).map((value) => new Date(value));
      const requiredDates = receiptRows.map((row) => row.fgRequiredDate || row.endDate).filter(Boolean).map((value) => new Date(value));
      const estimatedStart = starts.length ? new Date(Math.min(...starts.map((value) => value.getTime()))) : null;
      const requiredStart = requiredDates.length ? new Date(Math.min(...requiredDates.map((value) => value.getTime()))) : null;
      const requiredEnd = requiredDates.length ? new Date(Math.max(...requiredDates.map((value) => value.getTime()))) : null;
      const existing = existingPlans.find((row) => monthKey(row.planMonth || row.periodStart) === executionMonth)
        || existingPlans.find((row) => row.status === "Draft")
        || existingPlans[0]
        || null;
      return {
        executionMonth,
        horizonStart: ownerWindow.startDate,
        horizonEnd: ownerWindow.endDate,
        mrpLookbackStart: horizon.horizonStart,
        crossMonth: horizon.crossMonth,
        ownershipRule: "DEMAND_PHASE_HORIZON",
        planNumber: existing?.planNumber || null,
        planStatus: existing?.status || "NEW DRAFT",
        action: existing ? (existing.status === "Draft" ? (existingPlans.filter((row) => row.status === "Draft").length > 1 ? "CONSOLIDATE_DRAFTS" : "SYNC_DRAFT") : "KEEP_EXISTING") : "CREATE_DRAFT",
        receiptCount: receiptRows.length,
        processCount: processRows.length,
        fgPlannedQty: receiptRows.reduce((sum, row) => sum + number(row.qtyPlanned), 0),
        estimatedStart: estimatedStart && estimatedStart > ownerWindow.startDate ? estimatedStart : ownerWindow.startDate,
        requiredStart,
        requiredEnd,
        scheduleRisk: estimatedStart && estimatedStart < today ? "START_PASSED" : "ON_TIME",
      };
    }).sort((left, right) => left.executionMonth.localeCompare(right.executionMonth));
    res.json({
      sourceMpsNumber: mps.mpsNumber,
      mpsStatus: mps.status,
      demandFreezeLabel: "Confirmed · Demand Frozen",
      mrpRunNumber: completedMrp.runNumber,
      mrpRevision: completedMrp.planRevision,
      planningMonth: completedMrp.planningMonth,
      productionPercent,
      planningIdentity: { ownershipRule: "OWNER_MONTH_EXECUTION", monthRole: "EXECUTION_BOUNDARY", horizonStart: ownerWindow.startDate, horizonEnd: ownerWindow.endDate, mrpLookbackStart: horizon.horizonStart, crossMonth: horizon.crossMonth },
      items,
      total: items.length,
    });
  } catch (error) { next(error); }
};

exports.createFromMps = async (req, res, next) => {
  try {
    const mpsNumber = text(req.body?.mpsNumber);
    if (!mpsNumber) return res.status(400).json({ message: "MPS wajib dipilih." });
    const productionPercent = req.body?.productionPercent == null ? 100 : Number(req.body.productionPercent);
    if (!Number.isFinite(productionPercent) || productionPercent < 0 || productionPercent > 100) return res.status(400).json({ message: "Persentase Production Plan harus antara 0 sampai 100." });
    const mps = await prisma.mPS.findFirst({
      where: { mpsNumber, isDeleted: false },
      include: { details: { where: { isDeleted: false, status: { not: "Cancelled" } }, include: { part: true }, orderBy: [{ startDate: "asc" }, { lineNumber: "asc" }] } },
    });
    if (!mps) return res.status(404).json({ message: "MPS tidak ditemukan." });
    if (mps.status !== "Confirmed") return res.status(409).json({ message: "MPS harus Confirmed sebelum dibuat menjadi Production Plan." });
    // A rolling MRP has one monthly header (the anchor MPS), while its
    // scenarioAssumptions.sourceMpsNumbers records every delivery month in the
    // cycle. Looking up only mRPRun.mpsNumber incorrectly blocks MPP creation
    // for month 2/3 even though the authoritative completed run covered it.
    const anchorMonth = mps.planningAnchorMonth || mps.periodStart;
    const anchorMonthEnd = new Date(anchorMonth);
    anchorMonthEnd.setUTCMonth(anchorMonthEnd.getUTCMonth() + 1, 1);
    anchorMonthEnd.setUTCHours(0, 0, 0, 0);
    const completedMrpCandidates = await prisma.mRPRun.findMany({
      where: {
        isDeleted: false,
        isCurrentPlan: true,
        status: "Completed",
        OR: [
          { mpsNumber },
          { planningMonth: { gte: monthStart(anchorMonth), lt: anchorMonthEnd } },
        ],
      },
      orderBy: { createdAt: "desc" },
      select: { runNumber: true, mpsNumber: true, scenarioAssumptions: true },
    });
    const completedMrp = completedMrpCandidates.find((run) => {
      const sourceMpsNumbers = Array.isArray(run.scenarioAssumptions?.sourceMpsNumbers)
        ? run.scenarioAssumptions.sourceMpsNumbers
        : [run.mpsNumber];
      return run.mpsNumber === mpsNumber || sourceMpsNumbers.includes(mpsNumber);
    });
    if (!completedMrp) return res.status(409).json({ message: "Jalankan MRP sampai Completed sebelum membuat Production Plan agar material sudah diperiksa." });
    const rootRequirements = await prisma.mRPRequirement.findMany({
      where: {
        runNumber: completedMrp.runNumber,
        isDeleted: false,
        orderType: "Production",
        requirementType: "Independent",
        levelMBOM: 0,
        mpsDetailId: { not: null },
      },
      select: { mpsDetailId: true, plannedOrderQty: true, adjustedOrderQty: true, netRequirement: true },
    });
    const netProductionByMpsDetail = new Map();
    for (const row of rootRequirements) {
      const qty = number(row.adjustedOrderQty || row.plannedOrderQty || row.netRequirement);
      netProductionByMpsDetail.set(row.mpsDetailId, number(netProductionByMpsDetail.get(row.mpsDetailId)) + qty);
    }
    const validDetails = await splitPlanDetailsByMrpExecutionMonth(
      completedMrp.runNumber,
      derivePlanDetails(mps.details, productionPercent, netProductionByMpsDetail),
    );
    if (!validDetails.length) return res.status(400).json({ message: "MPS belum mempunyai FG receipt atau child/SFG process." });

    const { grouped, horizon } = groupDetailsIntoProductionHorizon(validDetails, mps.planningAnchorMonth || mps.periodStart);
    const ownerWindow = productionPlanOwnerWindow(horizon);
    const sourceType = `MPS:${mps.mpsNumber}`;
    const result = await prisma.$transaction(async (tx) => {
      const plans = [];
      for (const [key, details] of grouped.entries()) {
        const planMonth = monthStart(key);
        const existingDraft = await tx.monthlyProductionPlan.findFirst({
          where: { sourceType, isDeleted: false, status: "Draft" },
          orderBy: [{ periodStart: "asc" }, { createdAt: "asc" }],
          include,
        });
        const existing = existingDraft || await tx.monthlyProductionPlan.findFirst({
          where: { sourceType, isDeleted: false, status: { notIn: ["Cancelled", "Closed"] } },
          orderBy: [{ periodStart: "asc" }, { createdAt: "asc" }],
          include,
        });
        if (existing) {
          if (existing.status === "Draft") {
            let nextLineNumber = await nextMonthlyPlanDetailLineNumber(tx, existing.id);
            const matchedIds = new Set();
            for (const row of details) {
              const sourceLineMarker = `[MPS-LINE:${row.lineNumber}]`;
              const matched = existing.details.find((detail) =>
                !matchedIds.has(detail.id)
                && stableMpsPlanDetailMatch(detail, row, sourceLineMarker));
              const data = detailFromMps(row, matched?.lineNumber || nextLineNumber++);
              if (matched) { matchedIds.add(matched.id); await tx.monthlyProductionPlanDetail.update({ where: { id: matched.id }, data }); }
              else await tx.monthlyProductionPlanDetail.create({ data: { ...data, planId: existing.id } });
            }
            const stale = existing.details.filter((detail) => !matchedIds.has(detail.id));
            if (stale.length) await tx.monthlyProductionPlanDetail.updateMany({ where: { id: { in: stale.map((detail) => detail.id) } }, data: { isDeleted: true, status: "Cancelled", notes: "Synchronized: MPS line no longer active" } });
            const positiveQtyCount = await tx.monthlyProductionPlanDetail.count({
              where: { planId: existing.id, isDeleted: false, qtyPlanned: { gt: 0.000001 } },
            });
            if (positiveQtyCount === 0) {
              await tx.monthlyProductionPlan.update({
                where: { id: existing.id },
                data: {
                  status: "Closed",
                  closedBy: req.user?.username || req.user?.email || "system",
                  closedAt: new Date(),
                  notes: `Production plan dari ${mps.mpsNumber}; kebutuhan produksi 0 karena demand sudah tercakup stock pada ${completedMrp.runNumber}.`,
                },
              });
            } else {
              await tx.monthlyProductionPlan.update({
                where: { id: existing.id },
                data: {
                  planMonth,
                  periodStart: ownerWindow.startDate,
                  periodEnd: ownerWindow.endDate,
                  notes: `${existing.notes || `Production Plan dari ${mps.mpsNumber}`} [HORIZON:${horizon.horizonStart.toISOString().slice(0, 10)}..${horizon.horizonEnd.toISOString().slice(0, 10)}] [OWNERSHIP:DEMAND_PHASE]`.trim(),
                },
              });
            }
            const duplicatePlans = await tx.monthlyProductionPlan.findMany({
              where: {
                sourceType,
                id: { not: existing.id },
                isDeleted: false,
                OR: [
                  { status: "Draft" },
                  { notes: { contains: `[SUPERSEDED-BY:${existing.planNumber}]` } },
                ],
              },
              select: { id: true, planNumber: true, notes: true },
            });
            if (duplicatePlans.length) {
              const duplicateIds = duplicatePlans.map((row) => row.id);
              await tx.productionPlanAllocation.updateMany({ where: { planId: { in: duplicateIds }, isDeleted: false, status: { in: ["Draft", "Published"] } }, data: { status: "Cancelled", isDeleted: true } });
              await tx.monthlyProductionPlan.updateMany({
                where: { id: { in: duplicateIds } },
                data: {
                  status: "Closed",
                  closedBy: req.user?.username || req.user?.email || "system",
                  closedAt: new Date(),
                  notes: `[SUPERSEDED-BY:${existing.planNumber}] Legacy month-split plan dikonsolidasikan ke satu demand-phase horizon.`,
                },
              });
            }
          }
          const synchronized = await tx.monthlyProductionPlan.findFirst({ where: { id: existing.id }, include });
          plans.push({ ...serialize(synchronized), existing: true, synchronized: existing.status === "Draft" });
          continue;
        }
        const planNumber = await nextPlanNumber(tx, planMonth);
        const noProductionRequired = details.every((row) => number(row.qtyPlanned) <= 0.000001);
        const created = await tx.monthlyProductionPlan.create({
          data: {
            planNumber,
            planMonth,
            periodStart: ownerWindow.startDate,
            periodEnd: ownerWindow.endDate,
            status: noProductionRequired ? "Closed" : "Draft",
            sourceType,
            notes: noProductionRequired
              ? `Production plan dari ${mps.mpsNumber}; kebutuhan produksi 0 karena demand sudah tercakup stock pada ${completedMrp.runNumber}.`
              : `Production plan dari ${mps.mpsNumber}; material check ${completedMrp.runNumber}; adjustment ${productionPercent}% (minimum SO aktual); [HORIZON:${horizon.horizonStart.toISOString().slice(0, 10)}..${horizon.horizonEnd.toISOString().slice(0, 10)}] [OWNERSHIP:DEMAND_PHASE]`,
            ...(noProductionRequired ? {
              closedBy: req.user?.username || req.user?.email || "system",
              closedAt: new Date(),
            } : {}),
            createdBy: req.user?.username || req.user?.email || null,
            details: {
              create: details.map((row, index) => detailFromMps(row, index + 1)),
            },
          },
          include,
        });
        plans.push({ ...serialize(created), existing: false });
      }
      return plans;
    });
    const actor = req.user?.username || req.user?.email || "system";
    const items = [];
    for (const item of result) {
      let capacityRecommendation = null;
      // First creation and Draft re-sync both receive a fresh recommendation.
      // The service only replaces its own AUTO_RECOMMENDATION rows; PPIC's
      // manual allocations remain authoritative.
      if ((!item.existing || item.synchronized) && item.status === "Draft") {
        try {
          // createFromMps already refreshes the detail rows above. Reusing the
          // authoritative sync here also advances sourcePlanSync, so an older
          // capacity audit (for example R005) cannot survive a sync to R006.
          const sourcePlanSync = await syncDraftPlanWithCurrentMps(item.planNumber, actor);
          capacityRecommendation = await recommendMonthlyCapacity(prisma, item.planNumber, { actor, flowRule: normalizeCapacityFlowRule({}) });
          capacityRecommendation.sourcePlanSync = sourcePlanSync;
          if (capacityRecommendation.ready) {
            await prisma.$transaction((tx) => refreshDraftForMps(tx, mps.mpsNumber, actor));
          }
        } catch (recommendationError) {
          capacityRecommendation = { ready: false, error: recommendationError.message };
        }
      }
      items.push({ ...item, capacityRecommendation });
    }
    const sourceMonth = monthKey(mps.periodStart);
    const primaryPlan = items.find((item) =>
      monthKey(item.planMonth || item.periodStart) === sourceMonth
      && number(item.receiptLineCount) > 0)
      || items.find((item) => number(item.receiptLineCount) > 0)
      || items[0]
      || null;
    res.status(201).json({
      items,
      total: items.length,
      primaryPlanNumber: primaryPlan?.planNumber || null,
      sourceMpsNumber: mps.mpsNumber,
      mrpRunNumber: completedMrp.runNumber,
      productionPercent,
    });
  } catch (error) { next(error); }
};

exports.getCapacityFlowRule = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber: req.params.planNumber, isDeleted: false },
      select: { planNumber: true, recommendationSummary: true },
    });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan." });
    const summary = plan.recommendationSummary && typeof plan.recommendationSummary === "object" && !Array.isArray(plan.recommendationSummary) ? plan.recommendationSummary : {};
    const stored = summary.capacityFlowRule && typeof summary.capacityFlowRule === "object" ? summary.capacityFlowRule : {};
    res.json({ planNumber: plan.planNumber, draft: stored.draft || null, active: stored.active || null, updatedAt: stored.updatedAt || null, updatedBy: stored.updatedBy || null });
  } catch (error) { next(error); }
};

exports.saveCapacityFlowRule = async (req, res, next) => {
  try {
    const saveMode = String(req.body?.saveMode || "DRAFT").toUpperCase() === "ACTIVE" ? "ACTIVE" : "DRAFT";
    const rule = normalizeCapacityFlowRule(req.body?.rule || req.body || {});
    if (saveMode === "ACTIVE") assertCapacityFlowRule(rule);
    const plan = await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber: req.params.planNumber, isDeleted: false },
      select: { id: true, planNumber: true, recommendationSummary: true },
    });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan." });
    const current = plan.recommendationSummary && typeof plan.recommendationSummary === "object" && !Array.isArray(plan.recommendationSummary) ? plan.recommendationSummary : {};
    const currentFlow = current.capacityFlowRule && typeof current.capacityFlowRule === "object" ? current.capacityFlowRule : {};
    const actor = req.user?.username || req.user?.email || "system";
    const savedAt = new Date().toISOString();
    const capacityFlowRule = {
      ...currentFlow,
      draft: rule,
      ...(saveMode === "ACTIVE" ? { active: rule, activatedAt: savedAt, activatedBy: actor } : {}),
      updatedAt: savedAt,
      updatedBy: actor,
    };
    await prisma.monthlyProductionPlan.update({
      where: { id: plan.id },
      data: { recommendationSummary: { ...current, capacityFlowRule } },
    });
    res.json({ planNumber: plan.planNumber, saveMode, rule, capacityFlowRule, message: saveMode === "ACTIVE" ? "Algoritma aliran disimpan dan siap digunakan." : "Draft aturan aliran disimpan." });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

exports.recommendCapacity = async (req, res, next) => {
  try {
    const planningMode = String(req.body?.planningMode || "PRODUCTION").toUpperCase() === "SIMULATION" ? "SIMULATION" : "PRODUCTION";
    const scenarioKey = planningMode === "SIMULATION" ? String(req.body?.scenarioKey || "").trim().toLowerCase() : null;
    const presetId = String(req.body?.presetId || scenarioKey || "").trim().toLowerCase() || null;
    if (planningMode === "SIMULATION" && !scenarioKey) return res.status(400).json({ message: "Pilih preset simulasi bulanan terlebih dahulu." });
    if (presetId && !(await findPreset(prisma, presetId))) return res.status(404).json({ message: "Preset capacity tidak ditemukan." });
    const actor = req.user?.username || req.user?.email || "system";
    const sourcePlanSync = await syncDraftPlanWithCurrentMps(req.params.planNumber, actor);
    const planningGranularity = String(req.body?.planningGranularity || "DAY").toUpperCase() === "WEEK" ? "WEEK" : "DAY";
    const rollingLookbackWeeks = Math.min(Math.max(Math.trunc(number(req.body?.rollingLookbackWeeks)), 0), 12);
    const freezeFenceDays = Math.min(Math.max(Math.trunc(number(req.body?.freezeFenceDays)), 0), 31);
    await prisma.monthlyProductionPlan.update({ where: { planNumber: req.params.planNumber }, data: { planningGranularity, rollingLookbackWeeks, freezeFenceDays } });
    const storedPlan = await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber: req.params.planNumber, isDeleted: false },
      select: { id: true, recommendationSummary: true, sourceType: true, periodStart: true, periodEnd: true },
    });
    const storedSummary = storedPlan?.recommendationSummary && typeof storedPlan.recommendationSummary === "object" && !Array.isArray(storedPlan.recommendationSummary) ? storedPlan.recommendationSummary : {};
    const rawFlowRule = req.body?.flowRule || storedSummary.capacityFlowRule?.active || null;
    const flowRule = normalizeCapacityFlowRule(rawFlowRule || {});
    assertCapacityFlowRule(flowRule);
    const recommendation = await recommendMonthlyCapacity(prisma, req.params.planNumber, {
      actor,
      planningMode,
      scenarioKey,
      presetId,
      flowRule,
      transferBatchQty: flowRule.flowMethod === "SPLIT_BATCH" ? flowRule.flow.transferBatchQuantity : 0,
    });
    recommendation.sourcePlanSync = sourcePlanSync;
    // Slot-search success is not sufficient: validate the persisted allocation graph with
    // the same authoritative readiness rules used by the Capacity Planning workspace.
    const allocationReady = recommendation.ready;
    const allocationBlockers = Array.isArray(recommendation.blockers) ? recommendation.blockers : [];
    const validationSnapshot = await buildCapacitySnapshot(prisma, {
      planNumber: req.params.planNumber,
      startDate: storedPlan.periodStart,
      endDate: recommendation.schedulingHorizonEnd || storedPlan.periodEnd,
      planningMode,
      scenarioKey,
      presetId,
      manualAllocation: true,
      planningGranularity,
      rollingLookbackWeeks,
      freezeFenceDays,
    });
    const validationBlockers = (validationSnapshot.readiness?.issues || []).filter((issue) => issue.severity === "blocking");
    const authoritativeBlockers = uniqueCapacityBlockers([...allocationBlockers, ...validationBlockers]);
    const blockerAllocationIds = [...new Set(validationBlockers.flatMap((issue) => [issue.allocationId, issue.relatedAllocationId]).filter(Boolean))];
    const allocationPhases = blockerAllocationIds.length
      ? await prisma.productionPlanAllocation.findMany({
          where: { id: { in: blockerAllocationIds }, isDeleted: false },
          select: { id: true, deliveryPhaseId: true, deliveryPhaseNumber: true },
        })
      : [];
    const authoritativePhaseResults = buildAuthoritativePhaseResults({
      phaseResults: recommendation.phaseResults,
      blockers: authoritativeBlockers,
      allocationPhases,
      deliveryPhases: validationSnapshot.deliveryCoverage?.phases || [],
    });
    recommendation.allocationReady = allocationReady;
    recommendation.algorithmBlockers = allocationBlockers;
    recommendation.readiness = validationSnapshot.readiness;
    recommendation.validationBlockers = validationBlockers;
    recommendation.blockers = authoritativeBlockers;
    recommendation.ready = allocationReady && Boolean(validationSnapshot.readiness?.ok);
    recommendation.algorithmPhaseResults = recommendation.phaseResults;
    recommendation.phaseResults = authoritativePhaseResults;
    recommendation.validation = {
      ...(recommendation.validation || {}),
      status: recommendation.ready ? "AUTHORITATIVE_READY" : "AUTHORITATIVE_BLOCKED",
      validatedAt: new Date().toISOString(),
      blockingCount: authoritativeBlockers.length,
      algorithmBlockingCount: allocationBlockers.length,
      validationBlockingCount: validationBlockers.length,
    };
    if (planningMode === "PRODUCTION") {
      const latestPlan = await prisma.monthlyProductionPlan.findFirst({
        where: { planNumber: req.params.planNumber, isDeleted: false },
        select: { recommendationSummary: true },
      });
      const recommendationSummary = mergeAuthoritativeRecommendationSummary(latestPlan?.recommendationSummary, {
        recommendation,
        allocationBlockers,
        validationBlockers,
        readiness: validationSnapshot.readiness,
        allocationPhases,
        deliveryPhases: validationSnapshot.deliveryCoverage?.phases || [],
        validatedAt: recommendation.validation.validatedAt,
      });
      await prisma.monthlyProductionPlan.update({ where: { planNumber: req.params.planNumber }, data: { recommendationSummary, replanRequired: !recommendation.ready, replanReason: recommendation.ready ? null : "Capacity recommendation masih memiliki blocker.", ...(recommendation.ready ? { lastReplannedAt: new Date() } : {}) } });
      if (recommendation.ready) await prisma.planningChangeImpact.updateMany({ where: { status: "PENDING_REPLAN", affectedPlanNumbers: { array_contains: [req.params.planNumber] } }, data: { status: "RESOLVED", resolutionNotes: `Production Capacity dihitung ulang melalui ${req.params.planNumber}.`, resolvedBy: req.user?.username || req.user?.email || "system", resolvedAt: new Date() } });
      const sourceMpsNumber = String(storedPlan?.sourceType || "").startsWith("MPS:") ? String(storedPlan.sourceType).slice(4) : null;
      if (recommendation.ready && sourceMpsNumber) {
        await prisma.$transaction((tx) => refreshDraftForMps(tx, sourceMpsNumber, req.user?.username || req.user?.email || "system"));
      }
      recommendation.vendorProcessPr = await prisma.$transaction((tx) => syncVendorProcessDraftPrForPlan(
        tx,
        storedPlan.id,
        req.user?.username || req.user?.email || "system",
      ));
    }
    res.json(recommendation);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.details ? { details: error.details } : {}),
    });
    next(error);
  }
};

exports.adoptCapacitySimulation = async (req, res, next) => {
  try {
    const scenarioKey = String(req.body?.scenarioKey || "").trim().toLowerCase();
    if (!/^preset-[a-z0-9-]{8,}$/i.test(scenarioKey)) return res.status(400).json({ message: "Pilih preset simulasi bulanan yang akan dijadikan Production Capacity." });
    const preset = await findPreset(prisma, scenarioKey);
    if (!preset) return res.status(404).json({ message: "Preset simulasi tidak ditemukan atau sudah tidak tersedia." });
    const plan = await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber: req.params.planNumber, isDeleted: false },
      select: { id: true, planNumber: true, status: true, periodStart: true, periodEnd: true },
    });
    if (!plan) return res.status(404).json({ message: "Production Plan tidak ditemukan." });
    if (!["Draft", "Confirmed", "Released", "In Progress"].includes(plan.status)) {
      return res.status(409).json({ message: `Production Capacity tidak dapat direvisi saat MPP berstatus ${plan.status}.` });
    }
    const today = jakartaTodayDate();
    const simulationRows = await prisma.productionPlanAllocation.findMany({
      where: { planId: plan.id, planningMode: "SIMULATION", scenarioKey, status: "Draft", isDeleted: false },
      orderBy: [{ scheduleDate: "asc" }, { plannedStartTime: "asc" }, { createdAt: "asc" }],
    });
    const simulationFuture = simulationRows.filter((row) => dateOnly(row.scheduleDate) >= today);
    if (!simulationFuture.length) return res.status(409).json({ message: "Preset tidak mempunyai allocation hari ini atau mendatang. Hari yang sudah lewat dikunci sebagai histori Production.", code: "CAPACITY_HISTORY_LOCKED" });
    const production = await prisma.productionPlanAllocation.findMany({
      where: { planId: plan.id, planningMode: "PRODUCTION", status: { in: ["Draft", "Published"] }, isDeleted: false },
      select: { id: true, lineNumber: true, mbomProcessId: true, scheduleDate: true, shift: true, plannedQty: true, deliveryPhaseId: true, transferBatchNumber: true },
    });
    const linkedSchedules = await prisma.dailyProductionSchedule.findMany({
      where: { productionPlanId: plan.id, isDeleted: false, status: { not: "Cancelled" } },
      select: { id: true, scheduleNumber: true, scheduleDate: true, status: true, productionPlanAllocationId: true },
    });
    const firmSchedules = linkedSchedules.filter((row) => row.status !== "Draft");
    const firmAllocationIds = new Set(firmSchedules.map((row) => row.productionPlanAllocationId).filter(Boolean));
    const replaceableSchedules = linkedSchedules.filter((row) => row.status === "Draft" && dateOnly(row.scheduleDate) >= today);
    const replaceableProduction = production.filter((row) => dateOnly(row.scheduleDate) >= today && !firmAllocationIds.has(row.id));
    const preservedProduction = production.filter((row) => dateOnly(row.scheduleDate) < today || firmAllocationIds.has(row.id));
    const productionIds = replaceableProduction.map((row) => row.id);
    const remainingFirmQty = new Map();
    const routeKey = (row) => `${row.lineNumber}|${row.mbomProcessId}`;
    for (const row of preservedProduction) remainingFirmQty.set(routeKey(row), number(remainingFirmQty.get(routeKey(row))) + number(row.plannedQty));
    const simulation = simulationFuture.map((row) => {
      const key = routeKey(row);
      const covered = Math.min(number(remainingFirmQty.get(key)), number(row.plannedQty));
      remainingFirmQty.set(key, Math.max(number(remainingFirmQty.get(key)) - covered, 0));
      return covered > 0 ? { ...row, plannedQty: number(row.plannedQty) - covered } : row;
    }).filter((row) => number(row.plannedQty) > 0.000001);
    const actor = req.user?.username || req.user?.email || "system";
    const planningGranularity = String(req.body?.planningGranularity || "DAY").toUpperCase() === "WEEK" ? "WEEK" : "DAY";
    const rollingLookbackWeeks = Math.min(Math.max(Math.trunc(number(req.body?.rollingLookbackWeeks)), 0), 12);
    const freezeFenceDays = Math.min(Math.max(Math.trunc(number(req.body?.freezeFenceDays)), 0), 31);
    const result = await prisma.$transaction(async (tx) => {
      if (replaceableSchedules.length) await tx.dailyProductionSchedule.updateMany({ where: { id: { in: replaceableSchedules.map((row) => row.id) } }, data: { status: "Cancelled", isDeleted: true } });
      if (productionIds.length) await tx.productionPlanAllocation.updateMany({ where: { id: { in: productionIds } }, data: { status: "Cancelled", isDeleted: true } });
      const idMap = new Map();
      const simulationById = new Map(simulationRows.map((row) => [row.id, row]));
      const fingerprint = (row) => [row.lineNumber, row.mbomProcessId, dateOnly(row.scheduleDate)?.toISOString().slice(0, 10), row.shift, row.deliveryPhaseId || "", row.transferBatchNumber || "", number(row.plannedQty)].join("|");
      const preservedProductionByFingerprint = new Map(preservedProduction.map((row) => [fingerprint(row), row.id]));
      const preservedProductionByRoute = new Map(preservedProduction.map((row) => [routeKey(row), row.id]));
      for (const source of simulation) {
        const created = await tx.productionPlanAllocation.create({
          data: {
            planId: source.planId, lineNumber: source.lineNumber, mbomProcessId: source.mbomProcessId,
            scheduleDate: source.scheduleDate, shift: source.shift, plannedStartTime: source.plannedStartTime,
            plannedEndTime: source.plannedEndTime, machineId: source.machineId, diesId: source.diesId, routingMode: source.routingMode,
            vendorId: source.vendorId, vendorSendDate: source.vendorSendDate, vendorReturnDate: source.vendorReturnDate,
            vendorLeadTimeDays: source.vendorLeadTimeDays, expectedReturnQty: source.expectedReturnQty,
            plannedQty: source.plannedQty, uomCode: source.uomCode, status: "Draft", notes: source.notes,
            allocationSource: source.allocationSource, planningMode: "PRODUCTION", scenarioKey: null,
            recommendationReason: source.recommendationReason, capacityMode: source.capacityMode,
            deliveryPhaseId: source.deliveryPhaseId, deliveryPhaseNumber: source.deliveryPhaseNumber,
            transferBatchNumber: source.transferBatchNumber, predecessorAllocationIds: null, createdBy: actor,
          },
        });
        idMap.set(source.id, created.id);
      }
      for (const source of simulation) {
        const mapped = Array.isArray(source.predecessorAllocationIds) ? source.predecessorAllocationIds.map((id) => {
          if (idMap.has(id)) return idMap.get(id);
          const historicalSource = simulationById.get(id);
          if (!historicalSource) return null;
          return dateOnly(historicalSource.scheduleDate) < today
            ? preservedProductionByFingerprint.get(fingerprint(historicalSource)) || preservedProductionByRoute.get(routeKey(historicalSource))
            : preservedProductionByRoute.get(routeKey(historicalSource)) || null;
        }).filter(Boolean) : [];
        if (mapped.length) await tx.productionPlanAllocation.update({ where: { id: idMap.get(source.id) }, data: { predecessorAllocationIds: mapped } });
      }
      const simulationMachineIds = [...new Set(simulation.filter((row) => row.routingMode === "INHOUSE" && row.machineId).map((row) => row.machineId))];
      const calendarStart = new Date(Math.max(plan.periodStart.getTime(), today.getTime()));
      for (let scheduleDate = calendarStart; scheduleDate <= plan.periodEnd; scheduleDate = new Date(scheduleDate.getTime() + 86400000)) {
        const date = scheduleDate.toISOString().slice(0, 10); const configured = preset.dailyOverrides?.[date] || null; const weekDay = scheduleDate.getUTCDay(); const weekendHoliday = !configured && ((weekDay === 6 && !preset.includeSaturday) || (weekDay === 0 && !preset.includeSunday));
        const dayStatus = configured?.dayStatus || (weekendHoliday ? "HOLIDAY" : "WORKING"); const shiftsPerDay = Math.max(1, Math.min(Number(configured?.shiftCount || preset.shiftCount || 2), 3)); const overtimeStart = configured?.overtimeStart || preset.overtimeStart || null; const overtimeEnd = configured?.overtimeEnd || preset.overtimeEnd || null;
        for (const machineId of simulationMachineIds) {
          await tx.capacityDayOverride.upsert({
            where: { planId_machineId_scheduleDate: { planId: plan.id, machineId, scheduleDate } },
            update: { dayStatus, shiftsPerDay, overtimeStart, overtimeEnd, reason: `[SIMULATION-PRESET:${preset.id}] ${preset.name}`, changedBy: actor, changedAt: new Date(), isDeleted: false },
            create: { planId: plan.id, machineId, scheduleDate, dayStatus, shiftsPerDay, overtimeStart, overtimeEnd, reason: `[SIMULATION-PRESET:${preset.id}] ${preset.name}`, changedBy: actor },
          });
        }
      }
      await tx.monthlyProductionPlan.update({ where: { id: plan.id }, data: { planningGranularity, rollingLookbackWeeks, freezeFenceDays, replanRequired: false, replanReason: null, lastReplannedAt: new Date() } });
      await tx.planningChangeImpact.updateMany({ where: { status: "PENDING_REPLAN", affectedPlanNumbers: { array_contains: [plan.planNumber] } }, data: { status: "RESOLVED", resolutionNotes: `Simulation ${scenarioKey} diadopsi menjadi Production Capacity ${plan.planNumber}.`, resolvedBy: actor, resolvedAt: new Date() } });
      return { adoptedCount: idMap.size, appliedCalendarDays: plan.periodEnd < calendarStart ? 0 : Math.floor((plan.periodEnd - calendarStart) / 86400000) + 1, appliedMachineCount: simulationMachineIds.length, cancelledDppCount: replaceableSchedules.length, replacedProductionCount: productionIds.length, lockedPastAllocationCount: preservedProduction.length, lockedPastDppCount: firmSchedules.length, preservedCompletedDppCount: firmSchedules.filter((row) => row.status === "Completed").length };
    });
    await activatePreset(prisma, preset.id, actor);
    const vendorProcessPr = await prisma.$transaction((tx) => syncVendorProcessDraftPrForPlan(tx, plan.id, actor));
    res.json({ planNumber: plan.planNumber, scenarioKey, currentPresetId: preset.id, currentPresetName: preset.name, planningMode: "PRODUCTION", ...result, vendorProcessPr, message: "Preset berhasil ditetapkan sebagai Current Use Capacity. Auto recommendation MPP berikutnya akan memakai preset ini; hari yang sudah lewat tetap dikunci sebagai histori." });
  } catch (error) { next(error); }
};

exports.confirm = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber: req.params.planNumber, isDeleted: false }, include });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan." });
    if (plan.status !== "Draft") return res.status(409).json({ message: `Production Plan tidak dapat dikonfirmasi dari status ${plan.status}.` });
    if (!plan.details.length) return res.status(400).json({ message: "Production Plan tanpa detail tidak dapat dikonfirmasi." });
    const [sourceReconciliation, officialAllocations] = await Promise.all([buildSourceReconciliation(plan), loadOfficialAllocations(plan.id)]);
    assertPlanSourceAndTimingReady(plan, sourceReconciliation, officialAllocations);
    if (plan.replanRequired) return res.status(409).json({ message: plan.replanReason || "Production Plan harus direplan setelah perubahan target delivery.", code: "DELIVERY_REPLAN_REQUIRED" });
    const updated = await prisma.monthlyProductionPlan.update({ where: { planNumber: plan.planNumber }, data: { status: "Confirmed", confirmedBy: req.user?.username || req.user?.email || null, confirmedAt: new Date() }, include });
    res.json(serialize(updated));
  } catch (error) { next(error); }
};

exports.release = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber: req.params.planNumber, isDeleted: false }, include });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan." });
    if (plan.status !== "Confirmed") return res.status(409).json({ message: `Production Plan harus Confirmed sebelum release, status saat ini ${plan.status}.` });
    const [sourceReconciliation, officialAllocations] = await Promise.all([buildSourceReconciliation(plan), loadOfficialAllocations(plan.id)]);
    assertPlanSourceAndTimingReady(plan, sourceReconciliation, officialAllocations);
    if (plan.replanRequired) return res.status(409).json({ message: plan.replanReason || "Production Plan harus direplan setelah perubahan target delivery.", code: "DELIVERY_REPLAN_REQUIRED" });
    const capacity = await buildCapacitySnapshot(prisma, {
      planNumber: plan.planNumber,
      startDate: plan.periodStart,
      endDate: capacityHorizonEnd(plan),
      manualAllocation: true,
    });
    const materialReadiness = await buildMaterialReadinessSnapshot(prisma, plan);
    const materialDisposition = planningMaterialDisposition(materialReadiness);
    const hasOverridable = Number(capacity.readiness.overridableCount || 0) > 0 || Number(capacity.summary.overloadedCells || 0) > 0;
    const overrideApproved = plan.capacityOverrideApproved === true;
    if (!capacity.readiness.ok || (hasOverridable && !overrideApproved)) {
      return res.status(409).json({ message: "Production Plan belum dapat direlease. Lengkapi alokasi manual pada Capacity Check, pastikan tiap delivery phase tercukupi, lalu selesaikan blocker routing/overload.", code: "CAPACITY_NOT_READY", capacity: { summary: capacity.summary, readiness: capacity.readiness, deliveryCoverage: capacity.deliveryCoverage, unscheduled: capacity.unscheduled } });
    }
    const updated = await prisma.monthlyProductionPlan.update({ where: { planNumber: plan.planNumber }, data: { status: "Released", releasedBy: req.user?.username || req.user?.email || null, releasedAt: new Date() }, include });
    res.json({ ...serialize(updated), materialReadiness, warnings: [...materialDisposition.warnings, ...capacityUnscheduledNotices(capacity, plan.planNumber)] });
  } catch (error) { next(error); }
};

// PPIC owns the monthly-to-daily conversion. The capacity snapshot is the
// source of machine/date allocation; Production only consumes the resulting
// Daily Production Plan and follows its MO / Material Issue references.
exports.convertToDailyPlans = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber: req.params.planNumber, isDeleted: false },
      include,
    });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan." });
    if (!["Released", "In Progress"].includes(plan.status)) {
      return res.status(409).json({
        message: `Production Plan harus Released sebelum dikonversi ke Daily Production Plan. Status saat ini ${plan.status}.`,
        code: "MONTHLY_PLAN_NOT_RELEASED",
      });
    }
    if (plan.replanRequired) return res.status(409).json({ message: plan.replanReason || "Jalankan ulang Production Capacity sebelum revisi DPP.", code: "DELIVERY_REPLAN_REQUIRED" });
    const dailyMaterialReadiness = await buildMaterialReadinessSnapshot(prisma, plan);
    const dailyMaterialDisposition = planningMaterialDisposition(dailyMaterialReadiness);

    // UOM is a foreign key in WO/DPP. Capacity allocations can originate from
    // legacy snapshots that use different letter casing (for example `PCS`
    // while the canonical master key is `pcs`). Publish the real master key.
    const masterUoms = await prisma.uom.findMany({
      where: { isDeleted: false },
      select: { uomCode: true },
    });
    const canonicalUomByLower = new Map(masterUoms.map((row) => [String(row.uomCode).trim().toLowerCase(), row.uomCode]));
    const canonicalUomCode = (...candidates) => {
      for (const candidate of candidates) {
        const value = String(candidate || "").trim();
        if (!value) continue;
        const canonical = canonicalUomByLower.get(value.toLowerCase());
        if (canonical) return canonical;
      }
      return null;
    };

    {
    const draftAllocations = await prisma.productionPlanAllocation.findMany({
      where: { planId: plan.id, isDeleted: false, status: "Draft", planningMode: "PRODUCTION" },
      include: {
        mbomProcess: {
          select: {
            id: true,
            noReg: true,
            mbomDetailId: true,
            processId: true,
            sequence: true,
            cycleTime: true,
            machineId: true,
            diesId: true,
            process: { select: { processCode: true, processName: true } },
            machine: { select: { costingRate: true, costingRateType: true, currencyCode: true } },
            routingOperation: {
              select: {
                workCenterId: true,
                workCenter: {
                  select: {
                    machines: {
                      select: {
                        machineId: true,
                        machine: { select: { status: true, isDeleted: true } },
                      },
                    },
                  },
                },
              },
            },
            mbomDetail: {
              select: {
                partId: true,
                part: { select: { partCode: true, partNumber: true, partName: true } },
              },
            },
          },
        },
      },
      orderBy: [{ scheduleDate: "asc" }, { lineNumber: "asc" }, { createdAt: "asc" }],
    });
    if (!draftAllocations.length) {
      return res.status(409).json({
        message: "Belum ada draft allocation MPP yang perlu dipublikasikan. Atur tanggal, mesin, shift, dan qty dari Capacity Check terlebih dahulu.",
        code: "MANUAL_MPP_ALLOCATION_REQUIRED",
      });
    }

    const manufacturingOrders = await prisma.manufacturingOrder.findMany({
      where: {
        monthlyProductionPlanNumber: plan.planNumber,
        isDeleted: false,
        status: { notIn: ["Cancelled", "Completed"] },
      },
      include: {
        part: { select: { partCode: true } },
        workOrders: {
          where: { isDeleted: false, status: { not: "Cancelled" } },
          orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
        },
      },
      orderBy: [{ monthlyProductionPlanLineNumber: "asc" }, { createdAt: "asc" }],
    });
    if (!manufacturingOrders.length) {
      return res.status(409).json({
        message: "MPP sudah dapat dialokasikan sebelum release, tetapi publish ke Daily Plan memerlukan MO/WO reference. Buat MO reference lalu ulangi publish.",
        code: "MO_REFERENCE_REQUIRED_FOR_PUBLISH",
      });
    }

    const allocationBomNumbers = [...new Set(
      draftAllocations.map((allocation) => allocation.mbomProcess?.noReg).filter(Boolean),
    )];
    const allocationBomHeaders = allocationBomNumbers.length
      ? await prisma.mBOMHeader.findMany({
        where: { noReg: { in: allocationBomNumbers }, isDeleted: false },
        select: { noReg: true, partId: true },
      })
      : [];
    const bomOwnerPartIdByNumber = new Map(
      allocationBomHeaders.map((header) => [header.noReg, header.partId]),
    );
    const sourceMpsNumber = String(plan.sourceType || "").startsWith("MPS:")
      ? String(plan.sourceType).slice(4)
      : null;
    const sourceMpsDetails = sourceMpsNumber ? await prisma.mPSDetail.findMany({
      where: { mpsNumber: sourceMpsNumber, isDeleted: false },
      select: { id: true, notes: true },
    }) : [];
    const sourceMpsById = new Map(sourceMpsDetails.map((row) => [row.id, row]));
    const currentMrp = sourceMpsNumber ? await prisma.mRPRun.findFirst({ where: { mpsNumber: sourceMpsNumber, isDeleted: false, isCurrentPlan: true }, orderBy: { planRevision: "desc" }, select: { runNumber: true } }) : null;
    const planDetailByMpsId = new Map(plan.details.filter((row) => row.mpsDetailId).map((row) => [row.mpsDetailId, row]));
    const parentLineByLine = new Map();
    for (const detail of plan.details) {
      // MRP reruns can replace generated MPS detail ids. The MPP snapshot
      // keeps the immutable source marker, so prefer it over the current MPS row.
      const sourceId = String(detail.notes || sourceMpsById.get(detail.mpsDetailId)?.notes || "").match(/\[MPS-SOURCE:([^\]]+)\]/)?.[1];
      const parentDetail = sourceId ? planDetailByMpsId.get(sourceId) : null;
      if (parentDetail) parentLineByLine.set(number(detail.lineNumber), number(parentDetail.lineNumber));
    }
    const mosByPartId = new Map();
    for (const mo of manufacturingOrders) {
      if (!mo.partId) continue;
      if (!mosByPartId.has(mo.partId)) mosByPartId.set(mo.partId, []);
      mosByPartId.get(mo.partId).push(mo);
    }

    const mosByLine = new Map();
    for (const mo of manufacturingOrders) {
      const lineNumber = number(mo.monthlyProductionPlanLineNumber);
      if (!mosByLine.has(lineNumber)) mosByLine.set(lineNumber, []);
      mosByLine.get(lineNumber).push(mo);
    }
    const receiptLineNumbers = new Set(plan.details.filter((row) => !isGeneratedProcess(row)).map((row) => number(row.lineNumber)));
    const parentMOs = manufacturingOrders.filter((mo) => receiptLineNumbers.has(number(mo.monthlyProductionPlanLineNumber)));
    const mosForAllocation = (allocation) => {
      const ownerPartId = bomOwnerPartIdByNumber.get(allocation.mbomProcess?.noReg);
      const owned = ownerPartId ? (mosByPartId.get(ownerPartId) || []) : [];
      if (owned.length) return owned;
      const direct = mosByLine.get(number(allocation.lineNumber)) || [];
      if (direct.length) return direct;
      const parentLine = parentLineByLine.get(number(allocation.lineNumber));
      const parentOwned = parentLine ? (mosByLine.get(parentLine) || []) : [];
      if (parentOwned.length) return parentOwned;
      // A single-FG plan has an unambiguous fallback. Multi-FG plans must
      // never guess by processId because common processes (PRG/SPOT/WELD)
      // occur under several forecast parents.
      return parentMOs.length === 1 ? parentMOs : [];
    };

    const allocationById = new Map(draftAllocations.map((allocation) => [allocation.id, allocation]));
    const allocationDepthMemo = new Map();
    const allocationDepth = (allocation, visiting = new Set()) => {
      if (!allocation) return 0;
      if (allocationDepthMemo.has(allocation.id)) return allocationDepthMemo.get(allocation.id);
      if (visiting.has(allocation.id)) return 0;
      const nextVisiting = new Set(visiting).add(allocation.id);
      const predecessors = Array.isArray(allocation.predecessorAllocationIds)
        ? allocation.predecessorAllocationIds.map((id) => allocationById.get(id)).filter(Boolean)
        : [];
      const depth = predecessors.length
        ? Math.max(...predecessors.map((row) => allocationDepth(row, nextVisiting))) + 1
        : 0;
      allocationDepthMemo.set(allocation.id, depth);
      return depth;
    };
    const routeDepthById = new Map();
    const routePlannedQtyById = new Map();
    for (const allocation of draftAllocations) {
      const routeId = allocation.mbomProcess?.id;
      if (!routeId) continue;
      routeDepthById.set(routeId, Math.max(number(routeDepthById.get(routeId)), allocationDepth(allocation)));
      routePlannedQtyById.set(routeId, number(routePlannedQtyById.get(routeId)) + number(allocation.plannedQty));
    }

    // Create the exact child-routing WO needed by each capacity allocation.
    // The same process can occur more than once in a nested BOM, therefore
    // mbomProcessId (not processId) is the execution identity.
    const generatedWorkOrders = await prisma.$transaction(async (tx) => {
      const created = [];
      const generatedKeys = new Set();
      for (const allocation of draftAllocations) {
        if (String(allocation.routingMode || "INHOUSE").toUpperCase() === "VENDOR") continue;
        const route = allocation.mbomProcess;
        const mo = mosForAllocation(allocation)[0] || null;
        if (!route?.id || !route.processId || !mo) continue;
        const key = `${mo.id}|${route.id}`;
        if (generatedKeys.has(key) || (mo.workOrders || []).some((wo) => wo.mbomProcessId === route.id)) continue;
        generatedKeys.add(key);
        const workOrder = await tx.workOrder.create({
          data: {
            woNumber: await nextWorkOrderNumber(tx, allocation.scheduleDate),
            woDate: new Date(),
            moId: mo.id,
            mbomDetailId: route.mbomDetailId || null,
            mbomProcessId: route.id,
            outputPartId: route.mbomDetail?.partId || mo.partId || null,
            outputPartCode: route.mbomDetail?.part?.partCode || mo.part?.partCode || null,
            outputPartNumber: route.mbomDetail?.part?.partNumber || null,
            outputPartName: route.mbomDetail?.part?.partName || null,
            processId: route.processId,
            sequence: (number(routeDepthById.get(route.id)) + 1) * 10,
            cycleTime: number(route.cycleTime),
            diesId: allocation.diesId || route.diesId || null,
            machineId: allocation.machineId || route.machineId || null,
            machineCostingRate: route.machine?.costingRate ?? null,
            machineRateType: route.machine?.costingRateType || null,
            machineCurrency: route.machine?.currencyCode || null,
            plannedDate: allocation.scheduleDate,
            plannedQty: normalizeQuantity(routePlannedQtyById.get(route.id), canonicalUomCode(allocation.uomCode, mo.uomCode)),
            uomCode: canonicalUomCode(allocation.uomCode, mo.uomCode),
            status: "Planned",
            notes: `[MPP-CHILD-ROUTING:${plan.planNumber}:${allocation.lineNumber}:${route.id}] Generated from Capacity Planning`,
          },
        });
        mo.workOrders.push(workOrder);
        created.push(workOrder);
      }
      return created;
    });

    const moIds = manufacturingOrders.map((mo) => mo.id);
    const mbomProcessIds = [...new Set(draftAllocations.map((row) => row.mbomProcess?.id).filter(Boolean))];
    const committed = await prisma.dailyProductionSchedule.groupBy({
      by: ["moId", "mbomProcessId"],
      where: {
        moId: { in: moIds },
        mbomProcessId: { in: mbomProcessIds },
        isDeleted: false,
        status: { in: ["Draft", "Released", "In Progress", "Completed"] },
      },
      _sum: { plannedQty: true },
    });
    const committedByMoProcess = new Map(committed.map((row) => [
      `${row.moId}|${row.mbomProcessId}`,
      number(row._sum.plannedQty),
    ]));
    const remainingByMoProcess = new Map();
    const desired = [];
    const vendorAllocationsByMo = new Map();
    const publishBlockers = [];

    for (const allocation of draftAllocations) {
      const processId = allocation.mbomProcess?.processId;
      const mbomProcessId = allocation.mbomProcess?.id;
      const candidateMos = mosForAllocation(allocation);
      if (!processId) {
        publishBlockers.push({ allocationId: allocation.id, reason: "ROUTING_PROCESS_REFERENCE_MISSING" });
        continue;
      }
      if (!candidateMos.length) {
        publishBlockers.push({ allocationId: allocation.id, lineNumber: allocation.lineNumber, reason: "MO_REFERENCE_MISSING" });
        continue;
      }
      if (String(allocation.routingMode || "INHOUSE").toUpperCase() === "VENDOR") {
        const mo = candidateMos[0];
        if (!vendorAllocationsByMo.has(mo.id)) vendorAllocationsByMo.set(mo.id, { mo, allocationIds: [] });
        vendorAllocationsByMo.get(mo.id).allocationIds.push(allocation.id);
        continue;
      }
      let qtyToAssign = number(allocation.plannedQty);
      for (const mo of candidateMos) {
        if (qtyToAssign <= 0.000001) break;
        const remainingKey = `${mo.id}|${mbomProcessId}`;
        const workOrder = (mo.workOrders || []).find((wo) => wo.mbomProcessId === mbomProcessId)
          || (mo.workOrders || []).find((wo) => !wo.mbomProcessId && wo.processId === processId) || null;
        if (!remainingByMoProcess.has(remainingKey)) {
          const executionTargetQty = workOrder ? number(workOrder.plannedQty) : number(mo.qtyPlanned);
          remainingByMoProcess.set(
            remainingKey,
            Math.max(executionTargetQty - number(committedByMoProcess.get(remainingKey)), 0),
          );
        }
        const available = number(remainingByMoProcess.get(remainingKey));
        if (available <= 0) continue;
        const assignedQty = normalizeQuantity(Math.min(qtyToAssign, available), canonicalUomCode(allocation.uomCode, mo.uomCode));
        if (!workOrder && String(allocation.routingMode || "INHOUSE").toUpperCase() !== "VENDOR") {
          publishBlockers.push({
            allocationId: allocation.id,
            moNumber: mo.moNumber,
            processCode: allocation.mbomProcess?.process?.processCode || null,
            reason: "WORK_ORDER_REFERENCE_MISSING",
          });
          qtyToAssign = 0;
          break;
        }
        desired.push({ allocation, mo, workOrder, processId, mbomProcessId, assignedQty });
        remainingByMoProcess.set(remainingKey, available - assignedQty);
        qtyToAssign -= assignedQty;
      }
      if (qtyToAssign > 0.000001) {
        publishBlockers.push({
          allocationId: allocation.id,
          lineNumber: allocation.lineNumber,
          remainingQty: qtyToAssign,
          reason: "MO_QTY_NOT_AVAILABLE",
        });
      }
    }
    if (publishBlockers.length) {
      return res.status(409).json({
        message: "Draft allocation belum dapat dipublikasikan karena MO/WO reference atau sisa qty belum mencukupi.",
        code: "ALLOCATION_PUBLISH_BLOCKED",
        blockers: publishBlockers,
      });
    }

    const releaseDateKey = (value) => new Date(value).toISOString().slice(0, 10);
    const workCenterMachineIds = [...new Set(desired.flatMap((item) =>
      (item.allocation.mbomProcess?.routingOperation?.workCenter?.machines || [])
        .map((row) => row.machineId)
        .filter(Boolean)))];
    const releaseDates = [...new Map(desired.map((item) => {
      const value = new Date(item.allocation.scheduleDate);
      return [releaseDateKey(value), value];
    })).values()];
    const releaseStart = releaseDates.length ? new Date(Math.min(...releaseDates.map((value) => value.getTime()))) : null;
    const releaseEndExclusive = releaseDates.length ? new Date(Math.max(...releaseDates.map((value) => value.getTime()))) : null;
    if (releaseStart) releaseStart.setUTCHours(0, 0, 0, 0);
    if (releaseEndExclusive) {
      releaseEndExclusive.setUTCHours(0, 0, 0, 0);
      releaseEndExclusive.setUTCDate(releaseEndExclusive.getUTCDate() + 1);
    }
    const [planDayOverrides, globalDayOverrides] = workCenterMachineIds.length && releaseDates.length
      ? await Promise.all([
        prisma.capacityDayOverride.findMany({
          where: {
            planId: plan.id,
            machineId: { in: workCenterMachineIds },
            scheduleDate: { gte: releaseStart, lt: releaseEndExclusive },
            isDeleted: false,
          },
          select: { machineId: true, scheduleDate: true, dayStatus: true, shiftsPerDay: true },
        }),
        prisma.capacityCalendarOverride.findMany({
          where: {
            machineId: { in: workCenterMachineIds },
            scheduleDate: { gte: releaseStart, lt: releaseEndExclusive },
            isDeleted: false,
          },
          select: { machineId: true, scheduleDate: true, dayStatus: true, shiftsPerDay: true },
        }),
      ])
      : [[], []];
    const overrideMap = (rows) => new Map(rows.map((row) => [
      `${row.machineId}|${releaseDateKey(row.scheduleDate)}`,
      row,
    ]));
    const planOverrideByMachineDay = overrideMap(planDayOverrides);
    const globalOverrideByMachineDay = overrideMap(globalDayOverrides);
    const machineAvailableForRelease = (machineId, scheduleDate) => {
      const key = `${machineId}|${releaseDateKey(scheduleDate)}`;
      const override = planOverrideByMachineDay.get(key) || globalOverrideByMachineDay.get(key);
      if (!override) return true;
      return String(override.dayStatus || "WORKING").toUpperCase() !== "HOLIDAY"
        && !(override.shiftsPerDay != null && number(override.shiftsPerDay) <= 0);
    };

    const dailyReleaseSchedule = await scheduleDailyReleaseAllocations(desired.map((item) => {
      const workCenterMachines = item.allocation.mbomProcess?.routingOperation?.workCenter?.machines || [];
      const eligibleMachineIds = workCenterMachines.length ? workCenterMachines
        .filter((row) => !row.machine?.isDeleted && String(row.machine?.status || "Active").toUpperCase() === "ACTIVE")
        .filter((row) => machineAvailableForRelease(row.machineId, item.allocation.scheduleDate))
        .map((row) => row.machineId)
        .filter(Boolean) : undefined;
      return {
        ...item,
        id: item.allocation.id,
        scheduleDate: item.allocation.scheduleDate,
        machineId: item.allocation.machineId,
        eligibleMachineIds,
        workCenterId: item.allocation.mbomProcess?.routingOperation?.workCenterId || null,
        partCode: item.workOrder?.outputPartCode
          || item.allocation.mbomProcess?.mbomDetail?.part?.partCode
          || item.mo.part?.partCode
          || null,
        sequence: number(item.allocation.mbomProcess?.sequence),
        predecessorAllocationIds: item.allocation.predecessorAllocationIds || [],
        plannedStartTime: item.allocation.plannedStartTime || null,
        plannedEndTime: item.allocation.plannedEndTime || null,
        plannedQty: item.assignedQty,
      };
    }), {
      prisma,
      dayStart: "07:00",
      dependencyGapMinutes: 120,
      defaultDurationMinutes: 60,
      referenceType: "MONTHLY_PLAN_DAILY_RELEASE",
      referenceNumber: plan.planNumber,
      actor: req.user?.username || req.user?.email || "system",
    });

    const published = await prisma.$transaction(async (tx) => {
      const rows = [];
      for (const item of dailyReleaseSchedule.items) {
        const marker = `[PPIC-MPP-ALLOCATION:${item.allocation.id}:${item.mo.moNumber}]`;
        const scheduleDate = new Date(item.allocation.scheduleDate);
        rows.push(await tx.dailyProductionSchedule.create({
          data: {
            scheduleNumber: await nextDailyPlanNumber(tx, scheduleDate),
            scheduleDate,
            shift: executionShift(item.allocation.shift),
            plannedStartTime: item.plannedStartTime || null,
            plannedEndTime: item.plannedEndTime || null,
            moId: item.mo.id,
            moNumber: item.mo.moNumber,
            woId: item.workOrder?.id || null,
            woNumber: item.workOrder?.woNumber || null,
            // A Daily Production Plan represents one routing operation, not
            // the parent MO receipt. Its item identity must therefore be the
            // operation output (WO for in-house, route detail for vendor).
            // Using the parent FG here creates empty Material Issues and leaves
            // every intermediate WIP lot unconsumed.
            partId: item.workOrder?.outputPartId
              || item.allocation.mbomProcess?.mbomDetail?.partId
              || item.mo.partId,
            partCode: item.workOrder?.outputPartCode
              || item.allocation.mbomProcess?.mbomDetail?.part?.partCode
              || item.mo.part?.partCode
              || null,
            processId: item.processId,
            productionPlanId: plan.id,
            productionPlanAllocationId: item.allocation.id,
            mbomProcessId: item.mbomProcessId,
            machineId: item.allocation.routingMode === "INHOUSE" ? item.machineId : null,
            diesId: item.allocation.routingMode === "INHOUSE" ? item.allocation.diesId : null,
            vendorId: item.allocation.routingMode === "VENDOR" ? item.allocation.vendorId : null,
            plannedQty: item.assignedQty,
            uomCode: canonicalUomCode(item.allocation.uomCode, item.mo.uomCode),
            sequence: number(item.allocation.mbomProcess?.sequence),
            deliveryPhaseId: item.allocation.deliveryPhaseId || null,
            deliveryPhaseNumber: item.allocation.deliveryPhaseNumber || null,
            transferBatchNumber: item.allocation.transferBatchNumber || null,
            predecessorAllocationIds: item.allocation.predecessorAllocationIds || null,
            demandSourceType: item.allocation.demandSourceType || null,
            demandSourceNumber: item.allocation.demandSourceNumber || null,
            customerCode: item.allocation.customerCode || null,
            customerTargetDate: item.allocation.customerTargetDate || null,
            fgRequiredDate: item.allocation.fgRequiredDate || null,
            priorityScore: item.allocation.priorityScore || null,
            priorityClass: item.allocation.priorityClass || null,
            materialReadinessStatus: dailyMaterialDisposition.warnings.length
              ? "WARNING_MATERIAL_SHORTAGE"
              : "READY_AT_DAILY_PUBLISH",
            predecessorStatus: Array.isArray(item.allocation.predecessorAllocationIds) && item.allocation.predecessorAllocationIds.length ? "PLANNED" : "NOT_REQUIRED",
            vendorStatus: item.allocation.routingMode === "VENDOR" ? "PLANNED" : "NOT_REQUIRED",
            lateRisk: item.allocation.fgRequiredDate && scheduleDate > new Date(item.allocation.fgRequiredDate) ? "LATE" : "ON_TIME",
            mrpRunNumber: currentMrp?.runNumber || null,
            mpsNumber: sourceMpsNumber,
            mppNumber: plan.planNumber,
            status: "Draft",
            notes: `${marker} mode ${item.allocation.routingMode}${item.allocation.vendorId ? `; vendor ${item.allocation.vendorId}` : ""}${item.allocation.vendorSendDate ? `; send ${String(item.allocation.vendorSendDate).slice(0, 10)}` : ""}${item.allocation.vendorReturnDate ? `; return ${String(item.allocation.vendorReturnDate).slice(0, 10)}` : ""}${item.allocation.expectedReturnQty != null ? `; expected return ${item.allocation.expectedReturnQty}` : ""}${item.allocation.notes ? `; ${item.allocation.notes}` : ""}`,
            createdBy: req.user?.username || req.user?.email || null,
          },
        }));
      }
      const vendorAllocationIds = [...vendorAllocationsByMo.values()].flatMap((entry) => entry.allocationIds);
      // Clean up unpublished legacy rows made when vendor work was still
      // represented as a Daily Production Schedule.
      if (vendorAllocationIds.length) {
        await tx.dailyProductionSchedule.updateMany({
          where: {
            productionPlanAllocationId: { in: vendorAllocationIds },
            shift: "VENDOR",
            status: "Draft",
            isDeleted: false,
          },
          data: { status: "Cancelled", isDeleted: true },
        });
      }
      await tx.productionPlanAllocation.updateMany({
        where: { id: { in: draftAllocations.map((row) => row.id) }, status: "Draft", isDeleted: false },
        data: {
          status: "Published",
          publishedAt: new Date(),
          publishedBy: req.user?.username || req.user?.email || null,
        },
      });
      let vendorProcessOrderCount = 0;
      for (const { mo, allocationIds } of vendorAllocationsByMo.values()) {
        const generated = await generateVendorProcessOrdersFromRouting(tx, mo, {
          createdBy: req.user?.username || req.user?.email || null,
          capacityAllocationIds: allocationIds,
        });
        vendorProcessOrderCount += generated.created.length;
      }
      return { rows, vendorProcessOrderCount };
    });
    return res.status(201).json({
      planNumber: plan.planNumber,
      items: published.rows,
      total: published.rows.length,
      summary: {
        createdCount: published.rows.length,
        vendorProcessOrderCount: published.vendorProcessOrderCount,
        generatedWorkOrderCount: generatedWorkOrders.length,
        publishedAllocationCount: draftAllocations.length,
        updatedCount: 0,
      },
      ownership: {
        planner: "PPIC",
        source: "Manual MPP Allocation",
        executor: "Production",
      },
      materialReadiness: dailyMaterialReadiness,
      warnings: [...dailyMaterialDisposition.warnings, ...dailyReleaseSchedule.warnings],
    });
    }

    const capacity = await buildCapacitySnapshot(prisma, {
      ...(req.body || {}),
      planNumber: plan.planNumber,
      startDate: plan.periodStart,
      endDate: capacityHorizonEnd(plan),
      ignoreDraftDailyPlans: true,
    });
    if (!capacity.readiness.ok) {
      return res.status(409).json({
        message: "Daily Production Plan belum dapat dibuat karena Capacity Check masih mempunyai blocker routing, mesin, atau cycle time.",
        code: "CAPACITY_BLOCKING",
        capacity: {
          summary: capacity.summary,
          readiness: capacity.readiness,
          unscheduled: capacity.unscheduled,
        },
      });
    }

    const unscheduled = (capacity.unscheduled || []).filter((row) => row.source === "PROPOSED" && row.reference === plan.planNumber);
    const unscheduledNotices = capacityUnscheduledNotices(capacity, plan.planNumber);

    const rawAllocations = [];
    for (const machine of capacity.machines || []) {
      for (const [scheduleDate, cell] of Object.entries(machine.cells || {})) {
        for (const item of cell.items || []) {
          if (item.source !== "PROPOSED" || item.reference !== plan.planNumber || number(item.qty) <= 0 || !item.mbomProcessId) continue;
          const itemUom = item.uomCode || null;
          rawAllocations.push({
            ...item,
            scheduleDate,
            shift: String(item.shift || "1"),
            qty: normalizeQuantity(item.qty, itemUom),
            minutes: number(item.minutes),
            machineId: machine.id,
            routingMode: "INHOUSE",
          });
        }
      }
    }
    // Vendor assignments are executed as Vendor Process Orders. They remain
    // in Capacity Planning for date/sequence planning, but never become DPP.
    rawAllocations.sort((left, right) =>
      String(left.scheduleDate).localeCompare(String(right.scheduleDate))
      || number(left.sequence) - number(right.sequence)
      || String(left.shift).localeCompare(String(right.shift), undefined, { numeric: true }));

    if (!rawAllocations.length) {
      return res.status(409).json({
        message: "Capacity Check belum menghasilkan allocation harian in-house. Proses vendor tersedia di Prepare Delivery to Vendor.",
        code: "NO_DAILY_CAPACITY_ALLOCATION",
        capacity: { summary: capacity.summary, readiness: capacity.readiness, unscheduled },
      });
    }

    const lineNumbers = [...new Set(rawAllocations.map((row) => number(row.lineNumber)).filter(Boolean))];
    const routeIds = [...new Set(rawAllocations.map((row) => row.mbomProcessId).filter(Boolean))];
    const [manufacturingOrders, routes] = await Promise.all([
      prisma.manufacturingOrder.findMany({
        where: {
          monthlyProductionPlanNumber: plan.planNumber,
          isDeleted: false,
          status: { not: "Cancelled" },
        },
        include: {
          part: { select: { id: true, partCode: true } },
          workOrders: {
            where: { isDeleted: false, status: { not: "Cancelled" } },
            select: { id: true, woNumber: true, mbomProcessId: true, processId: true, sequence: true, machineId: true, plannedQty: true },
            orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
          },
        },
        orderBy: [{ monthlyProductionPlanLineNumber: "asc" }, { createdAt: "asc" }],
      }),
      prisma.mBOMProcess.findMany({
        where: { id: { in: routeIds }, isDeleted: false },
        select: { id: true, occurrenceCode: true, processId: true, sequence: true },
      }),
    ]);
    if (!manufacturingOrders.length) {
      return res.status(409).json({
        message: "Belum ada MO reference dari Monthly Production Plan. Buat/release MO dari PPIC terlebih dahulu.",
        code: "MO_REFERENCE_REQUIRED",
      });
    }

    const routeById = new Map(routes.map((row) => [row.id, row]));
    const mosByLine = new Map();
    for (const mo of manufacturingOrders) {
      const key = number(mo.monthlyProductionPlanLineNumber);
      if (!mosByLine.has(key)) mosByLine.set(key, []);
      mosByLine.get(key).push(mo);
    }
    const parentMOs = mosByLine.get(1) || [];
    const mosForLine = (lineNumber) => {
      const direct = mosByLine.get(number(lineNumber)) || [];
      // A process/WIP MPP line is executed by the FG parent MO's routing.
      // Falling back to that MO prevents invalid child MOs without an MBOM
      // and keeps the daily plan linked to the actual production order.
      return direct.length ? direct : parentMOs;
    };
    const missingMoLines = [...new Set(rawAllocations
      .map((row) => number(row.lineNumber))
      .filter((lineNumber) => !mosForLine(lineNumber).length))];

    const markerPrefix = `[PPIC-DPP:${plan.planNumber}:`;
    const moIds = manufacturingOrders.map((row) => row.id);
    const existingSchedules = await prisma.dailyProductionSchedule.findMany({
      where: {
        isDeleted: false,
        moId: { in: moIds },
        OR: [
          { notes: { contains: markerPrefix } },
          { status: { notIn: ["Draft", "Cancelled"] } },
        ],
      },
      orderBy: [{ scheduleDate: "asc" }, { shift: "asc" }, { sequence: "asc" }],
    });
    const committedByMoRoute = new Map();
    for (const row of existingSchedules.filter((item) => item.status !== "Draft" && item.status !== "Cancelled" && (item.mbomProcessId || item.processId))) {
      const key = `${row.moId}|${row.mbomProcessId || `PROCESS:${row.processId}`}`;
      committedByMoRoute.set(key, number(committedByMoRoute.get(key)) + number(row.plannedQty));
    }
    const remainingByMoRoute = new Map();
    const desired = [];
    const capacitySkipped = [];

    for (const allocation of rawAllocations) {
      const route = routeById.get(allocation.mbomProcessId);
      if (!route?.processId) {
        capacitySkipped.push({ ...allocation, reason: "ROUTING_PROCESS_REFERENCE_MISSING" });
        continue;
      }
      let qtyToAssign = number(allocation.qty);
      for (const mo of mosForLine(number(allocation.lineNumber))) {
        const remainingKey = `${mo.id}|${route.id}`;
        const workOrder = findRouteWorkOrder(mo.workOrders || [], route);
        if (!remainingByMoRoute.has(remainingKey)) {
          const executionTargetQty = workOrder ? number(workOrder.plannedQty) : number(mo.qtyPlanned);
          remainingByMoRoute.set(
            remainingKey,
            Math.max(executionTargetQty - number(committedByMoRoute.get(remainingKey)), 0),
          );
        }
        const availableForMo = number(remainingByMoRoute.get(remainingKey));
        if (availableForMo <= 0 || qtyToAssign <= 0) continue;
        const allocationUomCode = canonicalUomCode(allocation.uomCode, mo.uomCode);
        const assignedQty = isDiscreteUom(allocationUomCode)
          ? Math.min(Math.round(qtyToAssign), Math.round(availableForMo))
          : Math.min(qtyToAssign, availableForMo);
        desired.push({
          ...allocation,
          processId: route.processId,
          sequence: number(allocation.sequence || route.sequence),
          qty: assignedQty,
          mo,
          workOrder,
        });
        remainingByMoRoute.set(remainingKey, availableForMo - assignedQty);
        qtyToAssign -= assignedQty;
      }
      if (qtyToAssign > 0.000001) capacitySkipped.push({ ...allocation, qty: qtyToAssign, reason: "MO_RELEASE_QTY_NOT_AVAILABLE" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const draftRows = existingSchedules.filter((row) => row.status === "Draft" && String(row.notes || "").includes(markerPrefix));
      const draftByMarker = new Map(draftRows.map((row) => [String(row.notes || "").match(/\[PPIC-DPP:[^\]]+\]/)?.[0], row]).filter(([marker]) => marker));
      const retainedDraftIds = new Set();
      const rows = [];
      let createdCount = 0;
      let updatedCount = 0;

      for (const allocation of desired) {
        const marker = dailyPlanMarker(plan.planNumber, allocation, allocation.mo.moNumber);
        const existing = draftByMarker.get(marker);
        const scheduleDate = new Date(`${allocation.scheduleDate}T00:00:00.000Z`);
        const data = {
          scheduleDate,
          shift: executionShift(allocation.shift),
          plannedStartTime: allocation.plannedStartTime || null,
          plannedEndTime: allocation.plannedEndTime || null,
          moId: allocation.mo.id,
          moNumber: allocation.mo.moNumber,
          woId: allocation.workOrder?.id || null,
          woNumber: allocation.workOrder?.woNumber || null,
          partId: allocation.mo.partId || null,
          partCode: allocation.partCode || allocation.mo.part?.partCode || null,
          processId: allocation.processId,
          machineId: allocation.routingMode === "INHOUSE" ? allocation.machineId : null,
          diesId: allocation.routingMode === "INHOUSE" ? allocation.diesId || null : null,
          plannedQty: normalizeQuantity(allocation.qty, canonicalUomCode(allocation.uomCode, allocation.mo.uomCode)),
          uomCode: canonicalUomCode(allocation.uomCode, allocation.mo.uomCode),
          sequence: number(allocation.sequence),
          deliveryPhaseId: allocation.deliveryPhaseId || null,
          deliveryPhaseNumber: allocation.deliveryPhaseNumber || null,
          transferBatchNumber: allocation.transferBatchNumber || null,
          predecessorAllocationIds: allocation.predecessorAllocationIds || null,
          status: "Draft",
          notes: `${marker} Capacity ${number(allocation.minutes)} min; mode ${allocation.routingMode}${allocation.vendorId ? `; vendor ${allocation.vendorId}` : ""}${allocation.vendorSendDate ? `; send ${String(allocation.vendorSendDate).slice(0, 10)}` : ""}${allocation.vendorReturnDate ? `; return ${String(allocation.vendorReturnDate).slice(0, 10)}` : ""}${allocation.expectedReturnQty != null ? `; expected return ${allocation.expectedReturnQty}` : ""}${allocation.diesId ? `; dies ${allocation.diesId}` : ""}.`,
          createdBy: req.user?.username || req.user?.email || null,
        };
        if (existing) {
          retainedDraftIds.add(existing.id);
          rows.push(await tx.dailyProductionSchedule.update({ where: { id: existing.id }, data }));
          updatedCount += 1;
        } else {
          rows.push(await tx.dailyProductionSchedule.create({
            data: { scheduleNumber: await nextDailyPlanNumber(tx, scheduleDate), ...data },
          }));
          createdCount += 1;
        }
      }

      const staleIds = draftRows.filter((row) => !retainedDraftIds.has(row.id)).map((row) => row.id);
      if (staleIds.length) {
        await tx.dailyProductionSchedule.updateMany({
          where: { id: { in: staleIds } },
          data: { isDeleted: true, status: "Cancelled" },
        });
      }
      return { rows, createdCount, updatedCount, cancelledCount: staleIds.length };
    });

    const revisionDates = [...new Set(result.rows.map((row) => dateOnly(row.scheduleDate)?.toISOString().slice(0, 10)).filter(Boolean))];
    const revisions = [];
    for (const date of revisionDates) {
      revisions.push(await dailyPlanRevisionService.createDraft({
        date,
        sourcePlanNumber: plan.planNumber,
        userId: req.user?.username || req.user?.email || null,
      }));
    }

    res.status(result.createdCount ? 201 : 200).json({
      planNumber: plan.planNumber,
      ownership: {
        planner: "PPIC",
        source: "Monthly Production Plan + Capacity Check",
        executor: "Production",
      },
      items: result.rows,
      total: result.rows.length,
      revisions: revisions.map((revision) => ({ id: revision.id, revisionNumber: revision.revisionNumber, planDate: revision.planDate, status: revision.status, version: revision.version })),
      summary: {
        createdCount: result.createdCount,
        updatedCount: result.updatedCount,
        cancelledDraftCount: result.cancelledCount,
        unscheduledCount: unscheduled.length,
        skippedCapacityCount: capacitySkipped.length,
        missingMoLineCount: missingMoLines.length,
      },
      warnings: {
        unscheduled,
        missingMoLines,
        capacitySkipped,
      },
      notices: unscheduledNotices,
      capacity: {
        parameters: capacity.parameters,
        summary: capacity.summary,
        readiness: capacity.readiness,
      },
    });
  } catch (error) { next(error); }
};

// Persist PPIC's date/shift/qty decision before MPP release. This draft
// allocation deliberately has no MO/WO dependency; it is published to Daily
// Production Plan only after release has created the production references.
exports.createManualDailyPlan = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber: req.params.planNumber, isDeleted: false },
      include,
    });
    if (!plan) return res.status(404).json({ message: "Production Plan tidak ditemukan." });
    if (!["Draft", "Confirmed", "Released", "In Progress"].includes(plan.status)) {
      return res.status(409).json({ message: `MPP berstatus ${plan.status} tidak dapat menerima alokasi produksi baru.` });
    }
    const lineNumber = Number(req.body?.lineNumber);
    const planningMode = String(req.body?.planningMode || "PRODUCTION").toUpperCase() === "SIMULATION" ? "SIMULATION" : "PRODUCTION";
    const scenarioKey = planningMode === "SIMULATION" ? String(req.body?.scenarioKey || "").trim().toLowerCase() : null;
    const mbomProcessId = text(req.body?.mbomProcessId);
    const routingMode = String(req.body?.routingMode || "INHOUSE").toUpperCase();
    const scheduleDate = dateOnly(routingMode === "VENDOR"
      ? (req.body?.vendorSendDate || req.body?.scheduleDate)
      : req.body?.scheduleDate);
    const shift = routingMode === "VENDOR" ? "VENDOR" : String(req.body?.shift || "1");
    const plannedQty = number(req.body?.plannedQty);
    const plannedStartTime = routingMode === "INHOUSE" ? text(req.body?.plannedStartTime) : null;
    const plannedEndTime = routingMode === "INHOUSE" ? text(req.body?.plannedEndTime) : null;
    const machineId = text(req.body?.machineId);
    const requestedDiesId = text(req.body?.diesId);
    const vendorId = text(req.body?.vendorId);
    const vendorReturnDate = routingMode === "VENDOR" ? dateOnly(req.body?.vendorReturnDate) : null;
    const expectedReturnQtyInput = req.body?.expectedReturnQty == null
      ? plannedQty
      : number(req.body.expectedReturnQty);
    const notes = text(req.body?.notes);
    if (!Number.isInteger(lineNumber) || lineNumber < 1 || !mbomProcessId || !scheduleDate || plannedQty <= 0) {
      return res.status(400).json({ message: "Line, routing process, tanggal, dan qty alokasi wajib diisi." });
    }
    if ((plannedStartTime || plannedEndTime) && (!/^\d{2}:\d{2}$/.test(plannedStartTime || "") || !/^\d{2}:\d{2}$/.test(plannedEndTime || ""))) {
      return res.status(400).json({ message: "Jam mulai dan selesai harus diisi lengkap dalam format HH:mm." });
    }
    if (planningMode === "SIMULATION" && !/^preset-[a-z0-9-]{8,}$/i.test(scenarioKey || "")) return res.status(400).json({ message: "Simulation allocation harus memakai preset bulanan yang tersimpan." });
    if (planningMode === "SIMULATION" && !(await findPreset(prisma, scenarioKey))) return res.status(404).json({ message: "Preset simulasi tidak ditemukan." });
    if (scheduleDate < plan.periodStart || scheduleDate > plan.periodEnd) {
      return res.status(400).json({ message: "Tanggal alokasi harus berada dalam periode MPP." });
    }
    const freezeOverrideReason = requireFreezeOverride(plan, scheduleDate, planningMode, req.body);
    if (!["INHOUSE", "VENDOR"].includes(routingMode) || (routingMode === "INHOUSE" && (!machineId || !["1", "2", "3"].includes(shift))) || (routingMode === "VENDOR" && !vendorId)) {
      return res.status(400).json({ message: "Pilih shift dan mesin untuk in-house, atau vendor untuk proses vendor." });
    }
    if (routingMode === "VENDOR" && (!vendorReturnDate || vendorReturnDate < scheduleDate)) {
      return res.status(400).json({ message: "Tanggal kembali vendor wajib diisi dan tidak boleh sebelum tanggal kirim." });
    }
    if (routingMode === "VENDOR" && expectedReturnQtyInput <= 0) {
      return res.status(400).json({ message: "Qty ekspektasi kembali vendor harus lebih dari nol." });
    }
    const line = plan.details.find((row) => Number(row.lineNumber) === lineNumber && !row.isDeleted);
    if (!line) return res.status(404).json({ message: "Line Production Plan tidak ditemukan." });
    const route = await prisma.mBOMProcess.findFirst({
      where: { id: mbomProcessId, isDeleted: false },
      include: {
        mbomDetail: { select: { partId: true, part: { select: { partCode: true } } } },
        process: { select: { processCode: true, processName: true } },
      },
    });
    if (!route || (line.partId && route.mbomDetail?.partId !== line.partId) || (!line.partId && route.mbomDetail?.part?.partCode !== line.partCode)) {
      return res.status(409).json({ message: "Routing process tidak sesuai dengan line Production Plan." });
    }
    if (!route.processId) return res.status(409).json({ message: "Routing belum mempunyai reference process." });
    let selectedVendor = null;
    let selectedDies = null;
    if (routingMode === "INHOUSE") {
      const selectedMachine = await prisma.machine.findFirst({ where: { id: machineId, isDeleted: false, status: "Active" } });
      const requiredSpecification = route.machineSpecificationCode || (route.machineId ? (await prisma.machine.findUnique({ where: { id: route.machineId }, select: { machineSpecificationCode: true } }))?.machineSpecificationCode : null);
      if (!selectedMachine) {
        return res.status(409).json({ message: "Mesin tidak aktif atau tidak ditemukan." });
      }
      if (!requiredSpecification || selectedMachine.machineSpecificationCode !== requiredSpecification) return res.status(409).json({ message: "Mesin tidak memenuhi Machine Specification routing BOM." });
      selectedDies = (await resolveDiesAssignment(prisma, {
        route,
        machine: selectedMachine,
        diesId: requestedDiesId,
        scheduleDate,
        plannedStartTime,
        plannedEndTime,
      })).dies;
    } else {
      selectedVendor = await prisma.vendor.findFirst({
        where: { id: vendorId, isDeleted: false, status: "Active" },
        select: { id: true, vendorCode: true, vendorName: true, leadTimeDays: true },
      });
      if (!selectedVendor) return res.status(409).json({ message: "Vendor tidak aktif atau tidak ditemukan." });
    }

    const allocated = await prisma.productionPlanAllocation.aggregate({
      where: {
        planId: plan.id,
        lineNumber,
        mbomProcessId,
        isDeleted: false,
        status: { in: ["Draft", "Published"] },
        planningMode,
        ...(planningMode === "SIMULATION" ? { scenarioKey } : {}),
      },
      _sum: { plannedQty: true },
    });
    const normalizedQty = normalizeQuantity(plannedQty, line.uomCode);
    const expectedReturnQty = routingMode === "VENDOR"
      ? normalizeQuantity(expectedReturnQtyInput, line.uomCode)
      : null;
    if (routingMode === "VENDOR" && expectedReturnQty > normalizedQty + 0.000001) {
      return res.status(409).json({ message: "Qty ekspektasi kembali tidak boleh melebihi qty yang dikirim ke vendor." });
    }
    const remainingQty = Math.max(number(line.qtyPlanned) - number(allocated._sum.plannedQty), 0);
    if (normalizedQty > remainingQty + 0.000001) {
      return res.status(409).json({ message: `Qty alokasi melebihi sisa MPP untuk proses ini. Sisa tersedia ${remainingQty} ${line.uomCode || ""}.` });
    }

    const allocation = await prisma.productionPlanAllocation.create({
      data: {
        planId: plan.id,
        lineNumber,
        mbomProcessId,
        scheduleDate,
        shift,
        plannedStartTime,
        plannedEndTime,
        machineId: routingMode === "INHOUSE" ? machineId : null,
        diesId: routingMode === "INHOUSE" ? selectedDies?.id || null : null,
        routingMode,
        vendorId: routingMode === "VENDOR" ? vendorId : null,
        vendorSendDate: routingMode === "VENDOR" ? scheduleDate : null,
        vendorReturnDate,
        vendorLeadTimeDays: routingMode === "VENDOR"
          ? Math.max(number(selectedVendor?.leadTimeDays), 0)
          : null,
        expectedReturnQty,
        plannedQty: normalizedQty,
        uomCode: line.uomCode || null,
        status: "Draft",
        planningMode,
        scenarioKey,
        demandSourceType: line.deliveryPhaseId ? "DELIVERY_PHASE" : null,
        customerCode: line.customerCode || null,
        customerTargetDate: line.customerTargetDate || null,
        fgRequiredDate: line.fgRequiredDate || null,
        priorityScore: line.priorityScore || null,
        priorityClass: line.priorityClass || null,
        latestStartDate: line.latestStartDate || null,
        latestFinishDate: line.latestFinishDate || null,
        capacityLate: Boolean(line.fgRequiredDate && (vendorReturnDate || scheduleDate) > dateOnly(line.fgRequiredDate)),
        lateConstraintCode: line.fgRequiredDate && (vendorReturnDate || scheduleDate) > dateOnly(line.fgRequiredDate) ? "CAPACITY_LATE" : null,
        notes: [notes, freezeOverrideReason ? `[FREEZE-OVERRIDE] ${freezeOverrideReason}` : null].filter(Boolean).join("; ") || null,
        createdBy: req.user?.username || req.user?.email || null,
      },
    });
    const vendorProcessPr = planningMode === "PRODUCTION"
      ? await prisma.$transaction((tx) => syncVendorProcessDraftPrForPlan(tx, plan.id, req.user?.username || req.user?.email || "system"))
      : null;
    res.status(201).json({
      planNumber: plan.planNumber,
      planningMode,
      scenarioKey,
      allocation,
      vendorProcessPr,
      summary: {
        createdCount: 1,
        plannedQty: normalizedQty,
        remainingQty: normalizeQuantity(remainingQty - normalizedQty, line.uomCode),
        ...(routingMode === "INHOUSE" && selectedDies ? {
          dies: { id: selectedDies.id, diesCode: selectedDies.diesCode, diesName: selectedDies.diesName },
        } : {}),
        ...(routingMode === "VENDOR" ? {
          vendorSchedule: {
            vendorCode: selectedVendor.vendorCode,
            sendDate: scheduleDate,
            returnDate: vendorReturnDate,
            plannedLeadTimeDays: calendarDaysBetween(scheduleDate, vendorReturnDate),
            masterLeadTimeDays: number(selectedVendor.leadTimeDays),
            expectedReturnQty,
          },
        } : {}),
      },
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

exports.updateManualAllocation = async (req, res, next) => {
  try {
    const allocation = await prisma.productionPlanAllocation.findFirst({
      where: { id: req.params.allocationId, isDeleted: false },
      include: {
        plan: { include: { details: { where: { isDeleted: false, status: { not: "Cancelled" } } } } },
        mbomProcess: {
          include: {
            machine: { select: { machineSpecificationCode: true } },
            process: { select: { processCode: true, processName: true } },
            mbomDetail: { select: { partId: true } },
          },
        },
      },
    });
    if (!allocation || allocation.plan.planNumber !== req.params.planNumber) return res.status(404).json({ message: "Draft allocation tidak ditemukan." });
    if (allocation.status !== "Draft") return res.status(409).json({ message: "Hanya allocation Draft yang dapat diedit." });
    const routingMode = String(req.body?.routingMode || allocation.routingMode || "INHOUSE").toUpperCase();
    const scheduleDate = dateOnly(routingMode === "VENDOR" ? (req.body?.vendorSendDate || req.body?.scheduleDate) : req.body?.scheduleDate);
    const vendorReturnDate = routingMode === "VENDOR" ? dateOnly(req.body?.vendorReturnDate) : null;
    const plannedQty = normalizeQuantity(req.body?.plannedQty, allocation.uomCode);
    const expectedReturnQty = routingMode === "VENDOR" ? normalizeQuantity(req.body?.expectedReturnQty ?? plannedQty, allocation.uomCode) : null;
    const shift = routingMode === "VENDOR" ? "VENDOR" : String(req.body?.shift || allocation.shift || "1");
    const plannedStartTime = routingMode === "INHOUSE" ? text(req.body?.plannedStartTime) : null;
    const plannedEndTime = routingMode === "INHOUSE" ? text(req.body?.plannedEndTime) : null;
    const machineId = text(req.body?.machineId);
    const requestedDiesId = text(req.body?.diesId);
    const vendorId = text(req.body?.vendorId);
    if (!scheduleDate || plannedQty <= 0) return res.status(400).json({ message: "Tanggal dan qty allocation wajib diisi." });
    if ((plannedStartTime || plannedEndTime) && (!/^\d{2}:\d{2}$/.test(plannedStartTime || "") || !/^\d{2}:\d{2}$/.test(plannedEndTime || ""))) {
      return res.status(400).json({ message: "Jam mulai dan selesai harus diisi lengkap dalam format HH:mm." });
    }
    const freezeOverrideReason = requireFreezeOverride(allocation.plan, scheduleDate, allocation.planningMode, req.body);
    const schedulingHorizonEnd = capacityHorizonEnd(allocation.plan);
    if (scheduleDate < allocation.plan.periodStart || scheduleDate > schedulingHorizonEnd) return res.status(400).json({ message: "Tanggal allocation harus berada dalam horizon MPP sampai required date terakhir." });
    if (routingMode === "INHOUSE" && (!machineId || !["1", "2", "3"].includes(shift))) return res.status(400).json({ message: "Mesin dan shift wajib dipilih." });
    if (routingMode === "VENDOR" && (!vendorId || !vendorReturnDate || vendorReturnDate < scheduleDate || vendorReturnDate > schedulingHorizonEnd)) return res.status(400).json({ message: "Vendor, tanggal kirim, dan tanggal kembali wajib valid serta berada dalam horizon MPP." });
    if (routingMode === "VENDOR" && (expectedReturnQty <= 0 || expectedReturnQty > plannedQty + 0.000001)) return res.status(400).json({ message: "Qty kembali vendor harus lebih dari nol dan tidak melebihi qty kirim." });
    let selectedVendor = null;
    let selectedDies = null;
    if (routingMode === "INHOUSE") {
      const machine = await prisma.machine.findFirst({ where: { id: machineId, isDeleted: false, status: "Active" } });
      const requiredSpecification = allocation.mbomProcess.machineSpecificationCode || allocation.mbomProcess.machine?.machineSpecificationCode;
      if (!machine || !requiredSpecification || machine.machineSpecificationCode !== requiredSpecification) return res.status(409).json({ message: "Mesin tidak aktif atau tidak memenuhi Machine Specification routing." });
      selectedDies = (await resolveDiesAssignment(prisma, {
        route: allocation.mbomProcess,
        machine,
        diesId: requestedDiesId || allocation.diesId,
        scheduleDate,
        plannedStartTime,
        plannedEndTime,
        excludeAllocationId: allocation.id,
      })).dies;
    } else {
      selectedVendor = await prisma.vendor.findFirst({ where: { id: vendorId, isDeleted: false, status: "Active" }, select: { id: true, leadTimeDays: true } });
      if (!selectedVendor) return res.status(409).json({ message: "Vendor tidak aktif atau tidak ditemukan." });
    }
    const line = allocation.plan.details.find((row) => Number(row.lineNumber) === Number(allocation.lineNumber));
    if (!line) return res.status(409).json({ message: "Line MPP allocation sudah tidak tersedia." });
    const other = await prisma.productionPlanAllocation.aggregate({
      where: {
        id: { not: allocation.id }, planId: allocation.planId, lineNumber: allocation.lineNumber,
        mbomProcessId: allocation.mbomProcessId, planningMode: allocation.planningMode,
        ...(allocation.planningMode === "SIMULATION" ? { scenarioKey: allocation.scenarioKey } : {}),
        isDeleted: false, status: { in: ["Draft", "Published"] },
      },
      _sum: { plannedQty: true },
    });
    const remainingQty = Math.max(number(line.qtyPlanned) - number(other._sum.plannedQty), 0);
    if (plannedQty > remainingQty + 0.000001) return res.status(409).json({ message: `Qty edit melebihi sisa MPP ${remainingQty} ${allocation.uomCode || ""}.` });
    const updated = await prisma.productionPlanAllocation.update({
      where: { id: allocation.id },
      data: {
        scheduleDate, shift, plannedStartTime, plannedEndTime, plannedQty, routingMode,
        machineId: routingMode === "INHOUSE" ? machineId : null,
        diesId: routingMode === "INHOUSE" ? selectedDies?.id || null : null,
        vendorId: routingMode === "VENDOR" ? vendorId : null,
        vendorSendDate: routingMode === "VENDOR" ? scheduleDate : null,
        vendorReturnDate, vendorLeadTimeDays: routingMode === "VENDOR" ? Math.max(number(selectedVendor?.leadTimeDays), 0) : null,
        capacityLate: Boolean((line.fgRequiredDate || allocation.fgRequiredDate) && (vendorReturnDate || scheduleDate) > dateOnly(line.fgRequiredDate || allocation.fgRequiredDate)),
        lateConstraintCode: (line.fgRequiredDate || allocation.fgRequiredDate) && (vendorReturnDate || scheduleDate) > dateOnly(line.fgRequiredDate || allocation.fgRequiredDate) ? "CAPACITY_LATE" : null,
        expectedReturnQty, notes: [text(req.body?.notes), freezeOverrideReason ? `[FREEZE-OVERRIDE] ${freezeOverrideReason}` : null].filter(Boolean).join("; ") || null,
        allocationSource: "MANUAL",
        recommendationReason: `Posisi diedit manual dari matriks MPP oleh ${req.user?.username || req.user?.email || "system"}.`,
        recommendationScore: null,
        recommendationScoreBreakdown: null,
      },
    });
    const vendorProcessPr = allocation.planningMode === "PRODUCTION"
      ? await prisma.$transaction((tx) => syncVendorProcessDraftPrForPlan(tx, allocation.planId, req.user?.username || req.user?.email || "system"))
      : null;
    res.json({ planNumber: allocation.plan.planNumber, allocation: updated, vendorProcessPr, message: "Allocation berhasil diperbarui." });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message, code: error.code, details: error.details });
    next(error);
  }
};

exports.removeManualAllocation = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber: req.params.planNumber, isDeleted: false },
      select: { id: true, planNumber: true, freezeFenceDays: true },
    });
    if (!plan) return res.status(404).json({ message: "Production Plan tidak ditemukan." });
    const allocation = await prisma.productionPlanAllocation.findFirst({
      where: { id: req.params.allocationId, planId: plan.id, isDeleted: false },
    });
    if (!allocation) return res.status(404).json({ message: "Draft allocation tidak ditemukan." });
    if (allocation.status !== "Draft") {
      return res.status(409).json({ message: "Allocation yang sudah dipublikasikan tidak dapat dihapus dari Capacity Check." });
    }
    requireFreezeOverride(plan, allocation.scheduleDate, allocation.planningMode, req.body);
    const updated = await prisma.productionPlanAllocation.update({
      where: { id: allocation.id },
      data: { status: "Cancelled", isDeleted: true },
    });
    const vendorProcessPr = allocation.planningMode === "PRODUCTION"
      ? await prisma.$transaction((tx) => syncVendorProcessDraftPrForPlan(tx, plan.id, req.user?.username || req.user?.email || "system"))
      : null;
    res.json({ planNumber: plan.planNumber, allocation: updated, vendorProcessPr });
  } catch (error) { next(error); }
};

exports.capacityOverride = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber: req.params.planNumber, isDeleted: false }, include });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan." });
    if (!["Draft", "Confirmed"].includes(plan.status)) return res.status(409).json({ message: "Capacity override hanya dapat dilakukan sebelum release." });
    const reason = String(req.body?.reason || req.body?.notes || "").trim();
    if (reason.length < 10) return res.status(400).json({ message: "Reason override minimal 10 karakter." });
    const updated = await prisma.monthlyProductionPlan.update({ where: { planNumber: plan.planNumber }, data: { capacityOverrideApproved: true, capacityOverrideReason: reason, capacityOverrideBy: req.user?.username || req.user?.email || "system", capacityOverrideAt: new Date() }, include });
    res.json({ ...serialize(updated), capacityOverride: { approved: true, reason } });
  } catch (error) { next(error); }
};

// PPIC may rebalance a plan to a machine alternative defined in the BOM routing.
// This deliberately writes a plan-level assignment, never mutating the MBOM
// default machine used by future plans.
exports.assignCapacityMachine = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber: req.params.planNumber, isDeleted: false }, include });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan." });
    if (!['Draft', 'Confirmed'].includes(plan.status)) return res.status(409).json({ message: "Penggantian mesin hanya dapat dilakukan sebelum Production Plan release." });
    const lineNumber = Number(req.body?.lineNumber);
    const mbomProcessId = text(req.body?.mbomProcessId);
    const machineId = text(req.body?.machineId);
    const diesId = text(req.body?.diesId);
    const vendorId = text(req.body?.vendorId);
    const routingMode = String(req.body?.routingMode || "INHOUSE").toUpperCase();
    const scheduleDate = new Date(`${String(req.body?.scheduleDate || '').slice(0, 10)}T00:00:00.000Z`);
    const reason = String(req.body?.reason || '').trim();
    if (!Number.isInteger(lineNumber) || lineNumber < 1 || !mbomProcessId || Number.isNaN(scheduleDate.getTime())) return res.status(400).json({ message: "Line, routing process, dan tanggal assignment wajib dipilih." });
    assertCapacityDateEditable(scheduleDate);
    if (!["INHOUSE", "VENDOR"].includes(routingMode) || (routingMode === "INHOUSE" && !machineId) || (routingMode === "VENDOR" && !vendorId)) return res.status(400).json({ message: "Pilih mesin untuk INHOUSE atau vendor untuk VENDOR." });
    if (reason.length < 10) return res.status(400).json({ message: "Alasan perpindahan mesin minimal 10 karakter." });
    const line = plan.details.find((item) => Number(item.lineNumber) === lineNumber && !item.isDeleted);
    if (!line) return res.status(404).json({ message: "Detail Production Plan tidak ditemukan." });
    const route = await prisma.mBOMProcess.findFirst({ where: { id: mbomProcessId, isDeleted: false }, include: { mbomDetail: { select: { partId: true, part: { select: { partCode: true } } } } } });
    if (!route || (line.partId && route.mbomDetail?.partId !== line.partId) || (!line.partId && route.mbomDetail?.part?.partCode !== line.partCode)) return res.status(409).json({ message: "Routing process tidak sesuai dengan part pada Production Plan." });
    const legacyMachine = route.machineId ? await prisma.machine.findUnique({ where: { id: route.machineId }, select: { machineSpecificationCode: true } }) : null;
    const requiredSpecification = route.machineSpecificationCode || legacyMachine?.machineSpecificationCode || null;
    const machine = machineId ? await prisma.machine.findFirst({ where: { id: machineId, isDeleted: false, status: 'Active' }, select: { id: true, machineCode: true, machineName: true, machineSpecificationCode: true } }) : null;
    if (routingMode === "INHOUSE" && !machine) return res.status(409).json({ message: "Mesin tidak aktif atau tidak ditemukan." });
    if (routingMode === "INHOUSE" && (!requiredSpecification || machine.machineSpecificationCode !== requiredSpecification)) return res.status(409).json({ message: "Mesin tidak memenuhi Machine Specification routing BOM." });
    if (diesId && !await prisma.dies.findFirst({ where: { id: diesId, isDeleted: false, status: "Active" } })) return res.status(409).json({ message: "Dies/QD tidak aktif atau tidak ditemukan." });
    if (routingMode === "VENDOR" && !await prisma.vendor.findFirst({ where: { id: vendorId, isDeleted: false, status: "Active" } })) return res.status(409).json({ message: "Vendor tidak aktif atau tidak ditemukan." });
    const override = await prisma.capacityMachineOverride.upsert({
      where: { planId_lineNumber_mbomProcessId_scheduleDate: { planId: plan.id, lineNumber, mbomProcessId, scheduleDate } },
      create: { planId: plan.id, lineNumber, mbomProcessId, scheduleDate, machineId: routingMode === "INHOUSE" ? machineId : null, diesId, routingMode, vendorId: routingMode === "VENDOR" ? vendorId : null, reason, changedBy: req.user?.username || req.user?.email || 'system' },
      update: { machineId: routingMode === "INHOUSE" ? machineId : null, diesId, routingMode, vendorId: routingMode === "VENDOR" ? vendorId : null, reason, changedBy: req.user?.username || req.user?.email || 'system', changedAt: new Date(), isDeleted: false },
    });
    res.json({ planNumber: plan.planNumber, lineNumber, mbomProcessId, override: { ...override, machine } });
  } catch (error) { next(error); }
};

function normalizeCapacityShiftOverrides(value, shiftsPerDay) {
  if (!Array.isArray(value)) return undefined;
  if (!Number.isInteger(shiftsPerDay) || value.length !== shiftsPerDay || value.length < 1 || value.length > 3) {
    throw Object.assign(new Error("Jam shift harus lengkap sesuai jumlah shift yang dipilih."), { statusCode: 400 });
  }
  const validTime = /^([01]\d|2[0-3]):[0-5]\d$/;
  const rangeMinutes = (start, end) => {
    const [startHour, startMinute] = start.split(":").map(Number);
    const [endHour, endMinute] = end.split(":").map(Number);
    const startValue = (startHour * 60) + startMinute;
    const endValue = (endHour * 60) + endMinute;
    return endValue >= startValue ? endValue - startValue : endValue + 1440 - startValue;
  };
  return value.map((shift, index) => {
    const startTime = String(shift?.startTime || "");
    const endTime = String(shift?.endTime || "");
    const breakMinutes = Number(shift?.breakMinutes || 0);
    const optionalTime = (field, label) => {
      const raw = shift?.[field];
      if (raw == null || raw === "") return null;
      const value = String(raw);
      if (!validTime.test(value)) throw Object.assign(new Error(`${label} Shift ${index + 1} tidak valid.`), { statusCode: 400 });
      return value;
    };
    const overtimeBeforeStart = optionalTime("overtimeBeforeStart", "Jam mulai lembur awal");
    const overtimeBeforeEnd = optionalTime("overtimeBeforeEnd", "Jam selesai lembur awal");
    const overtimeAfterStart = optionalTime("overtimeAfterStart", "Jam mulai lembur akhir");
    const overtimeAfterEnd = optionalTime("overtimeAfterEnd", "Jam selesai lembur akhir");
    const overtimePairs = [
      [overtimeBeforeStart, overtimeBeforeEnd, "Lembur awal"],
      [overtimeAfterStart, overtimeAfterEnd, "Lembur akhir"],
    ];
    for (const [rangeStart, rangeEnd, label] of overtimePairs) {
      if (Boolean(rangeStart) !== Boolean(rangeEnd)) throw Object.assign(new Error(`${label} Shift ${index + 1} harus memiliki jam mulai dan selesai.`), { statusCode: 400 });
      if (rangeStart && rangeEnd && rangeStart === rangeEnd) throw Object.assign(new Error(`${label} Shift ${index + 1} tidak boleh berdurasi nol.`), { statusCode: 400 });
    }
    const hasStructuredOvertime = overtimePairs.some(([rangeStart]) => Boolean(rangeStart));
    const overtimeMinutes = hasStructuredOvertime
      ? overtimePairs.reduce((sum, [rangeStart, rangeEnd]) => sum + (rangeStart && rangeEnd ? rangeMinutes(rangeStart, rangeEnd) : 0), 0)
      : Number(shift?.overtimeMinutes || 0);
    if (!validTime.test(startTime) || !validTime.test(endTime) || startTime === endTime) {
      throw Object.assign(new Error(`Jam mulai dan selesai Shift ${index + 1} wajib valid dan tidak boleh sama.`), { statusCode: 400 });
    }
    if (!Number.isFinite(breakMinutes) || breakMinutes < 0 || breakMinutes > 480 || !Number.isFinite(overtimeMinutes) || overtimeMinutes < 0 || overtimeMinutes > 480) {
      throw Object.assign(new Error(`Break atau overtime Shift ${index + 1} tidak valid.`), { statusCode: 400 });
    }
    return { startTime, endTime, breakMinutes, overtimeMinutes, overtimeBeforeStart, overtimeBeforeEnd, overtimeAfterStart, overtimeAfterEnd };
  });
}

exports.normalizeCapacityShiftOverrides = normalizeCapacityShiftOverrides;

exports.setCapacityDay = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber: req.params.planNumber, isDeleted: false }, select: { id: true, planNumber: true, status: true, periodStart: true, periodEnd: true } });
    if (!plan) return res.status(404).json({ message: "Production Plan tidak ditemukan." });
    if (!['Draft', 'Confirmed'].includes(plan.status)) return res.status(409).json({ message: "Capacity harian hanya dapat diubah sebelum plan release." });
    const scheduleDate = new Date(`${String(req.body?.scheduleDate || '').slice(0, 10)}T00:00:00.000Z`);
    const machineId = text(req.body?.machineId);
    const dayStatus = String(req.body?.dayStatus || 'WORKING').toUpperCase();
    const shiftsPerDay = req.body?.shiftsPerDay == null ? null : Number(req.body.shiftsPerDay);
    const reason = String(req.body?.reason || "").trim();
    if (Number.isNaN(scheduleDate.getTime()) || scheduleDate < plan.periodStart || scheduleDate > plan.periodEnd) return res.status(400).json({ message: "Tanggal harus berada dalam periode Production Plan." });
    assertCapacityDateEditable(scheduleDate);
    if (!['WORKING', 'HOLIDAY', 'OVERLOAD'].includes(dayStatus) || (shiftsPerDay != null && (![1, 2, 3].includes(shiftsPerDay)))) return res.status(400).json({ message: "Status atau jumlah shift harian tidak valid." });
    const time = (value) => value && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value)) ? String(value) : null;
    const overtimeStart = time(req.body?.overtimeStart);
    const overtimeEnd = time(req.body?.overtimeEnd);
    const shiftOverrides = normalizeCapacityShiftOverrides(req.body?.shiftOverrides, shiftsPerDay);
    if (Boolean(overtimeStart) !== Boolean(overtimeEnd)) return res.status(400).json({ message: "Jam mulai dan selesai lembur harus diisi berpasangan." });
    if (overtimeStart && overtimeEnd && overtimeEnd <= overtimeStart) return res.status(400).json({ message: "Jam selesai lembur harus setelah jam mulai." });
    if (reason.length < 5) return res.status(400).json({ message: "Alasan perubahan capacity harian minimal 5 karakter." });
    if (!machineId || !await prisma.machine.findFirst({ where: { id: machineId, isDeleted: false } })) return res.status(400).json({ message: "Mesin wajib dipilih." });
    const row = await prisma.capacityDayOverride.upsert({
      where: { planId_machineId_scheduleDate: { planId: plan.id, machineId, scheduleDate } },
      create: {
        planId: plan.id,
        machineId,
        scheduleDate,
        dayStatus,
        shiftsPerDay,
        shiftOverrides,
        overtimeStart,
        overtimeEnd,
        reason,
        changedBy: req.user?.username || req.user?.email || 'system',
      },
      update: {
        dayStatus,
        shiftsPerDay,
        shiftOverrides,
        overtimeStart,
        overtimeEnd,
        reason,
        changedBy: req.user?.username || req.user?.email || 'system',
        changedAt: new Date(),
        isDeleted: false,
      },
    });
    res.json(row);
  } catch (error) { next(error); }
};

// Global machine calendar: usable even when no MPP/Production Plan exists.
// It is intentionally separate from plan-scoped overrides so a global rule
// cannot accidentally mutate a specific plan.
exports.setGlobalCapacityDay = async (req, res, next) => {
  try {
    const scheduleDate = new Date(`${String(req.body?.scheduleDate || '').slice(0, 10)}T00:00:00.000Z`);
    const machineId = text(req.body?.machineId);
    const dayStatus = String(req.body?.dayStatus || 'WORKING').toUpperCase();
    const shiftsPerDay = req.body?.shiftsPerDay == null ? null : Number(req.body.shiftsPerDay);
    const reason = String(req.body?.reason || '').trim();
    if (Number.isNaN(scheduleDate.getTime()) || !machineId) return res.status(400).json({ message: 'Mesin dan tanggal wajib dipilih.' });
    assertCapacityDateEditable(scheduleDate);
    if (!['WORKING', 'HOLIDAY', 'OVERLOAD'].includes(dayStatus) || (shiftsPerDay != null && ![1, 2, 3].includes(shiftsPerDay))) return res.status(400).json({ message: 'Status atau jumlah shift harian tidak valid.' });
    const time = (value) => value && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value)) ? String(value) : null;
    const overtimeStart = time(req.body?.overtimeStart);
    const overtimeEnd = time(req.body?.overtimeEnd);
    const shiftOverrides = normalizeCapacityShiftOverrides(req.body?.shiftOverrides, shiftsPerDay);
    if (Boolean(overtimeStart) !== Boolean(overtimeEnd)) return res.status(400).json({ message: 'Jam mulai dan selesai lembur harus diisi berpasangan.' });
    if (overtimeStart && overtimeEnd && overtimeEnd <= overtimeStart) return res.status(400).json({ message: 'Jam selesai lembur harus setelah jam mulai.' });
    if (reason.length < 5) return res.status(400).json({ message: 'Alasan perubahan capacity harian minimal 5 karakter.' });
    if (!await prisma.machine.findFirst({ where: { id: machineId, isDeleted: false }, select: { id: true } })) return res.status(400).json({ message: 'Mesin tidak ditemukan.' });
    const row = await prisma.capacityCalendarOverride.upsert({
      where: { machineId_scheduleDate: { machineId, scheduleDate } },
      create: { machineId, scheduleDate, dayStatus, shiftsPerDay, shiftOverrides, overtimeStart, overtimeEnd, reason, changedBy: req.user?.username || req.user?.email || 'system' },
      update: { dayStatus, shiftsPerDay, shiftOverrides, overtimeStart, overtimeEnd, reason, changedBy: req.user?.username || req.user?.email || 'system', changedAt: new Date(), isDeleted: false },
    });
    await invalidateRccpByMachineCalendar(prisma, machineId, scheduleDate);
    res.json({ scope: 'GLOBAL', ...row });
  } catch (error) { next(error); }
};

const editorActor = (req) => req.user?.username || req.user?.email || req.user?.id || "system";

exports.openCapacityEditor = async (req, res, next) => {
  try {
    const scope = String(req.body?.scope || "PLAN").toUpperCase();
    if (scope === "GLOBAL" && !req.user?.isSuperAdmin) return res.status(403).json({ message: "Global machine calendar hanya dapat diubah oleh Super Admin." });
    const session = await openPersistentSession(prisma, { planNumber: req.params.planNumber, actor: editorActor(req), scope });
    res.status(session.createdAt?.getTime?.() === session.updatedAt?.getTime?.() ? 201 : 200).json(session);
  } catch (error) { next(error); }
};

exports.getCapacityEditor = async (req, res, next) => {
  try { res.json(await getPersistentSession(prisma, req.params.sessionId)); } catch (error) { next(error); }
};

exports.stageCapacityEditorChange = async (req, res, next) => {
  try {
    const change = req.body || {};
    const allowed = new Set(["MACHINE_DAY", "MOVE_ALLOCATION", "SPLIT_ALLOCATION", "QUEUE_ALLOCATION", "VENDOR_BATCH", "ALLOCATE_REMAINING", "FORCE_OVERRIDE"]);
    if (!allowed.has(String(change.type || "").toUpperCase())) return res.status(400).json({ message: "Tipe perubahan capacity editor tidak valid." });
    res.status(201).json(await stagePersistentChange(prisma, { sessionId: req.params.sessionId, change: { ...change, type: String(change.type).toUpperCase() }, actor: editorActor(req) }));
  } catch (error) { next(error); }
};

exports.previewCapacityEditor = async (req, res, next) => {
  try { res.json(await previewPersistentSession(prisma, req.params.sessionId)); } catch (error) { next(error); }
};

exports.cancelCapacityEditor = async (req, res, next) => {
  try { res.json(await cancelPersistentSession(prisma, { sessionId: req.params.sessionId, actor: editorActor(req) })); } catch (error) { next(error); }
};

exports.undoCapacityEditor = async (req, res, next) => {
  try { res.json(await undoPersistentChange(prisma, req.params.sessionId)); } catch (error) { next(error); }
};

exports.commitCapacityEditor = async (req, res, next) => {
  try {
    if (req.user?.isSuperAdmin) {
      await prisma.capacityEditChange.updateMany({
        where: { sessionId: req.params.sessionId, forceRequired: true, approvalStatus: "PENDING" },
        data: { approvalStatus: "APPROVED", approvedBy: editorActor(req), approvedAt: new Date() },
      });
    }
    res.json(await commitPersistentSession(prisma, { sessionId: req.params.sessionId, actor: editorActor(req) }));
  } catch (error) { next(error); }
};

exports.__test = {
  consolidateGeneratedExecutionDetails,
  derivePlanDetails,
  splitPlanDetailsByMrpExecutionMonth,
  netProductionByMpsDetailForRun,
  syncDraftPlanWithCurrentMps,
  requirementExecutionQty,
  productionPlanHorizon,
  productionPlanOwnerWindow,
  groupDetailsIntoProductionHorizon,
  canonicalMrpExecutionNotes,
  sourceMrpRunNumbers,
  buildSourceReconciliation,
};
