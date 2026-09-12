"use strict";
const day = value => value ? new Date(value).toISOString().slice(0, 10) : null;
const quantity = value => Math.max(Number(value) || 0, 0);

// Shipment records refer to an SO line, not a demand phase. Allocate that line's
// recorded delivered quantity once, in due-date order; expose this basis in UI.
function attachDeliveryProgress(rows, schedules = []) {
  const pools = new Map();
  for (const row of rows) for (const sale of row.actualSalesOrders || []) {
    const key = sale.sourceLineId;
    if (!key) continue;
    if (!pools.has(key)) pools.set(key, { remaining: 0, schedules: [] });
    const pool = pools.get(key);
    // buildDemandRows allocates delivered quantities across its matched demand.
    pool.remaining += quantity(sale.deliveredQty);
  }
  for (const schedule of schedules) for (const detail of schedule.details || []) {
    if (!pools.has(detail.soDetailId)) continue;
    pools.get(detail.soDetailId).schedules.push({ scheduleNumber: schedule.scheduleNumber, plannedDate: schedule.plannedDate, shippedAt: schedule.shippedAt, receivedAt: schedule.deliveredAt || schedule.actualDate, status: schedule.status, plannedQty: quantity(detail.qty), deliveredQty: quantity(detail.qtyDelivered) });
  }
  const result = rows.map(row => ({ id: row.id, customerCode: row.customerCode, partCode: row.partCode, uomCode: row.uomCode, sourceType: row.sourceType, sourceNumber: row.sourceNumber, targetDate: row.targetDate, demandQty: row.demandQty, fgRequiredDate: row.fgRequiredDate, feasibilityStatus: row.feasibilityStatus, criticalConstraint: row.criticalConstraint,
    effectiveDeliverySplits: (row.effectiveDeliverySplits || []).map(split => {
      const sale = (row.actualSalesOrders || []).find(sale => sale.deliveryTargetId === split.deliveryTargetId && sale.sourceNumber === split.sourceNumber);
      const finish = (row.fgFinishSplits || []).find(finish => day(finish.targetDeliveryDate) === day(split.targetDate));
      return { ...split, sourceLineId: sale?.sourceLineId || null, fgRequiredDate: finish?.targetFinishDate || row.fgRequiredDate, deliveredQty: 0, remainingQty: quantity(split.qty), schedules: [] };
    }) }));
  const splits = result.flatMap(row => row.effectiveDeliverySplits).sort((a, b) => String(day(a.targetDate)).localeCompare(String(day(b.targetDate))) || String(a.deliveryTargetId).localeCompare(String(b.deliveryTargetId)));
  for (const split of splits) {
    const pool = pools.get(split.sourceLineId);
    if (!pool || split.sourceType !== "SALES_ORDER") continue;
    split.deliveredQty = Math.min(quantity(split.qty), pool.remaining);
    split.remainingQty = Math.max(quantity(split.qty) - split.deliveredQty, 0);
    pool.remaining -= split.deliveredQty;
    split.schedules = pool.schedules;
    split.progressBasis = "SO_LINE_DUE_DATE_ALLOCATION";
  }
  return result;
}
async function deliveryCalendar(tx) {
  const rows = await require("./demandPlanningService").buildDemandRows(tx);
  const lineIds = [...new Set(rows.flatMap(row => (row.actualSalesOrders || []).map(sale => sale.sourceLineId)).filter(Boolean))];
  const schedules = lineIds.length ? await tx.deliverySchedule.findMany({
    where: { isDeleted: false, status: { notIn: ["Cancelled", "Canceled"] }, details: { some: { isDeleted: false, soDetailId: { in: lineIds } } } },
    select: { scheduleNumber: true, plannedDate: true, shippedAt: true, deliveredAt: true, actualDate: true, status: true, details: { where: { isDeleted: false, soDetailId: { in: lineIds } }, select: { soDetailId: true, qty: true, qtyDelivered: true } } },
    orderBy: [{ plannedDate: "asc" }, { scheduleNumber: "asc" }],
  }) : [];
  return { items: attachDeliveryProgress(rows, schedules) };
}
module.exports = { deliveryCalendar, attachDeliveryProgress };
