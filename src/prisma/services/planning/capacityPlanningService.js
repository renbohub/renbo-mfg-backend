const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_PLAN_STATUSES = ["Draft", "Confirmed", "Released", "In Progress"];
const ACTIVE_SCHEDULE_STATUSES = ["Draft", "Released", "In Progress", "Completed"];
const { getFormulaSet, evaluateFromSet } = require("../masterFormulaService");
const { findPreset, presetCapacityQuery, shiftDurationMinutes } = require("./capacitySimulationPresetService");
const {
  canonicalizeRoutingOperations,
  compareRoutingOperations,
} = require("../../utils/routingSequence");
const { isDiscreteUom, normalizeQuantity } = require("../../utils/uomQuantity");

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value, digits = 2) => Number(number(value).toFixed(digits));
const capacityQty = (value, uomCode) => normalizeQuantity(round(value, 3), uomCode);
const capacityQtyText = (value, uomCode) => String(capacityQty(value, uomCode));
const bool = (value, fallback = false) => value === undefined || value === null || value === "" ? fallback : ![false, 0, "0", "false", "no", "off"].includes(typeof value === "string" ? value.trim().toLowerCase() : value);
const COVERAGE_EPSILON = 0.00001;

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

function allocationMoment(date, time, endOfDay = false) {
  const day = dateKey(date);
  const clock = /^\d{2}:\d{2}/.test(String(time || ""))
    ? String(time).slice(0, 5)
    : endOfDay ? "23:59" : "00:00";
  return new Date(`${day}T${clock}:00.000Z`);
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
    ? Math.min(Math.max(number(override.shiftsPerDay) || defaultShiftsPerDay, 1), 3)
    : defaultShiftsPerDay;
  // A saved machine-date rule replaces the scenario overtime. An empty
  // overtime range therefore explicitly means zero overtime for that date.
  const dailyOvertimeMinutes = hasOverride
    ? overtimeMinutes(override.overtimeStart, override.overtimeEnd)
    : defaultOvertimeHours * 60;
  const isClosed = dayStatus === "HOLIDAY" || weekendClosed;
  const effectiveShiftHours = hasOverride && number(override.shiftHours) > 0 ? number(override.shiftHours) : shiftHours;
  const availableMinutes = isClosed
    ? 0
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
    efficiencyPercent,
    availableMinutes,
  };
}

function pushIssue(target, issue, seen) {
  const key = [issue.code, issue.planNumber, issue.lineNumber, issue.partCode, issue.processCode, issue.routeId, issue.machineCode, issue.allocationId, issue.relatedAllocationId].join("|");
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
  const selectedPreset = presetId ? await findPreset(prisma, presetId) : null;
  const effectiveQuery = selectedPreset ? { ...query, ...presetCapacityQuery(selectedPreset) } : query;
  const formulas = await getFormulaSet(prisma, "capacity");
  const range = resolveRange(effectiveQuery);
  const shiftHours = Math.min(Math.max(number(effectiveQuery.shiftHours) || 8, 1), 24);
  const shiftsPerDay = Math.min(Math.max(number(effectiveQuery.shiftsPerDay) || 1, 1), 3);
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

  const [machines, processes, headers, routes, schedules, downtimes, productionLogs, planDetails, machineOverrides, dayOverrides, calendarOverrides] = await Promise.all([
    prisma.machine.findMany({
      where: { isDeleted: false },
      orderBy: [{ lineCode: "asc" }, { machineCode: "asc" }],
      select: { id: true, machineCode: true, machineName: true, machineType: true, machineFamily: true, machineTechnology: true, machineSpecificationCode: true, machineSpecificationName: true, lineCode: true, location: true, status: true, capacity: true, capacityUnit: true, tonnage: true, cycleTime: true },
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
  const presetDayOverrideByDate = new Map(Object.entries(selectedPreset?.dailyOverrides || {}).map(([date, rule]) => {
    const activeShifts = (rule.shifts || []).slice(0, rule.shiftCount || 0);
    const shiftHoursOverride = activeShifts.length ? activeShifts.reduce((sum, shift) => sum + shiftDurationMinutes(shift), 0) / activeShifts.length / 60 : shiftHours;
    return [date, { ...rule, shiftsPerDay: Math.max(rule.shiftCount || 1, 1), shiftHours: shiftHoursOverride, scope: "CAPACITY_PRESET" }];
  }));
  const [availableDies, availableVendors] = await Promise.all([
    prisma.dies.findMany({ where: { isDeleted: false, status: "Active" }, select: { id: true, diesCode: true, diesName: true, diesType: true }, orderBy: { diesCode: "asc" } }),
    prisma.vendor.findMany({ where: { isDeleted: false, status: "Active" }, select: { id: true, vendorCode: true, vendorName: true, leadTimeDays: true }, orderBy: { vendorCode: "asc" } }),
  ]);
  const capacityRuleForDate = (key, machineId) => resolveDailyCapacity({
    key,
    override: planningMode === "SIMULATION"
      ? presetDayOverrideByDate.get(key) || null
      : dayOverrideByMachineDate.get(`${machineId}|${key}`) || presetDayOverrideByDate.get(key) || globalDayOverrideByMachineDate.get(`${machineId}|${key}`) || null,
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
  const vendorById = new Map(availableVendors.map((vendor) => [vendor.id, vendor]));
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
      cell.dayOverride = planningMode === "SIMULATION"
        ? presetDayOverrideByDate.get(key) || null
        : dayOverrideByMachineDate.get(`${machine.id}|${key}`) || presetDayOverrideByDate.get(key) || globalDayOverrideByMachineDate.get(`${machine.id}|${key}`) || null;
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
        capacityMode: true,
        deliveryPhaseId: true,
        deliveryPhaseNumber: true,
        transferBatchNumber: true,
        predecessorAllocationIds: true,
        plan: { select: { planNumber: true, status: true } },
        mbomProcess: {
          select: {
            id: true,
            processId: true,
            sequence: true,
            cycleTime: true,
            machineSpecificationCode: true,
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

  const allocationById = new Map(productionPlanAllocations.map((row) => [row.id, row]));
  for (const allocation of productionPlanAllocations.filter((row) => row.status === "Draft")) {
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
    for (const predecessorId of predecessorIds) {
      const predecessor = allocationById.get(predecessorId);
      if (!predecessor || predecessor.plan.planNumber !== allocation.plan.planNumber) {
        pushIssue(issues, { ...common, relatedAllocationId: predecessorId, severity: "blocking", category: "SEQUENCE", code: "PLAN_PREDECESSOR_MISSING", message: `Predecessor allocation ${predecessorId} tidak ditemukan pada MPP yang sama.`, resolution: "Jalankan ulang recommendation atau perbaiki dependency allocation." }, issueKeys);
        continue;
      }
      const predecessorFinish = String(predecessor.routingMode || "INHOUSE").toUpperCase() === "VENDOR"
        ? allocationMoment(predecessor.vendorReturnDate || predecessor.scheduleDate, predecessor.plannedEndTime, true)
        : allocationMoment(predecessor.scheduleDate, predecessor.plannedEndTime, true);
      const successorStart = String(allocation.routingMode || "INHOUSE").toUpperCase() === "VENDOR"
        ? allocationMoment(allocation.vendorSendDate || allocation.scheduleDate, allocation.plannedStartTime, false)
        : allocationMoment(allocation.scheduleDate, allocation.plannedStartTime, false);
      if (predecessorFinish > successorStart) {
        pushIssue(issues, { ...common, relatedAllocationId: predecessorId, severity: "blocking", category: "SEQUENCE", code: "PLAN_PREDECESSOR_FINISH_AFTER_SUCCESSOR", message: `Proses sebelumnya selesai ${predecessorFinish.toISOString()} setelah proses berikutnya mulai ${successorStart.toISOString()}.`, resolution: "Majukan predecessor atau mundurkan successor; untuk hari yang sama isi jam mulai/selesai." }, issueKeys);
      }
      const predecessorOutput = String(predecessor.routingMode || "INHOUSE").toUpperCase() === "VENDOR"
        ? number(predecessor.expectedReturnQty ?? predecessor.plannedQty)
        : number(predecessor.plannedQty);
      const predecessorDetail = planDetails.find((row) => row.plan.planNumber === predecessor.plan.planNumber
        && number(row.lineNumber) === number(predecessor.lineNumber));
      const quantityStatus = predecessorQuantityStatus(
        predecessorOutput,
        predecessorDetail?.qtyPlanned,
        allocation.plannedQty,
        detail?.qtyPlanned,
        predecessor.uomCode,
        allocation.uomCode,
      );
      if (quantityStatus.short) {
        const message = quantityStatus.mode === "COVERAGE"
          ? `Coverage predecessor ${round(quantityStatus.predecessorCoverage * 100, 2)}% belum cukup untuk successor ${round(quantityStatus.successorCoverage * 100, 2)}%.`
          : `Output predecessor ${capacityQtyText(predecessorOutput, predecessor.uomCode)} belum cukup untuk successor ${capacityQtyText(allocation.plannedQty, allocation.uomCode)}.`;
        pushIssue(issues, { ...common, relatedAllocationId: predecessorId, severity: "blocking", category: "SEQUENCE", code: "PLAN_PREDECESSOR_QTY_SHORT", message, resolution: "Tambah coverage batch predecessor sebelum menjalankan successor." }, issueKeys);
      }
    }
  }

  const timedInhouse = productionPlanAllocations.filter((row) => row.status === "Draft"
    && String(row.routingMode || "INHOUSE").toUpperCase() === "INHOUSE"
    && row.machineId && row.plannedStartTime && row.plannedEndTime);
  for (let leftIndex = 0; leftIndex < timedInhouse.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < timedInhouse.length; rightIndex += 1) {
      const left = timedInhouse[leftIndex];
      const right = timedInhouse[rightIndex];
      if (left.machineId !== right.machineId || left.shift !== right.shift || dateKey(left.scheduleDate) !== dateKey(right.scheduleDate)) continue;
      const overlaps = allocationMoment(left.scheduleDate, left.plannedStartTime) < allocationMoment(right.scheduleDate, right.plannedEndTime)
        && allocationMoment(right.scheduleDate, right.plannedStartTime) < allocationMoment(left.scheduleDate, left.plannedEndTime);
      if (!overlaps) continue;
      const machine = machineById.get(left.machineId);
      pushIssue(issues, { severity: "blocking", category: "MACHINE", code: "PLAN_MACHINE_TIME_OVERLAP", planNumber: left.plan.planNumber, lineNumber: left.lineNumber, routeId: left.mbomProcessId, allocationId: left.id, relatedAllocationId: right.id, machineCode: machine?.machineCode || null, message: `${machine?.machineCode || "Mesin"} memiliki jadwal overlap pada ${dateKey(left.scheduleDate)} shift ${left.shift}.`, resolution: "Ubah jam, shift, lane, atau mesin salah satu allocation." }, issueKeys);
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
      const sendDate = allocation.vendorSendDate || allocation.scheduleDate;
      const returnDate = allocation.vendorReturnDate || allocation.scheduleDate;
      const plannedLeadTimeDays = Math.max(Math.ceil((parseDateOnly(returnDate) - parseDateOnly(sendDate)) / DAY_MS), 0);
      const requiredDate = allocationDetail?.requiredDate || allocationDetail?.plan?.periodEnd;
      const returnQty = number(allocation.expectedReturnQty ?? allocation.plannedQty);
      const isLate = requiredDate && parseDateOnly(returnDate) > parseDateOnly(requiredDate);
      const leadTimeShort = number(allocation.vendorLeadTimeDays ?? vendor?.leadTimeDays) > plannedLeadTimeDays;
      if (["Confirmed", "Released", "In Progress"].includes(allocation.plan.status) && isLate) {
        pushIssue(issues, {
          severity: "blocking",
          code: "VENDOR_RETURN_AFTER_REQUIRED_DATE",
          planNumber: allocation.plan.planNumber,
          lineNumber: allocation.lineNumber,
          partCode: allocationDetail?.partCode || null,
          processCode: allocation.mbomProcess?.process?.processCode || null,
          routeId: allocation.mbomProcessId,
          message: `${allocationDetail?.partCode || "Part"} · return vendor ${dateKey(returnDate)} melewati required date ${dateKey(requiredDate)}.`,
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
          processCode: allocation.mbomProcess?.process?.processCode || null,
          routeId: allocation.mbomProcessId,
          message: `Jadwal vendor ${plannedLeadTimeDays} hari lebih pendek dari Vendor Master ${number(allocation.vendorLeadTimeDays ?? vendor?.leadTimeDays)} hari.`,
          resolution: "Majukan tanggal kirim, mundurkan return yang realistis, atau gunakan vendor dengan lead time yang memenuhi due date.",
        }, issueKeys);
      }
      vendorAssignments.push({
        source: allocation.allocationSource === "AUTO_RECOMMENDATION" ? "RECOMMENDED" : "MANUAL",
        allocationId: allocation.id,
        planningMode: allocation.planningMode,
        scenarioKey: allocation.scenarioKey,
        planNumber: allocation.plan.planNumber,
        lineNumber: allocation.lineNumber,
        scheduleDate: dateKey(sendDate),
        sendDate: dateKey(sendDate),
        returnDate: dateKey(returnDate),
        requiredDate: requiredDate ? dateKey(requiredDate) : null,
        plannedLeadTimeDays,
        masterLeadTimeDays: number(allocation.vendorLeadTimeDays ?? vendor?.leadTimeDays),
        partCode: allocationDetail?.partCode || null,
        processCode: allocation.mbomProcess?.process?.processCode || null,
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
        processCode: allocation.mbomProcess?.process?.processCode || null,
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
      processCode: allocation.mbomProcess?.process?.processCode || null,
      processName: allocation.mbomProcess?.process?.processName || null,
      mbomProcessId: allocation.mbomProcessId,
      routingMode: "INHOUSE",
      machineId: allocation.machineId,
      scheduleDate: dateKey(allocation.scheduleDate),
      shift: allocation.shift,
      plannedStartTime: allocation.plannedStartTime,
      plannedEndTime: allocation.plannedEndTime,
      capacityMode: allocation.capacityMode,
      deliveryPhaseNumber: allocation.deliveryPhaseNumber,
      transferBatchNumber: allocation.transferBatchNumber,
      recommendationReason: allocation.recommendationReason,
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
      const planProcessKey = `${detail.plan.planNumber}|${detail.lineNumber}|${route.processId}`;
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
        const returnDate = parseDateOnly(detail.requiredDate || detail.plan.periodEnd);
        const sendDate = machineOverride?.scheduleDate
          ? parseDateOnly(machineOverride.scheduleDate)
          : addDays(returnDate, -Math.max(number(vendor?.leadTimeDays), 0));
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
          partCode: detail.partCode,
          processCode: route.process?.processCode || null,
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
        pushIssue(issues, { severity: "blocking", code: "PLAN_MACHINE_MISSING", planNumber: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, partName: planPart?.partName || null, bomNumber: route.noReg || null, processCode: route.process?.processCode || null, processName: route.process?.processName || null, routeId: route.id, message: `${detail.partCode} · ${route.process?.processName || route.process?.processCode || "Process"} belum ditentukan mesinnya.` }, issueKeys);
        unscheduled.push({ source: "PROPOSED", reference: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, processCode: route.process?.processCode || null, mbomProcessId: route.id, machineSpecificationCode: routeSpecificationCode(route), qty: remainingQty, uomCode: detail.uomCode, minutes: round(evaluateFromSet(formulas, "LOAD_MINUTES", { qty: remainingQty, cycleTimeMinutes: cycleMinutes, efficiencyPercent: 100 })), reason: "Tidak ada mesin aktif yang memenuhi Machine Specification", suggestedMachines: [] });
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
          cell.items.push({ source: "PROPOSED", reference: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, processCode: route.process?.processCode || null, routingNumber: route.routingNumber, sequence: number(route.sourceSequence || route.sequence), routingSequence: number(route.sourceSequence || route.sequence), mbomProcessId: route.id, diesId: machineOverride?.diesId || route.diesId || null, routingMode: "INHOUSE", machineSpecificationCode: routeSpecificationCode(route), allowedMachineIds: eligibleMachines.map((candidate) => candidate.id), machineOverride: machineOverride ? { machineId: machine.id, reason: machineOverride.reason } : null, qty: capacityQty(allocatedQty, detail.uomCode), uomCode: detail.uomCode, minutes: round(allocatedMinutes), status: detail.plan.status });
          remainingMinutes -= allocatedMinutes;
        }
        cursor = addDays(cursor, -1);
      }
      if (firstAllocatedDate) routeStartDates.set(route.id, parseDateOnly(firstAllocatedDate));
      if (remainingMinutes > 0) {
        pushIssue(issues, { severity: "overridable", code: "PLAN_CAPACITY_SHORTAGE", planNumber: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, partName: planPart?.partName || null, bomNumber: route.noReg || null, processCode: route.process?.processCode || null, processName: route.process?.processName || null, routeId: route.id, machineCode: machine.machineCode, machineName: machine.machineName || null, message: `${machine.machineName || machine.machineCode} kekurangan ${round(remainingMinutes)} menit untuk ${detail.partCode}${planPart?.partName ? ` · ${planPart.partName}` : ""} dalam horizon.` }, issueKeys);
        unscheduled.push({ source: "PROPOSED", reference: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, processCode: route.process?.processCode || null, mbomProcessId: route.id, machineCode: machine.machineCode, machineSpecificationCode: routeSpecificationCode(route), qty: capacityQty(remainingMinutes / cycleMinutes, detail.uomCode), uomCode: detail.uomCode, minutes: round(remainingMinutes), reason: "Kapasitas horizon tidak mencukupi", suggestedMachines: suggestedMachines.map((item) => ({ id: item.id, machineCode: item.machineCode, machineName: item.machineName })) });
      }
    }
  }

  const manualAllocationCatalog = [];
  for (const detail of capacityPlanDetails) {
    for (const route of canonicalizeRoutingOperations(routesForPlanDetail(detail)).sort(capacityRouteCompare)) {
      if (!route.processId) continue;
      const remainingQty = Math.max(capacityQty(number(detail.qtyPlanned) - number(scheduledQtyByPlanProcess.get(`${detail.plan.planNumber}|${detail.lineNumber}|${route.processId}`)), detail.uomCode), 0);
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
        processId: route.processId,
        processCode: route.process?.processCode || null,
        processName: route.process?.processName || null,
        mbomProcessId: route.id,
        routingNumber: route.routingNumber || null,
        sequence: number(route.sourceSequence || route.sequence),
        routingMode,
        machineSpecificationCode: routeSpecificationCode(route),
        allowedMachineIds,
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
  for (const detail of planDetails.filter((row) => row.mpsDetailId && !String(row.notes || "").includes("[MRP-PRODUCTION]"))) {
    const mpsNumber = String(detail.plan.sourceType || "").startsWith("MPS:") ? String(detail.plan.sourceType).slice(4) : null;
    if (!mpsNumber) continue;
    const configured = deliveryPhases.filter((phase) => phase.mpsNumber === mpsNumber && phase.mpsDetailId === detail.mpsDetailId);
    const configuredQty = configured.reduce((sum, phase) => sum + number(phase.qtyPlanned), 0);
    const shortageQty = Math.max(number(detail.qtyPlanned) - configuredQty, 0);
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
      phaseQty: 0, cumulativeRequiredQty: number(detail.qtyPlanned), plannedQtyByDueDate: configuredQty,
      shortageQty: capacityQty(shortageQty, detail.uomCode), uomCode: detail.uomCode, status: configured.length ? "INCOMPLETE" : "MISSING",
    });
  }
  const detailByMpsDetailId = new Map(planDetails.filter((detail) => detail.mpsDetailId).map((detail) => [`${detail.plan.sourceType}|${detail.mpsDetailId}`, detail]));
  const initialStockQtyByDetailId = new Map();
  const remainingFinishedGoodStock = new Map(availableFinishedGoodByPartUom);
  const directReceiptDetails = planDetails
    .filter((detail) => detail.mpsDetailId && !String(detail.notes || "").includes("[MRP-PRODUCTION]"))
    .sort((left, right) => parseDateOnly(left.requiredDate) - parseDateOnly(right.requiredDate));
  for (const detail of directReceiptDetails) {
    const mpsNumber = String(detail.plan.sourceType || "").startsWith("MPS:") ? String(detail.plan.sourceType).slice(4) : null;
    const deliveryDemandQty = deliveryPhases
      .filter((phase) => phase.mpsNumber === mpsNumber && phase.mpsDetailId === detail.mpsDetailId)
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
    const coveredAutoPhaseIds = new Set(deliveryPhases.filter((candidate) =>
      candidate.mpsNumber === phase.mpsNumber
      && candidate.mpsDetailId === phase.mpsDetailId
      && parseDateOnly(candidate.plannedDate) <= parseDateOnly(phase.plannedDate)).map((candidate) => candidate.id));
    const autoPhaseAllocations = productionPlanAllocations.filter((allocation) =>
      allocation.status === "Draft"
      && allocation.allocationSource === "AUTO_RECOMMENDATION"
      && coveredAutoPhaseIds.has(allocation.deliveryPhaseId));
    const autoPredecessorIds = new Set(autoPhaseAllocations.flatMap((allocation) =>
      Array.isArray(allocation.predecessorAllocationIds) ? allocation.predecessorAllocationIds : []));
    const autoTerminalQtyByDueDate = autoPhaseAllocations.reduce((sum, allocation) => {
      // A terminal output is not referenced as a predecessor by another
      // allocation in the same delivery phase graph.
      if (autoPredecessorIds.has(allocation.id)) return sum;
      const completionDate = String(allocation.routingMode || "INHOUSE").toUpperCase() === "VENDOR"
        ? (allocation.vendorReturnDate || allocation.scheduleDate)
        : allocation.scheduleDate;
      if (parseDateOnly(completionDate) > parseDateOnly(phase.plannedDate)) return sum;
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
    const initialStockQty = number(initialStockQtyByDetailId.get(directDetail.id));
    const plannedQtyByDueDate = initialStockQty + firmQtyByDueDate + legacyDraftQtyByDueDate + autoTerminalQtyByDueDate;
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
      cumulativeRequiredQty: capacityQty(cumulativeRequiredQty, phase.uomCode || detail.uomCode),
      initialStockQty: capacityQty(initialStockQty, phase.uomCode || detail.uomCode),
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
      if (!["MANUAL", "RECOMMENDED"].includes(vendorAssignments[index].source)) vendorAssignments.splice(index, 1);
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
          planNumber: planItem?.planNumber || (String(planItem?.reference || "").startsWith("MPP-") ? planItem.reference : null),
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
    parameters: { startDate: dateKey(range.start), endDate: dateKey(range.end), shiftHours, shiftsPerDay, efficiencyPercent, overtimeHours, includeSaturday, includeSunday, scenarioName, planningMode, scenarioKey, presetId: selectedPreset?.id || null, planningGranularity, rollingLookbackWeeks, freezeFenceDays, freezeFenceDate: dateKey(freezeFenceDate), availableMinutesPerMachineDay: workingAvailableMinutes, planNumber, manualAllocation },
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
      categories: issues.reduce((summary, issue) => {
        const category = issue.category || "CAPACITY";
        summary[category] = (summary[category] || 0) + 1;
        return summary;
      }, {}),
      issues,
    },
  };
}

module.exports = { buildCapacitySnapshot, resolveRange, resolveDailyCapacity, predecessorQuantityStatus };
