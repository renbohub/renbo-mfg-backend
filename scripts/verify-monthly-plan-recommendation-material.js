"use strict";

const assert = require("assert");
const {
  buildMachineWorkCenterMap,
  buildRecommendationMaterial,
  recommendationPrimaryInput,
  summarizeChildFgConversionHistory,
} = require("../src/prisma/services/planning/capacityPlanningService");

const centerMap = buildMachineWorkCenterMap([
  { id: "wc-insp", machines: [{ machine: { id: "machine-1" } }] },
]);
assert.deepStrictEqual(centerMap.get("machine-1"), { workCenterId: "wc-insp", matrixRowKey: "WC:wc-insp" });

const wipSpot = { id: "part-spot", partCode: "WIP-SPOT", itemType: "WIP" };
const rawNut = { id: "part-nut", partCode: "NUT-M6", itemType: "RAW_MATERIAL" };
const weld = { id: "part-weld", partCode: "WIP-WELD", itemType: "WIP" };
const route = {
  id: "route-weld",
  mbomDetail: {
    part: weld,
    children: [
      { qty: 1, part: wipSpot },
      { qty: 2, part: rawNut },
    ],
  },
};

const primary = recommendationPrimaryInput(route);
assert.strictEqual(primary.partCode, "WIP-SPOT", "WIP predecessor must be the primary monthly-plan material gate");
assert.strictEqual(primary.qtyPerOutput, 1);

const material = buildRecommendationMaterial({
  stockRows: [
    { partCode: "WIP-SPOT", _sum: { qtyAvailable: 191 } },
    { partCode: "NUT-M6", _sum: { qtyAvailable: 500 } },
  ],
  allocations: [
    {
      id: "allocation-spot",
      plannedQty: 60,
      expectedReturnQty: null,
      scheduleDate: new Date("2026-09-01T00:00:00.000Z"),
      vendorReturnDate: null,
      mbomProcess: {
        mbomDetail: { part: wipSpot, children: [] },
      },
    },
    {
      id: "allocation-weld",
      plannedQty: 40,
      scheduleDate: new Date("2026-09-03T00:00:00.000Z"),
      vendorReturnDate: null,
      mbomProcess: route,
    },
  ],
});

assert.deepStrictEqual(material.openingStock, { "NUT-M6": 500, "WIP-SPOT": 191 });
assert.deepStrictEqual(
  material.receipts.map((row) => ({ partCode: row.partCode, date: row.date, qty: row.qty })),
  [
    { partCode: "WIP-SPOT", date: "2026-09-02", qty: 60 },
    { partCode: "WIP-WELD", date: "2026-09-04", qty: 40 },
  ],
  "scheduled output must become available on D+1",
);
assert.deepStrictEqual(
  material.consumptions.map((row) => ({ partCode: row.partCode, date: row.date, qty: row.qty })),
  [
    { partCode: "NUT-M6", date: "2026-09-03", qty: 80 },
    { partCode: "WIP-SPOT", date: "2026-09-03", qty: 40 },
  ],
  "official downstream allocation must reserve each BOM input exactly once",
);

const childFgMaterial = buildRecommendationMaterial({
  stockRows: [
    { partCode: "CHILD-FINAL-WIP", _sum: { qtyAvailable: 815 } },
    { partCode: "CHILD-FG", _sum: { qtyAvailable: 0 } },
  ],
  childFgReceiptLines: [
    {
      id: "receipt-phase-1",
      planNumber: "MPP-202609-001",
      lineNumber: 99,
      partCode: "CHILD-FG",
      qtyPlanned: 40,
      requiredDate: new Date("2026-09-08T00:00:00.000Z"),
    },
  ],
  childFgFinalWipByFg: { "CHILD-FG": "CHILD-FINAL-WIP" },
  childFgConvertedQtyByReceiptLine: {},
  childFgLegacyConvertedQtyByPlanPart: {},
});

assert.strictEqual(
  childFgMaterial.openingStock["CHILD-FINAL-WIP"],
  775,
  "projected child-FG conversion must reserve final WIP so it cannot be used twice",
);
assert.deepStrictEqual(
  childFgMaterial.receipts.map((row) => ({
    partCode: row.partCode,
    date: row.date,
    qty: row.qty,
    sourceType: row.sourceType,
    receiptLineId: row.receiptLineId,
  })),
  [
    {
      partCode: "CHILD-FG",
      date: "0000-01-01",
      qty: 40,
      sourceType: "PROJECTED_CHILD_FG_RECEIPT",
      receiptLineId: "receipt-phase-1",
    },
  ],
  "authorized final WIP must be visible to recommendation as child-FG supply without mutating inventory",
);

assert.deepStrictEqual(
  summarizeChildFgConversionHistory([
    {
      partCode: "CHILD-FG",
      qty: 12,
      notes: "[CHILD-FG-RECEIPT:MPP-202609-001:receipt-phase-1:CHILD-FG] receive",
    },
    {
      partCode: "CHILD-FG",
      qty: 8,
      notes: "[CHILD-FG-RECEIPT:MPP-202609-001:CHILD-FG] receive; MPP line 99",
    },
  ]),
  {
    convertedQtyByReceiptLine: { "receipt-phase-1": 12 },
    legacyConvertedQtyByPlanPart: { "MPP-202609-001|CHILD-FG": 8 },
  },
  "planning must subtract both phase-scoped and legacy child-FG receipt history before projecting supply",
);

console.log("Monthly plan recommendation material snapshot contract passed.");
