"use strict";

const {
  normalizeStockOpnameScope,
} = require("./stockOpnameDomain");

const number = (value) => Number(value || 0);

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function buildStockTypeWhere(scope, purchasePartCodes) {
  if (scope.stoType !== "MATERIAL") {
    return { stockType: { in: scope.stockTypes } };
  }
  const clauses = [];
  if (scope.stockTypes.includes("Material")) clauses.push({ stockType: "Material" });
  if (scope.stockTypes.includes("Purchase Part")) {
    clauses.push({ stockType: "Purchase Part" });
    if (purchasePartCodes.length) {
      clauses.push({ stockType: "Part", partCode: { in: purchasePartCodes } });
    }
  }
  return clauses.length === 1 ? clauses[0] : { OR: clauses };
}

function summarizeBalances(balances) {
  const summary = {
    lineCount: balances.length,
    qtyOnHand: 0,
    qtyReserved: 0,
    qtyQC: 0,
    qtyAvailable: 0,
    missingRackCount: 0,
    missingLotCount: 0,
  };
  const breakdown = new Map();
  for (const balance of balances) {
    summary.qtyOnHand += number(balance.qtyOnHand);
    summary.qtyReserved += number(balance.qtyReserved);
    summary.qtyQC += number(balance.qtyQC);
    summary.qtyAvailable += number(balance.qtyAvailable);
    if (!balance.rackCode) summary.missingRackCount += 1;
    if (!balance.lotNumber) summary.missingLotCount += 1;
    const stockType = String(balance.stockType || "Unknown");
    const row = breakdown.get(stockType) || { stockType, lineCount: 0, qtyOnHand: 0 };
    row.lineCount += 1;
    row.qtyOnHand += number(balance.qtyOnHand);
    breakdown.set(stockType, row);
  }
  return {
    summary,
    stockTypeBreakdown: [...breakdown.values()].sort((left, right) =>
      left.stockType.localeCompare(right.stockType)),
  };
}

async function resolveStockOpnameScope(db, input, { includeBalances = true } = {}) {
  const scope = normalizeStockOpnameScope(input);
  const warehouse = await db.warehouse.findFirst({
    where: {
      warehouseCode: scope.warehouseCode,
      isDeleted: false,
      isActive: true,
    },
    select: { warehouseCode: true },
  });
  if (!warehouse) fail("Warehouse tidak ditemukan atau tidak aktif.");

  const purchasePartCodes = scope.stoType === "MATERIAL" && scope.stockTypes.includes("Purchase Part")
    ? (await db.part.findMany({
        where: { isDeleted: false, itemType: "RAW", rawType: "PURCHASE_PART" },
        select: { partCode: true },
      })).map((part) => part.partCode).filter(Boolean)
    : [];

  const where = {
    warehouseCode: scope.warehouseCode,
    isDeleted: false,
    ...buildStockTypeWhere(scope, purchasePartCodes),
    ...(scope.rackCodes.length ? { rackCode: { in: scope.rackCodes } } : {}),
    ...(scope.lotNumbers.length ? { lotNumber: { in: scope.lotNumbers } } : {}),
    ...(scope.stockBalanceIds.length ? { id: { in: scope.stockBalanceIds } } : {}),
    ...(!scope.includeZeroBalance ? { qtyOnHand: { not: 0 } } : {}),
  };
  const balances = await db.stockBalance.findMany({
    where,
    orderBy: [
      { stockType: "asc" },
      { rackCode: "asc" },
      { partCode: "asc" },
      { materialCode: "asc" },
      { lotNumber: "asc" },
    ],
  });
  const { summary, stockTypeBreakdown } = summarizeBalances(balances);
  const warnings = [];
  if (summary.missingRackCount) {
    warnings.push(`${summary.missingRackCount} balance masih tanpa rack; counting tetap dapat memakai opsi Tanpa rack.`);
  }
  if (summary.missingLotCount) {
    warnings.push(`${summary.missingLotCount} balance masih tanpa lot; counting tetap dapat memakai opsi Tanpa lot.`);
  }
  if (!summary.lineCount) warnings.push("Tidak ada stock balance pada scope opname yang dipilih.");

  return {
    scope,
    summary,
    stockTypeBreakdown,
    warnings,
    ...(includeBalances ? { balances } : {}),
  };
}

module.exports = {
  buildStockTypeWhere,
  summarizeBalances,
  resolveStockOpnameScope,
};