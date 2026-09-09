"use strict";
const assert = require("node:assert/strict");
const { netMpsBucket, buildDatedMpsDemand } = require("../src/prisma/services/planning/mpsNettingService");
const { scheduledProductionCoverage } = require("../src/prisma/services/planning/mpsCalculationService");
const { assertDemandSolverEvidence } = require("../src/prisma/services/planning/solver/planningSolverRunService");
(async () => {
  const input = { openingAvailableQty: 0, grossDemandQty: 100, firmScheduledReceiptQty: 100, demandEvents: [{ date: "2026-09-03", qty: 100 }], receiptEvents: [{ date: "2026-09-20", qty: 100 }] };
  assert.equal(netMpsBucket(input).plannedProductionQty, 100, "late receipt cannot cover early demand");
  assert.equal(netMpsBucket({ ...input, receiptEvents: [{ date: "2026-09-03", qty: 100 }] }).plannedProductionQty, 0);
  assert.equal(netMpsBucket({ ...input, receiptEvents: [{ date: null, qty: 100 }] }).plannedProductionQty, 100, "undated supply must not cover demand");
  assert.equal(netMpsBucket({ ...input, demandEvents: [{ date: "2026-09-03", qty: 40 }, { date: "2026-09-21", qty: 60 }] }).plannedProductionQty, 40);
  const targets = [
    { sourceType: "SALES_ORDER", sourceNumber: "SO-EARLY", targetDate: "2026-09-03", qty: 40 },
    { sourceType: "SALES_ORDER", sourceNumber: "SO-LATE", targetDate: "2026-09-21", qty: 60 },
    { sourceType: "FORECAST", targetDate: "2026-09-01", qty: 50 },
  ];
  const scopedDemands = buildDatedMpsDemand({ targets, policyDemandQty: 100, productionPercent: 0, reservations: [{ referenceNumber: "SO-LATE", appliedQty: 60 }] });
  assert.equal(scopedDemands.find((row) => row.sourceNumber === "SO-EARLY").qty, 40);
  assert.equal(scopedDemands.find((row) => row.sourceNumber === "SO-LATE").qty, 0);
  assert.equal(netMpsBucket({ ...input, openingAvailableQty: 60, timePhasedOpeningAvailableQty: 0, firmScheduledReceiptQty: 40, receiptEvents: [{ date: "2026-09-20", qty: 40 }], demandEvents: scopedDemands }).plannedProductionQty, 40, "a later SO reservation cannot cover an early SO");
  const overridden = buildDatedMpsDemand({ targets, policyDemandQty: 10, productionPercent: 0 });
  assert.equal(overridden.reduce((sum, row) => sum + row.qty, 0), 100, "firm SO dates survive smaller EFD and production override");
  assert.equal(scheduledProductionCoverage({ qty: 100, finishAt: "2026-09-04", requiredAt: "2026-09-03", current: true }), 0);
  assert.equal(scheduledProductionCoverage({ qty: 100, finishAt: "2026-09-02", requiredAt: "2026-09-03", current: true }), 100);
  assert.equal(scheduledProductionCoverage({ qty: 100, requiredAt: "2026-09-03", current: true }), null);
  assert.equal(scheduledProductionCoverage({ qty: 100, finishAt: "2026-09-02", requiredAt: "2026-09-03", current: false }), null);
  const good = { status: "OPTIMAL", feasible: true };
  assertDemandSolverEvidence({ engine: "OR_TOOLS_WASM_CP_SAT", backward: good, forward: good });
  assert.throws(() => assertDemandSolverEvidence(null), /belum memiliki/);
  assert.throws(() => assertDemandSolverEvidence({ engine: "OR_TOOLS_WASM_CP_SAT", backward: good, forward: { status: "INFEASIBLE", feasible: false } }), /belum memiliki/);
  const { solveBackwardChain } = await import("../src/prisma/services/planning/solver/planningCpSatSolver.mjs");
  for (const allowedStartMinutes of [[], [99], ["invalid"]]) {
    const result = await solveBackwardChain({ horizonMinutes: 100, targetMinute: 100, tasks: [{ id: "A", durationMinutes: 10, allowedStartMinutes }] });
    assert.equal(result.feasible, false, "empty/invalid calendar must not become unrestricted");
    assert.equal(result.blockers[0].code, "NO_ALLOWED_START");
  }
  const feasible = await solveBackwardChain({ horizonMinutes: 100, targetMinute: 100, tasks: [{ id: "A", durationMinutes: 10, allowedStartMinutes: [20, 40] }] });
  assert.equal(feasible.tasks[0].startMinute, 40);
  console.log("MPS dated netting, actual schedule coverage and CP-SAT calendar/evidence guards PASS");
})().catch((e) => { console.error(e); process.exitCode = 1; });
