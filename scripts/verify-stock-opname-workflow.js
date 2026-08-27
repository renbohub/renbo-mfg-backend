"use strict";

const assert = require("assert");
const {
  submitStockOpnameRound,
  checkStockOpnameRound,
  startStockOpnameRecount,
} = require("../src/prisma/services/inventory/stockOpnameWorkflowService");

function fakeTx() {
  const state = { headerUpdates: [], roundUpdates: [], rounds: [], detailUpdates: [] };
  return {
    state,
    stockOpnameCountRound: {
      update: async ({ data }) => { state.roundUpdates.push(data); return data; },
      create: async ({ data }) => { const row = { id: "r" + (data.roundNo || 2), ...data }; state.rounds.push(row); return row; },
    },
    stockOpnameHeader: {
      update: async ({ data }) => { state.headerUpdates.push(data); return { id: "h1", ...data }; },
    },
    stockOpnameDetail: {
      updateMany: async ({ data }) => { state.detailUpdates.push(data); return { count: 2 }; },
    },
  };
}

(async () => {
  const details = [
    { id: "d1", isDeleted: false, systemQty: 100, actualQty: 100 },
    { id: "d2", isDeleted: false, systemQty: 20, actualQty: 18 },
  ];
  const tx = fakeTx();
  const submitted = await submitStockOpnameRound(tx, {
    header: { id: "h1", status: "COUNTING", currentRoundNo: 1, toleranceQty: 0, tolerancePercent: 0 },
    round: { id: "r1", roundNo: 1, status: "ACTIVE" },
    details,
    submittedBy: "counter-a",
  });
  assert.strictEqual(submitted.header.status, "WAITING_CHECK");
  assert.strictEqual(tx.state.roundUpdates[0].status, "SUBMITTED");
  assert.strictEqual(submitted.recountRequiredDetails.length, 1);

  await assert.rejects(() => checkStockOpnameRound(fakeTx(), {
    header: { id: "h1", status: "WAITING_CHECK", createdBy: "maker-a", submittedBy: "counter-a", currentRoundNo: 1, toleranceQty: 0, tolerancePercent: 0 },
    round: { id: "r1", roundNo: 1, status: "SUBMITTED" },
    details,
    currentCounters: ["counter-a"],
    checkedBy: "checker-a",
  }), /recount wajib/i);

  await assert.rejects(() => checkStockOpnameRound(fakeTx(), {
    header: { id: "h1", status: "WAITING_CHECK", createdBy: "maker-a", submittedBy: "counter-a", currentRoundNo: 2, toleranceQty: 0, tolerancePercent: 0 },
    round: { id: "r2", roundNo: 2, status: "SUBMITTED" },
    details,
    currentCounters: ["checker-a"],
    checkedBy: "checker-a",
    acceptanceReason: "hasil recount dikonfirmasi",
  }), /checker tidak boleh/i);

  const acceptedTx = fakeTx();
  const accepted = await checkStockOpnameRound(acceptedTx, {
    header: { id: "h1", status: "WAITING_CHECK", createdBy: "maker-a", submittedBy: "counter-b", currentRoundNo: 2, toleranceQty: 0, tolerancePercent: 0 },
    round: { id: "r2", roundNo: 2, status: "SUBMITTED" },
    details,
    currentCounters: ["counter-b"],
    checkedBy: "checker-a",
    acceptanceReason: "hasil recount dikonfirmasi",
  });
  assert.strictEqual(accepted.header.status, "WAITING_APPROVAL");

  const recountTx = fakeTx();
  const recount = await startStockOpnameRecount(recountTx, {
    header: { id: "h1", status: "WAITING_CHECK", currentRoundNo: 1 },
    round: { id: "r1", roundNo: 1, status: "SUBMITTED" },
    requestedBy: "checker-a",
    reason: "selisih melebihi toleransi",
  });
  assert.strictEqual(recount.round.roundNo, 2);
  assert.strictEqual(recount.header.status, "COUNTING");
  assert.strictEqual(recountTx.state.roundUpdates[0].status, "SUPERSEDED");
  assert.strictEqual(recountTx.state.detailUpdates[0].actualQty, null);

  console.log("Balanced Stock Opname workflow checks passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});