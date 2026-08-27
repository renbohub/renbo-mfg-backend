"use strict";

const assert = require("assert");
const {
  previewStockOpnameAdjustment,
  postStockOpnameAdjustment,
} = require("../src/prisma/services/inventory/stockOpnameAdjustmentService");

(async () => {
  const header = { id: "h1", stoNo: "STO-1", status: "APPROVED", notes: null };
  const conflictTx = {
    stockBalance: {
      findMany: async () => [{
        id: "b1", qtyOnHand: 10, qtyReserved: 8, qtyQC: 3, isDeleted: false,
      }],
    },
  };
  const conflict = await previewStockOpnameAdjustment(conflictTx, {
    header,
    details: [{
      id: "d1", stockBalanceId: "b1", systemQty: 10, actualQty: 9,
      partCode: "P-1", isDeleted: false,
    }],
  });
  assert.strictEqual(conflict.conflicts.length, 1);
  assert.strictEqual(conflict.conflicts[0].type, "RESERVATION_QC_CONFLICT");

  const state = { balances: [], movements: [], detailUpdates: [], header: null };
  const foundTx = {
    stockBalance: {
      findMany: async () => [],
      create: async ({ data }) => {
        const row = { id: "new-balance", qtyReserved: 0, qtyQC: 0, ...data };
        state.balances.push(row);
        return row;
      },
      update: async () => { throw new Error("existing balance must not be updated in found-stock test"); },
    },
    stockMovement: {
      create: async ({ data }) => { const row = { id: "m1", ...data }; state.movements.push(row); return row; },
    },
    stockOpnameDetail: {
      update: async ({ data }) => { state.detailUpdates.push(data); return data; },
    },
    stockOpnameHeader: {
      update: async ({ data }) => { state.header = { ...header, ...data }; return state.header; },
    },
  };
  const posted = await postStockOpnameAdjustment(foundTx, {
    header,
    details: [{
      id: "d-found", stockBalanceId: null, systemQty: 0, actualQty: 4, varianceQty: 4,
      warehouseCode: "WH-A", rackCode: "R-1", lotNumber: "L-1",
      materialId: "mat-1", materialCode: "RM-1", materialName: "Raw 1",
      stockType: "Material", uomCode: "KG", isUnexpected: true, isDeleted: false,
      reason: "ditemukan saat count",
    }],
    performedBy: "inventory-a",
    movementNumberFactory: async () => "ADJ-1",
    assertNotFrozen: async () => {},
  });
  assert.strictEqual(state.balances[0].qtyOnHand, 4);
  assert.strictEqual(state.balances[0].qtyAvailable, 4);
  assert.strictEqual(state.movements[0].deltaQty, 4);
  assert.strictEqual(state.detailUpdates[0].stockBalanceId, "new-balance");
  assert.strictEqual(posted.header.status, "ADJUSTED");
  assert.strictEqual(posted.header.inventoryFrozen, false);

  console.log("Balanced Stock Opname adjustment checks passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});