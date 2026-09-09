"use strict";
process.env.NODE_ENV = "test";
const assert = require("node:assert/strict");
const store = require("../src/prisma/services/purchasing/etaConfirmationStore");
const mps = require("../src/prisma/services/planning/mpsEtaService");
const evidence = require("../src/prisma/services/planning/mpsProductionEvidenceService");
const monitor = require("../src/prisma/services/purchasing/etaMonitorService");
const service = require("../src/prisma/services/purchasing/etaConfirmationService");
const base = { id: "VO:order-1", source: "VO-1", code: "PART", partnerCode: "V001", qty: 100, uom: "PCS", needDate: "2026-09-20", targetArrivalDate: "2026-09-20", eta: null, sourceVersion: "v1" };
const row = store.decorate(base);
const input = { id: row.id, month: "2026-09", qty: 100, eta: "2026-09-18", reference: "Vendor PIC / email 06 Sep", requestId: "eta-test-request-001", sourceFingerprint: row.sourceFingerprint };
const values = store.validate(input, row);
assert.equal(values.qty, 100);
for (const patch of [{ qty: 0 }, { qty: Infinity }, { eta: "2026-02-30" }, { reference: " " }, { readyDate: "2026-09-17" }, { sourceFingerprint: "stale" }]) assert.throws(() => store.validate({ ...input, ...patch }, row));
assert.throws(() => store.validate(input, { ...row, requiresQc: true }), /setelah QC/);
assert.equal(store.readiness({ ...row, confirmed: true, confirmedQty: 50, eta: input.eta }).ready, false);
assert.equal(store.readiness({ ...row, confirmed: true, confirmedQty: 100, eta: "2026-09-21" }).ready, false);
assert.equal(store.readiness({ ...row, confirmed: true, confirmedQty: 100, eta: input.eta }).ready, true);
const record = { ...values, sourceFingerprint: row.sourceFingerprint, confirmationReference: input.reference };
assert.equal(store.decorate(base, record).confirmed, true);
for (const patch of [{ qty: 110 }, { partnerCode: "V002" }, { needDate: "2026-09-19" }, { sourceVersion: "v2" }]) assert.equal(store.decorate({ ...base, confirmed: true, ...patch }, record).confirmed, false);
const doc = { mpsNumber: "MPS-202609", revision: 2, periodStart: "2026-09-01", details: [{ id: "detail-1", partCode: "FG", qtyPlanned: 100, mbomHeaderId: "BOM-1", part: { partName: "Product", baseUomCode: "PCS" }, calculationTrace: { productionChecksheet: { version: evidence.VERSION, sourceKey: "current", mpsRevision: 2, mbomHeaderId: "BOM-1", phases: { phase1: { complete: true, plannedProductionQty: 100, materialCoverage: [
  { partCode: "RAW", qty: 20, shortageQty: 8, supplierCode: "S001", requiredDate: "2026-09-15", uomCode: "KG" },
  { partCode: "OWNED", qty: 10, shortageQty: 0, requiredDate: "2026-09-15" },
  { partCode: "CUSTOMER", qty: 5, shortageQty: 5, materialSupplyType: "CUSTOMER_SUPPLIED", supplyCustomerCode: "C001", requiredDate: "2026-09-15" },
], processTimeline: [{ routingMode: "VENDOR", processCode: "PAINT", partCode: "COMPONENT", qty: 100, uomCode: "PCS", vendorCode: "V001", latestStartDate: "2026-09-16", latestFinishDate: "2026-09-20" }, { routingMode: "INHOUSE", processCode: "PACK" }] } } } } }] };
const requirements = mps.buildRows(doc, "current");
assert.equal(requirements.length, 3); assert.equal(requirements[0].qty, 8); assert.equal(requirements[1].partnerCode, "C001"); assert.equal(requirements[2].qty, 100);
assert.equal(mps.buildRows(doc, "stale")[0].checkOnly, true);
assert.equal(mps.buildRows({ ...doc, revision: 3 }, "current")[0].canConfirm, false);
const broken = structuredClone(doc); broken.details[0].qtyPlanned = 110;
assert.equal(mps.buildRows(broken, "current")[0].checkOnly, true);
assert.equal(mps.summary(requirements.map((r) => ({ ...r, readiness: store.readiness(r) }))).pending, 3);
const originalList = monitor.list;
const records = [];
let mutableSource = { ...base };
const db = { etaConfirmation: {
  findUnique: async ({ where }) => records.find((r) => r.requestId === where.requestId) || null,
  create: async ({ data }) => { const saved = { ...data, id: `c${records.length}`, confirmedAt: new Date() }; records.push(saved); return saved; },
} };
monitor.list = async () => ({ items: [store.decorate(mutableSource, records.at(-1))] });
(async () => {
  const result = await service.confirm(db, "vendor-orders", input, { username: "test" });
  assert.equal(result.item.confirmed, true); assert.equal(result.item.readiness.ready, true);
  assert.equal(mutableSource.needDate, base.needDate); assert.equal(mutableSource.eta, null, "commitments cannot alter planning targets / receipts");
  assert.equal(records[0].confirmedBy, "test");
  assert.equal((await service.confirm(db, "vendor-orders", input, { username: "test" })).duplicate, true); assert.equal(records.length, 1);
  await assert.rejects(service.confirm(db, "vendor-orders", { ...input, qty: 50 }, { username: "test" }), /berbeda/);
  mutableSource = { ...base, qty: 120 };
  await assert.rejects(service.confirm(db, "vendor-orders", { ...input, confirmationId: records[0].id, requestId: "eta-test-request-002" }, {}), /berubah/);
  assert.equal(records.length, 1);
  console.log("PASS ETA: revision/partner/qty/date invalidation; missing, partial, late and QC gates; MPS BOM shortage and vendor tasks; idempotency; audit; unchanged targets and receipts.");
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { monitor.list = originalList; await require("../src/prisma").disconnectDatabase(); });
