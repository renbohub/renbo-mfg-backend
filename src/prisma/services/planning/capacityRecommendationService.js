const { canonicalizeRoutingOperations, compareRoutingOperations } = require("../../utils/routingSequence");
const { isDiscreteUom, normalizeQuantity } = require("../../utils/uomQuantity");
const { findPreset, findActivePreset, shiftDurationMinutes } = require("./capacitySimulationPresetService");
const { isDiesCapacityBlockingEnabled, isDiesTonnageCompatible, isPressResource, maintenanceInterval } = require("./diesCapacityService");

const DAY_MINUTES = 1440;
const EPSILON = 0.000001;
const DEFAULT_CANDIDATE_BUDGET = 50000;
const MAX_CANDIDATE_BUDGET = 500000;
const RETAINED_PLACEMENT_CANDIDATES = 4;
const AUTO_CAPACITY_OVERRIDE_PREFIX = "[AUTO-CAPACITY-RECOMMENDATION]";
const VERSION = "FINITE-CAPACITY-PIPELINE-V6-WEIGHTED-SCORING";
const SCORING_MODEL = "CAPACITY_ALLOCATION_SCORE_V2";
// Keep this model normalized to 100 so a recommendation score remains easy to
// explain to planners. `breakdown` intentionally stays a numeric map because it
// is consumed by the current UI; richer evidence is stored alongside it in the
// same JSON payload under `factors`, `context`, and `audit`.
const SCORING_WEIGHTS = Object.freeze({
  dueProtection: 23,
  machineEfficiency: 15,
  loadBalance: 13,
  queueWait: 11,
  dependencySync: 12,
  setupContinuity: 10,
  regularShift: 7,
  laneFragmentation: 9,
});
const SCORING_WEIGHT_TOTAL = Object.values(SCORING_WEIGHTS).reduce((sum, value) => sum + value, 0);
if (SCORING_WEIGHT_TOTAL !== 100) throw new Error(`Capacity allocation scoring weights must total 100, received ${SCORING_WEIGHT_TOTAL}.`);
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const round = (value, digits = 3) => Number(number(value).toFixed(digits));
const clamp01 = (value) => Math.min(Math.max(number(value), 0), 1);

function generatedBatchQuantity(batchReceiptQty, receiptQtyBeforeBatch, factor, uomCode) {
  const batchQty = Math.max(number(batchReceiptQty), 0);
  const previousReceiptQty = Math.max(number(receiptQtyBeforeBatch), 0);
  const ratio = Math.max(number(factor), 0);
  if (!isDiscreteUom(uomCode)) return round(batchQty * ratio);
  const before = normalizeQuantity(previousReceiptQty * ratio, uomCode);
  const after = normalizeQuantity((previousReceiptQty + batchQty) * ratio, uomCode);
  return Math.max(after - before, 0);
}

function dateOnly(value) {
  const parsed = value instanceof Date ? new Date(value) : new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function dateKey(value) { return dateOnly(value).toISOString().slice(0, 10); }
function jakartaToday() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return dateOnly(`${values.year}-${values.month}-${values.day}`);
}
function addDays(value, days) { return new Date(dateOnly(value).getTime() + days * 86400000); }
function dayIndex(periodStart, value) { return Math.round((dateOnly(value) - dateOnly(periodStart)) / 86400000); }
function absoluteMinute(periodStart, value, minute = 0) { return dayIndex(periodStart, value) * DAY_MINUTES + minute; }
function minuteOfDay(value, fallback) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return fallback;
  return Math.min(Math.max(Number(match[1]) * 60 + Number(match[2]), 0), DAY_MINUTES);
}
function timeText(minute) {
  const normalized = ((Math.round(minute) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}
function dateFromAbsolute(periodStart, absolute) { return addDays(periodStart, Math.floor(absolute / DAY_MINUTES)); }
function sourceMpsDetailId(detail) {
  return String(detail.notes || "").match(/\[MPS-SOURCE:([^\]]+)\]/)?.[1] || detail.mpsDetailId || null;
}
function isGeneratedProcess(detail) { return String(detail.notes || "").includes("[MRP-PRODUCTION]"); }
function routeMode(route) {
  return String(route.mbomDetail?.category || "").toUpperCase() === "VENDOR"
    ? "VENDOR"
    : String(route.routingMode || "INHOUSE").toUpperCase();
}
function specificationCode(route) { return route.machineSpecificationCode || route.machine?.machineSpecificationCode || null; }
function leadMinutes(route) {
  if (number(route.vendor?.leadTimeDays) > 0) return number(route.vendor.leadTimeDays) * DAY_MINUTES;
  const value = Math.max(number(route.mbomDetail?.leadTime), 0);
  switch (String(route.mbomDetail?.leadTimeUnit || "HOUR").toUpperCase()) {
    case "SECOND": return value / 60;
    case "MINUTE": return value;
    case "DAY": return value * DAY_MINUTES;
    default: return value * 60;
  }
}

function buildRouteGraph(tasks, headers, bomDetails) {
  const taskByRouteId = new Map(tasks.map((task) => [task.route.id, task]));
  const routesByNoReg = new Map();
  const routeByDetailId = new Map();
  for (const task of tasks) {
    routeByDetailId.set(task.route.mbomDetailId, task.route.id);
    if (!routesByNoReg.has(task.route.noReg)) routesByNoReg.set(task.route.noReg, []);
    routesByNoReg.get(task.route.noReg).push(task.route);
  }
  const predecessors = new Map(tasks.map((task) => [task.route.id, new Set()]));
  const successors = new Map(tasks.map((task) => [task.route.id, new Set()]));
  const connect = (beforeId, afterId) => {
    if (!beforeId || !afterId || beforeId === afterId || !taskByRouteId.has(beforeId) || !taskByRouteId.has(afterId)) return;
    predecessors.get(afterId).add(beforeId);
    successors.get(beforeId).add(afterId);
  };
  // In this BOM convention the largest routing number is the first process
  // (e.g. WELD-1 is visually at the bottom). Connect it towards routing 1.
  for (const routes of routesByNoReg.values()) {
    const ordered = [...routes].sort((left, right) => compareRoutingOperations(right, left));
    ordered.forEach((route, index) => connect(route.id, ordered[index + 1]?.id));
  }
  const detailById = new Map(bomDetails.map((detail) => [detail.id, detail]));
  const consumingDetailsByPart = new Map();
  for (const detail of bomDetails) {
    if (!detail.partId) continue;
    if (!consumingDetailsByPart.has(detail.partId)) consumingDetailsByPart.set(detail.partId, []);
    consumingDetailsByPart.get(detail.partId).push(detail);
  }
  // Bridge a child BOM into the parent BOM that consumes its output. Walk up
  // through drawing-only/receipt nodes until a routed parent operation exists.
  for (const header of headers) {
    const childRoutes = routesByNoReg.get(header.noReg);
    if (!childRoutes?.length || !header.partId) continue;
    const childTerminal = [...childRoutes].sort((left, right) => compareRoutingOperations(left, right))[0];
    for (const consumer of consumingDetailsByPart.get(header.partId) || []) {
      if (consumer.noReg === header.noReg) continue;
      let cursor = consumer;
      let downstreamRouteId = routeByDetailId.get(cursor.id);
      while (!downstreamRouteId && cursor?.parentDetailId) {
        cursor = detailById.get(cursor.parentDetailId);
        downstreamRouteId = cursor ? routeByDetailId.get(cursor.id) : null;
      }
      connect(childTerminal.id, downstreamRouteId);
    }
  }
  const indegree = new Map([...predecessors].map(([id, values]) => [id, values.size]));
  const ready = tasks.filter((task) => indegree.get(task.route.id) === 0);
  const deterministicSort = (left, right) => String(left.route.noReg).localeCompare(String(right.route.noReg), undefined, { numeric: true }) || compareRoutingOperations(right.route, left.route);
  ready.sort(deterministicSort);
  const ordered = [];
  while (ready.length) {
    const task = ready.shift();
    ordered.push(task);
    for (const successorId of successors.get(task.route.id) || []) {
      indegree.set(successorId, indegree.get(successorId) - 1);
      if (indegree.get(successorId) === 0) { ready.push(taskByRouteId.get(successorId)); ready.sort(deterministicSort); }
    }
  }
  // Invalid legacy trees must remain visible as blockers elsewhere, but do
  // not silently drop their routes from this recommendation.
  for (const task of tasks) if (!ordered.some((item) => item.route.id === task.route.id)) ordered.push(task);
  return { ordered, predecessors };
}

function splitTransferBatches(quantity, configuredBatchQty = 0) {
  const qty = Math.max(number(quantity), 0);
  if (qty <= EPSILON) return [];
  // Delivery phases come exclusively from the MPS delivery schedule. A phase
  // may only be split into transfer batches when PPIC explicitly supplies a
  // configured batch quantity; never invent an implicit 50/50 phase split.
  const batchQty = Math.max(number(configuredBatchQty), 0);
  const count = batchQty > EPSILON ? Math.min(500, Math.max(1, Math.ceil(qty / batchQty))) : 1;
  const base = qty / count;
  return Array.from({ length: count }, (_, index) => index === count - 1
    ? round(qty - round(base, 6) * (count - 1), 6)
    : round(base, 6));
}

function splitFlowBatches(quantity, flowRule, configuredBatchQty = 0) {
  const qty = Math.max(number(quantity), 0);
  if (qty <= EPSILON) return [];
  const method = String(flowRule?.flowMethod || "FULL_SEQUENTIAL").toUpperCase();
  if (method === "SPLIT_BATCH") return splitTransferBatches(qty, flowRule?.flow?.transferBatchQuantity || configuredBatchQty);
  if (method === "SPLIT_PHASE") {
    const count = Math.min(Math.max(Math.trunc(number(flowRule?.flow?.phaseCount) || 2), 2), 50);
    const percentages = flowRule?.flow?.phaseDistribution === "PERCENTAGE"
      ? (flowRule.flow.phasePercentages || []).slice(0, count).map((value) => Math.max(number(value), 0))
      : [];
    if (percentages.length === count && Math.abs(percentages.reduce((sum, value) => sum + value, 0) - 100) <= 0.01) {
      let allocated = 0;
      return percentages.map((percent, index) => {
        const batch = index === percentages.length - 1 ? qty - allocated : round(qty * percent / 100, 6);
        allocated += batch;
        return round(batch, 6);
      }).filter((batch) => batch > EPSILON);
    }
    return splitTransferBatches(qty, qty / count);
  }
  if (method === "CONTINUOUS_FLOW") {
    return splitTransferBatches(qty, number(flowRule?.flow?.maximumWip) || number(flowRule?.flow?.minimumWip));
  }
  return splitTransferBatches(qty, configuredBatchQty);
}

function fitFirstBatchStrategies(quantity, fallbackBatches = []) {
  const fullBatch = splitTransferBatches(quantity, 0);
  const fallback = (fallbackBatches || []).map((value) => round(value, 6)).filter((value) => value > EPSILON);
  if (!fallback.length || (fallback.length === 1 && Math.abs(fallback[0] - fullBatch[0]) <= EPSILON)) return [fullBatch];
  // Auto allocation must keep a lot intact whenever the complete quantity
  // fits the selected machine/shift. Transfer batches are only a fallback
  // when the full lot cannot be placed within that capacity window.
  return [fullBatch, fallback];
}

function shiftCapacityTransferQuantity(jobQty, graph, receiptQty, machineBySpecification, preset) {
  const activeShifts = (preset?.shifts || []).slice(0, Math.max(number(preset?.shiftCount) || 2, 1));
  const shiftMinutes = activeShifts.length
    ? Math.min(...activeShifts.map(shiftDurationMinutes).filter((minutes) => minutes > 0))
    : 480;
  const receiptCapacities = graph.ordered.flatMap((task) => {
    if (routeMode(task.route) === "VENDOR") return [];
    const eligible = machineBySpecification.get(specificationCode(task.route)) || [];
    const cycles = eligible.map((machine) => effectiveCycleMinutes(task.route, machine, preset?.efficiency || 85)).filter((value) => value > 0);
    const factor = number(task.detail.qtyPlanned) / Math.max(number(receiptQty), EPSILON);
    if (!cycles.length || factor <= EPSILON) return [];
    return [Math.floor(shiftMinutes / Math.min(...cycles) / factor)];
  }).filter((value) => value > 0);
  return Math.min(Math.max(receiptCapacities.length ? Math.min(...receiptCapacities) : number(jobQty), 1), number(jobQty));
}

function cloneUsage(usage) {
  return new Map([...usage.entries()].map(([key, intervals]) => [key, intervals.map((item) => ({ ...item }))]));
}

function capacityRuleKey(machineId, value) {
  return `${machineId || "*"}|${dateKey(value)}`;
}

function normalizeCapacityRule(rule, scope) {
  if (!rule) return null;
  return {
    dayStatus: String(rule.dayStatus || "WORKING").toUpperCase(),
    shiftsPerDay: rule.shiftsPerDay == null
      ? (rule.shiftCount == null ? null : Math.trunc(number(rule.shiftCount)))
      : Math.trunc(number(rule.shiftsPerDay)),
    shifts: Array.isArray(rule.shifts) ? rule.shifts : null,
    overtimeStart: rule.overtimeStart || null,
    overtimeEnd: rule.overtimeEnd || null,
    reason: rule.reason || null,
    source: scope,
  };
}

function isAutoCapacityOverride(rule) {
  return String(rule?.reason || "").trim().startsWith(AUTO_CAPACITY_OVERRIDE_PREFIX);
}

function buildCapacityRuleIndex({ globalOverrides = [], planOverrides = [] } = {}) {
  const globalByMachineDate = Object.fromEntries(globalOverrides.map((rule) => [
    capacityRuleKey(rule.machineId, rule.scheduleDate),
    normalizeCapacityRule(rule, "GLOBAL_CALENDAR"),
  ]));
  const planByMachineDate = {};
  const planByDate = {};
  let ignoredDerivedPlanOverrideCount = 0;
  for (const rule of planOverrides) {
    // A previous recommendation's escalation is an output, not a planner
    // constraint. Reusing it as a hard ceiling would prevent a later run from
    // escalating further when demand grows.
    if (isAutoCapacityOverride(rule)) {
      ignoredDerivedPlanOverrideCount += 1;
      continue;
    }
    const normalized = normalizeCapacityRule(rule, "PLAN_OVERRIDE");
    if (rule.machineId) planByMachineDate[capacityRuleKey(rule.machineId, rule.scheduleDate)] = normalized;
    else planByDate[dateKey(rule.scheduleDate)] = normalized;
  }
  return { globalByMachineDate, planByMachineDate, planByDate, ignoredDerivedPlanOverrideCount };
}

function withCapacityRuleIndex(preset, rules) {
  // Auto allocation may run without a saved preset. Preserve the historical
  // defaults while still attaching authoritative calendar rules.
  return {
    ...(preset || {}),
    shiftCount: preset?.shiftCount ?? 2,
    includeSaturday: preset?.includeSaturday ?? true,
    includeSunday: preset?.includeSunday ?? false,
    _capacityRuleIndex: rules || buildCapacityRuleIndex(),
  };
}

function capacityRuleForMachineDate(machine, value, preset) {
  const date = dateKey(value);
  const index = preset?._capacityRuleIndex || {};
  // A plan-wide rule is intentionally below a machine-specific plan rule but
  // above the simulation preset. Both are explicit plan decisions.
  const planRule = index.planByMachineDate?.[capacityRuleKey(machine?.id, date)]
    || index.planByDate?.[date]
    || null;
  const presetRule = normalizeCapacityRule(preset?.dailyOverrides?.[date], "SIMULATION_PRESET");
  const globalRule = index.globalByMachineDate?.[capacityRuleKey(machine?.id, date)] || null;
  return planRule || presetRule || globalRule;
}

function shiftWindows(machine, day, mode, preset, periodStart) {
  const defaults = [[480, 960], [960, 1440], [0, 480]];
  const calendarDate = addDays(periodStart, day); const dailyRule = capacityRuleForMachineDate(machine, calendarDate, preset);
  const weekDay = calendarDate.getUTCDay();
  const includeSaturday = preset?.includeSaturday ?? true; const includeSunday = preset?.includeSunday ?? false;
  const closedStatuses = new Set(["HOLIDAY", "CLOSED", "UNAVAILABLE", "OFF"]);
  if (closedStatuses.has(dailyRule?.dayStatus) || (!dailyRule && ((weekDay === 6 && !includeSaturday) || (weekDay === 0 && !includeSunday)))) return [];
  const presetShifts = dailyRule?.shifts?.length ? dailyRule.shifts : preset?.shifts;
  const configured = [
    [minuteOfDay(presetShifts?.[0]?.start || machine.shift1Start, defaults[0][0]), minuteOfDay(presetShifts?.[0]?.end || machine.shift1End, defaults[0][1])],
    [minuteOfDay(presetShifts?.[1]?.start || machine.shift2Start, defaults[1][0]), minuteOfDay(presetShifts?.[1]?.end || machine.shift2End, defaults[1][1])],
    [minuteOfDay(presetShifts?.[2]?.start || machine.shift3Start, defaults[2][0]), minuteOfDay(presetShifts?.[2]?.end || machine.shift3End, defaults[2][1])],
  ].map(([start, end], index) => ({ shift: String(index + 1), start, end: end <= start ? end + DAY_MINUTES : end }));
  const explicitShiftCount = dailyRule?.shiftsPerDay;
  if (explicitShiftCount != null && explicitShiftCount <= 0) return [];
  const baseShiftCount = Math.min(Math.max(number(explicitShiftCount ?? preset?.shiftCount ?? 2), 1), 3);
  // An explicit machine/date rule is a hard capacity ceiling. Scheduler
  // escalation may add shifts only on dates that have no explicit rule.
  const shifts = explicitShiftCount != null
    ? baseShiftCount
    : ["NORMAL", "PARALLEL", "OVERTIME"].includes(mode) ? baseShiftCount : mode === "TWO_SHIFT" ? Math.max(baseShiftCount, 2) : 3;
  const windows = configured.slice(0, shifts).map((window) => ({
    ...window,
    start: day * DAY_MINUTES + window.start,
    end: day * DAY_MINUTES + window.end,
    overtime: false,
  }));
  if (mode === "OVERTIME") {
    // Selecting an explicit daily rule suppresses the preset's overtime when
    // the rule has no overtime pair. This prevents phantom four-hour capacity.
    const overtimeStartText = dailyRule ? dailyRule.overtimeStart : preset?.overtimeStart;
    const overtimeEndText = dailyRule ? dailyRule.overtimeEnd : preset?.overtimeEnd;
    if (windows.length && overtimeStartText && overtimeEndText) {
      const last = windows.at(-1);
      const overtimeStart = minuteOfDay(overtimeStartText, last.end % DAY_MINUTES);
      const overtimeEndRaw = minuteOfDay(overtimeEndText, last.end % DAY_MINUTES);
      const overtimeEnd = overtimeEndRaw <= overtimeStart ? overtimeEndRaw + DAY_MINUTES : overtimeEndRaw;
      windows.push({ shift: last.shift, start: day * DAY_MINUTES + overtimeStart, end: day * DAY_MINUTES + overtimeEnd, overtime: true });
    }
  }
  return windows.sort((left, right) => left.start - right.start);
}

function overlapMinutes(leftStart, leftEnd, rightStart, rightEnd) {
  return Math.max(Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart), 0);
}

function prepareIntervalIndex(intervals = []) {
  const entries = intervals.map((interval, order) => ({ interval, order }));
  return {
    original: intervals,
    byStart: [...entries].sort((left, right) => number(left.interval.start) - number(right.interval.start) || left.order - right.order),
    byEnd: [...entries].sort((left, right) => number(left.interval.end) - number(right.interval.end) || right.order - left.order),
    forGaps: [...intervals].sort((left, right) => number(left.start) - number(right.start) || number(left.end) - number(right.end)),
  };
}

function mergeSortedIntervals(left = [], right = []) {
  const merged = [];
  let leftIndex = 0;
  let rightIndex = 0;
  const compare = (a, b) => number(a.start) - number(b.start) || number(a.end) - number(b.end);
  while (leftIndex < left.length || rightIndex < right.length) {
    if (rightIndex >= right.length || (leftIndex < left.length && compare(left[leftIndex], right[rightIndex]) <= 0)) merged.push(left[leftIndex++]);
    else merged.push(right[rightIndex++]);
  }
  return merged;
}

function intervalEndingAtOrBefore(index, minute) {
  let low = 0;
  let high = index.byEnd.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (number(index.byEnd[middle].interval.end) <= minute + EPSILON) low = middle + 1;
    else high = middle;
  }
  return low > 0 ? index.byEnd[low - 1].interval : null;
}

function intervalStartingAtOrAfter(index, minute) {
  let low = 0;
  let high = index.byStart.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (number(index.byStart[middle].interval.start) < minute - EPSILON) low = middle + 1;
    else high = middle;
  }
  return low < index.byStart.length ? index.byStart[low].interval : null;
}

function intervalWindowEvidence(machineIntervals, diesIntervals, window) {
  const machineOccupiedMinutes = machineIntervals.reduce((sum, interval) => sum + overlapMinutes(interval.start, interval.end, window.start, window.end), 0);
  const diesOccupiedMinutes = diesIntervals.reduce((sum, interval) => sum + overlapMinutes(interval.start, interval.end, window.start, window.end), 0);
  const distinctWorkFamilies = new Set(machineIntervals
    .filter((interval) => overlapMinutes(interval.start, interval.end, window.start, window.end) > EPSILON)
    .map((interval) => `${interval.partCode || "?"}|${interval.processCode || "?"}`)).size;
  return { machineOccupiedMinutes, diesOccupiedMinutes, distinctWorkFamilies };
}

function findFeasibleSlotStarts(intervals, start, end, duration, options = {}) {
  const required = Math.max(number(duration), 1);
  const merged = [];
  const orderedIntervals = options.presorted
    ? intervals
    : [...intervals].sort((left, right) => number(left.start) - number(right.start) || number(left.end) - number(right.end));
  for (const interval of orderedIntervals
    .filter((item) => number(item.end) > start + EPSILON && number(item.start) < end - EPSILON)
    .map((item) => ({ start: Math.max(number(item.start), start), end: Math.min(number(item.end), end) }))) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end + EPSILON) previous.end = Math.max(previous.end, interval.end);
    else merged.push(interval);
  }
  const starts = [];
  let cursor = start;
  for (const interval of merged) {
    if (interval.start - cursor + EPSILON >= required) starts.push(cursor);
    cursor = Math.max(cursor, interval.end);
  }
  if (end - cursor + EPSILON >= required) starts.push(cursor);
  return starts.filter((value, index, rows) => index === 0 || Math.abs(value - rows[index - 1]) > EPSILON);
}

function freeCapacitySegments(intervals, start, end) {
  const merged = [];
  for (const interval of [...(intervals || [])]
    .filter((item) => number(item.end) > start + EPSILON && number(item.start) < end - EPSILON)
    .map((item) => ({ start: Math.max(number(item.start), start), end: Math.min(number(item.end), end) }))
    .sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end + EPSILON) previous.end = Math.max(previous.end, interval.end);
    else merged.push(interval);
  }
  const segments = [];
  let cursor = start;
  for (const interval of merged) {
    if (interval.start > cursor + EPSILON) segments.push({ start: cursor, end: interval.start });
    cursor = Math.max(cursor, interval.end);
  }
  if (end > cursor + EPSILON) segments.push({ start: cursor, end });
  return segments;
}

function reserveCapacityInterval(usage, machineId, interval, source) {
  if (!machineId || number(interval?.end) <= number(interval?.start) + EPSILON) return 0;
  const rows = usage.get(machineId) || [];
  rows.push({
    start: number(interval.start),
    end: number(interval.end),
    partCode: null,
    processCode: null,
    capacityReservation: true,
    reservationSource: source?.type || "CAPACITY_CONSTRAINT",
    reservationReference: source?.reference || null,
    reservationPrecision: source?.precision || null,
  });
  usage.set(machineId, rows);
  return number(interval.end) - number(interval.start);
}

function timestampMinute(periodStart, value) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) return null;
  return (parsed.getTime() - dateOnly(periodStart).getTime()) / 60000;
}

function downtimeShiftNumber(value) {
  return String(value || "").match(/[123]/)?.[0] || null;
}

function reserveDowntimeCapacity({ usage, machines, downtimes, preset, periodStart, periodEnd }) {
  const machineByCode = new Map((machines || []).map((machine) => [String(machine.machineCode || "").trim().toUpperCase(), machine]));
  const horizonEnd = (dayIndex(periodStart, periodEnd) + 1) * DAY_MINUTES;
  const audit = {
    source: "DOWNTIME_LOG",
    loadedCount: (downtimes || []).length,
    exactCount: 0,
    inferredEndpointCount: 0,
    estimatedCount: 0,
    unknownMachineCount: 0,
    reservedMinutes: 0,
    unreservedMinutes: 0,
  };
  const ordered = [...(downtimes || [])].sort((left, right) =>
    dateOnly(left.downtimeDate) - dateOnly(right.downtimeDate)
    || String(left.machineCode || "").localeCompare(String(right.machineCode || ""))
    || String(left.shift || "").localeCompare(String(right.shift || ""))
    || String(left.downtimeNumber || left.id || "").localeCompare(String(right.downtimeNumber || right.id || "")));

  for (const row of ordered) {
    const machine = machineByCode.get(String(row.machineCode || "").trim().toUpperCase());
    const requestedMinutes = Math.max(number(row.durationMinutes), 0);
    if (!machine) {
      audit.unknownMachineCount += 1;
      audit.unreservedMinutes += requestedMinutes;
      continue;
    }
    const reference = row.downtimeNumber || row.id || null;
    const exactStart = timestampMinute(periodStart, row.startTime);
    const exactEnd = timestampMinute(periodStart, row.endTime);
    let resolvedStart = exactStart;
    let resolvedEnd = exactEnd;
    let timestampPrecision = "EXACT";
    if (resolvedStart != null && resolvedEnd == null && requestedMinutes > EPSILON) {
      resolvedEnd = resolvedStart + requestedMinutes;
      timestampPrecision = "START_PLUS_DURATION";
    } else if (resolvedStart == null && resolvedEnd != null && requestedMinutes > EPSILON) {
      resolvedStart = resolvedEnd - requestedMinutes;
      timestampPrecision = "END_MINUS_DURATION";
    }
    if (resolvedStart != null && resolvedEnd != null && resolvedEnd > resolvedStart + EPSILON) {
      const start = Math.max(resolvedStart, 0);
      const end = Math.min(resolvedEnd, horizonEnd);
      const reserved = reserveCapacityInterval(usage, machine.id, { start, end }, { type: "DOWNTIME_LOG", reference, precision: timestampPrecision });
      if (reserved > EPSILON) {
        if (timestampPrecision === "EXACT") audit.exactCount += 1;
        else audit.inferredEndpointCount += 1;
        audit.reservedMinutes += reserved;
      }
      continue;
    }

    if (requestedMinutes <= EPSILON) continue;
    const day = dayIndex(periodStart, row.downtimeDate);
    if (day < 0 || day * DAY_MINUTES >= horizonEnd) {
      audit.unreservedMinutes += requestedMinutes;
      continue;
    }
    // Include every shift the algorithm could otherwise escalate into. An
    // explicit calendar rule still caps this list through shiftWindows().
    const candidateWindows = [...shiftWindows(machine, day, "THREE_SHIFT", preset, periodStart), ...shiftWindows(machine, day, "OVERTIME", preset, periodStart)]
      .filter((window, index, rows) => rows.findIndex((candidate) => candidate.shift === window.shift && candidate.start === window.start && candidate.end === window.end) === index)
      .sort((left, right) => left.start - right.start || left.end - right.end);
    const shift = downtimeShiftNumber(row.shift);
    const selectedWindows = shift ? candidateWindows.filter((window) => window.shift === shift) : candidateWindows;
    let remaining = requestedMinutes;
    for (const window of selectedWindows) {
      if (remaining <= EPSILON) break;
      for (const segment of freeCapacitySegments(usage.get(machine.id) || [], window.start, window.end)) {
        if (remaining <= EPSILON) break;
        const reserved = Math.min(remaining, segment.end - segment.start);
        audit.reservedMinutes += reserveCapacityInterval(
          usage,
          machine.id,
          { start: segment.start, end: segment.start + reserved },
          { type: "DOWNTIME_LOG", reference, precision: "SHIFT_DURATION" },
        );
        remaining -= reserved;
      }
    }
    audit.estimatedCount += 1;
    audit.unreservedMinutes += Math.max(remaining, 0);
  }
  audit.reservedMinutes = round(audit.reservedMinutes, 2);
  audit.unreservedMinutes = round(audit.unreservedMinutes, 2);
  return audit;
}

function allocationShiftNumber(value) {
  const shift = String(value || "").match(/[123]/)?.[0];
  return shift ? Number(shift) : 0;
}

function buildDerivedCapacityDays(allocations = [], periodStart, preset) {
  const expandedDays = new Map();
  for (const item of allocations) {
    if (!item?.machine || (!item.overtime && !["TWO_SHIFT", "THREE_SHIFT"].includes(String(item.mode || "").toUpperCase()))) continue;
    const scheduleDate = dateFromAbsolute(periodStart, item.start);
    const day = dayIndex(periodStart, scheduleDate);
    const regularShiftCount = shiftWindows(item.machine, day, "NORMAL", preset, periodStart)
      .filter((window) => !window.overtime).length;
    const usedShift = allocationShiftNumber(item.shift);
    const needsExtraShift = usedShift > regularShiftCount;
    if (!item.overtime && !needsExtraShift) continue;
    const key = `${item.machine.id}|${dateKey(scheduleDate)}`;
    const current = expandedDays.get(key) || {
      machineId: item.machine.id,
      scheduleDate,
      shiftsPerDay: regularShiftCount,
      overtime: false,
      overtimeStart: null,
      overtimeEnd: null,
    };
    current.shiftsPerDay = Math.max(current.shiftsPerDay, usedShift, 1);
    current.overtime = current.overtime || Boolean(item.overtime);
    if (item.overtime) {
      current.overtimeStart = current.overtimeStart == null ? item.start : Math.min(current.overtimeStart, item.start);
      current.overtimeEnd = current.overtimeEnd == null ? item.end : Math.max(current.overtimeEnd, item.end);
    }
    expandedDays.set(key, current);
  }
  return expandedDays;
}

function sameRouteInterval(interval, partCode, processCode) {
  if (!partCode && !processCode) return false;
  return (!partCode || interval.partCode === partCode) && (!processCode || interval.processCode === processCode);
}

function setupAffinity(interval, partCode, processCode) {
  if (!interval) return 0.8;
  if (interval.partCode && partCode && interval.partCode === partCode) return 1;
  if (interval.processCode && processCode && interval.processCode === processCode) return 0.65;
  return 0.15;
}

function scorePlacementCandidate({
  candidate,
  machineIntervals = [],
  diesIntervals = [],
  diesAssigned = false,
  window,
  earliest,
  due,
  cycleMinutes,
  bestCycleMinutes,
  partCode,
  processCode,
  routeMachineCount = 0,
  routeAlreadyOnMachine = false,
  intervalEvidence = null,
}) {
  const windowMinutes = Math.max(window.end - window.start, 1);
  const durationMinutes = Math.max(candidate.end - candidate.start, 1);
  const machineOccupiedMinutes = intervalEvidence?.machineOccupiedMinutes
    ?? machineIntervals.reduce((sum, interval) => sum + overlapMinutes(interval.start, interval.end, window.start, window.end), 0);
  const diesOccupiedMinutes = intervalEvidence?.diesOccupiedMinutes
    ?? diesIntervals.reduce((sum, interval) => sum + overlapMinutes(interval.start, interval.end, window.start, window.end), 0);
  const machineLoadRatio = clamp01((machineOccupiedMinutes + durationMinutes) / windowMinutes);
  const diesLoadRatio = diesAssigned ? clamp01((diesOccupiedMinutes + durationMinutes) / windowMinutes) : 0;
  const resourceLoadRatio = Math.max(machineLoadRatio, diesLoadRatio);
  const slackMinutes = Math.max(due - candidate.end, 0);
  const waitMinutes = Math.max(candidate.start - earliest, 0);
  const horizonMinutes = Math.max(due - earliest, durationMinutes, 1);
  const previous = intervalEvidence && Object.prototype.hasOwnProperty.call(intervalEvidence, "previous")
    ? intervalEvidence.previous
    : [...machineIntervals].filter((interval) => interval.end <= candidate.start + EPSILON).sort((left, right) => right.end - left.end)[0] || null;
  const next = intervalEvidence && Object.prototype.hasOwnProperty.call(intervalEvidence, "next")
    ? intervalEvidence.next
    : [...machineIntervals].filter((interval) => interval.start >= candidate.end - EPSILON).sort((left, right) => left.start - right.start)[0] || null;
  const setupRatio = next
    ? (setupAffinity(previous, partCode, processCode) + setupAffinity(next, partCode, processCode)) / 2
    : setupAffinity(previous, partCode, processCode);
  const distinctWorkFamilies = intervalEvidence?.distinctWorkFamilies
    ?? new Set(machineIntervals
      .filter((interval) => overlapMinutes(interval.start, interval.end, window.start, window.end) > EPSILON)
      .map((interval) => `${interval.partCode || "?"}|${interval.processCode || "?"}`)).size;
  const laneBaseRatio = routeMachineCount === 0 ? 0.85 : routeAlreadyOnMachine ? 1 : Math.max(0.3, 0.55 - (routeMachineCount - 1) * 0.1);
  const laneRatio = clamp01(laneBaseRatio - Math.min(Math.max(distinctWorkFamilies - 1, 0) * 0.05, 0.2));
  const shiftNumber = String(candidate.shift || "1");
  const regularShiftRatio = candidate.overtime ? 0 : shiftNumber === "3" ? 0.55 : shiftNumber === "2" ? 0.9 : 1;
  const ratios = {
    dueProtection: clamp01(slackMinutes / horizonMinutes),
    machineEfficiency: clamp01(number(bestCycleMinutes) / Math.max(number(cycleMinutes), EPSILON)),
    loadBalance: 1 - resourceLoadRatio,
    queueWait: 1 - clamp01(waitMinutes / horizonMinutes),
    dependencySync: clamp01(1 / (1 + waitMinutes / Math.max(durationMinutes, 60))),
    setupContinuity: setupRatio,
    regularShift: regularShiftRatio,
    laneFragmentation: laneRatio,
  };
  const raw = Object.fromEntries(Object.entries(ratios).map(([key, ratio]) => [key, SCORING_WEIGHTS[key] * ratio]));
  const breakdown = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, round(value, 2)]));
  const factors = Object.fromEntries(Object.keys(SCORING_WEIGHTS).map((key) => [key, {
    weight: SCORING_WEIGHTS[key],
    ratio: round(ratios[key], 4),
    points: breakdown[key],
  }]));
  const rawScore = Object.values(raw).reduce((sum, value) => sum + value, 0);
  return {
    model: SCORING_MODEL,
    score: round(rawScore, 2),
    rawScore: round(rawScore, 6),
    breakdown,
    factors,
    context: {
      slackMinutes: round(slackMinutes, 1),
      waitMinutes: round(waitMinutes, 1),
      horizonMinutes: round(horizonMinutes, 1),
      dependencyLagMinutes: round(waitMinutes, 1),
      machineLoadPercentAfterPlacement: round(machineLoadRatio * 100, 2),
      diesLoadPercentAfterPlacement: diesAssigned ? round(diesLoadRatio * 100, 2) : null,
      limitingResourceLoadPercent: round(resourceLoadRatio * 100, 2),
      routeMachineCount,
      introducesAdditionalLane: routeMachineCount > 0 && !routeAlreadyOnMachine,
      workFamiliesInWindow: distinctWorkFamilies,
      setupContinuity: !previous ? "EMPTY_LANE" : previous.partCode === partCode ? "SAME_PART" : previous.processCode === processCode ? "SAME_PROCESS" : "CHANGEOVER",
      nextSetupContinuity: !next ? "NO_NEXT_JOB" : next.partCode === partCode ? "SAME_PART" : next.processCode === processCode ? "SAME_PROCESS" : "CHANGEOVER",
    },
  };
}

function compareDeterministicText(left, right) {
  const leftText = String(left == null ? "" : left);
  const rightText = String(right == null ? "" : right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function comparePlacementCandidates(left, right) {
  const scoreDifference = number(right._rankingScore ?? right.recommendationScore) - number(left._rankingScore ?? left.recommendationScore);
  if (Math.abs(scoreDifference) > EPSILON) return scoreDifference;
  if (left.end !== right.end) return left.end - right.end;
  if (left.start !== right.start) return left.start - right.start;
  const machineCode = compareDeterministicText(left.machine?.machineCode, right.machine?.machineCode);
  if (machineCode) return machineCode;
  const machineId = compareDeterministicText(left.machine?.id, right.machine?.id);
  if (machineId) return machineId;
  const diesCode = compareDeterministicText(left.dies?.diesCode, right.dies?.diesCode);
  if (diesCode) return diesCode;
  const diesId = compareDeterministicText(left.dies?.id, right.dies?.id);
  if (diesId) return diesId;
  return compareDeterministicText(left.shift, right.shift);
}

function resolveCandidateBudget(preset, scoringContext = {}) {
  const configured = number(scoringContext.candidateBudget ?? preset?.algorithm?.candidateBudget);
  if (configured <= 0) return DEFAULT_CANDIDATE_BUDGET;
  return Math.min(Math.max(Math.trunc(configured), 1), MAX_CANDIDATE_BUDGET);
}

function retainRankedCandidate(rankedCandidates, candidate, limit = RETAINED_PLACEMENT_CANDIDATES) {
  const insertionIndex = rankedCandidates.findIndex((current) => comparePlacementCandidates(candidate, current) < 0);
  if (insertionIndex < 0) {
    if (rankedCandidates.length < limit) rankedCandidates.push(candidate);
  } else {
    rankedCandidates.splice(insertionIndex, 0, candidate);
    if (rankedCandidates.length > limit) rankedCandidates.pop();
  }
}

function findPlacement({ machines, usage, diesCandidates = [null], diesCandidatesByMachine = null, diesUsage = new Map(), earliest, due, duration, mode, periodStart, periodEnd, preset, scoringContext = {} }) {
  const rankedCandidates = [];
  const candidateBudget = resolveCandidateBudget(preset, scoringContext);
  let candidatesEvaluated = 0;
  let evaluatedWindows = 0;
  const orderedMachines = [...machines].sort((left, right) => compareDeterministicText(left.machineCode, right.machineCode) || compareDeterministicText(left.id, right.id));
  const configuredDies = diesCandidatesByMachine instanceof Map
    ? [...diesCandidatesByMachine.values()].flat().filter(Boolean)
    : diesCandidates.filter(Boolean);
  const eligibleDiesCount = new Set(configuredDies.map((dies) => dies.id)).size;
  const routeMachineIds = new Set(orderedMachines
    .filter((machine) => (usage.get(machine.id) || []).some((interval) => sameRouteInterval(interval, scoringContext.partCode, scoringContext.processCode)))
    .map((machine) => machine.id));
  const machineIntervalIndexes = new Map(orderedMachines.map((machine) => [machine.id, prepareIntervalIndex(usage.get(machine.id) || [])]));
  const diesIntervalIndexes = new Map();
  const emptyIntervalIndex = prepareIntervalIndex([]);
  const useIntervalEvidenceCache = scoringContext.disableIntervalEvidenceCache !== true;
  const firstDay = Math.max(0, Math.floor(earliest / DAY_MINUTES));
  const lastDay = Math.min(dayIndex(periodStart, periodEnd), Math.floor(due / DAY_MINUTES));
  for (let day = firstDay; day <= lastDay; day += 1) {
    for (const machine of orderedMachines) {
      const machineDiesCandidates = diesCandidatesByMachine instanceof Map
        ? (diesCandidatesByMachine.get(machine.id) || [])
        : diesCandidates;
      const compatibleDies = machineDiesCandidates
        .filter((dies) => !dies || isDiesTonnageCompatible(dies, machine))
        .filter((dies, index, rows) => rows.findIndex((row) => (row?.id || null) === (dies?.id || null)) === index)
        .sort((left, right) => compareDeterministicText(left?.diesCode, right?.diesCode) || compareDeterministicText(left?.id, right?.id));
      const machineIntervalIndex = machineIntervalIndexes.get(machine.id);
      const machineIntervals = machineIntervalIndex.original;
      for (const dies of compatibleDies) {
        if (dies && !diesIntervalIndexes.has(dies.id)) diesIntervalIndexes.set(dies.id, prepareIntervalIndex(diesUsage.get(dies.id) || []));
        const diesIntervalIndex = dies ? diesIntervalIndexes.get(dies.id) : emptyIntervalIndex;
        const diesIntervals = diesIntervalIndex.original;
        const sortedResourceIntervals = mergeSortedIntervals(machineIntervalIndex.forGaps, diesIntervalIndex.forGaps);
        for (const window of shiftWindows(machine, day, mode, preset, periodStart)) {
          evaluatedWindows += 1;
          const start = Math.max(earliest, window.start);
          const end = Math.min(due, window.end);
          const resolvedDuration = typeof duration === "function" ? number(duration(machine)) : number(duration);
          // A missing/zero cycle time is not a one-minute operation. Silently
          // coercing it to one minute creates false capacity and invalid plans.
          if (resolvedDuration <= EPSILON) continue;
          const candidateDuration = Math.max(resolvedDuration, 1);
          if (end - start + EPSILON < candidateDuration) continue;
          const windowEvidence = useIntervalEvidenceCache ? intervalWindowEvidence(machineIntervals, diesIntervals, window) : null;
          for (const slotStart of findFeasibleSlotStarts(sortedResourceIntervals, start, end, candidateDuration, { presorted: true })) {
            candidatesEvaluated += 1;
            if (candidatesEvaluated > candidateBudget) {
              const error = new Error(`Candidate budget ${candidateBudget} terlampaui saat mencari slot capacity. Persempit horizon/preset atau naikkan candidate budget; hasil tidak dipotong sebagian.`);
              error.code = "CAPACITY_CANDIDATE_BUDGET_EXCEEDED";
              error.statusCode = 409;
              error.details = {
                mode,
                candidateBudget,
                candidatesEvaluated,
                resourceWindowsEvaluated: evaluatedWindows,
                eligibleMachineCount: orderedMachines.length,
                eligibleDiesCount,
                firstDay,
                lastDay,
                earliest: round(earliest, 2),
                due: round(due, 2),
                guardMode: "FAIL_EXPLICITLY_NO_PARTIAL_RANKING",
              };
              throw error;
            }
            const candidate = { machine, dies, start: slotStart, end: slotStart + candidateDuration, shift: window.shift, overtime: window.overtime };
            const scoring = scorePlacementCandidate({
              candidate,
              machineIntervals,
              diesIntervals,
              diesAssigned: Boolean(dies),
              window,
              earliest,
              due,
              cycleMinutes: scoringContext.cycleByMachine?.(machine),
              bestCycleMinutes: scoringContext.bestCycleMinutes,
              partCode: scoringContext.partCode,
              processCode: scoringContext.processCode,
              routeMachineCount: routeMachineIds.size,
              routeAlreadyOnMachine: routeMachineIds.has(machine.id),
              intervalEvidence: windowEvidence ? {
                ...windowEvidence,
                previous: intervalEndingAtOrBefore(machineIntervalIndex, slotStart),
                next: intervalStartingAtOrAfter(machineIntervalIndex, slotStart + candidateDuration),
              } : null,
            });
            candidate.recommendationScore = scoring.score;
            candidate.recommendationScoreBreakdown = scoring;
            candidate._rankingScore = scoring.rawScore;
            retainRankedCandidate(rankedCandidates, candidate);
          }
        }
      }
    }
  }
  if (!rankedCandidates.length) return null;
  const selected = rankedCandidates[0];
  selected.recommendationScoreBreakdown.audit = {
    candidatesEvaluated,
    resourceWindowsEvaluated: evaluatedWindows,
    candidateBudget,
    candidateBudgetRemaining: candidateBudget - candidatesEvaluated,
    candidateBudgetUtilizationPercent: round(candidatesEvaluated / candidateBudget * 100, 2),
    candidateRetentionLimit: RETAINED_PLACEMENT_CANDIDATES,
    candidateGuardMode: "FAIL_EXPLICITLY_NO_PARTIAL_RANKING",
    lanePolicy: scoringContext.lanePolicy || "ALLOW_PARALLEL_SCORING",
    pinnedMachineId: scoringContext.pinnedMachineId || null,
    eligibleMachineCount: orderedMachines.length,
    eligibleDiesCount,
    selectedRank: 1,
    deterministicTieBreak: ["score_desc", "end_asc", "start_asc", "machine_code_asc", "machine_id_asc", "dies_code_asc", "dies_id_asc", "shift_asc"],
    alternatives: rankedCandidates.slice(1, RETAINED_PLACEMENT_CANDIDATES).map((candidate) => ({
      machineCode: candidate.machine?.machineCode || null,
      diesCode: candidate.dies?.diesCode || null,
      shift: candidate.shift,
      start: round(candidate.start, 2),
      end: round(candidate.end, 2),
      score: candidate.recommendationScore,
    })),
  };
  delete selected._rankingScore;
  return selected;
}

function occupy(usage, machineId, allocation) {
  const intervals = usage.get(machineId) || [];
  intervals.push({
    start: allocation.start,
    end: allocation.end,
    partCode: allocation.partCode || null,
    processCode: allocation.processCode || null,
  });
  usage.set(machineId, intervals);
}

function occupyDies(usage, diesId, allocation) {
  if (!diesId) return;
  occupy(usage, diesId, allocation);
}

function effectiveCycleMinutes(route, machine, efficiency = 85) {
  const factor = Math.min(Math.max(number(efficiency), 1), 100) / 100;
  const seconds = number(route.cycleTime) || number(machine?.cycleTime);
  if (seconds > 0) return seconds / 60 / factor;
  const rate = number(machine?.capacity);
  const unit = String(machine?.capacityUnit || "").toUpperCase();
  if (rate <= 0) return 0;
  if (unit.includes("HOUR") || unit.includes("JAM")) return 60 / rate / factor;
  if (unit.includes("MIN")) return 1 / rate / factor;
  return 0;
}

function cycleCapableMachines(machines, cycleByMachine) {
  return (machines || []).filter((machine) => {
    const cycle = Number(cycleByMachine(machine));
    return Number.isFinite(cycle) && cycle > EPSILON;
  });
}

function shouldPinMachineLane(mode, preset) {
  return String(mode || "NORMAL").toUpperCase() === "NORMAL" || preset?.algorithm?.allowParallel === false;
}

function candidateMachinesForLane(machines, cycleByMachine, pinnedMachineId = null, pinLane = false) {
  const capable = cycleCapableMachines(machines, cycleByMachine);
  if (!pinLane || !pinnedMachineId) return capable;
  return capable.filter((machine) => machine.id === pinnedMachineId);
}

function machineLaneKey(route) {
  const logicalRouteId = route?.id || route?.routingOperationId || route?.occurrenceCode;
  if (logicalRouteId) return `route:${logicalRouteId}`;
  return `route:${route?.noReg || "?"}:${route?.mbomDetailId || "?"}:${route?.processId || "?"}:${route?.sequence || "?"}`;
}

function buildMachineDiesOptions(route, machines, diesForRoute, options = {}) {
  const blockingEnabled = options.blockingEnabled ?? isDiesCapacityBlockingEnabled();
  const diesCandidatesByMachine = new Map();
  const availableMachines = [];
  const excludedPressMachineIds = [];
  for (const machine of machines || []) {
    const press = isPressResource(machine, route);
    if (!press) {
      availableMachines.push(machine);
      diesCandidatesByMachine.set(machine.id, [null]);
      continue;
    }
    const compatibleDies = (diesForRoute(route, [machine]) || [])
      .filter((dies) => dies && isDiesTonnageCompatible(dies, machine))
      .filter((dies, index, rows) => rows.findIndex((candidate) => candidate.id === dies.id) === index);
    if (blockingEnabled && !compatibleDies.length) {
      excludedPressMachineIds.push(machine.id);
      continue;
    }
    availableMachines.push(machine);
    diesCandidatesByMachine.set(machine.id, compatibleDies.length ? compatibleDies : [null]);
  }
  return {
    machines: availableMachines,
    diesCandidatesByMachine,
    excludedPressMachineIds,
    pressMachineCount: (machines || []).filter((machine) => isPressResource(machine, route)).length,
    blockingEnabled,
  };
}

function normalizeLineageIndexes(indexes, upperBound = Number.POSITIVE_INFINITY) {
  return [...new Set((indexes || [])
    .filter((value) => value != null && value !== "")
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0 && value < upperBound))]
    .sort((left, right) => left - right);
}

function summarizeAllocationScoring(allocations) {
  const scores = allocations
    .filter((row) => row.recommendationScore != null && Number.isFinite(Number(row.recommendationScore)))
    .map((row) => Number(row.recommendationScore));
  const audits = allocations.map((row) => row.recommendationScoreBreakdown?.audit).filter(Boolean);
  return {
    model: SCORING_MODEL,
    weightTotal: SCORING_WEIGHT_TOTAL,
    scoredAllocationCount: scores.length,
    ruleBasedAllocationCount: allocations.length - scores.length,
    averageScore: scores.length ? round(scores.reduce((sum, score) => sum + score, 0) / scores.length, 2) : null,
    minimumScore: scores.length ? round(Math.min(...scores), 2) : null,
    maximumScore: scores.length ? round(Math.max(...scores), 2) : null,
    candidatesEvaluated: audits.reduce((sum, audit) => sum + number(audit.candidatesEvaluated), 0),
    resourceWindowsEvaluated: audits.reduce((sum, audit) => sum + number(audit.resourceWindowsEvaluated), 0),
    scoreBands: {
      excellent90Plus: scores.filter((score) => score >= 90).length,
      good75To89: scores.filter((score) => score >= 75 && score < 90).length,
      watch60To74: scores.filter((score) => score >= 60 && score < 75).length,
      riskBelow60: scores.filter((score) => score < 60).length,
    },
  };
}

function buildRecommendationValidationScope({ planNumber, planningMode, scenarioKey, presetId, persisted }) {
  return {
    planNumber,
    planningMode,
    scenarioKey: planningMode === "SIMULATION" ? scenarioKey : null,
    presetId,
    allocationSource: "AUTO_RECOMMENDATION",
    recommendationVersion: VERSION,
    persisted: Boolean(persisted),
  };
}

function scheduleFitFirstPerRoute({ graph, batches, receiptQty, receiptQtyBeforeJob, trialUsage, trialDiesUsage, trialManualByRoute, manualCompletionByRoute, machineBySpecification, diesForRoute, mode, due, executionFloor, periodStart, periodEnd, preset }) {
  const allocations = [];
  const completionByRoute = new Map();
  const allocationIndexesByRoute = new Map();
  const pinMachineLane = shouldPinMachineLane(mode, preset);
  const pinnedMachineByLane = new Map();
  let usedSplit = false;
  for (const task of graph.ordered) {
    const route = task.route;
    const predecessorRouteIds = [...(graph.predecessors.get(route.id) || [])];
    const predecessorEnd = Math.max(executionFloor, ...predecessorRouteIds.map((id) => number(completionByRoute.get(id))));
    const predecessorDraftIndexes = normalizeLineageIndexes(predecessorRouteIds.flatMap((id) => allocationIndexesByRoute.get(id) || []), allocations.length);
    const factor = number(task.detail.qtyPlanned) / receiptQty;
    let receiptBefore = receiptQtyBeforeJob;
    let routeChunks = batches.map((batch) => {
      const qty = generatedBatchQuantity(batch, receiptBefore, factor > 0 ? factor : 1, task.detail.uomCode);
      receiptBefore += number(batch);
      return qty;
    }).filter((qty) => qty > EPSILON);
    let manualRemaining = Math.max(number(trialManualByRoute.get(route.id)), 0);
    routeChunks = routeChunks.map((qty) => {
      const consumed = Math.min(qty, manualRemaining);
      manualRemaining -= consumed;
      return qty - consumed;
    }).filter((qty) => qty > EPSILON);
    trialManualByRoute.set(route.id, manualRemaining);
    const totalQty = routeChunks.reduce((sum, qty) => sum + qty, 0);
    if (totalQty <= EPSILON) {
      completionByRoute.set(route.id, Math.max(predecessorEnd, number(manualCompletionByRoute.get(route.id))));
      continue;
    }
    if (routeMode(route) === "VENDOR") {
      const duration = Math.max(leadMinutes(route), 1);
      const end = predecessorEnd + duration;
      if (end > due + EPSILON) return { failed: { code: "VENDOR_LEAD_TIME_LATE", route, qty: totalQty }, allocations, usage: trialUsage, manualByRoute: trialManualByRoute, batches };
      allocations.push({ task, qty: totalQty, start: predecessorEnd, end, shift: "VENDOR", machine: null, overtime: false, predecessorDraftIndexes, batchNumber: 1 });
      allocationIndexesByRoute.set(route.id, [allocations.length - 1]);
      completionByRoute.set(route.id, end);
      continue;
    }
    const spec = specificationCode(route);
    const eligible = spec ? machineBySpecification.get(spec) || [] : [];
    if (!eligible.length) return { failed: { code: "MACHINE_SPECIFICATION_UNAVAILABLE", route, qty: totalQty, specificationCode: spec }, allocations, usage: trialUsage, manualByRoute: trialManualByRoute, batches };
    const cycleByMachine = (machine) => effectiveCycleMinutes(route, machine, preset?.efficiency || 85);
    const cycleEligible = cycleCapableMachines(eligible, cycleByMachine);
    if (!cycleEligible.length) return { failed: { code: "CYCLE_TIME_MISSING", route, qty: totalQty, specificationCode: spec }, allocations, usage: trialUsage, manualByRoute: trialManualByRoute, batches };
    const cycle = Math.min(...cycleEligible.map(cycleByMachine));
    const laneKey = machineLaneKey(route);
    const pinnedMachineId = pinnedMachineByLane.get(laneKey) || null;
    const laneMachines = candidateMachinesForLane(cycleEligible, cycleByMachine, pinnedMachineId, pinMachineLane);
    if (!laneMachines.length) return { failed: { code: "CAPACITY_BEFORE_DUE_UNAVAILABLE", route, qty: totalQty, specificationCode: spec }, allocations, usage: trialUsage, manualByRoute: trialManualByRoute, batches };
    const machineResources = buildMachineDiesOptions(route, laneMachines, diesForRoute);
    if (!machineResources.machines.length) return { failed: { code: machineResources.excludedPressMachineIds.length ? "DIES_UNAVAILABLE" : "CAPACITY_BEFORE_DUE_UNAVAILABLE", route, qty: totalQty, specificationCode: spec }, allocations, usage: trialUsage, diesUsage: trialDiesUsage, manualByRoute: trialManualByRoute, batches };
    const candidateMachines = machineResources.machines;
    const scoringContext = { bestCycleMinutes: cycle, cycleByMachine, partCode: task.detail.partCode, processCode: route.process?.processCode || null, lanePolicy: pinMachineLane ? "PIN_BY_LOGICAL_ROUTE" : "ALLOW_PARALLEL_SCORING", pinnedMachineId };
    const fullPlacement = findPlacement({ machines: candidateMachines, usage: trialUsage, diesCandidatesByMachine: machineResources.diesCandidatesByMachine, diesUsage: trialDiesUsage, earliest: predecessorEnd, due, duration: (machine) => Math.max(totalQty * cycleByMachine(machine), 1), mode, periodStart, periodEnd, preset, scoringContext });
    if (fullPlacement) {
      if (pinMachineLane && !pinnedMachineId) pinnedMachineByLane.set(laneKey, fullPlacement.machine.id);
      occupy(trialUsage, fullPlacement.machine.id, { ...fullPlacement, partCode: task.detail.partCode, processCode: route.process?.processCode || null });
      occupyDies(trialDiesUsage, fullPlacement.dies?.id, fullPlacement);
      allocations.push({ task, qty: totalQty, ...fullPlacement, predecessorDraftIndexes, batchNumber: 1 });
      allocationIndexesByRoute.set(route.id, [allocations.length - 1]);
      completionByRoute.set(route.id, fullPlacement.end);
      continue;
    }
    if (routeChunks.length <= 1) return { failed: { code: "CAPACITY_BEFORE_DUE_UNAVAILABLE", route, qty: totalQty, specificationCode: spec }, allocations, usage: trialUsage, manualByRoute: trialManualByRoute, batches };
    usedSplit = true;
    const routeIndexes = [];
    let earliest = predecessorEnd;
    for (let chunkIndex = 0; chunkIndex < routeChunks.length; chunkIndex += 1) {
      const qty = routeChunks[chunkIndex];
      const chunkPinnedMachineId = pinnedMachineByLane.get(laneKey) || null;
      const chunkMachines = candidateMachinesForLane(candidateMachines, cycleByMachine, chunkPinnedMachineId, pinMachineLane);
      const placement = findPlacement({ machines: chunkMachines, usage: trialUsage, diesCandidatesByMachine: machineResources.diesCandidatesByMachine, diesUsage: trialDiesUsage, earliest, due, duration: (machine) => Math.max(qty * cycleByMachine(machine), 1), mode, periodStart, periodEnd, preset, scoringContext: { ...scoringContext, pinnedMachineId: chunkPinnedMachineId } });
      if (!placement) return { failed: { code: "CAPACITY_BEFORE_DUE_UNAVAILABLE", route, qty, specificationCode: spec }, allocations, usage: trialUsage, manualByRoute: trialManualByRoute, batches };
      if (pinMachineLane && !chunkPinnedMachineId) pinnedMachineByLane.set(laneKey, placement.machine.id);
      occupy(trialUsage, placement.machine.id, { ...placement, partCode: task.detail.partCode, processCode: route.process?.processCode || null });
      occupyDies(trialDiesUsage, placement.dies?.id, placement);
      allocations.push({ task, qty, ...placement, predecessorDraftIndexes, batchNumber: chunkIndex + 1 });
      routeIndexes.push(allocations.length - 1);
      earliest = placement.end;
    }
    allocationIndexesByRoute.set(route.id, routeIndexes);
    completionByRoute.set(route.id, earliest);
  }
  return { allocations, usage: trialUsage, diesUsage: trialDiesUsage, manualByRoute: trialManualByRoute, batches: usedSplit ? batches : [batches.reduce((sum, qty) => sum + qty, 0)] };
}

function customerDemandQuantity(detail) {
  return Math.max(
    number(detail?.actualSalesOrderQty),
    number(detail?.forecastQty),
    number(detail?.effectiveDemandQty) - number(detail?.bufferQty),
    0,
  );
}

function phaseJobs(plan, details, deliveryPhases) {
  const receipts = details.filter((detail) => !isGeneratedProcess(detail));
  const groups = receipts.map((receipt) => {
    const related = details.filter((detail) => detail.id === receipt.id || sourceMpsDetailId(detail) === receipt.mpsDetailId);
    const phases = deliveryPhases.filter((phase) => phase.mpsDetailId === receipt.mpsDetailId);
    const jobs = phases.map((phase) => ({
      id: phase.id, phaseNumber: phase.phaseNumber, due: phase.plannedDate, qty: number(phase.qtyPlanned),
      targetType: phase.targetType, targetCode: phase.targetCode,
    }));
    const covered = phases.reduce((sum, phase) => sum + number(phase.qtyPlanned), 0);
    const customerDemand = customerDemandQuantity(receipt);
    if (covered + EPSILON < customerDemand) jobs.push({ id: null, phaseNumber: null, due: receipt.requiredDate || plan.periodEnd, qty: customerDemand - covered, targetType: "CUSTOMER", targetCode: null, configurationError: phases.length ? "DELIVERY_PHASE_QTY_SHORT" : "DELIVERY_PHASE_REQUIRED" });
    const bufferProductionQty = Math.max(number(receipt.qtyPlanned) - customerDemand, 0);
    if (bufferProductionQty > EPSILON) jobs.push({ id: null, phaseNumber: null, due: plan.periodEnd, qty: bufferProductionQty, targetType: "INTERNAL_STOCK", targetCode: "BUFFER_STOCK", isBufferStock: true });
    return { receipt, related, jobs };
  });
  const groupedSourceIds = new Set(groups.map((group) => group.receipt.mpsDetailId).filter(Boolean));
  const orphanSources = new Map();
  for (const detail of details.filter(isGeneratedProcess)) {
    const sourceId = sourceMpsDetailId(detail);
    if (!sourceId || groupedSourceIds.has(sourceId)) continue;
    if (!orphanSources.has(sourceId)) orphanSources.set(sourceId, []);
    orphanSources.get(sourceId).push(detail);
  }
  for (const [sourceId, related] of orphanSources) {
    const qty = Math.max(...related.map((detail) => number(detail.qtyPlanned)), 0);
    const due = related.reduce((latest, detail) => !latest || dateOnly(detail.requiredDate || plan.periodEnd) > dateOnly(latest) ? (detail.requiredDate || plan.periodEnd) : latest, null) || plan.periodEnd;
    const sourcePartCode = String(related[0]?.notes || "").match(/;\s*source\s+(.+?)(?:;|$)/i)?.[1]?.trim() || related[0]?.partCode;
    const receipt = { id: sourceId, mpsDetailId: sourceId, partCode: sourcePartCode, qtyPlanned: qty, requiredDate: due };
    const matchingPhases = deliveryPhases.filter((phase) => phase.mpsDetailId === sourceId);
    const orphanJobs = matchingPhases.length ? matchingPhases.map((phase) => ({ id: phase.id, phaseNumber: phase.phaseNumber, due: phase.plannedDate, qty: number(phase.qtyPlanned), targetType: phase.targetType, targetCode: phase.targetCode })) : [{ id: null, phaseNumber: null, due, qty, targetType: "CUSTOMER", targetCode: null, configurationError: "DELIVERY_PHASE_REQUIRED" }];
    groups.push({ receipt, related, jobs: orphanJobs });
  }
  return groups.flatMap((group) => group.jobs.map((job) => ({ ...job, group }))).sort((left, right) =>
    dateOnly(left.due) - dateOnly(right.due)
    || (left.targetType === "CUSTOMER" ? 0 : 1) - (right.targetType === "CUSTOMER" ? 0 : 1)
    || left.phaseNumber - right.phaseNumber);
}

async function loadContext(prisma, planNumber, options = {}) {
  const planningMode = String(options.planningMode || "PRODUCTION").toUpperCase() === "SIMULATION" ? "SIMULATION" : "PRODUCTION";
  const scenarioKey = planningMode === "SIMULATION" ? String(options.scenarioKey || "").toLowerCase() : null;
  const presetId = String(options.presetId || scenarioKey || "").trim().toLowerCase() || null;
  const configuredPreset = presetId
    ? await findPreset(prisma, presetId)
    : planningMode === "PRODUCTION" ? await findActivePreset(prisma) : null;
  const plan = await prisma.monthlyProductionPlan.findFirst({
    where: { planNumber, isDeleted: false },
    include: { details: { where: { isDeleted: false, status: { not: "Cancelled" } }, orderBy: { lineNumber: "asc" } } },
  });
  if (!plan) { const error = new Error("Monthly Production Plan tidak ditemukan."); error.statusCode = 404; throw error; }
  const mpsNumber = String(plan.sourceType || "").startsWith("MPS:") ? String(plan.sourceType).slice(4) : null;
  const horizonEndExclusive = addDays(plan.periodEnd, 1);
  const [machines, headers, bomDetails, allRoutes, phases, existing, linkedSchedules, dies, diesParts, externalAllocations, unlinkedSchedules, calendarOverrides, planOverrides, downtimes] = await Promise.all([
    prisma.machine.findMany({ where: { isDeleted: false, status: "Active" }, orderBy: { machineCode: "asc" } }),
    prisma.mBOMHeader.findMany({ where: { isDeleted: false }, orderBy: [{ partId: "asc" }, { revision: "desc" }, { updatedAt: "desc" }], select: { noReg: true, partId: true } }),
    prisma.mBOMDetail.findMany({ where: { isDeleted: false }, select: { id: true, noReg: true, partId: true, parentDetailId: true } }),
    prisma.mBOMProcess.findMany({ where: { isDeleted: false }, include: { machine: true, vendor: true, process: true, mbomDetail: { include: { part: true, parentDetail: { include: { part: true } } } } } }),
    mpsNumber ? prisma.mPSDeliveryPlan.findMany({ where: { mpsNumber, targetType: "CUSTOMER", isDeleted: false, status: { not: "Cancelled" } }, orderBy: [{ plannedDate: "asc" }, { phaseNumber: "asc" }] }) : [],
    prisma.productionPlanAllocation.findMany({
      where: { planId: plan.id, isDeleted: false, status: { in: ["Draft", "Published"] }, planningMode, ...(planningMode === "SIMULATION" ? { scenarioKey } : {}) },
      include: { mbomProcess: { select: { diesId: true, process: { select: { processCode: true } }, mbomDetail: { select: { part: { select: { partCode: true } } } } } } },
    }),
    planningMode === "PRODUCTION"
      ? prisma.dailyProductionSchedule.findMany({
          where: { productionPlanId: plan.id, productionPlanAllocationId: { not: null }, isDeleted: false, status: { not: "Cancelled" } },
          select: { id: true, status: true, productionPlanAllocationId: true },
        })
      : [],
    prisma.dies.findMany({
      where: { isDeleted: false, status: "Active" },
      include: { maintenances: { where: { isDeleted: false }, select: { maintenanceDate: true, startDate: true, endDate: true } } },
      orderBy: { diesCode: "asc" },
    }),
    prisma.diesPart.findMany({
      where: { isActive: true, dies: { isDeleted: false, status: "Active" } },
      orderBy: [{ isPrimary: "desc" }, { effectiveDate: "desc" }],
    }),
    prisma.productionPlanAllocation.findMany({
      where: {
        planId: { not: plan.id }, isDeleted: false, status: { in: ["Draft", "Published"] }, planningMode: "PRODUCTION",
        scheduleDate: { gte: plan.periodStart, lte: plan.periodEnd }, routingMode: "INHOUSE", machineId: { not: null },
      },
      include: { mbomProcess: { select: { diesId: true, process: { select: { processCode: true } }, mbomDetail: { select: { part: { select: { partCode: true } } } } } } },
    }),
    prisma.dailyProductionSchedule.findMany({
      where: {
        productionPlanAllocationId: null, isDeleted: false, status: { in: ["Draft", "Released", "In Progress"] },
        scheduleDate: { gte: plan.periodStart, lte: plan.periodEnd }, shift: { not: "VENDOR" }, machineId: { not: null },
      },
      select: { machineId: true, diesId: true, scheduleDate: true, shift: true, plannedStartTime: true, plannedEndTime: true },
    }),
    prisma.capacityCalendarOverride.findMany({
      where: { isDeleted: false, scheduleDate: { gte: plan.periodStart, lt: horizonEndExclusive } },
      select: { id: true, machineId: true, scheduleDate: true, dayStatus: true, shiftsPerDay: true, overtimeStart: true, overtimeEnd: true, reason: true, changedAt: true },
      orderBy: [{ scheduleDate: "asc" }, { machineId: "asc" }],
    }),
    prisma.capacityDayOverride.findMany({
      where: { planId: plan.id, isDeleted: false, scheduleDate: { gte: plan.periodStart, lt: horizonEndExclusive } },
      select: { id: true, machineId: true, scheduleDate: true, dayStatus: true, shiftsPerDay: true, overtimeStart: true, overtimeEnd: true, reason: true, changedAt: true },
      orderBy: [{ changedAt: "asc" }, { id: "asc" }],
    }),
    prisma.downtimeLog.findMany({
      where: { downtimeDate: { gte: plan.periodStart, lt: horizonEndExclusive }, isDeleted: false, status: { not: "Cancelled" }, machineCode: { not: null } },
      select: { id: true, downtimeNumber: true, downtimeDate: true, machineCode: true, shift: true, startTime: true, endTime: true, durationMinutes: true, reason: true, category: true, status: true },
      orderBy: [{ downtimeDate: "asc" }, { downtimeNumber: "asc" }],
    }),
  ]);
  const latest = new Map();
  headers.forEach((header) => { if (header.partId && !latest.has(header.partId)) latest.set(header.partId, header.noReg); });
  const noRegs = new Set(latest.values());
  const capacityRuleIndex = buildCapacityRuleIndex({ globalOverrides: calendarOverrides, planOverrides });
  const preset = withCapacityRuleIndex(configuredPreset, capacityRuleIndex);
  return {
    plan, machines, headers: headers.filter((header) => noRegs.has(header.noReg)), bomDetails: bomDetails.filter((detail) => noRegs.has(detail.noReg)), routes: allRoutes.filter((route) => noRegs.has(route.noReg)),
    phases, existing, linkedSchedules, dies, diesParts, externalAllocations, unlinkedSchedules, downtimes,
    planningMode, scenarioKey, presetId: configuredPreset?.id || presetId, preset,
    capacityConstraintAudit: {
      rulePrecedence: ["PLAN_OVERRIDE", "SIMULATION_PRESET", "GLOBAL_CALENDAR"],
      globalCalendarRuleCount: calendarOverrides.length,
      planOverrideCount: planOverrides.length - capacityRuleIndex.ignoredDerivedPlanOverrideCount,
      ignoredDerivedPlanOverrideCount: capacityRuleIndex.ignoredDerivedPlanOverrideCount,
      presetDailyRuleCount: Object.keys(configuredPreset?.dailyOverrides || {}).length,
    },
  };
}

async function recommendMonthlyCapacity(prisma, planNumber, options = {}) {
  const context = await loadContext(prisma, planNumber, options);
  const { plan, machines, headers, bomDetails, routes, phases, existing, linkedSchedules, dies, diesParts, externalAllocations, unlinkedSchedules, downtimes, planningMode, scenarioKey, presetId, preset, capacityConstraintAudit } = context;
  const fgCompletionDaysBefore = Math.max(Math.trunc(number(options.flowRule?.delivery?.fgCompletionDaysBefore)), 0);
  const allowedStatuses = ["Draft", "Confirmed", "Released", "In Progress"];
  if (!allowedStatuses.includes(plan.status)) { const error = new Error(`Rekomendasi ${planningMode.toLowerCase()} tidak dapat dibuat saat MPP berstatus ${plan.status}.`); error.statusCode = 409; throw error; }
  const machineBySpecification = new Map();
  for (const machine of machines) {
    const code = machine.machineSpecificationCode;
    if (!code) continue;
    if (!machineBySpecification.has(code)) machineBySpecification.set(code, []);
    machineBySpecification.get(code).push(machine);
  }
  const routesByPart = new Map();
  for (const route of routes) {
    const key = route.mbomDetail?.partId || route.mbomDetail?.part?.partCode;
    if (!key) continue;
    if (!routesByPart.has(key)) routesByPart.set(key, []);
    routesByPart.get(key).push(route);
  }
  const usage = new Map();
  const downtimeConstraintAudit = reserveDowntimeCapacity({ usage, machines, downtimes, preset, periodStart: plan.periodStart, periodEnd: plan.periodEnd });
  const capacityConstraints = { ...capacityConstraintAudit, downtime: downtimeConstraintAudit };
  const diesUsage = new Map();
  const diesById = new Map(dies.map((row) => [row.id, row]));
  const diesPartsByPartId = new Map();
  for (const mapping of diesParts) {
    if (!diesPartsByPartId.has(mapping.partId)) diesPartsByPartId.set(mapping.partId, []);
    diesPartsByPartId.get(mapping.partId).push(mapping);
  }
  const diesForRoute = (route, eligibleMachines = []) => {
    if (!isPressResource(eligibleMachines[0] || route.machine, route)) return [];
    if (route.diesId) return [diesById.get(route.diesId)].filter(Boolean);
    const scheduleStart = dateOnly(plan.periodStart);
    const scheduleEnd = dateOnly(plan.periodEnd);
    return (diesPartsByPartId.get(route.mbomDetail?.partId) || [])
      .filter((mapping) => mapping.effectiveDate <= scheduleEnd && (!mapping.expiryDate || mapping.expiryDate >= scheduleStart))
      .map((mapping) => diesById.get(mapping.diesId))
      .filter((diesRow, index, rows) => diesRow && rows.findIndex((candidate) => candidate.id === diesRow.id) === index);
  };
  for (const diesRow of dies) {
    for (const maintenance of diesRow.maintenances || []) {
      const interval = maintenanceInterval(maintenance);
      if (!interval) continue;
      occupyDies(diesUsage, diesRow.id, {
        start: (interval.start - dateOnly(plan.periodStart).getTime()) / 60000,
        end: (interval.end - dateOnly(plan.periodStart).getTime()) / 60000,
      });
    }
  }
  // A calendar day that has passed is execution history. Treat historical
  // auto-allocation as firm input so re-running either Simulation or
  // Production never replaces it or schedules new work in the past.
  const today = jakartaToday();
  const executionFloor = Math.max(0, absoluteMinute(plan.periodStart, today, 0));
  const planPartByLine = new Map((plan.details || []).map((detail) => [number(detail.lineNumber), detail.partCode]));
  // Once Production has released/started/completed a DPP, its originating
  // allocation becomes firm. Replanning an In Progress MPP only replaces the
  // unexecuted Draft remainder and never moves execution history.
  const firmAllocationIds = new Set((linkedSchedules || [])
    .filter((row) => row.status !== "Draft")
    .map((row) => row.productionPlanAllocationId)
    .filter(Boolean));
  const manual = existing.filter((row) => row.allocationSource !== "AUTO_RECOMMENDATION" || dateOnly(row.scheduleDate) < today || firmAllocationIds.has(row.id));
  for (const row of [...externalAllocations, ...manual]) {
    if (!row.machineId) continue;
    const day = dayIndex(plan.periodStart, row.scheduleDate);
    const start = day * DAY_MINUTES + minuteOfDay(row.plannedStartTime, row.shift === "2" ? 960 : row.shift === "3" ? 0 : 480);
    const end = day * DAY_MINUTES + minuteOfDay(row.plannedEndTime, row.shift === "2" ? 1440 : row.shift === "3" ? 480 : 960);
    const reservation = { start, end: end <= start ? end + DAY_MINUTES : end };
    occupy(usage, row.machineId, { ...reservation, partCode: row.planId === plan.id ? planPartByLine.get(number(row.lineNumber)) : row.mbomProcess?.mbomDetail?.part?.partCode || null, processCode: row.mbomProcess?.process?.processCode || null });
    occupyDies(diesUsage, row.diesId || row.mbomProcess?.diesId, reservation);
  }
  for (const row of unlinkedSchedules) {
    const day = dayIndex(plan.periodStart, row.scheduleDate);
    const start = day * DAY_MINUTES + minuteOfDay(row.plannedStartTime, row.shift === "2" ? 960 : row.shift === "3" ? 0 : 480);
    const end = day * DAY_MINUTES + minuteOfDay(row.plannedEndTime, row.shift === "2" ? 1440 : row.shift === "3" ? 480 : 960);
    const reservation = { start, end: end <= start ? end + DAY_MINUTES : end };
    occupy(usage, row.machineId, { ...reservation, partCode: null, processCode: null });
    occupyDies(diesUsage, row.diesId, reservation);
  }
  let manualByRoute = new Map();
  manual.forEach((row) => manualByRoute.set(row.mbomProcessId, number(manualByRoute.get(row.mbomProcessId)) + number(row.plannedQty)));
  const manualCompletionByRoute = new Map();
  for (const row of manual) {
    const completion = absoluteMinute(plan.periodStart, row.routingMode === "VENDOR" ? (row.vendorReturnDate || row.scheduleDate) : row.scheduleDate,
      minuteOfDay(row.plannedEndTime, row.routingMode === "VENDOR" ? DAY_MINUTES : row.shift === "2" ? DAY_MINUTES : row.shift === "3" ? 480 : 960));
    manualCompletionByRoute.set(row.mbomProcessId, Math.max(number(manualCompletionByRoute.get(row.mbomProcessId)), completion));
  }
  const jobs = phaseJobs(plan, plan.details, phases);
  const generated = [];
  const blockers = [];
  const phaseResults = [];
  const cumulativeQty = new Map();
  const modes = ["NORMAL", preset?.algorithm?.allowParallel !== false ? "PARALLEL" : null, preset?.algorithm?.allowExtraShift !== false ? "TWO_SHIFT" : null, preset?.algorithm?.allowExtraShift !== false ? "THREE_SHIFT" : null, preset?.algorithm?.allowOvertime !== false ? "OVERTIME" : null].filter(Boolean);

  for (const job of jobs) {
    const targetFgDue = job.targetType === "CUSTOMER" && fgCompletionDaysBefore > 0 ? addDays(job.due, -fgCompletionDaysBefore) : dateOnly(job.due);
    job.targetFgDue = targetFgDue;
    if (job.configurationError) {
      blockers.push({
        phaseId: null, phaseNumber: null, dueDate: dateKey(job.due), targetFgDate: dateKey(targetFgDue), partCode: job.group.receipt.partCode,
        code: job.configurationError, qty: round(job.qty),
        message: job.configurationError === "DELIVERY_PHASE_REQUIRED"
          ? "Delivery Schedule MPS belum dibuat; sistem tidak membuat phase otomatis."
          : "Total qty Delivery Schedule MPS belum menutup qty MPS; lengkapi sisa qty phase.",
      });
      phaseResults.push({ phaseId: null, phaseNumber: null, dueDate: dateKey(job.due), targetFgDate: dateKey(targetFgDue), qty: round(job.qty), targetType: job.targetType, status: "BLOCKED", blocker: job.configurationError });
      continue;
    }
    // Delivery phases retain gross customer demand, while the MPP receipt
    // target is stock-netted. Use the phase total as the distribution basis
    // so all generated allocations add back exactly to each detail's MPP qty
    // (for example demand 300, opening FG 20, production target 280).
    const receiptQty = Math.max(
      job.group.jobs.reduce((sum, phase) => sum + number(phase.qty), 0),
      EPSILON,
    );
    const groupKey = job.group.receipt.id;
    const receiptQtyBeforeJob = number(cumulativeQty.get(groupKey));
    const relatedRoutes = job.group.related.flatMap((detail) => {
      const key = detail.partId || detail.partCode;
      return canonicalizeRoutingOperations(routesByPart.get(key) || []).map((route) => ({ detail, route }));
    });
    if (!relatedRoutes.length) continue;
    const graph = buildRouteGraph(relatedRoutes, headers, bomDetails);
    let attempt = null;
    const due = absoluteMinute(plan.periodStart, targetFgDue, DAY_MINUTES);
    const profile = String(options.flowRule?.algorithmProfile || "SHIFT_CAPACITY_TRANSFER").toUpperCase();
    attemptModes:
    for (const mode of modes) {
      const configuredBatches = profile === "FULL_COMPLETION_SEQUENCE"
        ? splitTransferBatches(job.qty, 0)
        : profile === "SHIFT_CAPACITY_TRANSFER"
          ? splitTransferBatches(job.qty, shiftCapacityTransferQuantity(job.qty, graph, receiptQty, machineBySpecification, preset))
          : splitFlowBatches(job.qty, options.flowRule, options.transferBatchQty);
      if (profile === "SHIFT_CAPACITY_TRANSFER") {
        const perRouteAttempt = scheduleFitFirstPerRoute({
          graph, batches: configuredBatches, receiptQty, receiptQtyBeforeJob,
          trialUsage: cloneUsage(usage), trialDiesUsage: cloneUsage(diesUsage), trialManualByRoute: new Map(manualByRoute), manualCompletionByRoute,
          machineBySpecification, diesForRoute, mode, due, executionFloor, periodStart: plan.periodStart, periodEnd: plan.periodEnd, preset,
        });
        if (!perRouteAttempt.failed) { attempt = { mode, ...perRouteAttempt }; break attemptModes; }
        attempt = { mode, ...perRouteAttempt };
        continue;
      }
      const batchStrategies = profile === "SHIFT_CAPACITY_TRANSFER"
        ? fitFirstBatchStrategies(job.qty, configuredBatches)
        : [configuredBatches];
      for (const batches of batchStrategies) {
        const trialUsage = cloneUsage(usage);
        const trialDiesUsage = cloneUsage(diesUsage);
        const trialManualByRoute = new Map(manualByRoute);
        const allocations = [];
        const pinMachineLane = shouldPinMachineLane(mode, preset);
        const pinnedMachineByLane = new Map();
        let failed = null;
        for (let batchIndex = 0; batchIndex < batches.length && !failed; batchIndex += 1) {
        const completionByRoute = new Map();
        const allocationIndexByRoute = new Map();
          for (const task of graph.ordered) {
          const route = task.route;
          const predecessorRouteIds = [...(graph.predecessors.get(route.id) || [])];
          const predecessorEnd = Math.max(executionFloor, ...predecessorRouteIds.map((id) => number(completionByRoute.get(id))));
          const predecessorDraftIndexes = normalizeLineageIndexes(predecessorRouteIds.map((id) => allocationIndexByRoute.get(id)), allocations.length);
          const factor = number(task.detail.qtyPlanned) / receiptQty;
          const receiptQtyBeforeBatch = receiptQtyBeforeJob + batches.slice(0, batchIndex).reduce((sum, value) => sum + number(value), 0);
          let qty = generatedBatchQuantity(batches[batchIndex], receiptQtyBeforeBatch, factor > 0 ? factor : 1, task.detail.uomCode);
          const manualRemaining = Math.max(number(trialManualByRoute.get(route.id)), 0);
          if (manualRemaining > EPSILON) {
            const consumed = Math.min(qty, manualRemaining);
            qty -= consumed;
            trialManualByRoute.set(route.id, manualRemaining - consumed);
          }
          if (qty <= EPSILON) {
            completionByRoute.set(route.id, Math.max(predecessorEnd, number(manualCompletionByRoute.get(route.id))));
            continue;
          }
          if (routeMode(route) === "VENDOR") {
            const duration = Math.max(leadMinutes(route), 1);
            const start = predecessorEnd;
            const end = start + duration;
            if (end > due + EPSILON) { failed = { code: "VENDOR_LEAD_TIME_LATE", route, qty }; break; }
            allocations.push({ task, qty, start, end, shift: "VENDOR", machine: null, overtime: false, predecessorDraftIndexes, batchNumber: batchIndex + 1 });
            allocationIndexByRoute.set(route.id, allocations.length - 1);
            completionByRoute.set(route.id, end);
            continue;
          }
          const spec = specificationCode(route);
          const eligible = spec ? machineBySpecification.get(spec) || [] : [];
          if (!eligible.length) { failed = { code: "MACHINE_SPECIFICATION_UNAVAILABLE", route, qty, specificationCode: spec }; break; }
          const cycleByMachine = (machine) => effectiveCycleMinutes(route, machine, preset?.efficiency || 85);
          const cycleEligible = cycleCapableMachines(eligible, cycleByMachine);
          if (!cycleEligible.length) { failed = { code: "CYCLE_TIME_MISSING", route, qty, specificationCode: spec }; break; }
          const cycle = Math.min(...cycleEligible.map(cycleByMachine));
          const laneKey = machineLaneKey(route);
          const pinnedMachineId = pinnedMachineByLane.get(laneKey) || null;
          const laneMachines = candidateMachinesForLane(cycleEligible, cycleByMachine, pinnedMachineId, pinMachineLane);
          if (!laneMachines.length) { failed = { code: "CAPACITY_BEFORE_DUE_UNAVAILABLE", route, qty, specificationCode: spec }; break; }
          const machineResources = buildMachineDiesOptions(route, laneMachines, diesForRoute);
          if (!machineResources.machines.length) { failed = { code: machineResources.excludedPressMachineIds.length ? "DIES_UNAVAILABLE" : "CAPACITY_BEFORE_DUE_UNAVAILABLE", route, qty, specificationCode: spec }; break; }
          const candidateMachines = machineResources.machines;
          const placement = findPlacement({ machines: candidateMachines, usage: trialUsage, diesCandidatesByMachine: machineResources.diesCandidatesByMachine, diesUsage: trialDiesUsage, earliest: predecessorEnd, due, duration: (machine) => qty * cycleByMachine(machine), mode, periodStart: plan.periodStart, periodEnd: plan.periodEnd, preset, scoringContext: { bestCycleMinutes: cycle, cycleByMachine, partCode: task.detail.partCode, processCode: route.process?.processCode || null, lanePolicy: pinMachineLane ? "PIN_BY_LOGICAL_ROUTE" : "ALLOW_PARALLEL_SCORING", pinnedMachineId } });
          if (!placement) { failed = { code: "CAPACITY_BEFORE_DUE_UNAVAILABLE", route, qty, specificationCode: spec }; break; }
          if (pinMachineLane && !pinnedMachineId) pinnedMachineByLane.set(laneKey, placement.machine.id);
          occupy(trialUsage, placement.machine.id, { ...placement, partCode: task.detail.partCode, processCode: route.process?.processCode || null });
          occupyDies(trialDiesUsage, placement.dies?.id, placement);
          allocations.push({ task, qty, ...placement, predecessorDraftIndexes, batchNumber: batchIndex + 1 });
          allocationIndexByRoute.set(route.id, allocations.length - 1);
          completionByRoute.set(route.id, placement.end);
          }
        }
        if (!failed) {
          attempt = { mode, usage: trialUsage, diesUsage: trialDiesUsage, allocations, manualByRoute: trialManualByRoute, batches };
          break attemptModes;
        }
        attempt = { mode, usage: trialUsage, allocations, failed, batches };
      }
    }
    if (attempt.failed) {
      blockers.push({ phaseId: job.id, phaseNumber: job.phaseNumber, dueDate: dateKey(job.due), targetFgDate: dateKey(targetFgDue), partCode: job.group.receipt.partCode, code: attempt.failed.code, processCode: attempt.failed.route?.process?.processCode || null, machineSpecificationCode: attempt.failed.specificationCode || null, qty: round(attempt.failed.qty) });
      phaseResults.push({ phaseId: job.id, phaseNumber: job.phaseNumber, dueDate: dateKey(job.due), targetFgDate: dateKey(targetFgDue), qty: round(job.qty), targetType: job.targetType, status: "BLOCKED", blocker: attempt.failed.code });
      continue;
    }
    const lanesByRoute = new Map();
    for (const row of attempt.allocations.filter((item) => item.machine)) {
      const routeKey = machineLaneKey(row.task.route);
      if (!lanesByRoute.has(routeKey)) lanesByRoute.set(routeKey, new Set());
      lanesByRoute.get(routeKey).add(row.machine.id);
    }
    const laneCount = Math.max(1, ...[...lanesByRoute.values()].map((ids) => ids.size));
    const capacityMode = attempt.mode === "OVERTIME" ? "OVERTIME" : attempt.mode === "THREE_SHIFT" || attempt.mode === "TWO_SHIFT" ? "EXTRA_SHIFT" : laneCount > 1 ? "PARALLEL_LANE" : "NORMAL";
    const generatedBaseIndex = generated.length;
    const phaseLineagePrefix = `phase:${job.id || `${groupKey}:${dateKey(job.due)}`}`;
    const draftLineageKeys = attempt.allocations.map((draft, index) => `${phaseLineagePrefix}:batch:${draft.batchNumber}:route:${draft.task.route.id}:allocation:${index + 1}`);
    for (let draftIndex = 0; draftIndex < attempt.allocations.length; draftIndex += 1) {
      const draft = attempt.allocations[draftIndex];
      const predecessorDraftIndexes = normalizeLineageIndexes(draft.predecessorDraftIndexes, attempt.allocations.length);
      const predecessorToken = predecessorDraftIndexes.map((index) => generatedBaseIndex + index);
      const lineageKey = draftLineageKeys[draftIndex];
      const predecessorLineageKeys = predecessorDraftIndexes.map((index) => draftLineageKeys[index]).filter(Boolean);
      const baseScoreAudit = draft.recommendationScoreBreakdown || { model: SCORING_MODEL, score: null, breakdown: {}, factors: {}, context: {} };
      const recommendationScoreBreakdown = {
        ...baseScoreAudit,
        audit: {
          ...(baseScoreAudit.audit || {}),
          lineage: { key: lineageKey, predecessorKeys: predecessorLineageKeys, transferBatchNumber: draft.batchNumber },
        },
      };
      generated.push({ ...draft, recommendationScoreBreakdown, phase: job, mode: attempt.mode, capacityMode, predecessorToken, lineageKey, predecessorLineageKeys });
    }
    for (const [key, value] of attempt.usage) usage.set(key, value);
    for (const [key, value] of attempt.diesUsage || []) diesUsage.set(key, value);
    manualByRoute = attempt.manualByRoute;
    cumulativeQty.set(groupKey, number(cumulativeQty.get(groupKey)) + job.qty);
    const allocationScores = attempt.allocations.map((allocation) => number(allocation.recommendationScore)).filter((score) => score > 0);
    phaseResults.push({ phaseId: job.id, phaseNumber: job.phaseNumber, dueDate: dateKey(job.due), targetFgDate: dateKey(targetFgDue), qty: round(job.qty), cumulativeQty: round(cumulativeQty.get(groupKey)), targetType: job.targetType, status: "COVERED", capacityMode, laneCount, algorithmProfile: String(options.flowRule?.algorithmProfile || "SHIFT_CAPACITY_TRANSFER").toUpperCase(), scoringModel: SCORING_MODEL, averageAllocationScore: allocationScores.length ? round(allocationScores.reduce((sum, score) => sum + score, 0) / allocationScores.length, 2) : null, minimumAllocationScore: allocationScores.length ? round(Math.min(...allocationScores), 2) : null, transferBatchCount: attempt.batches.length, transferBatchQty: round(Math.max(...attempt.batches, 0)) });
  }

  const scoringSummary = summarizeAllocationScoring(generated);
  const persisted = [];
  if (options.persist !== false) {
    await prisma.$transaction(async (tx) => {
      const replaceableIds = existing
        .filter((row) => row.allocationSource === "AUTO_RECOMMENDATION" && dateOnly(row.scheduleDate) >= today && !firmAllocationIds.has(row.id))
        .map((row) => row.id);
      if (planningMode === "PRODUCTION" && replaceableIds.length) {
        await tx.dailyProductionSchedule.updateMany({
          where: { productionPlanAllocationId: { in: replaceableIds }, isDeleted: false, status: "Draft" },
          data: { isDeleted: true, status: "Cancelled" },
        });
      }
      if (replaceableIds.length) {
        await tx.productionPlanAllocation.updateMany({
          where: { id: { in: replaceableIds }, status: { in: ["Draft", "Published"] }, isDeleted: false },
          data: { isDeleted: true, status: "Cancelled" },
        });
      }
      const createdIds = [];
      for (let index = 0; index < generated.length; index += 1) {
        const item = generated[index];
        const route = item.task.route;
        const scheduleDate = dateFromAbsolute(plan.periodStart, item.start);
        const predecessorIds = item.predecessorToken.map((token) => createdIds[token]).filter(Boolean);
        const uomCode = item.task.detail.uomCode || null;
        const plannedQty = normalizeQuantity(round(item.qty), uomCode);
        const hasRecommendationScore = Number.isFinite(Number(item.recommendationScore));
        const created = await tx.productionPlanAllocation.create({ data: {
          planId: plan.id, lineNumber: item.task.detail.lineNumber, mbomProcessId: route.id, scheduleDate,
          shift: item.shift, plannedStartTime: timeText(item.start), plannedEndTime: timeText(item.end),
          machineId: item.machine?.id || null, diesId: item.dies?.id || null, routingMode: routeMode(route), vendorId: routeMode(route) === "VENDOR" ? route.vendorId : null,
          vendorSendDate: routeMode(route) === "VENDOR" ? scheduleDate : null,
          vendorReturnDate: routeMode(route) === "VENDOR" ? dateFromAbsolute(plan.periodStart, item.end) : null,
          vendorLeadTimeDays: routeMode(route) === "VENDOR" ? Math.ceil(leadMinutes(route) / DAY_MINUTES) : null,
          expectedReturnQty: routeMode(route) === "VENDOR" ? plannedQty : null,
          plannedQty, uomCode, status: "Draft",
          notes: `[AUTO-RECOMMENDATION:${VERSION}] ${item.phase.isBufferStock ? "Internal buffer stock" : `Delivery phase ${item.phase.phaseNumber}`}; transfer batch ${item.batchNumber}; [LINEAGE:${item.lineageKey}]`,
          allocationSource: "AUTO_RECOMMENDATION", planningMode, scenarioKey,
          recommendationScore: hasRecommendationScore ? round(item.recommendationScore, 2) : null,
          recommendationScoreBreakdown: item.recommendationScoreBreakdown || null,
          recommendationReason: hasRecommendationScore
            ? `Score ${round(item.recommendationScore, 2)}/100; Delivery ${dateKey(item.phase.due)}; target FG ${dateKey(item.phase.targetFgDue || item.phase.due)}; ${item.capacityMode}; predecessor siap ${timeText(item.start)}`
            : `Rule-based ${routeMode(route).toLowerCase()} allocation; Delivery ${dateKey(item.phase.due)}; target FG ${dateKey(item.phase.targetFgDue || item.phase.due)}; predecessor siap ${timeText(item.start)}`,
          capacityMode: item.capacityMode, deliveryPhaseId: item.phase.id, deliveryPhaseNumber: item.phase.phaseNumber,
          transferBatchNumber: item.batchNumber, predecessorAllocationIds: predecessorIds, createdBy: options.actor || "system",
        } });
        createdIds.push(created.id); persisted.push(created);
      }
      const expandedDays = buildDerivedCapacityDays(generated, plan.periodStart, preset);
      if (planningMode === "PRODUCTION") {
        // Replace only derived future escalations. Planner-authored rules are
        // hard constraints and must never be deleted or overwritten here.
        await tx.capacityDayOverride.updateMany({
          where: {
            planId: plan.id,
            isDeleted: false,
            reason: { startsWith: AUTO_CAPACITY_OVERRIDE_PREFIX },
            scheduleDate: { gte: today, lte: plan.periodEnd },
          },
          data: { isDeleted: true, changedBy: options.actor || "system", changedAt: new Date() },
        });
      }
      for (const day of planningMode === "PRODUCTION" ? expandedDays.values() : []) {
        const current = await tx.capacityDayOverride.findFirst({
          where: { planId: plan.id, machineId: day.machineId, scheduleDate: day.scheduleDate },
          select: { id: true, reason: true, isDeleted: true },
        });
        if (current && !current.isDeleted && !isAutoCapacityOverride(current)) continue;
        const data = {
          dayStatus: "OVERLOAD", shiftsPerDay: day.shiftsPerDay,
          overtimeStart: day.overtime ? timeText(day.overtimeStart) : null, overtimeEnd: day.overtime ? timeText(day.overtimeEnd) : null,
          reason: `${AUTO_CAPACITY_OVERRIDE_PREFIX} Escalation untuk delivery phase`, changedBy: options.actor || "system", changedAt: new Date(), isDeleted: false,
        };
        if (current) await tx.capacityDayOverride.update({ where: { id: current.id }, data });
        else await tx.capacityDayOverride.create({ data: { planId: plan.id, machineId: day.machineId, scheduleDate: day.scheduleDate, ...data } });
      }
      const previousSummary = plan.recommendationSummary && typeof plan.recommendationSummary === "object" && !Array.isArray(plan.recommendationSummary) ? plan.recommendationSummary : {};
      const capacityFlowRule = previousSummary.capacityFlowRule || (options.flowRule ? { active: options.flowRule } : null);
      const summary = { ...previousSummary, version: VERSION, scoringModel: SCORING_MODEL, scoringWeights: SCORING_WEIGHTS, scoringSummary, capacityConstraints, averageAllocationScore: scoringSummary.averageScore, minimumAllocationScore: scoringSummary.minimumScore, allocationCount: persisted.length, phaseCount: phaseResults.length, coveredPhaseCount: phaseResults.filter((row) => row.status === "COVERED").length, blockerCount: blockers.length, phaseResults, blockers, ...(capacityFlowRule ? { capacityFlowRule } : {}) };
      if (planningMode === "PRODUCTION") await tx.monthlyProductionPlan.update({ where: { id: plan.id }, data: { recommendationGeneratedAt: new Date(), recommendationVersion: VERSION, recommendationSummary: summary } });
    });
  }
  const provisionalReady = blockers.length === 0;
  const validationRequest = buildRecommendationValidationScope({ planNumber, planningMode, scenarioKey, presetId, persisted: options.persist !== false });
  return {
    planNumber, planningMode, scenarioKey, presetId, presetName: preset?.name || null, version: VERSION, scoringModel: SCORING_MODEL, scoringWeights: SCORING_WEIGHTS,
    scoringSummary,
    capacityConstraints,
    allocationCount: options.persist === false ? generated.length : persisted.length,
    firmAllocationCount: firmAllocationIds.size,
    preservedCompletedDppCount: (linkedSchedules || []).filter((row) => row.status === "Completed").length,
    ...(options.persist === false ? { previewAllocations: generated.map((row) => ({
      partCode: row.task.detail.partCode, processCode: row.task.route.process?.processCode || null,
      qty: round(row.qty), phaseNumber: row.phase.phaseNumber, batchNumber: row.batchNumber,
      machineCode: row.machine?.machineCode || null, shift: row.shift,
      diesCode: row.dies?.diesCode || null, recommendationScore: row.recommendationScore, recommendationScoreBreakdown: row.recommendationScoreBreakdown,
      lineageKey: row.lineageKey, predecessorLineageKeys: row.predecessorLineageKeys,
    })) } : {}),
    phaseResults,
    blockers,
    provisionalReady,
    ready: provisionalReady,
    validation: {
      status: options.persist === false ? "PREVIEW_ONLY" : "AUTHORITATIVE_READINESS_REQUIRED",
      request: validationRequest,
    },
  };
}

module.exports = {
  recommendMonthlyCapacity,
  generatedBatchQuantity,
  customerDemandQuantity,
  phaseJobs,
  splitFlowBatches,
  fitFirstBatchStrategies,
  shiftCapacityTransferQuantity,
  shiftWindows,
  buildCapacityRuleIndex,
  withCapacityRuleIndex,
  capacityRuleForMachineDate,
  freeCapacitySegments,
  reserveDowntimeCapacity,
  buildDerivedCapacityDays,
  isAutoCapacityOverride,
  scorePlacementCandidate,
  findPlacement,
  findFeasibleSlotStarts,
  comparePlacementCandidates,
  retainRankedCandidate,
  resolveCandidateBudget,
  cycleCapableMachines,
  candidateMachinesForLane,
  shouldPinMachineLane,
  machineLaneKey,
  buildMachineDiesOptions,
  normalizeLineageIndexes,
  summarizeAllocationScoring,
  buildRecommendationValidationScope,
  SCORING_MODEL,
  SCORING_WEIGHTS,
  DEFAULT_CANDIDATE_BUDGET,
  MAX_CANDIDATE_BUDGET,
  AUTO_CAPACITY_OVERRIDE_PREFIX,
  VERSION,
};
