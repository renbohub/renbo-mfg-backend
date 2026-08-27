"use strict";

// Delivery promotion is evaluated from revision-bound snapshots, never from a
// lifecycle label alone.

const { createHash } = require("crypto");

const text = (value) => String(value ?? "").trim();
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const iso = (value) => {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};
const sameInstant = (left, right) => iso(left) === iso(right);

function normalizeDeliveryFeasibility(value) {
  const status = text(value).toUpperCase();
  if (["FEASIBLE", "ON_TIME", "SAFE"].includes(status)) return "FEASIBLE";
  if (["AT_RISK", "WARNING"].includes(status)) return "AT_RISK";
  if (["NOT_FEASIBLE", "INFEASIBLE", "LATE", "BLOCKER", "CAPACITY_LATE", "MATERIAL_LATE"].includes(status)) return "INFEASIBLE";
  if (status === "STALE") return "STALE";
  return "UNKNOWN";
}

function hasCompleteAcceptLate(snapshot = {}) {
  return snapshot.dispositionStatus === "ACCEPT_LATE_APPROVED"
    && Boolean(iso(snapshot.acceptLateNewDate))
    && text(snapshot.acceptLateReason).length >= 10
    && Boolean(text(snapshot.decisionApprovedBy))
    && Boolean(iso(snapshot.decisionApprovedAt));
}

function deriveMpsDeliveryGate(input = []) {
  const snapshots = Array.isArray(input) ? input : [];
  if (!snapshots.length) return {
    feasibilityStatus: "STALE",
    dispositionStatus: "NONE",
    officialGateStatus: "BLOCKED",
    blockerCount: 1,
    exceptionCount: 0,
    reason: "MPS belum memiliki snapshot feasibility delivery untuk revisi aktif.",
  };

  const normalized = snapshots.map((row) => ({
    ...row,
    feasibilityStatus: row.sourceCurrent === false ? "STALE" : normalizeDeliveryFeasibility(row.feasibilityStatus),
    dispositionStatus: text(row.dispositionStatus).toUpperCase() || "NONE",
  }));
  const stale = normalized.filter((row) => ["STALE", "UNKNOWN"].includes(row.feasibilityStatus));
  const unresolved = normalized.filter((row) => row.feasibilityStatus === "INFEASIBLE" && !hasCompleteAcceptLate(row));
  const exceptions = normalized.filter((row) => row.feasibilityStatus === "INFEASIBLE" && hasCompleteAcceptLate(row));
  const risks = normalized.filter((row) => row.feasibilityStatus === "AT_RISK");
  const feasibilityStatus = stale.length
    ? "STALE"
    : normalized.some((row) => row.feasibilityStatus === "INFEASIBLE")
      ? "INFEASIBLE"
      : risks.length
        ? "AT_RISK"
        : "FEASIBLE";
  const dispositions = [...new Set(normalized.map((row) => row.dispositionStatus).filter((value) => value !== "NONE"))];
  const dispositionStatus = dispositions.length === 1 ? dispositions[0] : dispositions.length > 1 ? "MIXED" : "NONE";
  const blockerCount = stale.length + unresolved.length;
  const officialGateStatus = blockerCount > 0
    ? "BLOCKED"
    : exceptions.length > 0
      ? "APPROVED_WITH_EXCEPTION"
      : "READY_TO_RELEASE";
  const reason = stale.length
    ? `${stale.length} delivery phase belum diperiksa atau snapshot-nya sudah berubah.`
    : unresolved.length
      ? `${unresolved.length} delivery phase infeasible belum mempunyai keputusan yang dapat dipromosikan.`
      : exceptions.length
        ? `${exceptions.length} delivery phase menggunakan Accept Late yang telah disetujui.`
        : risks.length
          ? `${risks.length} delivery phase berisiko tetapi masih memenuhi tanggal delivery.`
          : "Seluruh delivery phase feasible untuk revisi MPS aktif.";

  return { feasibilityStatus, dispositionStatus, officialGateStatus, blockerCount, exceptionCount: exceptions.length, reason };
}

function shouldRetireOfficialMrp(gate = {}) {
  return text(gate.officialGateStatus).toUpperCase() === "BLOCKED";
}

async function retireOfficialMrpWhenBlocked(tx, doc, gate) {
  if (!shouldRetireOfficialMrp(gate)) return { count: 0 };
  return tx.mRPRun.updateMany({
    where: {
      mpsNumber: doc.mpsNumber,
      isDeleted: false,
      isCurrentPlan: true,
    },
    data: {
      isCurrentPlan: false,
      scenarioStatus: "SUPERSEDED",
    },
  });
}

function recoveryDisposition(plan) {
  if (!plan) return "NONE";
  const acceptLate = plan.decisionType === "ACCEPT_LATE"
    || (Array.isArray(plan.checklist) && plan.checklist.some((item) => item.id === "ACCEPT_LATE" && item.selected));
  if (acceptLate) {
    if (plan.status === "APPROVED") return "ACCEPT_LATE_APPROVED";
    if (plan.status === "PENDING_APPROVAL") return "ACCEPT_LATE_PENDING";
  }
  if (plan.status === "APPROVED") return "RECOVERY_APPROVED";
  if (["DRAFT", "PENDING_APPROVAL", "REPLAN_REQUIRED"].includes(plan.status)) return "RECOVERY_PENDING";
  return "NONE";
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function buildSnapshotInputs(tx, doc) {
  const sources = (doc.details || []).flatMap((detail) => (detail.demandSources || []).flatMap((source) => {
    const pegging = Array.isArray(source.sourcePegging) ? source.sourcePegging.filter((row) => row.deliveryTargetId) : [];
    if (pegging.length) return pegging.map((row) => ({
      detail,
      source: {
        ...source,
        deliveryTargetId: row.deliveryTargetId,
        targetDeliveryDate: row.targetDeliveryDate || source.targetDeliveryDate,
        qty: number(row.qty),
      },
    }));
    return source.deliveryTargetId ? [{ detail, source }] : [];
  }));
  const targetIds = [...new Set(sources.map(({ source }) => source.deliveryTargetId))];
  if (!targetIds.length) return [];
  const [targets, decisions, recoveryPlans] = await Promise.all([
    tx.demandDeliveryTarget.findMany({ where: { id: { in: targetIds }, isDeleted: false } }),
    tx.demandPlanningDecision.findMany({ where: { deliveryTargetId: { in: targetIds }, isDeleted: false } }),
    tx.dueDateRecoveryPlan.findMany({ where: { deliveryTargetId: { in: targetIds }, isCurrentPlan: true, isDeleted: false }, orderBy: { revision: "desc" } }),
  ]);
  const targetById = new Map(targets.map((row) => [row.id, row]));
  const decisionById = new Map(decisions.map((row) => [row.deliveryTargetId, row]));
  const recoveryById = new Map();
  recoveryPlans.forEach((row) => { if (!recoveryById.has(row.deliveryTargetId)) recoveryById.set(row.deliveryTargetId, row); });
  const grouped = new Map();
  for (const entry of sources) {
    const key = entry.source.deliveryTargetId;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(entry);
  }

  return [...grouped.entries()].map(([deliveryTargetId, entries]) => {
    const first = entries[0];
    const target = targetById.get(deliveryTargetId);
    const decision = decisionById.get(deliveryTargetId);
    const recovery = recoveryById.get(deliveryTargetId);
    const originalTargetDate = target?.targetDate || first.source.targetDeliveryDate || first.source.requiredDate;
    // A fresh snapshot captures the current target and decision timestamps.
    // Do not require the decision row to be newer: target synchronization may
    // touch updatedAt without changing the committed date or quantity. Future
    // mutations are still detected by getMpsDeliveryGate through the captured
    // timestamp fingerprint.
    const sourceCurrent = Boolean(target && target.status === "ACTIVE" && decision
      && sameInstant(decision.targetDeliveryDate, target.targetDate));
    const dispositionStatus = recoveryDisposition(recovery);
    const acceptLateNewDate = recovery?.acceptedDeliveryDate
      || (Array.isArray(recovery?.checklist) ? recovery.checklist.find((item) => item.id === "ACCEPT_LATE" && item.selected)?.targetDate : null);
    const acceptLateReason = recovery?.acceptLateReason
      || (Array.isArray(recovery?.checklist) ? recovery.checklist.find((item) => item.id === "ACCEPT_LATE" && item.selected)?.notes : null);
    const base = {
      deliveryTargetId,
      sourceType: first.source.sourceType,
      sourceNumber: first.source.sourceNumber,
      sourceLineId: first.source.sourceLineId,
      partCode: first.detail.partCode,
      quantity: entries.reduce((sum, row) => sum + number(row.source.qty), 0),
      originalTargetDate,
      effectiveCommitmentDate: dispositionStatus === "ACCEPT_LATE_APPROVED" ? acceptLateNewDate : originalTargetDate,
      feasibilityStatus: sourceCurrent ? normalizeDeliveryFeasibility(decision.feasibilityStatus) : "STALE",
      dispositionStatus,
      recoveryPlanId: recovery?.id || null,
      recoveryPlanRevision: recovery?.revision || null,
      acceptLateNewDate: acceptLateNewDate || null,
      acceptLateReason: acceptLateReason || null,
      decisionApprovedBy: recovery?.approvedBy || null,
      decisionApprovedAt: recovery?.approvedAt || null,
      targetUpdatedAt: target?.updatedAt || null,
      decisionUpdatedAt: decision?.updatedAt || null,
      recoveryUpdatedAt: recovery?.updatedAt || null,
      sourceCurrent,
    };
    return {
      ...base,
      sourceFingerprint: fingerprint({ mpsRevision: doc.revision, ...base, originalTargetDate: iso(base.originalTargetDate), effectiveCommitmentDate: iso(base.effectiveCommitmentDate), targetUpdatedAt: iso(base.targetUpdatedAt), decisionUpdatedAt: iso(base.decisionUpdatedAt), recoveryUpdatedAt: iso(base.recoveryUpdatedAt) }),
      assessmentDetail: {
        demandPlanningStatus: decision?.status || "UNREVIEWED",
        demandFeasibilityStatus: decision?.feasibilityStatus || "NOT_SIMULATED",
        criticalConstraint: decision?.criticalConstraint || null,
        earliestFeasibleDeliveryDate: iso(decision?.earliestFeasibleDeliveryDate),
        recoveryStatus: recovery?.status || null,
      },
    };
  });
}

async function refreshMpsDeliveryFeasibility(tx, mpsNumber) {
  const doc = await tx.mPS.findFirst({
    where: { mpsNumber, isDeleted: false },
    include: { details: { where: { isDeleted: false }, include: { demandSources: true } } },
  });
  if (!doc) throw Object.assign(new Error("MPS tidak ditemukan."), { statusCode: 404 });
  const inputs = await buildSnapshotInputs(tx, doc);
  await tx.mPSDeliveryFeasibilitySnapshot.deleteMany({ where: { mpsId: doc.id, mpsRevision: doc.revision } });
  const snapshots = inputs.map((row) => {
    const gate = deriveMpsDeliveryGate([row]);
    const { sourceCurrent, ...data } = row;
    return { ...data, mpsId: doc.id, mpsRevision: doc.revision, officialGateStatus: gate.officialGateStatus };
  });
  if (snapshots.length) await tx.mPSDeliveryFeasibilitySnapshot.createMany({ data: snapshots });
  const gate = deriveMpsDeliveryGate(inputs);
  const aggregateFingerprint = fingerprint(snapshots.map((row) => row.sourceFingerprint).sort());
  await tx.mPS.update({ where: { id: doc.id }, data: {
    deliveryFeasibilityStatus: gate.feasibilityStatus,
    deliveryDispositionStatus: gate.dispositionStatus,
    officialGateStatus: gate.officialGateStatus,
    deliveryFeasibilityCheckedAt: new Date(),
    deliveryFeasibilityFingerprint: aggregateFingerprint,
    deliveryFeasibilityReason: gate.reason,
  } });
  await retireOfficialMrpWhenBlocked(tx, doc, gate);
  return { ...gate, fingerprint: aggregateFingerprint, snapshots: inputs };
}

function deliveryTargetIdsFromMps(doc = {}) {
  const ids = (doc.details || []).flatMap((detail) => (detail.demandSources || []).flatMap((source) => {
    const pegging = Array.isArray(source.sourcePegging)
      ? source.sourcePegging.map((row) => text(row?.deliveryTargetId)).filter(Boolean)
      : [];
    return pegging.length ? pegging : [text(source.deliveryTargetId)].filter(Boolean);
  }));
  return [...new Set(ids)];
}

async function reviewMpsDeliveryFeasibility(tx, mpsNumber, options = {}, services = {}) {
  const doc = await tx.mPS.findFirst({
    where: { mpsNumber, isDeleted: false },
    include: { details: { where: { isDeleted: false }, include: { demandSources: true } } },
  });
  if (!doc) throw Object.assign(new Error("MPS tidak ditemukan."), { statusCode: 404 });

  const availableIds = deliveryTargetIdsFromMps(doc);
  const requestedIds = [...new Set((Array.isArray(options.deliveryTargetIds) ? options.deliveryTargetIds : [])
    .map((value) => text(value)).filter(Boolean))];
  const selectedIds = requestedIds.length ? requestedIds : availableIds;
  const outsideIds = selectedIds.filter((id) => !availableIds.includes(id));
  if (outsideIds.length) {
    throw Object.assign(new Error(`${outsideIds.length} delivery target bukan bagian dari revisi MPS aktif.`), {
      statusCode: 400,
      code: "MPS_DELIVERY_TARGET_OUTSIDE_REVISION",
      deliveryTargetIds: outsideIds,
    });
  }
  if (!selectedIds.length) {
    throw Object.assign(new Error("MPS belum memiliki delivery phase yang dapat diperiksa."), { statusCode: 400 });
  }

  const review = services.reviewDemand
    || require("./demandPlanningService").reviewDemand;
  const refresh = services.refreshMpsDeliveryFeasibility
    || refreshMpsDeliveryFeasibility;
  for (const deliveryTargetId of selectedIds) {
    await review(tx, deliveryTargetId, { runFeasibility: true, status: "REVIEWED" }, options.actor || "system");
  }
  const gate = await refresh(tx, doc.mpsNumber);
  return { mpsNumber: doc.mpsNumber, reviewedCount: selectedIds.length, reviewedDeliveryTargetIds: selectedIds, gate };
}

async function getMpsDeliveryGate(tx, mpsOrNumber) {
  const doc = typeof mpsOrNumber === "string"
    ? await tx.mPS.findFirst({ where: { mpsNumber: mpsOrNumber, isDeleted: false } })
    : mpsOrNumber;
  if (!doc) throw Object.assign(new Error("MPS tidak ditemukan."), { statusCode: 404 });
  const rows = await tx.mPSDeliveryFeasibilitySnapshot.findMany({
    where: { mpsId: doc.id, mpsRevision: doc.revision },
    orderBy: [{ originalTargetDate: "asc" }, { sourceNumber: "asc" }],
  });
  const targetIds = rows.map((row) => row.deliveryTargetId);
  const [targets, decisions, recoveries] = targetIds.length ? await Promise.all([
    tx.demandDeliveryTarget.findMany({ where: { id: { in: targetIds }, isDeleted: false } }),
    tx.demandPlanningDecision.findMany({ where: { deliveryTargetId: { in: targetIds }, isDeleted: false } }),
    tx.dueDateRecoveryPlan.findMany({ where: { deliveryTargetId: { in: targetIds }, isCurrentPlan: true, isDeleted: false } }),
  ]) : [[], [], []];
  const targetById = new Map(targets.map((row) => [row.id, row]));
  const decisionById = new Map(decisions.map((row) => [row.deliveryTargetId, row]));
  const recoveryById = new Map(recoveries.map((row) => [row.deliveryTargetId, row]));
  const snapshots = rows.map((row) => {
    const target = targetById.get(row.deliveryTargetId);
    const decision = decisionById.get(row.deliveryTargetId);
    const recovery = recoveryById.get(row.deliveryTargetId);
    const sourceCurrent = doc.deliveryFeasibilityStatus !== "STALE"
      && Boolean(target && decision)
      && sameInstant(target.updatedAt, row.targetUpdatedAt)
      && sameInstant(decision.updatedAt, row.decisionUpdatedAt)
      && sameInstant(recovery?.updatedAt, row.recoveryUpdatedAt);
    return { ...row, sourceCurrent };
  });
  const gate = deriveMpsDeliveryGate(snapshots);
  if (gate.officialGateStatus !== "BLOCKED" && doc.status === "Confirmed" && doc.lifecycleStatus === "APPROVED") {
    gate.officialGateStatus = gate.officialGateStatus === "APPROVED_WITH_EXCEPTION" || doc.officialGateStatus === "APPROVED_WITH_EXCEPTION"
      ? "APPROVED_WITH_EXCEPTION"
      : "OFFICIAL";
  }
  return { ...gate, snapshots };
}

async function invalidateMpsDeliveryGate(tx, mpsNumber, reason) {
  return tx.mPS.update({ where: { mpsNumber }, data: {
    deliveryFeasibilityStatus: "STALE",
    officialGateStatus: "BLOCKED",
    deliveryFeasibilityReason: text(reason) || "Sumber MPS berubah; feasibility delivery harus dihitung ulang.",
  } });
}

async function assertMpsDeliveryApprovalAllowed(tx, doc) {
  const gate = await getMpsDeliveryGate(tx, doc);
  if (gate.officialGateStatus === "BLOCKED") {
    const error = Object.assign(new Error(gate.reason), { statusCode: 409, code: "MPS_DELIVERY_FEASIBILITY_BLOCKED", deliveryGate: gate });
    throw error;
  }
  return gate;
}

async function assertOfficialMpsDeliveryGate(tx, docs) {
  const results = [];
  for (const doc of docs) results.push({ mpsNumber: doc.mpsNumber, ...(await getMpsDeliveryGate(tx, doc)) });
  const blocked = results.find((row) => row.officialGateStatus === "BLOCKED");
  if (blocked) throw Object.assign(new Error(`${blocked.mpsNumber}: ${blocked.reason}`), { statusCode: 409, code: "MRP_OFFICIAL_DELIVERY_GATE_BLOCKED", deliveryGate: blocked, deliveryGates: results });
  return results;
}

module.exports = {
  normalizeDeliveryFeasibility,
  deriveMpsDeliveryGate,
  shouldRetireOfficialMrp,
  refreshMpsDeliveryFeasibility,
  deliveryTargetIdsFromMps,
  reviewMpsDeliveryFeasibility,
  getMpsDeliveryGate,
  invalidateMpsDeliveryGate,
  assertMpsDeliveryApprovalAllowed,
  assertOfficialMpsDeliveryGate,
};
