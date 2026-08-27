"use strict";

const { planningMonthKey, utcMonthStart } = require("../../utils/planningMonth");

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value, digits = 6) => {
  const factor = 10 ** digits;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
};
const text = (value) => String(value ?? "").trim();

function shiftMonth(month, offset) {
  const [year, value] = String(month || "").split("-").map(Number);
  const shifted = new Date(Date.UTC(year, value - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function statusMeta(status, deliveredQty = 0, plannedQty = 0) {
  const normalized = text(status).toUpperCase().replaceAll("_", " ");
  if (plannedQty > 0 && deliveredQty >= plannedQty - 0.000001) return { code: "DELIVERED", label: "Delivered", tone: "success" };
  if (deliveredQty > 0) return { code: "PARTIAL", label: "Partial", tone: "warning" };
  if (normalized === "DELIVERED") return { code: "DELIVERED", label: "Delivered", tone: "success" };
  if (normalized === "IN TRANSIT") return { code: "IN_TRANSIT", label: "In Transit", tone: "info" };
  if (["ON PROCESS", "PICKED", "PACKED"].includes(normalized)) return { code: "ON_PROCESS", label: normalized === "ON PROCESS" ? "On Process" : normalized[0] + normalized.slice(1).toLowerCase(), tone: "info" };
  if (normalized === "SCHEDULED") return { code: "SCHEDULED", label: "Scheduled", tone: "neutral" };
  if (normalized === "FAILED") return { code: "FAILED", label: "Failed", tone: "danger" };
  return { code: "NOT_SCHEDULED", label: "Not Scheduled", tone: "muted" };
}

function selectCurrentStatus(schedules = []) {
  const rank = { Failed: 6, "In Transit": 5, "On Process": 4, Packed: 4, Picked: 4, Scheduled: 3, Delivered: 2 };
  return [...schedules].sort((left, right) => number(rank[right.status]) - number(rank[left.status]) || new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0))[0]?.status || null;
}

async function buildDeliveryPerformance(tx, options = {}) {
  const month = planningMonthKey(options.month || new Date());
  const previousMonth = shiftMonth(month, -1);
  const nextMonth = shiftMonth(month, 1);
  const partCodes = [...new Set((options.partCodes || []).map(text).filter(Boolean))];
  const byPart = new Map(partCodes.map((partCode) => [partCode, {
    partCode,
    previousMonth,
    deliveredPreviousQty: 0,
    scheduledPreviousQty: 0,
    previousOutstandingQty: 0,
    currentPlannedQty: 0,
    currentDeliveredQty: 0,
    scheduleCount: 0,
    schedules: [],
  }]));
  if (!partCodes.length) return { month, previousMonth, byPart };

  const previousStart = utcMonthStart(previousMonth);
  const currentStart = utcMonthStart(month);
  const nextStart = utcMonthStart(nextMonth);
  const [salesLines, schedules] = await Promise.all([
    tx.salesOrderDetail.findMany({
      where: {
        isDeleted: false,
        partCode: { in: partCodes },
        soHeader: { isDeleted: false },
        OR: [
          { deliveryDate: { gte: previousStart, lt: currentStart } },
          { deliveryDate: null, soHeader: { deliveryDate: { gte: previousStart, lt: currentStart } } },
        ],
      },
      select: { id: true, soNumber: true, partCode: true, qty: true, qtyDelivered: true, status: true, deliveryDate: true, soHeader: { select: { deliveryDate: true, status: true } } },
    }),
    tx.deliverySchedule.findMany({
      where: {
        isDeleted: false,
        status: { notIn: ["Cancelled", "Canceled"] },
        details: { some: { isDeleted: false, soDetail: { partCode: { in: partCodes }, isDeleted: false } } },
        OR: [
          { plannedDate: { gte: previousStart, lt: nextStart } },
          { actualDate: { gte: previousStart, lt: nextStart } },
          { deliveredAt: { gte: previousStart, lt: nextStart } },
        ],
      },
      select: {
        scheduleNumber: true, soNumber: true, plannedDate: true, actualDate: true, deliveredAt: true, status: true, updatedAt: true,
        details: { where: { isDeleted: false, soDetail: { partCode: { in: partCodes }, isDeleted: false } }, select: { soDetailId: true, qty: true, qtyDelivered: true, soDetail: { select: { partCode: true } } } },
      },
      orderBy: [{ plannedDate: "asc" }, { scheduleNumber: "asc" }],
    }),
  ]);

  for (const line of salesLines) {
    const row = byPart.get(line.partCode);
    if (!row) continue;
    row.scheduledPreviousQty += number(line.qty);
    row.deliveredPreviousQty += Math.min(number(line.qtyDelivered), number(line.qty));
  }

  for (const schedule of schedules) {
    const scheduleMonth = planningMonthKey(schedule.plannedDate);
    for (const detail of schedule.details) {
      const partCode = detail.soDetail?.partCode;
      const row = byPart.get(partCode);
      if (!row) continue;
      const publicSchedule = {
        scheduleNumber: schedule.scheduleNumber,
        soNumber: schedule.soNumber,
        plannedDate: schedule.plannedDate,
        actualDate: schedule.actualDate || schedule.deliveredAt,
        status: schedule.status,
        plannedQty: round(detail.qty),
        deliveredQty: round(detail.qtyDelivered),
        updatedAt: schedule.updatedAt,
      };
      row.schedules.push(publicSchedule);
      row.scheduleCount += 1;
      if (scheduleMonth === month) {
        row.currentPlannedQty += number(detail.qty);
        row.currentDeliveredQty += number(detail.qtyDelivered);
      }
    }
  }

  for (const row of byPart.values()) {
    row.deliveredPreviousQty = round(row.deliveredPreviousQty);
    row.scheduledPreviousQty = round(row.scheduledPreviousQty);
    row.previousOutstandingQty = round(Math.max(row.scheduledPreviousQty - row.deliveredPreviousQty, 0));
    row.currentPlannedQty = round(row.currentPlannedQty);
    row.currentDeliveredQty = round(row.currentDeliveredQty);
    const currentSchedules = row.schedules.filter((schedule) => planningMonthKey(schedule.plannedDate) === month);
    const relevantSchedules = currentSchedules.length ? currentSchedules : row.schedules;
    const selected = statusMeta(selectCurrentStatus(relevantSchedules), row.currentDeliveredQty, row.currentPlannedQty);
    row.status = selected.code;
    row.statusLabel = selected.label;
    row.statusTone = selected.tone;
    row.lastScheduleNumber = relevantSchedules.at(-1)?.scheduleNumber || null;
  }
  return { month, previousMonth, byPart };
}

function phaseDeliveryStatus(performance, phase = {}) {
  const schedules = performance?.schedules || [];
  const sourceNumber = text(phase.sourceNumber);
  const matching = sourceNumber ? schedules.filter((row) => text(row.soNumber) === sourceNumber) : [];
  if (!matching.length) {
    return phase.sourceType === "BUFFER"
      ? { code: "BUFFER", label: "Buffer", tone: "info" }
      : statusMeta(null, 0, 0);
  }
  const plannedQty = matching.reduce((sum, row) => sum + number(row.plannedQty), 0);
  const deliveredQty = matching.reduce((sum, row) => sum + number(row.deliveredQty), 0);
  return statusMeta(selectCurrentStatus(matching), deliveredQty, plannedQty);
}

module.exports = { buildDeliveryPerformance, phaseDeliveryStatus, statusMeta };
