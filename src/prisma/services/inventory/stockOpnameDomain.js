"use strict";

const STO_STOCK_TYPES = Object.freeze({
  MATERIAL: Object.freeze(["Material", "Purchase Part"]),
  WIP: Object.freeze(["WIP", "WP", "Semi-Finished"]),
  FG: Object.freeze(["Finished Goods", "FG"]),
});

const text = (value) => String(value ?? "").trim();
const upper = (value) => text(value).toUpperCase();
const finiteNonNegative = (value, field) => {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) {
    const error = new Error(`${field} harus berupa angka >= 0.`);
    error.statusCode = 400;
    throw error;
  }
  return number;
};
const uniqueText = (values, transform = text) => [
  ...new Set((Array.isArray(values) ? values : values == null || values === "" ? [] : [values])
    .map(transform)
    .filter(Boolean)),
];

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function normalizeStockOpnameScope(input = {}) {
  const countMode = upper(input.countMode || "FULL");
  const stoType = upper(input.stoType || "MATERIAL");
  const warehouseCode = upper(input.warehouseCode);
  if (!["FULL", "CYCLE"].includes(countMode)) fail("countMode harus FULL atau CYCLE.");
  if (!STO_STOCK_TYPES[stoType]) fail("stoType harus MATERIAL, WIP, atau FG.");
  if (!warehouseCode) fail("warehouseCode wajib diisi.");

  const allowed = STO_STOCK_TYPES[stoType];
  const requestedStockTypes = uniqueText(input.stockTypes ?? input.stockType);
  const stockTypes = requestedStockTypes.length ? requestedStockTypes : [...allowed];
  const invalidStockType = stockTypes.find((stockType) => !allowed.includes(stockType));
  if (invalidStockType) fail(`Stock type ${invalidStockType} tidak sesuai dengan STO ${stoType}.`);

  const rackCodes = uniqueText(input.rackCodes ?? input.rackCode, upper);
  const lotNumbers = uniqueText(input.lotNumbers ?? input.lotNumber, upper);
  const stockBalanceIds = uniqueText(input.stockBalanceIds ?? input.stockBalanceId);
  if (countMode === "FULL" && stockBalanceIds.length) {
    fail("Full Count tidak menerima pilihan stock balance tertentu.");
  }
  if (countMode === "CYCLE" && !rackCodes.length && !lotNumbers.length && !stockBalanceIds.length) {
    fail("Cycle Count wajib memilih minimal rack, lot, atau stock balance.");
  }

  return {
    version: 1,
    countMode,
    stoType,
    warehouseCode,
    stockTypes,
    rackCodes,
    lotNumbers,
    stockBalanceIds,
    includeZeroBalance: input.includeZeroBalance !== false,
  };
}

function stockIdentityMatchesScope(identity = {}, scopeInput = {}) {
  let scope;
  try {
    scope = normalizeStockOpnameScope(scopeInput);
  } catch (_error) {
    return false;
  }
  if (upper(identity.warehouseCode) !== scope.warehouseCode) return false;
  if (!scope.stockTypes.includes(text(identity.stockType))) return false;
  if (scope.stockBalanceIds.length && !scope.stockBalanceIds.includes(text(identity.stockBalanceId))) return false;
  if (scope.rackCodes.length && !scope.rackCodes.includes(upper(identity.rackCode))) return false;
  if (scope.lotNumbers.length && !scope.lotNumbers.includes(upper(identity.lotNumber))) return false;
  return true;
}

function calculateStockOpnameVariance(systemQty, actualQty) {
  const system = Number(systemQty ?? 0);
  const actual = Number(actualQty);
  if (!Number.isFinite(system) || !Number.isFinite(actual) || actual < 0) {
    fail("System Qty dan Actual Qty harus berupa angka valid; Actual Qty harus >= 0.");
  }
  const varianceQty = actual - system;
  return {
    varianceQty,
    varianceStatus: varianceQty === 0 ? "MATCH" : varianceQty < 0 ? "SHORTAGE" : "EXCESS",
  };
}

function requiresStockOpnameRecount({
  systemQty,
  actualQty,
  toleranceQty = 0,
  tolerancePercent = 0,
} = {}) {
  const { varianceQty } = calculateStockOpnameVariance(systemQty, actualQty);
  const absoluteVariance = Math.abs(varianceQty);
  if (absoluteVariance === 0) return false;
  const quantityLimit = finiteNonNegative(toleranceQty, "Tolerance Qty");
  const percentLimit = finiteNonNegative(tolerancePercent, "Tolerance Percent");
  const variancePercent = (absoluteVariance / Math.max(Math.abs(Number(systemQty) || 0), 1)) * 100;
  return absoluteVariance > quantityLimit || variancePercent > percentLimit;
}

function evaluateStockOpnameAdjustment({ actualQty, qtyReserved = 0, qtyQC = 0 } = {}) {
  const actual = finiteNonNegative(actualQty, "Actual Qty");
  const reserved = finiteNonNegative(qtyReserved, "Reserved Qty");
  const qc = finiteNonNegative(qtyQC, "QC Qty");
  const committedQty = reserved + qc;
  const projectedAvailableQty = actual - committedQty;
  return {
    conflict: projectedAvailableQty < 0,
    committedQty,
    projectedAvailableQty,
  };
}

module.exports = {
  STO_STOCK_TYPES,
  normalizeStockOpnameScope,
  stockIdentityMatchesScope,
  calculateStockOpnameVariance,
  requiresStockOpnameRecount,
  evaluateStockOpnameAdjustment,
};