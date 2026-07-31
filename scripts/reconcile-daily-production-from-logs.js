require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");

const dayKey = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null;
};

function chooseSchedule(log, candidates, workOrder = null) {
  return [...candidates].sort((left, right) => {
    const score = (row) => {
      let value = 0;
      if (log.woId && row.woId === log.woId) value += 100;
      if (log.moId && row.moId === log.moId) value += 20;
      if (workOrder?.outputPartCode && row.partCode === workOrder.outputPartCode) value += 60;
      if (workOrder?.processId && row.processId === workOrder.processId) value += 50;
      if (workOrder?.machineId && row.machineId === workOrder.machineId) value += 30;
      if (dayKey(log.logDate) && dayKey(row.scheduleDate) === dayKey(log.logDate)) value += 10;
      if (log.shift && String(row.shift || "").toUpperCase() === String(log.shift).toUpperCase()) value += 5;
      if (row.status === "Released") value += 2;
      if (row.status === "In Progress") value += 1;
      return value;
    };
    return score(right) - score(left);
  })[0] || null;
}

async function main() {
  const logs = await prisma.productionLog.findMany({
    where: {
      isDeleted: false,
      status: { in: ["Submitted", "Approved"] },
    },
    select: {
      id: true,
      logNumber: true,
      logDate: true,
      shift: true,
      woId: true,
      moId: true,
      dpsId: true,
    },
    orderBy: { createdAt: "asc" },
  });
  const schedules = await prisma.dailyProductionSchedule.findMany({
    where: {
      isDeleted: false,
      status: { in: ["Draft", "Released", "In Progress", "Completed"] },
    },
    select: {
      id: true,
      scheduleNumber: true,
      scheduleDate: true,
      shift: true,
      woId: true,
      moId: true,
      plannedQty: true,
      partCode: true,
      processId: true,
      machineId: true,
      status: true,
    },
  });
  const workOrders = await prisma.workOrder.findMany({
    where: {
      id: { in: logs.map((log) => log.woId).filter(Boolean) },
      isDeleted: false,
    },
    select: {
      id: true,
      woNumber: true,
      outputPartCode: true,
      processId: true,
      machineId: true,
    },
  });
  const workOrderById = new Map(workOrders.map((workOrder) => [workOrder.id, workOrder]));

  let linkedLogs = 0;
  const previousScheduleIds = new Set();
  for (const log of logs) {
    if (log.dpsId) previousScheduleIds.add(log.dpsId);
    const workOrder = workOrderById.get(log.woId) || null;
    const candidates = schedules.filter((schedule) =>
      (
        (log.woId && schedule.woId === log.woId)
        || (log.moId && schedule.moId === log.moId)
      )
      && (!schedule.woId || schedule.woId === log.woId),
    );
    const schedule = chooseSchedule(log, candidates, workOrder);
    if (!schedule) continue;
    if (log.dpsId !== schedule.id) {
      await prisma.productionLog.update({
        where: { id: log.id },
        data: { dpsId: schedule.id },
      });
      linkedLogs += 1;
    }
    if (log.woId && !schedule.woId) {
      await prisma.dailyProductionSchedule.update({
        where: { id: schedule.id },
        data: {
          woId: log.woId,
          woNumber: workOrder?.woNumber || null,
        },
      });
      schedule.woId = log.woId;
      schedule.woNumber = workOrder?.woNumber || schedule.woNumber;
    }
    log.dpsId = schedule.id;
  }

  let updatedSchedules = 0;
  for (const schedule of schedules) {
    const relatedLogs = await prisma.productionLog.findMany({
      where: {
        dpsId: schedule.id,
        isDeleted: false,
        status: { in: ["Submitted", "Approved"] },
      },
      select: { status: true, qtyProduced: true },
    });
    if (!relatedLogs.length) continue;
    const approvedQty = relatedLogs
      .filter((log) => log.status === "Approved")
      .reduce((sum, log) => sum + Number(log.qtyProduced || 0), 0);
    const status =
      approvedQty >= Number(schedule.plannedQty || 0)
        ? "Completed"
        : "In Progress";
    await prisma.dailyProductionSchedule.update({
      where: { id: schedule.id },
      data: { actualQty: approvedQty, status },
    });
    updatedSchedules += 1;
  }
  for (const scheduleId of previousScheduleIds) {
    const stillLinked = logs.some((log) => log.dpsId === scheduleId);
    if (stillLinked) continue;
    const schedule = schedules.find((item) => item.id === scheduleId);
    if (!schedule || !String(schedule.status).match(/^(Completed|In Progress)$/)) continue;
    await prisma.dailyProductionSchedule.update({
      where: { id: scheduleId },
      data: { actualQty: 0, status: "Draft" },
    });
  }

  const statusSummary = await prisma.dailyProductionSchedule.groupBy({
    by: ["status"],
    where: { isDeleted: false },
    _count: { _all: true },
  });
  console.log(JSON.stringify({
    inspectedLogs: logs.length,
    linkedLogs,
    updatedSchedules,
    statusSummary: statusSummary.map((item) => ({
      status: item.status,
      count: item._count._all,
    })),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
