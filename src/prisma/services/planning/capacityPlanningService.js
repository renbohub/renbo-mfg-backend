const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_PLAN_STATUSES = ["Draft", "Confirmed", "Released", "In Progress"];
const ACTIVE_SCHEDULE_STATUSES = ["Draft", "Released", "In Progress", "Completed"];

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value, digits = 2) => Number(number(value).toFixed(digits));

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
    status: machine.status === "Active" ? "available" : "unavailable",
    items: [],
  };
}

function pushIssue(target, issue, seen) {
  const key = [issue.code, issue.planNumber, issue.lineNumber, issue.partCode, issue.processCode, issue.routeId, issue.machineCode].join("|");
  if (seen.has(key)) return;
  seen.add(key);
  target.push(issue);
}

async function buildCapacitySnapshot(prisma, query = {}) {
  const range = resolveRange(query);
  const shiftHours = Math.min(Math.max(number(query.shiftHours) || 8, 1), 24);
  const shiftsPerDay = Math.min(Math.max(number(query.shiftsPerDay) || 1, 1), 3);
  const efficiencyPercent = Math.min(Math.max(number(query.efficiencyPercent) || 85, 1), 100);
  const baseAvailableMinutes = round(shiftHours * 60 * shiftsPerDay * efficiencyPercent / 100, 2);
  const planNumber = String(query.planNumber || "").trim() || null;

  const [machines, processes, headers, routes, schedules, downtimes, planDetails] = await Promise.all([
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
        mbomDetail: { select: { partId: true, part: { select: { partCode: true, partName: true } } } },
      },
      orderBy: [{ noReg: "asc" }, { sequence: "asc" }, { routingNumber: "asc" }],
    }),
    prisma.dailyProductionSchedule.findMany({
      where: { scheduleDate: { gte: range.start, lt: range.endExclusive }, isDeleted: false, status: { in: ACTIVE_SCHEDULE_STATUSES } },
      orderBy: [{ scheduleDate: "asc" }, { shift: "asc" }, { sequence: "asc" }],
      select: { id: true, scheduleNumber: true, scheduleDate: true, shift: true, moId: true, moNumber: true, woId: true, woNumber: true, partCode: true, processId: true, machineId: true, plannedQty: true, actualQty: true, uomCode: true, sequence: true, status: true },
    }),
    prisma.downtimeLog.findMany({
      where: { downtimeDate: { gte: range.start, lt: range.endExclusive }, isDeleted: false, status: { not: "Cancelled" }, machineCode: { not: null } },
      select: { downtimeNumber: true, downtimeDate: true, machineCode: true, shift: true, durationMinutes: true, reason: true, category: true, status: true },
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
  ]);

  const latestHeaderByPart = new Map();
  for (const header of headers) if (header.partId && !latestHeaderByPart.has(header.partId)) latestHeaderByPart.set(header.partId, header.noReg);
  const activeNoRegs = new Set(latestHeaderByPart.values());
  const activeRoutes = routes.filter((route) => activeNoRegs.has(route.noReg));
  const machineById = new Map(machines.map((machine) => [machine.id, machine]));
  const machineByCode = new Map(machines.map((machine) => [machine.machineCode, machine]));
  const processById = new Map(processes.map((process) => [process.id, process]));
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
    defaultAvailableMinutes: machine.status === "Active" ? baseAvailableMinutes : 0,
    cells: Object.fromEntries(range.dates.map((key) => [key, machineCell(machine, key, baseAvailableMinutes)])),
  }));
  const rowByMachineId = new Map(machineRows.map((machine) => [machine.id, machine]));
  const rowByMachineCode = new Map(machineRows.map((machine) => [machine.machineCode, machine]));
  const issues = [];
  const issueKeys = new Set();
  const unscheduled = [];
  const fgReceipts = [];

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
    select: { id: true, partCode: true, partName: true, itemType: true },
  }) : [];
  const planPartById = new Map(planParts.map((part) => [part.id, part]));
  const planPartByCode = new Map(planParts.map((part) => [part.partCode, part]));

  const planNumbers = [...new Set(planDetails.map((detail) => detail.plan.planNumber).filter(Boolean))];
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

  for (const machine of machines) {
    if (machine.status !== "Active") pushIssue(issues, { severity: "warning", code: "MACHINE_NOT_ACTIVE", machineCode: machine.machineCode, message: `${machine.machineCode} berstatus ${machine.status}.` }, issueKeys);
    if (number(machine.capacity) <= 0 && number(machine.cycleTime) <= 0) pushIssue(issues, { severity: "warning", code: "MACHINE_RATE_MISSING", machineCode: machine.machineCode, message: `${machine.machineCode} belum memiliki capacity atau cycle time master.` }, issueKeys);
  }

  for (const route of activeRoutes) {
    const partCode = route.mbomDetail?.part?.partCode || null;
    if (!route.machineId) pushIssue(issues, { severity: "warning", code: "ROUTING_MACHINE_MISSING", routeId: route.id, partCode, message: `${partCode || route.noReg} · ${route.process?.processCode || "Process"} belum mempunyai mesin pada routing.` }, issueKeys);
    if (resolveCycleMinutes(route.cycleTime, route.machine, baseAvailableMinutes) <= 0) pushIssue(issues, { severity: "warning", code: "ROUTING_CYCLE_MISSING", routeId: route.id, partCode, machineCode: route.machine?.machineCode || null, message: `${partCode || route.noReg} · ${route.process?.processCode || "Process"} belum mempunyai cycle time.` }, issueKeys);
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
    const cycleMinutes = resolveCycleMinutes(wo?.cycleTime, machine, baseAvailableMinutes);
    const loadMinutes = number(schedule.plannedQty) * cycleMinutes;
    if (!cell || cycleMinutes <= 0) {
      unscheduled.push({ source: "FIRM", reference: schedule.scheduleNumber, partCode: schedule.partCode, processCode: wo?.process?.processCode || processById.get(schedule.processId)?.processCode || null, machineCode: machine?.machineCode || null, qty: number(schedule.plannedQty), minutes: round(loadMinutes), reason: !machine ? "Mesin belum ditentukan" : "Cycle time belum tersedia" });
      continue;
    }
    cell.firmMinutes += loadMinutes;
    cell.actualMinutes += number(schedule.actualQty) * cycleMinutes;
    cell.items.push({ source: "FIRM", reference: schedule.scheduleNumber, moNumber: schedule.moNumber, woNumber: schedule.woNumber, partCode: schedule.partCode, processCode: wo?.process?.processCode || processById.get(schedule.processId)?.processCode || null, shift: schedule.shift, qty: number(schedule.plannedQty), uomCode: schedule.uomCode, minutes: round(loadMinutes), status: schedule.status });
  }

  for (const detail of planDetails) {
    const plannedQty = Math.max(number(detail.qtyPlanned), 0);
    if (plannedQty <= 0) continue;
    const planPart = planPartById.get(detail.partId) || planPartByCode.get(detail.partCode) || null;
    if (String(planPart?.itemType || "").trim().toUpperCase() === "FG") {
      fgReceipts.push({
        planNumber: detail.plan.planNumber,
        lineNumber: detail.lineNumber,
        partCode: detail.partCode,
        partName: planPart?.partName || null,
        qty: plannedQty,
        uomCode: detail.uomCode,
        receiptDate: dateKey(detail.requiredDate || detail.plan.periodEnd),
        status: detail.plan.status,
      });
      continue;
    }
    const partRoutes = (detail.partId ? routesByPartId.get(detail.partId) : null) || routesByPartCode.get(detail.partCode) || [];
    if (!partRoutes.length) {
      pushIssue(issues, { severity: "blocking", code: "PLAN_ROUTING_MISSING", planNumber: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, message: `${detail.plan.planNumber} line ${detail.lineNumber} · ${detail.partCode} belum memiliki routing process.` }, issueKeys);
      unscheduled.push({ source: "PROPOSED", reference: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, qty: plannedQty, uomCode: detail.uomCode, minutes: 0, reason: "Routing process belum tersedia" });
      continue;
    }

    const orderedRoutes = [...partRoutes].sort((a, b) => number(b.sequence) - number(a.sequence) || String(b.routingNumber || "").localeCompare(String(a.routingNumber || "")));
    for (const route of orderedRoutes) {
      const planProcessKey = `${detail.plan.planNumber}|${detail.lineNumber}|${route.processId}`;
      const remainingQty = Math.max(plannedQty - number(scheduledQtyByPlanProcess.get(planProcessKey)), 0);
      if (remainingQty <= 0) continue;
      const machine = machineById.get(route.machineId);
      const cycleMinutes = resolveCycleMinutes(route.cycleTime, machine, baseAvailableMinutes);
      if (!machine) {
        pushIssue(issues, { severity: "blocking", code: "PLAN_MACHINE_MISSING", planNumber: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, routeId: route.id, message: `${detail.partCode} · ${route.process?.processCode || "Process"} belum ditentukan mesinnya.` }, issueKeys);
        unscheduled.push({ source: "PROPOSED", reference: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, processCode: route.process?.processCode || null, qty: remainingQty, uomCode: detail.uomCode, minutes: round(remainingQty * cycleMinutes), reason: "Mesin routing belum tersedia" });
        continue;
      }
      if (machine.status !== "Active") {
        pushIssue(issues, { severity: "blocking", code: "PLAN_MACHINE_INACTIVE", planNumber: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, routeId: route.id, machineCode: machine.machineCode, message: `${machine.machineCode} tidak Active untuk ${detail.partCode}.` }, issueKeys);
      }
      if (cycleMinutes <= 0) {
        pushIssue(issues, { severity: "blocking", code: "PLAN_CYCLE_MISSING", planNumber: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, routeId: route.id, machineCode: machine.machineCode, message: `${detail.partCode} · ${route.process?.processCode || "Process"} belum memiliki cycle time.` }, issueKeys);
        unscheduled.push({ source: "PROPOSED", reference: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, processCode: route.process?.processCode || null, machineCode: machine.machineCode, qty: remainingQty, uomCode: detail.uomCode, minutes: 0, reason: "Cycle time belum tersedia" });
        continue;
      }

      let remainingMinutes = remainingQty * cycleMinutes;
      const due = parseDateOnly(detail.requiredDate || detail.plan.periodEnd);
      let cursor = due > range.end ? range.end : due < range.start ? range.start : due;
      while (remainingMinutes > 0 && cursor >= range.start) {
        const cell = rowByMachineId.get(machine.id)?.cells[dateKey(cursor)];
        if (!cell) break;
        const freeMinutes = Math.max(cell.baseAvailableMinutes - cell.downtimeMinutes - cell.firmMinutes - cell.proposedMinutes, 0);
        const allocatedMinutes = Math.min(remainingMinutes, freeMinutes);
        if (allocatedMinutes > 0) {
          const allocatedQty = remainingQty * allocatedMinutes / (remainingQty * cycleMinutes);
          cell.proposedMinutes += allocatedMinutes;
          cell.items.push({ source: "PROPOSED", reference: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, processCode: route.process?.processCode || null, routingNumber: route.routingNumber, qty: round(allocatedQty, 3), uomCode: detail.uomCode, minutes: round(allocatedMinutes), status: detail.plan.status });
          remainingMinutes -= allocatedMinutes;
        }
        cursor = addDays(cursor, -1);
      }
      if (remainingMinutes > 0) {
        pushIssue(issues, { severity: "blocking", code: "PLAN_CAPACITY_SHORTAGE", planNumber: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, routeId: route.id, machineCode: machine.machineCode, message: `${machine.machineCode} kekurangan ${round(remainingMinutes)} menit untuk ${detail.partCode} dalam horizon.` }, issueKeys);
        unscheduled.push({ source: "PROPOSED", reference: detail.plan.planNumber, lineNumber: detail.lineNumber, partCode: detail.partCode, processCode: route.process?.processCode || null, machineCode: machine.machineCode, qty: round(remainingMinutes / cycleMinutes, 3), uomCode: detail.uomCode, minutes: round(remainingMinutes), reason: "Kapasitas horizon tidak mencukupi" });
      }
    }
  }

  let totalAvailableMinutes = 0;
  let totalLoadMinutes = 0;
  let totalFirmMinutes = 0;
  let totalProposedMinutes = 0;
  let totalDowntimeMinutes = 0;
  let overloadedCells = 0;
  for (const row of machineRows) {
    for (const key of range.dates) {
      const cell = row.cells[key];
      cell.downtimeMinutes = round(cell.downtimeMinutes);
      cell.availableMinutes = round(Math.max(cell.baseAvailableMinutes - cell.downtimeMinutes, 0));
      cell.firmMinutes = round(cell.firmMinutes);
      cell.proposedMinutes = round(cell.proposedMinutes);
      cell.actualMinutes = round(cell.actualMinutes);
      cell.loadMinutes = round(cell.firmMinutes + cell.proposedMinutes);
      cell.loadPercent = cell.availableMinutes > 0 ? round(cell.loadMinutes / cell.availableMinutes * 100, 1) : cell.loadMinutes > 0 ? 999 : 0;
      cell.status = cell.loadPercent > 100 ? "overload" : cell.loadPercent >= 85 ? "high" : cell.loadPercent > 0 ? "loaded" : row.status === "Active" ? "available" : "unavailable";
      if (cell.loadPercent > 100) overloadedCells += 1;
      totalAvailableMinutes += cell.availableMinutes;
      totalLoadMinutes += cell.loadMinutes;
      totalFirmMinutes += cell.firmMinutes;
      totalProposedMinutes += cell.proposedMinutes;
      totalDowntimeMinutes += cell.downtimeMinutes;
    }
  }

  const blockingIssues = issues.filter((issue) => issue.severity === "blocking");
  return {
    parameters: { startDate: dateKey(range.start), endDate: dateKey(range.end), shiftHours, shiftsPerDay, efficiencyPercent, availableMinutesPerMachineDay: baseAvailableMinutes, planNumber },
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
      utilizationPercent: totalAvailableMinutes > 0 ? round(totalLoadMinutes / totalAvailableMinutes * 100, 1) : 0,
      overloadedCells,
      unscheduledCount: unscheduled.length,
    },
    machines: machineRows,
    fgReceipts,
    unscheduled,
    readiness: {
      ok: blockingIssues.length === 0,
      blockingCount: blockingIssues.length,
      warningCount: issues.filter((issue) => issue.severity === "warning").length,
      infoCount: issues.filter((issue) => issue.severity === "info").length,
      issues,
    },
  };
}

module.exports = { buildCapacitySnapshot, resolveRange };
