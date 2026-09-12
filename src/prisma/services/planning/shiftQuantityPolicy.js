"use strict";

const SHIFT_QUANTITY_MULTIPLE = 1000;

// Search actual calendar/tooling capacity; rounding must never add production
// or pretend that a larger quantity fits a previously selected time interval.
function findRoundedShiftPlacement(remainingQty, findPlacement) {
  const remaining = Math.floor(Number(remainingQty));
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  function largestFit(step, maximum) {
    let low = 1, high = Math.floor(maximum / step), best = null;
    while (low <= high) {
      const count = Math.floor((low + high) / 2);
      const qty = count * step;
      const placement = findPlacement(qty);
      if (placement) { best = { qty, placement }; low = count + 1; }
      else high = count - 1;
    }
    return best;
  }
  const regular = largestFit(SHIFT_QUANTITY_MULTIPLE, remaining);
  if (regular) return { ...regular, quantityReason: "MULTIPLE_1000" };
  const small = largestFit(1, Math.min(remaining, SHIFT_QUANTITY_MULTIPLE - 1));
  return small ? { ...small, quantityReason: remaining < SHIFT_QUANTITY_MULTIPLE ? "SMALL_REMAINDER" : "CAPACITY_BELOW_1000" } : null;
}

module.exports = { SHIFT_QUANTITY_MULTIPLE, findRoundedShiftPlacement };
