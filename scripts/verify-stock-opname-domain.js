"use strict";

const assert = require("assert");
const domain = require("../src/prisma/services/inventory/stockOpnameDomain");

assert.deepStrictEqual(domain.STO_STOCK_TYPES.WIP, ["WIP", "WP", "Semi-Finished"]);

const cycle = domain.normalizeStockOpnameScope({
  countMode: "cycle",
  stoType: "material",
  warehouseCode: " WH-001 ",
  stockTypes: ["Material", "Material"],
  rackCodes: ["R-01", "R-01"],
  lotNumbers: [],
  stockBalanceIds: [],
  includeZeroBalance: true,
});
assert.deepStrictEqual(cycle, {
  version: 1,
  countMode: "CYCLE",
  stoType: "MATERIAL",
  warehouseCode: "WH-001",
  stockTypes: ["Material"],
  rackCodes: ["R-01"],
  lotNumbers: [],
  stockBalanceIds: [],
  includeZeroBalance: true,
});
assert.throws(
  () => domain.normalizeStockOpnameScope({ countMode: "CYCLE", stoType: "FG", warehouseCode: "WH-001" }),
  /Cycle Count wajib memilih minimal rack, lot, atau stock balance/,
);
assert.throws(
  () => domain.normalizeStockOpnameScope({ countMode: "FULL", stoType: "WIP", warehouseCode: "WH-001", stockTypes: ["Material"] }),
  /tidak sesuai dengan STO WIP/,
);
assert.strictEqual(domain.stockIdentityMatchesScope(
  { warehouseCode: "WH-001", stockType: "Material", rackCode: "R-01", lotNumber: null },
  cycle,
), true);
assert.strictEqual(domain.stockIdentityMatchesScope(
  { warehouseCode: "WH-001", stockType: "Material", rackCode: "R-02", lotNumber: null },
  cycle,
), false);
assert.deepStrictEqual(domain.calculateStockOpnameVariance(10, 8), { varianceQty: -2, varianceStatus: "SHORTAGE" });
assert.deepStrictEqual(domain.calculateStockOpnameVariance(10, 10), { varianceQty: 0, varianceStatus: "MATCH" });
assert.strictEqual(domain.requiresStockOpnameRecount({ systemQty: 10, actualQty: 9, toleranceQty: 2, tolerancePercent: 20 }), false);
assert.strictEqual(domain.requiresStockOpnameRecount({ systemQty: 10, actualQty: 7, toleranceQty: 2, tolerancePercent: 20 }), true);
assert.strictEqual(domain.requiresStockOpnameRecount({ systemQty: 0, actualQty: 1, toleranceQty: 0, tolerancePercent: 0 }), true);
assert.deepStrictEqual(domain.evaluateStockOpnameAdjustment({ actualQty: 8, qtyReserved: 5, qtyQC: 2 }), {
  conflict: false,
  committedQty: 7,
  projectedAvailableQty: 1,
});
assert.deepStrictEqual(domain.evaluateStockOpnameAdjustment({ actualQty: 6, qtyReserved: 5, qtyQC: 2 }), {
  conflict: true,
  committedQty: 7,
  projectedAvailableQty: -1,
});

console.log("Balanced Stock Opname domain checks passed");