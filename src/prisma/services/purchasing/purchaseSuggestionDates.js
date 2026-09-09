"use strict";

const { classifyProcurementWindow } = require("../planning/procurementSchedulingService");
const SOURCE = "MRP_DELIVERY_NEED_SUPPLIER_LEAD_TIME";
function dateOnly(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return new Date(`${parsed.toISOString().slice(0, 10)}T00:00:00.000Z`);
}
function deliveryNeed(requirements = [], fallback) {
  const dates = requirements.map(row => dateOnly(row.materialRequiredDate || row.requiredDate)).filter(Boolean);
  const result = dates.sort((a, b) => a - b)[0] || dateOnly(fallback);
  if (!result) throw Object.assign(new Error("Tanggal kebutuhan MRP belum tersedia. Periksa hasil MRP sumber Purchase Suggestion."), { status: 409, code: "MRP_DELIVERY_NEED_MISSING" });
  return result;
}
function schedule({ materialRequiredDate, supplierLeadTimeDays = 0, asOf }) {
  const need = deliveryNeed([], materialRequiredDate);
  const lead = Number(supplierLeadTimeDays);
  if (!Number.isFinite(lead) || lead < 0) throw Object.assign(new Error("Lead time supplier harus berupa angka nol atau lebih."), { status: 400 });
  const days = Math.ceil(lead);
  const purchaseMax = new Date(need);
  purchaseMax.setUTCDate(purchaseMax.getUTCDate() - days);
  return {
    source: SOURCE, calendar: "CALENDAR_DAYS", materialRequiredDate: need,
    supplierRequiredArrivalDate: need, latestPoDate: purchaseMax, latestPrDate: purchaseMax,
    totalLeadTimeDays: days,
    leadTimeBreakdown: { supplierLeadTimeDays: days, prApprovalDays: 0, poProcessingDays: 0, transitDays: 0, receivingQcDays: 0, safetyLeadTimeDays: 0 },
    procurementWindow: classifyProcurementWindow({ materialRequiredDate: need, latestPrDate: purchaseMax, asOf }),
  };
}
function sourceIds(item) {
  return [...new Set([item.mrpRequirementId, ...(item.sourceRequirements || []).filter(row => row.allocationType !== "MOQ_PULL_FORWARD").map(row => row.id)].filter(Boolean))];
}
function itemDeliveryNeed(item, requirementById, orderByNumber = new Map()) {
  const requirements = sourceIds(item).map(id => requirementById.get(id)).filter(Boolean);
  if (requirements.length) return deliveryNeed(requirements);
  const snapshots = (item.sourceRequirements || []).filter(row => row.allocationType !== "MOQ_PULL_FORWARD");
  return deliveryNeed(snapshots, orderByNumber.get(item.plannedOrderNumber)?.requiredDate
    || (item.scheduleSource === SOURCE ? item.materialRequiredDate : null));
}
async function loadItemDeliveryNeed(db, item) {
  const ids = sourceIds(item);
  const requirements = ids.length ? await db.mRPRequirement.findMany({ where: { id: { in: ids }, isDeleted: false }, select: { id: true, materialRequiredDate: true, requiredDate: true } }) : [];
  const orders = !requirements.length && item.plannedOrderNumber
    ? await db.plannedOrder.findMany({ where: { orderNumber: item.plannedOrderNumber, isDeleted: false }, select: { orderNumber: true, requiredDate: true } }) : [];
  return itemDeliveryNeed(item, new Map(requirements.map(row => [row.id, row])), new Map(orders.map(row => [row.orderNumber, row])));
}
module.exports = { SOURCE, deliveryNeed, schedule, itemDeliveryNeed, loadItemDeliveryNeed };
