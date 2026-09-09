"use strict";
const assert = require("node:assert/strict");
const { firmSupplyEvidence, operationalEvidence } = require("../src/prisma/services/planning/mpsChecklistEvidenceService");
const { buildMpsFeasibilityAssessment } = require("../src/prisma/services/planning/mpsFeasibilityAssessmentService");
const component = { partCode: "RM1", qty: 100, openingQty: 20, requiredDate: "2026-09-10", eligibleSupply: [{ sourceType: "PO", sourceNumber: "PO1", qty: 80, availableDate: "2026-09-09", confidence: "FIRM" }], lateSupply: [] };
const firm = firmSupplyEvidence([component], true);
assert.equal(firm.onTimeFirmReceiptQty, 1);
assert.equal(firm.causesDeliveryMiss, false);
assert.equal(firmSupplyEvidence([{ ...component, openingQty: 100 }], true).externalDependent, false);
const noPo = firmSupplyEvidence([{ ...component, eligibleSupply: [] }], true);
assert.equal(noPo.onTimeFirmReceiptQty, 0);
assert.equal(noPo.causesDeliveryMiss, true, "no PO is a measured shortage, not unchecked");
const unconfirmed = firmSupplyEvidence([{ ...component, eligibleSupply: [{ ...component.eligibleSupply[0], confidence: "PLANNED" }] }], true);
assert.equal(unconfirmed.unconfirmedReceiptQty, 1);
assert.equal(unconfirmed.causesDeliveryMiss, false);
const surplusLate = firmSupplyEvidence([{ ...component, lateSupply: [{ confidence: "FIRM", qty: 500 }] }], true);
assert.equal(surplusLate.lateReceiptQty, 0, "unused late supply must not fail an already covered component");
assert.equal(firmSupplyEvidence([component], false).externalDependent, null);
assert.equal(firmSupplyEvidence([{ ...component, openingQty: null }], true).firmReceiptQty, undefined);

const source = () => ({
  requiredAt: "2026-09-20", phaseQty: 100, dueQty: 100, stockUsedQty: 0, qcHoldQty: 20,
  routeProcesses: [{ routingOperation: { id: "OP1", yieldPercent: 100 } }],
  snapshot: { sourceCurrent: true, sourceType: "SALES_ORDER", sourceNumber: "SO1", sourceLineId: "SOL1", feasibilityStatus: "FEASIBLE", assessmentDetail: {
    materialCoverage: [component],
    earliestFgCalculation: { dispatchDays: 1, earliestFeasibleFgDate: "2026-09-14", earliestFeasibleDeliveryDate: "2026-09-15" },
    processTimeline: [{ processCode: "INS-PACK", solverTaskId: "PROCESS_2" }],
    solver: { forward: { status: "OPTIMAL", tasks: [{ id: "PROCESS_2", startDate: "2026-09-13", endDate: "2026-09-14" }] } },
  } },
  deliverySchedules: [{ scheduleNumber: "DS1", soNumber: "SO1", soDetailId: "SOL1", plannedDate: "2026-09-20", plannedQty: 100, carrier: "CARRIER1", status: "Scheduled" }],
});
const result = operationalEvidence(source());
assert.equal(result.quality.evaluated, true);
assert.equal(result.quality.qcDelayMinutes, 0);
assert.equal(result.delivery.evaluated, true);
assert.equal(result.delivery.slotAvailable, true);
assert.equal(result.lot.evaluated, true);
const stale = source(); stale.snapshot.sourceCurrent = false;
assert.equal(operationalEvidence(stale).quality.evaluated, false);
assert.equal(operationalEvidence(stale).delivery.evaluated, false);
const failedSolver = source(); failedSolver.snapshot.assessmentDetail.solver.forward.status = "INFEASIBLE";
assert.equal(operationalEvidence(failedSolver).quality.evaluated, false);
const differentBatch = source(); differentBatch.deliverySchedules[0].plannedDate = "2026-09-21";
assert.equal(operationalEvidence(differentBatch).delivery.evaluated, false);
const wrongLine = source(); wrongLine.deliverySchedules[0].soDetailId = "OTHER";
assert.equal(operationalEvidence(wrongLine).delivery.evaluated, false);
const noCarrier = source(); noCarrier.deliverySchedules[0].carrier = null;
assert.deepEqual(operationalEvidence(noCarrier).delivery.missingFields, ["deliverySchedule.carrierOrVehicle"]);
const shortBooking = source(); shortBooking.deliverySchedules[0].plannedQty = 50;
assert.equal(operationalEvidence(shortBooking).delivery.slotAvailable, false);
const stockOnly = source(); stockOnly.phaseQty = 0; stockOnly.stockUsedQty = 100;
assert.equal(operationalEvidence(stockOnly).quality.stockReleased, true);
const noRouting = source(); noRouting.routeProcesses = [];
assert.equal(operationalEvidence(noRouting).lot.evaluated, false);
const yieldRisk = source(); yieldRisk.routeProcesses[0].routingOperation.yieldPercent = 90;
assert.equal(operationalEvidence(yieldRisk).lot.requiresYieldAllowance, true);

const assessment = buildMpsFeasibilityAssessment({ ...source(), mpsQty: 100, rowType: "BATCH", ...result });
assert.equal(assessment.checks.length, 12);
assert.equal(assessment.checkedCount, assessment.totalCount);
assert(assessment.missingDataCount > 0, "checking every rule is not a promise that missing source data passes");
assert.equal(assessment.checks.find((row) => row.code === "FIRM_SUPPLY_ON_TIME").status, "PASS");
const shortageAssessment = buildMpsFeasibilityAssessment({ ...source(), mpsQty: 100, rowType: "BATCH", ...result, firmSupply: noPo });
assert.equal(shortageAssessment.checks.find((row) => row.code === "FIRM_SUPPLY_ON_TIME").status, "FAIL");
const complete = buildMpsFeasibilityAssessment({ ...source(), mpsQty: 100, rowType: "BATCH", ...result,
  masterData: { ready: true },
  inventory: { usableStockQty: 0, onTimeReceiptQty: 0, scheduledOutputByDue: 100, dueDemandQty: 100 },
  materials: { components: [{ ...component, shortageQty: 0 }] },
  capacity: { requiredCapacityHours: 50, netAvailableCapacityHours: 100 },
  resources: { evaluated: true, missingResourceCount: 0, conflictingResourceCount: 0 },
  routing: { evaluated: true, invalidSequenceCount: 0, overlapCount: 0, minimumActualGapMinutes: 10 },
  schedule: { requiredDeliveryAt: "2026-09-20", projectedCustomerArrivalAt: "2026-09-15" },
  buffer: { targetQty: 10, projectedEndingQty: 10 },
});
assert.equal(complete.checkedCount, 12);
assert.equal(complete.totalCount, 12);
assert.equal(complete.notCheckedCount, 0, "all rules resolve when actual source evidence is complete");
assert.equal(complete.okCount + complete.warningCount + complete.failCount, 12);
console.log("MPS checklist evidence: firm receipts, QC solver, yield, exact delivery booking, missing/stale data and full rule traversal passed.");
