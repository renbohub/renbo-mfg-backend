"use strict";

const assert = require("node:assert/strict");
const { buildCutLine, summarizeCutPreview } = require("../src/prisma/services/planning/productionCutService");

function run() {
  assert.deepEqual(buildCutLine({ plannedQty: 100, producedQty: 20, wipQty: 30, requestedQty: 80, supplierPoQty: 40, status: "Released" }), {
    plannedQty: 100,
    producedQty: 20,
    wipQty: 30,
    protectedProductionQty: 30,
    cuttableQty: 70,
    requestedCutQty: 80,
    approvedCutQty: 70,
    supplierPoQty: 40,
    supplierPoProtected: true,
    status: "PARTIAL",
  }, "Released production can be reduced, but produced/WIP quantity is protected");
  assert.equal(buildCutLine({ plannedQty: 100, producedQty: 100, requestedQty: 10 }).approvedCutQty, 0);
  const summary = summarizeCutPreview([
    buildCutLine({ plannedQty: 100, producedQty: 20, requestedQty: 50, supplierPoQty: 10 }),
    buildCutLine({ plannedQty: 40, producedQty: 40, requestedQty: 10 }),
  ]);
  assert.deepEqual(summary, { requestedQty: 60, approvedCutQty: 50, protectedProductionQty: 60, supplierPoQty: 10, blockedQty: 10, hasSupplierPoWarning: true });
  console.log("PASS verify-production-cut-rules: released qty is cuttable while produced/WIP and supplier PO stay protected");
}

run();
