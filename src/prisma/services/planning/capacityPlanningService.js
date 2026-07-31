const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_PLAN_STATUSES = ["Draft", "Confirmed", "Released", "In Progress"];
const ACTIVE_SCHEDULE_STATUSES = ["Draft", "Released", "In Progress", "Completed"];
const { getFormulaSet, evaluateFromSet } = require("../masterFormulaService");
const {
  canonicalizeRoutingOperations,
  compareRoutingOperations,
} = require("../../utils/routingSequence");

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value, digits = 2) => Number(number(value).toFixed(digits));
const bool = (value, fallback = false) => value === undefined || value === null || value === "" ? fallback : ![false, 0, "0", "false", "no", "off"].includes(typeof value === "string" ? value.trim().toLowerCase() : value);

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
  return Math.max(endMinutes - startMinutes, 0);
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
    ? Math.min(Math.max(number(override.shiftsPerDay) || defaultShiftsPerDay, 1), 3)
    : defaultShiftsPerDay;
  // A saved machine-date rule replaces the scenario overtime. An empty
  // overtime range therefore explicitly means zero overtime for that date.
  const dailyOvertimeMinutes = hasOverride
    ? overtimeMinutes(override.overtimeStart, override.overtimeEnd)
    : defaultOvertimeHours * 60;
  const isClosed = dayStatus === "HOLIDAY" || weekendClosed;
  const availableMinutes = isClosed
    ? 0
    : round(evaluateFromSet(formulas, "CAPACITY_BASE_MINUTES", {
      shiftHours,
      shiftsPerDay,
      overtimeMinutes: dailyOvertimeMinutes,
      efficiencyPercent,
    }), 2);

  return {
    source: hasOverride ? "DAILY_OVERRIDE" : "SCENARIO_DEFAULT",
    dayStatus: isClosed ? "HOLIDAY" : dayStatus === "OVERLOAD" ? "OVERLOAD" : "WORKING",
    shiftsPerDay,
    shiftHours,
    overtimeMinutes: dailyOvertimeMinutes,
    efficiencyPercent,
    availableMinutes,
  };
}

function pushIssue(target, issue, seen) {
  const key = [issue.code, issue.planNumber, issue.lineNumber, issue.partCode, issue.processCode, issue.routeId, issue.machineCode].join("|");
  if (seen.has(key)) return;
  seen.add(key);
  target.push(issue);
}

async function buildCapacitySnapshot(prisma, query = {}) {
  const formulas = await getFormulaSet(prisma, "capacity");
  const range = resolveRange(query);
  const shiftHours = Math.min(Math.max(number(query.shiftHours) || 8, 1), 24);
  const shiftsPerDay = Math.min(Math.max(number(query.shiftsPerDay) || 1, 1), 3);
  const efficiencyPercent = Math.min(Math.max(number(query.efficiencyPercent) || 85, 1), 100);
  const overtimeHours = Math.min(Math.max(number(query.overtimeHours), 0), 12);
  const includeSaturday = bool(query.includeSaturday, false);
  const includeSunday = bool(query.includeSunday, false);
  const scenarioName = String(query.scenarioName || "Current").trim().slice(0, 100) || "Current";
  const workingAvailableMinutes = round(evaluateFromSet(formulas, "CAPACITY_BASE_MINUTES", {
    shiftHours,
    shiftsPerDay,
    overtimeMinutes: overtimeHours * 60,
    efficiencyPercent,
  }), 2);
  const planNumber = String(query.planNumber || "").trim() || null;
  const manualAllocation = bool(query.manualAllocation, false);
  const ignoreDraftDailyPlans = bool(query.ignoreDraftDailyPlans, false);
  const generatedDailyPlanMarker = planNumber ? `[PPIC-DPP:${planNumber}:` : null;

  const [machines, processes, headers, routes, schedules, downtimes, productionLogs, planDetails, machineOverrides, dayOverrides, calendarOverrides] = await Promise.all([
    prisma.machine.findMany({
      where: { isDeleted: false },
      orderBy: [{ lineCode: "asc" }, { machineCode: "asc" }],
      select: { id: true, machineCode: true, machineName: true, machineType: true, lineCode: true, location: true, status: true, capacity: true, capacityUnit: true, cycleTime: true },
    }),
    prisma.process.findMany({ where: { isDeleted: false }, orderBy: { processCode: "asc" }, select: { id: true, processCode: true, processName: true } }),
    prisma.mBOMHeader.findMany({ where: { isDeleted: false }, orderBy: [{ partId: "asc" }, { revision: "desc" }, { updatedAt: "desc" }], select: { noReg: true, partId: true, revision: true } }),
    prisma.mBOMProcess.findMany({
      where: { isDeleted: false },
      include: {
        process: { select: { id: true, processCode: true, processName: true } },
        machine: { select: { id: true, machineCode: true, machineName: true, status: true, capacity: true, capacityUnit: true, cycleTime: true } },
        mbomDetail: {
          select: {
            partId: true,
            part: { select: { partCode: true, partName: true, itemType: true, partType: true } },
            parentDetail: { select: { partId: true, part: { select: { partCode: true, partName: true, itemType: true, partType: true } } } },
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
      select: { id: true, scheduleNumber: true, scheduleDate: true, shift: true, moId: true, moNumber: true, woId: true, woNumber: true, partCode: true, processId: true, machineId: true, plannedQty: true, actualQty: true, uomCode: true, sequence: true, status: true },
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
      include: { plan: { select: { planNumber: true, status: true, sourceType: true, periodStart: true, periodEnd: true } } },
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
    prisma.capacityDayOverride.findMany({ where: { isDeleted: false, plan: planNumber ? { isDeleted: false, planNumber } : { planNumber: "__NO_PLAN_OVERRIDE__" }, scheduleDate: { gte: range.start, lt: range.endExclusive } }, select: { machineId: true, scheduleDate: true, dayStatus: true, shiftsPerDay: true, overtimeStart: true, overtimeEnd: true, reason: true, changedBy: true, changedAt: true } }),
    prisma.capacityCalendarOverride.findMany({ where: { isDeleted: false, scheduleDate: { gte: range.start, lt: range.endExclusive } }, select: { machineId: true, scheduleDate: true, dayStatus: true, shiftsPerDay: true, overtimeStart: true, overtimeEnd: true, reason: true, changedBy: true, changedAt: true } }),
  ]);

  const globalDayOverrideByMachineDate = new Map(calendarOverrides.map((item) => [`${item.machineId}|${dateKey(item.scheduleDate)}`, { ...item, scope: "GLOBAL" }]));
  const dayOverrideByMachineDate = new Map(dayOverrides.map((item) => [`${item.machineId}|${dateKey(item.scheduleDate)}`, { ...item, scope: "PLAN" }]));
  const [availableDies, availableVendors] = await Promise.all([
    prisma.dies.findMany({ where: { isDeleted: false, status: "Active" }, select: { id: true, diesCode: true, diesName: true, diesType: true }, orderBy: { diesCode: "asc" } }),
    prisma.vendor.findMany({ where: { isDeleted: false, status: "Active" }, select: { id: true, vendorCode: true, vendorName: true }, orderBy: { vendorCode: "asc" } }),
  ]);
  const capacityRuleForDate = (key, machineId) => resolveDailyCapacity({
    key,
    override: dayOverrideByMachineDate.get(`${machineId}|${key}`)
      || globalDayOverrideByMachineDate.get(`${machineId}|${key}`)
      || null,
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
  const machineById = new Map(machines.map((machine) => [machine.id, machine]));
  const machineByCode = new Map(machines.map((machine) => [machine.machineCode, machine]));
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

  const machineRows = machines.map((machine) => ({
    ...machine,
    defaultAvailableMinutes: machine.status === "Active" ? workingAvailableMinutes : 0,
    cells: Object.fromEntries(range.dates.map((key) => {
      const capacityRule = capacityRuleForDate(key, machine.id);
      const cell = machineCell(machine, key, capacityRule.availableMinutes);
      cell.dayOverride = dayOverrideByMachineDate.get(`${machine.id}|${key}`)
        || globalDayOverrideByMachineDate.get(`${machine.id}|${key}`)
        || null;
      cell.capacityRule = capacityRule;
      return [key, cell];
    })),
  }));
  const rowByMachineId = new Map(machineRows.map((machine) => [machine.id, machine]));
  const rowByMachineCode = new Map(machineRows.map((machine) => [machine.machineCode, machine]));
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
    select: { id: true, partCode: true, partName: true, partNumber: true, itemType: true, partType: true },
  }) : [];
  const planPartById = new Map(planParts.map((part) => [part.id, part]));
  const planPartByCode = new Map(planParts.map((part) => [part.partCode, part]));

  const planNumbers = [...new Set(planDetails.map((detail) => detail.plan.planNumber).filter(Boolean))];
  const sourceMpsNumbers = [...new Set(planDetails
    .map((detail) => String(detail.plan.sourceType || "").startsWith("MPS:") ? String(detail.plan.sourceType).slice(4) : null)
    .filter(Boolean))];
  const deliveryPhases = sourceMpsNumbers.length && typeof prisma.mPSDeliveryPlan?.findMany === "function"
    ? await prisma.mPSDeliveryPlan.findMany({
      where: { mpsNumber: { in: sourceMpsNumbers }, isDeleted: false, status: { not: "Cancelled" } },
      orderBy: [{ plannedDate: "asc" }, { phaseNumber: "asc" }],
    })
    : [];
  const productionPlanAllocations = planNumbers.length && typeof prisma.productionPlanAllocation?.findMany === "function"
    ? await prisma.productionPlanAllocation.findMany({
      where: {
        isDeleted: false,
        status: { in: ["Draft", "Published"] },
        plan: { planNumber: { in: planNumbers }, isDeleted: false },
      },
      select: {
        id: true,
        lineNumber: true,
        mbomProcessId: true,
        scheduleDate: true,
        shift: true,
        machineId: true,
        routingMode: true,
        vendorId: true,
        plannedQty: true,
        uomCode: true,
        status: true,
        notes: true,
        plan: { select: { planNumber: true, status: true } },
        mbomProcess: {
          select: {
            id: true,
            processId: true,
            sequence: true,
            cycleTime: true,
            process: { select: { processCode: true, processName: true } },
          },
        },
      },
      orderBy: [{ scheduleDate: "asc" }, { lineNumber: "asc" }, { createdAt: "asc" }],
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
  const capacityPlanDetails = [...planDetails].sort((left, right) => {
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
    const hasRoutingCycle = activeRoutes.some((route) => route.machineId === machine.id && number(route.cycleTime) > 0);
    // A route-level cycle time is a valid fallback for capacity planning. Do
    // not raise a false machine-rate warning when the machine itself has no
    // default but every active route supplies its own cycle time.
    if (number(machine.capacity) <= 0 && number(machine.cycleTime) <= 0 && !hasRoutingCycle && activeRoutes.some((route) => route.machineId === machine.id)) {
      pushIssue(issues, { severity: "warning", code: "MACHINE_RATE_MISSING", machineCode: machine.machineCode, message: `${machine.machineCode} belum memiliki capacity atau cycle time master maupun routing.` }, issueKeys);
    }
  }

  for (const route of activeRoutes) {
    const partCode = route.mbomDetail?.part?.partCode || null;
    if (!route.machineId) pushIssue(issues, { severity: "warning", code: "ROUTING_MACHINE_MISSING", routeId: route.id, partCode, message: `${partCode || route.noReg} · ${route.process?.processCode || "Process"} belum mempunyai mesin pada routing.` }, issueKeys);
    if (resolveCycleMinutes(route.cycleTime, route.machine, workingAvailableMinutes) <= 0) pushIssue(issues, { severity: "warning", code: "ROUTING_CYCLE_MISSING", routeId: route.id, partCode, machineCode: route.machine?.machineCode || null, message: `${partCode || route.noReg} · ${route.process?.processCode || "Process"} belum mempunyai cycle time.` }, issueKeys);
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
    select: { id: true, cycleTime: true, outputPartCode: true, processId: true, machineId: true, process: { select: { processCode: true, processName: true } } },
  }) : [];
  const workOrderById = new Map(workOrders.map((row) => [row.id, row]));

  for (const schedule of schedules) {
    const machine = machineById.get(schedule.machineId);
    const row = rowByMachineId.get(schedule.machineId);
    const cell = row?.cells[dateKey(schedule.scheduleDate)];
    const wo = workOrderById.get(schedule.woId);
    const planMo = planMoById.get(schedule.moId) || planMoByNumber.get(schedule.moNumber);
    const scheduledProcessId = schedule.processId || wo?.processId || null;
    if (planMo?.monthlyProductionPlanNumber && planMo.monthlyProductionPlanLineNumber != null && scheduledProcessId) {
      const planProcessKey = `${planMo.monthlyProductionPlanNumber}|${planMo.monthlyProductionPlanLineNumber}|${scheduledProcessId}`;
      scheduledQtyByPlanProcess.set(planProcessKey, number(scheduledQtyByPlanProcess.get(planProcessKey)) + number(schedule.plannedQty));
    }
    const cycleMinutes = resolveCycleMinutes(wo?.cycleTime, machine, workingAvailableMinutes);
    const loadMinutes = evaluateFromSet(formulas, "LOAD_MINUTES", {
      qty: number(schedule.plannedQty),
      cycleTimeMinutes: cycleMinutes,
      efficiencyPercent: 100,
    });
    if (!cell || cycleMinutes <= 0) {
      unscheduled.push({ source: "FIRM", reference: schedule.scheduleNumber, partCode: schedule.partCode, processCode: wo?.process?.processCode || processById.get(schedule.processId)?.processCode || null, machineCode: machine?.machineCode || null, qty: number(schedule.plannedQty), minutes: round(loadMinutes), reason: !machine ? "Mesin belum ditentukan" : "Cycle time belum tersedia" });
      continue;
    }
    cell.firmMinutes += loadMinutes;
    cell.actualMinutes += evaluateFromSet(formulas, "LOAD_MINUTES", {
      qty: number(schedule.actualQty),
      cycleTimeMinutes: cycleMinutes,
      efficiencyPercent: 100,
    });
    cell.items.push({ source: "FIRM", reference: schedule.scheduleNumber, planNumber: planMo?.monthlyProductionPlanNumber || null, lineNumber: planMo?.monthlyProductionPlanLineNumber || null, processId: scheduledProcessId, moNumber: schedule.moNumber, woNumber: schedule.woNumber, partCode: schedule.partCode, processCode: wo?.process?.processCode || processById.get(schedule.processId)?.processCode || null, shift: schedule.shift, qty: number(schedule.plannedQty), uomCode: schedule.uomCode, minutes: round(loadMinutes), status: schedule.status });
  }

  // Draft MPP allocations are the PPIC planning source before MO/WO exists.
  // Published rows are represented by their Daily Production Schedule and must
  // not be counted twice.
  for (const allocation of productionPlanAllocations.filter((item) => item.status === "Draft")) {
    const allocationDetail = planDetails.find((detail) =>
      detail.plan.planNumber === allocation.plan.planNumber
      && number(detail.lineNumber) === number(allocation.lineNumber));
    const processId = allocation.mbomProcess?.processId || null;
    const planProcessKey = `${allocation.plan.planNumber}|${allocation.lineNumber}|${processId}`;
    if (processId) {
      scheduledQtyByPlanProcess.set(
        planProcessKey,
        number(scheduledQtyByPlanProcess.get(planProcessKey)) + number(allocation.plannedQty),
      );
    }
    if (String(allocation.routingMode || "INHOUSE").toUpperCase() === "VENDOR") {
      vendorAssignments.push({
        source: "MANUAL",
        allocationId: allocation.id,
        planNumber: allocation.plan.planNumber,
        lineNumber: allocation.lineNumber,
        scheduleDate: dateKey(allocation.scheduleDate),
        partCode: allocationDetail?.partCode || null,
        processCode: allocation.mbomProcess?.process?.processCode || null,
        processName: allocation.mbomProcess?.process?.processName || null,
        mbomProcessId: allocation.mbomProcessId,
        vendorId: allocation.vendorId,
        qty: number(allocation.plannedQty),
        uomCode: allocation.uomCode,
        status: allocation.status,
        reason: allocation.notes,
      });
      continue;
    }
    const machine = machineById.get(allocation.machineId);
    const cell = rowByMachineId.get(allocation.machineId)?.cells[dateKey(allocation.scheduleDate)];
    const cycleMinutes = resolveCycleMinutes(allocation.mbomProcess?.cycleTime, machine, workingAvailableMinutes);
    const loadMinutes = evaluateFromSet(formulas, "LOAD_MINUTES", {
      qty: number(allocation.plannedQty),
      cycleTimeMinutes: cycleMinutes,
      efficiencyPercent: 100,
    });
    if (!machine || !cell || cycleMinutes <= 0) {
      unscheduled.push({
        source: "MANUAL",
        allocationId: allocation.id,
        reference: allocation.plan.planNumber,
        lineNumber: allocation.lineNumber,
        processCode: allocation.mbomProcess?.process?.processCode || null,
        machineCode: machine?.machineCode || null,
        qty: number(allocation.plannedQty),
        uomCode: allocation.uomCode,
        minutes: round(loadMinutes),
        reason: !machine ? "Mesin alokasi tidak tersedia" : !cell ? "Tanggal alokasi di luar horizon" : "Cycle time belum tersedia",
      });
      continue;
    }
    cell.proposedMinutes += loadMinutes;
    cell.items.push({
      source: "MANUAL",
      allocationId: allocation.id,
      reference: allocation.plan.planNumber,
      planNumber: allocation.plan.planNumber,
      lineNumber: allocation.lineNumber,
      partCode: allocationDetail?.partCode || null,
      processId,
      processCode: allocation.mbomProcess?.process?.processCode || null,
      processName: allocation.mbomProcess?.process?.processName || null,
      mbomProcessId: allocation.mbomProcessId,
      routingMode: "INHOUSE",
      shift: allocation.shift,
      qty: number(allocation.plannedQty),
      uomCode: allocation.uomCode,
      minutes: round(loadMinutes),
      status: allocation.status,
      notes: allocation.notes,
    });
  }

  for (const detail of capacityPlanDetails) {
    const plannedQty = Math.max(number(detail.qtyPlanned), 0);
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
      const planProcessKey = `${detail.plan.planNumber}|${detail.lineNumber}|${route.processId}`;
      const remainingQty = Math.max(plannedQty - number(scheduledQtyByPlanProcess.get(planProcessKey)), 0);
      if (remainingQty <= 0) continue;
      const routeOverridePrefix = `${detail.plan.planNumber}|${detail.lineNumber}|${route.id}|`;
      const machineOverrideEntry = [...machineOverrideByRouteDate.entries()].find(([key]) => key.startsWith(routeOverridePrefix));
      const machineOverride = machineOverrideEntry?.[1] || null;
      if (machineOverride?.routingMode === "VENDOR") {
        vendorAssignments.push({ source: "PROPOSED", planNumber: detail.plan.planNumber, lineNumber: detail.lineNumber, scheduleDate: dateKey(machineOverride.scheduleDate), partCode: detail.partCode, processCode: route.process?.processCode || null, mbomProcessId: route.id, vendorId: machineOverride.vendorId, diesId: machineOverride.diesId, qty: remainingQty, uomCode: detail.uomCode, status: detail.plan.status, reason: machineOverride.reason });
        routeStartDates.set(route.id, parseDateOnly(machineOverride.scheduleDate));
        continue;
      }
      const machine = machineById.get(machineOverride?.machineId || route.machineId);
      const alternativeMachines = (Array.isArray(route.alternativeMachineIds) ? route.alternativeMachineIds : []).filter((machineId) => machineId !== machine?.id).map((machineId) => machineById.get(machineId)).filter(Boolean);
      const cycleMinutes = resolveCycleMinutes(route.cycleTime, machine, workingAvailableMinutes);
      if (!machine) {
        pushIssue(issues, { severity: "blocking", code: "PLAN_MACHINE_MISSING", planNumber: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, partName: planPart?.partName || null, bomNumber: route.noReg || null, processCode: route.process?.processCode || null, processName: route.process?.processName || null, routeId: route.id, message: `${detail.partCode} · ${route.process?.processName || route.process?.processCode || "Process"} belum ditentukan mesinnya.` }, issueKeys);
        unscheduled.push({ source: "PROPOSED", reference: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, processCode: route.process?.processCode || null, mbomProcessId: route.id, qty: remainingQty, uomCode: detail.uomCode, minutes: round(evaluateFromSet(formulas, "LOAD_MINUTES", { qty: remainingQty, cycleTimeMinutes: cycleMinutes, efficiencyPercent: 100 })), reason: "Mesin routing belum tersedia", suggestedMachines: alternativeMachines.map((item) => ({ id: item.id, machineCode: item.machineCode, machineName: item.machineName })) });
        continue;
      }
      if (machine.status !== "Active") {
        pushIssue(issues, { severity: "blocking", code: "PLAN_MACHINE_INACTIVE", planNumber: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, partName: planPart?.partName || null, bomNumber: route.noReg || null, processCode: route.process?.processCode || null, processName: route.process?.processName || null, routeId: route.id, machineCode: machine.machineCode, machineName: machine.machineName || null, message: `${machine.machineName || machine.machineCode} tidak Active untuk ${detail.partCode}.` }, issueKeys);
      }
      if (cycleMinutes <= 0) {
        pushIssue(issues, { severity: "blocking", code: "PLAN_CYCLE_MISSING", planNumber: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, partName: planPart?.partName || null, bomNumber: route.noReg || null, processCode: route.process?.processCode || null, processName: route.process?.processName || null, routeId: route.id, machineCode: machine.machineCode, machineName: machine.machineName || null, message: `${detail.partCode} · ${route.process?.processName || route.process?.processCode || "Process"} belum memiliki cycle time.` }, issueKeys);
        unscheduled.push({ source: "PROPOSED", reference: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, processCode: route.process?.processCode || null, machineCode: machine.machineCode, qty: remainingQty, uomCode: detail.uomCode, minutes: 0, reason: "Cycle time belum tersedia" });
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
        const allocatedMinutes = Math.min(remainingMinutes, freeMinutes);
        if (allocatedMinutes > 0) {
          const allocatedQty = remainingQty * allocatedMinutes / (remainingQty * cycleMinutes);
          cell.proposedMinutes += allocatedMinutes;
          const allocatedDate = dateKey(cursor);
          if (!firstAllocatedDate || allocatedDate < firstAllocatedDate) firstAllocatedDate = allocatedDate;
          cell.items.push({ source: "PROPOSED", reference: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, processCode: route.process?.processCode || null, routingNumber: route.routingNumber, sequence: number(route.sourceSequence || route.sequence), routingSequence: number(route.sourceSequence || route.sequence), mbomProcessId: route.id, diesId: machineOverride?.diesId || route.diesId || null, routingMode: "INHOUSE", allowedMachineIds: [route.machineId, ...(Array.isArray(route.alternativeMachineIds) ? route.alternativeMachineIds : [])].filter(Boolean), machineOverride: machineOverride ? { machineId: machine.id, reason: machineOverride.reason } : null, qty: round(allocatedQty, 3), uomCode: detail.uomCode, minutes: round(allocatedMinutes), status: detail.plan.status });
          remainingMinutes -= allocatedMinutes;
        }
        cursor = addDays(cursor, -1);
      }
      if (firstAllocatedDate) routeStartDates.set(route.id, parseDateOnly(firstAllocatedDate));
      if (remainingMinutes > 0) {
        pushIssue(issues, { severity: "overridable", code: "PLAN_CAPACITY_SHORTAGE", planNumber: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, partName: planPart?.partName || null, bomNumber: route.noReg || null, processCode: route.process?.processCode || null, processName: route.process?.processName || null, routeId: route.id, machineCode: machine.machineCode, machineName: machine.machineName || null, message: `${machine.machineName || machine.machineCode} kekurangan ${round(remainingMinutes)} menit untuk ${detail.partCode}${planPart?.partName ? ` · ${planPart.partName}` : ""} dalam horizon.` }, issueKeys);
        unscheduled.push({ source: "PROPOSED", reference: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, processCode: route.process?.processCode || null, mbomProcessId: route.id, machineCode: machine.machineCode, qty: round(remainingMinutes / cycleMinutes, 3), uomCode: detail.uomCode, minutes: round(remainingMinutes), reason: "Kapasitas horizon tidak mencukupi", suggestedMachines: alternativeMachines.map((item) => ({ id: item.id, machineCode: item.machineCode, machineName: item.machineName })) });
      }
    }
  }

  const manualAllocationCatalog = [];
  for (const detail of capacityPlanDetails) {
    for (const route of canonicalizeRoutingOperations(routesForPlanDetail(detail)).sort(capacityRouteCompare)) {
      if (!route.processId) continue;
      const remainingQty = Math.max(number(detail.qtyPlanned) - number(scheduledQtyByPlanProcess.get(`${detail.plan.planNumber}|${detail.lineNumber}|${route.processId}`)), 0);
      if (remainingQty <= 0.000001) continue;
      const allowedMachineIds = [route.machineId, ...(Array.isArray(route.alternativeMachineIds) ? route.alternativeMachineIds : [])].filter(Boolean);
      manualAllocationCatalog.push({
        planNumber: detail.plan.planNumber,
        planStatus: detail.plan.status,
        lineNumber: detail.lineNumber,
        mpsDetailId: detail.mpsDetailId || null,
        partCode: detail.partCode,
        processId: route.processId,
        processCode: route.process?.processCode || null,
        processName: route.process?.processName || null,
        mbomProcessId: route.id,
        routingNumber: route.routingNumber || null,
        sequence: number(route.sourceSequence || route.sequence),
        routingMode: String(route.routingMode || "INHOUSE").toUpperCase(),
        allowedMachineIds,
        cycleMinutesByMachine: Object.fromEntries(allowedMachineIds.map((machineId) => [
          machineId,
          round(resolveCycleMinutes(route.cycleTime, machineById.get(machineId), workingAvailableMinutes), 6),
        ])),
        vendorId: route.vendorId || null,
        remainingQty: round(remainingQty, 3),
        uomCode: detail.uomCode || null,
        requiredDate: detail.requiredDate,
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
      message: `${task.partCode} · ${task.processName || task.processCode || `Seq ${task.sequence}`} masih perlu dialokasikan ${round(task.remainingQty, 3)} ${task.uomCode || ""} pada Capacity Check.`,
    }, issueKeys);
  }

  const deliveryCoverage = [];
  const detailByMpsDetailId = new Map(planDetails.filter((detail) => detail.mpsDetailId).map((detail) => [`${detail.plan.sourceType}|${detail.mpsDetailId}`, detail]));
  const cumulativeRequiredByDetail = new Map();
  for (const phase of deliveryPhases) {
    const directDetail = detailByMpsDetailId.get(`MPS:${phase.mpsNumber}|${phase.mpsDetailId}`);
    if (!directDetail) continue;
    const relatedDetails = [
      directDetail,
      ...planDetails.filter((candidate) =>
        candidate.plan.sourceType === `MPS:${phase.mpsNumber}`
        && String(candidate.notes || "").includes(`[MPS-SOURCE:${phase.mpsDetailId}]`)),
    ].filter((candidate, index, rows) => rows.findIndex((row) => row.id === candidate.id) === index);
    const routeTasksForCoverage = relatedDetails.flatMap((detail) =>
      canonicalizeRoutingOperations(routesForPlanDetail(detail)).map((route) => ({ detail, route })))
      .sort((left, right) => capacityRouteCompare(left.route, right.route));
    const finalTask = routeTasksForCoverage.at(-1);
    const detail = finalTask?.detail || directDetail;
    const finalRoute = finalTask?.route || null;
    const groupKey = `${directDetail.plan.planNumber}|${phase.mpsDetailId}`;
    const cumulativeRequiredQty = number(cumulativeRequiredByDetail.get(groupKey)) + number(phase.qtyPlanned);
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
    const draftQtyByDueDate = finalRoute?.id
      ? productionPlanAllocations.reduce((sum, allocation) => {
        if (allocation.status !== "Draft"
          || allocation.plan.planNumber !== detail.plan.planNumber
          || number(allocation.lineNumber) !== number(detail.lineNumber)
          || allocation.mbomProcessId !== finalRoute.id
          || parseDateOnly(allocation.scheduleDate) > parseDateOnly(phase.plannedDate)) return sum;
        return sum + number(allocation.plannedQty);
      }, 0)
      : 0;
    const plannedQtyByDueDate = firmQtyByDueDate + draftQtyByDueDate;
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
      phaseQty: number(phase.qtyPlanned),
      cumulativeRequiredQty: round(cumulativeRequiredQty, 3),
      plannedQtyByDueDate: round(plannedQtyByDueDate, 3),
      shortageQty: round(shortageQty, 3),
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
        message: `Delivery phase ${phase.phaseNumber} ${phase.partCode} pada ${dateKey(phase.plannedDate)} masih kurang ${round(shortageQty, 3)} ${phase.uomCode || detail.uomCode || ""}.`,
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
      if (vendorAssignments[index].source !== "MANUAL") vendorAssignments.splice(index, 1);
    }
    for (const row of machineRows) {
      for (const key of range.dates) {
        const cell = row.cells[key];
        cell.items = cell.items.filter((item) => item.source !== "PROPOSED");
        cell.proposedMinutes = cell.items
          .filter((item) => item.source === "MANUAL")
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
      if (cell.loadPercent > 100) overloadedCells += 1;
      totalAvailableMinutes += cell.availableMinutes;
      totalLoadMinutes += cell.loadMinutes;
      totalFirmMinutes += cell.firmMinutes;
      totalProposedMinutes += cell.proposedMinutes;
      totalDowntimeMinutes += cell.downtimeMinutes;
      totalActualMinutes += cell.actualMinutes;
      historyLogCount += cell.items.filter((item) => item.source === "HISTORY").length;
      for (const item of cell.items.filter((item) => ["FIRM", "PROPOSED", "MANUAL"].includes(item.source) && item.processCode)) {
        const processCode = item.processCode;
        const entry = processLoads.get(processCode) || { processCode, processName: processByCode.get(processCode)?.processName || null, firmMinutes: 0, proposedMinutes: 0, actualMinutes: 0, qty: 0, machineCodes: new Set() };
        entry[item.source === "FIRM" ? "firmMinutes" : "proposedMinutes"] += number(item.minutes);
        entry.qty += number(item.qty);
        entry.machineCodes.add(row.machineCode);
        processLoads.set(processCode, entry);
      }
    }
  }

  const blockingIssues = issues.filter((issue) => issue.severity === "blocking");
  const overridableIssues = issues.filter((issue) => issue.severity === "overridable");
  return {
    parameters: { startDate: dateKey(range.start), endDate: dateKey(range.end), shiftHours, shiftsPerDay, efficiencyPercent, overtimeHours, includeSaturday, includeSunday, scenarioName, availableMinutesPerMachineDay: workingAvailableMinutes, planNumber, manualAllocation },
    scenario: {
      scenarioName,
      shiftHours,
      shiftsPerDay,
      overtimeHours,
      efficiencyPercent,
      includeSaturday,
      includeSunday,
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
    deliveryCoverage: {
      ready: deliveryCoverage.every((phase) => phase.status === "COVERED"),
      blockingCount: deliveryCoverage.filter((phase) => phase.status === "BLOCKED").length,
      phases: deliveryCoverage,
    },
    fgReceipts,
    vendorAssignments,
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
      issues,
    },
  };
}

module.exports = { buildCapacitySnapshot, resolveRange, resolveDailyCapacity };
