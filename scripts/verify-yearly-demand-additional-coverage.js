const assert = require("node:assert/strict");
const {
  loadAdditionalDemandCoverage,
  aggregateCoverageByPartMonth,
} = require("../src/prisma/services/planning/additionalDemandCoverageService");
const { mergeAdditionalCoverageIntoYearlyItems } = require("../src/prisma/services/planning/yearlyDemandService");

function fakePrisma() {
  return {
    planningBaselineLock: {
      findMany: async () => [
        {
          id: "lock-1",
          periodMonth: new Date("2026-09-01T00:00:00.000Z"),
          customerCode: "C001",
          partCode: "FG-001",
          uomCode: "PCS",
          forecastQtyLocked: 100,
          poQtyLocked: 90,
          efdQtyLocked: 100,
          baselineMpsNumber: "MPS-202609-B001",
          baselineMrpNumber: "MRP-202609-B001",
          sourceFingerprint: "fingerprint",
          sourceSnapshot: { sources: [{ sourceNumber: "SO-BASE" }] },
          status: "ACTIVE",
          lockedAt: new Date("2026-08-27T02:00:00.000Z"),
          lockedBy: "ppic.user",
        },
        {
          id: "lock-2",
          periodMonth: new Date("2026-09-01T00:00:00.000Z"),
          customerCode: "C002",
          partCode: "FG-001",
          uomCode: "PCS",
          forecastQtyLocked: 40,
          poQtyLocked: 40,
          efdQtyLocked: 40,
          baselineMpsNumber: "MPS-202609-B001",
          baselineMrpNumber: "MRP-202609-B001",
          sourceFingerprint: "fingerprint",
          sourceSnapshot: { sources: [{ sourceNumber: "SO-C002" }] },
          status: "ACTIVE",
          lockedAt: new Date("2026-08-27T02:00:00.000Z"),
          lockedBy: "ppic.user",
        },
      ],
    },
    demandDeliveryTarget: {
      findMany: async () => [
        { id: "so-new-1", sourceNumber: "SO-NEW", sourceLineId: "line-1", phaseNumber: 1, customerCode: "C001", partCode: "FG-001", targetDate: new Date("2026-09-10T00:00:00.000Z"), qty: 80, uomCode: "PCS", soDetail: { isDeleted: false, status: "Open", soHeader: { isDeleted: false, status: "Confirmed" } } },
        { id: "so-new-2", sourceNumber: "SO-NEW", sourceLineId: "line-1", phaseNumber: 2, customerCode: "C001", partCode: "FG-001", targetDate: new Date("2026-09-20T00:00:00.000Z"), qty: 50, uomCode: "PCS", soDetail: { isDeleted: false, status: "Open", soHeader: { isDeleted: false, status: "Confirmed" } } },
        { id: "so-c002", sourceNumber: "SO-C002", sourceLineId: "line-2", phaseNumber: 1, customerCode: "C002", partCode: "FG-001", targetDate: new Date("2026-09-15T00:00:00.000Z"), qty: 30, uomCode: "PCS", soDetail: { isDeleted: false, status: "Open", soHeader: { isDeleted: false, status: "Confirmed" } } },
        { id: "so-new-customer", sourceNumber: "SO-C003", sourceLineId: "line-4", phaseNumber: 1, customerCode: "C003", partCode: "FG-001", targetDate: new Date("2026-09-22T00:00:00.000Z"), qty: 25, uomCode: "PCS", soDetail: { isDeleted: false, status: "Open", soHeader: { isDeleted: false, status: "Confirmed" } } },
        { id: "so-draft", sourceNumber: "SO-DRAFT", sourceLineId: "line-3", phaseNumber: 1, customerCode: "C001", partCode: "FG-001", targetDate: new Date("2026-09-18T00:00:00.000Z"), qty: 999, uomCode: "PCS", soDetail: { isDeleted: false, status: "Open", soHeader: { isDeleted: false, status: "Draft" } } },
      ],
    },
    additionalDemandCoverage: {
      findMany: async () => [
        { id: "cov-1", baselineLockId: "lock-1", coverageType: "FG_STOCK", qty: 5, status: "ALLOCATED", sourceNumber: "STOCK-FG-001" },
        { id: "cov-2", baselineLockId: "lock-1", coverageType: "FIRM_FG_RECEIPT", qty: 10, status: "ALLOCATED", sourceNumber: "MO-001" },
        { id: "cov-3", baselineLockId: "lock-1", coverageType: "DELTA_MPS", qty: 7, status: "ALLOCATED", sourceNumber: "MPS-202609-D001" },
      ],
    },
  };
}

async function run() {
  const result = await loadAdditionalDemandCoverage(fakePrisma(), { year: 2026 });
  const c001 = result.items.find((row) => row.customerCode === "C001");
  const c002 = result.items.find((row) => row.customerCode === "C002");

  assert.equal(c001.currentSoQty, 130, "current SO sums active delivery phases only");
  assert.equal(c001.poDeltaQty, 40, "PO+ compares active PO with PO captured at lock");
  assert.equal(c001.additionalQty, 30, "ADD is current SO above locked EFD");
  assert.equal(c001.coveredFgStockQty, 5);
  assert.equal(c001.coveredFirmReceiptQty, 10);
  assert.equal(c001.generatedDeltaQty, 7);
  assert.equal(c001.pendingDeltaQty, 8, "only persisted allocations reduce pending delta");
  assert.equal(c001.uncoveredQty, 8);
  assert.equal(c001.sourceSalesOrders.length, 2, "delivery phases remain traceable");

  assert.equal(c002.currentSoQty, 30);
  assert.equal(c002.poDeltaQty, -10, "PO+ stays signed when SO is reduced or cancelled");
  assert.equal(c002.additionalQty, 0, "SO below locked EFD never creates negative ADD");
  assert.equal(c002.reductionQty, 10, "SO below locked EFD is exposed as reduction quantity");

  const livePartCoverage = result.byPartMonth.get("2026-09|FG-001");
  assert.equal(livePartCoverage.currentSoQty, 185, "part-level PO includes a new customer that did not exist at lock time");
  assert.equal(livePartCoverage.poDeltaQty, 55, "PO+ includes PO from new customer scopes");

  const aggregate = aggregateCoverageByPartMonth(result.items);
  const september = aggregate.get("2026-09|FG-001");
  assert.equal(september.lockedEfdQty, 140);
  assert.equal(september.currentSoQty, 160);
  assert.equal(september.poDeltaQty, 30, "signed PO+ aggregates positive and negative customer changes");
  assert.equal(september.additionalQty, 30, "per-customer ADD is preserved when the table aggregates a part");
  assert.deepEqual(september.baselineMpsNumbers, ["MPS-202609-B001"]);

  const yearlyItems = [{
    partCode: "FG-001",
    months: { "2026-09": { fcc: 140, po: 160, efd: 160, eff: 160 } },
  }];
  mergeAdditionalCoverageIntoYearlyItems(yearlyItems, aggregate);
  const metric = yearlyItems[0].months["2026-09"];
  assert.equal(metric.lock.lockedEfd, 140, "yearly response keeps locked EFD separate from live EFD");
  assert.equal(metric.additional.qty, 30);
  assert.equal(metric.additional.pendingDeltaQty, 8);
  assert.equal(metric.currentQty, 160);

  console.log("PASS verify-yearly-demand-additional-coverage: coverage ledger behavior verified");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
