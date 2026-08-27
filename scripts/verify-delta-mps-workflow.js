const assert = require("node:assert/strict");
const {
  buildDeltaCoveragePlan,
  fingerprintDeltaPreview,
  deltaSourceKey,
} = require("../src/prisma/services/planning/planningDeltaMpsService");

function run() {
  const plan = buildDeltaCoveragePlan({
    demands: [
      { baselineLockId: "lock-1", customerCode: "C001", partCode: "FG-001", month: "2026-09", pendingDeltaQty: 30, requiredDate: new Date("2026-09-20T00:00:00.000Z"), uomCode: "PCS", baselineMpsNumber: "MPS-202609-B001" },
      { baselineLockId: "lock-2", customerCode: "C002", partCode: "FG-001", month: "2026-09", pendingDeltaQty: 20, requiredDate: new Date("2026-09-25T00:00:00.000Z"), uomCode: "PCS", baselineMpsNumber: "MPS-202609-B001" },
    ],
    stockCandidates: [
      { id: "stock-1", partCode: "FG-001", availableQty: 10, warehouseCode: "WH-001", rackCode: "FG" },
    ],
    receiptCandidates: [
      { id: "mo-1", moNumber: "MO-001", partCode: "FG-001", availableQty: 25, availableDate: new Date("2026-09-15T00:00:00.000Z") },
    ],
  });

  assert.deepEqual(plan.allocations.map((row) => [row.baselineLockId, row.coverageType, row.qty]), [
    ["lock-1", "FG_STOCK", 10],
    ["lock-1", "FIRM_FG_RECEIPT", 20],
    ["lock-2", "FIRM_FG_RECEIPT", 5],
  ], "physical supply is allocated once, in due-date and waterfall order");
  assert.deepEqual(plan.deltaLines.map((row) => [row.baselineLockId, row.qty]), [["lock-2", 15]], "only uncovered demand becomes Delta MPS quantity");
  assert.equal(plan.summary.additionalQty, 50);
  assert.equal(plan.summary.stockQty, 10);
  assert.equal(plan.summary.firmReceiptQty, 25);
  assert.equal(plan.summary.deltaMpsQty, 15);

  const reversed = buildDeltaCoveragePlan({
    demands: [...plan.demands].reverse(),
    stockCandidates: [{ id: "stock-1", partCode: "FG-001", availableQty: 10, warehouseCode: "WH-001", rackCode: "FG" }],
    receiptCandidates: [{ id: "mo-1", moNumber: "MO-001", partCode: "FG-001", availableQty: 25, availableDate: new Date("2026-09-15T00:00:00.000Z") }],
  });
  assert.equal(fingerprintDeltaPreview(plan), fingerprintDeltaPreview(reversed), "fingerprint is stable regardless of database row order");
  assert.equal(deltaSourceKey("MPS-202609-B001", 2), "DELTA:MPS-202609-B001:002");

  const fullyCovered = buildDeltaCoveragePlan({
    demands: [{ baselineLockId: "lock-3", customerCode: "C003", partCode: "FG-002", month: "2026-09", pendingDeltaQty: 5, requiredDate: new Date("2026-09-20T00:00:00.000Z"), uomCode: "PCS", baselineMpsNumber: "MPS-202609-B001" }],
    stockCandidates: [{ id: "stock-2", partCode: "FG-002", availableQty: 7, warehouseCode: "WH-001" }],
    receiptCandidates: [],
  });
  assert.equal(fullyCovered.deltaLines.length, 0);
  assert.equal(fullyCovered.status, "COVERED_WITHOUT_PRODUCTION");

  console.log("PASS verify-delta-mps-workflow: waterfall and Delta MPS isolation verified");
}

run();
