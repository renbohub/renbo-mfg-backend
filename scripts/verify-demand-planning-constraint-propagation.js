"use strict";

const assert = require("assert");
const {
  loadDemandPlanningConstraintMap,
  procurementPolicyFromDecision,
  applyDecisionToRoutingMetric,
  effectiveVendorLeadTime,
} = require("../src/prisma/services/planning/demandPlanningConstraintService");
const { procurementSchedule } = require("../src/prisma/services/planning/procurementSchedulingService");
const demandPlanningSource = require("fs").readFileSync(require("path").resolve(__dirname, "../src/prisma/services/planning/demandPlanningService.js"), "utf8");
const monthlyPlanningSource = require("fs").readFileSync(require("path").resolve(__dirname, "../src/prisma/services/planning/monthlyPlanningService.js"), "utf8");

assert.match(
  demandPlanningSource,
  /input\.forceSolverDates\s*\?\s*target\.qty\s*:/,
  "MPS solver refresh must schedule the persisted delivery-target quantity, not the merged sibling total",
);
assert.match(
  demandPlanningSource,
  /savedSplitsMatchDemand[\s\S]*savedSplitsStillProtectDueDate\s*=\s*savedSplitsMatchDemand/,
  "stale finish splits with a quantity different from effective demand must be rebuilt",
);
assert.match(
  monthlyPlanningSource,
  /decisionByTarget\.get\(target\.id\)[\s\S]*\|\|\s*decisionByTarget\.get\(target\.matchedForecastTargetId\)/,
  "MPS delivery batches must prefer each active target's OR-Tools decision over its matched Forecast fallback",
);

(async () => {
  const forecastTargetId = "forecast-phase";
  const salesOrderTargetId = "sales-order-phase";
  const adjustmentKey = "C002-C004-020::SEQ-10::PAINT::V-AUDIT-PAINT::0";
  const decision = {
    id: "decision-1",
    deliveryTargetId: forecastTargetId,
    status: "REVIEWED",
    constraintDetails: {
      leadTimeControls: { productionProcess: true, supplierLeadTime: true, receivingQc: false, safety: false },
      capacityAssumption: { shiftsPerDay: 1, hoursPerShift: 8 },
      vendorProcessAdjustments: [{ key: adjustmentKey, adjustedDurationHours: 24, reason: "Confirmed vendor three days" }],
      vendorProcesses: [{
        key: adjustmentKey, detailCode: "C002-C004-020", sequence: 10, processCode: "PAINT",
        vendorCode: "V-AUDIT-PAINT", masterDurationHours: 40, adjustedDurationHours: 24,
        reason: "Confirmed vendor three days", adjustmentApplied: true,
      }],
    },
    updatedAt: new Date(),
  };
  const fakePrisma = {
    demandDeliveryTarget: { findMany: async () => [{ id: salesOrderTargetId, consumesForecastTargetId: forecastTargetId }] },
    demandPlanningDecision: { findMany: async () => [decision] },
  };
  const constraintMap = await loadDemandPlanningConstraintMap(fakePrisma, [salesOrderTargetId]);
  const inherited = constraintMap.get(salesOrderTargetId);
  assert(inherited, "SO phase must inherit the reviewed decision from the consumed forecast phase");
  assert.strictEqual(inherited.planningDecisionTargetId, forecastTargetId);

  const metric = {
    productionLeadTimeDays: 13,
    exactProductionLeadTimeDays: 12.5,
    productionLeadTimeHours: 100,
    inhouseProcessHours: 60,
    vendorScheduledDays: 5,
    vendorLeadTimeDays: 5,
    processPath: [{
      detailCode: "C002-C004-020", sequence: 10, processCode: "PAINT", mode: "VENDOR",
      vendorCode: "V-AUDIT-PAINT", vendorLeadTimeDays: 5, elapsedHours: 40, rawElapsedDays: 5, elapsedDays: 5,
    }],
  };
  const applied = applyDecisionToRoutingMetric(metric, inherited);
  assert.strictEqual(applied.metric.vendorLeadTimeDays, 3);
  assert.strictEqual(applied.metric.productionLeadTimeDays, 11);
  assert.strictEqual(applied.metric.processPath[0].vendorAdjustmentApplied, true);

  const policy = procurementPolicyFromDecision(inherited);
  assert.strictEqual(policy.receivingQcDays, 0);
  assert.strictEqual(policy.safetyLeadTimeDays, 0);
  const schedule = await procurementSchedule({ materialRequiredDate: new Date("2026-08-11T07:00:00.000Z"), supplierLeadTimeDays: 5, ...policy });
  assert.strictEqual(schedule.solver.engine, "OR_TOOLS_WASM_CP_SAT");
  assert(schedule.latestPrDate < schedule.latestPoDate && schedule.latestPoDate < schedule.supplierRequiredArrivalDate);

  const vendorPlanning = effectiveVendorLeadTime({
    sequence: 10,
    process: { processCode: "PAINT" },
    vendor: { vendorCode: "V-AUDIT-PAINT", leadTimeDays: 5 },
    mbomDetail: { part: { partCode: "C002-C004-020" } },
  }, inherited, 8);
  assert.strictEqual(vendorPlanning.masterDays, 5);
  assert.strictEqual(vendorPlanning.planningDays, 3);
  assert.strictEqual(vendorPlanning.adjustmentApplied, true);

  console.log("Demand Planning constraint propagation checks passed: 13/13");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
