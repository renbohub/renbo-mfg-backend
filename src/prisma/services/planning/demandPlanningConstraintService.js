"use strict";

const ACTIVE_DECISION_STATUSES = ["REVIEWED", "APPROVED", "LOCKED"];
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

function detailsOf(decision) {
  return decision?.constraintDetails && typeof decision.constraintDetails === "object"
    ? decision.constraintDetails
    : {};
}

function leadTimeControls(decision) {
  const controls = detailsOf(decision).leadTimeControls || {};
  return {
    productionProcess: controls.productionProcess !== false,
    supplierLeadTime: controls.supplierLeadTime !== false,
    receivingQc: controls.receivingQc !== false,
    safety: controls.safety !== false,
  };
}

function capacityPolicy(decision) {
  const assumption = detailsOf(decision).capacityAssumption || {};
  return {
    shiftsPerDay: Math.max(number(assumption.shiftsPerDay), 1),
    hoursPerShift: Math.max(number(assumption.hoursPerShift), 8),
  };
}

async function loadDemandPlanningConstraintMap(prisma, targetIds = []) {
  const actualIds = [...new Set(targetIds.filter(Boolean).map(String))];
  if (!actualIds.length
    || typeof prisma?.demandDeliveryTarget?.findMany !== "function"
    || typeof prisma?.demandPlanningDecision?.findMany !== "function") return new Map();
  const targets = await prisma.demandDeliveryTarget.findMany({
    where: { id: { in: actualIds }, isDeleted: false },
    select: { id: true, consumesForecastTargetId: true },
  });
  const lookupIds = [...new Set(targets.flatMap((target) => [target.id, target.consumesForecastTargetId]).filter(Boolean))];
  const decisions = lookupIds.length ? await prisma.demandPlanningDecision.findMany({
    where: { deliveryTargetId: { in: lookupIds }, isDeleted: false, status: { in: ACTIVE_DECISION_STATUSES } },
    orderBy: { updatedAt: "desc" },
  }) : [];
  const byTargetId = new Map();
  for (const decision of decisions) if (!byTargetId.has(decision.deliveryTargetId)) byTargetId.set(decision.deliveryTargetId, decision);
  const result = new Map();
  for (const target of targets) {
    const decision = byTargetId.get(target.id) || byTargetId.get(target.consumesForecastTargetId) || null;
    if (!decision) continue;
    result.set(target.id, {
      ...decision,
      actualDeliveryTargetId: target.id,
      planningDecisionTargetId: decision.deliveryTargetId,
      consumedForecastTargetId: target.consumesForecastTargetId || null,
    });
  }
  return result;
}

function procurementPolicyFromDecision(decision, base = {}) {
  const controls = leadTimeControls(decision);
  return {
    ...base,
    receivingQcDays: controls.receivingQc ? number(base.receivingQcDays ?? 1) : 0,
    safetyLeadTimeDays: controls.safety ? number(base.safetyLeadTimeDays ?? 1) : 0,
  };
}

function applyDecisionToRoutingMetric(metric, decision) {
  if (!metric || !decision) return {
    metric,
    vendorProcesses: [],
    planningEvidence: null,
  };
  const details = detailsOf(decision);
  const policy = capacityPolicy(decision);
  // Lazy import avoids the feasibility -> capacity -> constraint module cycle.
  const { applyVendorProcessAdjustments } = require("./demandFeasibilityService");
  const applied = applyVendorProcessAdjustments(metric, details.vendorProcessAdjustments || [], policy);
  const adjustedMetric = applied.breakdown || metric;
  return {
    metric: {
      ...adjustedMetric,
      productionLeadTimeHours: number(adjustedMetric.exactProductionLeadTimeDays) * policy.hoursPerShift * policy.shiftsPerDay,
      planningDecisionTargetId: decision.planningDecisionTargetId || decision.deliveryTargetId,
      sourceDeliveryTargetId: decision.actualDeliveryTargetId || decision.deliveryTargetId,
      leadTimeControls: leadTimeControls(decision),
      capacityAssumption: policy,
      vendorProcesses: applied.vendorProcesses,
    },
    vendorProcesses: applied.vendorProcesses,
    planningEvidence: {
      planningDecisionTargetId: decision.planningDecisionTargetId || decision.deliveryTargetId,
      sourceDeliveryTargetId: decision.actualDeliveryTargetId || decision.deliveryTargetId,
      consumedForecastTargetId: decision.consumedForecastTargetId || null,
      leadTimeControls: leadTimeControls(decision),
      capacityAssumption: policy,
      vendorProcessAdjustments: applied.adjustments,
      vendorProcesses: applied.vendorProcesses,
    },
  };
}

function matchingVendorProcess(decision, route = {}) {
  const processes = detailsOf(decision).vendorProcesses || [];
  const routeDetailCode = route.mbomDetail?.part?.partCode || route.detailCode || null;
  const routeProcessCode = route.process?.processCode || route.processCode || null;
  const routeVendorCode = route.vendor?.vendorCode || route.vendorCode || null;
  const routeSequence = number(route.routingOperation?.sequence ?? route.sequence);
  return processes.find((process) =>
    (!process.detailCode || !routeDetailCode || String(process.detailCode) === String(routeDetailCode))
    && (!process.processCode || !routeProcessCode || String(process.processCode) === String(routeProcessCode))
    && (!process.vendorCode || !routeVendorCode || String(process.vendorCode) === String(routeVendorCode))
    && (!number(process.sequence) || !routeSequence || number(process.sequence) === routeSequence)) || null;
}

function effectiveVendorLeadTime(route, decision, hoursPerDay = 8) {
  const masterDays = Math.max(number(route?.vendor?.leadTimeDays), 0)
    || Math.max(number(route?.mbomDetail?.leadTime), 0);
  const process = matchingVendorProcess(decision, route);
  if (!process || number(process.adjustedDurationHours) <= 0) {
    return { masterDays, planningDays: masterDays, adjustmentApplied: false, reason: null, process: null };
  }
  return {
    masterDays,
    planningDays: number(process.adjustedDurationHours) / Math.max(number(hoursPerDay), 1),
    adjustmentApplied: Math.abs(number(process.adjustedDurationHours) - number(process.masterDurationHours)) > 0.000001,
    reason: process.reason || null,
    process,
  };
}

module.exports = {
  ACTIVE_DECISION_STATUSES,
  loadDemandPlanningConstraintMap,
  leadTimeControls,
  capacityPolicy,
  procurementPolicyFromDecision,
  applyDecisionToRoutingMetric,
  matchingVendorProcess,
  effectiveVendorLeadTime,
};
