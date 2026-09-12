"use strict";
const n = value => Number(value) || 0;
const day = value => new Date(value).toISOString().slice(0, 10);
function aggregate({ schedules = [], logs = [], machines = [], processes = [], vendors = [] }, month) {
  const machineById = new Map(machines.map(row => [row.id, row.machineCode]));
  const processById = new Map(processes.map(row => [row.id, row.processCode]));
  const groups = new Map();
  function ensure(resource, partCode, processCode, unit = "PCS") {
    unit = String(unit || "PCS").trim().toUpperCase();
    const key = JSON.stringify([resource, partCode, processCode, unit]);
    if (!groups.has(key)) groups.set(key, { key, resource, partCode, processCode, unit, days: {}, sources: [], target: 0, good: 0, ng: 0, downtime: 0 });
    return groups.get(key);
  }
  function cell(row, date) { return row.days[date] ||= { target: 0, good: 0, ng: 0, downtime: 0, sources: [] }; }
  for (const schedule of schedules) {
    const row = ensure(machineById.get(schedule.machineId) || schedule.vendor?.vendorCode || "Belum ada mesin", schedule.partCode, schedule.mbomProcess?.process?.processCode || processById.get(schedule.processId) || "—", schedule.uomCode);
    const value = cell(row, day(schedule.scheduleDate));
    value.target += n(schedule.plannedQty); row.target += n(schedule.plannedQty);
    value.sources.push({ type: "DPP", number: schedule.scheduleNumber, woNumber: schedule.woNumber, shift: schedule.shift, target: n(schedule.plannedQty) });
  }
  for (const log of logs) {
    const row = ensure(log.machineCode || "Belum ada mesin", log.dailyProductionSchedule?.partCode || log.workOrder?.partCode || log.manufacturingOrder?.partCode || "—", log.processCode || "—", log.dailyProductionSchedule?.uomCode || log.workOrder?.uomCode || log.manufacturingOrder?.uomCode || "PCS");
    const value = cell(row, day(log.logDate));
    for (const [field, source] of [["good", "qtyGood"], ["ng", "qtyReject"], ["downtime", "downtime"]]) { value[field] += n(log[source]); row[field] += n(log[source]); }
    value.sources.push({ type: "LOG", number: log.logNumber, woNumber: log.workOrder?.woNumber, shift: log.shift, good: n(log.qtyGood), ng: n(log.qtyReject), downtime: n(log.downtime) });
  }
  for (const row of groups.values()) { row.shortfall = Math.max(row.target - row.good, 0); row.sources = Object.values(row.days).flatMap(value => value.sources); }
  return { month, rows: [...groups.values()], vendors: vendors.map(row => ({ vendorCode: row.vendorCode, partCode: row.outputPartCode, processCode: row.processCode, unit: row.uomCode, dueDate: row.dueDate, orderNumber: row.orderNumber, target: row.qtyPlanned, sent: row.qtySent, received: row.qtyReceived, acceptedPosition: row.qtyAccepted, ng: row.qtyReject, status: row.status })) };
}
async function snapshot(tx, month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || "")) throw Object.assign(new Error("Periode harus YYYY-MM."), { statusCode: 400 });
  const start = new Date(`${month}-01T00:00:00Z`), end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  const [schedules, logs, machines, processes, vendors] = await Promise.all([
    tx.dailyProductionSchedule.findMany({ where: { isDeleted: false, scheduleDate: { gte: start, lt: end }, status: { notIn: ["Cancelled", "Superseded"] } }, include: { mbomProcess: { include: { process: true } }, vendor: true } }),
    tx.productionLog.findMany({ where: { isDeleted: false, logDate: { gte: start, lt: end }, status: "Approved" }, include: { manufacturingOrder: true, workOrder: true, dailyProductionSchedule: true } }),
    tx.machine.findMany({ select: { id: true, machineCode: true } }), tx.process.findMany({ select: { id: true, processCode: true } }),
    tx.vendorProcessOrder.findMany({ where: { isDeleted: false, dueDate: { gte: start, lt: end }, status: { not: "Cancelled" } } }),
  ]);
  return aggregate({ schedules, logs, machines, processes, vendors }, month);
}
module.exports = { aggregate, snapshot };
