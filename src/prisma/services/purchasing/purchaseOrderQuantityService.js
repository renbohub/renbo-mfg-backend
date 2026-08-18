const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const round = (value) => Math.round((number(value) + Number.EPSILON) * 1e6) / 1e6;

/**
 * Resolve the commercial quantity that must be copied to a PO line.
 *
 * `demandCoveredQty` is pegging only and deliberately excludes free MOQ
 * buffer. New records persist `commercialQty`. For legacy records created before
 * that field existed, a single allocation owns the entire outstanding PR line.
 */
function resolveCommercialOrderQty({ commercialQty, demandCoveredQty, outstandingQty, activeAllocationCount }) {
  const outstanding = Math.max(number(outstandingQty), 0);
  const persisted = Math.max(number(commercialQty), 0);
  if (persisted > 0) return round(Math.min(persisted, outstanding));
  if (Number(activeAllocationCount) === 1) return round(outstanding);
  return round(Math.min(Math.max(number(demandCoveredQty), 0), outstanding));
}

/**
 * Compatibility bridge for manual PRs created before sourcing allocations
 * became the canonical PO-conversion decision. It copies the already saved
 * supplier/material-form decision; callers still persist it as an allocation
 * in the same PO transaction for auditability.
 */
function buildManualPrSourcingDecision({ detail = {}, requestLine = {}, currencyCode = "IDR" }) {
  const text = (value) => String(value ?? "").trim() || null;
  const outstandingQty = Math.max(number(detail.qty) - number(detail.orderedQty), 0);
  return {
    id: null,
    supplierCode: text(requestLine.supplierCode || detail.confirmedSupplierCode || detail.proposedSupplierCode || detail.preferredSupplier),
    vendorCode: text(requestLine.vendorCode || detail.preferredVendor),
    demandCoveredQty: outstandingQty,
    commercialQty: requestLine.sourceQty ?? requestLine.commercialQty ?? outstandingQty,
    demandUomCode: detail.uomCode || null,
    purchasePackageQty: requestLine.purchasePackageQty ?? detail.purchasePackageQty ?? null,
    purchasePackageUomCode: requestLine.purchasePackageUomCode || detail.purchasePackageUomCode || null,
    conversionFactor: requestLine.conversionFactor ?? detail.conversionFactor ?? null,
    conversionUomCode: requestLine.conversionUomCode || detail.conversionUomCode || null,
    convertedPurchaseQty: requestLine.convertedPurchaseQty ?? detail.convertedPurchaseQty ?? null,
    materialWidth: requestLine.materialWidth ?? detail.width ?? null,
    materialLength: requestLine.materialLength ?? detail.materialLength ?? null,
    deliveryDate: requestLine.deliveryDate || detail.pr?.requiredDate || null,
    currencyCode: text(currencyCode) || "IDR",
    unitPrice: requestLine.unitPrice ?? detail.estimatedPrice ?? null,
    notes: "[MANUAL_PR_ADAPTER] Keputusan supplier dan bentuk diambil dari detail PR manual.",
  };
}

function summarizePurchaseOrderAllocation({ poQty, sources = [] }) {
  const orderedQty = Math.max(number(poQty), 0);
  const demandQty = round(sources.reduce((sum, source) => {
    const metadata = source?.metadata && typeof source.metadata === "object" ? source.metadata : {};
    const reserved = Math.max(number(metadata.reservedAllocationQty), 0);
    return sum + Math.max(number(metadata.demandCoveredQty ?? (number(source?.qty) - reserved)), 0);
  }, 0));
  const reserveQty = round(sources.reduce((sum, source) => {
    const metadata = source?.metadata && typeof source.metadata === "object" ? source.metadata : {};
    return sum + Math.max(number(metadata.reservedAllocationQty), 0);
  }, 0));
  return {
    orderedQty: round(orderedQty),
    demandQty,
    reserveQty,
    moqBufferQty: round(Math.max(orderedQty - demandQty - reserveQty, 0)),
  };
}

module.exports = { resolveCommercialOrderQty, buildManualPrSourcingDecision, summarizePurchaseOrderAllocation };
