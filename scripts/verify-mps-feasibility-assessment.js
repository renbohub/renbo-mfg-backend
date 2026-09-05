"use strict";

const assert = require("node:assert/strict");
const { CHECK_STATUS, buildMpsFeasibilityAssessment, aggregateMpsFeasibilityAssessments } = require("../src/prisma/services/planning/mpsFeasibilityAssessmentService");
const { summarizeChecks } = require("../src/prisma/services/planning/scheduleFeasibilityAggregator");
const { buildMpsCalculationBreakdown } = require("../src/prisma/services/planning/mpsCalculationService");

const base = () => ({
  rowType: "BATCH", mpsQty: 100, demandQty: 100, requiredDeliveryAt: "2026-09-20T00:00:00.000Z", uomCode: "PCS",
  identity: { lineId: "L1::batch::B1", parentLineId: "L1", rowType: "BATCH", batchId: "B1", batchLabel: "Batch 1", mpsQty: 100 },
  masterData: { ready: true, missingFields: [] },
  inventory: { onHandQty: 30, reservedQty: 10, allocatedQty: 0, qcHoldQty: 0, blockedQty: 0, usableStockQty: 20, onTimeReceiptQty: 0, scheduledOutputByDue: 80, dueDemandQty: 100 },
  materials: { components: [{ partCode: "RM-1", requiredComponentQty: 200, shortageQty: 0, lateDays: 0 }] },
  firmSupply: { externalDependent: true, requiredReceiptQty: 50, firmReceiptQty: 50, onTimeFirmReceiptQty: 50, lateReceiptQty: 0, unconfirmedReceiptQty: 0, affectedPoNumbers: ["PO-1"] },
  capacity: { requiredCapacityHours: 70, netAvailableCapacityHours: 100, warningThreshold: 90, bottleneckWorkCenterId: "WC-1" },
  resources: { evaluated: true, missingResourceCount: 0, conflictingResourceCount: 0, alternateResourceCount: 0 },
  routing: { evaluated: true, invalidSequenceCount: 0, overlapCount: 0, minimumRequiredGapMinutes: 0, minimumActualGapMinutes: 30 },
  lot: { evaluated: true, valid: true, deliverable: true, roundedMpsQty: 100, plannedBatchCount: 1, expectedGoodQty: 100 },
  schedule: { plannedStartAt: "2026-09-10T00:00:00Z", plannedFinishAt: "2026-09-14T00:00:00Z", projectedCustomerArrivalAt: "2026-09-15T00:00:00Z", earliestFeasibleDeliveryAt: "2026-09-15T00:00:00Z", requiredDeliveryAt: "2026-09-20T00:00:00Z", warningSlackMinutes: 1440 },
  quality: { evaluated: true, qcHoldQty: 0, expectedReleaseAt: "2026-09-14T06:00:00Z", latestAllowedReleaseAt: "2026-09-18T00:00:00Z", qcDelayMinutes: 0, causesDeliveryMiss: false },
  delivery: { evaluated: true, slotAvailable: true, projectedCustomerArrivalAt: "2026-09-15T00:00:00Z", requiredDeliveryAt: "2026-09-20T00:00:00Z", warningSlackMinutes: 1440 },
  buffer: { targetQty: 10, projectedEndingQty: 10 }, metrics: { grossDemandQty: 100, firmReceiptQty: 0, plannedProductionQty: 100 }, planMetrics: { baselineMpsQty: 100, deltaMpsQty: 0, approvedCutQty: 0, totalPlanQty: 100 },
});
const build = (mutate = () => {}) => { const input = base(); mutate(input); return buildMpsFeasibilityAssessment(input); };
const find = (result, code) => result.checks.find((row) => row.code === code);

const allPass = build();
assert.equal(allPass.checks.length, 12); assert.equal(allPass.summary.okCount, 12); assert.equal(allPass.summary.totalCount, 12); assert.equal(allPass.status, "FEASIBLE"); assert.equal(allPass.isFeasible, true);

const bufferRisk = build((i) => { i.buffer.projectedEndingQty = 5; });
assert.equal(find(bufferRisk, "BUFFER_POLICY_MET").status, "WARNING"); assert.equal(bufferRisk.summary.okCount, 11); assert.equal(bufferRisk.status, "FEASIBLE_WITH_RISK");

const materialLate = build((i) => { i.materials.components[0] = { partCode: "RM-LATE", requiredComponentQty: 200, shortageQty: 40, lateDays: 2, causesDeliveryMiss: true }; i.schedule.projectedCustomerArrivalAt = "2026-09-22T00:00:00Z"; i.schedule.earliestFeasibleDeliveryAt = "2026-09-22T00:00:00Z"; });
assert.equal(find(materialLate, "MATERIAL_READY_BY_START").status, "FAIL"); assert.equal(find(materialLate, "MATERIAL_READY_BY_START").actual.shortageQty, 40); assert.equal(materialLate.status, "NOT_FEASIBLE"); assert.equal(materialLate.summary.earliestFeasibleDeliveryAt, "2026-09-22T00:00:00.000Z");

const capacityUnknown = build((i) => { i.capacity = {}; });
assert.equal(find(capacityUnknown, "CAPACITY_AVAILABLE").status, "NOT_CHECKED"); assert.equal(capacityUnknown.status, "NOT_EVALUATED"); assert.equal(capacityUnknown.isFeasible, null);

const overload = build((i) => { i.capacity = { requiredCapacityHours: 126, netAvailableCapacityHours: 100, warningThreshold: 90, bottleneckWorkCenterId: "WC-BOTTLENECK" }; });
assert.equal(find(overload, "CAPACITY_AVAILABLE").gap.value, -26); assert.equal(find(overload, "CAPACITY_AVAILABLE").actual.bottleneckWorkCenterId, "WC-BOTTLENECK"); assert.equal(overload.status, "NOT_FEASIBLE");

const supplierLate = build((i) => { i.firmSupply = { externalDependent: true, requiredReceiptQty: 50, firmReceiptQty: 50, onTimeFirmReceiptQty: 20, lateReceiptQty: 30, unconfirmedReceiptQty: 0, supplierLateDays: 3, affectedPoNumbers: ["PO-LATE"] }; });
assert.equal(find(supplierLate, "FIRM_SUPPLY_ON_TIME").status, "FAIL"); assert.deepEqual(find(supplierLate, "FIRM_SUPPLY_ON_TIME").affectedEntities, ["PO-LATE"]); assert.equal(find(supplierLate, "FIRM_SUPPLY_ON_TIME").actual.supplierLateDays, 3);

const overlap = build((i) => { i.routing = { evaluated: true, invalidSequenceCount: 1, overlapCount: 1, minimumRequiredGapMinutes: 0, minimumActualGapMinutes: -30, affectedOperationIds: ["OP-1", "OP-2"] }; });
assert.equal(find(overlap, "ROUTING_SEQUENCE_VALID").status, "FAIL"); assert.deepEqual(find(overlap, "ROUTING_SEQUENCE_VALID").affectedEntities, ["OP-1", "OP-2"]);

const zero = build((i) => { i.mpsQty = 0; i.demandQty = 0; i.inventory.dueDemandQty = 0; i.inventory.scheduledOutputByDue = 0; i.inventory.usableStockQty = 0; });
for (const code of ["MATERIAL_READY_BY_START", "CAPACITY_AVAILABLE", "RESOURCE_CALENDAR_AVAILABLE", "ROUTING_SEQUENCE_VALID", "LOT_BATCH_YIELD_VALID", "LEAD_TIME_AND_FINISH_FIT"]) assert.equal(find(zero, code).status, "NA");
assert.notEqual(zero.status, "NOT_FEASIBLE");

const bufferRow = buildMpsFeasibilityAssessment({ rowType: "BUFFER", mpsQty: 20, uomCode: "PCS", buffer: { targetQty: 20, projectedEndingQty: 20 } });
assert.equal(bufferRow.summary.totalCount, 1); assert.equal(bufferRow.summary.okCount, 1); assert.equal(bufferRow.status, "FEASIBLE");
for (const code of ["CAPACITY_AVAILABLE", "ROUTING_SEQUENCE_VALID", "DELIVERY_SLOT_AVAILABLE"]) assert.equal(find(bufferRow, code).status, "NA");

const childFail = build((i) => { i.identity.batchId = "B2"; i.identity.batchLabel = "Batch 2"; i.capacity.requiredCapacityHours = 130; });
const parent = aggregateMpsFeasibilityAssessments([allPass, childFail], { identity: { lineId: "L1", rowType: "FG" }, mpsCalculation: allPass.mpsCalculation });
assert.equal(parent.checks.length, 12); assert.equal(parent.status, "NOT_FEASIBLE"); assert.ok(find(parent, "CAPACITY_AVAILABLE").affectedEntities.includes("Batch 2"));

const countSummary = summarizeChecks([{ status: "PASS", critical: true }, { status: "WARNING", critical: false }, { status: "NA", critical: false }, { status: "NOT_CHECKED", critical: false }]);
assert.equal(countSummary.okCount, 1); assert.equal(countSummary.totalCount, 3); assert.equal(countSummary.warningCount, 1); assert.equal(countSummary.notCheckedCount, 1);

const calculation = buildMpsCalculationBreakdown({ metrics: { plannedProductionQty: 120 }, planMetrics: { baselineMpsQty: 120, deltaMpsQty: 15, approvedCutQty: 5, totalPlanQty: 130 }, mpsQty: 130 });
assert.equal(calculation.finalMpsQty, 130); assert.equal(calculation.reconciled, true);

// Rule-level status branches that are applicable to each rule's specification.
const cases = [
  ["MASTER_DATA_READY", (i) => { i.masterData = { missingFields: ["effectiveRouting"] }; }, "NOT_CHECKED"],
  ["FG_COVERAGE_AT_DUE_DATE", (i) => { i.inventory.scheduledOutputByDue = 50; }, "FAIL"],
  ["FG_COVERAGE_AT_DUE_DATE", (i) => { delete i.inventory.usableStockQty; }, "NOT_CHECKED"],
  ["MATERIAL_READY_BY_START", (i) => { i.materials.components[0] = { requiredComponentQty: 10, shortageQty: 2, causesDeliveryMiss: false }; }, "WARNING"],
  ["MATERIAL_READY_BY_START", (i) => { i.materials.components = []; }, "NOT_CHECKED"],
  ["FIRM_SUPPLY_ON_TIME", (i) => { i.firmSupply.unconfirmedReceiptQty = 1; }, "WARNING"],
  ["FIRM_SUPPLY_ON_TIME", (i) => { i.firmSupply = { externalDependent: true }; }, "NOT_CHECKED"],
  ["FIRM_SUPPLY_ON_TIME", (i) => { i.firmSupply = { externalDependent: false }; }, "NA"],
  ["CAPACITY_AVAILABLE", (i) => { i.capacity.requiredCapacityHours = 95; }, "WARNING"],
  ["RESOURCE_CALENDAR_AVAILABLE", (i) => { i.resources = { evaluated: true, conflictingResourceCount: 1, alternateResourceCount: 1 }; }, "WARNING"],
  ["RESOURCE_CALENDAR_AVAILABLE", (i) => { i.resources = { evaluated: true, missingResourceCount: 1, alternateResourceCount: 0 }; }, "FAIL"],
  ["RESOURCE_CALENDAR_AVAILABLE", (i) => { i.resources = {}; }, "NOT_CHECKED"],
  ["ROUTING_SEQUENCE_VALID", (i) => { i.routing.minimumActualGapMinutes = -1; }, "FAIL"],
  ["LOT_BATCH_YIELD_VALID", (i) => { i.lot.roundedMpsQty = 120; }, "WARNING"],
  ["LOT_BATCH_YIELD_VALID", (i) => { i.lot = { evaluated: true, valid: false, deliverable: false }; }, "FAIL"],
  ["LOT_BATCH_YIELD_VALID", (i) => { i.lot = {}; }, "NOT_CHECKED"],
  ["LEAD_TIME_AND_FINISH_FIT", (i) => { i.schedule.projectedCustomerArrivalAt = "2026-09-19T12:00:00Z"; }, "WARNING"],
  ["LEAD_TIME_AND_FINISH_FIT", (i) => { i.schedule.projectedCustomerArrivalAt = null; i.schedule.earliestFeasibleDeliveryAt = null; }, "NOT_CHECKED"],
  ["QUALITY_RELEASE_READY", (i) => { i.quality.qcDelayMinutes = 30; }, "WARNING"],
  ["QUALITY_RELEASE_READY", (i) => { i.quality.causesDeliveryMiss = true; }, "FAIL"],
  ["QUALITY_RELEASE_READY", (i) => { i.quality = {}; }, "NOT_CHECKED"],
  ["DELIVERY_SLOT_AVAILABLE", (i) => { i.delivery.projectedCustomerArrivalAt = "2026-09-19T12:00:00Z"; }, "WARNING"],
  ["DELIVERY_SLOT_AVAILABLE", (i) => { i.delivery.slotAvailable = false; }, "FAIL"],
  ["DELIVERY_SLOT_AVAILABLE", (i) => { i.delivery = {}; }, "NOT_CHECKED"],
  ["BUFFER_POLICY_MET", (i) => { i.buffer = { targetQty: 10 }; }, "NOT_CHECKED"],
];
for (const [code, mutate, expected] of cases) assert.equal(find(build(mutate), code).status, expected, `${code} should be ${expected}`);

assert.deepEqual(Object.values(CHECK_STATUS), ["PASS", "WARNING", "FAIL", "NOT_CHECKED", "NA"]);
console.log("MPS schedule feasibility verification passed (12 rules, row types, aggregation, counts, reconciliation)." );
