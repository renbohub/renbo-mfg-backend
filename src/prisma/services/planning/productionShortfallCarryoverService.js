const EPSILON = 0.000001;
const EFFICIENCY = 0.85;

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const round = (value) => Number(number(value).toFixed(6));

function dateOnly(value) {
  const parsed = new Date(value);
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function addDays(value, days) {
  return new Date(dateOnly(value).getTime() + days * 86400000);
}

function dayRange(value) {
  const start = dateOnly(value);
  return { start, end: new Date(start.getTime() + 86400000 - 1) };
}

function minuteOfDay(value, fallback) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : fallback;
}

function timeText(value) {
  const minute = ((Math.round(value) % 1440) + 1440) % 1440;
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function shiftNumber(value) {
  return ["1", "2", "3"].includes(String(value || "").slice(0, 1)) ? String(value).slice(0, 1) : "1";
}

function shiftWindow(machine, shift) {
  const index = Number(shiftNumber(shift)) - 1;
  const defaults = [[480, 960], [960, 1440], [0, 480]];
  const start = minuteOfDay(machine?.[`shift${index + 1}Start`], defaults[index][0]);
  const rawEnd = minuteOfDay(machine?.[`shift${index + 1}End`], defaults[index][1]);
  const end = rawEnd <= start ? rawEnd + 1440 : rawEnd;
  const configuredMinutes = Math.max(end - start, 1);
  const defaultMinutes = Math.max(number(machine?.defaultShiftHours) * 60, 1);
  return { start, end, availableMinutes: Math.max(configuredMinutes || defaultMinutes, 1) * EFFICIENCY };
}

function cycleMinutes(workOrder, machine) {
  const seconds = number(workOrder?.cycleTime) || number(machine?.cycleTime);
  if (seconds > 0) return seconds / 60;
  const capacity = number(machine?.capacity);
  const unit = String(machine?.capacityUnit || "").toUpperCase();
  if (capacity <= 0) return 0;
  if (unit.includes("HOUR") || unit.includes("JAM")) return 60 / capacity;
  if (unit.includes("MIN")) return 1 / capacity;
  return 0;
}

async function nextScheduleNumber(tx, date) {
  const key = dateOnly(date).toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `DPS-${key}`;
  // pg_advisory_xact_lock returns PostgreSQL `void`. Prisma cannot
  // deserialize that value through $queryRaw, so execute the statement
  // without asking Prisma to materialize a result row.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${prefix}))`;
  const last = await tx.dailyProductionSchedule.findFirst({
    where: { scheduleNumber: { startsWith: prefix } },
    orderBy: { scheduleNumber: "desc" },
    select: { scheduleNumber: true },
  });
  const sequence = last ? Number(last.scheduleNumber.split("-").pop()) + 1 : 1;
  return `${prefix}-${String(sequence).padStart(3, "0")}`;
}

function sameOperation(left, right) {
  if (left.woId && right.woId) return left.woId === right.woId;
  if (left.mbomProcessId && right.mbomProcessId) return left.mbomProcessId === right.mbomProcessId;
  return left.partCode === right.partCode && left.processId === right.processId;
}

async function createProductionShortfallCarryover(tx, { log, schedule, actor = "system" }) {
  if (!log?.id || !schedule?.id) return null;
  const existing = await tx.productionLogCarryover.findUnique({ where: { sourceLogId: log.id } });
  if (existing) return existing;

  const shortfallQty = round(Math.max(number(log.qtyPlanned) - number(log.qtyGood), 0));
  if (shortfallQty <= EPSILON) return null;

  const targetDate = addDays(schedule.scheduleDate || log.logDate, 1);
  const { start, end } = dayRange(targetDate);
  const [workOrder, route, targetSchedules] = await Promise.all([
    schedule.woId ? tx.workOrder.findFirst({ where: { id: schedule.woId, isDeleted: false } }) : null,
    schedule.mbomProcessId ? tx.mBOMProcess.findFirst({ where: { id: schedule.mbomProcessId, isDeleted: false }, select: { machineSpecificationCode: true } }) : null,
    tx.dailyProductionSchedule.findMany({
      where: { scheduleDate: { gte: start, lte: end }, isDeleted: false, status: { in: ["Draft", "Released", "In Progress"] } },
      orderBy: [{ schedulePriority: "asc" }, { plannedStartTime: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  const sourceMachineId = schedule.machineId || workOrder?.machineId || null;
  const sourceDiesId = schedule.diesId || workOrder?.diesId || null;
  const sourceDies = sourceDiesId ? await tx.dies.findFirst({ where: { id: sourceDiesId, isDeleted: false, status: "Active" } }) : null;
  const machineIds = [...new Set([sourceMachineId, ...targetSchedules.map((row) => row.machineId)].filter(Boolean))];
  let machines = machineIds.length ? await tx.machine.findMany({ where: { id: { in: machineIds }, isDeleted: false, status: "Active" } }) : [];
  const sourceMachine = machines.find((machine) => machine.id === sourceMachineId) || null;
  const specificationCode = route?.machineSpecificationCode || sourceMachine?.machineSpecificationCode || null;
  if (specificationCode) {
    machines = await tx.machine.findMany({
      where: { machineSpecificationCode: specificationCode, isDeleted: false, status: "Active" },
      orderBy: { machineCode: "asc" },
    });
  } else if (sourceMachine) {
    machines = [sourceMachine];
  }
  if (!machines.length && sourceMachine) machines = [sourceMachine];
  if (sourceDies && number(sourceDies.tonnage) > 0) {
    machines = machines.filter((machine) => number(machine.tonnage) <= 0 || number(machine.tonnage) >= number(sourceDies.tonnage));
  }

  const workOrderIds = [...new Set(targetSchedules.map((row) => row.woId).filter(Boolean))];
  const targetWorkOrders = workOrderIds.length ? await tx.workOrder.findMany({ where: { id: { in: workOrderIds } } }) : [];
  const workOrderById = new Map(targetWorkOrders.map((row) => [row.id, row]));
  const machineById = new Map(machines.map((row) => [row.id, row]));
  for (const machineId of machineIds) {
    if (machineById.has(machineId)) continue;
    const machine = await tx.machine.findFirst({ where: { id: machineId, isDeleted: false } });
    if (machine) machineById.set(machine.id, machine);
  }

  const loadMinutes = new Map();
  const diesLoadMinutes = new Map();
  for (const row of targetSchedules) {
    if (!row.machineId) continue;
    const machine = machineById.get(row.machineId);
    const rowCycle = cycleMinutes(workOrderById.get(row.woId), machine);
    const key = `${row.machineId}|${shiftNumber(row.shift)}`;
    loadMinutes.set(key, number(loadMinutes.get(key)) + number(row.plannedQty) * rowCycle);
    if (row.diesId) {
      const diesKey = `${row.diesId}|${shiftNumber(row.shift)}`;
      diesLoadMinutes.set(diesKey, number(diesLoadMinutes.get(diesKey)) + number(row.plannedQty) * rowCycle);
    }
  }

  const allocations = [];
  let remainingQty = shortfallQty;
  const matchingDrafts = targetSchedules.filter((row) => row.status === "Draft" && sameOperation(row, schedule));
  for (const target of matchingDrafts) {
    if (remainingQty <= EPSILON || !target.machineId) break;
    const machine = machineById.get(target.machineId);
    const targetCycle = cycleMinutes(workOrder || workOrderById.get(target.woId), machine);
    if (targetCycle <= 0) continue;
    const key = `${target.machineId}|${shiftNumber(target.shift)}`;
    const window = shiftWindow(machine, target.shift);
    const spareMinutes = Math.max(window.availableMinutes - number(loadMinutes.get(key)), 0);
    const diesKey = sourceDiesId ? `${sourceDiesId}|${shiftNumber(target.shift)}` : null;
    const diesSpareMinutes = diesKey ? Math.max(window.availableMinutes - number(diesLoadMinutes.get(diesKey)), 0) : spareMinutes;
    const allocatedQty = round(Math.min(remainingQty, Math.min(spareMinutes, diesSpareMinutes) / targetCycle));
    if (allocatedQty <= EPSILON) continue;
    const recalculatedEndTime = target.plannedStartTime
      ? timeText(minuteOfDay(target.plannedStartTime, window.start) + (number(target.plannedQty) + allocatedQty) * targetCycle)
      : target.plannedEndTime;
    await tx.dailyProductionSchedule.update({
      where: { id: target.id },
      data: {
        plannedQty: { increment: allocatedQty },
        diesId: target.diesId || sourceDiesId,
        plannedEndTime: recalculatedEndTime || null,
        schedulePriority: Math.min(number(target.schedulePriority) || 100, 1),
        notes: [target.notes, `[AUTO-CARRYOVER:${log.logNumber}:${allocatedQty}]`].filter(Boolean).join("; "),
      },
    });
    loadMinutes.set(key, number(loadMinutes.get(key)) + allocatedQty * targetCycle);
    if (diesKey) diesLoadMinutes.set(diesKey, number(diesLoadMinutes.get(diesKey)) + allocatedQty * targetCycle);
    allocations.push({ mode: "INCREASE", dpsId: target.id, scheduleNumber: target.scheduleNumber, qty: allocatedQty, previousPriority: target.schedulePriority });
    remainingQty = round(remainingQty - allocatedQty);
  }

  const shifts = [shiftNumber(schedule.shift), ...targetSchedules.map((row) => shiftNumber(row.shift))].filter((value, index, rows) => rows.indexOf(value) === index);
  const slots = machines.flatMap((machine) => shifts.map((shift) => {
    const key = `${machine.id}|${shift}`;
    const window = shiftWindow(machine, shift);
    return { machine, shift, key, window, usedMinutes: number(loadMinutes.get(key)) };
  })).sort((left, right) => (left.machine.id === sourceMachineId ? -1 : right.machine.id === sourceMachineId ? 1 : 0) || left.usedMinutes - right.usedMinutes || left.machine.machineCode.localeCompare(right.machine.machineCode));

  for (const slot of slots) {
    if (remainingQty <= EPSILON) break;
    const targetCycle = cycleMinutes(workOrder, slot.machine);
    if (targetCycle <= 0) continue;
    const diesKey = sourceDiesId ? `${sourceDiesId}|${slot.shift}` : null;
    const resourceUsedMinutes = Math.max(slot.usedMinutes, diesKey ? number(diesLoadMinutes.get(diesKey)) : 0);
    const spareMinutes = Math.max(slot.window.availableMinutes - resourceUsedMinutes, 0);
    const allocatedQty = round(Math.min(remainingQty, spareMinutes / targetCycle));
    if (allocatedQty <= EPSILON) continue;
    const plannedStart = slot.window.start + resourceUsedMinutes;
    const created = await tx.dailyProductionSchedule.create({
      data: {
        scheduleNumber: await nextScheduleNumber(tx, targetDate),
        scheduleDate: targetDate,
        shift: slot.shift,
        plannedStartTime: timeText(plannedStart),
        plannedEndTime: timeText(plannedStart + allocatedQty * targetCycle),
        moId: schedule.moId,
        moNumber: schedule.moNumber,
        woId: schedule.woId,
        woNumber: schedule.woNumber,
        partId: schedule.partId,
        partCode: schedule.partCode,
        processId: schedule.processId,
        machineId: slot.machine.id,
        diesId: sourceDiesId,
        productionPlanId: schedule.productionPlanId,
        productionPlanAllocationId: schedule.productionPlanAllocationId,
        mbomProcessId: schedule.mbomProcessId,
        plannedQty: allocatedQty,
        uomCode: schedule.uomCode,
        sequence: schedule.sequence,
        schedulePriority: 1,
        deliveryPhaseId: schedule.deliveryPhaseId,
        deliveryPhaseNumber: schedule.deliveryPhaseNumber,
        transferBatchNumber: schedule.transferBatchNumber,
        predecessorAllocationIds: schedule.predecessorAllocationIds,
        status: "Draft",
        notes: `[AUTO-CARRYOVER:${log.logNumber}:${allocatedQty}] Prioritas shortfall sebelum schedule reguler.`,
        createdBy: actor,
      },
    });
    slot.usedMinutes = resourceUsedMinutes + allocatedQty * targetCycle;
    loadMinutes.set(slot.key, slot.usedMinutes);
    if (diesKey) diesLoadMinutes.set(diesKey, resourceUsedMinutes + allocatedQty * targetCycle);
    allocations.push({ mode: "CREATE", dpsId: created.id, scheduleNumber: created.scheduleNumber, qty: allocatedQty, machineId: slot.machine.id, shift: slot.shift });
    remainingQty = round(remainingQty - allocatedQty);
  }

  if (remainingQty > EPSILON) {
    const slot = slots.sort((left, right) => left.usedMinutes - right.usedMinutes)[0];
    if (!slot) throw Object.assign(new Error("Shortfall tidak dapat dialokasikan karena mesin routing tidak tersedia."), { statusCode: 409 });
    const targetCycle = cycleMinutes(workOrder, slot.machine);
    const diesKey = sourceDiesId ? `${sourceDiesId}|${slot.shift}` : null;
    const resourceUsedMinutes = Math.max(slot.usedMinutes, diesKey ? number(diesLoadMinutes.get(diesKey)) : 0);
    const created = await tx.dailyProductionSchedule.create({
      data: {
        scheduleNumber: await nextScheduleNumber(tx, targetDate), scheduleDate: targetDate, shift: slot.shift,
        plannedStartTime: timeText(slot.window.start + resourceUsedMinutes),
        plannedEndTime: timeText(slot.window.start + resourceUsedMinutes + remainingQty * targetCycle),
        moId: schedule.moId, moNumber: schedule.moNumber, woId: schedule.woId, woNumber: schedule.woNumber,
        partId: schedule.partId, partCode: schedule.partCode, processId: schedule.processId, machineId: slot.machine.id,
        diesId: sourceDiesId,
        productionPlanId: schedule.productionPlanId, productionPlanAllocationId: schedule.productionPlanAllocationId, mbomProcessId: schedule.mbomProcessId,
        plannedQty: remainingQty, uomCode: schedule.uomCode, sequence: schedule.sequence, schedulePriority: 1,
        deliveryPhaseId: schedule.deliveryPhaseId, deliveryPhaseNumber: schedule.deliveryPhaseNumber, transferBatchNumber: schedule.transferBatchNumber,
        predecessorAllocationIds: schedule.predecessorAllocationIds, status: "Draft",
        notes: `[AUTO-CARRYOVER:${log.logNumber}:${remainingQty}][CAPACITY-OVERFLOW] DPP tambahan wajib diprioritaskan sebelum schedule reguler.`, createdBy: actor,
      },
    });
    allocations.push({ mode: "CREATE_OVERFLOW", dpsId: created.id, scheduleNumber: created.scheduleNumber, qty: remainingQty, machineId: slot.machine.id, shift: slot.shift });
    remainingQty = 0;
  }

  return tx.productionLogCarryover.create({
    data: {
      sourceLogId: log.id,
      sourceDpsId: schedule.id,
      targetDate,
      shortfallQty,
      allocatedQty: round(allocations.reduce((sum, row) => sum + number(row.qty), 0)),
      targetAllocations: allocations,
      status: allocations.some((row) => row.mode === "CREATE_OVERFLOW") ? "OVER_CAPACITY" : "ALLOCATED",
      createdBy: actor,
    },
  });
}

async function rollbackProductionShortfallCarryover(tx, sourceLogId) {
  const carryover = await tx.productionLogCarryover.findUnique({ where: { sourceLogId } });
  if (!carryover || carryover.status === "REVERSED") return;
  for (const allocation of Array.isArray(carryover.targetAllocations) ? carryover.targetAllocations : []) {
    const target = await tx.dailyProductionSchedule.findFirst({ where: { id: allocation.dpsId, isDeleted: false } });
    if (!target) continue;
    if (allocation.mode === "INCREASE") {
      if (target.status !== "Draft") throw Object.assign(new Error(`Carry-over ${target.scheduleNumber} sudah diproses dan tidak dapat dibatalkan.`), { statusCode: 409 });
      await tx.dailyProductionSchedule.update({
        where: { id: target.id },
        data: { plannedQty: Math.max(number(target.plannedQty) - number(allocation.qty), 0), schedulePriority: allocation.previousPriority || 100 },
      });
    } else {
      const logCount = await tx.productionLog.count({ where: { dpsId: target.id, isDeleted: false } });
      if (target.status !== "Draft" || logCount) throw Object.assign(new Error(`DPP carry-over ${target.scheduleNumber} sudah diproses dan tidak dapat dibatalkan.`), { statusCode: 409 });
      await tx.dailyProductionSchedule.update({ where: { id: target.id }, data: { isDeleted: true, status: "Cancelled" } });
    }
  }
  await tx.productionLogCarryover.update({ where: { id: carryover.id }, data: { status: "REVERSED", reversedAt: new Date() } });
}

module.exports = { createProductionShortfallCarryover, rollbackProductionShortfallCarryover };
