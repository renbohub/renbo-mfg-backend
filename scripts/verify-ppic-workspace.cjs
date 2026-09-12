"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const d = require("../src/prisma/services/planning/ppicWorkspaceDomain");
const service = require("../src/prisma/services/planning/ppicWorkspaceService");
const scenario = require("../src/prisma/services/planning/ppicWorkspaceScenarioService");
const user = { id: "fixture-actor", username: "ppic-test", isSuperAdmin: true };
const role = (scope = null, actions = ["read", "create", "update"]) => ({ id: "planner", roleAssignments: [{ isActive: true, role: { isActive: true, isDeleted: false, permissions: ["mps", "mrp", "monthlyProductionPlan"].map(resourceCode => ({ moduleCode: "planning-ppic", pageCode: "master-production-schedule", resourceCode, actions, dataScope: scope, isActive: true, isDeleted: false })) } }] });
const seed = { version: 1, month: "2026-09", mpsNumber: "MPS-202609", fingerprint: "a".repeat(64), horizonStart: "2026-08-01", horizonEnd: "2026-10-01", nodes: [{ id: "fg", kind: "fg", qty: 100 }, { id: "op", kind: "process", machineOptions: [{ machineId: "m1" }] }, { id: "raw", kind: "material" }, { id: "out", kind: "vendor" }], vendors: [{ id: "v1" }] };
const input = () => ({ name: "Skenario uji", month: "2026-09", sourceIdentifier: "MONTH:2026-09", sourceFingerprint: seed.fingerprint, operationId: "workspace-operation-0001", payload: { version: 1, overrides: { fg: { qty: 123 } } } });

test("read access needs all planning resources and rejects unsupported plant scope", () => {
  assert.doesNotThrow(() => d.assertAccess(role(), { plant: "ALL" }));
  assert.throws(() => d.assertAccess(null), { statusCode: 401 });
  assert.throws(() => d.assertAccess({ id: "none" }), { statusCode: 403 });
  assert.throws(() => d.assertAccess(user, { plant: "PLANT-A" }), { code: "PLANT_SCOPE_UNAVAILABLE" });
  assert.throws(() => d.assertAccess(role({ plantCodes: ["A"] })), { code: "PLANT_SCOPE_UNAVAILABLE" });
  assert.throws(() => d.assertAccess(role({ type: "ALL", plantCodes: ["A"] })), { code: "PLANT_SCOPE_UNAVAILABLE" });
});
test("read permission does not grant scenario create/update; scoped writes do not use broad reads", () => {
  const reader = role(null, ["read"]);
  assert.doesNotThrow(() => d.assertAccess(reader));
  assert.throws(() => d.assertAccess(reader, {}, "create"), { statusCode: 403 });
  assert.equal(d.capabilities(reader).scenarioCreate, false);
  const mixed = role(null, ["read"]); mixed.roleAssignments[0].role.permissions.push({ moduleCode: "planning-ppic", pageCode: "master-production-schedule", resourceCode: "monthlyProductionPlan", actions: ["update"], dataScope: { plants: ["A"] } });
  assert.throws(() => d.assertAccess(mixed, {}, "update"), { code: "PLANT_SCOPE_UNAVAILABLE" });
});
test("scenario inputs require explicit revision, operation identity and server snapshot", () => {
  assert.equal(d.normalizeScenario(input()).overrides.fg.qty, 123);
  assert.throws(() => d.normalizeScenario({ ...input(), operationId: "" }), { code: "OPERATION_ID_REQUIRED" });
  assert.throws(() => d.normalizeScenario(input(), true), { code: "REVISION_REQUIRED" });
  assert.throws(() => d.normalizeScenario({ ...input(), payload: { version: 1, overrides: {}, seed } }), { code: "CLIENT_SEED_FORBIDDEN" });
  assert.throws(() => d.normalizeScenario({ ...input(), month: "2026-13" }), { code: "INVALID_MONTH" });
});
test("override allowlist protects graph topology, quantity derivation and qualified resources", () => {
  assert.deepEqual(d.validateOverrides(seed, { fg: { qty: 123 }, op: { machineId: "m1", cycleSeconds: 4, efficiency: .8, downtime: { setup: 10 } }, raw: { availableDate: "2026-09-01", leadDays: 3 }, out: { vendorId: "v1" } }).fg, { qty: 123 });
  for (const overrides of [{ missing: { qty: 10 } }, { op: { dependencies: [] } }, { op: { qty: 10 } }, { fg: { qty: -1 } }, { fg: { qty: "123" } }, { fg: { qty: Infinity } }, { op: { efficiency: 0 } }, { op: { machineId: "unqualified" } }, { out: { vendorId: "unknown" } }, { raw: { availableDate: "2026-02-30" } }, { fg: { targetDate: "2026-10-01" } }, { op: { downtime: { forged: 20 } } }]) assert.throws(() => d.validateOverrides(seed, overrides), { statusCode: 400 });
});
test("effective demand consolidates shared target IDs without summing unlike UOM or counting forecast again", () => {
  const calendar = { items: [{ customerCode: "C", partCode: "FG", uomCode: "PCS", effectiveDeliverySplits: [{ deliveryTargetId: "SO1", sourceType: "SALES_ORDER", sourceNumber: "SO-1", targetDate: "2026-09-10", qty: 60, deliveredQty: 20, remainingQty: 40, matchedForecastTargetId: "FC1" }, { deliveryTargetId: "FC1", sourceType: "FORECAST", sourceNumber: "FC-1", targetDate: "2026-09-20", qty: 40, deliveredQty: 0, remainingQty: 40 }] }, { customerCode: "C", partCode: "FG", uomCode: "PCS", effectiveDeliverySplits: [{ deliveryTargetId: "SO1", sourceType: "SALES_ORDER", sourceNumber: "SO-1", targetDate: "2026-09-10", qty: 10, deliveredQty: 0, remainingQty: 10, matchedForecastTargetId: "FC2" }] }] };
  const workbench = { items: [{ phases: [{ deliveryTargetId: "SO1", stockUsedQty: 15, customerProductionQty: 35, checklistSummary: { status: "NOT_EVALUATED" } }] }] };
  const rows = service.projectDemand(calendar, [{ id: "SO1", sourceLineId: "line1" }, { id: "FC1", sourceLineId: "line2" }], [], [], workbench, "2026-09");
  assert.equal(rows.length, 2); assert.equal(rows[0].qty, 70); assert.equal(rows[0].consumedForecastQty, 70); assert.equal(rows[0].remainingQty, 50); assert.equal(rows[0].allocatedStockQty, 15); assert.equal(rows[0].netNeedQty, 35); assert.equal(rows[0].status, "UNKNOWN"); assert.equal(rows[1].allocatedStockQty, null);
  assert.deepEqual(d.totalsByUom([...rows, { uom: "KG", qty: 3 }]), [{ uom: "PCS", qty: 110 }, { uom: "KG", qty: 3 }]);
});
test("empty or stale planning inputs cannot become green readiness", () => {
  const empty = service.projectReadiness({ items: [], mps: null }, [], [], { asOf: null, stale: false });
  assert.ok(empty.every(row => row.status === "UNKNOWN")); assert.ok(empty.every(row => row.completeness.percent === null || row.completeness.percent === 0));
  const stale = service.projectReadiness({ items: [], mps: { replanReason: "Changed" } }, [], [], { asOf: null, stale: true });
  assert.equal(stale.find(row => row.id === "version").status, "BLOCKER");
  const partial = service.projectReadiness({ items: [{ partCode: "FG", feasibilityAssessment: { checks: [{ code: "MASTER_DATA_READY", status: "UNRECOGNIZED", reason: "No evidence" }] } }] }, [], [], { asOf: null, stale: false });
  assert.equal(partial.find(row => row.id === "bom-routing").completeness.complete, 0);
  const missingProgress = service.projectDemand({ items: [{ partCode: "FG", effectiveDeliverySplits: [{ deliveryTargetId: "T", targetDate: "2026-09-10", qty: 10 }] }] }, [], [], [], { items: [] }, "2026-09");
  assert.equal(missingProgress[0].deliveredQty, null); assert.equal(missingProgress[0].remainingQty, null);
});
test("scenario seed enforces permissions before any calculation and validates returned month", async () => {
  let called = 0;
  const dependencies = { seed: async () => { called++; return seed; } };
  await assert.rejects(() => scenario.seed({}, { month: "2026-09" }, role({ plantCodes: ["A"] }), dependencies), { statusCode: 403 }); assert.equal(called, 0);
  await assert.rejects(() => scenario.seed({}, { month: "2026-08" }, user, dependencies), { code: "SNAPSHOT_MONTH_MISMATCH" });
});
test("current V3 checksheet evidence reaches readiness; absent evaluation has unknown affected count", () => {
  const rows = service.projectReadiness({ items: [{ partCode: "FG", feasibilityAssessment: { checks: [{ code: "MPS_MATERIAL", status: "FAIL", reason: "Material terlambat", evidence: [{ partCode: "RAW", shortageQty: 5 }] }, { code: "MPS_CAPACITY", status: "PASS", actual: { value: 8, unit: "hour" } }, { code: "MPS_VENDOR", status: "NA", reason: "Tidak ada proses vendor." }] } }] }, [{ partCode: "FG" }], [], { datasetUpdatedAt: {} });
  assert.equal(rows.find(row => row.id === "material").status, "BLOCKER");
  assert.equal(rows.find(row => row.id === "material").evidence[0].evidence[0].shortageQty, 5);
  assert.equal(rows.find(row => row.id === "resource").completeness.percent, 100);
  assert.equal(rows.find(row => row.id === "vendor-lead-time").status, "NA");
  assert.equal(rows.find(row => row.id === "inventory").affectedDeliveryCount, null);
});
test("workspace UTC text timestamps override the shifted raw Prisma driver dates", () => {
  const row = scenario.publicRow({ created_at: new Date("2026-09-12T12:00:00Z"), updated_at: new Date("2026-09-12T13:00:00Z"), created_at_utc: "2026-09-12T05:00:00.123Z", updated_at_utc: "2026-09-12T06:00:00.456Z" });
  assert.equal(row.createdAt, "2026-09-12T05:00:00.123Z"); assert.equal(row.updatedAt, "2026-09-12T06:00:00.456Z");
});
