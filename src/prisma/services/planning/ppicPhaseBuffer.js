"use strict";
const { roundProductionAfterBuffer } = require("./mpsQuantityPolicy");
const n = value => Math.max(Number(value) || 0, 0);
const round = value => Math.round(value * 1e6) / 1e6;
function splitMonthlyQuantity(total, deliveryCount, uomCode = "PCS", { roundInitial = true } = {}) {
  const count = Number(deliveryCount);
  if (!Number.isInteger(count) || count < 1 || count > 10000 || !Number.isFinite(Number(total)) || Number(total) < 0) throw new Error("Jumlah dan banyak delivery tidak valid.");
  const policy = roundProductionAfterBuffer(total, uomCode);
  const monthlyQty = roundInitial ? policy.roundedQty : n(total);
  const step = policy.multiple && monthlyQty / count >= 1000 ? 1000 : policy.multiple ? 1 : 0.000001;
  const baseQty = round(Math.floor((monthlyQty / count + 1e-9) / step) * step);
  const remainderQty = round(monthlyQty - baseQty * count);
  return { monthlyQty, deliveryCount: count, baseQty, remainderQty, quantities: [...Array(count).fill(baseQty), ...(remainderQty > 0 ? [remainderQty] : [])], roundingQty: round(monthlyQty - n(total)) };
}
function readSplitMetadata(notes) {
  const token = String(notes || "").match(/\[PPIC-SPLIT:([^\]]+)\]/)?.[1];
  if (!token) return null;
  try {
    const data = JSON.parse(decodeURIComponent(token));
    if (!data || typeof data.splitKey !== "string" || !data.splitKey || data.splitKey.length > 300 || typeof data.isRemainder !== "boolean") return null;
    const fields = ["splitIndex", "deliveryCount", "initialMonthlyQty", "baseDivisionQty", "initialQty", "requiredProductionQty", "stockCoveredQty"];
    if (fields.some(key => !Number.isFinite(data[key]) || data[key] < 0)) return null;
    return { splitKey: data.splitKey, isRemainder: data.isRemainder, uom: String(data.uom || "PCS"), ...Object.fromEntries(fields.map(key => [key, data[key]])) };
  } catch { return null; }
}
// Round the month once. N deliveries define N equal divisions, plus exact remainder.
function distributeBuffer(rows, bufferQty, uomCode = "PCS") {
  if (!rows.length) return null;
  const byTarget = new Map();
  for (const [index, row] of rows.entries()) {
    const key = row._deliveryTargetId || row._deliveryPhaseId || `row-${index}`;
    let group = byTarget.get(key);
    if (!group) { group = { ...row, qtyPlanned: 0, _deliveryDemandQty: 0 }; byTarget.set(key, group); }
    group.qtyPlanned += n(row.qtyPlanned);
    group._deliveryDemandQty += n(row._deliveryDemandQty ?? row.qtyPlanned);
  }
  const deliveries = [...byTarget.values()];
  const customerTotal = deliveries.reduce((sum, row) => sum + n(row.qtyPlanned), 0);
  if (customerTotal + n(bufferQty) <= 0) return null;
  const split = splitMonthlyQuantity(customerTotal + n(bufferQty), deliveries.length, uomCode);
  const root = rows[0];
  const splitKey = `${root._sourceMpsNumber || root.mpsNumber || "MPS"}:${root.id || root.partCode || "FG"}`;
  const classifiedRounding = Math.min(n(bufferQty), n(root.calculationTrace?.lotRoundingDeltaQty)) + split.roundingQty;
  const classifiedBuffer = n(bufferQty) - Math.min(n(bufferQty), n(root.calculationTrace?.lotRoundingDeltaQty));
  let assignedBuffer = 0, assignedRounding = 0;
  return split.quantities.map((qty, index) => {
    const tail = index === deliveries.length;
    const source = deliveries[Math.min(index, deliveries.length - 1)];
    const last = index === split.quantities.length - 1;
    const buffer = last ? round(classifiedBuffer - assignedBuffer) : round(classifiedBuffer * qty / split.monthlyQty);
    const roundingQty = last ? round(classifiedRounding - assignedRounding) : round(classifiedRounding * qty / split.monthlyQty);
    assignedBuffer += buffer; assignedRounding += roundingQty;
    const metadata = { splitKey, isRemainder: tail, splitIndex: index + 1, deliveryCount: deliveries.length,
      initialMonthlyQty: split.monthlyQty, baseDivisionQty: split.baseQty, initialQty: qty, uom: uomCode,
      requiredProductionQty: tail ? 0 : n(source.qtyPlanned), stockCoveredQty: tail ? 0 : Math.max(n(source._deliveryDemandQty) - n(source.qtyPlanned), 0) };
    return { ...source, qtyPlanned: qty, effectiveDemandQty: qty, forecastQty: source._deliveryPhaseSourceType === "SALES_ORDER" ? 0 : qty,
      actualSalesOrderQty: source._deliveryPhaseSourceType === "SALES_ORDER" ? qty : 0,
      bufferQty: buffer, _bufferAllocatedQty: buffer, _customerProductionQty: round(qty - buffer - roundingQty),
      _productionRoundingQty: roundingQty, _productionBeforeRoundingQty: round(qty - roundingQty), _ppicSplit: metadata,
      ...(tail ? { lineNumber: n(root.lineNumber) + 999, _deliveryPhaseId: null, _deliveryPhaseNumber: null,
        _deliveryTargetId: null, _deliveryPhaseSourceType: "BUFFER", _isBufferPhase: true, _customerCode: null,
        customerCode: null, _deliveryDemandQty: 0, forecastQty: 0, actualSalesOrderQty: 0 } : {}),
    };
  });
}
module.exports = { distributeBuffer, splitMonthlyQuantity, readSplitMetadata };
