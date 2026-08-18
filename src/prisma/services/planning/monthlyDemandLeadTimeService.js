"use strict";

const { consumeDeliveryTargets } = require("./demandConsumptionService");
const { assessDemandFeasibility } = require("./demandFeasibilityService");
const { loadDemandPlanningConstraintMap, leadTimeControls, capacityPolicy } = require("./demandPlanningConstraintService");

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const roundQty = (value) => Math.round((number(value) + Number.EPSILON) * 1000000) / 1000000;
const iso = (value) => value ? new Date(value).toISOString() : null;
const monthKey = (value) => iso(value)?.slice(0, 7) || null;
const dateOnly = (value) => iso(value)?.slice(0, 10) || null;
const unique = (values) => [...new Set(values.filter(Boolean))];

async function mapLimit(values, limit, mapper) {
  const result = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      result[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), values.length) }, worker));
  return result;
}

function compactProcessStep(step) {
  return {
    sequence: number(step.sequence),
    processCode: step.processCode || null,
    routingMode: step.routingMode || null,
    vendorCode: step.vendorCode || null,
    durationDays: roundQty(step.durationDays),
    durationHours: roundQty(step.durationHours),
    latestStartDate: iso(step.latestStartDate),
    latestFinishDate: iso(step.latestFinishDate),
  };
}

function compactLeadTimePhase(phase, feasibility, planningDecision = null) {
  const calculation = feasibility?.constraintDetails?.earliestFgCalculation || {};
  const materialShortages = feasibility?.constraintDetails?.materialShortages || [];
  const productionStart = feasibility?.productionLatestStartDate;
  const requestedDelivery = feasibility?.requestedDeliveryDate || phase.targetDate;
  const startPreviousMonth = Boolean(productionStart && monthKey(productionStart) < monthKey(requestedDelivery));
  const late = feasibility?.status === "NOT_FEASIBLE"
    || (feasibility?.earliestFeasibleDeliveryDate && new Date(feasibility.earliestFeasibleDeliveryDate) > new Date(requestedDelivery));
  const status = feasibility?.status === "MASTER_DATA_INCOMPLETE"
    ? "MASTER_DATA_INCOMPLETE"
    : late ? "LATE"
      : startPreviousMonth ? "START_PREVIOUS_MONTH"
        : materialShortages.length || feasibility?.materialStatus === "EXPEDITE_REQUIRED" ? "AT_RISK"
          : "SAFE";
  return {
    key: `${phase.sourceType}|${phase.id}|${phase.matchedForecastTargetId || "-"}|${dateOnly(phase.targetDate)}|${roundQty(phase.qty)}`,
    sourceTargetId: phase.id,
    sourceType: phase.sourceType,
    sourceNumber: phase.sourceNumber,
    sourceLineId: phase.sourceLineId || null,
    phaseNumber: phase.phaseNumber,
    customerCode: phase.customerCode || null,
    partCode: phase.partCode,
    qty: roundQty(phase.qty),
    uomCode: phase.uomCode || null,
    targetDeliveryDate: iso(phase.targetDate),
    originalTargetDate: iso(phase.originalTargetDate || phase.targetDate),
    matchedForecastTargetId: phase.matchedForecastTargetId || null,
    forecastTargetDate: iso(phase.forecastTargetDate),
    status,
    startPreviousMonth,
    requestedDeliveryDate: iso(requestedDelivery),
    fgRequiredDate: iso(feasibility?.fgRequiredDate),
    productionLatestStartDate: iso(productionStart),
    materialRequiredDate: iso(feasibility?.materialRequiredDate),
    supplierRequiredArrivalDate: iso(feasibility?.supplierRequiredArrivalDate),
    latestPoDate: iso(feasibility?.latestPoDate),
    latestPrDate: iso(feasibility?.latestPrDate),
    vendorSendDate: iso(feasibility?.vendorSendDate),
    vendorReturnDate: iso(feasibility?.vendorReturnDate),
    earliestFeasibleFgDate: iso(feasibility?.earliestFeasibleFgDate),
    earliestFeasibleDeliveryDate: iso(feasibility?.earliestFeasibleDeliveryDate),
    productionLeadTimeDays: roundQty(calculation.scheduledProductionLeadTimeDays),
    exactProductionLeadTimeHours: roundQty(feasibility?.exactProductionLeadTimeHours),
    procurementLeadTimeDays: roundQty(calculation.procurementLeadTimeDaysApplied),
    dispatchDays: roundQty(calculation.dispatchDays),
    materialStagingDays: roundQty(calculation.materialStagingDays),
    capacityShiftsPerDay: number(calculation.capacityShiftsPerDay),
    capacityHoursPerShift: number(calculation.capacityHoursPerShift),
    capacitySimulated: Boolean(calculation.capacityAssumption?.finiteCapacitySimulated),
    bomNumber: feasibility?.constraintDetails?.bomNumber || null,
    criticalConstraint: feasibility?.criticalConstraint || null,
    materialStatus: feasibility?.materialStatus || null,
    materialShortages: materialShortages.map((row) => ({
      partCode: row.partCode,
      partName: row.partName || null,
      shortageQty: roundQty(row.shortageQty),
      requiredDate: iso(row.requiredDate),
      supplierCode: row.supplierCode || null,
    })),
    processTimeline: (feasibility?.constraintDetails?.processTimeline || []).map(compactProcessStep),
    leadTimeTrace: feasibility?.constraintDetails?.leadTimeTrace || [],
    planningDecision: planningDecision ? {
      id: planningDecision.id,
      status: planningDecision.status,
      planningDecisionTargetId: planningDecision.planningDecisionTargetId || planningDecision.deliveryTargetId,
      leadTimeControls: leadTimeControls(planningDecision),
      capacityAssumption: capacityPolicy(planningDecision),
    } : null,
    calculationError: feasibility?.calculationError || null,
  };
}

function effectiveDeliveryPhases({ forecasts, sales, parts, period }) {
  const partByCode = new Map(parts.map((part) => [part.partCode, part]));
  const groups = new Map();
  const groupFor = (row) => {
    const key = `${row.customerCode || "-"}|${row.partCode}`;
    if (!groups.has(key)) groups.set(key, { forecasts: [], sales: [], part: partByCode.get(row.partCode) });
    return groups.get(key);
  };
  for (const row of forecasts) groupFor(row).forecasts.push({ ...row, originalTargetDate: row.targetDate });
  for (const row of sales) groupFor(row).sales.push({ ...row, originalTargetDate: row.targetDate });
  return [...groups.values()].flatMap((group) => consumeDeliveryTargets({
    forecastTargets: group.forecasts,
    salesOrderTargets: group.sales,
    part: group.part,
    policy: group.part?.planningPolicy,
  })).filter((row) => monthKey(row.targetDate) === period.key && number(row.qty) > 0.000001);
}

function effectiveHeaderId(part, targetDate) {
  const at = new Date(targetDate);
  return [...(part?.mbomHeaders || [])]
    .filter((header) => (!header.effectiveDate || new Date(header.effectiveDate) <= at)
      && (!header.expiryDate || new Date(header.expiryDate) >= at))
    .sort((left, right) => number(right.revision) - number(left.revision))[0]?.id || null;
}

async function buildPhaseLeadTimes(prisma, { forecasts, sales, parts, period }) {
  const phases = effectiveDeliveryPhases({ forecasts, sales, parts, period });
  const decisions = await loadDemandPlanningConstraintMap(prisma, phases.map((phase) => phase.id));
  const partByCode = new Map(parts.map((part) => [part.partCode, part]));
  const contextCache = new Map();
  const routingMetricCache = new Map();
  const materialSupplyCache = new Map();
  return mapLimit(phases, 4, async (phase) => {
    const decision = decisions.get(String(phase.id)) || null;
    const decisionDetails = decision?.constraintDetails && typeof decision.constraintDetails === "object" ? decision.constraintDetails : {};
    const supplierStrategy = decisionDetails.supplierStrategy || "PREFERRED";
    const supplierSelections = decisionDetails.supplierSelections || {};
    const headerId = effectiveHeaderId(partByCode.get(phase.partCode), phase.targetDate);
    const contextCacheKey = `${headerId || phase.partCode}|${roundQty(phase.qty)}|${supplierStrategy}|${JSON.stringify(supplierSelections)}`;
    try {
      const feasibility = await assessDemandFeasibility(prisma, {
        sourceType: phase.sourceType,
        sourceNumber: phase.sourceNumber,
        deliveryTargetId: phase.id,
        customerCode: phase.customerCode,
        partCode: phase.partCode,
        quantity: number(phase.qty),
        requestedDeliveryDate: phase.targetDate,
        leadTimeControls: decision ? leadTimeControls(decision) : undefined,
        capacityShiftsPerDay: decision ? capacityPolicy(decision).shiftsPerDay : undefined,
        capacityHoursPerShift: decision ? capacityPolicy(decision).hoursPerShift : undefined,
        supplierStrategy,
        supplierSelections,
        vendorProcessAdjustments: decisionDetails.vendorProcessAdjustments,
        contextCache,
        contextCacheKey,
        routingMetricCache,
        materialSupplyCache,
      });
      return compactLeadTimePhase(phase, feasibility, decision);
    } catch (error) {
      return compactLeadTimePhase(phase, {
        status: "MASTER_DATA_INCOMPLETE",
        requestedDeliveryDate: phase.targetDate,
        calculationError: error.message,
        constraintDetails: {},
      }, decision);
    }
  });
}

function leadTimeSummary(phases = []) {
  const statusRank = { LATE: 5, MASTER_DATA_INCOMPLETE: 4, AT_RISK: 3, START_PREVIOUS_MONTH: 2, SAFE: 1 };
  const worst = [...phases].sort((left, right) => number(statusRank[right.status]) - number(statusRank[left.status]))[0];
  const dates = (field) => phases.map((phase) => phase[field]).filter(Boolean).sort((left, right) => new Date(left) - new Date(right));
  const previous = phases.filter((phase) => phase.startPreviousMonth);
  return {
    status: worst?.status || "MASTER_DATA_INCOMPLETE",
    phaseCount: phases.length,
    safeCount: phases.filter((phase) => phase.status === "SAFE").length,
    atRiskCount: phases.filter((phase) => phase.status === "AT_RISK").length,
    lateCount: phases.filter((phase) => phase.status === "LATE").length,
    incompleteCount: phases.filter((phase) => phase.status === "MASTER_DATA_INCOMPLETE").length,
    previousMonthPhaseCount: previous.length,
    previousMonthQty: roundQty(previous.reduce((sum, phase) => sum + number(phase.qty), 0)),
    earliestProductionStartDate: dates("productionLatestStartDate")[0] || null,
    earliestMaterialRequiredDate: dates("materialRequiredDate")[0] || null,
    earliestDeliveryDate: dates("targetDeliveryDate")[0] || null,
    bomNumbers: unique(phases.map((phase) => phase.bomNumber)),
  };
}

module.exports = { buildPhaseLeadTimes, leadTimeSummary, effectiveDeliveryPhases, compactLeadTimePhase };
