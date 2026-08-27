const assert = require("assert");
const {
  buildAuthoritativePhaseResults,
  mergeAuthoritativeRecommendationSummary,
  uniqueBlockers,
  visibleStoredRecommendationBlockers,
} = require("../src/prisma/services/planning/capacityRecommendationValidationService");
const { applyUnscheduledNoticePolicy } = require("../src/prisma/services/planning/capacityPlanningService");

const algorithmBlocker = { code: "CAPACITY_BEFORE_DUE_UNAVAILABLE", phaseId: "phase-1", phaseNumber: 1 };
const validationBlocker = { code: "PLAN_PREDECESSOR_QTY_SHORT", allocationId: "allocation-2", processCode: "PACK" };
const duplicateValidationBlocker = { ...validationBlocker };
const blockers = uniqueBlockers([algorithmBlocker, validationBlocker, duplicateValidationBlocker]);
assert.strictEqual(blockers.length, 2, "Authoritative blocker contract must de-duplicate identical algorithm/validator evidence");

const phaseResults = buildAuthoritativePhaseResults({
  phaseResults: [
    { phaseId: "phase-1", phaseNumber: 1, status: "BLOCKED", qty: 100 },
    { phaseId: "phase-2", phaseNumber: 2, status: "COVERED", qty: 200 },
  ],
  blockers,
  allocationPhases: [{ id: "allocation-2", deliveryPhaseId: "phase-2", deliveryPhaseNumber: 2 }],
});
assert.deepStrictEqual(phaseResults.map((phase) => phase.status), ["BLOCKED", "BLOCKED"], "Validator blockers linked through allocation lineage must update the affected phase status");
assert.deepStrictEqual(phaseResults[1].blockerCodes, ["PLAN_PREDECESSOR_QTY_SHORT"]);
assert.strictEqual(phaseResults[1].algorithmStatus, "COVERED", "Authoritative status must retain the original algorithm status for audit");

const currentSummary = {
  version: "FINITE-CAPACITY-PIPELINE-V6-WEIGHTED-SCORING",
  scoringSummary: { averageScore: 88.5 },
  capacityFlowRule: { active: { name: "Keep me" } },
  blockerCount: 0,
  coveredPhaseCount: 2,
};
const merged = mergeAuthoritativeRecommendationSummary(currentSummary, {
  recommendation: { allocationReady: true, phaseResults },
  allocationBlockers: [algorithmBlocker],
  validationBlockers: [validationBlocker],
  readiness: { ok: false, blockingCount: 1, warningCount: 2, overridableCount: 1, infoCount: 3, categories: { SEQUENCE: 1 } },
  allocationPhases: [{ id: "allocation-2", deliveryPhaseId: "phase-2", deliveryPhaseNumber: 2 }],
  validatedAt: "2026-08-09T12:00:00.000Z",
});
assert.strictEqual(merged.ready, false);
assert.strictEqual(merged.blockerCount, 2);
assert.strictEqual(merged.coveredPhaseCount, 0);
assert.strictEqual(merged.authoritativeValidation.status, "BLOCKED");
assert.strictEqual(merged.authoritativeValidation.validationBlockerCount, 1);
assert.deepStrictEqual(merged.scoringSummary, currentSummary.scoringSummary, "Post-validation merge must preserve scoring evidence");
assert.deepStrictEqual(merged.capacityFlowRule, currentSummary.capacityFlowRule, "Post-validation merge must preserve unrelated recommendation summary fields");

const readySummary = mergeAuthoritativeRecommendationSummary(currentSummary, {
  recommendation: { allocationReady: true, phaseResults: [{ phaseId: "phase-1", phaseNumber: 1, status: "COVERED" }] },
  readiness: { ok: true },
  validatedAt: "2026-08-09T12:00:00.000Z",
});
assert.strictEqual(readySummary.ready, true);
assert.strictEqual(readySummary.blockerCount, 0);
assert.strictEqual(readySummary.coveredPhaseCount, 1);
assert.strictEqual(readySummary.authoritativeValidation.status, "READY");

const stalePlan = {
  replanRequired: true,
  recommendationSummary: {
    blockers: [{ code: "VENDOR_RETURN_AFTER_REQUIRED_DATE", partCode: "C002-C004-020" }],
  },
};
assert.deepStrictEqual(visibleStoredRecommendationBlockers(stalePlan, {
  readiness: { ok: true },
  deliveryCoverage: { ready: true },
}), [], "Fresh authoritative READY snapshot must suppress a stale persisted validator blocker");
assert.strictEqual(visibleStoredRecommendationBlockers(stalePlan, {
  readiness: { ok: false },
  deliveryCoverage: { ready: true },
}).length, 1, "Stored blocker must remain visible while the live snapshot is still blocked");

const unscheduledIssues = [
  { code: "PLAN_ROUTING_MISSING", severity: "blocking" },
  { code: "PLAN_CAPACITY_SHORTAGE", severity: "overridable" },
  { code: "PLAN_MACHINE_TIME_OVERLAP", severity: "blocking" },
];
const unscheduledRows = [{ reason: "Routing process belum tersedia" }];
applyUnscheduledNoticePolicy(unscheduledIssues, unscheduledRows);
assert.strictEqual(unscheduledIssues[0].severity, "warning", "Unscheduled routing must be a follow-up warning");
assert.strictEqual(unscheduledIssues[1].severity, "warning", "Unscheduled capacity shortage must not block release");
assert.strictEqual(unscheduledIssues[2].severity, "blocking", "A real machine overlap must remain blocking");
assert.strictEqual(unscheduledRows[0].noticeCode, "UNSCHEDULED_FOLLOW_UP", "Unscheduled rows must carry an auditable notice code");
assert.strictEqual(unscheduledRows[0].requiresFollowUp, true, "Unscheduled warning must stay visible for the next review");

console.log("Capacity authoritative post-validation checks passed: 21/21 cases");
