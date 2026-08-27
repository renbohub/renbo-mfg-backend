"use strict";

const assert = require("assert");
const {
  assertStockIdentityNotFrozen,
} = require("../src/prisma/controllers/inventory/utils/stockOpnameFreezeGuard");

const cycleScope = {
  version: 1,
  countMode: "CYCLE",
  stoType: "MATERIAL",
  warehouseCode: "WH-001",
  stockTypes: ["Material"],
  rackCodes: ["R-01"],
  lotNumbers: [],
  stockBalanceIds: [],
  includeZeroBalance: true,
};
const fakeTx = {
  stockOpnameHeader: {
    findMany: async () => [{
      stoNo: "STO-20260825-0001",
      status: "COUNTING",
      scopeJson: cycleScope,
    }],
  },
};

(async () => {
  await assert.doesNotReject(() => assertStockIdentityNotFrozen(fakeTx, {
    warehouseCode: "WH-001",
    stockType: "WIP",
    rackCode: "R-02",
    lotNumber: null,
  }));
  await assert.doesNotReject(() => assertStockIdentityNotFrozen(fakeTx, {
    warehouseCode: "WH-001",
    stockType: "Material",
    rackCode: "R-02",
    lotNumber: null,
  }));
  await assert.rejects(() => assertStockIdentityNotFrozen(fakeTx, {
    warehouseCode: "WH-001",
    stockType: "Material",
    rackCode: "R-01",
    lotNumber: null,
  }), /frozen oleh STO-20260825-0001/);

  const legacyTx = {
    stockOpnameHeader: {
      findMany: async () => [{ stoNo: "STO-LEGACY", status: "COUNTING", scopeJson: null }],
    },
  };
  await assert.rejects(() => assertStockIdentityNotFrozen(legacyTx, {
    warehouseCode: "WH-001",
    stockType: "Finished Goods",
    rackCode: "FG-01",
  }), /frozen oleh STO-LEGACY/);

  const allowTx = {
    stockOpnameHeader: {
      findMany: async ({ where }) => {
        assert.deepStrictEqual(where.stoNo, { not: "STO-20260825-0001" });
        return [];
      },
    },
  };
  await assert.doesNotReject(() => assertStockIdentityNotFrozen(allowTx, {
    warehouseCode: "WH-001",
    stockType: "Material",
    rackCode: "R-01",
  }, { allowStoNo: "STO-20260825-0001" }));

  console.log("Balanced Stock Opname identity freeze checks passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});