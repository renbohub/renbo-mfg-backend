"use strict";

function procurementWeek(value) {
  if (!value || !Number.isFinite(new Date(value).getTime())) throw Object.assign(new Error("Tanggal kebutuhan pembelian wajib valid sebelum pengelompokan mingguan."), { status: 409 });
  const day = new Date(value);
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
  return { key: start.toISOString().slice(0, 10), startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

function groupWeeklyPurchases(orders = []) {
  const groups = new Map(); const seen = new Set();
  for (const order of orders) {
    if (String(order.orderType).toUpperCase() !== "PURCHASE" || order.isDeleted || ["CANCELLED", "CANCELED", "SUPERSEDED"].includes(String(order.status).toUpperCase())) continue;
    const identity = order.orderNumber || order.id;
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    const qty = Number(order.qty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const week = procurementWeek(order.requiredDate);
    // Never combine units or already-selected suppliers/vendors.
    const key = [week.key, order.partCode, order.uomCode, order.supplierCode || "", order.vendorCode || ""].join("|");
    if (!groups.has(key)) groups.set(key, { key, week, partCode: order.partCode, uomCode: order.uomCode, supplierCode: order.supplierCode || null, vendorCode: order.vendorCode || null, qty: 0, earliestRequiredDate: order.requiredDate, earliestOrderDate: order.orderDate || null, orders: [] });
    const group = groups.get(key);
    group.qty = Math.round((group.qty + qty) * 1e6) / 1e6;
    if (new Date(order.requiredDate) < new Date(group.earliestRequiredDate)) group.earliestRequiredDate = order.requiredDate;
    if (order.orderDate && (!group.earliestOrderDate || new Date(order.orderDate) < new Date(group.earliestOrderDate))) group.earliestOrderDate = order.orderDate;
    group.orders.push({ orderNumber: identity, qty, requiredDate: order.requiredDate, orderDate: order.orderDate, status: order.status, referenceNumber: order.referenceNumber || null });
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}
module.exports = { procurementWeek, groupWeeklyPurchases };
