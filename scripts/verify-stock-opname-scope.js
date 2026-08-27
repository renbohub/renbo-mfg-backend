"use strict";

const assert = require("assert");
const { resolveStockOpnameScope } = require("../src/prisma/services/inventory/stockOpnameScopeService");

function createDb(balances, { warehouse = true, purchasePartCodes = [] } = {}) {
  return {
    lastBalanceWhere: null,
    warehouse: {
      findFirst: async () => warehouse ? { warehouseCode: "WH-001" } : null,
    },
    part: {
      findMany: async () => purchasePartCodes.map((partCode) => ({ partCode })),
    },
    stockBalance: {
      findMany: async function ({ where }) {
        this.owner.lastBalanceWhere = where;
        return balances;
      },
      owner: null,
    },
  };
}

(async () => {
  const balances = [
    { id: "b1", warehouseCode: "WH-001", stockType: "WIP", rackCode: "R-01", lotNumber: null, qtyOnHand: 10, qtyReserved: 2, qtyQC: 1, qtyAvailable: 7 },
    { id: "b2", warehouseCode: "WH-001", stockType: "WP", rackCode: "R-02", lotNumber: "LOT-2", qtyOnHand: 5, qtyReserved: 0, qtyQC: 0, qtyAvailable: 5 },
    { id: "b3", warehouseCode: "WH-001", stockType: "WIP", rackCode: null, lotNumber: null, qtyOnHand: 0, qtyReserved: 0, qtyQC: 0, qtyAvailable: 0 },
  ];
  const db = createDb(balances);
  db.stockBalance.owner = db;
  const preview = await resolveStockOpnameScope(db, {
    countMode: "CYCLE",
    stoType: "WIP",
    warehouseCode: "WH-001",
    stockTypes: ["WIP", "WP"],
    rackCodes: ["R-01", "R-02"],
    includeZeroBalance: true,
  }, { includeBalances: true });

  assert.deepStrictEqual(db.lastBalanceWhere.rackCode, { in: ["R-01", "R-02"] });
  assert.deepStrictEqual(db.lastBalanceWhere.stockType, { in: ["WIP", "WP"] });
  assert.strictEqual(preview.summary.lineCount, 3);
  assert.strictEqual(preview.summary.qtyOnHand, 15);
  assert.strictEqual(preview.summary.qtyReserved, 2);
  assert.strictEqual(preview.summary.qtyQC, 1);
  assert.strictEqual(preview.summary.qtyAvailable, 12);
  assert.strictEqual(preview.summary.missingRackCount, 1);
  assert.strictEqual(preview.summary.missingLotCount, 2);
  assert(preview.warnings.some((message) => message.includes("tanpa lot")));
  assert.deepStrictEqual(preview.stockTypeBreakdown, [
    { stockType: "WIP", lineCount: 2, qtyOnHand: 10 },
    { stockType: "WP", lineCount: 1, qtyOnHand: 5 },
  ]);
  assert.strictEqual(preview.balances.length, 3);

  const noZeroDb = createDb([]);
  noZeroDb.stockBalance.owner = noZeroDb;
  await resolveStockOpnameScope(noZeroDb, {
    countMode: "FULL",
    stoType: "FG",
    warehouseCode: "WH-001",
    includeZeroBalance: false,
  });
  assert.deepStrictEqual(noZeroDb.lastBalanceWhere.qtyOnHand, { not: 0 });

  const materialDb = createDb([], { purchasePartCodes: ["P-001"] });
  materialDb.stockBalance.owner = materialDb;
  await resolveStockOpnameScope(materialDb, {
    countMode: "FULL",
    stoType: "MATERIAL",
    warehouseCode: "WH-001",
    stockTypes: ["Purchase Part"],
  });
  assert.deepStrictEqual(materialDb.lastBalanceWhere.OR, [
    { stockType: "Purchase Part" },
    { stockType: "Part", partCode: { in: ["P-001"] } },
  ]);

  const missingWarehouseDb = createDb([], { warehouse: false });
  missingWarehouseDb.stockBalance.owner = missingWarehouseDb;
  await assert.rejects(
    () => resolveStockOpnameScope(missingWarehouseDb, { countMode: "FULL", stoType: "FG", warehouseCode: "WH-X" }),
    /Warehouse tidak ditemukan atau tidak aktif/,
  );

  console.log("Balanced Stock Opname scope checks passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});