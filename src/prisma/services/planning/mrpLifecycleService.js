"use strict";

const { createHash } = require("crypto");
const text = (value) => String(value ?? "").trim().toUpperCase();
const CANONICAL_LIFECYCLES = new Set(["DRAFT", "SIMULATED", "APPROVED", "SUPERSEDED"]);

function canonicalMrpLifecycleStatus(value) {
  const lifecycle = text(value);
  // R023 and several earlier working revisions used SIMULATION. It has the
  // same business meaning as SIMULATED, but must never make an unknown state
  // look approvable.
  if (lifecycle === "SIMULATION") return "SIMULATED";
  return CANONICAL_LIFECYCLES.has(lifecycle) ? lifecycle : "UNKNOWN";
}

function mrpCalculationLifecycle(requestedStatus) {
  const requested = text(requestedStatus || "DRAFT");
  if (requested !== "DRAFT") return { allowed: false, code: "MRP_APPROVAL_ENDPOINT_REQUIRED" };
  return { allowed: true, initialStatus: "DRAFT", completedStatus: "SIMULATED", isCurrentPlan: false };
}

function mrpApprovalEligibility(run = {}) {
  const lifecycle = canonicalMrpLifecycleStatus(run.scenarioStatus);
  const runStatus = text(run.status);
  const planningMode = text(run.scenarioAssumptions?.planningMode || "OFFICIAL");
  if (planningMode === "M_PLUS_ONE_PREVIEW") return { allowed: false, code: "LOOKAHEAD_PREVIEW_NOT_APPROVABLE" };
  if (run.isCurrentPlan || lifecycle === "APPROVED") return { allowed: false, code: "MRP_ALREADY_APPROVED" };
  if (runStatus !== "COMPLETED" || lifecycle !== "SIMULATED") return { allowed: false, code: "MRP_NOT_SIMULATED" };
  return { allowed: true, code: "READY_TO_APPROVE" };
}

function mrpApprovalTransitionData(run = {}, actor = "system") {
  return {
    status: "Completed",
    scenarioStatus: "APPROVED",
    isCurrentPlan: true,
    scenarioAssumptions: {
      ...(run.scenarioAssumptions && typeof run.scenarioAssumptions === "object" ? run.scenarioAssumptions : {}),
      approvedFromSnapshot: true,
      approvedBy: actor || "system",
    },
  };
}

function mrpApprovalCycleMpsNumbers(run = {}) {
  const assumptions = run.scenarioAssumptions && typeof run.scenarioAssumptions === "object" ? run.scenarioAssumptions : {};
  // M+1/M+2 are look-ahead inputs only. They can remain Draft or stale without
  // blocking the official MRP for M. Approval gates only executable sources.
  const values = Array.isArray(assumptions.officialSourceMpsNumbers) && assumptions.officialSourceMpsNumbers.length
    ? assumptions.officialSourceMpsNumbers
    : Array.isArray(assumptions.sourceMpsNumbers) && assumptions.sourceMpsNumbers.length
      ? assumptions.sourceMpsNumbers
      : [run.mpsNumber];
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function assertApprovedCurrentMrp(run = {}, actionLabel = "Output MRP") {
  const planningMode = text(run.scenarioAssumptions?.planningMode || "OFFICIAL");
  const valid = text(run.status) === "COMPLETED"
    && text(run.scenarioStatus) === "APPROVED"
    && run.isCurrentPlan === true
    && planningMode !== "M_PLUS_ONE_PREVIEW";
  if (!valid) {
    throw Object.assign(new Error(`${actionLabel} hanya dapat dibuat dari MRP Approved yang menjadi current plan.`), {
      status: 409,
      statusCode: 409,
      code: "MRP_OUTPUT_REQUIRES_APPROVAL",
    });
  }
  return run;
}

function buildMrpSourceSnapshot(mpsRows = []) {
  const rows = [...mpsRows]
    .map((row) => ({
      mpsNumber: String(row.mpsNumber || "").trim(),
      revision: Number(row.revision || 0),
      deliveryFeasibilityFingerprint: row.deliveryFeasibilityFingerprint || null,
    }))
    .filter((row) => row.mpsNumber)
    .sort((left, right) => left.mpsNumber.localeCompare(right.mpsNumber));
  return {
    planningCycleMpsRevisions: rows.map(({ mpsNumber, revision }) => ({ mpsNumber, revision })),
    planningCycleDeliveryFingerprints: rows.map(({ mpsNumber, deliveryFeasibilityFingerprint }) => ({ mpsNumber, fingerprint: deliveryFeasibilityFingerprint })),
  };
}

function mrpSourceSnapshotMatches(assumptions = {}, currentMpsRows = []) {
  const currentNumbers = new Set(currentMpsRows.map((row) => String(row.mpsNumber || "").trim()).filter(Boolean));
  const expectedRevisions = (Array.isArray(assumptions.planningCycleMpsRevisions) ? assumptions.planningCycleMpsRevisions : [])
    .filter((row) => currentNumbers.has(String(row?.mpsNumber || "").trim()));
  const expectedFingerprints = (Array.isArray(assumptions.planningCycleDeliveryFingerprints) ? assumptions.planningCycleDeliveryFingerprints : [])
    .filter((row) => currentNumbers.has(String(row?.mpsNumber || "").trim()));
  if (!expectedRevisions.length || !expectedFingerprints.length) {
    const legacyGates = Array.isArray(assumptions.deliveryGateSnapshot) ? assumptions.deliveryGateSnapshot : [];
    if (!legacyGates.length || legacyGates.length < currentMpsRows.length) return false;
    return currentMpsRows.every((row) => {
      const gate = legacyGates.find((item) => String(item?.mpsNumber || "").trim() === String(row.mpsNumber || "").trim());
      const snapshots = Array.isArray(gate?.snapshots) ? gate.snapshots : [];
      if (!snapshots.length) return false;
      const revisions = [...new Set(snapshots.map((item) => Number(item?.mpsRevision || 0)))];
      const fingerprints = snapshots.map((item) => String(item?.sourceFingerprint || "").trim()).filter(Boolean).sort();
      if (revisions.length !== 1 || revisions[0] !== Number(row.revision || 0) || fingerprints.length !== snapshots.length) return false;
      const aggregate = createHash("sha256").update(JSON.stringify(fingerprints)).digest("hex");
      return aggregate === String(row.deliveryFeasibilityFingerprint || "").trim();
    });
  }
  if (expectedRevisions.length !== currentMpsRows.length || expectedFingerprints.length !== currentMpsRows.length) return false;
  // scenarioAssumptions is persisted as PostgreSQL JSONB. JSONB does not
  // preserve object-key order, so comparing JSON.stringify output can reject
  // an unchanged source (for example { revision, mpsNumber } versus
  // { mpsNumber, revision }). Compare the business keys by MPS number instead.
  const expectedRevisionByMps = new Map(expectedRevisions.map((row) => [
    String(row?.mpsNumber || "").trim(),
    Number(row?.revision || 0),
  ]));
  const expectedFingerprintByMps = new Map(expectedFingerprints.map((row) => [
    String(row?.mpsNumber || "").trim(),
    String(row?.fingerprint || "").trim(),
  ]));
  if (expectedRevisionByMps.size !== currentMpsRows.length || expectedFingerprintByMps.size !== currentMpsRows.length) return false;

  return currentMpsRows.every((row) => {
    const mpsNumber = String(row?.mpsNumber || "").trim();
    return expectedRevisionByMps.has(mpsNumber)
      && expectedFingerprintByMps.has(mpsNumber)
      && expectedRevisionByMps.get(mpsNumber) === Number(row?.revision || 0)
      && expectedFingerprintByMps.get(mpsNumber) === String(row?.deliveryFeasibilityFingerprint || "").trim();
  });
}

module.exports = {
  canonicalMrpLifecycleStatus,
  mrpCalculationLifecycle,
  mrpApprovalEligibility,
  mrpApprovalTransitionData,
  mrpApprovalCycleMpsNumbers,
  assertApprovedCurrentMrp,
  buildMrpSourceSnapshot,
  mrpSourceSnapshotMatches,
};
