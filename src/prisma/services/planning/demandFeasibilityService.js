"use strict";

const { recommendMonthlyCapacity } = require("./capacityRecommendationService");
const { netTimePhasedDemand } = require("./timePhasedNettingService");
const { procurementSchedule, addWorkingDays } = require("./procurementSchedulingService");
const { buildDueDateRecoveryChecklist } = require("./dueDateRecoveryService");

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const asDate = (value) => {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const startOfDay = (value) => {
  const date = asDate(value);
  return date ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())) : null;
};
const addDays = (value, days) => {
  const date = startOfDay(value);
  if (!date) return null;
  date.setUTCDate(date.getUTCDate() + number(days));
  return date;
};
const dateKey = (value) => startOfDay(value)?.toISOString().slice(0, 10) || null;

function normalizeLeadTimeControls(input = {}) {
  return {
    productionProcess: true,
    supplierLeadTime: input.supplierLeadTime !== false,
    receivingQc: input.receivingQc !== false,
    safety: input.safety !== false,
  };
}

function supplierLeadTime(item) {
  return Math.max(number(item?.leadTimeDays ?? item?.supplier?.leadTimeDays), 0);
}

function resolveSupplierItem(items = [], partCode, options = {}) {
  const available = [...items].filter(Boolean);
  if (!available.length) return { item: null, selectionSource: "NOT_AVAILABLE" };
  const explicit = options.supplierSelections?.[partCode];
  const byIdOrCode = explicit && explicit !== "FASTEST"
    ? available.find((row) => row.id === explicit || row.supplier?.supplierCode === explicit)
    : null;
  if (byIdOrCode) return { item: byIdOrCode, selectionSource: "EXPLICIT" };
  if (explicit === "FASTEST" || String(options.supplierStrategy || "").toUpperCase() === "FASTEST") {
    const ranked = available.sort((a, b) => supplierLeadTime(a) - supplierLeadTime(b)
      || Number(Boolean(b.isPreferred)) - Number(Boolean(a.isPreferred))
      || number(a.priority) - number(b.priority)
      || String(a.supplier?.supplierCode || "").localeCompare(String(b.supplier?.supplierCode || "")));
    return { item: ranked[0], selectionSource: "FASTEST" };
  }
  return { item: available[0], selectionSource: explicit ? "EXPLICIT_NOT_FOUND_FALLBACK" : "PREFERRED" };
}

function supplierOption(item) {
  return {
    supplierItemId: item?.id || null,
    supplierCode: item?.supplier?.supplierCode || null,
    supplierName: item?.supplier?.supplierName || null,
    leadTimeDays: supplierLeadTime(item),
    isPreferred: Boolean(item?.isPreferred),
    priority: number(item?.priority),
    moq: number(item?.moq),
    orderMultiple: number(item?.orderMultiple),
    purchaseUomCode: item?.purchaseUomCode || null,
  };
}

function subtractWorkingDays(value, days, calendar = {}) {
  let cursor = startOfDay(value);
  let remaining = Math.max(Math.ceil(number(days)), 0);
  while (cursor && remaining > 0) {
    cursor = addDays(cursor, -1);
    const override = calendar[dateKey(cursor)];
    const weekend = [0, 6].includes(cursor.getUTCDay());
    if (override === "WORKING" || (!weekend && override !== "HOLIDAY")) remaining -= 1;
  }
  return cursor;
}

function isPlanningWorkingDay(value, calendar = {}) {
  const cursor = asDate(value);
  if (!cursor) return false;
  const override = calendar[dateKey(cursor)];
  const weekend = [0, 6].includes(cursor.getUTCDay());
  return override === "WORKING" || (!weekend && override !== "HOLIDAY");
}

function addWorkingHours(value, hours, { calendar = {}, hoursPerDay = 8 } = {}) {
  let cursor = asDate(value);
  if (!cursor) return null;
  let remaining = Math.max(number(hours), 0);
  const dailyHours = Math.max(number(hoursPerDay), 1);
  while (remaining > 0.000001) {
    if (!isPlanningWorkingDay(cursor, calendar)) {
      cursor = addDays(startOfDay(cursor), 1);
      continue;
    }
    const dayStart = startOfDay(cursor);
    const elapsed = Math.max((cursor - dayStart) / 3600000, 0);
    if (elapsed >= dailyHours - 0.000001) {
      cursor = addDays(dayStart, 1);
      continue;
    }
    const consumed = Math.min(remaining, dailyHours - elapsed);
    cursor = new Date(cursor.getTime() + consumed * 3600000);
    remaining -= consumed;
    if (remaining > 0.000001 && (cursor - dayStart) / 3600000 >= dailyHours - 0.000001) cursor = addDays(dayStart, 1);
  }
  return cursor;
}

function subtractWorkingHours(value, hours, { calendar = {}, hoursPerDay = 8 } = {}) {
  let cursor = asDate(value);
  if (!cursor) return null;
  let remaining = Math.max(number(hours), 0);
  const dailyHours = Math.max(number(hoursPerDay), 1);
  while (remaining > 0.000001) {
    const dayStart = startOfDay(cursor);
    if (!isPlanningWorkingDay(cursor, calendar) || cursor <= dayStart) {
      cursor = addDays(dayStart, -1);
      while (!isPlanningWorkingDay(cursor, calendar)) cursor = addDays(cursor, -1);
      cursor = new Date(startOfDay(cursor).getTime() + dailyHours * 3600000);
      continue;
    }
    const rawElapsed = Math.max((cursor - dayStart) / 3600000, 0);
    if (rawElapsed > dailyHours) cursor = new Date(dayStart.getTime() + dailyHours * 3600000);
    const elapsed = Math.min(rawElapsed, dailyHours);
    const consumed = Math.min(remaining, elapsed);
    cursor = new Date(cursor.getTime() - consumed * 3600000);
    remaining -= consumed;
  }
  return cursor;
}

function processDurationDays(step, quantity) {
  if (number(step.durationDays) > 0) return number(step.durationDays);
  if (number(step.leadTimeDays) > 0) return number(step.leadTimeDays);
  const seconds = number(step.cycleTimeSeconds ?? step.cycleTime) * Math.max(number(quantity), 1);
  return seconds > 0 ? Math.max(seconds / (8 * 60 * 60), 1 / 8) : 0;
}

function feasibilityCapacityPolicy(input = {}) {
  const sourceType = String(input.sourceType || "").toUpperCase();
  const requestedShifts = number(input.capacityShiftsPerDay);
  const shiftsPerDay = Math.min(Math.max(requestedShifts || (sourceType === "FORECAST" ? 2 : 1), 1), 3);
  return {
    mode: sourceType === "FORECAST" && shiftsPerDay === 2 ? "FORECAST_TWO_SHIFT" : "STANDARD_SHIFT_ASSUMPTION",
    shiftsPerDay,
    hoursPerShift: Math.max(number(input.capacityHoursPerShift) || 8, 1),
    sourceType: sourceType || null,
  };
}

function applyShiftCapacityToProductionLeadTime(breakdown, policy) {
  if (!breakdown || typeof breakdown !== "object") return breakdown || null;
  const shiftsPerDay = Math.max(number(policy?.shiftsPerDay), 1);
  const hoursPerShift = Math.max(number(policy?.hoursPerShift), 1);
  const baselineProductionLeadTimeDays = number(breakdown.baselineProductionLeadTimeDays ?? breakdown.productionLeadTimeDays);
  if (number(breakdown.capacityShiftsPerDay) === shiftsPerDay && breakdown.capacityAdjusted) return breakdown;
  const processPath = (breakdown.processPath || []).map((step) => {
    const vendor = String(step.mode || step.routingMode || "INHOUSE").toUpperCase() === "VENDOR";
    const rawElapsedDays = number(step.rawElapsedDays ?? step.elapsedDays);
    return {
      ...step,
      baselineElapsedDays: number(step.baselineElapsedDays ?? step.elapsedDays),
      elapsedDays: vendor ? number(step.elapsedDays) : rawElapsedDays / shiftsPerDay,
      capacityShiftsPerDay: vendor ? null : shiftsPerDay,
    };
  });
  const inhouseHours = Math.max(number(breakdown.inhouseProcessHours), 0);
  const vendorDays = Math.max(number(breakdown.vendorScheduledDays ?? breakdown.vendorLeadTimeDays), 0);
  const adjustedInhouseDays = inhouseHours > 0
    ? Math.ceil(inhouseHours / (hoursPerShift * shiftsPerDay))
    : Math.max(baselineProductionLeadTimeDays - vendorDays, 0) / shiftsPerDay;
  const productionLeadTimeDays = vendorDays + adjustedInhouseDays;
  return {
    ...breakdown,
    processPath,
    baselineProductionLeadTimeDays,
    baselineExactProductionLeadTimeDays: number(breakdown.baselineExactProductionLeadTimeDays ?? breakdown.exactProductionLeadTimeDays),
    productionLeadTimeDays,
    exactProductionLeadTimeDays: vendorDays + (inhouseHours > 0 ? inhouseHours / (hoursPerShift * shiftsPerDay) : adjustedInhouseDays),
    capacityAdjusted: shiftsPerDay > 1,
    capacityShiftsPerDay: shiftsPerDay,
    capacityHoursPerShift: hoursPerShift,
    calculationMethod: `${breakdown.calculationMethod || "BOM_CRITICAL_PATH"}_SHIFT_${shiftsPerDay}`,
  };
}

function vendorProcessKey(step = {}, index = 0) {
  return [
    step.detailCode || `LEVEL-${number(step.level)}`,
    `SEQ-${number(step.sequence)}`,
    step.processCode || step.processName || "VENDOR",
    step.vendorCode || "VENDOR-NOT-SET",
    index,
  ].map((value) => String(value).trim().toUpperCase()).join("::");
}

function normalizeVendorProcessAdjustments(input) {
  if (!Array.isArray(input)) return [];
  return input.map((row) => ({
    key: String(row?.key || "").trim(),
    adjustedDurationHours: number(row?.adjustedDurationHours),
    reason: String(row?.reason || "").trim(),
  })).filter((row) => row.key);
}

/**
 * Applies a PPIC planning overlay to vendor lead time without changing the
 * routing/vendor master. Vendor work stays a mandatory route dependency.
 */
function applyVendorProcessAdjustments(breakdown, adjustments, policy) {
  if (!breakdown || typeof breakdown !== "object") return { breakdown: breakdown || null, vendorProcesses: [], adjustments: [], shortened: [] };
  const productionHoursPerDay = Math.max(number(policy?.hoursPerShift) * Math.max(number(policy?.shiftsPerDay), 1), 1);
  const requested = new Map(normalizeVendorProcessAdjustments(adjustments).map((row) => [row.key, row]));
  const vendorProcesses = [];
  const normalizedAdjustments = [];
  const shortened = [];
  const processPath = (breakdown.processPath || []).map((step, index) => {
    if (String(step.mode || step.routingMode || "INHOUSE").toUpperCase() !== "VENDOR") return step;
    const key = vendorProcessKey(step, index);
    const masterDurationHours = Math.max(number(step.masterDurationHours ?? step.elapsedHours)
      || number(step.vendorLeadTimeDays ?? step.baselineElapsedDays ?? step.rawElapsedDays ?? step.elapsedDays) * 8, 0.25);
    const adjustment = requested.get(key);
    const adjustedDurationHours = adjustment ? adjustment.adjustedDurationHours : masterDurationHours;
    if (adjustment && adjustedDurationHours < 0.25) {
      throw Object.assign(new Error(`Durasi planning vendor ${step.processCode || step.processName || key} minimal 0,25 jam dan proses vendor tidak boleh dihapus.`), { statusCode: 400 });
    }
    const changed = Math.abs(adjustedDurationHours - masterDurationHours) > 0.000001;
    if (changed && adjustment.reason.length < 5) {
      throw Object.assign(new Error(`Alasan adjustment vendor ${step.processCode || step.processName || key} wajib diisi minimal 5 karakter.`), { statusCode: 400 });
    }
    const effectiveHours = changed ? adjustedDurationHours : masterDurationHours;
    const process = {
      key,
      detailCode: step.detailCode || null,
      detailName: step.detailName || null,
      level: number(step.level),
      sequence: number(step.sequence),
      processCode: step.processCode || null,
      processName: step.processName || null,
      vendorCode: step.vendorCode || null,
      vendorName: step.vendorName || null,
      masterDurationHours,
      adjustedDurationHours: effectiveHours,
      reason: changed ? adjustment.reason : null,
      adjustmentApplied: changed,
      shortened: changed && effectiveHours < masterDurationHours,
    };
    vendorProcesses.push(process);
    if (changed) normalizedAdjustments.push({ key, adjustedDurationHours: effectiveHours, reason: adjustment.reason });
    if (process.shortened) shortened.push(process);
    return {
      ...step,
      masterDurationHours,
      masterDurationDays: masterDurationHours / productionHoursPerDay,
      elapsedHours: effectiveHours,
      rawElapsedDays: effectiveHours / productionHoursPerDay,
      elapsedDays: effectiveHours / productionHoursPerDay,
      vendorLeadTimeDays: effectiveHours / productionHoursPerDay,
      vendorPlanningDurationHours: effectiveHours,
      vendorAdjustmentReason: process.reason,
      vendorAdjustmentApplied: changed,
    };
  });
  const vendorHours = vendorProcesses.reduce((sum, row) => sum + row.adjustedDurationHours, 0);
  const inhouseHours = Math.max(number(breakdown.inhouseProcessHours), 0);
  // Preserve the routing engine's per-operation rounding. Aggregating all
  // in-house hours and rounding once makes the critical path look shorter
  // than the Purchase Suggestion calculation shown to PPIC.
  const inhouseDays = number(breakdown.inhouseScheduledDays) > 0
    ? number(breakdown.inhouseScheduledDays)
    : inhouseHours > 0
      ? Math.ceil(inhouseHours / productionHoursPerDay)
      : Math.max(number(breakdown.productionLeadTimeDays) - number(breakdown.vendorScheduledDays), 0);
  return {
    breakdown: {
      ...breakdown,
      processPath,
      vendorScheduledDays: vendorHours / productionHoursPerDay,
      vendorLeadTimeDays: vendorHours / productionHoursPerDay,
      productionLeadTimeDays: inhouseDays + vendorHours / productionHoursPerDay,
      exactProductionLeadTimeDays: (inhouseHours + vendorHours) / productionHoursPerDay,
      vendorProcessAdjustments: normalizedAdjustments,
      vendorAdjustmentApplied: normalizedAdjustments.length > 0,
    },
    vendorProcesses,
    adjustments: normalizedAdjustments,
    shortened,
  };
}

function applyVendorAdjustmentsToProcessSteps(processSteps, vendorProcesses, policy) {
  const productionHoursPerDay = Math.max(number(policy?.hoursPerShift) * Math.max(number(policy?.shiftsPerDay), 1), 1);
  const remaining = [...(vendorProcesses || [])];
  return (processSteps || []).map((step) => {
    if (String(step.routingMode || "INHOUSE").toUpperCase() !== "VENDOR") return step;
    const index = remaining.findIndex((process) => String(process.processCode || "") === String(step.processCode || "")
      && String(process.vendorCode || "") === String(step.vendorCode || "")
      && number(process.sequence) === number(step.sequence));
    if (index < 0) return step;
    const [process] = remaining.splice(index, 1);
    return {
      ...step,
      durationDays: process.adjustedDurationHours / productionHoursPerDay,
      durationHours: process.adjustedDurationHours,
      masterDurationHours: process.masterDurationHours,
      vendorAdjustmentReason: process.reason,
      vendorProcessKey: process.key,
    };
  });
}

function calculateLeadTimeFeasibility(input = {}) {
  const requestedDeliveryDate = startOfDay(input.requestedDeliveryDate || input.targetDeliveryDate);
  if (!requestedDeliveryDate) throw Object.assign(new Error("Requested delivery date wajib valid."), { statusCode: 400 });
  const today = startOfDay(input.today || new Date());
  const calendar = input.productionCalendar || {};
  const dispatchDays = Math.max(number(input.dispatchDays ?? 1), 0);
  const fgRequiredDate = subtractWorkingDays(requestedDeliveryDate, dispatchDays, calendar);
  const capacityPolicy = feasibilityCapacityPolicy(input);
  const productionHoursPerDay = capacityPolicy.hoursPerShift * capacityPolicy.shiftsPerDay;
  const productionLeadTimeBreakdown = applyShiftCapacityToProductionLeadTime(input.productionLeadTimeBreakdown, capacityPolicy);
  const orderedSteps = [...(input.processSteps || [])].sort((a, b) => number(b.sequence) - number(a.sequence));
  let processDue = fgRequiredDate;
  let vendorSendDate = null;
  let vendorReturnDate = null;
  const processTimeline = [];
  for (const step of orderedSteps) {
    const finishDate = processDue;
    const routingMode = String(step.routingMode || "INHOUSE").toUpperCase();
    const baselineDurationDays = processDurationDays(step, input.quantity);
    const durationDays = routingMode === "VENDOR" ? baselineDurationDays : baselineDurationDays / capacityPolicy.shiftsPerDay;
    const durationHours = durationDays * productionHoursPerDay;
    const startDate = subtractWorkingHours(finishDate, durationHours, { calendar, hoursPerDay: productionHoursPerDay });
    if (routingMode === "VENDOR") {
      vendorReturnDate = vendorReturnDate || finishDate;
      vendorSendDate = startDate;
    }
    processTimeline.unshift({
      sequence: number(step.sequence),
      processCode: step.processCode || null,
      routingMode,
      vendorCode: step.vendorCode || null,
      durationDays, durationHours, baselineDurationDays,
      capacityShiftsPerDay: routingMode === "VENDOR" ? null : capacityPolicy.shiftsPerDay,
      latestStartDate: startDate,
      latestFinishDate: finishDate,
    });
    processDue = startDate;
  }
  const scheduledProductionLeadTimeDays = number(productionLeadTimeBreakdown?.productionLeadTimeDays ?? input.scheduledProductionLeadTimeDays);
  const exactProductionLeadTimeDays = number(productionLeadTimeBreakdown?.exactProductionLeadTimeDays ?? scheduledProductionLeadTimeDays);
  const scheduledProductionLeadTimeHours = exactProductionLeadTimeDays * productionHoursPerDay;
  if (scheduledProductionLeadTimeHours > 0) processDue = subtractWorkingHours(fgRequiredDate, scheduledProductionLeadTimeHours, { calendar, hoursPerDay: productionHoursPerDay });
  const productionLatestStartDate = processDue;
  const materialRequiredDate = subtractWorkingDays(productionLatestStartDate, number(input.materialStagingDays), calendar);
  const holidays = Object.entries(calendar).filter(([, status]) => status === "HOLIDAY").map(([key]) => key);
  const purchasingSchedule = procurementSchedule({
    materialRequiredDate,
    supplierLeadTimeDays: input.supplierLeadTimeDays,
    prApprovalDays: input.prApprovalDays,
    poProcessingDays: input.poProcessingDays,
    transitDays: input.transitDays,
    receivingQcDays: input.receivingQcDays,
    safetyLeadTimeDays: input.safetyLeadTimeDays,
    holidays,
    asOf: today,
  });
  const supplierRequiredArrivalDate = purchasingSchedule.supplierRequiredArrivalDate;
  const latestPoDate = purchasingSchedule.latestPoDate;
  const latestPrDate = purchasingSchedule.latestPrDate;
  const earliestMaterialDate = addWorkingDays(today, purchasingSchedule.totalLeadTimeDays, holidays);
  const productionDays = exactProductionLeadTimeDays || processTimeline.reduce((sum, row) => sum + row.durationDays, 0);
  const earliestProductionStartDate = addWorkingDays(earliestMaterialDate, number(input.materialStagingDays), holidays);
  const earliestFeasibleFgDate = addWorkingHours(earliestProductionStartDate, productionDays * productionHoursPerDay, { calendar, hoursPerDay: productionHoursPerDay });
  const earliestFeasibleDeliveryDate = addDays(earliestFeasibleFgDate, dispatchDays);
  const result = {
    requestedDeliveryDate,
    fgDispatchDate: requestedDeliveryDate,
    fgRequiredDate,
    finalProcessDueDate: fgRequiredDate,
    productionLatestStartDate,
    materialRequiredDate,
    supplierRequiredArrivalDate,
    latestPoDate,
    latestPrDate,
    vendorSendDate,
    vendorReturnDate,
    earliestFeasibleFgDate,
    earliestFeasibleDeliveryDate,
    processTimeline,
    productionLeadTimeBreakdown,
    scheduledProductionLeadTimeHours,
    purchasingSchedule,
    capacityAssumption: capacityPolicy,
    today,
  };
  return result;
}

async function purchaseSuggestionRoutingMetric(prisma, mbomHeaderId, quantity) {
  if (!mbomHeaderId) return null;
  // Lazy import avoids controller initialization cycles while retaining one
  // authoritative critical-path implementation for Forecast and Suggestion.
  const { routingMetrics } = require("../../controllers/purchasing/PurchaseSuggestionController");
  const metrics = await routingMetrics(prisma, [mbomHeaderId], new Map([[mbomHeaderId, Math.max(number(quantity), 1)]]));
  return metrics.get(mbomHeaderId) || null;
}

function classifyFeasibility({ timeline, capacity = null, masterDataComplete = true, materialCovered = null }) {
  if (!masterDataComplete) return { status: "MASTER_DATA_INCOMPLETE", capacityStatus: capacity?.status || "NOT_SIMULATED", materialStatus: "MASTER_DATA_INCOMPLETE", criticalConstraint: "MASTER_DATA" };
  const now = timeline.today || startOfDay(new Date());
  const leadTimeLate = timeline.latestPrDate && timeline.latestPrDate < now;
  const deliveryLate = timeline.earliestFeasibleDeliveryDate > timeline.requestedDeliveryDate;
  const capacityLate = capacity && (capacity.ready === false || number(capacity.blockerCount) > 0);
  const materialStatus = materialCovered === false ? "SHORTAGE" : leadTimeLate ? "EXPEDITE_REQUIRED" : "READY_BY_DATE";
  const capacityStatus = !capacity ? "NOT_SIMULATED" : capacityLate ? "CAPACITY_LATE" : "FEASIBLE";
  if (deliveryLate || (leadTimeLate && materialCovered !== true) || capacityLate) {
    return {
      status: deliveryLate || capacityLate ? "NOT_FEASIBLE" : "AT_RISK",
      capacityStatus,
      materialStatus,
      criticalConstraint: capacityLate ? "CAPACITY" : leadTimeLate ? "SUPPLIER_LEAD_TIME" : "DELIVERY_DATE",
    };
  }
  if (materialCovered === false) return { status: "AT_RISK", capacityStatus, materialStatus, criticalConstraint: "MATERIAL_SHORTAGE" };
  if (!capacity) return { status: "AT_RISK", capacityStatus: "NOT_SIMULATED", materialStatus, criticalConstraint: "CAPACITY_NOT_SIMULATED" };
  return { status: "FEASIBLE", capacityStatus, materialStatus, criticalConstraint: null };
}

const categoryKey = (value) => String(value || "").replace(/[^a-z]/gi, "").toUpperCase();

async function explodeDemandBom(prisma, { partId, partCode, quantity, maxDepth = 10, supplierSelections = {}, supplierStrategy = "PREFERRED", effectiveAt = null }) {
  const headers = new Map();
  const trace = [];
  const purchased = new Map();
  const visitedEdges = new Set();

  async function headerFor(childPartId) {
    if (!childPartId) return null;
    if (headers.has(childPartId)) return headers.get(childPartId);
    const header = await prisma.mBOMHeader.findFirst({
      where: {
        partId: childPartId,
        isDeleted: false,
        ...(effectiveAt ? { AND: [
          { OR: [{ effectiveDate: null }, { effectiveDate: { lte: new Date(effectiveAt) } }] },
          { OR: [{ expiryDate: null }, { expiryDate: { gte: new Date(effectiveAt) } }] },
        ] } : {}),
      },
      orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
      select: {
        id: true, noReg: true, partId: true,
        details: {
          where: { isDeleted: false },
          orderBy: [{ levelComponent: "asc" }, { createdAt: "asc" }],
          select: {
            id: true, parentDetailId: true, levelComponent: true, partId: true, category: true, qty: true, grossWeight: true, uomCode: true, leadTime: true, leadTimeUnit: true,
            part: {
              select: {
                id: true, partCode: true, partName: true,
                supplierItems: {
                  where: { isActive: true }, orderBy: [{ isPreferred: "desc" }, { priority: "asc" }],
                  select: { id: true, leadTimeDays: true, moq: true, orderMultiple: true, purchaseUomCode: true, isPreferred: true, priority: true, supplier: { select: { supplierCode: true, supplierName: true, leadTimeDays: true } } },
                },
              },
            },
            mbomProcesses: { where: { isDeleted: false }, orderBy: { sequence: "asc" }, select: { sequence: true, cycleTime: true, routingMode: true, process: { select: { processCode: true } }, vendor: { select: { vendorCode: true, leadTimeDays: true } }, routingOperation: { select: { isSubcontract: true } } } },
          },
        },
      },
    });
    headers.set(childPartId, header);
    return header;
  }

  async function walk(currentPartId, currentPartCode, driverQty, depth, path, accumulatedLeadTimeDays = 0, activeHeaders = new Set()) {
    if (!currentPartId || depth > maxDepth) return null;
    const header = await headerFor(currentPartId);
    if (!header || activeHeaders.has(header.id)) return header;
    const nextActive = new Set(activeHeaders); nextActive.add(header.id);
    const requiredByDetail = new Map();
    const pathByDetail = new Map();
    const cumulativeLeadTimeByDetail = new Map();
    for (const detail of header.details || []) {
      if (!detail.part?.partCode) continue;
      const parentDriver = detail.parentDetailId && requiredByDetail.has(detail.parentDetailId) ? requiredByDetail.get(detail.parentDetailId) : driverQty;
      const category = categoryKey(detail.category);
      const usagePerParent = category === "PURCHASE" && number(detail.grossWeight) > 0 ? number(detail.grossWeight) : number(detail.qty);
      const requiredQty = Math.max(usagePerParent, 0) * Math.max(number(parentDriver), 0);
      requiredByDetail.set(detail.id, requiredQty);
      const supplierResolution = resolveSupplierItem(detail.part.supplierItems, detail.part.partCode, { supplierSelections, supplierStrategy });
      const supplierItem = supplierResolution.item;
      const supplierLeadTimeDays = supplierLeadTime(supplierItem);
      const supplierOptions = (detail.part.supplierItems || []).map(supplierOption);
      const leadTimeSteps = category === "PURCHASE"
        ? [{ sequence: null, processCode: "SUPPLIER", routingMode: "SUPPLIER", resourceCode: supplierItem?.supplier?.supplierCode || null, durationDays: supplierLeadTimeDays }]
        : (detail.mbomProcesses || []).map((process) => {
            const routingMode = String(process.routingMode || "INHOUSE").toUpperCase();
            return {
              sequence: number(process.sequence), processCode: process.process?.processCode || null, routingMode,
              resourceCode: routingMode === "VENDOR" ? process.vendor?.vendorCode || null : null,
              durationDays: routingMode === "VENDOR" ? number(process.vendor?.leadTimeDays) : processDurationDays({ cycleTimeSeconds: process.cycleTime }, requiredQty),
            };
          });
      const processLeadTimeDays = leadTimeSteps.reduce((sum, step) => sum + number(step.durationDays), 0);
      const parentCumulativeLeadTimeDays = detail.parentDetailId && cumulativeLeadTimeByDetail.has(detail.parentDetailId) ? cumulativeLeadTimeByDetail.get(detail.parentDetailId) : accumulatedLeadTimeDays;
      const cumulativeLeadTimeDays = parentCumulativeLeadTimeDays + processLeadTimeDays;
      cumulativeLeadTimeByDetail.set(detail.id, cumulativeLeadTimeDays);
      const rowPath = [...(detail.parentDetailId && pathByDetail.get(detail.parentDetailId) || path), detail.part.partCode];
      pathByDetail.set(detail.id, rowPath);
      trace.push({
        level: depth + Math.max(number(detail.levelComponent), 0), mbomNumber: header.noReg, parentPartCode: currentPartCode, partCode: detail.part.partCode,
        partName: detail.part.partName || null, category, usagePerParent, requiredQty, uomCode: detail.uomCode || supplierItem?.purchaseUomCode || null,
        path: rowPath, supplierItemId: supplierItem?.id || null, supplierCode: supplierItem?.supplier?.supplierCode || null, supplierName: supplierItem?.supplier?.supplierName || null,
        supplierSelectionSource: supplierResolution.selectionSource, supplierOptions,
        supplierLeadTimeDays, processLeadTimeDays, cumulativeLeadTimeDays, leadTimeSteps, moq: number(supplierItem?.moq), orderMultiple: number(supplierItem?.orderMultiple),
      });
      if (category === "PURCHASE") {
        const existing = purchased.get(detail.part.partCode) || { partCode: detail.part.partCode, partName: detail.part.partName || null, qty: 0, uomCode: detail.uomCode || supplierItem?.purchaseUomCode || null, supplierItemId: supplierItem?.id || null, supplierCode: supplierItem?.supplier?.supplierCode || null, supplierName: supplierItem?.supplier?.supplierName || null, supplierSelectionSource: supplierResolution.selectionSource, supplierOptions, supplierLeadTimeDays, moq: number(supplierItem?.moq), orderMultiple: number(supplierItem?.orderMultiple), paths: [] };
        existing.qty += requiredQty;
        existing.supplierLeadTimeDays = Math.max(existing.supplierLeadTimeDays, supplierLeadTimeDays);
        existing.paths.push(rowPath);
        purchased.set(detail.part.partCode, existing);
      } else {
        const edge = `${header.id}:${detail.id}:${detail.part.id}`;
        if (!visitedEdges.has(edge)) {
          visitedEdges.add(edge);
          await walk(detail.part.id, detail.part.partCode, requiredQty, depth + 1, rowPath, cumulativeLeadTimeDays, nextActive);
        }
      }
    }
    return header;
  }

  const rootHeader = await walk(partId, partCode, quantity, 0, [partCode], 0);
  return { rootHeader, trace, componentRequirements: [...purchased.values()] };
}

async function loadDemandContext(prisma, { partCode, quantity, requestedDeliveryDate, supplierSelections = {}, supplierStrategy = "PREFERRED" }) {
  const part = await prisma.part.findFirst({
    where: { partCode, isDeleted: false },
    select: { id: true, partCode: true, partName: true },
  });
  const explosion = part ? await explodeDemandBom(prisma, { partId: part.id, partCode: part.partCode, quantity, supplierSelections, supplierStrategy, effectiveAt: requestedDeliveryDate }) : { rootHeader: null, trace: [], componentRequirements: [] };
  const header = explosion.rootHeader;
  const details = header?.details || [];
  const processSteps = details.flatMap((detail) => (detail.mbomProcesses || []).map((row) => {
    const vendorProcess = String(row.routingMode).toUpperCase() === "VENDOR"
      || categoryKey(detail.category) === "VENDOR"
      || Boolean(row.routingOperation?.isSubcontract);
    return {
      sequence: row.sequence,
      processCode: row.process?.processCode,
      routingMode: vendorProcess ? "VENDOR" : row.routingMode,
      vendorCode: row.vendor?.vendorCode,
      durationDays: vendorProcess ? number(row.vendor?.leadTimeDays) || number(detail.leadTime) : undefined,
      cycleTimeSeconds: row.cycleTime,
    };
  }));
  const componentRequirements = explosion.componentRequirements;
  const supplierRows = componentRequirements.filter((row) => row.supplierCode);
  const supplierLeadTimeDays = componentRequirements.reduce((max, row) => Math.max(max, number(row.supplierLeadTimeDays)), 0);
  const result = {
    part,
    mbomHeader: header,
    processSteps,
    supplierRows,
    componentRequirements,
    bomTrace: explosion.trace,
    quantity,
    requestedDeliveryDate,
    supplierLeadTimeDays,
    masterDataComplete: Boolean(part && header && processSteps.length && componentRequirements.every((row) => row.supplierCode)),
  };
  return result;
}

async function loadMaterialCoverage(prisma, componentRequirements, requiredDate, options = {}) {
  const partCodes = [...new Set((componentRequirements || []).map((row) => row.partCode).filter(Boolean))];
  if (!partCodes.length) return { covered: null, shortages: [], components: [] };
  const supplyCache = options.supplyCache instanceof Map ? options.supplyCache : null;
  const supplyKey = [...partCodes].sort().join("|");
  let supplyPromise = supplyCache?.get(supplyKey);
  if (!supplyPromise) {
    supplyPromise = Promise.all([
      prisma.stockBalance.findMany({ where: { isDeleted: false, OR: [{ partCode: { in: partCodes } }, { materialCode: { in: partCodes } }, { partNumber: { in: partCodes } }] }, select: { partCode: true, materialCode: true, partNumber: true, qtyAvailable: true } }),
      prisma.purchaseOrderDetail.findMany({ where: { isDeleted: false, partCode: { in: partCodes }, po: { isDeleted: false, status: { notIn: ["Cancelled", "Rejected"] } } }, select: { partCode: true, qty: true, qtyReceived: true, deliveryDate: true, poNumber: true, po: { select: { deliveryDate: true, status: true } } } }),
      prisma.purchaseRequisitionDetail.findMany({ where: { isDeleted: false, partCode: { in: partCodes }, pr: { isDeleted: false, status: { in: ["Draft","Submitted","Approved","Partially Ordered"] } } }, select: { partCode: true, qty: true, orderedQty: true, prNumber: true, pr: { select: { requiredDate: true, status: true } } } }),
    ]);
    if (supplyCache) supplyCache.set(supplyKey, supplyPromise);
  }
  const [balances, openPo, openPr] = await supplyPromise;
  const components = componentRequirements.map((component) => {
    const openingQty = balances.filter((row) => [row.partCode,row.materialCode,row.partNumber].includes(component.partCode)).reduce((sum,row) => sum + number(row.qtyAvailable), 0);
    const supplyEvents = [
      ...openPo.filter((row) => row.partCode === component.partCode && number(row.qty) > number(row.qtyReceived)).map((row) => ({ sourceType: "PO", sourceNumber: row.poNumber, qty: number(row.qty) - number(row.qtyReceived), availableDate: row.deliveryDate || row.po.deliveryDate, confidence: ["Confirmed","Partial Receipt","Sent","Approved"].includes(row.po.status) ? "FIRM" : "PLANNED" })),
      ...openPr.filter((row) => row.partCode === component.partCode && number(row.qty) > number(row.orderedQty)).map((row) => ({ sourceType: "PR", sourceNumber: row.prNumber, qty: number(row.qty) - number(row.orderedQty), availableDate: row.pr.requiredDate, confidence: "PLANNED" })),
    ];
    const result = netTimePhasedDemand({ openingQty, supplyEvents, demandEvents: [{ qty: component.qty, requiredDate }] })[0];
    const eligibleSupply = result?.eligibleSupply || [];
    const lateSupply = supplyEvents.filter((row) => asDate(row.availableDate) > asDate(requiredDate));
    return { ...component, requiredDate, openingQty, eligibleSupply, eligibleSupplyQty: eligibleSupply.reduce((sum, row) => sum + number(row.qty), 0), lateSupply, lateSupplyQty: lateSupply.reduce((sum, row) => sum + number(row.qty), 0), shortageQty: number(result?.firmNetRequirement), expectedShortageQty: number(result?.netRequirement) };
  });
  const shortages = components.filter((row) => row.shortageQty > 0.000001);
  return { covered: shortages.length === 0, shortages, components };
}

async function simulateCapacity(prisma, input) {
  if (!input.planNumber) return null;
  try {
    const result = await recommendMonthlyCapacity(prisma, input.planNumber, {
      planningMode: "SIMULATION",
      scenarioKey: input.scenarioKey || `demand-feasibility-${dateKey(new Date())}`,
      persist: false,
    });
    return { ready: Boolean(result.ready), blockerCount: (result.blockers || []).length, earliestFeasibleCompletion: result.earliestFeasibleCompletion || null, blockers: result.blockers || [] };
  } catch (error) {
    return { ready: false, blockerCount: 1, blockers: [{ code: "CAPACITY_SIMULATION_ERROR", message: error.message }] };
  }
}

async function assessDemandFeasibility(prisma, input = {}) {
  const leadTimeControls = normalizeLeadTimeControls(input.leadTimeControls);
  const supplierStrategy = String(input.supplierStrategy || "PREFERRED").toUpperCase() === "FASTEST" ? "FASTEST" : "PREFERRED";
  const supplierSelections = input.supplierSelections && typeof input.supplierSelections === "object" && !Array.isArray(input.supplierSelections) ? input.supplierSelections : {};
  const controlledInput = {
    ...input,
    supplierStrategy,
    supplierSelections,
    receivingQcDays: leadTimeControls.receivingQc ? input.receivingQcDays : 0,
    safetyLeadTimeDays: leadTimeControls.safety ? input.safetyLeadTimeDays : 0,
  };
  const contextCache = input.contextCache instanceof Map ? input.contextCache : null;
  const contextCacheKey = input.contextCacheKey || null;
  let contextPromise = contextCacheKey ? contextCache?.get(contextCacheKey) : null;
  if (!contextPromise) {
    contextPromise = loadDemandContext(prisma, controlledInput);
    if (contextCache && contextCacheKey) contextCache.set(contextCacheKey, contextPromise);
  }
  const cachedContext = await contextPromise;
  const context = { ...cachedContext, requestedDeliveryDate: controlledInput.requestedDeliveryDate };
  controlledInput.supplierLeadTimeDays = leadTimeControls.supplierLeadTime ? context.supplierLeadTimeDays : 0;
  const capacityPolicy = feasibilityCapacityPolicy(input);
  const routingCache = input.routingMetricCache instanceof Map ? input.routingMetricCache : null;
  const routingCacheKey = context.mbomHeader?.id ? `${context.mbomHeader.id}|${number(context.quantity)}` : null;
  let routingPromise = routingCacheKey ? routingCache?.get(routingCacheKey) : null;
  if (!routingPromise) {
    routingPromise = purchaseSuggestionRoutingMetric(prisma, context.mbomHeader?.id, context.quantity);
    if (routingCache && routingCacheKey) routingCache.set(routingCacheKey, routingPromise);
  }
  const baselineProductionLeadTimeBreakdown = await routingPromise;
  const shiftedProductionLeadTimeBreakdown = applyShiftCapacityToProductionLeadTime(baselineProductionLeadTimeBreakdown, capacityPolicy);
  const vendorAdjustment = applyVendorProcessAdjustments(shiftedProductionLeadTimeBreakdown, input.vendorProcessAdjustments, capacityPolicy);
  const productionLeadTimeBreakdown = vendorAdjustment.breakdown;
  const processSteps = applyVendorAdjustmentsToProcessSteps(context.processSteps, vendorAdjustment.vendorProcesses, capacityPolicy);
  const timeline = calculateLeadTimeFeasibility({ ...controlledInput, ...context, processSteps, supplierLeadTimeDays: controlledInput.supplierLeadTimeDays, capacityShiftsPerDay: capacityPolicy.shiftsPerDay, capacityHoursPerShift: capacityPolicy.hoursPerShift, productionLeadTimeBreakdown });
  const coverage = input.materialCovered == null ? await loadMaterialCoverage(prisma, context.componentRequirements, timeline.materialRequiredDate, { supplyCache: input.materialSupplyCache }) : { covered: Boolean(input.materialCovered), shortages: [], components: [] };
  const capacity = await simulateCapacity(prisma, input);
  const holidays = Object.entries(input.productionCalendar || {}).filter(([, status]) => status === "HOLIDAY").map(([key]) => key);
  const materialCoverage = coverage.components.map((row) => {
    const schedule = procurementSchedule({
      materialRequiredDate: timeline.materialRequiredDate,
      supplierLeadTimeDays: leadTimeControls.supplierLeadTime ? row.supplierLeadTimeDays : 0,
      prApprovalDays: input.prApprovalDays,
      poProcessingDays: input.poProcessingDays,
      transitDays: input.transitDays,
      receivingQcDays: controlledInput.receivingQcDays,
      safetyLeadTimeDays: controlledInput.safetyLeadTimeDays,
      holidays,
      asOf: timeline.today,
    });
    return { ...row, latestPrDate: schedule.latestPrDate, procurementWindow: schedule.procurementWindow, procurementLeadTimeDays: schedule.totalLeadTimeDays, procurementLeadTimeBreakdown: schedule.leadTimeBreakdown };
  });
  let cumulativeProductionDays = 0;
  const productionLeadTimeTrace = (productionLeadTimeBreakdown?.processPath || []).map((step) => {
    const scheduledDays = number(step.elapsedDays);
    cumulativeProductionDays += scheduledDays;
    return {
      level: number(step.level), partCode: step.detailCode || step.processCode || "PROCESS", partName: step.detailName || null,
      path: [context.part?.partCode || input.partCode, step.detailCode].filter(Boolean), category: step.mode === "VENDOR" ? "VENDOR" : "INHOUSE",
      processLeadTimeDays: scheduledDays, cumulativeLeadTimeDays: cumulativeProductionDays,
      leadTimeSteps: [{ sequence: step.sequence, processCode: step.processName || step.processCode || "PROCESS", routingMode: step.mode, resourceCode: step.vendorCode || null, durationDays: scheduledDays, rawDurationDays: number(step.rawElapsedDays) }],
    };
  });
  const purchasingLeadTimeTrace = materialCoverage.map((row) => {
    const breakdown = row.procurementLeadTimeBreakdown || {};
    const steps = [
      ["PR APPROVAL", breakdown.prApprovalDays], ["PO PROCESSING", breakdown.poProcessingDays], ["SUPPLIER", breakdown.supplierLeadTimeDays],
      ["TRANSIT", breakdown.transitDays], ["RECEIVING QC", breakdown.receivingQcDays], ["SAFETY", breakdown.safetyLeadTimeDays],
    ].filter(([, days]) => number(days) > 0).map(([processCode, days]) => ({ processCode, routingMode: "PURCHASING", resourceCode: processCode === "SUPPLIER" ? row.supplierCode : null, durationDays: number(days) }));
    return {
      level: 99, partCode: row.partCode, partName: row.partName || null, path: [context.part?.partCode || input.partCode, row.partCode].filter(Boolean), category: "PURCHASE",
      processLeadTimeDays: row.procurementLeadTimeDays, cumulativeLeadTimeDays: cumulativeProductionDays + number(row.procurementLeadTimeDays), leadTimeSteps: steps,
      latestPrDate: row.latestPrDate, procurementWindow: row.procurementWindow,
    };
  });
  const materialCoveredByRequiredDate = coverage.covered === true;
  const hasPurchaseMaterial = context.componentRequirements.length > 0;
  const procurementLeadTimeDaysApplied = materialCoveredByRequiredDate || !hasPurchaseMaterial
    ? 0
    : Math.max(timeline.purchasingSchedule?.totalLeadTimeDays || 0, ...materialCoverage.map((row) => number(row.procurementLeadTimeDays)));
  const materialStagingDays = Math.max(number(input.materialStagingDays), 0);
  const scheduledProductionLeadTimeDays = Math.max(number(productionLeadTimeBreakdown?.productionLeadTimeDays), timeline.processTimeline.reduce((sum, row) => sum + number(row.durationDays), 0));
  const exactProductionLeadTimeDays = Math.max(number(productionLeadTimeBreakdown?.exactProductionLeadTimeDays), timeline.processTimeline.reduce((sum, row) => sum + number(row.durationDays), 0));
  const productionHoursPerDay = capacityPolicy.hoursPerShift * capacityPolicy.shiftsPerDay;
  const exactProductionLeadTimeHours = exactProductionLeadTimeDays * productionHoursPerDay;
  const earliestMaterialAvailableDate = addWorkingDays(timeline.today, procurementLeadTimeDaysApplied, holidays);
  const earliestProductionStartDate = addWorkingDays(earliestMaterialAvailableDate, materialStagingDays, holidays);
  const leadTimeEarliestFgDate = addWorkingHours(earliestProductionStartDate, exactProductionLeadTimeHours, { calendar: input.productionCalendar || {}, hoursPerDay: productionHoursPerDay });
  const capacityEarliestFgDate = asDate(capacity?.earliestFeasibleCompletion);
  const earliestFeasibleFgDate = capacityEarliestFgDate && capacityEarliestFgDate > leadTimeEarliestFgDate ? capacityEarliestFgDate : leadTimeEarliestFgDate;
  const dispatchDays = Math.max(number(input.dispatchDays ?? 1), 0);
  const earliestFeasibleDeliveryDate = addDays(earliestFeasibleFgDate, dispatchDays);
  const deliveryAdvanceDays = Math.max(Math.floor((timeline.requestedDeliveryDate - earliestFeasibleDeliveryDate) / 86400000), 0);
  const canDeliverEarlier = deliveryAdvanceDays > 0;
  const feasibilityTimeline = { ...timeline, earliestFeasibleFgDate, earliestFeasibleDeliveryDate };
  const baseClassification = classifyFeasibility({ timeline: feasibilityTimeline, capacity, masterDataComplete: context.masterDataComplete, materialCovered: coverage.covered });
  const waivedRisks = [
    !leadTimeControls.supplierLeadTime && { code: "SUPPLIER_LEAD_TIME_WAIVED", label: "Lead time supplier", approvalRole: "PPIC" },
    !leadTimeControls.receivingQc && { code: "RECEIVING_QC_WAIVED", label: "Receiving QC", approvalRole: "PPIC / QC" },
    !leadTimeControls.safety && { code: "SAFETY_LEAD_TIME_WAIVED", label: "Safety lead time", approvalRole: "PPIC" },
    ...vendorAdjustment.shortened.map((row) => ({ code: "VENDOR_PROCESS_SHORTENED", label: `${row.processCode || row.processName || "Vendor process"} ${row.vendorCode || row.vendorName || ""} dipersingkat ${row.masterDurationHours.toFixed(2)} menjadi ${row.adjustedDurationHours.toFixed(2)} jam`, approvalRole: "PPIC / Purchasing", vendorProcessKey: row.key })),
  ].filter(Boolean);
  const classification = waivedRisks.length && baseClassification.status === "FEASIBLE"
    ? { ...baseClassification, status: "AT_RISK", criticalConstraint: "RISK_WAIVER" }
    : baseClassification;
  const earliestFgCalculation = {
    method: String(input.sourceType || "").toUpperCase() === "FORECAST" ? "FORECAST_TWO_SHIFT_HOURLY_EARLIEST_FG_V2" : "PURCHASE_SUGGESTION_HOURLY_DUE_DATE_V5",
    calculationAnchorDate: timeline.today,
    materialCoverageBasis: materialCoveredByRequiredDate ? "STOCK_OR_OPEN_SUPPLY_COVERED" : hasPurchaseMaterial ? "PURCHASING_LEAD_TIME_REQUIRED" : "NO_PURCHASE_MATERIAL",
    procurementLeadTimeDaysApplied,
    procurementLeadTimeBreakdown: timeline.purchasingSchedule?.leadTimeBreakdown || null,
    earliestMaterialAvailableDate,
    materialStagingDays,
    earliestProductionStartDate,
    exactProductionLeadTimeDays,
    exactProductionLeadTimeHours,
    scheduledProductionLeadTimeDays,
    productionHoursPerDay,
    baselineProductionLeadTimeDays: number(productionLeadTimeBreakdown?.baselineProductionLeadTimeDays ?? scheduledProductionLeadTimeDays),
    capacityShiftsPerDay: capacityPolicy.shiftsPerDay,
    capacityHoursPerShift: capacityPolicy.hoursPerShift,
    leadTimeEarliestFgDate,
    capacityEarliestFgDate,
    capacityDateApplied: Boolean(capacityEarliestFgDate && capacityEarliestFgDate > leadTimeEarliestFgDate),
    earliestFeasibleFgDate,
    dispatchDays,
    earliestFeasibleDeliveryDate,
    canDeliverEarlier,
    deliveryAdvanceDays,
    capacityAssumption: { ...capacityPolicy, finiteCapacitySimulated: Boolean(input.planNumber), loadAware: Boolean(input.planNumber) },
  };
  const result = {
    ...classification,
    requestedDeliveryDate: timeline.requestedDeliveryDate,
    fgRequiredDate: timeline.fgRequiredDate,
    earliestFeasibleFgDate,
    exactProductionLeadTimeHours,
    earliestFeasibleDeliveryDate,
    canDeliverEarlier,
    deliveryAdvanceDays,
    capacityAssumption: { ...capacityPolicy, finiteCapacitySimulated: Boolean(input.planNumber), loadAware: Boolean(input.planNumber) },
    productionLatestStartDate: timeline.productionLatestStartDate,
    materialRequiredDate: timeline.materialRequiredDate,
    supplierRequiredArrivalDate: timeline.supplierRequiredArrivalDate,
    latestPrDate: timeline.latestPrDate,
    vendorSendDate: timeline.vendorSendDate,
    vendorReturnDate: timeline.vendorReturnDate,
    criticalConstraint: classification.criticalConstraint,
    requiresRiskApproval: waivedRisks.length > 0,
    waivedRisks,
    procurementWindow: timeline.purchasingSchedule?.procurementWindow || null,
    constraintDetails: { rootPartCode: context.part?.partCode || input.partCode, bomNumber: context.mbomHeader?.noReg || null, bomTrace: context.bomTrace, leadTimeTrace: [...productionLeadTimeTrace, ...purchasingLeadTimeTrace], productionLeadTimeBreakdown, procurementLeadTimeBreakdown: timeline.purchasingSchedule?.leadTimeBreakdown || null, earliestFgCalculation, capacityAssumption: { ...capacityPolicy, finiteCapacitySimulated: Boolean(input.planNumber), loadAware: Boolean(input.planNumber) }, processTimeline: timeline.processTimeline, capacityBlockers: capacity?.blockers || [], supplierLeadTimeDays: leadTimeControls.supplierLeadTime ? context.supplierLeadTimeDays : 0, leadTimeControls, supplierStrategy, supplierSelections, supplierAlternatives: context.componentRequirements.map((row) => ({ partCode: row.partCode, partName: row.partName, selectedSupplierItemId: row.supplierItemId, selectedSupplierCode: row.supplierCode, selectedSupplierName: row.supplierName, selectionSource: row.supplierSelectionSource, options: row.supplierOptions || [] })), vendorProcesses: vendorAdjustment.vendorProcesses, vendorProcessAdjustments: vendorAdjustment.adjustments, vendorAdjustmentApplied: vendorAdjustment.adjustments.length > 0, waivedRisks, requiresRiskApproval: waivedRisks.length > 0, materialCoverage, materialShortages: coverage.shortages.map((shortage) => materialCoverage.find((row) => row.partCode === shortage.partCode) || shortage) },
    simulatedAt: new Date(),
  };
  result.constraintDetails.recoveryRecommendation = buildDueDateRecoveryChecklist(result);
  return result;
}

module.exports = { calculateLeadTimeFeasibility, classifyFeasibility, assessDemandFeasibility, subtractWorkingDays, addWorkingHours, subtractWorkingHours, processDurationDays, feasibilityCapacityPolicy, applyShiftCapacityToProductionLeadTime, applyVendorProcessAdjustments, applyVendorAdjustmentsToProcessSteps, vendorProcessKey, normalizeVendorProcessAdjustments, loadMaterialCoverage, explodeDemandBom, purchaseSuggestionRoutingMetric, normalizeLeadTimeControls, resolveSupplierItem, supplierLeadTime };
