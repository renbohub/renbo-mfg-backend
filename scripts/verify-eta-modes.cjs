"use strict";
const assert = require("node:assert/strict");
const bom = require("../src/prisma/services/purchasing/etaBomService");
const store = require("../src/prisma/services/purchasing/etaConfirmationStore");
const mode = require("../src/prisma/services/purchasing/etaModeService");
const monitor = require("../src/prisma/services/purchasing/etaMonitorService");
const base = { id: "MPSM:D:P:0", source: "MPS-SEP", mpsNumber: "MPS-SEP", bomId: "BOM-PINNED", etaMode: "BOM", mpsRevision: 1,
  partnerCode: "S1", qty: 100, requiredQty: 100, uom: "KG", code: "STEEL", checkpoint: "MPS_MATERIAL", category: "MATERIAL", leadTime: 2,
  needDate: "2026-09-08", targetArrivalDate: "2026-09-07", requiresQc: true, procurementPolicy: { prApprovalDays: 0, poProcessingDays: 0, transitDays: 0, receivingQcDays: 1, safetyLeadTimeDays: 0 } };
const options = { asOf: new Date("2026-09-04T00:00:00Z") };
(async () => {
  const role = (moduleCode, actions) => ({ roleAssignments: [{ isActive: true, role: { isActive: true, permissions: [{ moduleCode, pageCode: "*", resourceCode: "*", actions }] } }] });
  assert.equal(mode.canManage(role("planning-ppic", ["update"])), true);
  assert.equal(mode.canManage(role("planning-ppic", ["read"])), false);
  assert.equal(mode.canManage(role("purchasing", ["update"])), false);
  assert.equal(mode.canManage(role("planning-ppic", ["create"]), "create"), true);
  let status;
  mode.authorize({ user: role("purchasing", ["update"]), get: () => "purchasing" }, { status: n => {status=n;return {json:()=>{}};} }, () => {throw Error("Client headers cannot grant MPS source editing");});
  assert.equal(status, 403);
  const auto = await bom.attach(store.decorate(base), options);
  assert.equal(auto.eta, "2026-09-07"); assert.equal(auto.readyDate, "2026-09-08");
  assert.equal(auto.confirmed, false); assert.equal(auto.confirmedQty, null); assert.equal(auto.etaBasis, "BOM");
  assert.equal(store.readiness(auto).ready, true); assert.equal(monitor.finish(auto, options.asOf).confirmation, "BOM");
  assert.equal(store.readiness({ ...auto, etaMode: "MANUAL" }).ready, false, "switching to manual requires a partner commitment");
  const late = await bom.attach(store.decorate({ ...base, needDate: "2026-09-04", targetArrivalDate: "2026-09-04" }), options);
  assert.equal(late.eta, "2026-09-07", "never copy the target into the ETA"); assert.equal(store.readiness(late).ready, false);
  for (const changes of [{ stale: true }, { partnerCode: null }, { leadTime: null }, { procurementPolicy: null }, { uom: null }]) {
    assert.equal(store.readiness(await bom.attach(store.decorate({ ...base, ...changes }), options)).ready, false);
  }
  const vendor = { ...base, id: "MPSV:D:P:1", checkpoint: "MPS_VENDOR", category: "VENDOR", requiresQc: false, sendDate: "2026-09-04", needDate: "2026-09-07", targetArrivalDate: "2026-09-07" };
  assert.equal(store.readiness(await bom.attach(store.decorate(vendor), options)).ready, true);
  assert.equal(store.readiness(await bom.attach(store.decorate({ ...vendor, bomStartDate: "2026-09-08" }), options)).ready, false, "late upstream start cannot pass the vendor gate");
  const missingQc = await bom.attach(store.decorate({ ...base, category: "CUSTOMER", procurementPolicy: null }), options);
  assert.equal(missingQc.bomCalculation.available, false);
  const customer = await bom.attach(store.decorate({ ...base, category: "CUSTOMER" }), options);
  assert.equal(customer.eta, "2026-09-07"); assert.equal(customer.confirmed, false);
  const record = { id: "manual", sourceFingerprint: store.fingerprint(base), qty: 50, eta: "2026-09-09", readyDate: "2026-09-10", sourceSnapshot: { leadTimeDays: 1 }, confirmationReference: "Partner answer" };
  const manual = await bom.attach(store.decorate({ ...base, etaMode: "MANUAL" }, record), options);
  assert.equal(manual.etaBasis, "MANUAL"); assert.equal(manual.eta, "2026-09-09"); assert.equal(manual.confirmedQty, 50);
  assert.equal(store.readiness(manual).ready, false, "manual source must check the actual partial / late answer");
  const selectedBom = await bom.attach(store.decorate(base, record), options);
  assert.equal(selectedBom.etaBasis, "BOM"); assert.equal(selectedBom.eta, "2026-09-07");
  assert.equal(selectedBom.confirmed, false); assert.equal(selectedBom.confirmedQty, null);
  assert.deepEqual(selectedBom.confirmationRecord, manual.confirmationRecord, "switching source preserves the manual record");
  assert.equal(store.readiness(selectedBom).ready, true);
  const missingBom = await bom.attach(store.decorate({ ...base, procurementPolicy: null }, record), options);
  assert.equal(missingBom.eta, null); assert.equal(store.readiness(missingBom).ready, false, "missing BOM data cannot silently fall back to manual");
  const rawManual = store.decorate(base, record);
  assert.deepEqual(await store.withLeadTime(rawManual), rawManual, "BOM mode must keep BOM order dates and lead time");
  const failure = await bom.attach(store.decorate(base), { ...options, solveFiniteSchedule: async () => { throw Error("solver unavailable"); } });
  assert.equal(store.readiness(failure).ready, false);
  let doc = { id: "mps", mpsNumber: "MPS-SEP", revision: 1, etaMode: "MANUAL", etaModeVersion: 0, status: "Draft", etaModeHistory: [] }, writes = 0;
  const db = { mPS: { findFirst: async () => structuredClone(doc), updateMany: async ({ where, data }) => {
    if (where.etaModeVersion !== doc.etaModeVersion) return { count: 0 };
    writes++; doc = { ...doc, ...data, etaModeVersion: doc.etaModeVersion + 1 }; return { count: 1 };
  } } };
  const input = { mpsNumber: doc.mpsNumber, revision: 1, etaMode: "BOM", etaModeVersion: 0 };
  await mode.setMode(db, input, { username: "purchasing" });
  assert.equal(doc.etaMode, "BOM"); assert.equal(doc.etaModeVersion, 1); assert.equal(doc.etaModeHistory[0].by, "purchasing");
  await assert.rejects(mode.setMode(db, { ...input, etaMode: "MANUAL" }), (e) => e.code === "ETA_MODE_CHANGED");
  await mode.setMode(db, { ...input, etaModeVersion: 1 }, {}); assert.equal(writes, 1, "saving current mode is a no-op");
  await mode.setMode(db, { ...input, etaMode: "MANUAL", etaModeVersion: 1 }, {}); assert.equal(doc.etaMode, "MANUAL");
  doc.status = "Released"; await assert.rejects(mode.setMode(db, { ...input, etaModeVersion: 2 }), /Draft/);
  await assert.rejects(mode.setMode(db, { ...input, etaMode: "invalid" }), /Pilih/);
  console.log("PASS ETA modes: BOM calendar/late/upstream/QC/missing data, exclusive selected source, preserved confirmations, reversible mode, audit, stale edits and released lock.");
})().catch((e) => { console.error(e); process.exitCode = 1; });
