const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_PLAN_STATUSES = ["Draft", "Confirmed", "Released", "In Progress"];
const ACTIVE_SCHEDULE_STATUSES = ["Draft", "Released", "In Progress", "Completed"];
const { getFormulaSet, evaluateFromSet } = require("../masterFormulaService");
const { findPreset, findActivePreset, presetCapacityQuery, shiftDurationMinutes } = require("./capacitySimulationPresetService");
const {
  canonicalizeRoutingOperations,
  compareRoutingOperations,
} = require("../../utils/routingSequence");
const { isDiscreteUom, normalizeQuantity } = require("../../utils/uomQuantity");
const { intervalsOverlap, isDiesCapacityBlockingEnabled, isDiesTonnageCompatible, isPressResource, maintenanceInterval, plannedInterval } = require("./diesCapacityService");
const { buildProductionMaterialGate, materialGateForJob } = require("./materialReadinessService");
const { loadDemandPlanningConstraintMap, effectiveVendorLeadTime } = require("./demandPlanningConstraintService");
const { calculateShiftMinutes } = require("./workingHourCalendarService");

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value, digits = 2) => Number(number(value).toFixed(digits));
const capacityQty = (value, uomCode) => normalizeQuantity(round(value, 3), uomCode);
const capacityQtyText = (value, uomCode) => String(capacityQty(value, uomCode));
const bool = (value, fallback = false) => value === undefined || value === null || value === "" ? fallback : ![false, 0, "0", "false", "no", "off"].includes(typeof value === "string" ? value.trim().toLowerCase() : value);
const COVERAGE_EPSILON = 0.00001;
const MONTHLY_PLAN_RUNTIME_ALLOWANCE_FACTOR = 1.2;
const UNSCHEDULED_NOTICE_CODES = new Set([
  "PLAN_ROUTING_MISSING",
  "PLAN_MACHINE_MISSING",
  "PLAN_CYCLE_MISSING",
  "PLAN_CAPACITY_SHORTAGE",
  "MPP_ROUTE_ALLOCATION_INCOMPLETE",
]);

function applyUnscheduledNoticePolicy(issues, unscheduled) {
  for (const item of unscheduled) {
    item.severity = "warning";
    item.noticeCode = "UNSCHEDULED_FOLLOW_UP";
    item.requiresFollowUp = true;
  }
  for (const issue of issues) {
    if (!UNSCHEDULED_NOTICE_CODES.has(issue.code)) continue;
    issue.severity = "warning";
    issue.category = "UNSCHEDULED";
    issue.noticeCode = "UNSCHEDULED_FOLLOW_UP";
    issue.requiresFollowUp = true;
    issue.resolution = issue.resolution || "Plan tetap dapat dilanjutkan; lengkapi routing, mesin, cycle time, atau kapasitas pada review berikutnya.";
  }
}

function capacityOperationCode(route = {}) {
  return route.occurrenceCode || route.process?.processCode || route.processCode || null;
}

function capacityPlanRouteKey(planNumber, lineNumber, mbomProcessId, processId) {
  return `${planNumber}|${lineNumber}|${mbomProcessId || `PROCESS:${processId || "UNMAPPED"}`}`;
}

function findRouteWorkOrder(workOrders = [], route = {}) {
  const exact = workOrders.find((workOrder) => workOrder.mbomProcessId === route.id);
  if (exact) return exact;
  const sameProcess = workOrders.filter((workOrder) => workOrder.processId === route.processId);
  const sameSequence = sameProcess.find((workOrder) => number(workOrder.sequence) === number(route.sequence));
  return sameSequence || (sameProcess.length === 1 ? sameProcess[0] : null);
}

function mrpTargetKey(detail) {
  return String(detail?.notes || "").match(/\[MRP-TARGET:([^\]]+)\]/)?.[1] || null;
}

function predecessorQuantityStatus(predecessorOutput, predecessorPlanQty, successorQty, successorPlanQty, predecessorUomCode, successorUomCode) {
  const output = number(predecessorOutput);
  const required = number(successorQty);
  const predecessorTarget = number(predecessorPlanQty);
  const successorTarget = number(successorPlanQty);
  if (predecessorTarget > 0 && successorTarget > 0) {
    const predecessorCoverage = output / predecessorTarget;
    const successorCoverage = required / successorTarget;
    // A discrete allocation is rounded independently on each MPP line. The
    // same delivery phase can therefore differ by at most half a unit on both
    // sides of a predecessor edge (for example 57/172 vs 79/236 PCS). Treat
    // that quantisation interval as equal coverage, while retaining the strict
    // ratio comparison for continuous UOMs such as KG.
    const discreteCoverageTolerance = isDiscreteUom(predecessorUomCode) && isDiscreteUom(successorUomCode)
      ? (0.5 / predecessorTarget) + (0.5 / successorTarget)
      : 0;
    return {
      mode: "COVERAGE",
      predecessorCoverage,
      successorCoverage,
      coverageTolerance: discreteCoverageTolerance,
      short: predecessorCoverage + discreteCoverageTolerance + COVERAGE_EPSILON < successorCoverage,
    };
  }
  return { mode: "RAW_QTY", predecessorCoverage: null, successorCoverage: null, short: output + 0.000001 < required };
}

function logicalPredecessorGroupKey(allocation = {}) {
  const planNumber = allocation.plan?.planNumber || allocation.planNumber || "NO_PLAN";
  const lineNumber = allocation.lineNumber ?? "NO_LINE";
  const routeId = allocation.mbomProcessId || allocation.mbomProcess?.id || allocation.mbomProcess?.processId || "NO_ROUTE";
  const phase = allocation.deliveryPhaseId
    ? `ID:${allocation.deliveryPhaseId}`
    : allocation.deliveryPhaseNumber != null
      ? `NUMBER:${allocation.deliveryPhaseNumber}`
      : "NO_PHASE";
  return `${planNumber}|${lineNumber}|${routeId}|${phase}`;
}

/**
 * A successor can legitimately depend on several finite-capacity chunks from
 * the same routing operation. Quantity readiness belongs to that logical
 * route/MPP-line/delivery-phase, not to each physical chunk. Only chunks that
 * finish no later than the successor start can contribute available WIP.
 */
function predecessorOutputQuantity(predecessor = {}) {
  return String(predecessor.routingMode || "INHOUSE").toUpperCase() === "VENDOR"
    ? number(predecessor.expectedReturnQty ?? predecessor.plannedQty)
    : number(predecessor.plannedQty);
}

function ensurePredecessorWipEntry(wipState, predecessor, outputQty = predecessorOutputQuantity(predecessor)) {
  if (!(wipState instanceof Map) || predecessor?.id == null) return null;
  const allocationId = String(predecessor.id);
  let entry = wipState.get(allocationId);
  if (!entry) {
    entry = {
      allocationId: predecessor.id,
      originalOutputQty: number(outputQty),
      remainingOutputQty: number(outputQty),
      reservations: [],
    };
    wipState.set(allocationId, entry);
  }
  return entry;
}

function groupPredecessorAllocations(predecessors = [], successorStart, wipState = null) {
  const start = successorStart instanceof Date ? successorStart : new Date(successorStart);
  const startTime = start.getTime();
  const groups = new Map();
  const seenAllocationIds = new Set();

  for (const predecessor of predecessors) {
    const allocationId = predecessor?.id == null ? null : String(predecessor.id);
    if (allocationId && seenAllocationIds.has(allocationId)) continue;
    if (allocationId) seenAllocationIds.add(allocationId);
    const vendorMode = String(predecessor.routingMode || "INHOUSE").toUpperCase() === "VENDOR";
    const finishAt = vendorMode
      ? allocationMoment(predecessor.vendorReturnDate || predecessor.scheduleDate, predecessor.plannedEndTime, true)
      : allocationMoment(predecessor.scheduleDate, predecessor.plannedEndTime, true);
    const originalOutputQty = predecessorOutputQuantity(predecessor);
    const wipEntry = ensurePredecessorWipEntry(wipState, predecessor, originalOutputQty);
    const outputQty = wipEntry ? Math.max(number(wipEntry.remainingOutputQty), 0) : originalOutputQty;
    const reservedOutputQty = Math.max(originalOutputQty - outputQty, 0);
    const finishedBeforeSuccessor = Number.isFinite(startTime) && finishAt.getTime() <= startTime;
    const key = logicalPredecessorGroupKey(predecessor);
    const current = groups.get(key) || {
      key,
      planNumber: predecessor.plan?.planNumber || predecessor.planNumber || null,
      lineNumber: predecessor.lineNumber ?? null,
      routeId: predecessor.mbomProcessId || predecessor.mbomProcess?.id || null,
      deliveryPhaseId: predecessor.deliveryPhaseId || null,
      deliveryPhaseNumber: predecessor.deliveryPhaseNumber ?? null,
      processCode: predecessor.mbomProcess?.process?.processCode || null,
      uomCode: predecessor.uomCode || null,
      availableOutputQty: 0,
      lateOutputQty: 0,
      linkedOutputQty: 0,
      grossLinkedOutputQty: 0,
      reservedOutputQty: 0,
      finishedBatchCount: 0,
      lateBatchCount: 0,
      batches: [],
    };

    current.linkedOutputQty += outputQty;
    current.grossLinkedOutputQty += originalOutputQty;
    current.reservedOutputQty += reservedOutputQty;
    if (finishedBeforeSuccessor) {
      current.availableOutputQty += outputQty;
      current.finishedBatchCount += 1;
    } else {
      current.lateOutputQty += outputQty;
      current.lateBatchCount += 1;
    }
    current.batches.push({
      allocationId: predecessor.id,
      transferBatchNumber: predecessor.transferBatchNumber ?? null,
      outputQty: round(outputQty, 3),
      originalOutputQty: round(originalOutputQty, 3),
      reservedOutputQty: round(reservedOutputQty, 3),
      uomCode: predecessor.uomCode || null,
      finishAt,
      finishedBeforeSuccessor,
      priorReservations: (wipEntry?.reservations || []).map((reservation) => ({ ...reservation })),
    });
    groups.set(key, current);
  }

  return [...groups.values()].map((group) => ({
    ...group,
    availableOutputQty: round(group.availableOutputQty, 3),
    lateOutputQty: round(group.lateOutputQty, 3),
    linkedOutputQty: round(group.linkedOutputQty, 3),
    grossLinkedOutputQty: round(group.grossLinkedOutputQty, 3),
    reservedOutputQty: round(group.reservedOutputQty, 3),
    batches: group.batches.sort((left, right) => left.finishAt - right.finishAt
      || String(left.allocationId).localeCompare(String(right.allocationId))),
  })).sort((left, right) => left.key.localeCompare(right.key));
}

/**
 * Reserve physical predecessor output for one successor. The caller processes
 * successors chronologically, so an earlier successor always owns its WIP
 * first. Every reservation is stored against the physical allocation id; this
 * prevents the same split batch from being counted again through another set
 * of dependency links.
 */
function reservePredecessorGroupOutput(group, requiredOutputQty, successor = {}, wipState) {
  const requiredQty = Math.max(number(requiredOutputQty), 0);
  let outstandingQty = requiredQty;
  const batchReservations = [];

  for (const batch of group?.batches || []) {
    if (outstandingQty <= COVERAGE_EPSILON) break;
    const entry = wipState instanceof Map ? wipState.get(String(batch.allocationId)) : null;
    const remainingQty = entry ? Math.max(number(entry.remainingOutputQty), 0) : Math.max(number(batch.outputQty), 0);
    const reservedQty = Math.min(remainingQty, outstandingQty);
    if (reservedQty <= COVERAGE_EPSILON) continue;
    const reservation = {
      predecessorAllocationId: batch.allocationId,
      successorAllocationId: successor.id || successor.allocationId || null,
      successorStartAt: successor.startAt instanceof Date ? successor.startAt.toISOString() : successor.startAt || null,
      reservedQty: round(reservedQty, 3),
      finishedBeforeSuccessor: Boolean(batch.finishedBeforeSuccessor),
    };
    if (entry) {
      entry.remainingOutputQty = Math.max(number(entry.remainingOutputQty) - reservedQty, 0);
      entry.reservations.push(reservation);
    }
    batchReservations.push({ ...reservation, finishAt: batch.finishAt });
    outstandingQty -= reservedQty;
  }

  const readyReservedQty = batchReservations
    .filter((reservation) => reservation.finishedBeforeSuccessor)
    .reduce((sum, reservation) => sum + number(reservation.reservedQty), 0);
  const lateReservedQty = batchReservations
    .filter((reservation) => !reservation.finishedBeforeSuccessor)
    .reduce((sum, reservation) => sum + number(reservation.reservedQty), 0);
  return {
    requiredQty: round(requiredQty, 3),
    reservedQty: round(requiredQty - Math.max(outstandingQty, 0), 3),
    readyReservedQty: round(readyReservedQty, 3),
    lateReservedQty: round(lateReservedQty, 3),
    unreservedQty: round(Math.max(outstandingQty, 0), 3),
    batchReservations,
  };
}

function predecessorGroupReadiness(group, predecessorPlanQty, successorQty, successorPlanQty, successorUomCode) {
  const quantityStatus = predecessorQuantityStatus(
    group?.availableOutputQty,
    predecessorPlanQty,
    successorQty,
    successorPlanQty,
    group?.uomCode,
    successorUomCode,
  );
  const linkedQuantityStatus = predecessorQuantityStatus(
    group?.linkedOutputQty,
    predecessorPlanQty,
    successorQty,
    successorPlanQty,
    group?.uomCode,
    successorUomCode,
  );
  return {
    status: !quantityStatus.short
      ? "READY"
      : number(group?.lateBatchCount) > 0 && !linkedQuantityStatus.short
        ? "TIMING_BLOCKED"
        : "QTY_BLOCKED",
    quantityStatus,
    linkedQuantityStatus,
  };
}

function parseDateOnly(value, fallback = new Date()) {
  const source = value || fallback;
  const parsed = source instanceof Date ? new Date(source) : new Date(`${String(source).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return parseDateOnly(fallback, new Date());
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function dateKey(value) {
  return parseDateOnly(value).toISOString().slice(0, 10);
}

function addDays(value, days) {
  return new Date(parseDateOnly(value).getTime() + days * DAY_MS);
}

function recommendationRouteInputs(route = {}) {
  return (route.mbomDetail?.children || [])
    .filter((child) => !child.isDeleted && child.part?.partCode && number(child.qty) > 0)
    .map((child) => ({
      partId: child.part.id || child.partId || null,
      partCode: child.part.partCode,
      itemType: String(child.part.itemType || child.part.partType || "").toUpperCase(),
      qtyPerOutput: number(child.qty),
    }))
    .sort((left, right) => {
      const priority = (item) => item.itemType === "WIP" ? 0 : item.itemType === "FG" ? 1 : 2;
      return priority(left) - priority(right) || left.partCode.localeCompare(right.partCode);
    });
}

function recommendationPrimaryInput(route = {}) {
  return recommendationRouteInputs(route)[0] || null;
}

function buildMachineWorkCenterMap(workCenters = []) {
  const result = new Map();
  for (const center of workCenters) {
    if (!center?.id) continue;
    for (const link of center.machines || []) {
      const machineId = link.machine?.id || link.machineId || link.id;
      if (!machineId) continue;
      result.set(machineId, {
        workCenterId: center.id,
        matrixRowKey: `WC:${center.id}`,
      });
    }
  }
  return result;
}

function summarizeChildFgConversionHistory(movements = []) {
  const convertedQtyByReceiptLine = {};
  const legacyConvertedQtyByPlanPart = {};
  for (const movement of movements || []) {
    const qty = Math.max(number(movement.qty), 0);
    if (qty <= 0) continue;
    const marker = String(movement.notes || "").match(/\[CHILD-FG-RECEIPT:([^\]]+)\]/)?.[1];
    if (!marker) continue;
    const segments = marker.split(":");
    if (segments.length >= 3) {
      const receiptLineId = segments[1];
      convertedQtyByReceiptLine[receiptLineId] = round(number(convertedQtyByReceiptLine[receiptLineId]) + qty, 6);
      continue;
    }
    if (segments.length === 2) {
      const key = `${segments[0]}|${movement.partCode || segments[1]}`;
      legacyConvertedQtyByPlanPart[key] = round(number(legacyConvertedQtyByPlanPart[key]) + qty, 6);
    }
  }
  return { convertedQtyByReceiptLine, legacyConvertedQtyByPlanPart };
}

function buildRecommendationMaterial({
  stockRows = [],
  allocations = [],
  childFgReceiptLines = [],
  childFgFinalWipByFg = {},
  childFgConvertedQtyByReceiptLine = {},
  childFgLegacyConvertedQtyByPlanPart = {},
} = {}) {
  const openingStock = {};
  for (const row of [...stockRows].sort((left, right) => String(left.partCode).localeCompare(String(right.partCode)))) {
    if (!row.partCode) continue;
    openingStock[row.partCode] = round(number(openingStock[row.partCode]) + Math.max(number(row._sum?.qtyAvailable ?? row.qtyAvailable), 0), 6);
  }
  const receipts = [];
  const consumptions = [];
  const legacyRemaining = new Map(Object.entries(childFgLegacyConvertedQtyByPlanPart || {}).map(([key, qty]) => [key, Math.max(number(qty), 0)]));
  const orderedChildReceipts = [...(childFgReceiptLines || [])].sort((left, right) =>
    dateKey(left.requiredDate || left.fgRequiredDate).localeCompare(dateKey(right.requiredDate || right.fgRequiredDate))
    || number(left.lineNumber) - number(right.lineNumber)
    || String(left.id || "").localeCompare(String(right.id || "")));
  for (const receiptLine of orderedChildReceipts) {
    const fgPartCode = receiptLine.partCode;
    const finalWipPartCode = childFgFinalWipByFg?.[fgPartCode];
    if (!fgPartCode || !finalWipPartCode || !receiptLine.id) continue;
    const legacyKey = `${receiptLine.planNumber || ""}|${fgPartCode}`;
    const legacyQty = number(legacyRemaining.get(legacyKey));
    const exactConvertedQty = Math.max(number(childFgConvertedQtyByReceiptLine?.[receiptLine.id]), 0);
    const authorizationAfterExact = Math.max(number(receiptLine.qtyPlanned) - exactConvertedQty, 0);
    const legacyAppliedQty = Math.min(authorizationAfterExact, legacyQty);
    legacyRemaining.set(legacyKey, Math.max(legacyQty - legacyAppliedQty, 0));
    const remainingAuthorization = Math.max(authorizationAfterExact - legacyAppliedQty, 0);
    const finalWipAvailable = Math.max(number(openingStock[finalWipPartCode]), 0);
    const projectedQty = Math.min(remainingAuthorization, finalWipAvailable);
    if (projectedQty <= 0) continue;
    openingStock[finalWipPartCode] = round(finalWipAvailable - projectedQty, 6);
    receipts.push({
      partCode: fgPartCode,
      date: "0000-01-01",
      qty: round(projectedQty, 6),
      sourceId: `CHILD_FG_CONVERSION:${receiptLine.id}`,
      sourceType: "PROJECTED_CHILD_FG_RECEIPT",
      receiptLineId: receiptLine.id,
      receiptLineNumber: receiptLine.lineNumber ?? null,
      deliveryPhaseId: receiptLine.deliveryPhaseId || null,
      sourcePartCode: finalWipPartCode,
    });
  }
  for (const allocation of allocations) {
    const route = allocation.mbomProcess || {};
    const availabilityDate = allocation.vendorReturnDate || allocation.scheduleDate;
    const outputPartCode = route.mbomDetail?.part?.partCode;
    const outputQty = Math.max(number(allocation.expectedReturnQty ?? allocation.plannedQty), 0);
    if (outputPartCode && availabilityDate && outputQty > 0) {
      receipts.push({
        partCode: outputPartCode,
        date: dateKey(addDays(availabilityDate, 1)),
        qty: outputQty,
        sourceAllocationId: allocation.id || null,
      });
    }
    for (const input of recommendationRouteInputs(route)) {
      const consumptionQty = Math.max(number(allocation.plannedQty) * input.qtyPerOutput, 0);
      if (!allocation.scheduleDate || consumptionQty <= 0) continue;
      consumptions.push({
        partCode: input.partCode,
        date: dateKey(allocation.scheduleDate),
        qty: consumptionQty,
        sourceAllocationId: allocation.id || null,
      });
    }
  }
  const compare = (left, right) => left.date.localeCompare(right.date) || left.partCode.localeCompare(right.partCode) || String(left.sourceAllocationId || "").localeCompare(String(right.sourceAllocationId || ""));
  receipts.sort(compare);
  consumptions.sort(compare);
  return { openingStock, receipts, consumptions };
}

function allocationMoment(date, time, endOfDay = false) {
  const day = dateKey(date);
  const clock = /^\d{2}:\d{2}/.test(String(time || ""))
    ? String(time).slice(0, 5)
    : endOfDay ? "23:59" : "00:00";
  return new Date(`${day}T${clock}:00.000Z`);
}

function allocationStartMoment(allocation = {}) {
  return String(allocation.routingMode || "INHOUSE").toUpperCase() === "VENDOR"
    ? allocationMoment(allocation.vendorSendDate || allocation.scheduleDate, allocation.plannedStartTime, false)
    : allocationMoment(allocation.scheduleDate, allocation.plannedStartTime, false);
}

function allocationFinishMoment(allocation = {}) {
  return String(allocation.routingMode || "INHOUSE").toUpperCase() === "VENDOR"
    ? allocationMoment(allocation.vendorReturnDate || allocation.scheduleDate, allocation.plannedEndTime, true)
    : allocationMoment(allocation.scheduleDate, allocation.plannedEndTime, true);
}

function crossPlanPredecessorStatus(predecessor, successor) {
  if (!predecessor?.plan || !successor?.plan || predecessor.plan.planNumber === successor.plan.planNumber) return null;
  if (!predecessor.plan.sourceType || predecessor.plan.sourceType !== successor.plan.sourceType) return "SOURCE_MISMATCH";
  return allocationFinishMoment(predecessor) <= allocationStartMoment(successor)
    ? "READY"
    : "LATE";
}

function resolveVendorReturnDeadline(allocation = {}, allocations = []) {
  const directSuccessors = allocations
    .filter((candidate) => {
      const predecessorIds = Array.isArray(candidate?.predecessorAllocationIds)
        ? candidate.predecessorAllocationIds.map(String)
        : [];
      return predecessorIds.includes(String(allocation.id))
        && candidate?.plan?.planNumber === allocation?.plan?.planNumber;
    })
    .map((candidate) => ({ allocation: candidate, deadline: allocationStartMoment(candidate) }))
    .filter((candidate) => Number.isFinite(candidate.deadline.getTime()))
    .sort((left, right) => left.deadline - right.deadline || String(left.allocation.id).localeCompare(String(right.allocation.id)));

  if (directSuccessors.length) {
    const successor = directSuccessors[0];
    return {
      deadline: successor.deadline,
      source: "SUCCESSOR_START",
      successorAllocationId: successor.allocation.id,
      successorProcessCode: successor.allocation.mbomProcess?.process?.processCode || null,
    };
  }

  // Child MPP requiredDate is the beginning of the full production chain, not
  // a vendor-return deadline. A terminal vendor route instead uses the
  // authoritative backward-pass/FG deadline stored on the allocation.
  const fallback = [
    [allocation.latestFinishDate, "ROUTE_LATEST_FINISH"],
    [allocation.fgRequiredDate, "FG_REQUIRED"],
    [allocation.customerTargetDate, "CUSTOMER_TARGET"],
  ].find(([value]) => value);
  if (!fallback) return null;

  return {
    deadline: allocationMoment(fallback[0], null, true),
    source: fallback[1],
    successorAllocationId: null,
    successorProcessCode: null,
  };
}

function compareAllocationConsumptionOrder(left, right) {
  return allocationStartMoment(left) - allocationStartMoment(right)
    || String(left?.id || "").localeCompare(String(right?.id || ""));
}

function resolveRange(query = {}) {
  const today = parseDateOnly(new Date());
  const defaultStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const defaultEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  const start = parseDateOnly(query.startDate, defaultStart);
  let end = parseDateOnly(query.endDate, defaultEnd);
  if (end < start) end = start;
  if ((end - start) / DAY_MS > 61) end = addDays(start, 61);
  const dates = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) dates.push(dateKey(cursor));
  return { start, end, endExclusive: addDays(end, 1), dates };
}

function resolveCycleMinutes(routeCycle, machine, availableMinutes) {
  if (number(routeCycle) > 0) return number(routeCycle) / 60;
  if (number(machine?.cycleTime) > 0) return number(machine.cycleTime) / 60;
  const rate = number(machine?.capacity);
  const unit = String(machine?.capacityUnit || "").toLowerCase();
  if (rate <= 0) return 0;
  if (/jam|hour|hr/.test(unit)) return 60 / rate;
  if (/menit|minute|min/.test(unit)) return 1 / rate;
  if (/hari|day/.test(unit)) return availableMinutes / rate;
  return 0;
}

function machineCell(machine, key, baseAvailableMinutes) {
  return {
    date: key,
    baseAvailableMinutes: machine.status === "Active" ? baseAvailableMinutes : 0,
    availableMinutes: machine.status === "Active" ? baseAvailableMinutes : 0,
    downtimeMinutes: 0,
    firmMinutes: 0,
    proposedMinutes: 0,
    actualMinutes: 0,
    loadMinutes: 0,
    loadPercent: 0,
    status: machine.status === "Active" && baseAvailableMinutes > 0 ? "available" : "unavailable",
    items: [],
  };
}

function overtimeMinutes(start, end) {
  if (!start || !end) return 0;
  const [startHour, startMinute] = String(start).split(":").map(Number);
  const [endHour, endMinute] = String(end).split(":").map(Number);
  if (![startHour, startMinute, endHour, endMinute].every(Number.isFinite)) return 0;
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  return endMinutes >= startMinutes ? endMinutes - startMinutes : endMinutes + 1440 - startMinutes;
}

function resolveDailyCapacity({
  key,
  override,
  shiftHours,
  defaultShiftsPerDay,
  defaultOvertimeHours,
  efficiencyPercent,
  includeSaturday,
  includeSunday,
  formulas,
}) {
  const hasOverride = Boolean(override);
  const dayStatus = hasOverride ? String(override.dayStatus || "WORKING").toUpperCase() : "DEFAULT";
  const day = parseDateOnly(key).getUTCDay();
  const weekendClosed = !hasOverride && ((day === 6 && !includeSaturday) || (day === 0 && !includeSunday));
  const shiftsPerDay = hasOverride
    ? Math.min(Math.max(override.shiftsPerDay == null ? defaultShiftsPerDay : number(override.shiftsPerDay), 0), 3)
    : defaultShiftsPerDay;
  // A saved machine-date rule replaces the scenario overtime. An empty
  // overtime range therefore explicitly means zero overtime for that date.
  const dailyOvertimeMinutes = hasOverride
    ? overtimeMinutes(override.overtimeStart, override.overtimeEnd)
    : defaultOvertimeHours * 60;
  const isClosed = dayStatus === "HOLIDAY" || shiftsPerDay <= 0 || weekendClosed;
  const shiftOverrides = hasOverride && Array.isArray(override.shiftOverrides) ? override.shiftOverrides : [];
  const overrideWorkingMinutes = shiftOverrides.reduce((sum, shift) => sum
    + calculateShiftMinutes(shift.startTime, shift.endTime, shift.breakMinutes)
    + number(shift.overtimeMinutes), 0);
  const effectiveShiftHours = hasOverride && number(override.shiftHours) > 0 ? number(override.shiftHours) : shiftHours;
  const availableMinutes = isClosed
    ? 0
    : shiftOverrides.length
      ? round((overrideWorkingMinutes + dailyOvertimeMinutes) * efficiencyPercent / 100, 2)
      : round(evaluateFromSet(formulas, "CAPACITY_BASE_MINUTES", {
      shiftHours: effectiveShiftHours,
      shiftsPerDay,
      overtimeMinutes: dailyOvertimeMinutes,
      efficiencyPercent,
    }), 2);

  return {
    source: hasOverride ? "DAILY_OVERRIDE" : "SCENARIO_DEFAULT",
    dayStatus: isClosed ? "HOLIDAY" : dayStatus === "OVERLOAD" ? "OVERLOAD" : "WORKING",
    shiftsPerDay,
    shiftHours: effectiveShiftHours,
    overtimeMinutes: dailyOvertimeMinutes,
    shifts: shiftOverrides,
    efficiencyPercent,
    availableMinutes,
  };
}

function pushIssue(target, issue, seen) {
  const key = [issue.code, issue.planNumber, issue.lineNumber, issue.partCode, issue.processCode, issue.routeId, issue.machineCode, issue.diesCode, issue.allocationId, issue.relatedAllocationId, issue.relatedScheduleId].join("|");
  if (seen.has(key)) return;
  seen.add(key);
  target.push({
    category: issue.category || "CAPACITY",
    canOverride: issue.canOverride ?? issue.severity === "overridable",
    resolution: issue.resolution || null,
    ...issue,
  });
}

async function buildCapacitySnapshot(prisma, query = {}) {
  const planningMode = String(query.planningMode || "PRODUCTION").toUpperCase() === "SIMULATION" ? "SIMULATION" : "PRODUCTION";
  const scenarioKey = planningMode === "SIMULATION" ? String(query.presetId || query.scenarioKey || "").trim() || null : null;
  const presetId = String(query.presetId || scenarioKey || "").trim() || null;
  const selectedPreset = presetId
    ? await findPreset(prisma, presetId)
    : planningMode === "PRODUCTION" ? await findActivePreset(prisma) : null;
  const effectiveQuery = selectedPreset ? { ...query, ...presetCapacityQuery(selectedPreset) } : query;
  const formulas = await getFormulaSet(prisma, "capacity");
  const range = resolveRange(effectiveQuery);
  const shiftHours = Math.min(Math.max(number(effectiveQuery.shiftHours) || 8, 1), 24);
  const shiftsPerDay = Math.min(Math.max(number(effectiveQuery.shiftsPerDay) || 2, 1), 3);
  const efficiencyPercent = Math.min(Math.max(number(effectiveQuery.efficiencyPercent) || 85, 1), 100);
  const overtimeHours = Math.min(Math.max(number(effectiveQuery.overtimeHours), 0), 12);
  const includeSaturday = bool(effectiveQuery.includeSaturday, false);
  const includeSunday = bool(effectiveQuery.includeSunday, false);
  const scenarioName = String(effectiveQuery.scenarioName || "Current").trim().slice(0, 100) || "Current";
  const planningGranularity = String(effectiveQuery.planningGranularity || "DAY").toUpperCase() === "WEEK" ? "WEEK" : "DAY";
  const rollingLookbackWeeks = Math.min(Math.max(Math.trunc(number(effectiveQuery.rollingLookbackWeeks)), 0), 12);
  const freezeFenceDays = Math.min(Math.max(Math.trunc(number(effectiveQuery.freezeFenceDays)), 0), 31);
  const freezeFenceDate = new Date();
  freezeFenceDate.setHours(0, 0, 0, 0);
  freezeFenceDate.setDate(freezeFenceDate.getDate() + freezeFenceDays);
  const workingAvailableMinutes = round(evaluateFromSet(formulas, "CAPACITY_BASE_MINUTES", {
    shiftHours,
    shiftsPerDay,
    overtimeMinutes: overtimeHours * 60,
    efficiencyPercent,
  }), 2);
  const planNumber = String(effectiveQuery.planNumber || "").trim() || null;
  const manualAllocation = bool(effectiveQuery.manualAllocation, false);
  const ignoreDraftDailyPlans = bool(effectiveQuery.ignoreDraftDailyPlans, false);
  const generatedDailyPlanMarker = planNumber ? `[PPIC-DPP:${planNumber}:` : null;

  const [machines, processes, headers, routes, schedules, downtimes, productionLogs, planDetails, machineOverrides, dayOverrides, calendarOverrides, workCenters] = await Promise.all([
    prisma.machine.findMany({
      where: { isDeleted: false },
      orderBy: [{ lineCode: "asc" }, { machineCode: "asc" }],
      select: { id: true, machineCode: true, machineName: true, machineType: true, machineFamily: true, machineTechnology: true, machineSpecificationCode: true, machineSpecificationName: true, workingHourProfileId: true, lineCode: true, location: true, status: true, capacity: true, capacityUnit: true, tonnage: true, cycleTime: true },
    }),
    prisma.process.findMany({ where: { isDeleted: false }, orderBy: { processCode: "asc" }, select: { id: true, processCode: true, processName: true } }),
    prisma.mBOMHeader.findMany({ where: { isDeleted: false }, orderBy: [{ partId: "asc" }, { revision: "desc" }, { updatedAt: "desc" }], select: { noReg: true, partId: true, revision: true } }),
    prisma.mBOMProcess.findMany({
      where: { isDeleted: false },
      include: {
        process: { select: { id: true, processCode: true, processName: true } },
        machine: { select: { id: true, machineCode: true, machineName: true, status: true, machineSpecificationCode: true, capacity: true, capacityUnit: true, cycleTime: true } },
        mbomDetail: {
          select: {
            category: true,
            partId: true,
            part: { select: { partCode: true, partName: true, itemType: true, partType: true } },
            parentDetail: { select: { partId: true, part: { select: { partCode: true, partName: true, itemType: true, partType: true } } } },
            children: {
              where: { isDeleted: false },
              select: {
                partId: true,
                qty: true,
                isDeleted: true,
                part: { select: { id: true, partCode: true, partName: true, itemType: true, partType: true } },
              },
            },
          },
        },
      },
      orderBy: [{ noReg: "asc" }, { sequence: "asc" }, { routingNumber: "asc" }],
    }),
    prisma.dailyProductionSchedule.findMany({
      where: {
        scheduleDate: { gte: range.start, lt: range.endExclusive },
        isDeleted: false,
        status: { in: ACTIVE_SCHEDULE_STATUSES },
        ...(ignoreDraftDailyPlans && generatedDailyPlanMarker
          ? { NOT: { status: "Draft", notes: { contains: generatedDailyPlanMarker } } }
          : {}),
      },
      orderBy: [{ scheduleDate: "asc" }, { shift: "asc" }, { sequence: "asc" }],
      select: { id: true, scheduleNumber: true, scheduleDate: true, shift: true, plannedStartTime: true, plannedEndTime: true, moId: true, moNumber: true, woId: true, woNumber: true, partCode: true, processId: true, mbomProcessId: true, machineId: true, diesId: true, plannedQty: true, actualQty: true, uomCode: true, sequence: true, status: true, productionPlan: { select: { planNumber: true } } },
    }),
    prisma.downtimeLog.findMany({
      where: { downtimeDate: { gte: range.start, lt: range.endExclusive }, isDeleted: false, status: { not: "Cancelled" }, machineCode: { not: null } },
      select: { downtimeNumber: true, downtimeDate: true, machineCode: true, shift: true, durationMinutes: true, reason: true, category: true, status: true },
    }),
    prisma.productionLog.findMany({
      where: { logDate: { gte: range.start, lt: range.endExclusive }, isDeleted: false, status: { notIn: ["Cancelled"] }, machineCode: { not: null } },
      select: { logNumber: true, logDate: true, shift: true, machineCode: true, processCode: true, qtyProduced: true, qtyGood: true, qtyReject: true, runningMinutes: true, startTime: true, endTime: true, moId: true, woId: true, status: true },
      orderBy: [{ logDate: "asc" }, { logNumber: "asc" }],
    }),
    prisma.monthlyProductionPlanDetail.findMany({
      where: {
        isDeleted: false,
        status: { not: "Cancelled" },
        plan: {
          isDeleted: false,
          status: { in: ACTIVE_PLAN_STATUSES },
          periodStart: { lt: range.endExclusive },
          periodEnd: { gte: range.start },
          ...(planNumber ? { planNumber } : {}),
        },
      },
      include: { plan: { select: { planNumber: true, status: true, sourceType: true, periodStart: true, periodEnd: true, recommendationSummary: true } } },
      orderBy: [{ requiredDate: "asc" }, { priority: "asc" }, { lineNumber: "asc" }],
    }),
    prisma.capacityMachineOverride.findMany({
      where: {
        isDeleted: false,
        plan: {
          isDeleted: false,
          status: { in: ACTIVE_PLAN_STATUSES },
          periodStart: { lt: range.endExclusive },
          periodEnd: { gte: range.start },
          ...(planNumber ? { planNumber } : {}),
        },
      },
      select: { lineNumber: true, mbomProcessId: true, scheduleDate: true, machineId: true, diesId: true, routingMode: true, vendorId: true, reason: true, plan: { select: { planNumber: true } } },
    }),
    prisma.capacityDayOverride.findMany({ where: { isDeleted: false, plan: planNumber ? { isDeleted: false, planNumber } : { planNumber: "__NO_PLAN_OVERRIDE__" }, scheduleDate: { gte: range.start, lt: range.endExclusive } }, select: { machineId: true, scheduleDate: true, dayStatus: true, shiftsPerDay: true, shiftOverrides: true, overtimeStart: true, overtimeEnd: true, reason: true, changedBy: true, changedAt: true } }),
    prisma.capacityCalendarOverride.findMany({ where: { isDeleted: false, scheduleDate: { gte: range.start, lt: range.endExclusive } }, select: { machineId: true, scheduleDate: true, dayStatus: true, shiftsPerDay: true, shiftOverrides: true, overtimeStart: true, overtimeEnd: true, reason: true, changedBy: true, changedAt: true } }),
    typeof prisma.workCenter?.findMany === "function"
      ? prisma.workCenter.findMany({
          where: { isActive: true },
          select: {
            id: true,
            machines: { select: { machineId: true, machine: { select: { id: true } } } },
          },
        })
      : Promise.resolve([]),
  ]);

  const globalDayOverrideByMachineDate = new Map(calendarOverrides.map((item) => [`${item.machineId}|${dateKey(item.scheduleDate)}`, { ...item, scope: "GLOBAL" }]));
  const dayOverrideByMachineDate = new Map(dayOverrides.map((item) => [`${item.machineId}|${dateKey(item.scheduleDate)}`, { ...item, scope: "PLAN" }]));
  const presetDayOverrideByDate = new Map(Object.entries(selectedPreset?.dailyOverrides || {}).map(([date, rule]) => {
    const presetShiftCount = Math.min(Math.max(rule.shiftCount == null ? 2 : number(rule.shiftCount), 0), 3);
    const activeShifts = (rule.shifts || []).slice(0, presetShiftCount);
    const shiftHoursOverride = activeShifts.length ? activeShifts.reduce((sum, shift) => sum + shiftDurationMinutes(shift), 0) / activeShifts.length / 60 : shiftHours;
    return [date, { ...rule, shiftsPerDay: presetShiftCount, shiftHours: shiftHoursOverride, scope: "CAPACITY_PRESET" }];
  }));
  const [availableDies, availableVendors] = await Promise.all([
    prisma.dies.findMany({
      where: { isDeleted: false, status: "Active" },
      select: {
        id: true, diesCode: true, diesName: true, diesType: true, tonnage: true, cavity: true,
        shotCounter: true, maxShotLifetime: true, nextMaintenanceDate: true,
        diesParts: { where: { isActive: true }, select: { partId: true, isPrimary: true, effectiveDate: true, expiryDate: true, expectedOutput: true } },
        maintenances: { where: { isDeleted: false }, select: { maintenanceNumber: true, maintenanceDate: true, startDate: true, endDate: true } },
      },
      orderBy: { diesCode: "asc" },
    }),
    prisma.vendor.findMany({ where: { isDeleted: false, status: "Active" }, select: { id: true, vendorCode: true, vendorName: true, leadTimeDays: true }, orderBy: { vendorCode: "asc" } }),
  ]);
  // Keep the heatmap/readiness calendar identical to the allocator: an
  // explicit plan decision wins, then the selected simulation/current-use
  // preset, and the global machine calendar is the final fallback.
  const dayOverrideForDate = (key, machineId) => dayOverrideByMachineDate.get(`${machineId}|${key}`)
    || dayOverrideByMachineDate.get(`null|${key}`)
    || presetDayOverrideByDate.get(key)
    || globalDayOverrideByMachineDate.get(`${machineId}|${key}`)
    || null;
  const capacityRuleForDate = (key, machineId) => resolveDailyCapacity({
    key,
    override: dayOverrideForDate(key, machineId),
    shiftHours,
    defaultShiftsPerDay: shiftsPerDay,
    defaultOvertimeHours: overtimeHours,
    efficiencyPercent,
    includeSaturday,
    includeSunday,
    formulas,
  });

  const latestHeaderByPart = new Map();
  for (const header of headers) if (header.partId && !latestHeaderByPart.has(header.partId)) latestHeaderByPart.set(header.partId, header.noReg);
  const activeNoRegs = new Set(latestHeaderByPart.values());
  const activeRoutes = routes.filter((route) => activeNoRegs.has(route.noReg));
  const activeRouteById = new Map(activeRoutes.map((route) => [route.id, route]));
  const machineById = new Map(machines.map((machine) => [machine.id, machine]));
  const machineByCode = new Map(machines.map((machine) => [machine.machineCode, machine]));
  const vendorById = new Map(availableVendors.map((vendor) => [vendor.id, vendor]));
  const diesById = new Map(availableDies.map((dies) => [dies.id, dies]));
  const processById = new Map(processes.map((process) => [process.id, process]));
  const processByCode = new Map(processes.map((process) => [process.processCode, process]));
  const routesByPartId = new Map();
  const routesByPartCode = new Map();
  for (const route of activeRoutes) {
    if (route.mbomDetail?.partId) {
      if (!routesByPartId.has(route.mbomDetail.partId)) routesByPartId.set(route.mbomDetail.partId, []);
      routesByPartId.get(route.mbomDetail.partId).push(route);
    }
    if (route.mbomDetail?.part?.partCode) {
      if (!routesByPartCode.has(route.mbomDetail.part.partCode)) routesByPartCode.set(route.mbomDetail.part.partCode, []);
      routesByPartCode.get(route.mbomDetail.part.partCode).push(route);
    }
  }

  const machineWorkCenter = buildMachineWorkCenterMap(workCenters);
  const machineRows = machines.map((machine) => ({
    ...machine,
    ...(machineWorkCenter.get(machine.id) || {}),
    defaultAvailableMinutes: machine.status === "Active" ? workingAvailableMinutes : 0,
    cells: Object.fromEntries(range.dates.map((key) => {
      const capacityRule = capacityRuleForDate(key, machine.id);
      const cell = machineCell(machine, key, capacityRule.availableMinutes);
      cell.dayOverride = dayOverrideForDate(key, machine.id);
      cell.capacityRule = capacityRule;
      return [key, cell];
    })),
  }));
  const rowByMachineId = new Map(machineRows.map((machine) => [machine.id, machine]));
  const rowByMachineCode = new Map(machineRows.map((machine) => [machine.machineCode, machine]));
  const routeSpecificationCode = (route) => route.machineSpecificationCode || machineById.get(route.machineId)?.machineSpecificationCode || null;
  const eligibleMachinesForRoute = (route, activeOnly = true) => {
    const specificationCode = routeSpecificationCode(route);
    if (!specificationCode) return route.machineId ? [machineById.get(route.machineId)].filter(Boolean) : [];
    return machines.filter((machine) => machine.machineSpecificationCode === specificationCode && (!activeOnly || machine.status === "Active"));
  };
  const availableMinutesForMachine = (machine, dueDate) => Object.entries(rowByMachineId.get(machine.id)?.cells || {}).reduce((sum, [key, cell]) => {
    if (dueDate && parseDateOnly(key) > parseDateOnly(dueDate)) return sum;
    return sum + Math.max(number(cell.availableMinutes) - number(cell.downtimeMinutes) - number(cell.firmMinutes) - number(cell.proposedMinutes), 0);
  }, 0);
  const bestEligibleMachine = (route, dueDate, overrideMachineId = null) => {
    if (overrideMachineId) return eligibleMachinesForRoute(route).find((machine) => machine.id === overrideMachineId) || null;
    return eligibleMachinesForRoute(route).sort((left, right) => availableMinutesForMachine(right, dueDate) - availableMinutesForMachine(left, dueDate) || left.machineCode.localeCompare(right.machineCode))[0] || null;
  };
  const machineOverrideByRouteDate = new Map(machineOverrides.map((item) => [`${item.plan.planNumber}|${item.lineNumber}|${item.mbomProcessId}|${dateKey(item.scheduleDate)}`, item]));
  const issues = [];
  const issueKeys = new Set();
  const unscheduled = [];
  const fgReceipts = [];
  const vendorAssignments = [];

  const planPartIds = [...new Set(planDetails.map((detail) => detail.partId).filter(Boolean))];
  const planPartCodes = [...new Set(planDetails.map((detail) => detail.partCode).filter(Boolean))];
  const planParts = planPartIds.length || planPartCodes.length ? await prisma.part.findMany({
    where: {
      isDeleted: false,
      OR: [
        ...(planPartIds.length ? [{ id: { in: planPartIds } }] : []),
        ...(planPartCodes.length ? [{ partCode: { in: planPartCodes } }] : []),
      ],
    },
    select: { id: true, partCode: true, partName: true, partNumber: true, itemType: true, partType: true, baseUomCode: true, productionUomCode: true, stockUomCode: true },
  }) : [];
  const planPartById = new Map(planParts.map((part) => [part.id, part]));
  const planPartByCode = new Map(planParts.map((part) => [part.partCode, part]));
  const childFgReceiptLines = planDetails
    .filter((detail) => /\[FG-RECEIPT:CHILD\]/i.test(String(detail.notes || "")))
    .map((detail) => ({
      id: detail.id,
      planNumber: detail.plan.planNumber,
      lineNumber: detail.lineNumber,
      partId: detail.partId,
      partCode: detail.partCode,
      qtyPlanned: detail.qtyPlanned,
      requiredDate: detail.requiredDate,
      fgRequiredDate: detail.fgRequiredDate,
      deliveryPhaseId: detail.deliveryPhaseId,
    }));
  const childFgFinalWipByFg = {};
  for (const receiptLine of childFgReceiptLines) {
    const fgPart = planPartById.get(receiptLine.partId) || planPartByCode.get(receiptLine.partCode);
    const activeNoReg = fgPart?.id ? latestHeaderByPart.get(fgPart.id) : null;
    if (!activeNoReg) continue;
    const rootWipCodes = [...new Set(activeRoutes
      .filter((route) => route.noReg === activeNoReg
        && !route.mbomDetail?.parentDetail
        && String(route.mbomDetail?.part?.itemType || route.mbomDetail?.part?.partType || "").toUpperCase() === "WIP")
      .map((route) => route.mbomDetail?.part?.partCode)
      .filter(Boolean))];
    if (rootWipCodes.length === 1) childFgFinalWipByFg[receiptLine.partCode] = rootWipCodes[0];
  }
  const recommendationInputPartCodes = [...new Set([
    ...routes.flatMap((route) => recommendationRouteInputs(route).map((input) => input.partCode)),
    ...Object.values(childFgFinalWipByFg),
  ])];
  const recommendationStockRows = recommendationInputPartCodes.length && typeof prisma.stockBalance?.groupBy === "function"
    ? await prisma.stockBalance.groupBy({
        by: ["partCode"],
        where: {
          partCode: { in: recommendationInputPartCodes },
          isDeleted: false,
          warehouse: { isDeleted: false, availableForProduction: true },
        },
        _sum: { qtyAvailable: true },
      })
    : [];
  const receiptPartCodes = [...new Set(planDetails
    .filter((detail) => detail.mpsDetailId && !String(detail.notes || "").includes("[MRP-PRODUCTION]"))
    .map((detail) => detail.partCode)
    .filter(Boolean))];
  const finishedGoodStock = receiptPartCodes.length ? await prisma.stockBalance.groupBy({
    by: ["partCode", "uomCode"],
    where: {
      partCode: { in: receiptPartCodes },
      stockType: "Finished Goods",
      isDeleted: false,
    },
    _sum: { qtyAvailable: true },
  }) : [];
  const availableFinishedGoodByPartUom = new Map(finishedGoodStock.map((row) => [
    `${row.partCode}|${String(row.uomCode || "").toLowerCase()}`,
    Math.max(number(row._sum.qtyAvailable), 0),
  ]));

  const planNumbers = [...new Set(planDetails.map((detail) => detail.plan.planNumber).filter(Boolean))];
  const selectedPlan = planNumber ? planDetails.find((detail) => detail.plan.planNumber === planNumber)?.plan : null;
  const materialGate = selectedPlan
    ? await buildProductionMaterialGate(prisma, selectedPlan)
    : null;
  const sourceMpsNumbers = [...new Set(planDetails
    .map((detail) => String(detail.plan.sourceType || "").startsWith("MPS:") ? String(detail.plan.sourceType).slice(4) : null)
    .filter(Boolean))];
  const forecastReceiptDetails = sourceMpsNumbers.length
    ? await prisma.mPSDetail.findMany({
      where: {
        mpsNumber: { in: sourceMpsNumbers },
        isDeleted: false,
        OR: [
          { notes: null },
          { NOT: { notes: { startsWith: "[MRP-PRODUCTION]" } } },
        ],
      },
      select: { id: true },
    })
    : [];
  const childFgPartCodes = [...new Set(childFgReceiptLines.map((line) => line.partCode).filter(Boolean))];
  const childFgConversionMovements = childFgPartCodes.length && typeof prisma.stockMovement?.findMany === "function"
    ? await prisma.stockMovement.findMany({
        where: {
          isDeleted: false,
          direction: "IN",
          transactionType: "PRODUCTION",
          stockType: "Finished Goods",
          partCode: { in: childFgPartCodes },
          notes: { contains: "[CHILD-FG-RECEIPT:" },
        },
        select: { partCode: true, qty: true, notes: true },
      })
    : [];
  const childFgConversionHistory = summarizeChildFgConversionHistory(childFgConversionMovements);
  const forecastReceiptDetailIds = forecastReceiptDetails.map((detail) => detail.id);
  const deliveryPhases = sourceMpsNumbers.length && typeof prisma.mPSDeliveryPlan?.findMany === "function"
    ? await prisma.mPSDeliveryPlan.findMany({
      where: {
        mpsNumber: { in: sourceMpsNumbers },
        mpsDetailId: { in: forecastReceiptDetailIds },
        targetType: "CUSTOMER",
        isDeleted: false,
        status: { not: "Cancelled" },
      },
      orderBy: [{ plannedDate: "asc" }, { phaseNumber: "asc" }],
    })
    : [];
  const planningConstraintByTarget = await loadDemandPlanningConstraintMap(
    prisma,
    deliveryPhases.map((phase) => phase.sourceDeliveryTargetId),
  );
  const productionPlanAllocations = planNumbers.length && typeof prisma.productionPlanAllocation?.findMany === "function"
    ? await prisma.productionPlanAllocation.findMany({
      where: {
        isDeleted: false,
        status: { in: ["Draft", "Published"] },
        planningMode,
        ...(planningMode === "SIMULATION" ? { scenarioKey } : {}),
        plan: { planNumber: { in: planNumbers }, isDeleted: false },
      },
      select: {
        id: true,
        lineNumber: true,
        mbomProcessId: true,
        scheduleDate: true,
        shift: true,
        plannedStartTime: true,
        plannedEndTime: true,
        machineId: true,
        diesId: true,
        routingMode: true,
        vendorId: true,
        vendorSendDate: true,
        vendorReturnDate: true,
        vendorLeadTimeDays: true,
        expectedReturnQty: true,
        plannedQty: true,
        uomCode: true,
        status: true,
        notes: true,
        allocationSource: true,
        planningMode: true,
        scenarioKey: true,
        recommendationReason: true,
        // Expose persisted scoring evidence so every recommended slot remains auditable in the UI.
        recommendationScore: true,
        recommendationScoreBreakdown: true,
        capacityMode: true,
        deliveryPhaseId: true,
        deliveryPhaseNumber: true,
        demandSourceType: true,
        demandSourceNumber: true,
        customerCode: true,
        customerTargetDate: true,
        fgRequiredDate: true,
        priorityScore: true,
        priorityClass: true,
        latestStartDate: true,
        latestFinishDate: true,
        capacityLate: true,
        earliestFeasibleCompletion: true,
        transferBatchNumber: true,
        predecessorAllocationIds: true,
        plan: { select: { planNumber: true, status: true, sourceType: true } },
        mbomProcess: {
          select: {
            id: true,
            occurrenceCode: true,
            processId: true,
            sequence: true,
            cycleTime: true,
            diesId: true,
            machineSpecificationCode: true,
            process: { select: { processCode: true, processName: true } },
            mbomDetail: {
              select: {
                partId: true,
                part: { select: { id: true, partCode: true, partName: true, itemType: true, partType: true } },
                children: {
                  where: { isDeleted: false },
                  select: {
                    partId: true,
                    qty: true,
                    isDeleted: true,
                    part: { select: { id: true, partCode: true, partName: true, itemType: true, partType: true } },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: [{ scheduleDate: "asc" }, { lineNumber: "asc" }, { createdAt: "asc" }],
    })
    : [];
  const currentAllocationIds = new Set(productionPlanAllocations.map((row) => row.id));
  const referencedExternalIds = [...new Set(productionPlanAllocations.flatMap((row) =>
    Array.isArray(row.predecessorAllocationIds) ? row.predecessorAllocationIds.map(String) : []))]
    .filter((id) => !currentAllocationIds.has(id));
  const externalPredecessorAllocations = referencedExternalIds.length
    ? await prisma.productionPlanAllocation.findMany({
      where: {
        id: { in: referencedExternalIds },
        isDeleted: false,
        status: { in: ["Draft", "Published"] },
        planningMode: "PRODUCTION",
        plan: { isDeleted: false },
      },
      select: {
        id: true, scheduleDate: true, plannedStartTime: true, plannedEndTime: true,
        routingMode: true, vendorSendDate: true, vendorReturnDate: true,
        plan: { select: { planNumber: true, status: true, sourceType: true } },
      },
    })
    : [];
  const planManufacturingOrders = planNumbers.length ? await prisma.manufacturingOrder.findMany({
    where: {
      monthlyProductionPlanNumber: { in: planNumbers },
      isDeleted: false,
      status: { not: "Cancelled" },
    },
    select: { id: true, moNumber: true, monthlyProductionPlanNumber: true, monthlyProductionPlanLineNumber: true },
  }) : [];
  const planMoById = new Map(planManufacturingOrders.map((mo) => [mo.id, mo]));
  const planMoByNumber = new Map(planManufacturingOrders.map((mo) => [mo.moNumber, mo]));
  const scheduledQtyByPlanProcess = new Map();

  const allocationById = new Map([...productionPlanAllocations, ...externalPredecessorAllocations].map((row) => [row.id, row]));
  const predecessorWipState = new Map();
  const draftAllocationsInConsumptionOrder = productionPlanAllocations
    .filter((row) => row.status === "Draft")
    .sort(compareAllocationConsumptionOrder);
  for (const allocation of draftAllocationsInConsumptionOrder) {
    const detail = planDetails.find((row) => row.plan.planNumber === allocation.plan.planNumber
      && number(row.lineNumber) === number(allocation.lineNumber));
    const route = allocation.mbomProcess;
    const processCode = route?.process?.processCode || null;
    const common = {
      planNumber: allocation.plan.planNumber,
      lineNumber: allocation.lineNumber,
      partCode: detail?.partCode || null,
      processCode,
      routeId: allocation.mbomProcessId,
      allocationId: allocation.id,
    };
    if (number(allocation.plannedQty) <= 0) {
      pushIssue(issues, { ...common, severity: "blocking", category: "QUANTITY", code: "PLAN_ALLOCATION_QTY_INVALID", message: "Qty allocation harus lebih dari nol.", resolution: "Perbaiki atau hapus allocation ini." }, issueKeys);
    }
    if (!range.dates.includes(dateKey(allocation.scheduleDate))) {
      pushIssue(issues, { ...common, severity: "blocking", category: "CALENDAR", code: "PLAN_ALLOCATION_OUTSIDE_HORIZON", message: `Tanggal allocation ${dateKey(allocation.scheduleDate)} berada di luar horizon Capacity Planning.`, resolution: "Pindahkan allocation ke periode MPP atau perluas horizon." }, issueKeys);
    }

    const allocationMaterialGate = materialGateForJob(materialGate, {
      id: allocation.deliveryPhaseId,
      sourceDeliveryTargetId: deliveryPhases.find((phase) => phase.id === allocation.deliveryPhaseId)?.sourceDeliveryTargetId || null,
    });
    if (allocationMaterialGate?.readyDate && dateKey(allocation.scheduleDate) < dateKey(allocationMaterialGate.readyDate)) {
      const confirmedLabel = allocationMaterialGate.confirmed
        ? "jadwal delivery supplier terkonfirmasi"
        : "due date sistem Purchase Suggestion (fallback karena supplier belum confirm)";
      pushIssue(issues, {
        ...common,
        severity: "blocking",
        category: "MATERIAL",
        code: "PLAN_START_BEFORE_MATERIAL_READY",
        message: `${detail?.partCode || "Part"} dijadwalkan mulai ${dateKey(allocation.scheduleDate)}, sebelum material siap ${dateKey(allocationMaterialGate.readyDate)} berdasarkan ${confirmedLabel}.`,
        resolution: "Jalankan ulang Auto Allocation setelah supplier mengubah konfirmasi, atau geser proses pertama ke tanggal material siap.",
        materialReadyDate: allocationMaterialGate.readyDate,
        materialReadySource: allocationMaterialGate.source,
        suggestionNumber: allocationMaterialGate.suggestionNumber || materialGate?.suggestionNumber || null,
      }, issueKeys);
    }

    const vendorMode = String(allocation.routingMode || "INHOUSE").toUpperCase() === "VENDOR";
    if (vendorMode) {
      const vendor = vendorById.get(allocation.vendorId);
      if (!vendor) {
        pushIssue(issues, { ...common, severity: "blocking", category: "VENDOR", code: "PLAN_VENDOR_REQUIRED", message: `${detail?.partCode || "Part"} · ${processCode || "proses vendor"} belum memiliki vendor aktif.`, resolution: "Pilih vendor aktif pada allocation Capacity Planning." }, issueKeys);
      }
      if (!allocation.vendorSendDate || !allocation.vendorReturnDate) {
        pushIssue(issues, { ...common, severity: "blocking", category: "VENDOR", code: "PLAN_VENDOR_DATES_REQUIRED", message: "Tanggal kirim dan kembali vendor wajib diisi.", resolution: "Isi vendor send date dan return date." }, issueKeys);
      } else if (parseDateOnly(allocation.vendorReturnDate) < parseDateOnly(allocation.vendorSendDate)) {
        pushIssue(issues, { ...common, severity: "blocking", category: "VENDOR", code: "PLAN_VENDOR_DATE_SEQUENCE_INVALID", message: "Tanggal kembali vendor tidak boleh sebelum tanggal kirim.", resolution: "Perbaiki urutan tanggal vendor." }, issueKeys);
      }
      if (number(allocation.expectedReturnQty) + 0.000001 < number(allocation.plannedQty)) {
        pushIssue(issues, { ...common, severity: "blocking", category: "VENDOR", code: "PLAN_VENDOR_RETURN_QTY_SHORT", message: `Ekspektasi kembali ${capacityQtyText(allocation.expectedReturnQty, allocation.uomCode)} lebih kecil dari qty kirim ${capacityQtyText(allocation.plannedQty, allocation.uomCode)}.`, resolution: "Tambahkan allowance/replacement plan atau cukupkan expected return qty." }, issueKeys);
      }
    } else {
      const machine = machineById.get(allocation.machineId);
      if (!machine || machine.status !== "Active") {
        pushIssue(issues, { ...common, severity: "blocking", category: "MACHINE", code: "PLAN_ALLOCATION_MACHINE_INVALID", machineCode: machine?.machineCode || null, message: "Allocation in-house wajib memakai mesin aktif.", resolution: "Pilih mesin aktif yang memenuhi spesifikasi routing." }, issueKeys);
      } else if (route?.machineSpecificationCode && machine.machineSpecificationCode !== route.machineSpecificationCode) {
        pushIssue(issues, { ...common, severity: "blocking", category: "MACHINE", code: "PLAN_MACHINE_SPEC_MISMATCH", machineCode: machine.machineCode, message: `${machine.machineCode} tidak memenuhi spesifikasi ${route.machineSpecificationCode} untuk ${processCode || "routing"}.`, resolution: "Pindahkan ke mesin dengan machine specification yang sama." }, issueKeys);
      }
      if (!/^(1|2|3|1A|1B|2A|2B|3A|3C)$/i.test(String(allocation.shift || ""))) {
        pushIssue(issues, { ...common, severity: "blocking", category: "CALENDAR", code: "PLAN_SHIFT_INVALID", message: `Shift "${allocation.shift || "-"}" tidak valid untuk proses in-house.`, resolution: "Pilih shift produksi yang tersedia." }, issueKeys);
      }
    }

    const predecessorIds = Array.isArray(allocation.predecessorAllocationIds) ? allocation.predecessorAllocationIds : [];
    const successorStart = allocationStartMoment(allocation);
    const linkedPredecessors = [];
    for (const predecessorId of predecessorIds) {
      const predecessor = allocationById.get(predecessorId);
      if (!predecessor) {
        pushIssue(issues, { ...common, relatedAllocationId: predecessorId, severity: "blocking", category: "SEQUENCE", code: "PLAN_PREDECESSOR_MISSING", message: `Predecessor allocation ${predecessorId} tidak ditemukan.`, resolution: "Jalankan ulang recommendation atau perbaiki dependency allocation." }, issueKeys);
        continue;
      }
      const crossPlanStatus = crossPlanPredecessorStatus(predecessor, allocation);
      if (crossPlanStatus === "SOURCE_MISMATCH") {
        pushIssue(issues, { ...common, relatedAllocationId: predecessorId, severity: "blocking", category: "SEQUENCE", code: "PLAN_PREDECESSOR_SOURCE_MISMATCH", message: `Predecessor ${predecessor.plan.planNumber} bukan bagian dari source MPS yang sama.`, resolution: "Pilih predecessor dari rolling Monthly Plan dengan source MPS yang sama." }, issueKeys);
        continue;
      }
      if (crossPlanStatus === "LATE") {
        pushIssue(issues, {
          ...common, relatedAllocationId: predecessorId, severity: "blocking", category: "SEQUENCE", code: "PLAN_PREDECESSOR_LATE",
          message: `Predecessor ${predecessor.plan.planNumber} selesai ${allocationFinishMoment(predecessor).toISOString()} setelah proses ini mulai.`,
          resolution: "Majukan predecessor bulan sebelumnya atau mundurkan proses successor.",
        }, issueKeys);
        continue;
      }
      if (crossPlanStatus === "READY") continue;
      linkedPredecessors.push(predecessor);
    }

    // One logical predecessor can be split into several finite-capacity
    // allocations. Validate the cumulative ready WIP once per route/line/phase
    // rather than incorrectly requiring every split to cover the successor.
    for (const predecessorGroup of groupPredecessorAllocations(linkedPredecessors, successorStart, predecessorWipState)) {
      const predecessor = allocationById.get(predecessorGroup.batches[0]?.allocationId);
      if (!predecessor) continue;
      const predecessorProcessCode = predecessorGroup.processCode || "Proses sebelumnya";
      const successorProcessCode = processCode || "Proses berikutnya";
      const predecessorDetail = planDetails.find((row) => row.plan.planNumber === predecessorGroup.planNumber
        && number(row.lineNumber) === number(predecessorGroup.lineNumber));
      const relatedAllocationIds = predecessorGroup.batches.map((batch) => batch.allocationId);
      const lateBatches = predecessorGroup.batches.filter((batch) => !batch.finishedBeforeSuccessor);

      const groupReadiness = predecessorGroupReadiness(
        predecessorGroup,
        predecessorDetail?.qtyPlanned,
        allocation.plannedQty,
        detail?.qtyPlanned,
        allocation.uomCode,
      );
      const { quantityStatus } = groupReadiness;
      const requiredPredecessorOutput = quantityStatus.mode === "COVERAGE"
        ? quantityStatus.successorCoverage * number(predecessorDetail?.qtyPlanned)
        : number(allocation.plannedQty);
      const additionalPredecessorQty = Math.max(requiredPredecessorOutput - predecessorGroup.availableOutputQty, 0);
      const maximumSuccessorQty = quantityStatus.mode === "COVERAGE"
        ? quantityStatus.predecessorCoverage * number(detail?.qtyPlanned)
        : predecessorGroup.availableOutputQty;
      const reservation = reservePredecessorGroupOutput(
        predecessorGroup,
        requiredPredecessorOutput,
        { id: allocation.id, startAt: successorStart },
        predecessorWipState,
      );

      // A future linked chunk is harmless when already-finished chunks cover
      // the successor. When the future output is specifically what closes the
      // gap, report one timing blocker (not a duplicate quantity blocker).
      if (groupReadiness.status === "TIMING_BLOCKED") {
        const requiredLateReservations = reservation.batchReservations.filter((item) => !item.finishedBeforeSuccessor);
        const requiredLateIds = new Set(requiredLateReservations.map((item) => String(item.predecessorAllocationId)));
        const requiredLateBatches = lateBatches.filter((batch) => requiredLateIds.has(String(batch.allocationId)));
        const unblockAt = requiredLateBatches.at(-1)?.finishAt || lateBatches.at(-1).finishAt;
        const requiredLateQty = reservation.lateReservedQty;
        pushIssue(issues, {
          ...common,
          relatedAllocationId: requiredLateBatches[0]?.allocationId || lateBatches[0].allocationId,
          relatedAllocationIds,
          severity: "blocking",
          category: "SEQUENCE",
          code: "PLAN_PREDECESSOR_FINISH_AFTER_SUCCESSOR",
          message: `${predecessorProcessCode} memiliki WIP siap ${capacityQtyText(predecessorGroup.availableOutputQty, predecessorGroup.uomCode)} ${predecessorGroup.uomCode || ""}; masih perlu ${capacityQtyText(additionalPredecessorQty, predecessorGroup.uomCode)} dari ${requiredLateBatches.length} split batch yang baru selesai setelah ${successorProcessCode} mulai.`,
          resolution: `Majukan batch predecessor yang dibutuhkan sebelum ${successorStart.toISOString()}, atau mundurkan successor setelah ${unblockAt.toISOString()}.`,
          blockerDetail: {
            cause: "Jumlah total predecessor mencukupi, tetapi sebagian output yang dibutuhkan belum selesai saat successor mulai.",
            impact: `${successorProcessCode} hanya dapat memakai WIP dari batch yang telah selesai sebelum waktu mulai.`,
            predecessorGroupKey: predecessorGroup.key,
            shortageQtyAtStart: round(additionalPredecessorQty, 3),
            linkedBatchCount: predecessorGroup.batches.length,
            readyBatchCount: predecessorGroup.finishedBatchCount,
            lateBatchCount: predecessorGroup.lateBatchCount,
            requiredLateBatchCount: requiredLateBatches.length,
            requiredLateOutputQty: round(requiredLateQty, 3),
            reservation,
            readyOutputQty: predecessorGroup.availableOutputQty,
            lateOutputQty: predecessorGroup.lateOutputQty,
            requiredPredecessorOutput: round(requiredPredecessorOutput, 3),
            uomCode: predecessorGroup.uomCode,
            batches: predecessorGroup.batches.map((batch) => ({ ...batch, finishAt: batch.finishAt.toISOString(), requiredToUnblock: requiredLateIds.has(String(batch.allocationId)) })),
            successor: { allocationId: allocation.id, processCode: successorProcessCode, startAt: successorStart.toISOString(), unblockAt: unblockAt.toISOString() },
          },
        }, issueKeys);
        continue;
      }

      if (groupReadiness.status === "QTY_BLOCKED") {
        const batchSummary = `${predecessorGroup.finishedBatchCount}/${predecessorGroup.batches.length} split batch selesai sebelum successor mulai`;
        const priorSuccessorIds = [...new Set(predecessorGroup.batches.flatMap((batch) => batch.priorReservations || [])
          .map((item) => item.successorAllocationId).filter(Boolean))].sort((left, right) => String(left).localeCompare(String(right)));
        const reservationSummary = predecessorGroup.reservedOutputQty > COVERAGE_EPSILON
          ? ` ${capacityQtyText(predecessorGroup.reservedOutputQty, predecessorGroup.uomCode)} ${predecessorGroup.uomCode || ""} sudah dialokasikan ke ${priorSuccessorIds.length} successor yang mulai lebih dahulu.`
          : "";
        const lateSummary = predecessorGroup.lateBatchCount
          ? ` ${capacityQtyText(predecessorGroup.lateOutputQty, predecessorGroup.uomCode)} ${predecessorGroup.uomCode || ""} dari ${predecessorGroup.lateBatchCount} batch terlambat belum dihitung sebagai WIP siap.`
          : "";
        const message = quantityStatus.mode === "COVERAGE"
          ? `${predecessorProcessCode} baru mencakup ${round(quantityStatus.predecessorCoverage * 100, 2)}% (${capacityQtyText(predecessorGroup.availableOutputQty, predecessorGroup.uomCode)} dari target ${capacityQtyText(predecessorDetail?.qtyPlanned, predecessorGroup.uomCode)}; ${batchSummary}), sementara ${successorProcessCode} sudah dijadwalkan ${round(quantityStatus.successorCoverage * 100, 2)}% (${capacityQtyText(allocation.plannedQty, allocation.uomCode)} dari target ${capacityQtyText(detail?.qtyPlanned, allocation.uomCode)}).${reservationSummary}${lateSummary}`
          : `Output kumulatif predecessor yang siap baru ${capacityQtyText(predecessorGroup.availableOutputQty, predecessorGroup.uomCode)} dari ${batchSummary}, belum cukup untuk successor ${capacityQtyText(allocation.plannedQty, allocation.uomCode)}.${reservationSummary}${lateSummary}`;
        const resolution = `Tambah atau majukan predecessor minimal ${capacityQtyText(additionalPredecessorQty, predecessorGroup.uomCode)} ${predecessorGroup.uomCode || ""} hingga WIP siap ${capacityQtyText(requiredPredecessorOutput, predecessorGroup.uomCode)}, atau turunkan successor maksimal menjadi ${capacityQtyText(maximumSuccessorQty, allocation.uomCode)} ${allocation.uomCode || ""}.`;
        const latestReadyBatch = [...predecessorGroup.batches].reverse().find((batch) => batch.finishedBeforeSuccessor);
        pushIssue(issues, {
          ...common,
          relatedAllocationId: predecessorGroup.batches[0].allocationId,
          relatedAllocationIds,
          severity: "blocking",
          category: "SEQUENCE",
          code: "PLAN_PREDECESSOR_QTY_SHORT",
          message,
          resolution,
          blockerDetail: {
            cause: predecessorGroup.reservedOutputQty > COVERAGE_EPSILON
              ? `WIP predecessor tidak boleh dipakai ulang: ${capacityQtyText(predecessorGroup.reservedOutputQty, predecessorGroup.uomCode)} ${predecessorGroup.uomCode || ""} sudah direservasi oleh successor lebih awal (${priorSuccessorIds.join(", ") || "allocation sebelumnya"}).`
              : `Coverage successor melebihi WIP kumulatif dari split batch predecessor yang selesai tepat waktu (${batchSummary}).`,
            impact: `${successorProcessCode} tidak boleh mulai penuh karena WIP tersedia belum mencukupi. Jika dipaksakan, schedule terlihat on-time tetapi material antar-proses tidak tersedia.`,
            predecessorGroupKey: predecessorGroup.key,
            shortageQty: round(additionalPredecessorQty, 3),
            shortageUomCode: predecessorGroup.uomCode || null,
            coverageGapPercent: quantityStatus.mode === "COVERAGE" ? round((quantityStatus.successorCoverage - quantityStatus.predecessorCoverage) * 100, 2) : null,
            requiredPredecessorOutput: round(requiredPredecessorOutput, 3),
            maximumSuccessorQty: round(maximumSuccessorQty, 3),
            grossLinkedOutputQty: predecessorGroup.grossLinkedOutputQty,
            previouslyReservedOutputQty: predecessorGroup.reservedOutputQty,
            previousSuccessorAllocationIds: priorSuccessorIds,
            reservation,
            linkedBatchCount: predecessorGroup.batches.length,
            readyBatchCount: predecessorGroup.finishedBatchCount,
            lateBatchCount: predecessorGroup.lateBatchCount,
            lateOutputQty: predecessorGroup.lateOutputQty,
            batches: predecessorGroup.batches.map((batch) => ({ ...batch, finishAt: batch.finishAt.toISOString() })),
            predecessor: {
              allocationId: predecessorGroup.batches[0].allocationId,
              allocationIds: relatedAllocationIds,
              processCode: predecessorProcessCode,
              partCode: predecessorDetail?.partCode || null,
              outputQty: round(predecessorGroup.availableOutputQty, 3),
              linkedOutputQty: round(predecessorGroup.linkedOutputQty, 3),
              grossLinkedOutputQty: round(predecessorGroup.grossLinkedOutputQty, 3),
              previouslyReservedOutputQty: round(predecessorGroup.reservedOutputQty, 3),
              targetQty: round(predecessorDetail?.qtyPlanned, 3),
              coveragePercent: quantityStatus.predecessorCoverage == null ? null : round(quantityStatus.predecessorCoverage * 100, 2),
              uomCode: predecessorGroup.uomCode || null,
              finishAt: latestReadyBatch?.finishAt?.toISOString() || null,
            },
            successor: { allocationId: allocation.id, processCode: successorProcessCode, partCode: detail?.partCode || null, plannedQty: round(allocation.plannedQty, 3), targetQty: round(detail?.qtyPlanned, 3), coveragePercent: quantityStatus.successorCoverage == null ? null : round(quantityStatus.successorCoverage * 100, 2), uomCode: allocation.uomCode || null, startAt: successorStart.toISOString() },
          },
        }, issueKeys);
      }
    }
  }

  const timedInhouse = [
    ...productionPlanAllocations.filter((row) => row.status === "Draft"
      && String(row.routingMode || "INHOUSE").toUpperCase() === "INHOUSE")
      .map((row) => ({
        ...row,
        source: "ALLOCATION",
        planNumber: row.plan.planNumber,
        diesId: row.diesId || row.mbomProcess?.diesId || null,
        route: row.mbomProcess,
      })),
    ...schedules.filter((row) => row.machineId).map((row) => ({
      ...row,
      source: "SCHEDULE",
      planNumber: row.productionPlan?.planNumber || null,
      allocationId: null,
      route: { process: processById.get(row.processId) || null },
    })),
  ];
  for (const row of timedInhouse) {
    const machine = machineById.get(row.machineId);
    const requiresDies = isDiesCapacityBlockingEnabled() && isPressResource(machine, row.route);
    const dies = diesById.get(row.diesId);
    const common = {
      severity: "blocking",
      category: "DIES",
      planNumber: row.planNumber,
      lineNumber: row.lineNumber || null,
      routeId: row.mbomProcessId || null,
      allocationId: row.source === "ALLOCATION" ? row.id : null,
      relatedScheduleId: row.source === "SCHEDULE" ? row.id : null,
      machineCode: machine?.machineCode || null,
    };
    if (requiresDies && !row.diesId) {
      pushIssue(issues, { ...common, code: "PLAN_DIES_REQUIRED", message: `${machine?.machineCode || "Mesin Press"} wajib dijadwalkan bersama Dies.`, resolution: "Tetapkan Dies pada routing MBOM atau draft allocation." }, issueKeys);
      continue;
    }
    if (!row.diesId) continue;
    if (!dies) {
      pushIssue(issues, { ...common, code: "PLAN_DIES_INACTIVE", message: "Dies allocation tidak aktif atau tidak ditemukan.", resolution: "Pilih Dies aktif atau selesaikan maintenance Dies." }, issueKeys);
      continue;
    }
    common.diesCode = dies.diesCode;
    if (!isDiesTonnageCompatible(dies, machine)) {
      pushIssue(issues, { ...common, code: "PLAN_DIES_MACHINE_TONNAGE_MISMATCH", message: `${machine?.machineCode || "Mesin"} ${number(machine?.tonnage)}T tidak mencukupi Dies ${dies.diesCode} ${number(dies.tonnage)}T.`, resolution: "Pilih mesin Press dengan tonase yang mencukupi." }, issueKeys);
    }
    const interval = plannedInterval(row.scheduleDate, row.plannedStartTime, row.plannedEndTime);
    if (requiresDies && !interval) {
      pushIssue(issues, { ...common, code: "PLAN_DIES_TIME_REQUIRED", message: `Jam mulai dan selesai wajib diisi untuk mengunci kapasitas Dies ${dies.diesCode}.`, resolution: "Isi planned start dan planned end allocation." }, issueKeys);
      continue;
    }
    const maintenance = interval && dies.maintenances.find((item) => intervalsOverlap(interval, maintenanceInterval(item)));
    if (maintenance) {
      pushIssue(issues, { ...common, code: "PLAN_DIES_MAINTENANCE_OVERLAP", message: `Dies ${dies.diesCode} overlap maintenance ${maintenance.maintenanceNumber}.`, resolution: "Pindahkan jadwal atau selesaikan maintenance Dies." }, issueKeys);
    }
  }
  for (let leftIndex = 0; leftIndex < timedInhouse.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < timedInhouse.length; rightIndex += 1) {
      const left = timedInhouse[leftIndex];
      const right = timedInhouse[rightIndex];
      const leftInterval = plannedInterval(left.scheduleDate, left.plannedStartTime, left.plannedEndTime);
      const rightInterval = plannedInterval(right.scheduleDate, right.plannedStartTime, right.plannedEndTime);
      const overlaps = intervalsOverlap(leftInterval, rightInterval);
      if (!overlaps) continue;
      if (left.machineId === right.machineId) {
        const machine = machineById.get(left.machineId);
        pushIssue(issues, { severity: "blocking", category: "MACHINE", code: "PLAN_MACHINE_TIME_OVERLAP", planNumber: left.planNumber, lineNumber: left.lineNumber, routeId: left.mbomProcessId, allocationId: left.source === "ALLOCATION" ? left.id : null, relatedAllocationId: right.source === "ALLOCATION" ? right.id : null, relatedScheduleId: right.source === "SCHEDULE" ? right.id : null, machineCode: machine?.machineCode || null, message: `${machine?.machineCode || "Mesin"} memiliki jadwal overlap pada ${dateKey(left.scheduleDate)}.`, resolution: "Ubah jam, shift, lane, atau mesin salah satu allocation." }, issueKeys);
      }
      if (left.diesId && left.diesId === right.diesId) {
        const dies = diesById.get(left.diesId);
        pushIssue(issues, { severity: "blocking", category: "DIES", code: "PLAN_DIES_TIME_OVERLAP", planNumber: left.planNumber, lineNumber: left.lineNumber, routeId: left.mbomProcessId, allocationId: left.source === "ALLOCATION" ? left.id : null, relatedAllocationId: right.source === "ALLOCATION" ? right.id : null, relatedScheduleId: right.source === "SCHEDULE" ? right.id : null, diesCode: dies?.diesCode || null, machineCode: machineById.get(left.machineId)?.machineCode || null, message: `Dies ${dies?.diesCode || left.diesId} dipakai bersamaan pada lebih dari satu jadwal.`, resolution: "Geser jam/tanggal salah satu proses atau gunakan Dies alternatif yang kompatibel." }, issueKeys);
      }
    }
  }

  // Production Plan rows can represent different SFG/child parts while their
  // routing still belongs to one predecessor chain. Since capacity is
  // allocated backwards from the required date, the last routing operation
  // must be visited first globally; otherwise a later sequence on another
  // plan line is placed on the first available date.
  const routesForPlanDetail = (detail) => (detail.partId ? routesByPartId.get(detail.partId) : null) || routesByPartCode.get(detail.partCode) || [];
  const capacityRouteCompare = (left, right) => {
    if (!left || !right) return left ? 1 : right ? -1 : 0;
    const leftPartId = left.mbomDetail?.partId || null;
    const rightPartId = right.mbomDetail?.partId || null;
    const leftParentId = left.mbomDetail?.parentDetail?.partId || null;
    const rightParentId = right.mbomDetail?.parentDetail?.partId || null;
    // A child/SFG operation produces the input consumed by its parent. It is
    // therefore always a predecessor, regardless of the numeric routing
    // label stored on the two separate BOM details.
    if (leftParentId && leftParentId === rightPartId) return -1;
    if (rightParentId && rightParentId === leftPartId) return 1;
    const routingDifference = compareRoutingOperations(left, right);
    if (routingDifference) return routingDifference;
    // Separate BOM headers can legitimately restart sequence at 1. Keep the
    // deterministic header order so PRG (MBOM ...-001) precedes the next
    // assembly header instead of being placed after it by UUID order.
    const headerDifference = String(left.noReg || "").localeCompare(String(right.noReg || ""), undefined, { numeric: true });
    if (headerDifference) return headerDifference;
    return String(left.id || "").localeCompare(String(right.id || ""));
  };
  const routeTasks = planDetails.flatMap((detail) => routesForPlanDetail(detail).map((route) => ({ detail, route })));
  const routeOrderByPlan = new Map();
  for (const task of routeTasks) {
    const planKey = task.detail.plan.planNumber;
    if (!routeOrderByPlan.has(planKey)) routeOrderByPlan.set(planKey, []);
    routeOrderByPlan.get(planKey).push(task);
  }
  const successorByRouteId = new Map();
  for (const tasks of routeOrderByPlan.values()) {
    const ordered = tasks.sort((left, right) => capacityRouteCompare(left.route, right.route));
    ordered.forEach((task, index) => successorByRouteId.set(task.route.id, ordered[index + 1]?.route.id || null));
  }
  const routeStartDates = new Map();
  const capacityPlanDetails = [...planDetails].map((detail) => {
    const part = planPartById.get(detail.partId) || planPartByCode.get(detail.partCode) || null;
    const fallbackUom = ["FG", "WIP"].includes(String(part?.itemType || "").trim().toUpperCase()) ? "PCS" : null;
    return {
      ...detail,
      uomCode: detail.uomCode || part?.productionUomCode || part?.baseUomCode || part?.stockUomCode || fallbackUom,
    };
  }).sort((left, right) => {
    const planDifference = String(left.plan.planNumber || "").localeCompare(String(right.plan.planNumber || ""));
    if (planDifference) return planDifference;
    const leftRoutes = routesForPlanDetail(left);
    const rightRoutes = routesForPlanDetail(right);
    const leftLast = leftRoutes.length ? [...leftRoutes].sort(capacityRouteCompare).at(-1) : null;
    const rightLast = rightRoutes.length ? [...rightRoutes].sort(capacityRouteCompare).at(-1) : null;
    if (leftLast || rightLast) {
      const routeDifference = capacityRouteCompare(rightLast, leftLast);
      if (routeDifference) return routeDifference;
    }
    const dateDifference = parseDateOnly(left.requiredDate) - parseDateOnly(right.requiredDate);
    return dateDifference || number(left.priority) - number(right.priority) || number(left.lineNumber) - number(right.lineNumber);
  });

  for (const machine of machines) {
    if (machine.status !== "Active") pushIssue(issues, { severity: "warning", code: "MACHINE_NOT_ACTIVE", machineCode: machine.machineCode, message: `${machine.machineCode} berstatus ${machine.status}.` }, issueKeys);
    const hasRoutingCycle = activeRoutes.some((route) => eligibleMachinesForRoute(route, false).some((candidate) => candidate.id === machine.id) && number(route.cycleTime) > 0);
    // A route-level cycle time is a valid fallback for capacity planning. Do
    // not raise a false machine-rate warning when the machine itself has no
    // default but every active route supplies its own cycle time.
    if (number(machine.capacity) <= 0 && number(machine.cycleTime) <= 0 && !hasRoutingCycle && activeRoutes.some((route) => eligibleMachinesForRoute(route, false).some((candidate) => candidate.id === machine.id))) {
      pushIssue(issues, { severity: "warning", code: "MACHINE_RATE_MISSING", machineCode: machine.machineCode, message: `${machine.machineCode} belum memiliki capacity atau cycle time master maupun routing.` }, issueKeys);
    }
  }

  for (const route of activeRoutes) {
    const partCode = route.mbomDetail?.part?.partCode || null;
    const routingMode = String(route.mbomDetail?.category || "").toUpperCase() === "VENDOR"
      ? "VENDOR"
      : String(route.routingMode || "INHOUSE").toUpperCase();
    if (routingMode !== "VENDOR") {
      if (!route.machineId) pushIssue(issues, { severity: "warning", code: "ROUTING_MACHINE_MISSING", routeId: route.id, partCode, message: `${partCode || route.noReg} · ${route.process?.processCode || "Process"} belum mempunyai mesin pada routing.` }, issueKeys);
      if (resolveCycleMinutes(route.cycleTime, route.machine, workingAvailableMinutes) <= 0) pushIssue(issues, { severity: "warning", code: "ROUTING_CYCLE_MISSING", routeId: route.id, partCode, machineCode: route.machine?.machineCode || null, message: `${partCode || route.noReg} · ${route.process?.processCode || "Process"} belum mempunyai cycle time.` }, issueKeys);
      const routeRequiresDies = isDiesCapacityBlockingEnabled() && isPressResource(route.machine || eligibleMachinesForRoute(route)[0], route);
      const compatibleDies = availableDies.filter((dies) => route.diesId === dies.id
        || dies.diesParts.some((mapping) => mapping.partId === route.mbomDetail?.partId));
      if (routeRequiresDies && !compatibleDies.length) {
        pushIssue(issues, {
          severity: "blocking",
          category: "DIES",
          code: "ROUTING_DIES_MISSING",
          routeId: route.id,
          partCode,
          processCode: capacityOperationCode(route),
          baseProcessCode: route.process?.processCode || null,
          machineCode: route.machine?.machineCode || null,
          message: `${partCode || route.noReg} belum memiliki Dies aktif yang terhubung ke routing/part.`,
          resolution: "Tetapkan Dies pada routing MBOM atau aktifkan mapping Dies-Part.",
        }, issueKeys);
      }
    } else if (!route.vendorId) {
      pushIssue(issues, {
        severity: "info",
        code: "ROUTING_VENDOR_SELECTED_AT_CAPACITY",
        routeId: route.id,
        partCode,
        message: `${partCode || route.noReg} · ${route.process?.processCode || "Process"} memilih vendor dan tanggal send/return saat Capacity Planning.`,
      }, issueKeys);
    }
  }

  const usedProcessIds = new Set(activeRoutes.map((route) => route.processId));
  for (const process of processes) {
    if (!usedProcessIds.has(process.id)) pushIssue(issues, { severity: "info", code: "PROCESS_NOT_ROUTED", processCode: process.processCode, message: `${process.processCode} belum dipakai pada routing MBOM aktif.` }, issueKeys);
  }

  for (const downtime of downtimes) {
    const row = rowByMachineCode.get(downtime.machineCode);
    const cell = row?.cells[dateKey(downtime.downtimeDate)];
    if (!cell) continue;
    cell.downtimeMinutes += number(downtime.durationMinutes);
    cell.items.push({ source: "DOWNTIME", reference: downtime.downtimeNumber, shift: downtime.shift, minutes: round(downtime.durationMinutes), label: downtime.reason, status: downtime.status });
  }

  // Historical production is shown separately from firm/proposed load. It
  // never changes the proposed capacity, but gives PPIC a real achieved-vs-
  // plan view for each machine/date cell.
  for (const log of productionLogs) {
    const row = rowByMachineCode.get(log.machineCode);
    const cell = row?.cells[dateKey(log.logDate)];
    if (!cell) continue;
    const machine = machineByCode.get(log.machineCode);
    const cycleMinutes = resolveCycleMinutes(0, machine, workingAvailableMinutes);
    const minutes = number(log.runningMinutes) > 0
      ? number(log.runningMinutes)
      : evaluateFromSet(formulas, "LOAD_MINUTES", { qty: number(log.qtyProduced), cycleTimeMinutes: cycleMinutes, efficiencyPercent: 100 });
    cell.actualMinutes += minutes;
    cell.items.push({ source: "HISTORY", reference: log.logNumber, shift: log.shift, partCode: null, processCode: log.processCode, qty: number(log.qtyProduced), qtyGood: number(log.qtyGood), qtyReject: number(log.qtyReject), minutes: round(minutes), status: log.status, moId: log.moId, woId: log.woId });
  }

  const woIds = [...new Set(schedules.map((row) => row.woId).filter(Boolean))];
  const workOrders = woIds.length ? await prisma.workOrder.findMany({
    where: { id: { in: woIds } },
    select: { id: true, mbomProcessId: true, cycleTime: true, outputPartCode: true, processId: true, machineId: true, diesId: true, process: { select: { processCode: true, processName: true } } },
  }) : [];
  const workOrderById = new Map(workOrders.map((row) => [row.id, row]));

  for (const schedule of schedules) {
    const machine = machineById.get(schedule.machineId);
    const row = rowByMachineId.get(schedule.machineId);
    const cell = row?.cells[dateKey(schedule.scheduleDate)];
    const wo = workOrderById.get(schedule.woId);
    const scheduledRoute = activeRouteById.get(schedule.mbomProcessId) || null;
    const operationCode = capacityOperationCode(scheduledRoute) || wo?.process?.processCode || processById.get(schedule.processId)?.processCode || null;
    const planMo = planMoById.get(schedule.moId) || planMoByNumber.get(schedule.moNumber);
    const scheduledProcessId = schedule.processId || wo?.processId || null;
    if (planMo?.monthlyProductionPlanNumber && planMo.monthlyProductionPlanLineNumber != null && scheduledProcessId) {
      const planProcessKey = capacityPlanRouteKey(planMo.monthlyProductionPlanNumber, planMo.monthlyProductionPlanLineNumber, schedule.mbomProcessId, scheduledProcessId);
      scheduledQtyByPlanProcess.set(planProcessKey, number(scheduledQtyByPlanProcess.get(planProcessKey)) + number(schedule.plannedQty));
    }
    const cycleMinutes = resolveCycleMinutes(wo?.cycleTime, machine, workingAvailableMinutes);
    const loadMinutes = evaluateFromSet(formulas, "LOAD_MINUTES", {
      qty: number(schedule.plannedQty),
      cycleTimeMinutes: cycleMinutes,
      efficiencyPercent: 100,
    });
    if (!cell || cycleMinutes <= 0) {
      unscheduled.push({ source: "FIRM", reference: schedule.scheduleNumber, partCode: schedule.partCode, processCode: operationCode, baseProcessCode: scheduledRoute?.process?.processCode || wo?.process?.processCode || null, mbomProcessId: schedule.mbomProcessId || null, machineCode: machine?.machineCode || null, qty: number(schedule.plannedQty), minutes: round(loadMinutes), reason: !machine ? "Mesin belum ditentukan" : "Cycle time belum tersedia" });
      continue;
    }
    cell.firmMinutes += loadMinutes;
    cell.actualMinutes += evaluateFromSet(formulas, "LOAD_MINUTES", {
      qty: number(schedule.actualQty),
      cycleTimeMinutes: cycleMinutes,
      efficiencyPercent: 100,
    });
    cell.items.push({ source: "FIRM", reference: schedule.scheduleNumber, planNumber: planMo?.monthlyProductionPlanNumber || null, lineNumber: planMo?.monthlyProductionPlanLineNumber || null, processId: scheduledProcessId, mbomProcessId: schedule.mbomProcessId || null, moNumber: schedule.moNumber, woNumber: schedule.woNumber, partCode: schedule.partCode, processCode: operationCode, baseProcessCode: scheduledRoute?.process?.processCode || wo?.process?.processCode || null, processName: scheduledRoute?.process?.processName || wo?.process?.processName || null, shift: schedule.shift, diesId: schedule.diesId || wo?.diesId || null, qty: number(schedule.plannedQty), uomCode: schedule.uomCode, minutes: round(loadMinutes), status: schedule.status });
  }

  // Draft in-house allocations are the PPIC planning source before MO/WO exists.
  // Published in-house rows are represented by their Daily Production Schedule
  // and must not be counted twice. Vendor allocations remain visible after
  // publish because their send-return interval has no machine heatmap row.
  for (const allocation of productionPlanAllocations) {
    const allocationDetail = planDetails.find((detail) =>
      detail.plan.planNumber === allocation.plan.planNumber
      && number(detail.lineNumber) === number(allocation.lineNumber));
    const processId = allocation.mbomProcess?.processId || null;
    const planProcessKey = capacityPlanRouteKey(allocation.plan.planNumber, allocation.lineNumber, allocation.mbomProcessId, processId);
    if (processId) {
      const scheduledQty = String(allocation.routingMode || "INHOUSE").toUpperCase() === "VENDOR"
        ? number(allocation.expectedReturnQty ?? allocation.plannedQty)
        : number(allocation.plannedQty);
      scheduledQtyByPlanProcess.set(
        planProcessKey,
        number(scheduledQtyByPlanProcess.get(planProcessKey)) + scheduledQty,
      );
    }
    if (String(allocation.routingMode || "INHOUSE").toUpperCase() === "VENDOR") {
      const vendor = vendorById.get(allocation.vendorId);
      const deliveryPhase = deliveryPhases.find((phase) => phase.id === allocation.deliveryPhaseId);
      const planningDecision = planningConstraintByTarget.get(deliveryPhase?.sourceDeliveryTargetId) || null;
      const masterRoute = activeRoutes.find((route) => route.id === allocation.mbomProcessId) || null;
      const vendorPlanning = effectiveVendorLeadTime(masterRoute || { vendor }, planningDecision, 8);
      const sendDate = allocation.vendorSendDate || allocation.scheduleDate;
      const returnDate = allocation.vendorReturnDate || allocation.scheduleDate;
      const plannedLeadTimeDays = Math.max(Math.ceil((parseDateOnly(returnDate) - parseDateOnly(sendDate)) / DAY_MS), 0);
      const returnDeadline = resolveVendorReturnDeadline(allocation, productionPlanAllocations);
      const requiredDate = returnDeadline?.deadline || null;
      const returnQty = number(allocation.expectedReturnQty ?? allocation.plannedQty);
      const returnMoment = allocationFinishMoment(allocation);
      const isLate = requiredDate && returnMoment > requiredDate;
      const effectivePlanningLeadTimeDays = vendorPlanning.planningDays || number(allocation.vendorLeadTimeDays ?? vendor?.leadTimeDays);
      const leadTimeShort = effectivePlanningLeadTimeDays > plannedLeadTimeDays;
      if (["Confirmed", "Released", "In Progress"].includes(allocation.plan.status) && isLate) {
        const deadlineLabel = returnDeadline.source === "SUCCESSOR_START"
          ? `proses berikutnya ${returnDeadline.successorProcessCode || "successor"} mulai`
          : "batas selesai routing/FG";
        pushIssue(issues, {
          severity: "blocking",
          category: "VENDOR",
          code: "VENDOR_RETURN_AFTER_REQUIRED_DATE",
          allocationId: allocation.id,
          planNumber: allocation.plan.planNumber,
          lineNumber: allocation.lineNumber,
          partCode: allocationDetail?.partCode || null,
          processCode: capacityOperationCode(allocation.mbomProcess),
          baseProcessCode: allocation.mbomProcess?.process?.processCode || null,
          routeId: allocation.mbomProcessId,
          successorAllocationId: returnDeadline.successorAllocationId,
          deadlineSource: returnDeadline.source,
          message: `${allocationDetail?.partCode || "Part"} · return vendor ${dateKey(returnDate)} melewati ${deadlineLabel} ${dateKey(requiredDate)}.`,
          resolution: returnDeadline.source === "SUCCESSOR_START"
            ? "Majukan vendor return atau geser proses successor setelah material vendor kembali."
            : "Majukan vendor send/return agar selesai sebelum FG required date.",
        }, issueKeys);
      }
      if (leadTimeShort) {
        pushIssue(issues, {
          severity: ["Confirmed", "Released", "In Progress"].includes(allocation.plan.status) ? "blocking" : "warning",
          category: "VENDOR",
          code: "VENDOR_LEAD_TIME_BELOW_MASTER",
          planNumber: allocation.plan.planNumber,
          lineNumber: allocation.lineNumber,
          partCode: allocationDetail?.partCode || null,
          processCode: capacityOperationCode(allocation.mbomProcess),
          baseProcessCode: allocation.mbomProcess?.process?.processCode || null,
          routeId: allocation.mbomProcessId,
          message: `Jadwal vendor ${plannedLeadTimeDays} hari lebih pendek dari lead time planning ${effectivePlanningLeadTimeDays} hari.`,
          resolution: "Majukan tanggal kirim, mundurkan return yang realistis, atau gunakan vendor dengan lead time yang memenuhi due date.",
        }, issueKeys);
      }
      vendorAssignments.push({
        source: allocation.status === "Published"
          ? "PUBLISHED"
          : allocation.allocationSource === "AUTO_RECOMMENDATION" ? "RECOMMENDED" : "MANUAL",
        allocationId: allocation.id,
        planningMode: allocation.planningMode,
        scenarioKey: allocation.scenarioKey,
        planNumber: allocation.plan.planNumber,
        lineNumber: allocation.lineNumber,
        scheduleDate: dateKey(sendDate),
        sendDate: dateKey(sendDate),
        returnDate: dateKey(returnDate),
        requiredDate: requiredDate ? dateKey(requiredDate) : null,
        requiredDateSource: returnDeadline?.source || null,
        successorAllocationId: returnDeadline?.successorAllocationId || null,
        successorProcessCode: returnDeadline?.successorProcessCode || null,
        plannedLeadTimeDays,
        masterLeadTimeDays: number(vendor?.leadTimeDays ?? vendorPlanning.masterDays),
        planningLeadTimeDays: effectivePlanningLeadTimeDays,
        leadTimeSource: vendorPlanning.adjustmentApplied ? "DEMAND_PLANNING_CONFIRMED" : "VENDOR_MASTER",
        planningDecisionTargetId: planningDecision?.planningDecisionTargetId || null,
        vendorAdjustmentReason: vendorPlanning.reason,
        deliveryPhaseId: allocation.deliveryPhaseId,
        deliveryPhaseNumber: allocation.deliveryPhaseNumber,
        transferBatchNumber: allocation.transferBatchNumber,
        predecessorAllocationIds: allocation.predecessorAllocationIds || [],
        recommendationReason: allocation.recommendationReason,
        recommendationScore: allocation.recommendationScore,
        recommendationScoreBreakdown: allocation.recommendationScoreBreakdown,
        partCode: allocationDetail?.partCode || null,
        demandSourceType: allocation.demandSourceType,
        demandSourceNumber: allocation.demandSourceNumber,
        customerCode: allocation.customerCode,
        customerTargetDate: allocation.customerTargetDate,
        fgRequiredDate: allocation.fgRequiredDate,
        priorityScore: allocation.priorityScore,
        priorityClass: allocation.priorityClass,
        capacityLate: allocation.capacityLate,
        earliestFeasibleCompletion: allocation.earliestFeasibleCompletion,
        processCode: capacityOperationCode(allocation.mbomProcess),
        baseProcessCode: allocation.mbomProcess?.process?.processCode || null,
        processName: allocation.mbomProcess?.process?.processName || null,
        mbomProcessId: allocation.mbomProcessId,
        vendorId: allocation.vendorId,
        routingMode: allocation.routingMode,
        shift: allocation.shift,
        qty: number(allocation.plannedQty),
        expectedReturnQty: returnQty,
        uomCode: allocation.uomCode,
        status: isLate || leadTimeShort || returnQty + 0.000001 < number(allocation.plannedQty) ? "AT_RISK" : allocation.status,
        riskReasons: [
          ...(isLate ? ["RETURN_AFTER_REQUIRED_DATE"] : []),
          ...(leadTimeShort ? ["BELOW_VENDOR_MASTER_LEAD_TIME"] : []),
          ...(returnQty + 0.000001 < number(allocation.plannedQty) ? ["EXPECTED_RETURN_SHORTAGE"] : []),
        ],
        reason: allocation.notes,
      });
      continue;
    }
    if (allocation.status !== "Draft") continue;
    const machine = machineById.get(allocation.machineId);
    const cell = rowByMachineId.get(allocation.machineId)?.cells[dateKey(allocation.scheduleDate)];
    // Monthly Plan is a capacity commitment, not an ideal-cycle stopwatch.
    // Keep a fixed 20% runtime allowance for minor downtime, handling, and
    // normal micro-stops. Daily execution can later refine the exact hours.
    const cycleMinutes = resolveCycleMinutes(allocation.mbomProcess?.cycleTime, machine, workingAvailableMinutes)
      * MONTHLY_PLAN_RUNTIME_ALLOWANCE_FACTOR;
    const loadMinutes = evaluateFromSet(formulas, "LOAD_MINUTES", {
      qty: number(allocation.plannedQty),
      cycleTimeMinutes: cycleMinutes,
      efficiencyPercent: 100,
    });
    if (!machine || !cell || cycleMinutes <= 0) {
      unscheduled.push({
        source: "MANUAL",
        allocationId: allocation.id,
        planNumber: allocation.plan.planNumber,
        reference: allocation.plan.planNumber,
        lineNumber: allocation.lineNumber,
        mbomProcessId: allocation.mbomProcessId,
        machineId: allocation.machineId,
        scheduleDate: dateKey(allocation.scheduleDate),
        routingMode: allocation.routingMode,
        shift: allocation.shift,
        planningMode: allocation.planningMode,
        scenarioKey: allocation.scenarioKey,
        partCode: allocationDetail?.partCode || null,
        processCode: capacityOperationCode(allocation.mbomProcess),
        baseProcessCode: allocation.mbomProcess?.process?.processCode || null,
        machineCode: machine?.machineCode || null,
        qty: number(allocation.plannedQty),
        uomCode: allocation.uomCode,
        minutes: round(loadMinutes),
        notes: allocation.notes,
        reason: !machine ? "Mesin alokasi tidak tersedia" : !cell ? "Tanggal alokasi di luar horizon" : "Cycle time belum tersedia",
      });
      continue;
    }
    cell.proposedMinutes += loadMinutes;
    cell.items.push({
      source: allocation.allocationSource === "AUTO_RECOMMENDATION" ? "RECOMMENDED" : "MANUAL",
      allocationId: allocation.id,
      planningMode: allocation.planningMode,
      scenarioKey: allocation.scenarioKey,
      reference: allocation.plan.planNumber,
      planNumber: allocation.plan.planNumber,
      lineNumber: allocation.lineNumber,
      partCode: allocationDetail?.partCode || null,
      processId,
      processCode: capacityOperationCode(allocation.mbomProcess),
      baseProcessCode: allocation.mbomProcess?.process?.processCode || null,
      processName: allocation.mbomProcess?.process?.processName || null,
      mbomProcessId: allocation.mbomProcessId,
      routingMode: "INHOUSE",
      machineId: allocation.machineId,
      diesId: allocation.diesId || allocation.mbomProcess?.diesId || null,
      scheduleDate: dateKey(allocation.scheduleDate),
      shift: allocation.shift,
      plannedStartTime: allocation.plannedStartTime,
      plannedEndTime: allocation.plannedEndTime,
      capacityMode: allocation.capacityMode,
      deliveryPhaseId: allocation.deliveryPhaseId,
      deliveryPhaseNumber: allocation.deliveryPhaseNumber,
      transferBatchNumber: allocation.transferBatchNumber,
      predecessorAllocationIds: allocation.predecessorAllocationIds || [],
      recommendationReason: allocation.recommendationReason,
      recommendationScore: allocation.recommendationScore,
      recommendationScoreBreakdown: allocation.recommendationScoreBreakdown,
      demandSourceType: allocation.demandSourceType,
      demandSourceNumber: allocation.demandSourceNumber,
      customerCode: allocation.customerCode,
      customerTargetDate: allocation.customerTargetDate,
      fgRequiredDate: allocation.fgRequiredDate,
      priorityScore: allocation.priorityScore,
      priorityClass: allocation.priorityClass,
      latestStartDate: allocation.latestStartDate,
      latestFinishDate: allocation.latestFinishDate,
      capacityLate: allocation.capacityLate,
      earliestFeasibleCompletion: allocation.earliestFeasibleCompletion,
      qty: number(allocation.plannedQty),
      uomCode: allocation.uomCode,
      minutes: round(loadMinutes),
      status: allocation.status,
      notes: allocation.notes,
    });
  }

  for (const detail of capacityPlanDetails) {
    const plannedQty = Math.max(capacityQty(detail.qtyPlanned, detail.uomCode), 0);
    if (plannedQty <= 0) continue;
    const planPart = planPartById.get(detail.partId) || planPartByCode.get(detail.partCode) || null;
    const isFgReceiptLine = String(planPart?.itemType || "").trim().toUpperCase() === "FG"
      && (
        String(planPart?.partType || "STANDARD").trim().toUpperCase() !== "COMP"
        || /\[FG-RECEIPT(?::CHILD)?\]/i.test(String(detail.notes || ""))
      );
    // FG receipt is an inventory milestone, not a machine operation. A
    // non-COMP FG is therefore valid without its own routing process.
    if (isFgReceiptLine) {
      fgReceipts.push({
        planNumber: detail.plan.planNumber,
        lineNumber: detail.lineNumber,
        partCode: detail.partCode,
        partName: planPart?.partName || null,
        partNumber: planPart?.partNumber || null,
        partType: planPart?.partType || null,
        qty: plannedQty,
        uomCode: detail.uomCode,
        receiptDate: dateKey(detail.requiredDate || detail.plan.periodEnd),
        status: detail.plan.status,
      });
      continue;
    }
    const partRoutes = routesForPlanDetail(detail);
    if (!partRoutes.length) {
      pushIssue(issues, {
        severity: "blocking",
        code: "PLAN_ROUTING_MISSING",
        planNumber: detail.plan.planNumber,
        lineNumber: detail.lineNumber,
        partCode: detail.partCode,
        partName: planPart?.partName || null,
        partNumber: planPart?.partNumber || null,
        partType: planPart?.partType || null,
        bomNumber: detail.partId ? latestHeaderByPart.get(detail.partId) || null : null,
        message: `${detail.partCode}${planPart?.partName ? ` · ${planPart.partName}` : ""} belum memiliki routing process.`,
      }, issueKeys);
      unscheduled.push({ source: "PROPOSED", reference: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, qty: plannedQty, uomCode: detail.uomCode, minutes: 0, reason: "Routing process belum tersedia" });
      continue;
    }

    // Capacity is planned backwards from the required date. Allocate the
    // final operation first (closest to the due date), then walk back through
    // its predecessors. The comparator also follows BOM child -> parent
    // dependencies, so a PRG output is available before a downstream WELD.
    const orderedRoutes = canonicalizeRoutingOperations(partRoutes).sort(capacityRouteCompare).reverse();
    for (const route of orderedRoutes) {
      const planProcessKey = capacityPlanRouteKey(detail.plan.planNumber, detail.lineNumber, route.id, route.processId);
      const remainingQty = Math.max(plannedQty - number(scheduledQtyByPlanProcess.get(planProcessKey)), 0);
      if (remainingQty <= 0) continue;
      const routeOverridePrefix = `${detail.plan.planNumber}|${detail.lineNumber}|${route.id}|`;
      const machineOverrideEntry = [...machineOverrideByRouteDate.entries()].find(([key]) => key.startsWith(routeOverridePrefix));
      const machineOverride = machineOverrideEntry?.[1] || null;
      const bomRoutingMode = String(route.mbomDetail?.category || "").toUpperCase() === "VENDOR"
        ? "VENDOR"
        : String(route.routingMode || "INHOUSE").toUpperCase();
      const effectiveRoutingMode = String(machineOverride?.routingMode || bomRoutingMode).toUpperCase();
      if (effectiveRoutingMode === "VENDOR") {
        const vendorId = machineOverride?.vendorId || route.vendorId || null;
        const vendor = vendorById.get(vendorId);
        const phaseForDetail = deliveryPhases.find((phase) => phase.mpsDetailId === detail.mpsDetailId) || null;
        const planningDecision = planningConstraintByTarget.get(phaseForDetail?.sourceDeliveryTargetId) || null;
        const vendorPlanning = effectiveVendorLeadTime(route, planningDecision, 8);
        const returnDate = parseDateOnly(detail.requiredDate || detail.plan.periodEnd);
        const sendDate = machineOverride?.scheduleDate
          ? parseDateOnly(machineOverride.scheduleDate)
          : addDays(returnDate, -Math.max(number(vendorPlanning.planningDays || vendor?.leadTimeDays), 0));
        vendorAssignments.push({
          source: "PROPOSED",
          planNumber: detail.plan.planNumber,
          lineNumber: detail.lineNumber,
          scheduleDate: dateKey(sendDate),
          sendDate: dateKey(sendDate),
          returnDate: dateKey(returnDate),
          requiredDate: dateKey(detail.requiredDate || detail.plan.periodEnd),
          plannedLeadTimeDays: Math.max(Math.ceil((returnDate - sendDate) / DAY_MS), 0),
          masterLeadTimeDays: number(vendor?.leadTimeDays),
          planningLeadTimeDays: number(vendorPlanning.planningDays || vendor?.leadTimeDays),
          leadTimeSource: vendorPlanning.adjustmentApplied ? "DEMAND_PLANNING_CONFIRMED" : "VENDOR_MASTER",
          planningDecisionTargetId: planningDecision?.planningDecisionTargetId || null,
          vendorAdjustmentReason: vendorPlanning.reason,
          partCode: detail.partCode,
          processCode: capacityOperationCode(route),
          baseProcessCode: route.process?.processCode || null,
          processName: route.process?.processName || null,
          mbomProcessId: route.id,
          vendorId,
          diesId: machineOverride?.diesId || route.diesId,
          qty: remainingQty,
          expectedReturnQty: remainingQty,
          uomCode: detail.uomCode,
          status: vendorId ? "PROPOSED" : "VENDOR_TO_SELECT",
          reason: machineOverride?.reason || "Referensi routing BOM; jadwal final ditentukan PPIC",
        });
        routeStartDates.set(route.id, sendDate);
        continue;
      }
      const eligibleMachines = eligibleMachinesForRoute(route);
      const machine = bestEligibleMachine(route, machineOverride?.scheduleDate || detail.requiredDate || detail.plan.periodEnd, machineOverride?.machineId);
      const suggestedMachines = eligibleMachines.filter((candidate) => candidate.id !== machine?.id);
      const cycleMinutes = resolveCycleMinutes(route.cycleTime, machine, workingAvailableMinutes);
      if (!machine) {
        pushIssue(issues, { severity: "blocking", code: "PLAN_MACHINE_MISSING", planNumber: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, partName: planPart?.partName || null, bomNumber: route.noReg || null, processCode: capacityOperationCode(route), baseProcessCode: route.process?.processCode || null, processName: route.process?.processName || null, routeId: route.id, message: `${detail.partCode} · ${capacityOperationCode(route) || "Process"} belum ditentukan mesinnya.` }, issueKeys);
        unscheduled.push({ source: "PROPOSED", reference: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, processCode: capacityOperationCode(route), baseProcessCode: route.process?.processCode || null, mbomProcessId: route.id, machineSpecificationCode: routeSpecificationCode(route), qty: remainingQty, uomCode: detail.uomCode, minutes: round(evaluateFromSet(formulas, "LOAD_MINUTES", { qty: remainingQty, cycleTimeMinutes: cycleMinutes, efficiencyPercent: 100 })), reason: "Tidak ada mesin aktif yang memenuhi Machine Specification", suggestedMachines: [] });
        continue;
      }
      if (machine.status !== "Active") {
        pushIssue(issues, { severity: "blocking", code: "PLAN_MACHINE_INACTIVE", planNumber: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, partName: planPart?.partName || null, bomNumber: route.noReg || null, processCode: capacityOperationCode(route), baseProcessCode: route.process?.processCode || null, processName: route.process?.processName || null, routeId: route.id, machineCode: machine.machineCode, machineName: machine.machineName || null, message: `${machine.machineName || machine.machineCode} tidak Active untuk ${detail.partCode}.` }, issueKeys);
      }
      if (cycleMinutes <= 0) {
        pushIssue(issues, { severity: "blocking", code: "PLAN_CYCLE_MISSING", planNumber: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, partName: planPart?.partName || null, bomNumber: route.noReg || null, processCode: capacityOperationCode(route), baseProcessCode: route.process?.processCode || null, processName: route.process?.processName || null, routeId: route.id, machineCode: machine.machineCode, machineName: machine.machineName || null, message: `${detail.partCode} · ${capacityOperationCode(route) || "Process"} belum memiliki cycle time.` }, issueKeys);
        unscheduled.push({ source: "PROPOSED", reference: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, processCode: capacityOperationCode(route), baseProcessCode: route.process?.processCode || null, mbomProcessId: route.id, machineCode: machine.machineCode, qty: remainingQty, uomCode: detail.uomCode, minutes: 0, reason: "Cycle time belum tersedia" });
        continue;
      }

      let remainingMinutes = evaluateFromSet(formulas, "LOAD_MINUTES", {
        qty: remainingQty,
        cycleTimeMinutes: cycleMinutes,
        efficiencyPercent: 100,
      });
      const successorStart = routeStartDates.get(successorByRouteId.get(route.id));
      const routeDue = parseDateOnly(machineOverride?.scheduleDate || detail.requiredDate || detail.plan.periodEnd);
      let due = routeDue;
      if (successorStart) {
        // Prefer the previous working day for the hand-off. If the horizon
        // starts on a weekend/holiday (e.g. Aug-2026 starts on Saturday),
        // allow the predecessor on the successor's date so it is not lost
        // entirely; the route sequence remains available for same-day
        // dispatch ordering.
        let predecessorDue = addDays(successorStart, -1);
        while (predecessorDue >= range.start) {
          const predecessorCell = rowByMachineId.get(machine.id)?.cells[dateKey(predecessorDue)];
          if (predecessorCell?.baseAvailableMinutes > 0) break;
          predecessorDue = addDays(predecessorDue, -1);
        }
        if (predecessorDue < range.start) predecessorDue = successorStart;
        if (predecessorDue < due) due = predecessorDue;
      }
      let cursor = due > range.end ? range.end : due < range.start ? range.start : due;
      let firstAllocatedDate = null;
      while (remainingMinutes > 0 && cursor >= range.start) {
        const cell = rowByMachineId.get(machine.id)?.cells[dateKey(cursor)];
        if (!cell) break;
        const freeMinutes = evaluateFromSet(formulas, "CAPACITY_AVAILABLE_MINUTES", {
          baseAvailableMinutes: cell.baseAvailableMinutes,
          downtimeMinutes: cell.downtimeMinutes + cell.firmMinutes + cell.proposedMinutes,
        });
        let allocatedMinutes = Math.min(remainingMinutes, freeMinutes);
        if (allocatedMinutes > 0) {
          let allocatedQty = allocatedMinutes / cycleMinutes;
          if (isDiscreteUom(detail.uomCode)) {
            allocatedQty = Math.min(Math.floor(allocatedQty + 0.000001), Math.round(remainingMinutes / cycleMinutes));
            allocatedMinutes = allocatedQty * cycleMinutes;
          }
          if (allocatedQty <= 0 || allocatedMinutes <= 0) {
            cursor = addDays(cursor, -1);
            continue;
          }
          cell.proposedMinutes += allocatedMinutes;
          const allocatedDate = dateKey(cursor);
          if (!firstAllocatedDate || allocatedDate < firstAllocatedDate) firstAllocatedDate = allocatedDate;
          const routeDies = machineOverride?.diesId || route.diesId || availableDies.find((dies) => dies.diesParts.some((mapping) => mapping.partId === route.mbomDetail?.partId))?.id || null;
          cell.items.push({ source: "PROPOSED", reference: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, processCode: capacityOperationCode(route), baseProcessCode: route.process?.processCode || null, processName: route.process?.processName || null, routingNumber: route.routingNumber, sequence: number(route.sourceSequence || route.sequence), routingSequence: number(route.sourceSequence || route.sequence), mbomProcessId: route.id, diesId: routeDies, routingMode: "INHOUSE", machineSpecificationCode: routeSpecificationCode(route), allowedMachineIds: eligibleMachines.map((candidate) => candidate.id), machineOverride: machineOverride ? { machineId: machine.id, reason: machineOverride.reason } : null, qty: capacityQty(allocatedQty, detail.uomCode), uomCode: detail.uomCode, minutes: round(allocatedMinutes), status: detail.plan.status });
          remainingMinutes -= allocatedMinutes;
        }
        cursor = addDays(cursor, -1);
      }
      if (firstAllocatedDate) routeStartDates.set(route.id, parseDateOnly(firstAllocatedDate));
      if (remainingMinutes > 0) {
        pushIssue(issues, { severity: "overridable", code: "PLAN_CAPACITY_SHORTAGE", planNumber: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, partName: planPart?.partName || null, bomNumber: route.noReg || null, processCode: capacityOperationCode(route), baseProcessCode: route.process?.processCode || null, processName: route.process?.processName || null, routeId: route.id, machineCode: machine.machineCode, machineName: machine.machineName || null, message: `${machine.machineName || machine.machineCode} kekurangan ${round(remainingMinutes)} menit untuk ${detail.partCode}${planPart?.partName ? ` · ${planPart.partName}` : ""} dalam horizon.` }, issueKeys);
        unscheduled.push({ source: "PROPOSED", reference: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, processCode: capacityOperationCode(route), baseProcessCode: route.process?.processCode || null, mbomProcessId: route.id, machineCode: machine.machineCode, machineSpecificationCode: routeSpecificationCode(route), qty: capacityQty(remainingMinutes / cycleMinutes, detail.uomCode), uomCode: detail.uomCode, minutes: round(remainingMinutes), reason: "Kapasitas horizon tidak mencukupi", suggestedMachines: suggestedMachines.map((item) => ({ id: item.id, machineCode: item.machineCode, machineName: item.machineName })) });
      }
    }
  }

  const manualAllocationCatalog = [];
  for (const detail of capacityPlanDetails) {
    const orderedDetailRoutes = canonicalizeRoutingOperations(routesForPlanDetail(detail)).sort(capacityRouteCompare);
    for (const route of orderedDetailRoutes) {
      if (!route.processId) continue;
      const primaryInput = route.id === orderedDetailRoutes[0]?.id ? recommendationPrimaryInput(route) : null;
      const remainingQty = Math.max(capacityQty(number(detail.qtyPlanned) - number(scheduledQtyByPlanProcess.get(capacityPlanRouteKey(detail.plan.planNumber, detail.lineNumber, route.id, route.processId))), detail.uomCode), 0);
      if (remainingQty <= 0.000001) continue;
      const routeOverridePrefix = `${detail.plan.planNumber}|${detail.lineNumber}|${route.id}|`;
      const routeOverride = [...machineOverrideByRouteDate.entries()].find(([key]) => key.startsWith(routeOverridePrefix))?.[1] || null;
      const bomRoutingMode = String(route.mbomDetail?.category || "").toUpperCase() === "VENDOR"
        ? "VENDOR"
        : String(route.routingMode || "INHOUSE").toUpperCase();
      const routingMode = String(routeOverride?.routingMode || bomRoutingMode).toUpperCase();
      const vendorId = routeOverride?.vendorId || route.vendorId || null;
      const vendor = vendorById.get(vendorId);
      const allowedMachineIds = eligibleMachinesForRoute(route).map((machine) => machine.id);
      manualAllocationCatalog.push({
        planNumber: detail.plan.planNumber,
        planStatus: detail.plan.status,
        lineNumber: detail.lineNumber,
        mpsDetailId: detail.mpsDetailId || null,
        partCode: detail.partCode,
        outputPartCode: route.mbomDetail?.part?.partCode || detail.partCode,
        inputPartCode: primaryInput?.partCode || null,
        inputQtyPerOutput: primaryInput?.qtyPerOutput || null,
        processId: route.processId,
        processCode: capacityOperationCode(route),
        baseProcessCode: route.process?.processCode || null,
        processName: route.process?.processName || null,
        mbomProcessId: route.id,
        routingNumber: route.routingNumber || null,
        sequence: number(route.sourceSequence || route.sequence),
        routingMode,
        machineSpecificationCode: routeSpecificationCode(route),
        allowedMachineIds,
        requiresDies: isDiesCapacityBlockingEnabled() && isPressResource(machineById.get(route.machineId) || machineById.get(allowedMachineIds[0]), route),
        diesId: routeOverride?.diesId || route.diesId || null,
        allowedDiesIds: availableDies.filter((dies) => route.diesId === dies.id || dies.diesParts.some((mapping) => mapping.partId === route.mbomDetail?.partId)).map((dies) => dies.id),
        cycleMinutesByMachine: Object.fromEntries(allowedMachineIds.map((machineId) => [
          machineId,
          round(resolveCycleMinutes(route.cycleTime, machineById.get(machineId), workingAvailableMinutes), 6),
        ])),
        vendorId,
        vendorLeadTimeDays: number(vendor?.leadTimeDays),
        recommendedReturnDate: dateKey(detail.requiredDate || detail.plan.periodEnd),
        recommendedSendDate: dateKey(addDays(detail.requiredDate || detail.plan.periodEnd, -Math.max(number(vendor?.leadTimeDays), 0))),
        remainingQty: capacityQty(remainingQty, detail.uomCode),
        uomCode: detail.uomCode || null,
        requiredDate: detail.requiredDate,
        fgRequiredDate: detail.fgRequiredDate || null,
        deliveryPhaseId: detail.deliveryPhaseId || null,
      });
    }
  }
  for (const task of manualAllocationCatalog.filter((item) => item.planStatus === "Confirmed" && number(item.remainingQty) > 0.000001)) {
    pushIssue(issues, {
      severity: "blocking",
      code: "MPP_ROUTE_ALLOCATION_INCOMPLETE",
      planNumber: task.planNumber,
      lineNumber: task.lineNumber,
      partCode: task.partCode,
      processCode: task.processCode,
      routeId: task.mbomProcessId,
      message: `${task.partCode} · ${task.processName || task.processCode || `Seq ${task.sequence}`} masih perlu dialokasikan ${capacityQtyText(task.remainingQty, task.uomCode)} ${task.uomCode || ""} pada Capacity Check.`,
    }, issueKeys);
  }

  const deliveryCoverage = [];
  const recommendationPhaseById = new Map();
  const fgCompletionDaysByPlan = new Map();
  for (const detail of planDetails) {
    const summary = detail.plan?.recommendationSummary;
    for (const result of Array.isArray(summary?.phaseResults) ? summary.phaseResults : []) {
      if (result.phaseId) recommendationPhaseById.set(result.phaseId, result);
    }
    fgCompletionDaysByPlan.set(
      detail.plan.planNumber,
      Math.max(Math.trunc(number(summary?.capacityFlowRule?.active?.delivery?.fgCompletionDaysBefore)), 0),
    );
  }
  for (const detail of planDetails.filter((row) => row.mpsDetailId && !String(row.notes || "").includes("[MRP-PRODUCTION]"))) {
    const mpsNumber = String(detail.plan.sourceType || "").startsWith("MPS:") ? String(detail.plan.sourceType).slice(4) : null;
    if (!mpsNumber) continue;
    const detailTargetKey = mrpTargetKey(detail);
    const configured = deliveryPhases.filter((phase) => phase.mpsNumber === mpsNumber && phase.mpsDetailId === detail.mpsDetailId
      && (!detailTargetKey || detailTargetKey === String(phase.sourceDeliveryTargetId || "")));
    const configuredQty = configured.reduce((sum, phase) => sum + number(phase.qtyPlanned), 0);
    // Delivery phases cover gross customer demand only. Buffer stock remains a
    // valid internal production target and must not be reported as an
    // incomplete customer delivery phase.
    const customerDemandQty = Math.max(
      number(detail.actualSalesOrderQty),
      number(detail.forecastQty),
      number(detail.effectiveDemandQty) - number(detail.bufferQty),
      0,
    );
    const shortageQty = Math.max(customerDemandQty - configuredQty, 0);
    if (shortageQty <= 0.000001) continue;
    const code = configured.length ? "DELIVERY_PHASE_QTY_SHORT" : "DELIVERY_PHASE_REQUIRED";
    pushIssue(issues, {
      severity: "blocking", category: "DELIVERY", code,
      planNumber: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode,
      message: configured.length
        ? `Delivery Schedule MPS ${detail.partCode} masih kurang ${capacityQtyText(shortageQty, detail.uomCode)} ${detail.uomCode || ""}; sistem tidak membuat phase pelengkap.`
        : `Delivery Schedule MPS ${detail.partCode} belum dibuat; sistem tidak membuat phase otomatis.`,
      resolution: "Lengkapi tanggal, customer, dan qty phase pada Delivery Schedule MPS.",
    }, issueKeys);
    deliveryCoverage.push({
      phaseId: null, phaseNumber: null, mpsNumber, mpsDetailId: detail.mpsDetailId,
      planNumber: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode,
      targetType: "CUSTOMER", targetCode: null, plannedDate: detail.requiredDate ? dateKey(detail.requiredDate) : null,
      phaseQty: 0, cumulativeRequiredQty: customerDemandQty, plannedQtyByDueDate: configuredQty,
      shortageQty: capacityQty(shortageQty, detail.uomCode), uomCode: detail.uomCode, status: configured.length ? "INCOMPLETE" : "MISSING",
    });
  }
  const directReceiptByTarget = new Map();
  const directReceiptFallback = new Map();
  const targetScopedReceiptSources = new Set();
  for (const detail of planDetails.filter((row) =>
    row.mpsDetailId && !String(row.notes || "").includes("[MRP-PRODUCTION]"))) {
    const sourceKey = detail.plan.sourceType + "|" + detail.mpsDetailId;
    const targetKey = mrpTargetKey(detail);
    if (targetKey) {
      directReceiptByTarget.set(sourceKey + "|" + targetKey, detail);
      targetScopedReceiptSources.add(sourceKey);
    } else {
      directReceiptFallback.set(sourceKey, detail);
    }
  }
  const auditedStockCoverageByPhaseId = new Map();
  const auditedStockHistoryByPhaseId = new Map();
  for (const allocation of productionPlanAllocations) {
    if (!allocation.deliveryPhaseId) continue;
    const quantityAudit = allocation.recommendationScoreBreakdown?.audit?.quantityCalculation;
    if (!quantityAudit || quantityAudit.fgStockCoverageQty == null) continue;
    auditedStockCoverageByPhaseId.set(
      allocation.deliveryPhaseId,
      Math.max(number(auditedStockCoverageByPhaseId.get(allocation.deliveryPhaseId)), number(quantityAudit.fgStockCoverageQty)),
    );
    if (!auditedStockHistoryByPhaseId.has(allocation.deliveryPhaseId) && Array.isArray(quantityAudit.fgStockCoverageHistory)) {
      auditedStockHistoryByPhaseId.set(allocation.deliveryPhaseId, quantityAudit.fgStockCoverageHistory);
    }
  }
  const initialStockQtyByDetailId = new Map();
  const remainingFinishedGoodStock = new Map(availableFinishedGoodByPartUom);
  const directReceiptDetails = planDetails
    .filter((detail) => detail.mpsDetailId && !String(detail.notes || "").includes("[MRP-PRODUCTION]"))
    .sort((left, right) => parseDateOnly(left.requiredDate) - parseDateOnly(right.requiredDate));
  for (const detail of directReceiptDetails) {
    const mpsNumber = String(detail.plan.sourceType || "").startsWith("MPS:") ? String(detail.plan.sourceType).slice(4) : null;
    const detailTargetKey = mrpTargetKey(detail);
    const deliveryDemandQty = deliveryPhases
      .filter((phase) => phase.mpsNumber === mpsNumber && phase.mpsDetailId === detail.mpsDetailId
        && (!detailTargetKey || detailTargetKey === String(phase.sourceDeliveryTargetId || "")))
      .reduce((sum, phase) => sum + number(phase.qtyPlanned), 0);
    const stockKey = `${detail.partCode}|${String(detail.uomCode || "").toLowerCase()}`;
    const availableQty = number(remainingFinishedGoodStock.get(stockKey));
    // qtyPlanned on the receipt line is the stock-netted MRP production
    // target, while delivery phases retain gross customer demand. Only the
    // difference may be covered by opening FG stock.
    const stockCoverageQty = Math.min(
      availableQty,
      Math.max(deliveryDemandQty - number(detail.qtyPlanned), 0),
    );
    initialStockQtyByDetailId.set(detail.id, stockCoverageQty);
    remainingFinishedGoodStock.set(stockKey, Math.max(availableQty - stockCoverageQty, 0));
  }
  const cumulativeRequiredByDetail = new Map();
  for (const phase of deliveryPhases) {
    const sourceKey = "MPS:" + phase.mpsNumber + "|" + phase.mpsDetailId;
    const phaseTargetKey = String(phase.sourceDeliveryTargetId || "");
    const directDetail = directReceiptByTarget.get(sourceKey + "|" + phaseTargetKey)
      || (!targetScopedReceiptSources.has(sourceKey) ? directReceiptFallback.get(sourceKey) : null);
    if (!directDetail) continue;
    const directTargetKey = mrpTargetKey(directDetail);
    const relatedDetails = [
      directDetail,
      ...planDetails.filter((candidate) =>
        candidate.plan.sourceType === "MPS:" + phase.mpsNumber
        && String(candidate.notes || "").includes("[MPS-SOURCE:" + phase.mpsDetailId + "]")
        && (!directTargetKey || mrpTargetKey(candidate) === directTargetKey)),
    ].filter((candidate, index, rows) => rows.findIndex((row) => row.id === candidate.id) === index);
    const routeTasksForCoverage = relatedDetails.flatMap((detail) =>
      canonicalizeRoutingOperations(routesForPlanDetail(detail)).map((route) => ({ detail, route })))
      .sort((left, right) => capacityRouteCompare(left.route, right.route));
    const finalTask = routeTasksForCoverage.at(-1);
    const detail = finalTask?.detail || directDetail;
    const finalRoute = finalTask?.route || null;
    const groupKey = directDetail.plan.planNumber + "|" + phase.mpsDetailId + "|" + (directTargetKey || "ROLLING");
    const cumulativeRequiredQty = directTargetKey
      ? number(phase.qtyPlanned)
      : number(cumulativeRequiredByDetail.get(groupKey)) + number(phase.qtyPlanned);
    cumulativeRequiredByDetail.set(groupKey, cumulativeRequiredQty);
    const firmQtyByDueDate = finalRoute?.processId
      ? schedules.reduce((sum, schedule) => {
        const mo = planMoById.get(schedule.moId) || planMoByNumber.get(schedule.moNumber);
        if (mo?.monthlyProductionPlanNumber !== detail.plan.planNumber
          || number(mo.monthlyProductionPlanLineNumber) !== number(detail.lineNumber)
          || (schedule.processId || workOrderById.get(schedule.woId)?.processId) !== finalRoute.processId
          || parseDateOnly(schedule.scheduleDate) > parseDateOnly(phase.plannedDate)) return sum;
        return sum + number(schedule.plannedQty);
      }, 0)
      : 0;
    const coveredAutoPhaseIds = directTargetKey
      ? new Set([phase.id])
      : new Set(deliveryPhases.filter((candidate) =>
        candidate.mpsNumber === phase.mpsNumber
        && candidate.mpsDetailId === phase.mpsDetailId
        && parseDateOnly(candidate.plannedDate) <= parseDateOnly(phase.plannedDate)).map((candidate) => candidate.id));
    const autoPhaseAllocations = productionPlanAllocations.filter((allocation) =>
      ["Draft", "Published"].includes(allocation.status)
      && allocation.allocationSource === "AUTO_RECOMMENDATION"
      && coveredAutoPhaseIds.has(allocation.deliveryPhaseId));
    const autoPredecessorIds = new Set(autoPhaseAllocations.flatMap((allocation) =>
      Array.isArray(allocation.predecessorAllocationIds) ? allocation.predecessorAllocationIds : []));
    const terminalAllocationByBatch = new Map();
    for (const allocation of autoPhaseAllocations.filter((row) => !autoPredecessorIds.has(row.id))) {
      // A BOM can have several terminal-looking child branches. Delivery is
      // represented by the terminal operation that finishes last in each
      // transfer batch, not by summing every child branch output.
      const batchKey = `${allocation.deliveryPhaseId}|${allocation.transferBatchNumber || allocation.id}`;
      const completionDate = String(allocation.routingMode || "INHOUSE").toUpperCase() === "VENDOR"
        ? (allocation.vendorReturnDate || allocation.scheduleDate)
        : allocation.scheduleDate;
      const completionKey = allocationMoment(completionDate, allocation.plannedEndTime, true).getTime();
      const current = terminalAllocationByBatch.get(batchKey);
      if (!current || completionKey > current.completionKey) terminalAllocationByBatch.set(batchKey, { allocation, completionDate, completionKey });
    }
    const autoTerminalQtyByDueDate = [...terminalAllocationByBatch.values()].reduce((sum, item) => {
      if (parseDateOnly(item.completionDate) > parseDateOnly(phase.plannedDate)) return sum;
      const allocation = item.allocation;
      return sum + (String(allocation.routingMode || "INHOUSE").toUpperCase() === "VENDOR"
        ? number(allocation.expectedReturnQty ?? allocation.plannedQty)
        : number(allocation.plannedQty));
    }, 0);
    const legacyDraftQtyByDueDate = finalRoute?.id
      ? productionPlanAllocations.reduce((sum, allocation) => {
        if (allocation.status !== "Draft"
          || allocation.allocationSource === "AUTO_RECOMMENDATION"
          || allocation.plan.planNumber !== detail.plan.planNumber
          || number(allocation.lineNumber) !== number(detail.lineNumber)
          || allocation.mbomProcessId !== finalRoute.id
          || parseDateOnly(
            String(allocation.routingMode || "INHOUSE").toUpperCase() === "VENDOR"
              ? (allocation.vendorReturnDate || allocation.scheduleDate)
              : allocation.scheduleDate,
          ) > parseDateOnly(phase.plannedDate)) return sum;
        return sum + (String(allocation.routingMode || "INHOUSE").toUpperCase() === "VENDOR"
          ? number(allocation.expectedReturnQty ?? allocation.plannedQty)
          : number(allocation.plannedQty));
      }, 0)
      : 0;
    const coveredPhaseRows = deliveryPhases.filter((candidate) => coveredAutoPhaseIds.has(candidate.id));
    const hasAuditedStockCoverage = coveredPhaseRows.some((candidate) => auditedStockCoverageByPhaseId.has(candidate.id));
    const initialStockQty = hasAuditedStockCoverage
      ? coveredPhaseRows.reduce((sum, candidate) => sum + number(auditedStockCoverageByPhaseId.get(candidate.id)), 0)
      : directTargetKey
        ? Math.max(number(phase.qtyPlanned) - number(directDetail.qtyPlanned), 0)
        : number(initialStockQtyByDetailId.get(directDetail.id));
    const initialStockHistory = hasAuditedStockCoverage
      ? coveredPhaseRows.flatMap((candidate) => auditedStockHistoryByPhaseId.get(candidate.id) || [])
      : [];
    // Published recommendation rows and DPP firm schedules can describe the
    // same production output. Use the larger coverage, never their sum.
    const plannedQtyByDueDate = directTargetKey
      ? initialStockQty + number(directDetail.qtyPlanned)
      : initialStockQty + Math.max(firmQtyByDueDate, autoTerminalQtyByDueDate) + legacyDraftQtyByDueDate;
    const shortageQty = Math.max(cumulativeRequiredQty - plannedQtyByDueDate, 0);
    deliveryCoverage.push({
      phaseId: phase.id,
      phaseNumber: phase.phaseNumber,
      mpsNumber: phase.mpsNumber,
      planNumber: directDetail.plan.planNumber,
      lineNumber: detail.lineNumber,
      mpsDetailId: phase.mpsDetailId,
      partCode: phase.partCode,
      targetType: phase.targetType,
      targetCode: phase.targetCode,
      plannedDate: dateKey(phase.plannedDate),
      targetFgDate: recommendationPhaseById.get(phase.id)?.targetFgDate
        || dateKey(addDays(phase.plannedDate, -number(fgCompletionDaysByPlan.get(directDetail.plan.planNumber)))),
      phaseQty: number(phase.qtyPlanned),
      cumulativeRequiredQty: capacityQty(cumulativeRequiredQty, phase.uomCode || detail.uomCode),
      initialStockQty: capacityQty(initialStockQty, phase.uomCode || detail.uomCode),
      initialStockHistory,
      plannedQtyByDueDate: capacityQty(plannedQtyByDueDate, phase.uomCode || detail.uomCode),
      shortageQty: capacityQty(shortageQty, phase.uomCode || detail.uomCode),
      uomCode: phase.uomCode || detail.uomCode || null,
      status: shortageQty <= 0.000001 ? "COVERED" : "BLOCKED",
    });
    if (["Confirmed", "Released", "In Progress"].includes(directDetail.plan.status) && shortageQty > 0.000001) {
      pushIssue(issues, {
        severity: "blocking",
        code: "DELIVERY_PHASE_NOT_COVERED",
        planNumber: directDetail.plan.planNumber,
        lineNumber: detail.lineNumber,
        partCode: phase.partCode,
        processCode: finalRoute?.process?.processCode || null,
        message: `Delivery phase ${phase.phaseNumber} ${phase.partCode} pada ${dateKey(phase.plannedDate)} masih kurang ${capacityQtyText(shortageQty, phase.uomCode || detail.uomCode)} ${phase.uomCode || detail.uomCode || ""}.`,
      }, issueKeys);
    }
  }

  let totalAvailableMinutes = 0;
  let totalLoadMinutes = 0;
  let totalFirmMinutes = 0;
  let totalProposedMinutes = 0;
  let totalDowntimeMinutes = 0;
  let totalActualMinutes = 0;
  let historyLogCount = 0;
  let overloadedCells = 0;
  const processLoads = new Map();
  if (manualAllocation) {
    for (let index = vendorAssignments.length - 1; index >= 0; index -= 1) {
      if (!["MANUAL", "RECOMMENDED", "PUBLISHED"].includes(vendorAssignments[index].source)) vendorAssignments.splice(index, 1);
    }
    for (const row of machineRows) {
      for (const key of range.dates) {
        const cell = row.cells[key];
        cell.items = cell.items.filter((item) => item.source !== "PROPOSED");
        cell.proposedMinutes = cell.items
          .filter((item) => ["MANUAL", "RECOMMENDED"].includes(item.source))
          .reduce((sum, item) => sum + number(item.minutes), 0);
      }
    }
  }
  for (const row of machineRows) {
    for (const key of range.dates) {
      const cell = row.cells[key];
      cell.downtimeMinutes = round(cell.downtimeMinutes);
      cell.availableMinutes = round(evaluateFromSet(formulas, "CAPACITY_AVAILABLE_MINUTES", {
        baseAvailableMinutes: cell.baseAvailableMinutes,
        downtimeMinutes: cell.downtimeMinutes,
      }));
      cell.firmMinutes = round(cell.firmMinutes);
      cell.proposedMinutes = round(cell.proposedMinutes);
      cell.actualMinutes = round(cell.actualMinutes);
      cell.loadMinutes = round(cell.firmMinutes + cell.proposedMinutes);
      cell.loadPercent = cell.availableMinutes > 0
        ? round(evaluateFromSet(formulas, "CAPACITY_UTILIZATION_PERCENT", {
          loadMinutes: cell.loadMinutes,
          availableMinutes: cell.availableMinutes,
        }), 1)
        : cell.loadMinutes > 0 ? 999 : 0;
      cell.status = cell.loadPercent > 100 ? "overload" : cell.loadPercent >= 85 ? "high" : cell.loadPercent > 0 ? "loaded" : row.status === "Active" && cell.availableMinutes > 0 ? "available" : "unavailable";
      if (cell.loadPercent > 100) {
        overloadedCells += 1;
        const planItem = cell.items.find((item) => item.planNumber || item.reference);
        pushIssue(issues, {
          severity: "overridable",
          category: "MACHINE",
          code: "PLAN_CAPACITY_OVERLOAD",
          planNumber: planItem?.planNumber || (/^(MPP|PP)-/i.test(String(planItem?.reference || "")) ? planItem.reference : null),
          lineNumber: planItem?.lineNumber || null,
          machineCode: row.machineCode,
          message: `${row.machineCode} load ${round(cell.loadPercent, 1)}% pada ${key}; ${round(cell.loadMinutes - cell.availableMinutes, 1)} menit melebihi kapasitas efektif.`,
          resolution: "Pindahkan lane/mesin/tanggal, tambah shift atau overtime terotorisasi.",
        }, issueKeys);
      }
      totalAvailableMinutes += cell.availableMinutes;
      totalLoadMinutes += cell.loadMinutes;
      totalFirmMinutes += cell.firmMinutes;
      totalProposedMinutes += cell.proposedMinutes;
      totalDowntimeMinutes += cell.downtimeMinutes;
      totalActualMinutes += cell.actualMinutes;
      historyLogCount += cell.items.filter((item) => item.source === "HISTORY").length;
      for (const item of cell.items.filter((item) => ["FIRM", "PROPOSED", "MANUAL"].includes(item.source) && item.processCode)) {
        const processCode = item.processCode;
        const entry = processLoads.get(processCode) || { processCode, processName: item.processName || processByCode.get(item.baseProcessCode || processCode)?.processName || null, firmMinutes: 0, proposedMinutes: 0, actualMinutes: 0, qty: 0, machineCodes: new Set() };
        entry[item.source === "FIRM" ? "firmMinutes" : "proposedMinutes"] += number(item.minutes);
        entry.qty += number(item.qty);
        entry.machineCodes.add(row.machineCode);
        processLoads.set(processCode, entry);
      }
    }
  }

  applyUnscheduledNoticePolicy(issues, unscheduled);
  const blockingIssues = issues.filter((issue) => issue.severity === "blocking");
  const overridableIssues = issues.filter((issue) => issue.severity === "overridable");
  return {
    parameters: { startDate: dateKey(range.start), endDate: dateKey(range.end), shiftHours, shiftsPerDay, efficiencyPercent, overtimeHours, includeSaturday, includeSunday, scenarioName, planningMode, scenarioKey, presetId: selectedPreset?.id || null, presetMode: selectedPreset ? (presetId ? "SIMULATION_SELECTED" : "CURRENT_USE") : "DEFAULT_TWO_SHIFT", planningGranularity, rollingLookbackWeeks, freezeFenceDays, freezeFenceDate: dateKey(freezeFenceDate), availableMinutesPerMachineDay: workingAvailableMinutes, planNumber, manualAllocation },
    scenario: {
      scenarioName,
      shiftHours,
      shiftsPerDay,
      overtimeHours,
      efficiencyPercent,
      includeSaturday,
      includeSunday,
      preset: selectedPreset ? { id: selectedPreset.id, month: selectedPreset.month, name: selectedPreset.name, dailyOverrideCount: Object.keys(selectedPreset.dailyOverrides || {}).length, algorithm: selectedPreset.algorithm } : null,
      workingDayCount: range.dates.filter((key) => machineRows.some((machine) => machine.cells[key]?.baseAvailableMinutes > 0)).length,
      maxAvailableMinutesPerMachineDay: Math.max(
        workingAvailableMinutes,
        ...machineRows.flatMap((machine) => range.dates.map((key) => number(machine.cells[key]?.baseAvailableMinutes))),
      ),
    },
    dates: range.dates,
    summary: {
      machineCount: machines.length,
      activeMachineCount: machines.filter((machine) => machine.status === "Active").length,
      processCount: processes.length,
      routeCount: activeRoutes.length,
      planLineCount: planDetails.length - fgReceipts.length,
      fgReceiptLineCount: fgReceipts.length,
      totalAvailableMinutes: round(totalAvailableMinutes),
      totalLoadMinutes: round(totalLoadMinutes),
      totalFirmMinutes: round(totalFirmMinutes),
      totalProposedMinutes: round(totalProposedMinutes),
      totalDowntimeMinutes: round(totalDowntimeMinutes),
      totalActualMinutes: round(totalActualMinutes),
      historyLogCount,
      utilizationPercent: totalAvailableMinutes > 0
        ? round(evaluateFromSet(formulas, "CAPACITY_UTILIZATION_PERCENT", {
          loadMinutes: totalLoadMinutes,
          availableMinutes: totalAvailableMinutes,
        }), 1)
        : 0,
      overloadedCells,
      unscheduledCount: unscheduled.length,
    },
    machines: machineRows,
    manualAllocationCatalog,
    recommendationMaterial: buildRecommendationMaterial({
      stockRows: recommendationStockRows,
      allocations: productionPlanAllocations,
      childFgReceiptLines,
      childFgFinalWipByFg,
      childFgConvertedQtyByReceiptLine: childFgConversionHistory.convertedQtyByReceiptLine,
      childFgLegacyConvertedQtyByPlanPart: childFgConversionHistory.legacyConvertedQtyByPlanPart,
    }),
    deliveryCoverage: {
      ready: deliveryCoverage.every((phase) => phase.status === "COVERED"),
      blockingCount: deliveryCoverage.filter((phase) => phase.status === "BLOCKED").length,
      phases: deliveryCoverage,
    },
    fgReceipts,
    vendorAssignments,
    materialGate,
    processLoad: [...processLoads.values()].map((item) => ({
      ...item,
      machineCodes: [...item.machineCodes].sort(),
      firmMinutes: round(item.firmMinutes),
      proposedMinutes: round(item.proposedMinutes),
      actualMinutes: round(item.actualMinutes),
      qty: round(item.qty, 3),
      loadMinutes: round(item.firmMinutes + item.proposedMinutes),
    })).sort((a, b) => b.loadMinutes - a.loadMinutes || a.processCode.localeCompare(b.processCode)),
    catalogs: { dies: availableDies, vendors: availableVendors },
    unscheduled,
    readiness: {
      ok: blockingIssues.length === 0,
      blockingCount: blockingIssues.length,
      warningCount: issues.filter((issue) => issue.severity === "warning").length,
      overridableCount: overridableIssues.length,
      infoCount: issues.filter((issue) => issue.severity === "info").length,
      categories: issues.reduce((summary, issue) => {
        const category = issue.category || "CAPACITY";
        summary[category] = (summary[category] || 0) + 1;
        return summary;
      }, {}),
      issues,
    },
  };
}

module.exports = {
  buildCapacitySnapshot,
  buildMachineWorkCenterMap,
  buildRecommendationMaterial,
  recommendationPrimaryInput,
  recommendationRouteInputs,
  summarizeChildFgConversionHistory,
  resolveRange,
  resolveDailyCapacity,
  predecessorQuantityStatus,
  logicalPredecessorGroupKey,
  groupPredecessorAllocations,
  reservePredecessorGroupOutput,
  predecessorGroupReadiness,
  compareAllocationConsumptionOrder,
  allocationFinishMoment,
  crossPlanPredecessorStatus,
  resolveVendorReturnDeadline,
  capacityOperationCode,
  capacityPlanRouteKey,
  findRouteWorkOrder,
  applyUnscheduledNoticePolicy,
};
