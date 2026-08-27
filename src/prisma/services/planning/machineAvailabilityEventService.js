const { prisma } = require("../../index");

function normalizeMachineEvent(input = {}, actor = "system") {
  const machineId = String(input.machineId || "").trim();
  const eventType = String(input.eventType || "").trim().toUpperCase();
  const reason = String(input.reason || "").trim();
  const startedAt = input.startedAt ? new Date(input.startedAt) : new Date();
  if (!machineId) throw Object.assign(new Error("machineId wajib diisi."), { statusCode: 400 });
  if (!eventType) throw Object.assign(new Error("eventType wajib diisi."), { statusCode: 400 });
  if (!reason) throw Object.assign(new Error("Reason event mesin wajib diisi."), { statusCode: 400 });
  if (Number.isNaN(startedAt.getTime())) throw Object.assign(new Error("startedAt tidak valid."), { statusCode: 400 });
  return { machineId, eventType, reason, startedAt, status: "OPEN", reportedBy: actor || "system" };
}

async function createMachineEvent(input, actor) {
  const data = normalizeMachineEvent(input, actor);
  return prisma.$transaction(async (tx) => {
    const machine = await tx.machine.findFirst({ where: { id: data.machineId, isDeleted: false }, select: { id: true, machineCode: true } });
    if (!machine) throw Object.assign(new Error("Mesin tidak ditemukan."), { statusCode: 404 });
    const event = await tx.machineAvailabilityEvent.create({ data });
    const key = `MACHINE_EVENT:${event.id}`;
    const planDate = new Date(`${event.startedAt.toISOString().slice(0, 10)}T00:00:00.000Z`);
    await tx.dailyPlanningException.create({ data: {
      exceptionKey: key,
      planDate,
      exceptionType: event.eventType === "BREAKDOWN" ? "MACHINE_BREAKDOWN" : "MACHINE_AVAILABILITY",
      severity: event.eventType === "BREAKDOWN" ? "BLOCKER" : "WARNING",
      sourceType: "MachineAvailabilityEvent",
      sourceId: event.id,
      machineId: event.machineId,
      suggestions: [{ action: "MOVE_MACHINE", label: "Pindahkan ke mesin alternatif" }, { action: "MOVE_TIME", label: "Geser ke slot setelah recovery" }],
    } });
    return { ...event, machineCode: machine.machineCode };
  });
}

async function resolveMachineEvent(id, actor) {
  return prisma.$transaction(async (tx) => {
    const event = await tx.machineAvailabilityEvent.findUnique({ where: { id } });
    if (!event || event.isDeleted) throw Object.assign(new Error("Event mesin tidak ditemukan."), { statusCode: 404 });
    const resolvedAt = new Date();
    const updated = await tx.machineAvailabilityEvent.update({ where: { id }, data: { status: "RESOLVED", endedAt: resolvedAt, resolvedAt, resolvedBy: actor || "system" } });
    await tx.dailyPlanningException.updateMany({ where: { sourceType: "MachineAvailabilityEvent", sourceId: id, isDeleted: false }, data: { state: "RESOLVED", handledBy: actor || "system", handledAt: resolvedAt } });
    return updated;
  });
}

module.exports = { normalizeMachineEvent, createMachineEvent, resolveMachineEvent };
