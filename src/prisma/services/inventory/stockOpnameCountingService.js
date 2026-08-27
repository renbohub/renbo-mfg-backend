"use strict";

const {
  calculateStockOpnameVariance,
} = require("./stockOpnameDomain");

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

async function startStockOpnameCounting(tx, header, performedBy) {
  if (!header || header.status !== "DRAFT") {
    fail("Hanya Stock Opname DRAFT yang dapat mulai counting.", 409);
  }
  const balanceIds = (header.details || []).map((detail) => detail.stockBalanceId).filter(Boolean);
  if (!balanceIds.length) fail("Stock Opname tidak memiliki balance untuk dihitung.", 409);

  const conflict = await tx.stockOpnameDetail.findFirst({
    where: {
      stockBalanceId: { in: balanceIds },
      isDeleted: false,
      header: {
        isDeleted: false,
        inventoryFrozen: true,
        status: { in: ["COUNTING", "WAITING_CHECK", "WAITING_APPROVAL", "APPROVED"] },
        stoNo: { not: header.stoNo },
      },
    },
    select: { header: { select: { stoNo: true } } },
  });
  if (conflict) fail("Scope stock sudah dibekukan oleh " + conflict.header.stoNo + ".", 409);

  const balances = await tx.stockBalance.findMany({
    where: { id: { in: balanceIds }, isDeleted: false },
    select: { id: true, qtyOnHand: true },
  });
  const qtyById = new Map(balances.map((balance) => [balance.id, Number(balance.qtyOnHand || 0)]));
  if (qtyById.size !== balanceIds.length) {
    fail("Sebagian stock balance sudah tidak tersedia. Buat ulang dokumen opname.", 409);
  }

  await Promise.all((header.details || []).map((detail) =>
    tx.stockOpnameDetail.update({
      where: { id: detail.id },
      data: {
        systemQty: qtyById.get(detail.stockBalanceId) || 0,
        actualQty: null,
        varianceQty: 0,
        varianceStatus: "MATCH",
        reason: null,
        countedBy: null,
        countedAt: null,
      },
    })));

  const snapshotAt = new Date();
  const round = await tx.stockOpnameCountRound.create({
    data: {
      stoHeaderId: header.id,
      roundNo: 1,
      status: "ACTIVE",
      startedBy: performedBy,
      startedAt: snapshotAt,
    },
  });
  const updated = await tx.stockOpnameHeader.update({
    where: { id: header.id },
    data: {
      status: "COUNTING",
      inventoryFrozen: true,
      snapshotAt,
      currentRoundNo: 1,
      submittedBy: null,
      submittedAt: null,
    },
  });
  return { ...updated, currentRound: round };
}

async function saveStockOpnameCountAttempt(tx, {
  header,
  round,
  detail,
  actualQty,
  countedBy,
  reason = null,
}) {
  if (!header || header.status !== "COUNTING") fail("Stock Opname tidak sedang COUNTING.", 409);
  if (!round || round.status !== "ACTIVE") fail("Count round tidak aktif.", 409);
  if (!detail || detail.isDeleted) fail("Detail Stock Opname tidak ditemukan.", 404);
  const actual = Number(actualQty);
  if (!Number.isFinite(actual) || actual < 0) fail("Actual Qty harus berupa angka >= 0.");
  const counter = String(countedBy || "").trim();
  if (!counter) fail("Nama petugas hitung wajib diisi.");

  if (Number(round.roundNo) > 1) {
    const priorRoundAttempt = await tx.stockOpnameCountAttempt.findFirst({
      where: {
        stoDetailId: detail.id,
        isCurrent: true,
        round: {
          stoHeaderId: header.id,
          roundNo: Number(round.roundNo) - 1,
        },
      },
      select: { countedBy: true },
    });
    if (priorRoundAttempt
      && String(priorRoundAttempt.countedBy || "").trim().toLowerCase() === counter.toLowerCase()) {
      fail("Petugas recount harus berbeda dari ronde sebelumnya.", 409);
    }
  }
  const previous = await tx.stockOpnameCountAttempt.findFirst({
    where: {
      countRoundId: round.id,
      stoDetailId: detail.id,
    },
    orderBy: { sequenceNo: "desc" },
    select: { id: true, sequenceNo: true, isCurrent: true, countedBy: true },
  });
  if (previous?.isCurrent
    && String(previous.countedBy || "").trim().toLowerCase() !== counter.toLowerCase()) {
    fail(`Item ini sudah dihitung oleh ${previous.countedBy}. Refresh daftar dan lanjutkan item lain.`, 409);
  }
  if (previous?.isCurrent) {
    await tx.stockOpnameCountAttempt.updateMany({
      where: {
        countRoundId: round.id,
        stoDetailId: detail.id,
        isCurrent: true,
      },
      data: { isCurrent: false },
    });
  }

  const countedAt = new Date();
  const attempt = await tx.stockOpnameCountAttempt.create({
    data: {
      countRoundId: round.id,
      stoDetailId: detail.id,
      sequenceNo: Number(previous?.sequenceNo || 0) + 1,
      actualQty: actual,
      reason: String(reason || "").trim() || null,
      countedBy: counter,
      countedAt,
      isCurrent: true,
    },
  });
  const calculated = calculateStockOpnameVariance(detail.systemQty, actual);
  const updatedDetail = await tx.stockOpnameDetail.update({
    where: { id: detail.id },
    data: {
      actualQty: actual,
      varianceQty: calculated.varianceQty,
      varianceStatus: calculated.varianceStatus,
      reason: String(reason || "").trim() || null,
      countedBy: counter,
      countedAt,
    },
  });
  return { attempt, detail: updatedDetail };
}

module.exports = {
  startStockOpnameCounting,
  saveStockOpnameCountAttempt,
};
