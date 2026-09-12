"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const service = require("../src/prisma/services/planning/ppicExecutionWorkspaceService");
const resources = ["mps", "mrp", "monthlyProductionPlan", "dailyProductionSchedules", "productionLogs", "workOrders", "materialIssues", "wip", "stockBalances"];
const role = (scope = null) => ({ id: "reader", roleAssignments: [{ isActive: true, role: { isActive: true, isDeleted: false, permissions: resources.map(resourceCode => ({ moduleCode: "*", pageCode: "*", resourceCode, actions: ["read"], dataScope: scope })) } }] });
const schedule = () => ({ id: "dps", scheduleNumber: "DPS-1", scheduleDate: "2026-09-12", shift: "1A", plannedStartTime: "08:00", plannedEndTime: "16:00", plannedQty: 100, actualQty: 999, status: "Released", productionPlanId: "plan", productionPlanAllocationId: "alloc", mbomProcessId: "routing", woId: "wo", moId: "mo", partCode: "PART", machineId: "machine", uomCode: "PCS", productionLogs: [{ id: "approved", status: "Approved", qtyGood: 80, qtyReject: 10, qtyProduced: 90 }, { id: "pending", status: "Submitted", qtyGood: 1000, qtyReject: 20 }] });
const context = () => ({ workOrders: new Map([["wo", { status: "Material Issued" }]]), parts: new Map(), customers: new Map(), machines: new Map([["machine", { status: "Active", machineCode: "M-1" }]]), issues: [{ issueNumber: "MI-1", woId: "wo", moId: "mo", status: "Issued", notes: "[DPS-CONSUME:DPS-1]", details: [{ qtyIssued: 100, qtyReturned: 0 }] }], events: [], predecessorOutput: new Map(), allocationById: new Map([["alloc", { id: "alloc", predecessorAllocationIds: [] }]]), planTargets: new Map() });
test("execution requires each real source read permission and fails closed on data scope", () => {
  assert.doesNotThrow(() => service.assertExecutionAccess(role(), { plant: "ALL" }));
  assert.throws(() => service.assertExecutionAccess(role({ plants: ["P1"] })), { code: "PLANT_SCOPE_UNAVAILABLE" });
  const planner = role(); planner.roleAssignments[0].role.permissions = planner.roleAssignments[0].role.permissions.filter(row => row.resourceCode !== "productionLogs");
  assert.throws(() => service.assertExecutionAccess(planner), { code: "EXECUTION_FORBIDDEN" });
  const limited = role(); limited.roleAssignments[0].role.permissions.find(row => row.resourceCode === "wip").dataScope = { warehouse: ["W1"] };
  assert.throws(() => service.assertExecutionAccess(limited), { code: "PLANT_SCOPE_UNAVAILABLE" });
});
test("actual output counts approved good once and never adds reject to remaining need", () => {
  const input = schedule(); input.productionLogs.push(input.productionLogs[0]);
  const row = service.projectOperation(input, context());
  assert.equal(row.goodQty, 80); assert.equal(row.rejectQty, 10); assert.equal(row.remainingQty, 20); assert.equal(row.approvedLogCount, 1); assert.equal(row.pendingLogCount, 1);
  assert.equal(row.actual.startAt, null); assert.equal(row.baseline, null); assert.equal(row.forecast, null);
});
test("planning timestamps require evidence and overnight shift is localized once", () => {
  const interval = service.plannedInterval({ scheduleDate: "2026-09-12", plannedStartTime: "22:00", plannedEndTime: "06:00" });
  assert.equal(interval.startAt, "2026-09-12T15:00:00.000Z"); assert.equal(interval.endAt, "2026-09-12T23:00:00.000Z");
  assert.equal(service.plannedInterval({ scheduleDate: "2026-09-12", plannedStartTime: "22:00", plannedEndTime: "22:00" }), null);
  assert.equal(service.plannedInterval({ scheduleDate: "2026-09-12", plannedStartTime: "25:00", plannedEndTime: "06:00" }), null);
  assert.throws(() => service.dateKey("2026-02-30"), { code: "INVALID_EXECUTION_DATE" });
});
test("physical issue proof and predecessor approved good cannot be replaced by planned or gross output", () => {
  const ctx = context(); ctx.allocationById.set("alloc", { predecessorAllocationIds: ["before"], planId: "plan", lineNumber: 2 }); ctx.allocationById.set("before", { planId: "plan", lineNumber: 1, uomCode: "PCS" }); ctx.predecessorOutput.set("before", { goodQty: 90 });
  const row = service.projectOperation(schedule(), ctx); assert.equal(row.materialIssueStatus, "OK"); assert.equal(row.predecessorStatus, "BLOCKER");
  ctx.issues[0].details[0].qtyReturned = 100; assert.equal(service.projectOperation(schedule(), ctx).materialIssueStatus, "BLOCKER");
  ctx.allocationById.get("before").uomCode = "KG"; assert.equal(service.projectOperation(schedule(), ctx).predecessorStatus, "UNKNOWN");
});
test("machine incident is a blocker while absent operator competency remains unknown", () => {
  const ctx = context(); ctx.events.push({ machineId: "machine", eventType: "BREAKDOWN", startedAt: "2026-09-12T02:00:00Z", endedAt: null, reason: "Breakdown" });
  const row = service.projectOperation(schedule(), ctx); assert.equal(row.readiness.find(item => item.code === "MACHINE_ASSIGNMENT").status, "BLOCKER"); assert.equal(row.readiness.find(item => item.code === "OPERATOR_QUALIFICATION").status, "UNKNOWN");
  const finished = service.projectOperation({ ...schedule(), status: "Completed" }, ctx); assert.equal(finished.readinessStatus, "NA"); assert.equal(finished.goodQty, 80);
});
test("WIP physical balance does not infer qualified supply, operation, or downstream routing", () => {
  const row = service.projectLot({ id: "lot", qtyOnHand: 100, qtyReserved: 10, qtyQC: 0, qtyAvailable: 90 });
  assert.equal(row.qualityStatus, "UNKNOWN"); assert.equal(row.qtyAvailable, 90); assert.equal(row.sourceOperationId, null); assert.equal(row.nextProcess, null);
  assert.equal(service.projectLot({ qtyQC: 5 }).qualityStatus, "HOLD");
});
