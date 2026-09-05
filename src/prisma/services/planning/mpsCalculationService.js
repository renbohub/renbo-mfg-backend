"use strict";

const EPSILON = 0.000001;
const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const numberOrNull = (value) => finite(value) ? Number(value) : null;
const round = (value, digits = 6) => {
  if (!finite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

/**
 * Exposes (but does not replace) the authoritative MPS netting result. Some
 * inventory deductions are not stored independently by the legacy ledger, so
 * those values remain null instead of being inferred or fabricated.
 */
function buildMpsCalculationBreakdown(input = {}) {
  const trace = input.calculationTrace || {};
  const metrics = input.metrics || {};
  const planMetrics = input.planMetrics || {};
  const inventory = input.inventory || {};
  const previousShortageQty = round(Math.max(
    Number(input.previousEfdQty || 0) - Number(input.previousDeliveredQty || 0),
    0,
  ));
  const authoritativeFinal = round(planMetrics.totalPlanQty ?? metrics.plannedProductionQty ?? input.mpsQty ?? 0);
  const rawNetRequirement = round(metrics.plannedProductionQty ?? input.mpsQty ?? 0);

  return {
    formulaVersion: trace.formulaVersion || "MPS_EXISTING_NETTING_V1",
    formula: trace.formula || "authoritative MPS ledger: demand + buffer - usable stock - firm receipts, followed by existing lot/netting rules",
    previousEfdQty: round(input.previousEfdQty ?? 0),
    previousDeliveredQty: round(input.previousDeliveredQty ?? 0),
    previousShortageQty,
    currentEfdQty: round(input.currentEfdQty ?? 0),
    lookAheadEfdQty: round(input.lookAheadEfdQty ?? 0),
    bufferBaseQty: round(input.bufferBaseQty ?? 0),
    bufferPercent: round(input.bufferPercent ?? 0),
    bufferQty: round(input.bufferQty ?? 0),
    grossRequirementQty: round(metrics.grossDemandQty ?? input.demandQty ?? 0),
    onHandQty: numberOrNull(inventory.onHandQty),
    reservedQty: numberOrNull(inventory.reservedQty),
    allocatedQty: numberOrNull(inventory.allocatedQty),
    qcHoldQty: numberOrNull(inventory.qcHoldQty),
    blockedQty: numberOrNull(inventory.blockedQty),
    usableStockQty: numberOrNull(inventory.usableStockQty),
    firmReceiptQty: round(metrics.firmReceiptQty ?? input.firmReceiptQty ?? 0),
    rawNetRequirementQty: rawNetRequirement,
    lotRoundingDeltaQty: round(input.lotRoundingDeltaQty ?? 0),
    baselineMpsQty: round(planMetrics.baselineMpsQty ?? rawNetRequirement ?? 0),
    deltaMpsQty: round(planMetrics.deltaMpsQty ?? 0),
    approvedCutQty: round(planMetrics.approvedCutQty ?? 0),
    finalMpsQty: authoritativeFinal,
    reconciled: Math.abs(Number(authoritativeFinal || 0) - Number(input.mpsQty ?? authoritativeFinal ?? 0)) <= EPSILON,
    source: "MPSDetail.calculationTrace + authoritative workbench ledger",
  };
}

module.exports = { buildMpsCalculationBreakdown };
