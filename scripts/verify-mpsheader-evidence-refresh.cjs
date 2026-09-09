"use strict";
const assert = require("node:assert/strict");
const { Prisma } = require("@prisma/client");
const { withBusinessDate } = require("../src/prisma/utils/businessClock");
const feasibility = require("../src/prisma/services/planning/demandFeasibilityService");
const workbench = require("../src/prisma/services/planning/mpsWorkbenchService");
const procurement = require("../src/prisma/services/planning/procurementSchedulingService");
const evidencePath = require.resolve("../src/prisma/services/planning/mpsProductionEvidenceService");
const original = { assess: feasibility.assessDemandFeasibility, workbench: workbench.getMpsWorkbench, schedule: procurement.procurementSchedule, module: require.cache[evidencePath] };
const detail = { id: "D1", qtyPlanned: 10, partCode: "FG", mbomHeaderId: "BOM1", updatedAt: new Date("2026-08-20T01:00:00Z"), calculationTrace: { existing: "preserved" } };
const doc = { mpsNumber: "MPS-202609", revision: 27, status: "Confirmed", periodStart: "2026-09-01", details: [detail] };
const phases = [
  { id: "PHASE", plannedProductionQty: 8, fgRequiredDate: "2026-09-18", targetDeliveryDate: "2026-09-25", sourceType: "SALES_ORDER" },
  { id: "BUFFER", plannedProductionQty: 2, fgRequiredDate: "2026-09-30", targetDeliveryDate: "2026-09-30", sourceType: "BUFFER" },
];
const writes = [], calls = [];
const models = Object.fromEntries(Prisma.dmmf.datamodel.models.map((model) => [model.name[0].toLowerCase() + model.name.slice(1), {
  aggregate: async ({ _max }) => ({ _max: Object.fromEntries(Object.keys(_max).map((field) => [field, null])), _count: { _all: 0 } }),
}]));
models.mPS.findUniqueOrThrow = async ({ where }) => { assert.equal(where.mpsNumber, doc.mpsNumber); return doc; };
models.mPSDetail.findUniqueOrThrow = async ({ where }) => { assert.equal(where.id, detail.id); return detail; };
models.mPSDetail.update = async ({ where, data }) => {
  assert.deepEqual(where, { id: detail.id }); assert.deepEqual(Object.keys(data), ["calculationTrace"]);
  assert.equal(data.calculationTrace.existing, "preserved"); writes.push(data); return { ...detail, ...data };
};
let db;
db = new Proxy(models, { get(target, name) {
  if (name === "$transaction") return async (fn) => fn(db);
  assert.ok(target[name], `Unexpected DB access: ${String(name)}`);
  return new Proxy(target[name], { get(model, method) {
    assert.ok(model[method], `Unexpected operation ${name}.${String(method)}`);
    return model[method];
  } });
} });
(async () => {
  try {
    workbench.getMpsWorkbench = async () => ({ mps: doc, items: [{ id: detail.id, phases: phases.slice(0, 1), bufferPhase: phases[1] }] });
    feasibility.assessDemandFeasibility = async (_db, input) => {
      calls.push(input); assert.equal(input.sourceType, "MPS_PRODUCTION"); assert.equal(input.sourceNumber, doc.mpsNumber);
      assert.equal(input.dispatchDays, 0); assert.equal(input.planNumber, undefined);
      return { constraintDetails: { bomNumber: "MBOM1", bomTrace: [{ mbomNumber: "MBOM1", partCode: "CHILD", requiredQty: input.quantity * 2 }],
        materialCoverage: [{ partCode: "RAW", materialSupplyType: "SUPPLIER_PURCHASE", supplierCode: "SUP", qty: input.quantity * 3, openingQty: 0, supplierLeadTimeDays: 5,
          requiredDate: input.requestedDeliveryDate, supplyEvents: [], procurementLeadTimeBreakdown: {
            prApprovalDays: 1, poProcessingDays: 1, supplierLeadTimeDays: 5, transitDays: 0, receivingQcDays: 1, safetyLeadTimeDays: 1,
          } }], processTimeline: [], solver: { engine: "TEST_FIXTURE", status: "FEASIBLE" } } };
    };
    procurement.procurementSchedule = async () => ({ supplierRequiredArrivalDate: "2026-09-16", latestPoDate: "2026-09-09" });
    delete require.cache[evidencePath];
    const evidence = require(evidencePath);
    const before = JSON.stringify(doc);
    await withBusinessDate("2026-08-20", async () => {
      const result = await evidence.refreshProductionEvidence(db, doc.mpsNumber, { runBy: "mock-test" });
      assert.deepEqual(result, { phaseCount: 2, failedPhaseCount: 0 }); assert.equal(writes.length, 1);
      const saved = writes[0].calculationTrace.productionChecksheet;
      assert.equal(saved.mpsRevision, 27); assert.equal(saved.mbomHeaderId, "BOM1");
      assert.equal(saved.sourceKey, await evidence.sourceKey(db));
      assert.deepEqual(Object.keys(saved.phases), phases.map(evidence.phaseKey));
      const customer = saved.phases[evidence.phaseKey(phases[0])], buffer = saved.phases[evidence.phaseKey(phases[1])];
      assert.equal(customer.customerDeliveryDate, "2026-09-25T00:00:00.000Z");
      assert.equal(customer.fgRequiredDate, "2026-09-18T00:00:00.000Z"); assert.equal(buffer.customerDeliveryDate, null);
      assert.equal(customer.materialCoverage[0].shortageQty, 24); assert.equal(buffer.materialCoverage[0].shortageQty, 6);
      assert.equal(customer.materialCoverage[0].latestPoDate, "2026-09-09T00:00:00.000Z");
      assert.equal(customer.bomTrace[0].requiredQty, 16);
      assert.equal(evidence.currentEvidence({ ...detail, ...writes[0] }, doc, phases[0], saved.sourceKey), customer);
      const otherDateKey = await withBusinessDate("2026-09-06", () => evidence.sourceKey(db));
      assert.notEqual(saved.sourceKey, otherDateKey, "demo business date must match between refresh and ETA read");
    });
    assert.equal(JSON.stringify(doc), before, "MPS qty/status and source document unchanged");
    assert.equal(calls.length, 2);
    assert.ok(writes.every((r) => !JSON.stringify(r).includes("confirmationReference")));
    console.log("PASS MPS header evidence refresh: demo-date fingerprint, unchanged phase keys, actual customer dates, buffer separation, BOM quantities, supplier milestones, calculationTrace-only mocked writes; no real database access.");
  } finally {
    feasibility.assessDemandFeasibility = original.assess; workbench.getMpsWorkbench = original.workbench;
    procurement.procurementSchedule = original.schedule;
    if (original.module) require.cache[evidencePath] = original.module; else delete require.cache[evidencePath];
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
