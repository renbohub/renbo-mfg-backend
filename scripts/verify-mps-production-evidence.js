"use strict";
const assert = require("node:assert/strict");
const { VERSION, sourceKey, allocateMaterials, phaseKey, currentEvidence } = require("../src/prisma/services/planning/mpsProductionEvidenceService");
const { buildLedger, attachPhaseNetting } = require("../src/prisma/services/planning/mpsWorkbenchService");
const row = (changes = {}) => ({ partCode: "RAW", uomCode: "kg", openingQty: 10, qty: 8, requiredDate: "2026-09-10", materialSupplyType: "PURCHASED", supplyEvents: [], ...changes });
const receipt = { id: "PO-LINE-1", sourceType: "PO", sourceNumber: "PO-1", qty: 5, availableDate: "2026-09-10", confidence: "FIRM" };
const entries = [
  { materialCoverage: [row({ requiredDate: "2026-09-11", supplyEvents: [receipt] })] },
  { materialCoverage: [row({ requiredDate: "2026-09-09", supplyEvents: [receipt] })] },
  { materialCoverage: [row({ requiredDate: "2026-09-12", supplyEvents: [receipt, { ...receipt, id: "PR-1", qty: 100, confidence: "PLANNED" }] })] },
];
allocateMaterials(entries);
assert.deepEqual(entries.map(e => e.materialCoverage[0].shortageQty), [1, 0, 8], "one shared stock pool and one firm receipt; no PR coverage");
assert.ok(entries.every(e => !e.materialCoverage[0].supplyEvents));
const customer = [{ materialCoverage: [row({ openingQty: 0, materialSupplyType: "CUSTOMER_SUPPLIED", supplyEvents: [receipt] })] }];
allocateMaterials(customer);
assert.equal(customer[0].materialCoverage[0].shortageQty, 8, "purchasing cannot cover customer-supplied material");
const units = [{ materialCoverage: [row(), row({ uomCode: "pcs" })] }];
allocateMaterials(units);
assert.deepEqual(units[0].materialCoverage.map(r => r.shortageQty), [0, 0], "units are separate stock pools");
const sharedRaw = [{ materialCoverage: [row({ partCode: "A", materialCode: "STEEL" }), row({ partCode: "B", materialCode: "STEEL" })] }];
allocateMaterials(sharedRaw);
assert.deepEqual(sharedRaw[0].materialCoverage.map(r => r.shortageQty), [0, 6], "two BOM identities cannot reuse the same raw material stock");
const identicalLines = [{ materialCoverage: [row({ openingQty: 0, supplyEvents: [receipt, { ...receipt, id: "PO-LINE-2" }] })] }];
allocateMaterials(identicalLines);
assert.equal(identicalLines[0].materialCoverage[0].shortageQty, 0, "distinct identical PO lines remain separate receipts");

const phase = { id: "BUFFER", plannedProductionQty: 5, fgRequiredDate: "2026-09-30", sourceType: "BUFFER" };
const evidence = { complete: true };
const detail = { mbomHeaderId: "BOM-7", calculationTrace: { productionChecksheet: { version: VERSION, mpsRevision: 20, mbomHeaderId: "BOM-7", sourceKey: "INPUT-1", phases: { [phaseKey(phase)]: evidence } } } };
assert.equal(currentEvidence(detail, { revision: 20 }, phase, "INPUT-1"), evidence);
assert.equal(currentEvidence(detail, { revision: 21 }, phase, "INPUT-1"), null);
assert.equal(currentEvidence(detail, { revision: 20 }, phase, "INPUT-2"), null);
assert.equal(currentEvidence({ ...detail, mbomHeaderId: "BOM-8" }, { revision: 20 }, phase, "INPUT-1"), null);
assert.equal(currentEvidence(detail, { revision: 20 }, { ...phase, plannedProductionQty: 6 }, "INPUT-1"), null);
assert.equal(currentEvidence(detail, { revision: 20 }, { ...phase, fgRequiredDate: "2026-09-29" }, "INPUT-1"), null);

const netting = buildLedger({ detail: { id: "EXCESS", mpsNumber: "MPS", startDate: "2026-10-01", endDate: "2026-10-31", qtyPlanned: 125, targetEndingStockQty: 100, openingAvailableQty: 0, projectedEndingStockQty: 125, demandSources: [] }, stockLines: [], reservations: [], receipts: [] });
const total = attachPhaseNetting(netting.phases, netting.ledger).reduce((sum, p) => sum + p.plannedProductionQty, 0)
  + netting.ledger.filter(e => ["BUFFER_TARGET", "PLANNED_BALANCE"].includes(e.eventType)).reduce((sum, e) => sum + e.plannedProductionQty, 0);
assert.equal(total, 125, "all official production must be capacity checked including planned balance");
console.log("Production evidence: shared dated supply, customer supply, units, snapshot invalidation and full production quantity PASS");

const { selectAuthoritativeMbom } = require("../src/prisma/services/planning/solver/bomGraphValidationService");
(async () => {
  const { Prisma } = require("@prisma/client");
  const { withBusinessDate } = require("../src/prisma/utils/businessClock");
  const snapshots = new Map();
  const queried = new Set();
  const evidenceDb = Object.fromEntries(Prisma.dmmf.datamodel.models.map(model => {
    const name = model.name[0].toLowerCase() + model.name.slice(1);
    snapshots.set(name, { timestamp: null, count: 0 });
    return [name, { aggregate: async args => {
      queried.add(name);
      const fields = Object.keys(args._max);
      assert.equal(fields.length, 1);
      const field = model.fields.find(field => field.name === fields[0]);
      assert.ok(field && field.kind === "scalar" && field.type === "DateTime", `${model.name}.${fields[0]} must exist in the generated Prisma schema`);
      assert.deepEqual(args._count, { _all: true });
      const snapshot = snapshots.get(name);
      return { _max: { [fields[0]]: snapshot.timestamp }, _count: { _all: snapshot.count } };
    } }];
  }));
  const fingerprint = () => withBusinessDate("2026-09-06", () => sourceKey(evidenceDb));
  const emptyKey = await fingerprint();
  assert.equal(await fingerprint(), emptyKey, "unchanged empty inputs have a stable fingerprint");
  for (const name of ["customerSupplyRequest", "customerSupplyShipment", "customerSupplyReceipt", "customerSupplyIssue", "stockBalance"]) assert.ok(queried.has(name));
  const issueSnapshot = snapshots.get("customerSupplyIssue");
  issueSnapshot.timestamp = new Date("2026-09-06T10:00:00Z");
  issueSnapshot.count = 1;
  const firstIssueKey = await fingerprint();
  assert.notEqual(firstIssueKey, emptyKey, "a new issue invalidates production evidence");
  issueSnapshot.count = 2;
  assert.notEqual(await fingerprint(), firstIssueKey, "same-timestamp issues still invalidate via count");
  issueSnapshot.count = 1;
  issueSnapshot.timestamp = new Date("2026-09-06T11:00:00Z");
  assert.notEqual(await fingerprint(), firstIssueKey, "issue creation timestamp is included");
  const beforeReceiptEdit = await fingerprint();
  snapshots.get("customerSupplyReceipt").timestamp = new Date("2026-09-06T12:00:00Z");
  assert.notEqual(await fingerprint(), beforeReceiptEdit, "receipt updates still invalidate production evidence");
  console.log(`Source fingerprint: ${queried.size} models validated against Prisma schema; issue creation/count and receipt updates PASS`);
  const db = { mBOMHeader: { findMany: async ({ where }) => {
    assert.equal(where.partId, "FG-1");
    assert.equal(where.isDeleted, false);
    assert.equal(where.AND[0].OR[1].effectiveDate.lte.toISOString().slice(0, 10), "2026-09-01");
    return where.id === "BOM-7" ? [{ id: "BOM-7" }] : where.id ? [] : [{ id: "BOM-6" }, { id: "BOM-7" }];
  } } };
  assert.equal((await selectAuthoritativeMbom(db, { partId: "FG-1", selectedId: "BOM-7", effectiveAt: "2026-09-01" })).id, "BOM-7");
  await assert.rejects(() => selectAuthoritativeMbom(db, { partId: "FG-1", selectedId: "EXPIRED", effectiveAt: "2026-09-01" }), { code: "MPS_BOM_NOT_EFFECTIVE" });
  await assert.rejects(() => selectAuthoritativeMbom(db, { partId: "FG-1", effectiveAt: "2026-09-01" }), { code: "MBOM_ACTIVE_REVISION_AMBIGUOUS" });
  console.log("Pinned MPS revision retains BOM effectivity and ambiguity guards PASS");
})().catch(error => { console.error(error); process.exitCode = 1; });
