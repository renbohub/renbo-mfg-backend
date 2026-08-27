"use strict";

const assert = require("assert");
const { createInventoryCapabilityDefinitions } = require("../src/prisma/services/ai/capabilities/inventoryCapabilities");

const stockRows = [
  { id: "s1", partCode: "NUT-M6", partName: "NUT M6", uomCode: "PCS", warehouseCode: "WH-01", rackCode: "A-01", lotNumber: "LOT-1", stockType: "Purchase Part", qtyOnHand: 100.4, qtyReserved: 30.2, qtyAvailable: 70.2, warehouse: { warehouseName: "Main" } },
  { id: "s2", partCode: "NUT-M6", partName: "NUT M6", uomCode: "PCS", warehouseCode: "WIP-01", rackCode: "LINE-1", lotNumber: "LOT-2", stockType: "WIP", qtyOnHand: 51.2, qtyReserved: 5.1, qtyAvailable: 46.1, warehouse: { warehouseName: "WIP" } },
  { id: "s3", materialCode: "SPHC-2.0", materialName: "SPHC", uomCode: "KG", warehouseCode: "WH-01", rackCode: "RM", lotNumber: "COIL-1", stockType: "Material", qtyOnHand: 12.345, qtyReserved: 2.111, qtyAvailable: 10.234, warehouse: { warehouseName: "Main" }, purchaseCost: 999, supplierSecret: "hidden" },
];

const reservations = [{ id: "r1", reservationNumber: "RSV-001", partCode: "NUT-M6", qtyReserved: 30, qtyReleased: 5, status: "Active", referenceType: "MRP", referenceNumber: "MRP-01", stockBalance: stockRows[0] }];
const movements = [{ id: "m1", movementNumber: "MOV-001", movementDate: new Date("2026-09-01"), movementType: "Issue", qty: 10, referenceType: "MO", referenceNumber: "MO-01", stockBalanceId: "s1" }];

const calls = [];
const prisma = {
  stockBalance: { findMany: async (args) => { calls.push(args); return stockRows; } },
  stockReservation: { findMany: async () => reservations },
  stockMovement: { findMany: async () => movements },
  part: { findMany: async () => [{ partCode: "NUT-M6", partName: "NUT M6", safetyStock: 200, uomCode: "PCS" }] },
};

(async () => {
  const definitions = createInventoryCapabilityDefinitions();
  assert.deepStrictEqual(definitions.map((item) => item.code), ["inventory.get_stock_summary", "inventory.trace_stock_usage", "inventory.get_stock_risk"]);
  definitions.forEach((item) => assert.ok(["READ", "ANALYZE"].includes(item.operationClass)));

  const summary = await definitions[0].execute({ prisma, input: { query: "NUT-M6", limit: 100 } });
  assert.strictEqual(summary.items[0].warehouseQty, 100);
  assert.strictEqual(summary.items[0].wipQty, 51);
  assert.strictEqual(summary.items[0].reservedQty, 35);
  assert.strictEqual(summary.items[0].freeQty, 116);
  assert.strictEqual(summary.items[1].warehouseQty, 12.35);
  assert.strictEqual(summary.items[1].freeQty, 10.23);
  assert.ok(summary.items[0].sources[0].href.includes("/modules/inventory/stock-balances/"));
  assert.ok(summary.items.length <= 100);
  assert.ok(calls[0].where.isDeleted === false);
  assert.strictEqual(calls[0].where.warehouse.availableForMrp, true);
  assert.ok(!JSON.stringify(summary).match(/purchaseCost|secret|credential/i));

  const trace = await definitions[1].execute({ prisma, input: { partCode: "NUT-M6" } });
  assert.strictEqual(trace.reservations[0].openQty, 25);
  assert.ok(trace.sources.some((source) => source.entityType === "STOCK_RESERVATION"));

  const risk = await definitions[2].execute({ prisma, input: { limit: 100 } });
  assert.strictEqual(risk.items[0].partCode, "NUT-M6");
  assert.strictEqual(risk.items[0].shortageQty, 84);
  assert.ok(risk.sources.length > 0);

  console.log("AI inventory capabilities: OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
