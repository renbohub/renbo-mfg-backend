/* eslint-disable no-console */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const base = `http://localhost:${process.env.PORT || 5017}/api`;
const marker = "SIM-BRACKET-COMP-AUG-2026";
const referenceNumber = `${marker}-OPENING-20260731`;
const materials = [
  ["MAT-1287", "SPHC-PO-2-145", 1.3772825],
  ["MAT-1288", "SPHC-PO-2-145", 1.00166],
  ["MAT-1289", "SPHC-PO-1.6-50", 0.202216],
  ["MAT-1290", "SPHC-PO-1.6-75", 0.35796],
  ["MAT-1291", "SPHC-PO-1.6-65", 0.6343428],
  ["MAT-1292", "SPHC-PO-2-175", 10.489955],
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
  for (const [key, materialCode, qty] of materials) {
    if (existingKeys.has(key)) {
      skipped.push(key);
      continue;
    }
    // materialId is the canonical reference and avoids losing the decimal dot
    // in materialCode inside the generic strict identifier middleware.
    const material = await api("GET", `/master-data/materials/${encodeURIComponent(materialCode)}`);
    const result = await api("POST", "/inventory/stock-movements", {
      movementType: "IN",
      movementDate: "2026-07-31T12:00:00.000+07:00",
      transactionType: "OPENING_BALANCE",
      warehouseCode: warehouse.warehouseCode,
      stockType: "Material",
      materialId: material.id,
      qty,
      uomCode: "KG",
      referenceType: "SIMULATION",
      referenceNumber,
      notes: `${marker}|OPENING|${key}`,
    });
    created.push({ key, materialCode, movementNumber: result.items?.[0]?.movementNumber, qty, uomCode: "KG" });
  }
  console.log(JSON.stringify({ warehouseCode: warehouse.warehouseCode, created, skipped }, null, 2));
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
