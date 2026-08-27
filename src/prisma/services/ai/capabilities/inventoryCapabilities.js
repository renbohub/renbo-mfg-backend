"use strict";

const STOCK_SELECT = Object.freeze({
  id: true, partCode: true, partName: true, materialCode: true, materialName: true,
  uomCode: true, warehouseCode: true, rackCode: true, lotNumber: true, stockType: true,
  qtyOnHand: true, qtyReserved: true, qtyAvailable: true,
  warehouse: { select: { warehouseName: true } },
});

const ACTIVE_MRP_STOCK_WHERE = Object.freeze({
  isDeleted: false,
  warehouse: { isDeleted: false, isActive: true, availableForMrp: true },
});

const sourceSchema = {
  type: "object", additionalProperties: false,
  required: ["entityType", "entityId", "label", "href"],
  properties: { entityType: { type: "string" }, entityId: { type: "string" }, label: { type: "string" }, href: { type: "string" } },
};
const inputLimit = { type: "integer", minimum: 1, maximum: 100, default: 100 };

function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function isPcs(uomCode) { return ["PCS", "PC", "PCE", "EA"].includes(String(uomCode || "").trim().toUpperCase()); }
function roundQty(value, uomCode) { return isPcs(uomCode) ? Math.round(number(value)) : Math.round(number(value) * 100) / 100; }
function stockKey(row) { return String(row.partCode || row.materialCode || "").trim(); }
function isWip(row) { return /WIP|WORK.IN.PROCESS|SEMI.FINISHED/i.test(String(row.stockType || "")); }
function stockHref(id) { return `/modules/inventory/stock-balances/${encodeURIComponent(id)}`; }

function searchWhere(input = {}) {
  const query = String(input.query || input.partCode || "").trim();
  return {
    ...ACTIVE_MRP_STOCK_WHERE,
    ...(query ? { OR: [
      { partCode: { contains: query, mode: "insensitive" } },
      { materialCode: { contains: query, mode: "insensitive" } },
      { partName: { contains: query, mode: "insensitive" } },
      { materialName: { contains: query, mode: "insensitive" } },
    ] } : {}),
  };
}

function aggregateStock(rows = [], limit = 100) {
  const grouped = new Map();
  for (const row of rows) {
    const code = stockKey(row);
    if (!code) continue;
    const current = grouped.get(code) || {
      partCode: code, partName: row.partName || row.materialName || null, uomCode: row.uomCode || null,
      warehouseQty: 0, wipQty: 0, reservedQty: 0, locations: [], sources: [],
    };
    const onHand = Math.max(number(row.qtyOnHand), 0);
    if (isWip(row)) current.wipQty += onHand; else current.warehouseQty += onHand;
    current.reservedQty += Math.max(number(row.qtyReserved), 0);
    current.locations.push({ warehouseCode: row.warehouseCode || null, rackCode: row.rackCode || null, lotNumber: row.lotNumber || null, qty: roundQty(onHand, row.uomCode) });
    current.sources.push({ entityType: "STOCK_BALANCE", entityId: String(row.id), label: `${code} · ${row.warehouseCode || "Warehouse"}${row.lotNumber ? ` · ${row.lotNumber}` : ""}`, href: stockHref(row.id) });
    grouped.set(code, current);
  }
  return [...grouped.values()].slice(0, Math.min(Math.max(number(limit) || 100, 1), 100)).map((row) => ({
    ...row,
    warehouseQty: roundQty(row.warehouseQty, row.uomCode),
    wipQty: roundQty(row.wipQty, row.uomCode),
    reservedQty: roundQty(row.reservedQty, row.uomCode),
    freeQty: roundQty(Math.max(row.warehouseQty + row.wipQty - row.reservedQty, 0), row.uomCode),
  }));
}

async function getStockSummary({ prisma, input }) {
  const limit = Math.min(Math.max(number(input.limit) || 100, 1), 100);
  const rows = await prisma.stockBalance.findMany({ where: searchWhere(input), select: STOCK_SELECT, orderBy: [{ partCode: "asc" }, { warehouseCode: "asc" }, { lotNumber: "asc" }], take: limit * 10 });
  const items = aggregateStock(rows, limit);
  return { items, sources: items.flatMap((item) => item.sources).slice(0, 100) };
}

async function traceStockUsage({ prisma, input }) {
  const partCode = String(input.partCode || "").trim();
  const [balances, reservations, movements] = await Promise.all([
    prisma.stockBalance.findMany({ where: searchWhere({ partCode }), select: STOCK_SELECT, take: 100 }),
    prisma.stockReservation.findMany({ where: { isDeleted: false, status: { in: ["Active", "Partial"] }, OR: [{ partCode }, { stockBalance: { partCode } }] }, select: { id: true, reservationNumber: true, qtyReserved: true, qtyReleased: true, status: true, referenceType: true, referenceNumber: true, stockBalanceId: true }, orderBy: { reservationDate: "desc" }, take: 100 }),
    prisma.stockMovement.findMany({ where: { isDeleted: false, OR: [{ partCode }, { stockBalance: { partCode } }] }, select: { id: true, movementNumber: true, movementDate: true, movementType: true, qty: true, referenceType: true, referenceNumber: true, stockBalanceId: true }, orderBy: { movementDate: "desc" }, take: 100 }),
  ]);
  const stock = aggregateStock(balances, 100)[0] || null;
  const mappedReservations = reservations.map((row) => ({ reservationNumber: row.reservationNumber, status: row.status, reservedQty: roundQty(row.qtyReserved, stock?.uomCode), releasedQty: roundQty(row.qtyReleased, stock?.uomCode), openQty: roundQty(Math.max(number(row.qtyReserved) - number(row.qtyReleased), 0), stock?.uomCode), referenceType: row.referenceType || null, referenceNumber: row.referenceNumber || null }));
  const mappedMovements = movements.map((row) => ({ movementNumber: row.movementNumber, movementDate: row.movementDate?.toISOString?.() || String(row.movementDate || ""), movementType: row.movementType, qty: roundQty(row.qty, stock?.uomCode), referenceType: row.referenceType || null, referenceNumber: row.referenceNumber || null }));
  const sources = [
    ...(stock?.sources || []),
    ...reservations.map((row) => ({ entityType: "STOCK_RESERVATION", entityId: String(row.id), label: row.reservationNumber, href: `/modules/inventory/stock-reservations/${encodeURIComponent(row.reservationNumber)}` })),
    ...movements.map((row) => ({ entityType: "STOCK_MOVEMENT", entityId: String(row.id), label: row.movementNumber, href: `/modules/inventory/stock-movements/${encodeURIComponent(row.movementNumber)}` })),
  ].slice(0, 100);
  return { partCode, stock, reservations: mappedReservations, movements: mappedMovements, sources };
}

async function getStockRisk({ prisma, input }) {
  const limit = Math.min(Math.max(number(input.limit) || 100, 1), 100);
  const [rows, parts] = await Promise.all([
    prisma.stockBalance.findMany({ where: ACTIVE_MRP_STOCK_WHERE, select: STOCK_SELECT, take: 1000 }),
    prisma.part.findMany({ where: { isDeleted: false, safetyStock: { gt: 0 } }, select: { partCode: true, partName: true, safetyStock: true, baseUomCode: true, stockUomCode: true }, take: 1000 }),
  ]);
  const stockByCode = new Map(aggregateStock(rows, 1000).map((row) => [row.partCode, row]));
  const items = parts.map((part) => {
    const stock = stockByCode.get(part.partCode);
    const uomCode = stock?.uomCode || part.stockUomCode || part.baseUomCode || null;
    const freeQty = number(stock?.freeQty);
    const safetyStockQty = roundQty(part.safetyStock, uomCode);
    return { partCode: part.partCode, partName: part.partName || stock?.partName || null, uomCode, freeQty: roundQty(freeQty, uomCode), safetyStockQty, shortageQty: roundQty(Math.max(safetyStockQty - freeQty, 0), uomCode), sources: stock?.sources || [] };
  }).filter((row) => row.shortageQty > 0).sort((a, b) => number(b.shortageQty) - number(a.shortageQty)).slice(0, limit);
  return { items, sources: items.flatMap((item) => item.sources).slice(0, 100) };
}

const stockItemSchema = {
  type: "object", additionalProperties: false,
  required: ["partCode", "partName", "uomCode", "warehouseQty", "wipQty", "reservedQty", "freeQty", "locations", "sources"],
  properties: {
    partCode: { type: "string" }, partName: { type: ["string", "null"] }, uomCode: { type: ["string", "null"] }, warehouseQty: { type: "number" }, wipQty: { type: "number" }, reservedQty: { type: "number" }, freeQty: { type: "number" },
    locations: { type: "array", items: { type: "object", additionalProperties: false, required: ["warehouseCode", "rackCode", "lotNumber", "qty"], properties: { warehouseCode: { type: ["string", "null"] }, rackCode: { type: ["string", "null"] }, lotNumber: { type: ["string", "null"] }, qty: { type: "number" } } } },
    sources: { type: "array", items: sourceSchema },
  },
};

function createInventoryCapabilityDefinitions() {
  const permission = { moduleCode: "inventory", pageCode: "*", resourceCode: "stockBalances", action: "read" };
  return [
    { code: "inventory.get_stock_summary", operationClass: "READ", permission, maxRows: 100, fieldAllowlist: ["items", "sources"], inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string", maxLength: 100 }, partCode: { type: "string", maxLength: 100 }, limit: inputLimit } }, outputSchema: { type: "object", additionalProperties: false, required: ["items", "sources"], properties: { items: { type: "array", items: stockItemSchema }, sources: { type: "array", items: sourceSchema } } }, execute: getStockSummary },
    { code: "inventory.trace_stock_usage", operationClass: "ANALYZE", permission, maxRows: 100, fieldAllowlist: ["partCode", "stock", "reservations", "movements", "sources"], inputSchema: { type: "object", additionalProperties: false, required: ["partCode"], properties: { partCode: { type: "string", minLength: 1, maxLength: 100 } } }, outputSchema: { type: "object" }, execute: traceStockUsage },
    { code: "inventory.get_stock_risk", operationClass: "ANALYZE", permission, maxRows: 100, fieldAllowlist: ["items", "sources"], inputSchema: { type: "object", additionalProperties: false, properties: { limit: inputLimit } }, outputSchema: { type: "object" }, execute: getStockRisk },
  ];
}

function registerInventoryCapabilities(registry) { for (const definition of createInventoryCapabilityDefinitions()) if (!registry.has(definition.code)) registry.register(definition); return registry; }

module.exports = { ACTIVE_MRP_STOCK_WHERE, STOCK_SELECT, roundQty, aggregateStock, createInventoryCapabilityDefinitions, registerInventoryCapabilities };
