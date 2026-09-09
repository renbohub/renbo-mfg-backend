"use strict";
const assert = require("node:assert/strict");
const { assertSameAllocationExecutor, assertNewAllocationExecutor } = require("../src/prisma/services/planning/allocationExecutorGuard");
const { resolveRoutingExecutionPolicy, executionPolicyErrorsForSelection } = require("../src/prisma/services/planning/routingExecutionPolicy");
const clone = value => JSON.parse(JSON.stringify(value));
const masters = {
  machines: [{ id: "m1", status: "Active", machineSpecificationCode: "LATHE", machineCode: "L-1" }, { id: "m2", status: "Active", machineSpecificationCode: "LATHE", machineCode: "L-2" }],
  dies: [], vendors: [{ id: "v1", vendorCode: "V-1", status: "Active" }, { id: "v2", vendorCode: "V-2", status: "Active" }],
  processes: [{ id: "process", processCode: "LATHE" }],
  vendorAssignments: ["v1", "v2"].map(vendorId => ({ entityType: "vendor", vendorId, vendorProcess: { vendorProcessCode: "LATHE" } })),
};
const dbFor = context => Object.fromEntries(Object.entries({ machine: "machines", dies: "dies", vendor: "vendors", process: "processes", entityVendorProcess: "vendorAssignments" }).map(([delegate, collection]) => [delegate, { findMany: async () => context[collection] }]));
const route = { id: "r", processId: "process", routingMode: "INHOUSE", machineSpecificationCode: "LATHE", cycleTime: 6, machinePlanningPolicy: { primaryMachineId: "m1", mode: "SINGLE", resources: [{ machineId: "m1", cycleTimeSeconds: 6 }], execution: { allowedModes: ["INHOUSE", "VENDOR"], vendorIds: ["v1", "v2"], allowSplit: true } } };
async function main() {
  assert.doesNotThrow(() => assertSameAllocationExecutor({ routingMode: "INHOUSE" }, { routingMode: "INHOUSE" }));
  for (const [source, change] of [[{ routingMode: "INHOUSE" }, { routingMode: "VENDOR", vendorId: "v1" }], [{ routingMode: "VENDOR", vendorId: "v1" }, { routingMode: "INHOUSE" }], [{ routingMode: "VENDOR", vendorId: "v1" }, { vendorId: "v2" }]]) assert.throws(() => assertSameAllocationExecutor(source, change), { code: "EXECUTOR_USE_CHANGE_ACTION" });
  const legacy = { ...route, machinePlanningPolicy: {} };
  assert.equal((await assertNewAllocationExecutor({}, legacy, { routingMode: "INHOUSE", machineId: "m2" })).route, legacy, "legacy same-mode scheduling keeps existing machine-specification behavior");
  assert.equal((await assertNewAllocationExecutor({}, legacy, { routingMode: "INHOUSE", machineId: "m2" }, { existing: { routingMode: "INHOUSE" } })).resource, null);
  await assert.rejects(() => assertNewAllocationExecutor({}, legacy, { routingMode: "VENDOR", vendorId: "v1" }), { code: "EXECUTOR_MODE_NOT_ALLOWED" });
  await assert.rejects(() => assertNewAllocationExecutor({}, { routingMode: "VENDOR", vendorId: "v1" }, { routingMode: "VENDOR", vendorId: "v2" }), { code: "EXECUTOR_MODE_NOT_ALLOWED" });
  const db = dbFor(masters);
  assert.equal((await assertNewAllocationExecutor(db, route, { routingMode: "INHOUSE", machineId: "m1" })).resource.machineId, "m1");
  await assert.rejects(() => assertNewAllocationExecutor(db, route, { routingMode: "INHOUSE", machineId: "m2" }), { code: "EXECUTOR_POLICY_INVALID" }, "configured routing must reject an unqualified machine even when its specification matches");
  const engineeringOnly = clone(route); delete engineeringOnly.machinePlanningPolicy.execution;
  await assert.rejects(() => assertNewAllocationExecutor(db, engineeringOnly, { routingMode: "INHOUSE", machineId: "m2" }, { existing: { routingMode: "INHOUSE" } }), { code: "EXECUTOR_POLICY_INVALID" }, "existing approved machine resources must apply even before executor alternatives are configured");
  assert.equal((await assertNewAllocationExecutor(db, route, { routingMode: "VENDOR", vendorId: "v1" })).policy.defaultMode, "INHOUSE");
  const stopped = clone(masters); stopped.machines[0].status = "Inactive";
  const stoppedPolicy = resolveRoutingExecutionPolicy(route, stopped);
  assert.ok(stoppedPolicy.errors.length);
  assert.deepEqual(executionPolicyErrorsForSelection(stoppedPolicy, [{ routingMode: "VENDOR", vendorId: "v1" }]), [], "machine-down must still allow a qualified vendor alternative");
  await assertNewAllocationExecutor(dbFor(stopped), route, { routingMode: "VENDOR", vendorId: "v1" });
  const staleVendor = clone(masters); staleVendor.vendors[0].status = "Inactive";
  const vendorPolicy = resolveRoutingExecutionPolicy(route, staleVendor);
  assert.deepEqual(executionPolicyErrorsForSelection(vendorPolicy, [{ routingMode: "VENDOR", vendorId: "v2" }]), [], "an unselected stale vendor must not block a healthy selected vendor");
  assert.deepEqual(executionPolicyErrorsForSelection(vendorPolicy, [{ routingMode: "INHOUSE", machineId: "m1" }]), []);
  assert.ok(executionPolicyErrorsForSelection(vendorPolicy, [{ routingMode: "VENDOR", vendorId: "v1" }]).length);
  await assert.rejects(() => assertNewAllocationExecutor(dbFor(staleVendor), route, { routingMode: "VENDOR", vendorId: "v1" }), { code: "EXECUTOR_POLICY_INVALID" });
  const malformed = clone(route); malformed.machinePlanningPolicy.execution.allowedModes = ["VENDOR"];
  assert.ok(executionPolicyErrorsForSelection(resolveRoutingExecutionPolicy(malformed, masters), [{ routingMode: "VENDOR", vendorId: "v1" }]).length, "global BOM permission errors always apply");
  console.log("PASS: old-path mode/vendor change rejection, legacy same-mode scheduling, explicit machine/vendor qualification, selected-mode health and global permission checks");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
