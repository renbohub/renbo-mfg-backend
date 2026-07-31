/* eslint-disable no-console */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const base = `http://localhost:${process.env.PORT || 5017}/api`;
const marker = "SIM-BRACKET-COMP-AUG-2026";
const referenceNumber = `${marker}-OPENING-20260731`;
const movements = [
  ["FG-1498", "Finished Goods", "C002-C004-000", 20, "PCS"],
  ["WELD-1498", "WIP", "C002-C004-070", 10, "PCS"],
  ["FG-1287", "Finished Goods", "C002-C005-000", 10, "PCS"],
  ["SPOT-1287", "WIP", "C002-C005-010", 7, "PCS"],
  ["PROD-1287", "WIP", "C002-C005-020", 121, "PCS"],
  ["FG-1288", "Finished Goods", "C002-C006-000", 15, "PCS"],
  ["SPOT-1288", "WIP", "C002-C006-010", 6, "PCS"],
  ["PROD-1288", "WIP", "C002-C006-020", 87, "PCS"],
  ["FG-1289", "Finished Goods", "C002-C007-000", 13, "PCS"],
  ["SPOT-1289", "WIP", "C002-C007-010", 9, "PCS"],
  ["PROD-1289", "WIP", "C002-C007-020", 57, "PCS"],
  ["FG-1290", "Finished Goods", "C002-C008-000", 11, "PCS"],
  ["SPOT-1290", "WIP", "C002-C008-010", 15, "PCS"],
  ["PROD-1290", "WIP", "C002-C008-020", 43, "PCS"],
  ["FG-1291", "Finished Goods", "C002-C009-000", 17, "PCS"],
  ["SPOT-1291", "WIP", "C002-C009-010", 30, "PCS"],
  ["PROD-1291", "WIP", "C002-C009-020", 81, "PCS"],
  ["FG-1292", "Finished Goods", "C002-0006-000", 20, "PCS"],
  ["SPOT-1292", "WIP", "C002-0006-010", 14, "PCS"],
  ["PROD-1292", "WIP", "C002-0006-020", 66, "PCS"],
  ["NUT-M6", "Purchase Part", "MI-M06-N01", 205, "PCS"],
  ["PIN-1766", "Purchase Part", "C002-0007-000", 43, "PCS"],
  // Data sumber menyebut 0697/0698, sementara BOM aktif memakai 2706B/2707A.
  // Saldo simulasi dipetakan ke child BOM aktif supaya netting MRP dapat diaudit.
  ["SOURCE-0697-AS-BOM-2706B", "Purchase Part", "C002-0003-000", 24, "PCS"],
  ["SOURCE-0698-AS-BOM-2707A", "Purchase Part", "C002-0004-000", 33, "PCS"],
  ["MAT-1287", "Material", "SPHC-PO-2-145", 1.3772825, "KG"],
  ["MAT-1288", "Material", "SPHC-PO-2-145", 1.00166, "KG"],
  ["MAT-1289", "Material", "SPHC-PO-1.6-50", 0.202216, "KG"],
  ["MAT-1290", "Material", "SPHC-PO-1.6-75", 0.35796, "KG"],
  ["MAT-1291", "Material", "SPHC-PO-1.6-65", 0.6343428, "KG"],
  ["MAT-1292", "Material", "SPHC-PO-2-175", 10.489955, "KG"],
];

let token;
async function api(method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status}: ${payload.message || JSON.stringify(payload)}`);
  return payload;
}

(async () => {
  const login = await api("POST", "/auth/login", {
    identifier: process.env.DEFAULT_ADMIN_USERNAME || "admin",
    password: process.env.DEFAULT_ADMIN_PASSWORD || "admin123",
  });
  token = login.token;
  const warehouses = (await api("GET", "/inventory/warehouses?isActive=true&limit=200")).items || [];
  const warehouse = warehouses.find((row) => row.availableForProduction) || warehouses[0];
  if (!warehouse) throw new Error("Warehouse aktif tidak ditemukan.");

  const existing = (await api("GET", `/inventory/stock-movements?q=${encodeURIComponent(referenceNumber)}&limit=200`)).items || [];
  const existingKeys = new Set(existing.map((row) => String(row.notes || "").split("|OPENING|")[1]).filter(Boolean));
  const created = [];
  const skipped = [];
  for (const [key, stockType, itemCode, qty, uomCode] of movements) {
    if (existingKeys.has(key)) {
      skipped.push(key);
      continue;
    }
    const isMaterial = stockType === "Material";
    const result = await api("POST", "/inventory/stock-movements", {
      movementType: "IN",
      movementDate: "2026-07-31T12:00:00.000+07:00",
      transactionType: "OPENING_BALANCE",
      warehouseCode: warehouse.warehouseCode,
      stockType,
      ...(isMaterial ? { materialCode: itemCode } : { partCode: itemCode }),
      qty,
      uomCode,
      referenceType: "SIMULATION",
      referenceNumber,
      notes: `${marker}|OPENING|${key}`,
    });
    created.push({ key, movementNumber: result.items?.[0]?.movementNumber, qty, uomCode });
  }
  console.log(JSON.stringify({
    warehouseCode: warehouse.warehouseCode,
    expected: movements.length,
    created,
    skipped,
  }, null, 2));
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
