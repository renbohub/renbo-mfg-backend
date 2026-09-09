"use strict";
const assert = require("node:assert/strict");
const { resolveRoutingExecutionPolicy: resolve, inhouseRouteForExecution } = require("../src/prisma/services/planning/routingExecutionPolicy");
const clone = value => JSON.parse(JSON.stringify(value));
const machinePolicy = { primaryMachineId: "m1", mode: "SINGLE", resources: [{ machineId: "m1", diesId: "d1", cycleTimeSeconds: 6, setupMinutes: 15 }] };
const internal = { processId: "p", routingMode: "INHOUSE", machineSpecificationCode: "PRESS110", cycleTime: 6, diesId: "d1", machinePlanningPolicy: machinePolicy, mbomDetail: { partId: "part" } };
const context = {
  processes: [{ id: "p", processCode: "PRESS" }],
  machines: [{ id: "m1", machineCode: "M-001", machineName: "P-1", machineSpecificationCode: "PRESS110", status: "Active", tonnage: 110 }],
  dies: [{ id: "d1", diesCode: "D-1", status: "Active", tonnage: 100, diesParts: [{ partId: "part", isActive: true, effectiveDate: "2026-01-01", expiryDate: "2026-12-31" }] }],
  vendors: [{ id: "v1", vendorCode: "BINTANG", status: "Active" }, { id: "v2", vendorCode: "OTHER", status: "Active" }],
  vendorAssignments: [{ vendorId: "v1", entityType: "vendor", vendorProcess: { id: "vp", vendorProcessCode: "PRESS" } }],
  period: { start: "2026-09-01", end: "2026-09-30" },
};
const legacy = resolve(internal, context);
assert.deepEqual(legacy.allowedModes, ["INHOUSE"]);
assert.equal(legacy.allowSplit, false);
assert.deepEqual(legacy.errors, []);
const dual = clone(internal);
dual.machinePlanningPolicy.execution = { allowedModes: ["INHOUSE", "VENDOR"], allowSplit: true, vendorIds: ["v1"] };
const dualBefore = clone(dual);
assert.deepEqual(resolve(dual, context).eligibleVendorIds, ["v1"]);
assert.equal(resolve(dual, context).allowSplit, true);
assert.deepEqual(resolve(dual, context).errors, []);
assert.deepEqual(dual, dualBefore, "resolver must not mutate BOM masters");
const invalidVendor = clone(dual); invalidVendor.machinePlanningPolicy.execution.vendorIds = ["v2"];
assert.ok(resolve(invalidVendor, context).errors.some(error => error.includes("OTHER")));
const inactive = clone(context); inactive.vendors[0].status = "Inactive";
assert.deepEqual(resolve(dual, inactive).eligibleVendorIds, []);
const unrelated = clone(context); unrelated.vendorAssignments[0].vendorProcess.vendorProcessCode = "PAINT";
assert.ok(resolve(dual, unrelated).errors.some(error => error.includes("PRESS")));
const vendor = { processId: "p", routingMode: "VENDOR", vendorId: "v1", cycleTime: 0, mbomDetail: { partId: "part" }, machinePlanningPolicy: { execution: { allowedModes: ["VENDOR", "INHOUSE"], allowSplit: true, vendorIds: [], inhouse: { machineSpecificationCode: "PRESS110", cycleTime: 6, diesId: "d1", machinePlanningPolicy: machinePolicy } } } };
assert.deepEqual(resolve(vendor, context).errors, []);
assert.equal(resolve(vendor, context).inhouseRoute.cycleTime, 6);
assert.equal(inhouseRouteForExecution(vendor).machinePlanningPolicy.resources[0].setupMinutes, 15);
assert.equal(vendor.cycleTime, 0, "inhouse conversion must not replace vendor default");
assert.equal(inhouseRouteForExecution({ ...vendor, machinePlanningPolicy: {} }), null, "legacy vendor cannot silently become inhouse");
const missingTool = clone(vendor); missingTool.machinePlanningPolicy.execution.inhouse.machinePlanningPolicy.resources[0].diesId = null; missingTool.machinePlanningPolicy.execution.inhouse.diesId = null;
assert.ok(resolve(missingTool, context).errors.some(error => error.includes("dies/jig")));
const expired = clone(context); expired.dies[0].diesParts[0].expiryDate = "2026-08-31";
assert.ok(resolve(vendor, expired).errors.some(error => error.includes("Masa berlaku")));
const malformed = clone(dual); malformed.machinePlanningPolicy.execution.allowedModes = 7;
assert.ok(resolve(malformed, context).errors.length > 0);
const splitWithoutAlternative = clone(internal); splitWithoutAlternative.machinePlanningPolicy.execution = { allowedModes: ["INHOUSE"], allowSplit: true };
assert.ok(resolve(splitWithoutAlternative, context).errors.some(error => error.includes("Pembagian qty")));
console.log("PASS: executor permissions, vendor qualification, inhouse tooling/cycle conversion, split rules, malformed policy, immutable BOM defaults");
