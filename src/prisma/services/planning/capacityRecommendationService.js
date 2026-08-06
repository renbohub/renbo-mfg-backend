const { canonicalizeRoutingOperations, compareRoutingOperations } = require("../../utils/routingSequence");
const { isDiscreteUom, normalizeQuantity } = require("../../utils/uomQuantity");
const { findPreset } = require("./capacitySimulationPresetService");

const DAY_MINUTES = 1440;
const EPSILON = 0.000001;
const VERSION = "FINITE-CAPACITY-PIPELINE-V1";
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const round = (value, digits = 3) => Number(number(value).toFixed(digits));

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
  const count = batchQty > EPSILON ? Math.min(25, Math.max(1, Math.ceil(qty / batchQty))) : 1;
  const base = qty / count;
  return Array.from({ length: count }, (_, index) => index === count - 1
    ? round(qty - round(base, 6) * (count - 1), 6)
    : round(base, 6));
}

function cloneUsage(usage) {
  return new Map([...usage.entries()].map(([key, intervals]) => [key, intervals.map((item) => ({ ...item }))]));
}

function shiftWindows(machine, day, mode, preset, periodStart) {
  const defaults = [[480, 960], [960, 1440], [0, 480]];
  const calendarDate = addDays(periodStart, day); const date = dateKey(calendarDate); const dailyRule = preset?.dailyOverrides?.[date] || null;
  const weekDay = calendarDate.getUTCDay();
  const includeSaturday = preset ? preset.includeSaturday : true; const includeSunday = preset ? preset.includeSunday : false;
  if (dailyRule?.dayStatus === "HOLIDAY" || (!dailyRule && ((weekDay === 6 && !includeSaturday) || (weekDay === 0 && !includeSunday)))) return [];
  const presetShifts = dailyRule?.shifts?.length ? dailyRule.shifts : preset?.shifts;
  const configured = [
    [minuteOfDay(presetShifts?.[0]?.start || machine.shift1Start, defaults[0][0]), minuteOfDay(presetShifts?.[0]?.end || machine.shift1End, defaults[0][1])],
    [minuteOfDay(presetShifts?.[1]?.start || machine.shift2Start, defaults[1][0]), minuteOfDay(presetShifts?.[1]?.end || machine.shift2End, defaults[1][1])],
    [minuteOfDay(presetShifts?.[2]?.start || machine.shift3Start, defaults[2][0]), minuteOfDay(presetShifts?.[2]?.end || machine.shift3End, defaults[2][1])],
  ].map(([start, end], index) => ({ shift: String(index + 1), start, end: end <= start ? end + DAY_MINUTES : end }));
  const baseShiftCount = Math.min(Math.max(number(dailyRule?.shiftCount || preset?.shiftCount || 1), 1), 3);
  const shifts = ["NORMAL", "PARALLEL", "OVERTIME"].includes(mode) ? baseShiftCount : mode === "TWO_SHIFT" ? Math.max(baseShiftCount, 2) : 3;
  const windows = configured.slice(0, shifts).map((window) => ({
    ...window,
    start: day * DAY_MINUTES + window.start,
    end: day * DAY_MINUTES + window.end,
    overtime: false,
  }));
  if (mode === "OVERTIME") {
    const last = windows.at(-1); const overtimeStart = minuteOfDay(dailyRule?.overtimeStart || preset?.overtimeStart, last.end % DAY_MINUTES); const overtimeEndRaw = minuteOfDay(dailyRule?.overtimeEnd || preset?.overtimeEnd, (last.end + 240) % DAY_MINUTES); const overtimeEnd = overtimeEndRaw <= overtimeStart ? overtimeEndRaw + DAY_MINUTES : overtimeEndRaw;
    windows.push({ shift: last.shift, start: day * DAY_MINUTES + overtimeStart, end: day * DAY_MINUTES + overtimeEnd, overtime: true });
  }
  return windows.sort((left, right) => left.start - right.start);
}

function findGap(intervals, start, end, duration) {
  let cursor = start;
  for (const interval of intervals.sort((left, right) => left.start - right.start)) {
    if (interval.end <= cursor || interval.start >= end) continue;
    if (interval.start - cursor >= duration) return cursor;
    cursor = Math.max(cursor, interval.end);
    if (cursor + duration > end) return null;
  }
  return cursor + duration <= end ? cursor : null;
}

function findPlacement({ machines, usage, earliest, due, duration, mode, periodStart, periodEnd, preset }) {
  let best = null;
  const firstDay = Math.max(0, Math.floor(earliest / DAY_MINUTES));
  const lastDay = Math.min(dayIndex(periodStart, periodEnd), Math.floor(due / DAY_MINUTES));
  for (let day = firstDay; day <= lastDay; day += 1) {
    for (const machine of machines) {
      const intervals = usage.get(machine.id) || [];
      for (const window of shiftWindows(machine, day, mode, preset, periodStart)) {
        const start = Math.max(earliest, window.start);
        const end = Math.min(due, window.end);
        if (end - start + EPSILON < duration) continue;
        const slotStart = findGap(intervals, start, end, duration);
        if (slotStart == null) continue;
        const candidate = { machine, start: slotStart, end: slotStart + duration, shift: window.shift, overtime: window.overtime };
        if (!best || candidate.end < best.end || (candidate.end === best.end && machine.machineCode.localeCompare(best.machine.machineCode) < 0)) best = candidate;
      }
    }
    if (best && best.end < (day + 1) * DAY_MINUTES) break;
  }
  return best;
}

function occupy(usage, machineId, allocation) {
  const intervals = usage.get(machineId) || [];
  intervals.push({ start: allocation.start, end: allocation.end });
  usage.set(machineId, intervals);
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

function phaseJobs(plan, details, deliveryPhases) {
  const receipts = details.filter((detail) => !isGeneratedProcess(detail));
  const groups = receipts.map((receipt) => {
    const related = details.filter((detail) => detail.id === receipt.id || sourceMpsDetailId(detail) === receipt.mpsDetailId);
    const phases = deliveryPhases.filter((phase) => phase.mpsDetailId === receipt.mpsDetailId);
    const jobs = phases.length ? phases.map((phase) => ({
      id: phase.id, phaseNumber: phase.phaseNumber, due: phase.plannedDate, qty: number(phase.qtyPlanned),
      targetType: phase.targetType, targetCode: phase.targetCode,
    })) : [{ id: null, phaseNumber: null, due: receipt.requiredDate || plan.periodEnd, qty: number(receipt.qtyPlanned), targetType: "CUSTOMER", targetCode: null, configurationError: "DELIVERY_PHASE_REQUIRED" }];
    const covered = phases.reduce((sum, phase) => sum + number(phase.qtyPlanned), 0);
    if (phases.length && covered + EPSILON < number(receipt.qtyPlanned)) jobs.push({ id: null, phaseNumber: null, due: receipt.requiredDate || plan.periodEnd, qty: number(receipt.qtyPlanned) - covered, targetType: "CUSTOMER", targetCode: null, configurationError: "DELIVERY_PHASE_QTY_SHORT" });
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
  const preset = presetId ? await findPreset(prisma, presetId) : null;
  const plan = await prisma.monthlyProductionPlan.findFirst({
    where: { planNumber, isDeleted: false },
    include: { details: { where: { isDeleted: false, status: { not: "Cancelled" } }, orderBy: { lineNumber: "asc" } } },
  });
  if (!plan) { const error = new Error("Monthly Production Plan tidak ditemukan."); error.statusCode = 404; throw error; }
  const mpsNumber = String(plan.sourceType || "").startsWith("MPS:") ? String(plan.sourceType).slice(4) : null;
  const [machines, headers, bomDetails, allRoutes, phases, existing] = await Promise.all([
    prisma.machine.findMany({ where: { isDeleted: false, status: "Active" }, orderBy: { machineCode: "asc" } }),
    prisma.mBOMHeader.findMany({ where: { isDeleted: false }, orderBy: [{ partId: "asc" }, { revision: "desc" }, { updatedAt: "desc" }], select: { noReg: true, partId: true } }),
    prisma.mBOMDetail.findMany({ where: { isDeleted: false }, select: { id: true, noReg: true, partId: true, parentDetailId: true } }),
    prisma.mBOMProcess.findMany({ where: { isDeleted: false }, include: { machine: true, vendor: true, process: true, mbomDetail: { include: { part: true, parentDetail: { include: { part: true } } } } } }),
    mpsNumber ? prisma.mPSDeliveryPlan.findMany({ where: { mpsNumber, targetType: "CUSTOMER", isDeleted: false, status: { not: "Cancelled" } }, orderBy: [{ plannedDate: "asc" }, { phaseNumber: "asc" }] }) : [],
    prisma.productionPlanAllocation.findMany({ where: { planId: plan.id, isDeleted: false, status: { in: ["Draft", "Published"] }, planningMode, ...(planningMode === "SIMULATION" ? { scenarioKey } : {}) } }),
  ]);
  const latest = new Map();
  headers.forEach((header) => { if (header.partId && !latest.has(header.partId)) latest.set(header.partId, header.noReg); });
  const noRegs = new Set(latest.values());
  return { plan, machines, headers: headers.filter((header) => noRegs.has(header.noReg)), bomDetails: bomDetails.filter((detail) => noRegs.has(detail.noReg)), routes: allRoutes.filter((route) => noRegs.has(route.noReg)), phases, existing, planningMode, scenarioKey, presetId, preset };
}

async function recommendMonthlyCapacity(prisma, planNumber, options = {}) {
  const context = await loadContext(prisma, planNumber, options);
  const { plan, machines, headers, bomDetails, routes, phases, existing, planningMode, scenarioKey, presetId, preset } = context;
  const allowedStatuses = planningMode === "SIMULATION" ? ["Draft", "Confirmed", "Released", "In Progress"] : ["Draft", "Confirmed", ...(plan.replanRequired ? ["Released", "In Progress"] : [])];
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
  // A calendar day that has passed is execution history. Treat historical
  // auto-allocation as firm input so re-running either Simulation or
  // Production never replaces it or schedules new work in the past.
  const today = jakartaToday();
  const executionFloor = Math.max(0, absoluteMinute(plan.periodStart, today, 0));
  const manual = existing.filter((row) => row.allocationSource !== "AUTO_RECOMMENDATION" || dateOnly(row.scheduleDate) < today);
  for (const row of manual) {
    if (!row.machineId) continue;
    const day = dayIndex(plan.periodStart, row.scheduleDate);
    const start = day * DAY_MINUTES + minuteOfDay(row.plannedStartTime, row.shift === "2" ? 960 : row.shift === "3" ? 0 : 480);
    const end = day * DAY_MINUTES + minuteOfDay(row.plannedEndTime, row.shift === "2" ? 1440 : row.shift === "3" ? 480 : 960);
    occupy(usage, row.machineId, { start, end: end <= start ? end + DAY_MINUTES : end });
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
    if (job.configurationError) {
      blockers.push({
        phaseId: null, phaseNumber: null, dueDate: dateKey(job.due), partCode: job.group.receipt.partCode,
        code: job.configurationError, qty: round(job.qty),
        message: job.configurationError === "DELIVERY_PHASE_REQUIRED"
          ? "Delivery Schedule MPS belum dibuat; sistem tidak membuat phase otomatis."
          : "Total qty Delivery Schedule MPS belum menutup qty MPS; lengkapi sisa qty phase.",
      });
      phaseResults.push({ phaseId: null, phaseNumber: null, dueDate: dateKey(job.due), qty: round(job.qty), status: "BLOCKED", blocker: job.configurationError });
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
    const due = absoluteMinute(plan.periodStart, job.due, DAY_MINUTES);
    for (const mode of modes) {
      const trialUsage = cloneUsage(usage);
      const trialManualByRoute = new Map(manualByRoute);
      const allocations = [];
      let failed = null;
      const batches = splitTransferBatches(job.qty, options.transferBatchQty);
      for (let batchIndex = 0; batchIndex < batches.length && !failed; batchIndex += 1) {
        const completionByRoute = new Map();
        const allocationIndexByRoute = new Map();
        for (const task of graph.ordered) {
          const route = task.route;
          const predecessorRouteIds = [...(graph.predecessors.get(route.id) || [])];
          const predecessorEnd = Math.max(executionFloor, ...predecessorRouteIds.map((id) => number(completionByRoute.get(id))));
          const predecessorDraftIndexes = predecessorRouteIds.map((id) => allocationIndexByRoute.get(id)).filter((value) => value != null);
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
           const cycle = Math.min(...eligible.map((machine) => effectiveCycleMinutes(route, machine, preset?.efficiency || 85)).filter((value) => value > 0));
          if (!Number.isFinite(cycle) || cycle <= 0) { failed = { code: "CYCLE_TIME_MISSING", route, qty, specificationCode: spec }; break; }
          const candidateMachines = mode === "NORMAL" ? eligible.slice(0, 1) : eligible;
           const placement = findPlacement({ machines: candidateMachines, usage: trialUsage, earliest: predecessorEnd, due, duration: Math.max(qty * cycle, 1), mode, periodStart: plan.periodStart, periodEnd: plan.periodEnd, preset });
          if (!placement) { failed = { code: "CAPACITY_BEFORE_DUE_UNAVAILABLE", route, qty, specificationCode: spec }; break; }
          occupy(trialUsage, placement.machine.id, placement);
          allocations.push({ task, qty, ...placement, predecessorDraftIndexes, batchNumber: batchIndex + 1 });
          allocationIndexByRoute.set(route.id, allocations.length - 1);
          completionByRoute.set(route.id, placement.end);
        }
      }
      if (!failed) { attempt = { mode, usage: trialUsage, allocations, manualByRoute: trialManualByRoute }; break; }
      attempt = { mode, usage: trialUsage, allocations, failed };
    }
    if (attempt.failed) {
      blockers.push({ phaseId: job.id, phaseNumber: job.phaseNumber, dueDate: dateKey(job.due), partCode: job.group.receipt.partCode, code: attempt.failed.code, processCode: attempt.failed.route?.process?.processCode || null, machineSpecificationCode: attempt.failed.specificationCode || null, qty: round(attempt.failed.qty) });
      phaseResults.push({ phaseId: job.id, phaseNumber: job.phaseNumber, dueDate: dateKey(job.due), qty: round(job.qty), status: "BLOCKED", blocker: attempt.failed.code });
      continue;
    }
    const lanesBySpecification = new Map();
    for (const row of attempt.allocations.filter((item) => item.machine)) {
      const spec = specificationCode(row.task.route) || row.task.route.id;
      if (!lanesBySpecification.has(spec)) lanesBySpecification.set(spec, new Set());
      lanesBySpecification.get(spec).add(row.machine.id);
    }
    const laneCount = Math.max(1, ...[...lanesBySpecification.values()].map((ids) => ids.size));
    const capacityMode = attempt.mode === "OVERTIME" ? "OVERTIME" : attempt.mode === "THREE_SHIFT" || attempt.mode === "TWO_SHIFT" ? "EXTRA_SHIFT" : laneCount > 1 ? "PARALLEL_LANE" : "NORMAL";
    const generatedBaseIndex = generated.length;
    for (const draft of attempt.allocations) {
      const predecessorToken = (draft.predecessorDraftIndexes || []).map((index) => generatedBaseIndex + index);
      generated.push({ ...draft, phase: job, mode: attempt.mode, capacityMode, predecessorToken });
    }
    for (const [key, value] of attempt.usage) usage.set(key, value);
    manualByRoute = attempt.manualByRoute;
    cumulativeQty.set(groupKey, number(cumulativeQty.get(groupKey)) + job.qty);
    phaseResults.push({ phaseId: job.id, phaseNumber: job.phaseNumber, dueDate: dateKey(job.due), qty: round(job.qty), cumulativeQty: round(cumulativeQty.get(groupKey)), status: "COVERED", capacityMode, laneCount });
  }

  const persisted = [];
  if (options.persist !== false) {
    await prisma.$transaction(async (tx) => {
      await tx.productionPlanAllocation.updateMany({ where: { planId: plan.id, allocationSource: "AUTO_RECOMMENDATION", planningMode, ...(planningMode === "SIMULATION" ? { scenarioKey } : {}), scheduleDate: { gte: today }, isDeleted: false, status: "Draft" }, data: { isDeleted: true, status: "Cancelled" } });
      const createdIds = [];
      for (let index = 0; index < generated.length; index += 1) {
        const item = generated[index];
        const route = item.task.route;
        const scheduleDate = dateFromAbsolute(plan.periodStart, item.start);
        const predecessorIds = item.predecessorToken.map((token) => createdIds[token]).filter(Boolean);
        const uomCode = item.task.detail.uomCode || null;
        const plannedQty = normalizeQuantity(round(item.qty), uomCode);
        const created = await tx.productionPlanAllocation.create({ data: {
          planId: plan.id, lineNumber: item.task.detail.lineNumber, mbomProcessId: route.id, scheduleDate,
          shift: item.shift, plannedStartTime: timeText(item.start), plannedEndTime: timeText(item.end),
          machineId: item.machine?.id || null, routingMode: routeMode(route), vendorId: routeMode(route) === "VENDOR" ? route.vendorId : null,
          vendorSendDate: routeMode(route) === "VENDOR" ? scheduleDate : null,
          vendorReturnDate: routeMode(route) === "VENDOR" ? dateFromAbsolute(plan.periodStart, item.end) : null,
          vendorLeadTimeDays: routeMode(route) === "VENDOR" ? Math.ceil(leadMinutes(route) / DAY_MINUTES) : null,
          expectedReturnQty: routeMode(route) === "VENDOR" ? plannedQty : null,
          plannedQty, uomCode, status: "Draft",
          notes: `[AUTO-RECOMMENDATION:${VERSION}] Delivery phase ${item.phase.phaseNumber}; transfer batch ${item.batchNumber}`,
          allocationSource: "AUTO_RECOMMENDATION", planningMode, scenarioKey, recommendationReason: `Due ${dateKey(item.phase.due)}; ${item.capacityMode}; predecessor selesai ${timeText(item.start)}`,
          capacityMode: item.capacityMode, deliveryPhaseId: item.phase.id, deliveryPhaseNumber: item.phase.phaseNumber,
          transferBatchNumber: item.batchNumber, predecessorAllocationIds: predecessorIds, createdBy: options.actor || "system",
        } });
        createdIds.push(created.id); persisted.push(created);
      }
      const expandedDays = new Map();
      for (const item of generated.filter((row) => row.machine && (row.mode !== "NORMAL" || row.overtime))) {
        const scheduleDate = dateFromAbsolute(plan.periodStart, item.start);
        const key = `${item.machine.id}|${dateKey(scheduleDate)}`;
        const shiftsPerDay = item.mode === "TWO_SHIFT" ? 2 : item.mode === "NORMAL" ? 1 : 3;
        const current = expandedDays.get(key) || { machineId: item.machine.id, scheduleDate, shiftsPerDay: 1, overtime: false, overtimeStart: null, overtimeEnd: null };
        current.shiftsPerDay = Math.max(current.shiftsPerDay, shiftsPerDay);
        current.overtime = current.overtime || item.overtime;
        if (item.overtime) {
          current.overtimeStart = current.overtimeStart == null ? item.start : Math.min(current.overtimeStart, item.start);
          current.overtimeEnd = current.overtimeEnd == null ? item.end : Math.max(current.overtimeEnd, item.end);
        }
        expandedDays.set(key, current);
      }
      for (const day of planningMode === "PRODUCTION" ? expandedDays.values() : []) {
        const current = await tx.capacityDayOverride.findFirst({ where: { planId: plan.id, machineId: day.machineId, scheduleDate: day.scheduleDate } });
        const data = {
          dayStatus: "OVERLOAD", shiftsPerDay: day.shiftsPerDay,
          overtimeStart: day.overtime ? timeText(day.overtimeStart) : null, overtimeEnd: day.overtime ? timeText(day.overtimeEnd) : null,
          reason: `[AUTO-CAPACITY-RECOMMENDATION] Escalation untuk delivery phase`, changedBy: options.actor || "system", changedAt: new Date(), isDeleted: false,
        };
        if (current) await tx.capacityDayOverride.update({ where: { id: current.id }, data });
        else await tx.capacityDayOverride.create({ data: { planId: plan.id, machineId: day.machineId, scheduleDate: day.scheduleDate, ...data } });
      }
      const summary = { version: VERSION, allocationCount: persisted.length, phaseCount: phaseResults.length, coveredPhaseCount: phaseResults.filter((row) => row.status === "COVERED").length, blockerCount: blockers.length, phaseResults, blockers };
      if (planningMode === "PRODUCTION") await tx.monthlyProductionPlan.update({ where: { id: plan.id }, data: { recommendationGeneratedAt: new Date(), recommendationVersion: VERSION, recommendationSummary: summary } });
    });
  }
  return { planNumber, planningMode, scenarioKey, presetId, presetName: preset?.name || null, version: VERSION, allocationCount: options.persist === false ? generated.length : persisted.length, phaseResults, blockers, ready: blockers.length === 0 };
}

module.exports = { recommendMonthlyCapacity, generatedBatchQuantity, VERSION };
