"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const service = require("../src/prisma/services/planning/ppicExecutionFollowupService"), eta = require("../src/prisma/services/purchasing/etaConfirmationStore");
const actor = { id: "reader", isSuperAdmin: true }, now = new Date("2026-09-12T00:00:00Z");
const vendor = { id: "vendor-1", orderNumber: "VO1", updatedAt: new Date("2026-09-10T01:00:00Z"), vendorCode: "V1", outputPartCode: "P1", processCode: "PLATING", uomCode: "PCS", qtyPlanned: 100, qtySent: 100, qtyReceived: 80, qtyAccepted: 60, qtyReject: 5, qtyRework: 3, qtyScrap: 2, dueDate: new Date("2026-09-15T00:00:00Z"), sentAt: new Date("2026-09-10T00:00:00Z"), status: "Partial Received" };
const spec = service.normalize("delivery-fulfillment", { month: "2026-09" }, now);
function database(patch = {}) {
  let touched = false;
  const tx = { $executeRaw: async strings => { assert.equal(strings[0], "SET TRANSACTION READ ONLY"); }, $queryRaw: async () => [], vendorProcessOrder: { findMany: async () => [] }, etaConfirmation: { findMany: async () => [] }, demandException: { findMany: async () => [] }, mpsRecoveryRequest: { findMany: async () => [] }, dailyPlanRevision: { findMany: async () => [] }, productionLog: { findMany: async () => [] }, stockOpnameDetail: { findMany: async () => [] }, deliveryScheduleDetail: { findMany: async () => [] }, systemSetting: { findUnique: async () => null }, ...patch };
  return { get touched() { return touched; }, $transaction: async (fn, options) => { touched = true; assert.equal(options.isolationLevel, "RepeatableRead"); return fn(tx); } };
}
test("source permission and scoped roles block before any read", async () => {
  const db = database(), planning = ["mps", "mrp", "monthlyProductionPlan"].map(resource => ({ resource, actions: ["read"] }));
  await assert.rejects(service.snapshot(db, "subcontract-control", { month: "2026-09" }, { listMenu: planning }), { code: "FOLLOWUP_FORBIDDEN", statusCode: 403 }); assert.equal(db.touched, false);
  const rolePermissions = [...planning.map(p => ({ resourceCode: p.resource, actions: p.actions })), { resourceCode: "vendorProcessOrders", actions: ["read"], dataScope: { customerCode: "C1" } }];
  await assert.rejects(service.snapshot(db, "subcontract-control", { month: "2026-09" }, { roleAssignments: [{ isActive: true, role: { isActive: true, permissions: rolePermissions } }] }), { code: "PLANT_SCOPE_UNAVAILABLE" }); assert.equal(db.touched, false);
  await assert.rejects(service.snapshot(db, "change-control", { month: "2026-09", plant: "PLANT-A" }, actor), { code: "PLANT_SCOPE_UNAVAILABLE" });
});
test("invalid dates and unavailable scope filters are rejected explicitly", () => {
  for (const query of [{ date: "2026-02-31" }, { month: "2026-13" }, { month: "2026-09", date: "2026-08-31" }, { q: [] }]) assert.throws(() => service.normalize("subcontract-control", query, now));
  assert.throws(() => service.normalize("subcontract-control", { customer: "C1" }, now), { code: "FOLLOWUP_FILTER_UNAVAILABLE" });
  assert.throws(() => service.normalize("delivery-fulfillment", { resource: "M1" }, now), { code: "FOLLOWUP_FILTER_UNAVAILABLE" });
  assert.equal(service.normalize("delivery-fulfillment", { customer: "C1" }, now).filters.customer, "C1");
});
test("E07 accepts exact owner-page role grants without unrelated production permissions", () => {
  const planning = ["mps", "mrp", "monthlyProductionPlan"].map(resourceCode => ({ resourceCode, actions: ["read"] }));
  const user = { roleAssignments: [{ isActive: true, role: { isActive: true, permissions: [...planning,
    { resourceCode: "*", moduleCode: "outgoing", pageCode: "delivery-schedules", actions: ["read"] },
    { resourceCode: "*", moduleCode: "sales", pageCode: "forecasts", actions: ["read"] },
  ] } }] };
  assert.doesNotThrow(() => service.assertAccess(user, "delivery-fulfillment", {}));
  user.roleAssignments[0].role.permissions.at(-1).dataScope = { customer: "C1" };
  assert.throws(() => service.assertAccess(user, "delivery-fulfillment", {}), { code: "PLANT_SCOPE_UNAVAILABLE" });
});
test("vendor positions retain partial receipt and do not double count reject disposition", () => {
  const r = service.vendorPosition(vendor);
  assert.equal(r.pendingQcQty, 15); assert.equal(r.notReturnedQty, 20); assert.equal(r.acceptedQty, 60);
  assert.equal(r.operationId, null); assert.equal(r.positionBasis, "CUMULATIVE_VENDOR_ORDER"); assert.equal(r.eta, null);
  const invalid = service.vendorPosition({ ...vendor, qtyAccepted: 100 });
  assert.equal(invalid.integrityStatus, "BLOCKER"); assert.equal(invalid.pendingQcQty, null);
});
test("ETA requires exact current source fingerprint and never substitutes the deadline", () => {
  const confirmation = { id: "C1", sourceFingerprint: eta.fingerprint(service.vendorSource(vendor)), qty: 100, eta: "2026-09-14", confirmationReference: "vendor email", confirmedAt: "2026-09-11T03:00:00Z" };
  const r = service.vendorPosition(vendor, confirmation); assert.equal(r.confirmationStatus, "CONFIRMED"); assert.equal(r.eta, "2026-09-14");
  const stale = service.vendorPosition({ ...vendor, qtyPlanned: 101 }, confirmation); assert.equal(stale.confirmationStatus, "STALE"); assert.equal(stale.eta, null); assert.equal(stale.confirmation.valid, false);
});
test("effective demand slices combine one delivery identity without fabricating fulfillment", () => {
  const row = { id: "F1", partCode: "P1", uomCode: "PCS", customerCode: "C1", actualSalesOrders: [{ deliveryTargetId: "D1", sourceLineId: "SL1", sourceNumber: "SO1", deliveredQty: 900 }], effectiveDeliverySplits: [{ sourceType: "SALES_ORDER", sourceNumber: "SO1", deliveryTargetId: "D1", targetDate: "2026-09-18", qty: 60 }] };
  const r = service.demandItems([row, { ...row, id: "F2", effectiveDeliverySplits: [{ ...row.effectiveDeliverySplits[0], qty: 40 }] }], spec);
  assert.equal(r.length, 1); assert.equal(r[0].committedQty, 100); assert.equal(r[0].sourceLineId, "SL1");
  assert.equal(r[0].shippedQty, null); assert.equal(r[0].outstandingQty, null); assert.equal(r[0].allocatedGoodQty, null);
});
test("shipment position is not customer receipt proof and actualDate is not receivedAt", () => {
  const r = service.shipmentPosition({ id: "S1", soDetailId: "SL1", qty: 100, qtyDelivered: 60, schedule: { scheduleNumber: "DS1", status: "Delivered", actualDate: "2026-09-18", deliveredAt: null }, soDetail: { uomCode: "PCS" } });
  assert.equal(r.lineRemainingQty, 40); assert.equal(r.receivedAt, null); assert.equal(r.podEvidenceStatus, "UNKNOWN"); assert.equal(r.customerAcceptedQty, null); assert.equal(r.customerOtif, null);
});
test("unlike or unknown UOM is never added into a single quantity", () => {
  assert.deepEqual(service.unitTotals([{ uom: "PCS", qty: 10 }, { uom: "KG", qty: 2.5 }, { uom: null, qty: 99 }, { uom: "PCS", qty: -1 }]), [{ uom: "PCS", qty: 10 }, { uom: "KG", qty: 2.5 }]);
});
test("uncounted stock remains UNKNOWN even when default variance is zero", async () => {
  const stock = { id: "ST1", actualQty: null, systemQty: 100, varianceQty: 0, uomCode: "PCS", header: { stoNo: "STO1", status: "COUNTING", stoDate: "2026-09-12" } };
  assert.equal(service.stockVariance(stock), null);
  const db = database({ stockOpnameDetail: { findMany: async () => [stock] }, systemSetting: { findUnique: async () => ({ settingValue: JSON.stringify({ status: "CLOSED", closedAt: "2026-09-30T16:00:00Z" }) }) } });
  const r = await service.snapshot(db, "reconciliation-closure", { month: "2026-09" }, actor, { now });
  assert.equal(r.items[0].varianceQty, null); assert.equal(r.items[0].status, "UNKNOWN"); assert.equal(r.planningPeriodState.status, "CLOSED"); assert.equal(r.readiness.canClose, false); assert.equal(r.capabilities.close, false); assert.equal(r.readiness.status, "UNKNOWN");
});
test("empty sources never certify readiness and all five snapshots remain read only", async () => {
  for (const page of Object.keys(service.PAGES)) {
    const r = await service.snapshot(database(), page, { month: "2026-09" }, actor, { now, buildDemandRows: async () => [] });
    assert.equal(r.readiness.status, "UNKNOWN"); assert.equal(r.readiness.canRelease, false); assert.equal(r.capabilities.mutate, false); assert.equal(r.scope.historicalAsOf, false);
  }
});
test("effective demand source is consumed across full horizon before display-month filtering", async () => {
  let query;
  const r = await service.snapshot(database(), "delivery-fulfillment", { month: "2026-09" }, actor, { now, buildDemandRows: async (_tx, filters) => { query = filters; return []; } });
  assert.deepEqual(query, {}); assert.equal(r.summary.find(m => m.id === "customer_otif").value, null);
});
