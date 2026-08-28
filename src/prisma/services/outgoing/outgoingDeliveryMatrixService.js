const { buildFgCompStockTraceability } = require("../inventory/fgCompStockTraceabilityService");

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value, digits = 3) => Number(number(value).toFixed(digits));
const text = (value) => String(value || "").trim();
const dateValue = (value) => {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
};
const monthKey = (value) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit",
}).format(value);
const firstOfMonth = (value) => new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
const addMonths = (value, offset) => new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + offset, 1));
const normalizeUom = (value) => {
  const code = String(value || "PCS").trim().toUpperCase();
  return ["PC", "PIECE", "PIECES"].includes(code) ? "PCS" : code;
};

function historyPeriods(options = {}) {
  const requestedMonths = Math.min(Math.max(Number(options.historyMonths) || 6, 1), 12);
  const requestedEnd = dateValue(options.endDate);
  const endMonth = firstOfMonth(requestedEnd || new Date());
  const requestedStart = dateValue(options.startDate);
  const startMonth = requestedStart ? firstOfMonth(requestedStart) : addMonths(endMonth, -(requestedMonths - 1));
  const periods = [];
  for (let cursor = startMonth; cursor <= endMonth && periods.length < 12; cursor = addMonths(cursor, 1)) {
    periods.push({ key: monthKey(cursor), startDate: cursor.toISOString() });
  }
  return periods;
}

function stockByUom(stock, field) {
  return (stock?.byUom || []).map((row) => ({
    uomCode: normalizeUom(row.uomCode),
    qty: round(row[field]),
  })).filter((row) => row.qty !== 0);
}

function dedupeCustomers(rows) {
  const customers = new Map();
  for (const row of rows) {
    const customerCode = text(row.customerCode);
    if (!customerCode || customers.has(customerCode)) continue;
    customers.set(customerCode, { customerCode, customerName: text(row.customerName) || customerCode });
  }
  return [...customers.values()].sort((left, right) => left.customerName.localeCompare(right.customerName, "id", { numeric: true }));
}

function dedupeFinishedGoods(details) {
  const finishedGoods = new Map();
  for (const detail of details) {
    const partCode = text(detail.partCode || detail.part?.partCode);
    if (!partCode || finishedGoods.has(partCode)) continue;
    finishedGoods.set(partCode, {
      partCode,
      partNumber: text(detail.partNumber || detail.part?.partNumber) || null,
      partName: text(detail.partName || detail.part?.partName) || null,
      itemType: "FG",
      partType: text(detail.partType || detail.part?.partType) || "STANDARD",
      mbomNoReg: detail.mbomHeaders?.[0]?.noReg || null,
      uomCode: normalizeUom(detail.uomCode || detail.salesUomCode || detail.stockUomCode || detail.part?.salesUomCode || detail.part?.stockUomCode || "PCS"),
    });
  }
  return [...finishedGoods.values()].sort((left, right) => String(left.partNumber || left.partCode).localeCompare(String(right.partNumber || right.partCode), "id", { numeric: true }));
}

function deliveryDate(schedule) {
  return dateValue(schedule.deliveredAt || schedule.actualDate || schedule.plannedDate);
}

function scheduledPartQty(schedule, partCode, field) {
  return round((schedule.details || []).reduce((total, detail) => {
    if (text(detail.soDetail?.partCode) !== partCode) return total;
    if (field === "outstanding") return total + Math.max(number(detail.qty) - number(detail.qtyDelivered), 0);
    return total + number(detail[field]);
  }, 0));
}

async function buildOutgoingDeliveryMatrix(prisma, options = {}) {
  const [fgMasterRows, soFinishedGoodsRows, customerMasterRows] = await Promise.all([
    prisma.part.findMany({
      where: {
        isDeleted: false,
        itemType: "FG",
        customerCode: { not: null },
        // Berlaku untuk FG STANDARD maupun COMP. Syarat report hanya:
        // part bertipe FG dan memiliki minimal satu mBOM yang belum dihapus.
        mbomHeaders: { some: { isDeleted: false } },
      },
      select: {
        partCode: true, partNumber: true, partName: true, itemType: true, partType: true,
        customerCode: true, stockUomCode: true, salesUomCode: true,
        mbomHeaders: {
          where: { isDeleted: false }, orderBy: [{ revision: "desc" }, { updatedAt: "desc" }], take: 1,
          select: { noReg: true },
        },
      },
      orderBy: [{ customerCode: "asc" }, { partNumber: "asc" }, { partCode: "asc" }],
    }),
    prisma.salesOrderDetail.findMany({
      where: {
        isDeleted: false,
        partCode: { not: null },
        soHeader: { isDeleted: false, status: { not: "Cancelled" }, customerCode: { not: null } },
        part: {
          is: {
            isDeleted: false,
            itemType: "FG",
            mbomHeaders: { some: { isDeleted: false } },
          },
        },
      },
      select: {
        partCode: true, partNumber: true, partName: true, uomCode: true,
        part: {
          select: {
            partCode: true, partNumber: true, partName: true, itemType: true, partType: true,
            stockUomCode: true, salesUomCode: true,
            mbomHeaders: {
              where: { isDeleted: false }, orderBy: [{ revision: "desc" }, { updatedAt: "desc" }], take: 1,
              select: { noReg: true },
            },
          },
        },
        soHeader: { select: { customerCode: true, customerName: true } },
      },
    }),
    prisma.customer.findMany({
      where: { isDeleted: false },
      select: { customerCode: true, customerName: true },
    }),
  ]);
  const customerNameByCode = new Map(customerMasterRows.map((row) => [row.customerCode, row.customerName]));
  const fgScopeRows = [
    ...fgMasterRows,
    ...soFinishedGoodsRows.map((row) => ({
      ...row.part,
      partCode: row.partCode || row.part?.partCode,
      partNumber: row.partNumber || row.part?.partNumber,
      partName: row.partName || row.part?.partName,
      uomCode: row.uomCode || row.part?.salesUomCode || row.part?.stockUomCode,
      customerCode: row.soHeader?.customerCode || null,
      customerName: row.soHeader?.customerName || null,
    })),
  ];
  const customers = dedupeCustomers(fgScopeRows.map((row) => ({
    customerCode: row.customerCode,
    customerName: customerNameByCode.get(row.customerCode) || row.customerName || row.customerCode,
  })));
  const customerCode = text(options.customerCode);
  const periods = historyPeriods(options);
  const empty = {
    items: [], total: 0, historyPeriods: periods,
    summary: { finishedGoods: 0, deliveredQty: 0, fgFreeQty: 0, nextPlannedQty: 0 },
    chart: { labels: periods.map((period) => period.key), series: [] },
    filterOptions: { customers, finishedGoods: [] },
  };
  if (!customerCode) return empty;

  // The Part master may intentionally leave customerCode empty for a shared
  // or newly introduced FG. A confirmed SO is authoritative for the client
  // relationship, so include its active-BOM FG in that client's matrix too.
  const finishedGoods = dedupeFinishedGoods(fgScopeRows.filter((row) => row.customerCode === customerCode));
  const requestedFgPartCode = text(options.fgPartCode);
  const visibleFinishedGoods = requestedFgPartCode
    ? finishedGoods.filter((row) => row.partCode === requestedFgPartCode)
    : finishedGoods;
  const allPartCodes = finishedGoods.map((row) => row.partCode);
  if (!allPartCodes.length || !visibleFinishedGoods.length) {
    return { ...empty, filterOptions: { customers, finishedGoods } };
  }

  const [schedules, traceability] = await Promise.all([
    prisma.deliverySchedule.findMany({
      where: {
        isDeleted: false,
        status: { notIn: ["Cancelled", "Failed"] },
        soHeader: { isDeleted: false, customerCode },
        details: { some: { isDeleted: false, soDetail: { partCode: { in: allPartCodes } } } },
      },
      select: {
        scheduleNumber: true, plannedDate: true, actualDate: true, deliveredAt: true, status: true,
        details: {
          where: { isDeleted: false, soDetail: { partCode: { in: allPartCodes } } },
          select: { qty: true, qtyDelivered: true, soDetail: { select: { partCode: true } } },
        },
      },
      orderBy: [{ plannedDate: "asc" }, { scheduleNumber: "asc" }],
    }),
    buildFgCompStockTraceability(prisma, { partCodes: allPartCodes }),
  ]);

  const traceByPartCode = new Map((traceability.items || []).map((row) => [row.fgPartCode, row]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const firstPeriod = periods[0]?.key || "";
  const lastPeriod = periods[periods.length - 1]?.key || "";
  const rows = visibleFinishedGoods.map((fg) => {
    const history = Object.fromEntries(periods.map((period) => [period.key, 0]));
    let lastDelivery = null;
    let nextDelivery = null;
    for (const schedule of schedules) {
      const deliveredQty = scheduledPartQty(schedule, fg.partCode, "qtyDelivered");
      const actual = deliveryDate(schedule);
      if (schedule.status === "Delivered" && deliveredQty > 0 && actual) {
        const key = monthKey(actual);
        if (key >= firstPeriod && key <= lastPeriod && Object.prototype.hasOwnProperty.call(history, key)) history[key] = round(history[key] + deliveredQty);
        if (!lastDelivery || actual > new Date(lastDelivery.date)) lastDelivery = { scheduleNumber: schedule.scheduleNumber, date: actual.toISOString(), qty: deliveredQty };
      }
      const outstandingQty = scheduledPartQty(schedule, fg.partCode, "outstanding");
      const planned = dateValue(schedule.plannedDate);
      if (schedule.status !== "Delivered" && outstandingQty > 0 && planned && planned >= today && (!nextDelivery || planned < new Date(nextDelivery.date))) {
        nextDelivery = { scheduleNumber: schedule.scheduleNumber, date: planned.toISOString(), qty: outstandingQty, status: schedule.status };
      }
    }
    const trace = traceByPartCode.get(fg.partCode) || {};
    return {
      ...fg,
      history,
      historyTotalQty: round(Object.values(history).reduce((total, value) => total + number(value), 0)),
      materialAvailable: stockByUom(trace.materialStock, "qtyAvailable"),
      wipOnHand: stockByUom(trace.wipStock, "qtyOnHand"),
      fgOnHand: stockByUom(trace.fgStock, "qtyOnHand"),
      fgReserved: stockByUom(trace.fgStock, "qtyReserved"),
      fgFree: stockByUom(trace.fgStock, "qtyAvailable"),
      stockStatus: trace.traceStatus || "NO STOCK DATA",
      lastDelivery,
      nextDelivery,
    };
  });
  const q = text(options.q || options.search).toLowerCase();
  const filteredRows = q ? rows.filter((row) => [row.partCode, row.partNumber, row.partName].some((value) => String(value || "").toLowerCase().includes(q))) : rows;
  const deliveredQty = round(filteredRows.reduce((total, row) => total + row.historyTotalQty, 0));
  const fgFreeQty = round(filteredRows.reduce((total, row) => total + row.fgFree.filter((stock) => stock.uomCode === "PCS").reduce((sum, stock) => sum + stock.qty, 0), 0));
  const nextPlannedQty = round(filteredRows.reduce((total, row) => total + number(row.nextDelivery?.qty), 0));
  return {
    items: filteredRows,
    total: filteredRows.length,
    historyPeriods: periods,
    summary: { finishedGoods: filteredRows.length, deliveredQty, fgFreeQty, nextPlannedQty },
    chart: { labels: periods.map((period) => period.key), series: periods.map((period) => round(filteredRows.reduce((total, row) => total + number(row.history[period.key]), 0))) },
    filterOptions: { customers, finishedGoods },
  };
}

module.exports = { buildOutgoingDeliveryMatrix, historyPeriods, dedupeCustomers, dedupeFinishedGoods };
