const assert = require("node:assert/strict");
const {
  additionalDemandQty,
  pendingDeltaQty,
  cuttableProductionQty,
  chooseCoverageSequence,
} = require("../src/prisma/services/planning/additionalDemandDomain");

function closeTo(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= 0.000001, `${message}: expected ${expected}, received ${actual}`);
}

function run() {
  assert.equal(
    additionalDemandQty({ currentSoQty: 120, lockedEfdQty: 100 }),
    20,
    "a customer order above locked EFD creates additional demand",
  );
  assert.equal(
    additionalDemandQty({ currentSoQty: 80, lockedEfdQty: 100 }),
    0,
    "a customer order below locked EFD does not create negative additional demand",
  );
  assert.equal(
    additionalDemandQty({ currentSoQty: Number.NaN, lockedEfdQty: -10 }),
    0,
    "invalid and negative inputs normalize to zero",
  );

  assert.equal(
    pendingDeltaQty({ additionalQty: 30, fgStockQty: 5, firmReceiptQty: 10, generatedDeltaQty: 7 }),
    8,
    "only persisted coverage categories reduce pending delta",
  );
  closeTo(
    pendingDeltaQty({ additionalQty: 0.3, fgStockQty: 0.1, firmReceiptQty: 0.1, generatedDeltaQty: 0.1 }),
    0,
    "decimal quantities do not leave floating-point residue",
  );

  assert.equal(
    cuttableProductionQty({ plannedQty: 100, producedQty: 20, wipQty: 15 }),
    65,
    "produced and WIP quantities are protected from production cut",
  );
  assert.equal(
    cuttableProductionQty({ plannedQty: 20, producedQty: 30, wipQty: 10 }),
    0,
    "cuttable quantity cannot be negative",
  );

  assert.deepEqual(
    chooseCoverageSequence({ additionalQty: 25, freeFgQty: 5, firmReceiptQty: 8 }),
    [
      { type: "FG_STOCK", qty: 5 },
      { type: "FIRM_FG_RECEIPT", qty: 8 },
      { type: "DELTA_MPS", qty: 12 },
    ],
    "coverage follows free FG, firm receipt, then Delta MPS",
  );
  assert.deepEqual(
    chooseCoverageSequence({ additionalQty: 4, freeFgQty: 10, firmReceiptQty: 10 }),
    [{ type: "FG_STOCK", qty: 4 }],
    "coverage stops once additional demand is fully covered",
  );

  console.log("PASS verify-additional-demand-domain: 9 behaviors verified");
}

run();
