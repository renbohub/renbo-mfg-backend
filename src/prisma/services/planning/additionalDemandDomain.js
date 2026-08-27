const QUANTITY_TOLERANCE = 0.000001;

function quantity(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= QUANTITY_TOLERANCE) return 0;
  return parsed;
}

function normalizedResult(value) {
  return value <= QUANTITY_TOLERANCE ? 0 : value;
}

function additionalDemandQty({ currentSoQty, lockedEfdQty }) {
  return normalizedResult(Math.max(quantity(currentSoQty) - quantity(lockedEfdQty), 0));
}

function pendingDeltaQty({ additionalQty, fgStockQty, firmReceiptQty, generatedDeltaQty }) {
  return normalizedResult(Math.max(
    quantity(additionalQty)
      - quantity(fgStockQty)
      - quantity(firmReceiptQty)
      - quantity(generatedDeltaQty),
    0,
  ));
}

function cuttableProductionQty({ plannedQty, producedQty, wipQty }) {
  return normalizedResult(Math.max(
    quantity(plannedQty) - quantity(producedQty) - quantity(wipQty),
    0,
  ));
}

function chooseCoverageSequence({ additionalQty, freeFgQty, firmReceiptQty }) {
  let remaining = quantity(additionalQty);
  const result = [];
  const allocate = (type, availableQty) => {
    if (remaining <= QUANTITY_TOLERANCE) return;
    const allocatedQty = Math.min(remaining, quantity(availableQty));
    if (allocatedQty <= QUANTITY_TOLERANCE) return;
    result.push({ type, qty: normalizedResult(allocatedQty) });
    remaining = normalizedResult(remaining - allocatedQty);
  };

  allocate("FG_STOCK", freeFgQty);
  allocate("FIRM_FG_RECEIPT", firmReceiptQty);
  allocate("DELTA_MPS", remaining);
  return result;
}

module.exports = {
  QUANTITY_TOLERANCE,
  additionalDemandQty,
  pendingDeltaQty,
  cuttableProductionQty,
  chooseCoverageSequence,
};
