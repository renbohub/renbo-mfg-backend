"use strict";

const { additionalDemandQty, pendingDeltaQty } = require("./additionalDemandDomain");

const number = (value) => (Number.isFinite(Number(value)) ? Math.max(Number(value), 0) : 0);
const rounded = (value) => Math.round((number(value) + Number.EPSILON) * 1000000) / 1000000;
const signedNumber = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const signedRounded = (value) => {
  const result = Math.round((signedNumber(value) + Number.EPSILON) * 1000000) / 1000000;
  return Math.abs(result) <= 0.000001 ? 0 : result;
};
const monthKey = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 7);
};
const unique = (values) => [...new Set(values.filter(Boolean))].sort();
const scopeKey = (month, customerCode, partCode) => `${month}|${customerCode}|${partCode}`;

function activeSalesOrderTarget(row) {
  return Boolean(
    row?.soDetail
      && !row.soDetail.isDeleted
      && row.soDetail.status !== "Cancelled"
      && row.soDetail.soHeader
      && !row.soDetail.soHeader.isDeleted
      && !["Draft", "Cancelled", "Superseded"].includes(row.soDetail.soHeader.status),
  );
}

function aggregateCoverageByPartMonth(items = []) {
  const grouped = new Map();
  for (const item of items) {
    const key = `${item.month}|${item.partCode}`;
    if (!grouped.has(key)) grouped.set(key, {
      month: item.month,
      partCode: item.partCode,
      uomCode: item.uomCode || null,
      locked: false,
      forecastQtyLocked: 0,
      poQtyLocked: 0,
      lockedEfdQty: 0,
      currentSoQty: 0,
      poDeltaQty: 0,
      additionalQty: 0,
      coveredFgStockQty: 0,
      coveredFirmReceiptQty: 0,
      generatedDeltaQty: 0,
      pendingDeltaQty: 0,
      uncoveredQty: 0,
      reductionQty: 0,
      customerCodes: [],
      baselineMpsNumbers: [],
      baselineMrpNumbers: [],
      sourceSalesOrders: [],
      locks: [],
    });
    const output = grouped.get(key);
    output.locked = true;
    for (const field of [
      "forecastQtyLocked", "poQtyLocked", "lockedEfdQty", "currentSoQty", "additionalQty",
      "coveredFgStockQty", "coveredFirmReceiptQty", "generatedDeltaQty", "pendingDeltaQty",
      "uncoveredQty", "reductionQty",
    ]) output[field] = rounded(output[field] + number(item[field]));
    output.poDeltaQty = signedRounded(output.poDeltaQty + signedNumber(item.poDeltaQty));
    output.customerCodes.push(item.customerCode);
    output.baselineMpsNumbers.push(item.baselineMpsNumber);
    output.baselineMrpNumbers.push(item.baselineMrpNumber);
    output.sourceSalesOrders.push(...(item.sourceSalesOrders || []));
    output.locks.push(item.lock);
  }
  for (const output of grouped.values()) {
    output.customerCodes = unique(output.customerCodes);
    output.baselineMpsNumbers = unique(output.baselineMpsNumbers);
    output.baselineMrpNumbers = unique(output.baselineMrpNumbers);
  }
  return grouped;
}

async function loadAdditionalDemandCoverage(prisma, options = {}) {
  const year = Number.parseInt(options.year, 10) || new Date().getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year + 1, 0, 1));
  const customerCode = String(options.customerCode || "").trim();
  const partCodes = unique(Array.isArray(options.partCodes) ? options.partCodes : []);
  const lockWhere = {
    status: "ACTIVE",
    periodMonth: { gte: start, lt: end },
    ...(customerCode ? { customerCode } : {}),
    ...(partCodes.length ? { partCode: { in: partCodes } } : {}),
  };
  const locks = await prisma.planningBaselineLock.findMany({
    where: lockWhere,
    orderBy: [{ periodMonth: "asc" }, { partCode: "asc" }, { customerCode: "asc" }],
  });
  if (!locks.length) return { year, items: [], byPartMonth: new Map() };

  const lockPartCodes = unique(locks.map((row) => row.partCode));
  const [rawSales, coverages] = await Promise.all([
    prisma.demandDeliveryTarget.findMany({
      where: {
        isDeleted: false,
        status: "ACTIVE",
        sourceType: "SALES_ORDER",
        targetDate: { gte: start, lt: end },
        partCode: { in: lockPartCodes },
        ...(customerCode ? { customerCode } : {}),
      },
      include: { soDetail: { include: { soHeader: true } } },
      orderBy: [{ targetDate: "asc" }, { sourceNumber: "asc" }, { phaseNumber: "asc" }],
    }),
    prisma.additionalDemandCoverage.findMany({
      where: { baselineLockId: { in: locks.map((row) => row.id) }, status: "ALLOCATED" },
      orderBy: [{ allocatedAt: "asc" }, { id: "asc" }],
    }),
  ]);

  const salesByScope = new Map();
  for (const row of rawSales.filter(activeSalesOrderTarget)) {
    const month = monthKey(row.targetDate);
    const key = scopeKey(month, String(row.customerCode || "UNASSIGNED"), row.partCode);
    if (!salesByScope.has(key)) salesByScope.set(key, { qty: 0, rows: [] });
    const bucket = salesByScope.get(key);
    bucket.qty = rounded(bucket.qty + number(row.qty));
    bucket.rows.push({
      deliveryTargetId: row.id,
      sourceNumber: row.sourceNumber,
      sourceLineId: row.sourceLineId,
      phaseNumber: row.phaseNumber,
      targetDate: row.targetDate,
      qty: rounded(row.qty),
      uomCode: row.uomCode || null,
    });
  }
  const coverageByLock = new Map();
  for (const row of coverages) {
    if (!coverageByLock.has(row.baselineLockId)) coverageByLock.set(row.baselineLockId, []);
    coverageByLock.get(row.baselineLockId).push(row);
  }

  const items = locks.map((lock) => {
    const month = monthKey(lock.periodMonth);
    const sales = salesByScope.get(scopeKey(month, lock.customerCode, lock.partCode)) || { qty: 0, rows: [] };
    const allocationRows = coverageByLock.get(lock.id) || [];
    const coveredFgStockQty = rounded(allocationRows.filter((row) => row.coverageType === "FG_STOCK").reduce((sum, row) => sum + number(row.qty), 0));
    const coveredFirmReceiptQty = rounded(allocationRows.filter((row) => row.coverageType === "FIRM_FG_RECEIPT").reduce((sum, row) => sum + number(row.qty), 0));
    const generatedDeltaQty = rounded(allocationRows.filter((row) => row.coverageType === "DELTA_MPS").reduce((sum, row) => sum + number(row.qty), 0));
    const additionalQty = additionalDemandQty({ currentSoQty: sales.qty, lockedEfdQty: lock.efdQtyLocked });
    const pending = pendingDeltaQty({ additionalQty, fgStockQty: coveredFgStockQty, firmReceiptQty: coveredFirmReceiptQty, generatedDeltaQty });
    return {
      baselineLockId: lock.id,
      month,
      customerCode: lock.customerCode,
      partCode: lock.partCode,
      uomCode: lock.uomCode || null,
      forecastQtyLocked: rounded(lock.forecastQtyLocked),
      poQtyLocked: rounded(lock.poQtyLocked),
      lockedEfdQty: rounded(lock.efdQtyLocked),
      currentSoQty: rounded(sales.qty),
      poDeltaQty: signedRounded(number(sales.qty) - number(lock.poQtyLocked)),
      additionalQty: rounded(additionalQty),
      coveredFgStockQty,
      coveredFirmReceiptQty,
      generatedDeltaQty,
      pendingDeltaQty: rounded(pending),
      uncoveredQty: rounded(pending),
      reductionQty: rounded(Math.max(number(lock.efdQtyLocked) - number(sales.qty), 0)),
      baselineMpsNumber: lock.baselineMpsNumber || null,
      baselineMrpNumber: lock.baselineMrpNumber || null,
      sourceSalesOrders: sales.rows,
      allocations: allocationRows,
      lock: {
        id: lock.id,
        locked: true,
        lockedAt: lock.lockedAt,
        lockedBy: lock.lockedBy || null,
        sourceFingerprint: lock.sourceFingerprint,
        sourceSnapshot: lock.sourceSnapshot || null,
      },
    };
  });
  const byPartMonth = aggregateCoverageByPartMonth(items);
  const currentPoByPartMonth = new Map();
  for (const row of rawSales.filter(activeSalesOrderTarget)) {
    const key = `${monthKey(row.targetDate)}|${row.partCode}`;
    currentPoByPartMonth.set(key, rounded((currentPoByPartMonth.get(key) || 0) + number(row.qty)));
  }
  for (const [key, coverage] of byPartMonth.entries()) {
    coverage.currentSoQty = currentPoByPartMonth.get(key) || 0;
    coverage.poDeltaQty = signedRounded(coverage.currentSoQty - coverage.poQtyLocked);
  }
  return { year, items, byPartMonth };
}

module.exports = { activeSalesOrderTarget, aggregateCoverageByPartMonth, loadAdditionalDemandCoverage };
