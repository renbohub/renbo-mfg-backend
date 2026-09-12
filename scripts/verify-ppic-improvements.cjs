"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const service = require("../src/prisma/services/planning/ppicImprovementService");
const input = () => ({ title: "Kurangi setup", issue: "Setup lama", cause: "Hipotesis penyiapan tooling", proposedAction: "Siapkan tooling sebelum shift", ownerId: "owner", dueDate: "2026-09-10", metric: { name: "Median setup", unit: "minute", direction: "LOWER", target: 30, aggregation: "MEDIAN" }, baseline: { value: 38, sampleSize: 12, windowStart: "2026-08-01", windowEnd: "2026-08-07", evidence: ["SETUP-BEFORE"] }, observation: { value: 29, sampleSize: 12, windowStart: "2026-08-12", windowEnd: "2026-08-19", evidence: ["SETUP-AFTER"] } });
test("measurements require finite values, positive samples, source evidence and explicit metric", () => {
  const payload = service.normalize(input()); assert.equal(payload.baseline.provenance, "USER_RECORDED");
  for (const update of [{ baseline: { ...input().baseline, value: "38" } }, { baseline: { ...input().baseline, sampleSize: 0 } }, { baseline: { ...input().baseline, evidence: [] } }, { baseline: { ...input().baseline, evidence: [{}] } }, { metric: { ...input().metric, aggregation: "AUTOMATIC" } }, { proposedAction: "" }]) assert.throws(() => service.normalize({ ...input(), ...update }), { statusCode: 400 });
});
test("before/after windows must be completed, ordered and comparable without total-period bias", () => {
  const payload = service.normalize(input()); assert.equal(service.comparable(payload, "2026-08-31"), true);
  assert.throws(() => service.comparable(payload, "2026-08-19"), { code: "MEASUREMENT_WINDOW_INCOMPLETE" });
  assert.throws(() => service.comparable({ ...payload, observation: { ...payload.observation, windowStart: "2026-08-07" } }, "2026-08-31"), { code: "MEASUREMENT_WINDOW_OVERLAP" });
  assert.throws(() => service.comparable({ ...payload, metric: { ...payload.metric, aggregation: "SUM" } }, "2026-08-31"), { code: "MEASUREMENT_NOT_COMPARABLE" });
});
test("computed improvement remains measured outcome rather than causal proof", () => {
  const payload = service.normalize(input()), value = service.outcome(payload); assert.equal(value.delta, -9); assert.equal(value.targetMet, true); assert.ok(Math.abs(value.improvementPercent - 9 / 38 * 100) < 1e-9); assert.equal(value.causalAttribution, "REQUIRES_REVIEWER_QUALIFICATION");
  assert.equal(service.outcome({ ...payload, baseline: { ...payload.baseline, value: 0 } }).improvementPercent, null);
  assert.equal(service.outcome({ ...payload, observation: { ...payload.observation, value: 45 } }).measuredDirectionImproved, false);
});
test("review forbids owner and submitter self verification, requires note and locked baseline", () => {
  const payload = { ...service.normalize(input()), measurementActorId: "recorder" }, row = { status: "PENDING_VERIFICATION", owner_id: "owner", submitted_actor_id: "submitter", created_actor_id: "creator", payload, measurement_contract_hash: service.contractHash(payload) };
  assert.equal(service.contractHash({ ...payload, metric: Object.fromEntries(Object.entries(payload.metric).reverse()), baseline: Object.fromEntries(Object.entries(payload.baseline).reverse()) }), row.measurement_contract_hash);
  for (const id of ["owner", "submitter", "creator", "recorder"]) assert.throws(() => service.nextTransition(row, "VERIFY", { id }, "Measured evidence checked", "2026-08-31"), { code: "INDEPENDENT_REVIEW_REQUIRED" });
  assert.throws(() => service.nextTransition(row, "VERIFY", { id: "reviewer" }, "", "2026-08-31"), { code: "REVIEW_NOTE_REQUIRED" });
  assert.equal(service.nextTransition(row, "VERIFY", { id: "reviewer" }, "Evidence reviewed; attribution not conclusive", "2026-08-31"), "VERIFIED");
  assert.throws(() => service.nextTransition({ ...row, measurement_contract_hash: "changed" }, "VERIFY", { id: "reviewer" }, "Reviewed", "2026-08-31"), { code: "MEASUREMENT_CONTRACT_CHANGED" });
});
test("closure needs independent recorded verification and cannot skip workflow", () => {
  const payload = service.normalize(input()), row = { status: "IN_PROGRESS", payload, measurement_contract_hash: service.contractHash(payload) };
  assert.throws(() => service.nextTransition(row, "CLOSE", { id: "owner" }, "", "2026-08-31"), { code: "IMPROVEMENT_STATE_CONFLICT" });
  assert.throws(() => service.nextTransition({ ...row, status: "VERIFIED" }, "CLOSE", { id: "owner" }, "", "2026-08-31"), { code: "INDEPENDENT_REVIEW_REQUIRED" });
  assert.equal(service.nextTransition({ ...row, status: "VERIFIED", verified_actor_id: "reviewer", verification_note: "Checked" }, "CLOSE", { id: "owner" }, "", "2026-08-31"), "CLOSED");
});
