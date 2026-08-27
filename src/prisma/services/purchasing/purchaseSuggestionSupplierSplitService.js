const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
};

const supplierKey = (value) => String(value || "").trim().toUpperCase();
const deliveryKey = (value) => {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value).trim() : parsed.toISOString().slice(0, 10);
};

function sameAllocation(left, right) {
  return supplierKey(left?.supplierCode) === supplierKey(right?.supplierCode)
    && Math.abs(number(left?.confirmedQty) - number(right?.confirmedQty)) <= 0.000001
    && deliveryKey(left?.deliveryDate) === deliveryKey(right?.deliveryDate);
}

function mergePrimaryAndSplitSupplierAllocations({ primaryAllocation, splitAllocations = [] } = {}) {
  const splits = (Array.isArray(splitAllocations) ? splitAllocations : [])
    .filter((allocation) => supplierKey(allocation?.supplierCode) && number(allocation?.confirmedQty) > 0);
  const primaryCode = supplierKey(primaryAllocation?.supplierCode);
  const primaryQty = number(primaryAllocation?.confirmedQty);
  if (!primaryCode || primaryQty <= 0) return splits;

  // Legacy data may contain an exact copy of the primary allocation as a child.
  // Only an exact supplier + qty + delivery copy is deduplicated. The same
  // supplier on another delivery date is a valid delivery split and must stay.
  if (splits.some((allocation) => sameAllocation(allocation, primaryAllocation))) {
    return splits;
  }
  return [{ ...primaryAllocation, supplierCode: String(primaryAllocation.supplierCode).trim(), confirmedQty: primaryQty }, ...splits];
}

function sumSupplierAllocationQty(allocations = []) {
  return (Array.isArray(allocations) ? allocations : [])
    .reduce((sum, allocation) => sum + number(allocation?.confirmedQty), 0);
}

module.exports = {
  mergePrimaryAndSplitSupplierAllocations,
  sumSupplierAllocationQty,
};
