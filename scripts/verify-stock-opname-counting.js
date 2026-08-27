"use strict";

const assert = require("assert");
const {
  saveStockOpnameCountAttempt,
  startStockOpnameCounting,
} = require("../src/prisma/services/inventory/stockOpnameCountingService");

function attemptTx() {
  const state = {
    attempts: [],
    detail: { id: "d1", systemQty: 10, actualQty: null },
  };
  return {
    state,
    stockOpnameCountAttempt: {
      findFirst: async ({ where }) => state.attempts
        .filter((row) => row.countRoundId === where.countRoundId && row.stoDetailId === where.stoDetailId)
        .sort((a, b) => b.sequenceNo - a.sequenceNo)[0] || null,
      updateMany: async ({ where, data }) => {
        state.attempts.filter((row) =>
          row.countRoundId === where.countRoundId && row.stoDetailId === where.stoDetailId && row.isCurrent === where.isCurrent)
          .forEach((row) => Object.assign(row, data));
      },
      create: async ({ data }) => {
        const row = { id: "a" + (state.attempts.length + 1), ...data };
        state.attempts.push(row);
        return row;
      },
    },
    stockOpnameDetail: {
      update: async ({ data }) => {
        Object.assign(state.detail, data);
        return { ...state.detail };
      },
    },
  };
}

(async () => {
  const tx = attemptTx();
  const first = await saveStockOpnameCountAttempt(tx, {
    header: { id: "h1", status: "COUNTING" },
    round: { id: "r1", roundNo: 1, status: "ACTIVE" },
    detail: tx.state.detail,
    actualQty: 8,
    countedBy: "counter-a",
    reason: null,
  });
  assert.strictEqual(first.attempt.sequenceNo, 1);
  assert.strictEqual(first.detail.varianceQty, -2);
  assert.strictEqual(first.detail.varianceStatus, "SHORTAGE");
  assert.strictEqual(tx.state.attempts[0].isCurrent, true);

  await assert.rejects(() => saveStockOpnameCountAttempt(tx, {
    header: { id: "h1", status: "COUNTING" },
    round: { id: "r1", roundNo: 1, status: "ACTIVE" },
    detail: first.detail,
    actualQty: 7,
    countedBy: "counter-b",
  }), /sudah dihitung oleh counter-a/i);

  const correction = await saveStockOpnameCountAttempt(tx, {
    header: { id: "h1", status: "COUNTING" },
    round: { id: "r1", roundNo: 1, status: "ACTIVE" },
    detail: first.detail,
    actualQty: 9,
    countedBy: "counter-a",
    reason: "koreksi hitung",
  });
  assert.strictEqual(correction.attempt.sequenceNo, 2);
  assert.strictEqual(tx.state.attempts[0].isCurrent, false);
  assert.strictEqual(tx.state.attempts[1].isCurrent, true);
  assert.strictEqual(correction.detail.varianceQty, -1);

  const zero = await saveStockOpnameCountAttempt(tx, {
    header: { id: "h1", status: "COUNTING" },
    round: { id: "r1", roundNo: 1, status: "ACTIVE" },
    detail: correction.detail,
    actualQty: 0,
    countedBy: "counter-a",
  });
  assert.strictEqual(zero.detail.actualQty, 0);
  await assert.rejects(() => saveStockOpnameCountAttempt(tx, {
    header: { id: "h1", status: "COUNTING" },
    round: { id: "r1", roundNo: 1, status: "ACTIVE" },
    detail: zero.detail,
    actualQty: -1,
    countedBy: "counter-a",
  }), /Actual Qty harus berupa angka >= 0/);

  const startState = { detailUpdates: [], rounds: [], headerUpdate: null };
  const startTx = {
    stockOpnameDetail: {
      findFirst: async () => null,
      update: async ({ where, data }) => {
        startState.detailUpdates.push({ where, data });
        return { id: where.id, ...data };
      },
    },
    stockBalance: {
      findMany: async () => [{ id: "b1", qtyOnHand: 12 }, { id: "b2", qtyOnHand: 3 }],
    },
    stockOpnameCountRound: {
      create: async ({ data }) => {
        const row = { id: "r1", ...data };
        startState.rounds.push(row);
        return row;
      },
    },
    stockOpnameHeader: {
      update: async ({ data }) => {
        startState.headerUpdate = data;
        return { id: "h1", ...data };
      },
    },
  };
  const started = await startStockOpnameCounting(startTx, {
    id: "h1",
    stoNo: "STO-1",
    status: "DRAFT",
    details: [
      { id: "d1", stockBalanceId: "b1" },
      { id: "d2", stockBalanceId: "b2" },
    ],
  }, "creator-a");
  assert.strictEqual(startState.detailUpdates[0].data.systemQty, 12);
  assert.strictEqual(startState.detailUpdates[1].data.systemQty, 3);
  assert.strictEqual(startState.rounds[0].roundNo, 1);
  assert.strictEqual(startState.rounds[0].status, "ACTIVE");
  assert.strictEqual(startState.headerUpdate.status, "COUNTING");
  assert.strictEqual(startState.headerUpdate.inventoryFrozen, true);
  assert(started.snapshotAt instanceof Date);

  const recountTx = attemptTx();
  recountTx.stockOpnameCountAttempt.findFirst = async ({ where }) => {
    if (where.round) return { countedBy: "counter-a" };
    return null;
  };
  await assert.rejects(() => saveStockOpnameCountAttempt(recountTx, {
    header: { id: "h1", status: "COUNTING" },
    round: { id: "r2", roundNo: 2, status: "ACTIVE" },
    detail: recountTx.state.detail,
    actualQty: 10,
    countedBy: "counter-a",
  }), /berbeda dari ronde sebelumnya/i);
  console.log("Balanced Stock Opname counting service checks passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
