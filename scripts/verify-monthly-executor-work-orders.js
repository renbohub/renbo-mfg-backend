"use strict";
const assert = require("node:assert/strict");
const { sumInternalRouteQuantities, allocationWorkOrderSettings, canAdjustPlannedWorkOrder, unstartedWorkOrderGuard } = require("../src/prisma/services/planning/monthlyExecutorWorkOrderPolicy");
const allocations = [
  { id: "internal", mbomProcessId: "press", status: "Draft", routingMode: "INHOUSE", plannedQty: 600 },
  { id: "vendor", mbomProcessId: "press", status: "Draft", routingMode: "VENDOR", plannedQty: 400 },
];
assert.equal(sumInternalRouteQuantities(allocations).get("press"), 600, "1000 split 600 internal / 400 vendor must create WO600");
const published = { id: "already-published", mbomProcessId: "press", status: "Published", routingMode: "INHOUSE", plannedQty: 200 };
assert.equal(sumInternalRouteQuantities([...allocations, published, published]).get("press"), 800, "published internal peer remains part of WO target and is counted once");
assert.equal(sumInternalRouteQuantities([...allocations, { ...published, isDeleted: true }]).get("press"), 600);
assert.equal(sumInternalRouteQuantities([allocations[1]]).get("press") || 0, 0, "all-vendor work must not generate an internal target");
const scoped = sumInternalRouteQuantities([{ ...allocations[0], moId: "a" }, { ...published, moId: "b" }], row => `${row.moId}|${row.mbomProcessId}`);
assert.equal(scoped.get("a|press"), 600); assert.equal(scoped.get("b|press"), 200, "distinct MOs may not share an internal target");
const route = { id: "press", processId: "p", routingMode: "VENDOR", cycleTime: 0, machinePlanningPolicy: { execution: { allowedModes: ["VENDOR", "INHOUSE"], inhouse: { machineSpecificationCode: "PRESS", cycleTime: 5, machinePlanningPolicy: { primaryMachineId: "m", resources: [{ machineId: "m", cycleTimeSeconds: 7, diesId: "d" }] } } } } };
const settings = allocationWorkOrderSettings({ ...allocations[0], machineId: "m", mbomProcess: route });
assert.equal(settings.cycleTime, 7, "WO must use qualified machine cycle seconds, not the vendor default zero");
assert.equal(settings.machineId, "m"); assert.equal(settings.diesId, "d");
assert.equal(route.cycleTime, 0, "publication must not mutate BOM defaults");
assert.equal(allocationWorkOrderSettings(allocations[1]), null);
assert.throws(() => allocationWorkOrderSettings({ ...allocations[0], mbomProcess: { ...route, machinePlanningPolicy: {} } }), { code: "EXECUTOR_INHOUSE_NOT_APPROVED" });
const planned = { id: "wo", status: "Planned", plannedQty: 1000, qtyProduced: 0, updatedAt: new Date("2026-09-01"), productionLogs: [] };
assert.equal(canAdjustPlannedWorkOrder(planned), true);
for (const change of [{ status: "Released" }, { status: "In Production" }, { startTime: new Date() }, { qtyProduced: 1 }, { qtyGood: 1 }, { qtyReject: 1 }, { shotCount: 1 }, { runningMinutes: 1 }, { diesUsageId: "started" }, { productionLogs: [{ id: "actual" }] }]) assert.equal(canAdjustPlannedWorkOrder({ ...planned, ...change }), false, `production evidence must protect WO: ${Object.keys(change)[0]}`);
const guard = unstartedWorkOrderGuard(planned);
assert.deepEqual(guard.status.in, ["Draft", "Planned"]);
assert.equal(guard.qtyProduced, 0); assert.equal(guard.startTime, null); assert.equal(guard.updatedAt, planned.updatedAt);
assert.deepEqual(guard.productionLogs, { none: { isDeleted: false } }, "database update must recheck actual evidence atomically");
console.log("PASS: 600/400 WO split, published peers, MO scope, qualified alternative cycle/tooling, full vendor zero target, active WO and concurrency protection");
