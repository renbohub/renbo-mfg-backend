"use strict";
const assert = require("node:assert/strict");
const { buildMpsFeasibilityAssessment: build, aggregateMpsFeasibilityAssessments: aggregate, deliverySuggestion } = require("../src/prisma/services/planning/mpsProductionChecksheetService");
const { validateRequest, updateFeedback } = require("../src/prisma/services/planning/mpsRecoveryRequestService");
const base = {
  asOf: "2026-09-05", rowType: "BATCH", mpsQty: 100,
  identity: { lineId: "D::batch::B1", mpsNumber: "MPS1", mpsRevision: 2 },
  materials: { components: [{ partCode: "RM1", qty: 100, shortageQty: 0, requiredDate: "2026-09-20", supplierCode: "S1", latestPrDate: "2026-09-10", procurementLeadTimeDays: 10 }] },
  capacity: { rccpRunId: "R2", status: "FEASIBLE", requiredCapacityHours: 30, netAvailableCapacityHours: 100 },
  vendor: { bomAvailable: true, processes: [] },
  schedule: { requiredDeliveryAt: "2026-10-01", projectedCustomerArrivalAt: "2026-09-25" },
};
const clone = () => structuredClone(base);
let input = clone(), assessment = build(input);
assert.deepEqual(assessment.checks.map((c) => c.code), ["MPS_MATERIAL", "MPS_CAPACITY", "MPS_VENDOR"]);
assert.equal(assessment.summary.status, "FEASIBLE"); assert.equal(assessment.summary.totalCount, 2); assert.equal(assessment.summary.checkedCount, 2);
assert.equal(assessment.checks[2].status, "NA");
input.materials.components[0].shortageQty = 30;
assert.equal(build(input).checks[0].status, "WARNING", "shortage with on-time purchasing is not an impossible plan");
input.materials.components[0].latestPrDate = "2026-09-05";
assert.equal(build(input).checks[0].status, "WARNING", "can request on the deadline day");
input.materials.components[0].latestPrDate = "2026-09-04";
assert.equal(build(input).checks[0].status, "FAIL");
input.materials.components[0].latestPrDate = null;
assert.equal(build(input).checks[0].status, "NOT_CHECKED");
input.materials.components[0].procurementWindow = "CUSTOMER_SUPPLIED";
assert.equal(build(input).checks[0].status, "NOT_CHECKED", "do not suggest buying customer-supplied materials");
input = clone(); input.materials.components[0].shortageQty = null;
assert.equal(build(input).checks[0].status, "NOT_CHECKED", "null coverage is not zero shortage");
input.materials.components.push({ ...base.materials.components[0], partCode: "RM2", shortageQty: 10, latestPrDate: "2026-09-01" });
assert.equal(build(input).checks[0].status, "FAIL", "a known late purchase still fails when another component is unknown");
assert.equal(build(input).summary.missingDataCount, 1, "partial missing evidence is counted even in a failed area");
assert.equal(build(input).summary.evaluatedCount, 1);
input = clone(); input.materials.components[0].shortageQty = 30; input.materials.components[0].procurementLeadTimeDays = 0; input.materials.components[0].supplierLeadTimeDays = 7;
assert.equal(build(input).checks[0].status, "NOT_CHECKED", "disabled supplier LT must not produce a false on-time purchase result");
input = clone(); input.materials.components = [];
assert.equal(build(input).checks[0].status, "NOT_CHECKED");
input = clone(); input.capacity.netAvailableCapacityHours = 20;
assert.equal(build(input).checks[1].status, "FAIL");
input.capacity.rccpRunId = null;
assert.equal(build(input).checks[1].status, "NOT_CHECKED");
input = clone(); input.rowType = "BUFFER";
assert.equal(build(input).summary.totalCount, 2, "buffer production still consumes material and capacity");
assert.equal(build({ ...input, mpsQty: 0 }).summary.status, "NA");
input = clone(); input.vendor = {
  bomAvailable: true, current: true, processes: [{ processCode: "PLATING", vendorCode: "V1", vendorLeadTimeDays: 2 }],
  timeline: [{ routingMode: "VENDOR", processCode: "PLATING", vendorCode: "V1", baselineDurationDays: 2, durationDays: 2, latestFinishDate: "2026-09-20", solverTaskId: "PROCESS_1" }],
  solver: { forward: { feasible: true, tasks: [{ id: "PROCESS_1", endDate: "2026-09-19" }] } },
};
assert.equal(build(input).checks[2].status, "PASS");
input.vendor.solver.forward.tasks[0].endDate = "2026-09-21";
assert.equal(build(input).checks[2].status, "FAIL");
input.vendor.timeline[0].durationDays = 1;
assert.equal(build(input).checks[2].status, "NOT_CHECKED", "unconfirmed shortening of BOM lead time must not pass");
input.vendor.current = false;
assert.equal(build(input).checks[2].status, "NOT_CHECKED", "stale solver output cannot pass");
input = clone(); input.vendor.bomAvailable = false;
assert.equal(build(input).checks[2].status, "NOT_CHECKED", "missing BOM is not no vendor");
const rolled = aggregate([build(base), build(input)], { identity: { mpsQty: 200 } });
assert.equal(rolled.checks[2].status, "NOT_CHECKED"); assert.equal(rolled.checks.length, 3);
assert.equal(deliverySuggestion(rolled).eligible, false, "review target per batch, not entire month");

input = clone(); input.capacity.netAvailableCapacityHours = 20; input.schedule.projectedCustomerArrivalAt = "2026-10-03";
assessment = build(input);
const record = { ...input.identity, checkpointCode: "PRODUCTION_CAPACITY", feedbackStatus: "DONE", feedbackNotes: "Overtime dan line lain tidak tersedia", history: [{ recoveryOutcome: "NOT_FEASIBLE", evidenceReference: "Konfirmasi Production 123" }] };
assert.equal(deliverySuggestion(assessment).eligible, false, "untried recovery is not exhausted");
assert.equal(deliverySuggestion(assessment, [{ ...record, history: [] }]).eligible, false, "DONE alone does not imply impossible");
assert.equal(deliverySuggestion(assessment, [{ ...record, mpsRevision: 1 }]).eligible, false, "old revision is invalid evidence");
assert.equal(deliverySuggestion(assessment, [{ ...record, lineId: "another batch" }]).eligible, false);
assert.equal(deliverySuggestion(assessment, [{ ...record, feedbackStatus: "IN_PROGRESS" }]).eligible, false);
assert.equal(deliverySuggestion(assessment, [record]).eligible, true);
const materialInput = structuredClone(input); materialInput.materials.components[0].shortageQty = 20;
assert.equal(deliverySuggestion(build(materialInput), [record]).eligible, false, "all problem areas, not just capacity, need a recovery conclusion");
assert.equal(deliverySuggestion(build({ ...input, rowType: "BUFFER" }), [record]).eligible, false);
input.materials.components = [];
assert.equal(deliverySuggestion(build(input), [record]).eligible, false, "missing material evidence always blocks reschedule");
const request = { lineId: base.identity.lineId, checkpointCode: "DELIVERY_SCHEDULE", notes: "Minta review Sales" };
assert.throws(() => validateRequest(request, assessment), /Tuntaskan review/);
assert.doesNotThrow(() => validateRequest(request, assessment, [record]));
assert.throws(() => validateRequest({ ...request, checkpointCode: "MASTER_DATA" }, assessment), /tidak memiliki masalah/);
async function run() {
  await assert.rejects(updateFeedback({}, {}, "R", { feedbackStatus: "DONE", recoveryOutcome: "NOT_FEASIBLE", feedbackNotes: "Tidak bisa" }), /alasan dan referensi bukti/);
  await assert.rejects(updateFeedback({}, {}, "R", { feedbackStatus: "WAITING", recoveryOutcome: "NOT_FEASIBLE", feedbackNotes: "Tidak bisa", evidenceReference: "E" }), /Tandai Done/);
  console.log("MPS production checksheet: 3 areas, material purchase windows, capacity, vendor BOM, buffer, missing/stale evidence, and server-side last-resort gate PASS");
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
