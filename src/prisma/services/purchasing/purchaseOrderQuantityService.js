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

module.exports = { resolveCommercialOrderQty, summarizePurchaseOrderAllocation };
