"use strict";

const assert = require("node:assert/strict");
const {
  currentPlanScope,
  sameCurrentPlanScope,
  deltaMrpMetadata,
} = require("../src/prisma/services/planning/planningDeltaMrpService");

function run() {
  assert.deepEqual(currentPlanScope({ planKind: "BASELINE", planningMonth: "2026-09-01" }), {
    planKind: "BASELINE",
    planningMonth: "2026-09",
    baselineRunNumber: null,
  });
  assert.deepEqual(currentPlanScope({ planKind: "DELTA", planningMonth: "2026-09-01", baselineRunNumber: "MRP-202609-R006" }), {
    planKind: "DELTA",
    planningMonth: "2026-09",
    baselineRunNumber: "MRP-202609-R006",
  });
  assert.equal(sameCurrentPlanScope(
    { planKind: "DELTA", planningMonth: "2026-09-01", baselineRunNumber: "MRP-202609-R006" },
    { planKind: "DELTA", planningMonth: "2026-09-01", baselineRunNumber: "MRP-202609-R006" },
  ), true);
  assert.equal(sameCurrentPlanScope(
    { planKind: "BASELINE", planningMonth: "2026-09-01" },
    { planKind: "DELTA", planningMonth: "2026-09-01", baselineRunNumber: "MRP-202609-R006" },
  ), false, "Delta approval must not supersede the baseline run");
  assert.deepEqual(deltaMrpMetadata({
    deltaMpsNumber: "MPS-202609-D001",
    baselineMpsNumber: "MPS-202609-001",
    baselineRunNumber: "MRP-202609-R006",
  }), {
    planKind: "DELTA",
    baselineRunNumber: "MRP-202609-R006",
    sourceDeltaMpsNumber: "MPS-202609-D001",
    baselineMpsNumber: "MPS-202609-001",
  });
  assert.throws(() => deltaMrpMetadata({ deltaMpsNumber: "MPS-202609-D001" }), /baseline MRP/i);
  console.log("PASS verify-delta-mrp-lifecycle: baseline and Delta current-plan scopes are isolated");
}

run();
