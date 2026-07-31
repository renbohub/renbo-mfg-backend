/* eslint-disable no-console */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const API_BASE_URL = String(
  process.env.SIMULATION_API_BASE_URL
    || process.env.API_BASE_URL
    || `http://localhost:${process.env.PORT || 5017}`,
).replace(/\/+$/, "");

const MARKER = "SIM-BRACKET-COMP-AUG-2026";
const OPENING_REFERENCE = `${MARKER}-OPENING-20260731`;
const FG_PART_CODE = "C002-C004-000";
const BOM_NUMBER = "MBOM-20260729-008";
const CUSTOMER_CODE = "C002";
const AUGUST_MONTH = "2026-08-01T00:00:00.000Z";
const SEPTEMBER_MONTH = "2026-09-01T00:00:00.000Z";
const AUGUST_DUE_DATE = "2026-08-31T00:00:00.000Z";

const requestedPhases = new Set(
  process.argv.slice(2).filter((arg) => arg.startsWith("--")).map((arg) => arg.slice(2)),
);
if (!requestedPhases.size) requestedPhases.add("audit");
if (requestedPhases.has("all")) {
  ["audit", "opening", "demand", "planning"].forEach((phase) => requestedPhases.add(phase));
}

let authToken = null;

const encode = encodeURIComponent;
const number = (value) => Number(value || 0);
const itemsOf = (payload) => Array.isArray(payload) ? payload : (payload?.items || []);

async function api(method, route, body) {
  const response = await fetch(`${API_BASE_URL}/api${route}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = raw;
  }
  if (!response.ok) {
    const error = new Error(
      `${method} ${route} -> ${response.status}: ${payload?.message || payload || response.statusText}`,
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function login() {
  const identifier = process.env.DEFAULT_ADMIN_USERNAME || "admin";
  const password = process.env.DEFAULT_ADMIN_PASSWORD || "admin123";
  const result = await api("POST", "/auth/login", { identifier, password });
  authToken = result.token;
  if (!authToken) throw new Error("Login berhasil tetapi API tidak mengembalikan token.");
  return result.user;
}

async function findPartByNumber(fragment) {
  const result = await api("GET", `/master-data/parts?q=${encode(fragment)}&limit=100`);
  const candidates = itemsOf(result).filter((part) =>
    String(part.partNumber || "").toUpperCase().includes(String(fragment).toUpperCase()),
  );
  const exact = candidates.filter((part) =>
    String(part.partNumber || "").toUpperCase() === String(fragment).toUpperCase(),
  );
  if (exact.length === 1) return exact[0];
  if (candidates.length === 1) return candidates[0];
  return { ambiguous: true, fragment, candidates };
}

function chooseWarehouse(warehouses, kind) {
  const active = warehouses.filter((warehouse) => warehouse.isActive !== false && !warehouse.isDeleted);
  const tokens = {
    material: ["MATERIAL", "RAW"],
    wip: ["WIP", "PRODUCTION"],
    fg: ["FINISHED", "FG"],
    purchase: ["PURCHASE", "MATERIAL", "RAW"],
  }[kind] || [];
  const exact = active.find((warehouse) => {
    const haystack = `${warehouse.type || ""} ${warehouse.warehouseName || ""}`.toUpperCase();
    return tokens.some((token) => haystack.includes(token));
  });
  return exact
    || active.find((warehouse) => warehouse.availableForProduction)
    || active[0]
    || null;
}

async function loadContext() {
  const [
    warehousesResponse,
    customer,
    fgPart,
    bom,
    existingMovements,
    forecasts,
    salesOrders,
    part0697,
    part0698,
  ] = await Promise.all([
    api("GET", "/inventory/warehouses?isActive=true&limit=200"),
    api("GET", `/master-data/customers/${encode(CUSTOMER_CODE)}`),
    api("GET", `/master-data/parts/${encode(FG_PART_CODE)}`),
    api("GET", `/mbom/mbom/${encode(BOM_NUMBER)}`),
    api("GET", `/inventory/stock-movements?q=${encode(OPENING_REFERENCE)}&limit=200`),
    api("GET", "/planning/forecasts?limit=500"),
    api("GET", "/sales/sales-orders?limit=500"),
    findPartByNumber("0697"),
    findPartByNumber("0698"),
  ]);
  const warehouses = itemsOf(warehousesResponse);
  return {
    warehouses,
    warehouseByKind: {
      material: chooseWarehouse(warehouses, "material"),
      wip: chooseWarehouse(warehouses, "wip"),
      fg: chooseWarehouse(warehouses, "fg"),
      purchase: chooseWarehouse(warehouses, "purchase"),
    },
    customer,
    fgPart,
    bom,
    existingMovements: itemsOf(existingMovements),
    forecast: itemsOf(forecasts).find((item) =>
      item.sourceBatchNumber === MARKER || String(item.forecastName || "").includes(MARKER),
    ) || null,
    salesOrder: itemsOf(salesOrders).find((item) => String(item.notes || "").includes(MARKER)) || null,
    part0697,
    part0698,
  };
}

function openingEntries(context) {
  const entries = [
    { key: "FG-1498", stockType: "Finished Goods", partCode: FG_PART_CODE, qty: 20, uomCode: "PCS", warehouseKind: "fg" },
    { key: "WELD-1498", stockType: "WIP", partCode: "C002-C004-070", qty: 10, uomCode: "PCS", warehouseKind: "wip" },

    { key: "FG-1287", stockType: "Finished Goods", partCode: "C002-C005-000", qty: 10, uomCode: "PCS", warehouseKind: "fg" },
    { key: "SPOT-1287", stockType: "WIP", partCode: "C002-C005-010", qty: 7, uomCode: "PCS", warehouseKind: "wip" },
    { key: "PROD-1287", stockType: "WIP", partCode: "C002-C005-020", qty: 121, uomCode: "PCS", warehouseKind: "wip" },
    { key: "FG-1288", stockType: "Finished Goods", partCode: "C002-C006-000", qty: 15, uomCode: "PCS", warehouseKind: "fg" },
    { key: "SPOT-1288", stockType: "WIP", partCode: "C002-C006-010", qty: 6, uomCode: "PCS", warehouseKind: "wip" },
    { key: "PROD-1288", stockType: "WIP", partCode: "C002-C006-020", qty: 87, uomCode: "PCS", warehouseKind: "wip" },
    { key: "FG-1289", stockType: "Finished Goods", partCode: "C002-C007-000", qty: 13, uomCode: "PCS", warehouseKind: "fg" },
    { key: "SPOT-1289", stockType: "WIP", partCode: "C002-C007-010", qty: 9, uomCode: "PCS", warehouseKind: "wip" },
    { key: "PROD-1289", stockType: "WIP", partCode: "C002-C007-020", qty: 57, uomCode: "PCS", warehouseKind: "wip" },
    { key: "FG-1290", stockType: "Finished Goods", partCode: "C002-C008-000", qty: 11, uomCode: "PCS", warehouseKind: "fg" },
    { key: "SPOT-1290", stockType: "WIP", partCode: "C002-C008-010", qty: 15, uomCode: "PCS", warehouseKind: "wip" },
    { key: "PROD-1290", stockType: "WIP", partCode: "C002-C008-020", qty: 43, uomCode: "PCS", warehouseKind: "wip" },
    { key: "FG-1291", stockType: "Finished Goods", partCode: "C002-C009-000", qty: 17, uomCode: "PCS", warehouseKind: "fg" },
    { key: "SPOT-1291", stockType: "WIP", partCode: "C002-C009-010", qty: 30, uomCode: "PCS", warehouseKind: "wip" },
    { key: "PROD-1291", stockType: "WIP", partCode: "C002-C009-020", qty: 81, uomCode: "PCS", warehouseKind: "wip" },
    { key: "FG-1292", stockType: "Finished Goods", partCode: "C002-0006-000", qty: 20, uomCode: "PCS", warehouseKind: "fg" },
    { key: "SPOT-1292", stockType: "WIP", partCode: "C002-0006-010", qty: 14, uomCode: "PCS", warehouseKind: "wip" },
    { key: "PROD-1292", stockType: "WIP", partCode: "C002-0006-020", qty: 66, uomCode: "PCS", warehouseKind: "wip" },

    { key: "MAT-1287", stockType: "Material", materialCode: "SPHC-PO-2-145", qty: 1.3772825, uomCode: "KG", warehouseKind: "material" },
    { key: "MAT-1288", stockType: "Material", materialCode: "SPHC-PO-2-145", qty: 1.00166, uomCode: "KG", warehouseKind: "material" },
    { key: "MAT-1289", stockType: "Material", materialCode: "SPHC-PO-1.6-50", qty: 0.202216, uomCode: "KG", warehouseKind: "material" },
    { key: "MAT-1290", stockType: "Material", materialCode: "SPHC-PO-1.6-75", qty: 0.35796, uomCode: "KG", warehouseKind: "material" },
    { key: "MAT-1291", stockType: "Material", materialCode: "SPHC-PO-1.6-65", qty: 0.6343428, uomCode: "KG", warehouseKind: "material" },
    { key: "MAT-1292", stockType: "Material", materialCode: "SPHC-PO-2-175", qty: 10.489955, uomCode: "KG", warehouseKind: "material" },

    { key: "NUT-M6", stockType: "Purchase Part", partCode: "MI-M06-N01", qty: 205, uomCode: "PCS", warehouseKind: "purchase" },
    { key: "PIN-1766", stockType: "Purchase Part", partCode: "C002-0007-000", qty: 43, uomCode: "PCS", warehouseKind: "purchase" },
  ];
  if (!context.part0697.ambiguous) {
    entries.push({ key: "PART-0697", stockType: "Purchase Part", partCode: context.part0697.partCode, qty: 24, uomCode: "PCS", warehouseKind: "purchase" });
  }
  if (!context.part0698.ambiguous) {
    entries.push({ key: "PART-0698", stockType: "Purchase Part", partCode: context.part0698.partCode, qty: 33, uomCode: "PCS", warehouseKind: "purchase" });
  }
  return entries;
}

async function audit(context, user) {
  const opening = openingEntries(context);
  const materialCodes = [...new Set(opening.filter((row) => row.materialCode).map((row) => row.materialCode))];
  const materialChecks = await Promise.all(materialCodes.map(async (materialCode) => {
    try {
      const material = await api("GET", `/master-data/materials/${encode(materialCode)}`);
      return { materialCode, found: true, id: material.id };
    } catch (error) {
      if (error.status === 404) return { materialCode, found: false };
      throw error;
    }
  }));
  const warehouseSummary = Object.fromEntries(
    Object.entries(context.warehouseByKind).map(([kind, warehouse]) => [
      kind,
      warehouse ? `${warehouse.warehouseCode} (${warehouse.warehouseName || warehouse.type || "-"})` : null,
    ]),
  );
  console.log(JSON.stringify({
    apiBaseUrl: API_BASE_URL,
    authenticatedAs: user?.username || user?.email || user?.id,
    customer: { code: context.customer.customerCode, name: context.customer.customerName },
    fg: { partCode: context.fgPart.partCode, partNumber: context.fgPart.partNumber, partName: context.fgPart.partName },
    bom: { id: context.bom.id, number: context.bom.noReg || context.bom.mbomNumber || BOM_NUMBER, status: context.bom.status },
    warehouses: warehouseSummary,
    opening: {
      expectedEntries: opening.length,
      existingEntries: context.existingMovements.length,
      existingQty: context.existingMovements.reduce((sum, row) => sum + number(row.qty), 0),
      materials: materialChecks,
      part0697: context.part0697.ambiguous
        ? context.part0697.candidates.map((part) => ({ partCode: part.partCode, partNumber: part.partNumber, partName: part.partName }))
        : { partCode: context.part0697.partCode, partNumber: context.part0697.partNumber },
      part0698: context.part0698.ambiguous
        ? context.part0698.candidates.map((part) => ({ partCode: part.partCode, partNumber: part.partNumber, partName: part.partName }))
        : { partCode: context.part0698.partCode, partNumber: context.part0698.partNumber },
    },
    demand: {
      forecast: context.forecast ? { forecastNumber: context.forecast.forecastNumber, status: context.forecast.status } : null,
      salesOrder: context.salesOrder ? { soNumber: context.salesOrder.soNumber, status: context.salesOrder.status } : null,
    },
  }, null, 2));
}

async function postOpening(context) {
  const entries = openingEntries(context);
  if (context.part0697.ambiguous || context.part0698.ambiguous) {
    throw new Error("Part number 0697/0698 belum terpetakan unik. Opening stock dihentikan agar tidak masuk ke master part yang salah.");
  }
  const missingWarehouses = Object.entries(context.warehouseByKind).filter(([, value]) => !value);
  if (missingWarehouses.length) {
    throw new Error(`Warehouse aktif tidak ditemukan untuk: ${missingWarehouses.map(([key]) => key).join(", ")}.`);
  }
  const existingKeys = new Set(
    context.existingMovements
      .map((movement) => String(movement.notes || "").split("|OPENING|")[1])
      .filter(Boolean),
  );
  const created = [];
  const skipped = [];
  for (const entry of entries) {
    if (existingKeys.has(entry.key)) {
      skipped.push(entry.key);
      continue;
    }
    const warehouse = context.warehouseByKind[entry.warehouseKind];
    const result = await api("POST", "/inventory/stock-movements", {
      movementType: "IN",
      movementDate: "2026-07-31T12:00:00.000+07:00",
      transactionType: "OPENING_BALANCE",
      warehouseCode: warehouse.warehouseCode,
      stockType: entry.stockType,
      partCode: entry.partCode,
      materialCode: entry.materialCode,
      qty: entry.qty,
      uomCode: entry.uomCode,
      referenceType: "SIMULATION",
      referenceNumber: OPENING_REFERENCE,
      notes: `${MARKER}|OPENING|${entry.key}`,
    });
    created.push({
      key: entry.key,
      movementNumber: result.items?.[0]?.movementNumber,
      qty: entry.qty,
      uomCode: entry.uomCode,
    });
  }
  console.log(JSON.stringify({ phase: "opening", created, skipped }, null, 2));
}

async function ensureDemand(context) {
  let forecast = context.forecast;
  if (!forecast) {
    forecast = await api("POST", "/planning/forecasts", {
      forecastName: `${MARKER} Forecast`,
      sourceBatchNumber: MARKER,
      customerCode: CUSTOMER_CODE,
      demandBucket: "PLANNING",
      periodStart: AUGUST_MONTH,
      periodEnd: "2026-09-30T00:00:00.000Z",
      notes: `${MARKER}; Forecast Agustus dan September untuk konsumsi MPS Agustus serta buffer 50%.`,
      details: [
        { partCode: FG_PART_CODE, uomCode: "PCS", forecastMonth: AUGUST_MONTH, forecastQty: 300, notes: MARKER },
        { partCode: FG_PART_CODE, uomCode: "PCS", forecastMonth: SEPTEMBER_MONTH, forecastQty: 300, notes: MARKER },
      ],
    });
  }
  if (forecast.status === "Draft") {
    forecast = await api("POST", `/planning/forecasts/${encode(forecast.forecastNumber)}/submit`, {});
  }

  let salesOrder = context.salesOrder;
  if (!salesOrder) {
    salesOrder = await api("POST", "/sales/sales-orders", {
      soDate: "2026-07-30T12:00:00.000+07:00",
      customerCode: context.customer.customerCode,
      customerName: context.customer.customerName,
      currencyCode: "IDR",
      deliveryDate: AUGUST_DUE_DATE,
      notes: `${MARKER}; SO Agustus 300 PCS.`,
      details: [{
        partCode: FG_PART_CODE,
        partNumber: context.fgPart.partNumber,
        partName: context.fgPart.partName,
        uomCode: "PCS",
        mbomHeaderId: context.bom.id,
        qty: 300,
        unitPrice: 0,
        deliveryDate: AUGUST_DUE_DATE,
        notes: MARKER,
      }],
    });
  }
  if (salesOrder.status === "Draft") {
    salesOrder = await api("PATCH", `/sales/sales-orders/${encode(salesOrder.soNumber)}/confirm`, {});
  }
  console.log(JSON.stringify({
    phase: "demand",
    forecast: { forecastNumber: forecast.forecastNumber, status: forecast.status },
    salesOrder: {
      soNumber: salesOrder.soNumber,
      status: salesOrder.status,
      reservationWarnings: salesOrder.reservationWarnings || [],
    },
  }, null, 2));
  return { forecast, salesOrder };
}

async function ensurePlanning(context) {
  const refreshed = await loadContext();
  if (!refreshed.forecast || !refreshed.salesOrder) {
    throw new Error("Forecast dan Sales Order simulasi belum tersedia. Jalankan --demand terlebih dahulu.");
  }
  if (!["Confirmed", "Partial Product", "Consumed"].includes(refreshed.forecast.status)) {
    throw new Error(`Forecast belum siap dibuat MPS. Status: ${refreshed.forecast.status}.`);
  }
  if (!["Confirmed", "In Progress", "Ready to Deliver", "Delivered"].includes(refreshed.salesOrder.status)) {
    throw new Error(`Sales Order belum Confirmed. Status: ${refreshed.salesOrder.status}.`);
  }

  const existingMpsResponse = await api("GET", `/planning/mps?q=${encode(refreshed.forecast.forecastNumber)}&limit=500`);
  let mps = itemsOf(existingMpsResponse).find((item) =>
    String(item.periodStart || "").slice(0, 7) === "2026-08",
  );
  if (!mps) {
    const result = await api("POST", "/planning/mps/from-forecast", {
      forecastNumber: refreshed.forecast.forecastNumber,
      months: ["2026-08"],
      productionPercent: 100,
      mpsName: `${MARKER} MPS`,
      notes: `${MARKER}; MPS Agustus dengan SO 300 dan buffer September 50%.`,
    });
    mps = result.items?.[0] || result;
  }

  let mpsDetail = (mps.details || []).find((row) =>
    row.partCode === FG_PART_CODE && !String(row.notes || "").startsWith("[MRP-PRODUCTION]"),
  );
  let fullMps = await api("GET", `/planning/mps/${encode(mps.mpsNumber)}`);
  mpsDetail = fullMps.details.find((row) =>
    row.partCode === FG_PART_CODE && !String(row.notes || "").startsWith("[MRP-PRODUCTION]"),
  );

  const customerPhases = (fullMps.deliveryPlans || []).filter((phase) =>
    phase.targetType === "CUSTOMER"
      && phase.targetCode === CUSTOMER_CODE
      && phase.partCode === FG_PART_CODE
      && phase.status !== "Cancelled",
  );
  const customerPlanned = customerPhases.reduce((sum, phase) => sum + number(phase.qtyPlanned), 0);
  if (customerPlanned < 300) {
    await api("POST", `/planning/mps/${encode(mps.mpsNumber)}/delivery-phases`, {
      mpsDetailId: mpsDetail.id,
      targetType: "CUSTOMER",
      targetCode: CUSTOMER_CODE,
      plannedDate: AUGUST_DUE_DATE,
      qtyPlanned: 300 - customerPlanned,
      notes: `${MARKER}; delivery SO Agustus phase 1.`,
    });
    fullMps = await api("GET", `/planning/mps/${encode(mps.mpsNumber)}`);
  }

  const readiness = await api("GET", `/planning/mps/${encode(mps.mpsNumber)}/readiness`);
  let confirmed = fullMps;
  if (fullMps.status === "Draft" && readiness.ok) {
    confirmed = await api("PATCH", `/planning/mps/${encode(mps.mpsNumber)}/confirm`, {});
  }
  let mrp = null;
  if (["Confirmed", "Released"].includes(confirmed.status)) {
    const mrpList = await api("GET", `/planning/mrp?limit=500&q=${encode(mps.mpsNumber)}`);
    mrp = itemsOf(mrpList).find((item) => item.mpsNumber === mps.mpsNumber && !item.isDeleted);
    if (!mrp) {
      mrp = await api("POST", "/planning/mrp/run", {
        mpsNumber: mps.mpsNumber,
        cutoffDate: AUGUST_DUE_DATE,
      });
    }
  }
  console.log(JSON.stringify({
    phase: "planning",
    mps: {
      mpsNumber: mps.mpsNumber,
      status: confirmed.status,
      forecastQty: number(mpsDetail.forecastQty),
      actualSalesOrderQty: number(mpsDetail.actualSalesOrderQty),
      bufferBaseQty: number(mpsDetail.bufferBaseQty),
      bufferPercent: number(mpsDetail.bufferPercent),
      bufferQty: number(mpsDetail.bufferQty),
      stockAvailableQty: number(mpsDetail.stockAvailableQty),
      effectiveDemandQty: number(mpsDetail.effectiveDemandQty),
      qtyPlanned: number(mpsDetail.qtyPlanned),
      customerDeliveryQty: (fullMps.deliveryPlans || [])
        .filter((phase) => phase.targetType === "CUSTOMER" && phase.status !== "Cancelled")
        .reduce((sum, phase) => sum + number(phase.qtyPlanned), 0),
    },
    readiness,
    mrp: mrp ? { runNumber: mrp.runNumber, status: mrp.status, errorMessage: mrp.errorMessage || null } : null,
  }, null, 2));
}

async function main() {
  const user = await login();
  let context = await loadContext();
  if (requestedPhases.has("audit")) await audit(context, user);
  if (requestedPhases.has("opening")) {
    await postOpening(context);
    context = await loadContext();
  }
  if (requestedPhases.has("demand")) {
    await ensureDemand(context);
    context = await loadContext();
  }
  if (requestedPhases.has("planning")) await ensurePlanning(context);
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: error.message,
    status: error.status || null,
    payload: error.payload || null,
  }, null, 2));
  process.exitCode = 1;
});
