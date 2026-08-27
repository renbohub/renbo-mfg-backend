"use strict";

function validateVendorBatch({ qty, minimumOrderQty = 0, orderMultipleQty = 0, force = false, reason, approvalStatus }) {
  const quantity = Number(qty || 0);
  const moq = Number(minimumOrderQty || 0);
  const multiple = Number(orderMultipleQty || 0);
  if (quantity <= 0) throw new Error("Qty vendor batch wajib lebih dari 0.");
  const belowMoq = moq > 0 && quantity < moq;
  const invalidMultiple = multiple > 0 && Math.abs(quantity / multiple - Math.round(quantity / multiple)) > 0.000001;
  if ((belowMoq || invalidMultiple) && !force) {
    if (belowMoq) throw new Error(`Qty vendor batch di bawah MOQ ${moq}.`);
    throw new Error(`Qty vendor batch wajib kelipatan ${multiple}.`);
  }
  if (force && (belowMoq || invalidMultiple)) {
    if (!String(reason || "").trim()) throw new Error("Force Below MOQ wajib alasan.");
    if (approvalStatus !== "APPROVED") throw new Error("Force Below MOQ wajib approval.");
  }
  return { valid: true, belowMoq, invalidMultiple };
}

function splitVendorQuantity(totalQty, batches) {
  const total = Number(totalQty || 0);
  const values = (batches || []).map(Number);
  if (values.some((qty) => !Number.isFinite(qty) || qty <= 0)) throw new Error("Seluruh qty batch harus lebih dari 0.");
  const sum = values.reduce((value, qty) => value + qty, 0);
  if (Math.abs(sum - total) > 0.000001) throw new Error("Total split vendor batch harus sama dengan qty allocation.");
  return values;
}

module.exports = { validateVendorBatch, splitVendorQuantity };
