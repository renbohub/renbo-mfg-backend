"use strict";
const { inhouseRouteForExecution } = require("./routingExecutionPolicy");
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;

function sumInternalRouteQuantities(allocations, keyOf = row => row.mbomProcessId || row.mbomProcess?.id) {
  const quantities = new Map();
  const seen = new Set();
  for (const row of allocations) {
    if (row.isDeleted || !["Draft", "Published"].includes(row.status) || String(row.routingMode || "INHOUSE").toUpperCase() === "VENDOR") continue;
    if (row.id && seen.has(row.id)) continue;
    if (row.id) seen.add(row.id);
    const key = keyOf(row);
    if (!key) continue;
    quantities.set(key, number(quantities.get(key)) + number(row.plannedQty));
  }
  return quantities;
}

function allocationWorkOrderSettings(allocation) {
  if (String(allocation.routingMode || "INHOUSE").toUpperCase() === "VENDOR") return null;
  const route = inhouseRouteForExecution(allocation.mbomProcess);
  if (!route) throw Object.assign(new Error("Produksi in-house belum diizinkan pada routing BOM vendor."), { statusCode: 409, code: "EXECUTOR_INHOUSE_NOT_APPROVED" });
  const machineId = allocation.machineId || route.machinePlanningPolicy?.primaryMachineId || route.machineId || null;
  const resource = route.machinePlanningPolicy?.resources?.find(item => item.machineId === machineId);
  return { route, machineId, diesId: allocation.diesId || resource?.diesId || route.diesId || null, cycleTime: number(resource?.cycleTimeSeconds ?? route.cycleTime) };
}

function canAdjustPlannedWorkOrder(workOrder) {
  return Boolean(workOrder && !workOrder.isDeleted && ["Draft", "Planned"].includes(workOrder.status) &&
    !workOrder.startTime && !workOrder.endTime && !workOrder.diesUsageId &&
    ["qtyProduced", "qtyGood", "qtyReject", "shotCount", "runningMinutes", "actualProcessCost"].every(field => number(workOrder[field]) === 0) &&
    !(workOrder.productionLogs || []).some(log => !log.isDeleted));
}

function unstartedWorkOrderGuard(workOrder) {
  return { id: workOrder.id, isDeleted: false, status: { in: ["Draft", "Planned"] },
    ...(workOrder.updatedAt ? { updatedAt: workOrder.updatedAt } : {}),
    startTime: null, endTime: null, diesUsageId: null, qtyProduced: 0, qtyGood: 0, qtyReject: 0, shotCount: 0, actualProcessCost: 0,
    OR: [{ runningMinutes: null }, { runningMinutes: 0 }], productionLogs: { none: { isDeleted: false } } };
}

module.exports = { sumInternalRouteQuantities, allocationWorkOrderSettings, canAdjustPlannedWorkOrder, unstartedWorkOrderGuard };
