"use strict";

const { requiresStockOpnameRecount } = require("./stockOpnameDomain");

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

const normalizeActor = (value) => String(value || "").trim().toLowerCase();

function activeDetails(details) {
  return (Array.isArray(details) ? details : []).filter((detail) => !detail.isDeleted);
}

function recountRequiredDetails(header, details) {
  return activeDetails(details).filter((detail) => requiresStockOpnameRecount({
    systemQty: detail.systemQty,
    actualQty: detail.actualQty,
    toleranceQty: header.toleranceQty,
    tolerancePercent: header.tolerancePercent,
  }));
}

async function submitStockOpnameRound(tx, {
  header,
  round,
  details,
  submittedBy,
}) {
  if (!header || header.status !== "COUNTING") fail("Stock Opname tidak sedang COUNTING.", 409);
  if (!round || round.status !== "ACTIVE" || round.roundNo !== header.currentRoundNo) {
    fail("Count round aktif tidak valid.", 409);
  }
  const rows = activeDetails(details);
  if (!rows.length) fail("Stock Opname tidak memiliki detail aktif.", 409);
  if (rows.some((detail) => detail.actualQty == null)) {
    fail("Semua detail harus dihitung sebelum diajukan.", 409);
  }
  const actor = String(submittedBy || "").trim();
  if (!actor) fail("Petugas submit wajib diketahui.", 400);
  const submittedAt = new Date();
  await tx.stockOpnameCountRound.update({
    where: { id: round.id },
    data: { status: "SUBMITTED", submittedBy: actor, submittedAt },
  });
  const updated = await tx.stockOpnameHeader.update({
    where: { id: header.id },
    data: {
      status: "WAITING_CHECK",
      submittedBy: actor,
      submittedAt,
      checkerBy: null,
      checkerApprovedAt: null,
    },
  });
  return {
    header: updated,
    recountRequiredDetails: recountRequiredDetails(header, rows),
  };
}

async function checkStockOpnameRound(tx, {
  header,
  round,
  details,
  currentCounters = [],
  checkedBy,
  acceptanceReason,
}) {
  if (!header || header.status !== "WAITING_CHECK") fail("Stock Opname tidak sedang menunggu checker.", 409);
  if (!round || round.status !== "SUBMITTED" || round.roundNo !== header.currentRoundNo) {
    fail("Count round submitted tidak valid.", 409);
  }
  const checker = String(checkedBy || "").trim();
  if (!checker) fail("Checker wajib diketahui.", 400);
  const checkerKey = normalizeActor(checker);
  const forbidden = [header.createdBy, header.submittedBy, ...currentCounters]
    .map(normalizeActor)
    .filter(Boolean);
  if (checkerKey !== "system" && forbidden.includes(checkerKey)) {
    fail("Checker tidak boleh menjadi maker, submitter, atau penghitung pada ronde aktif.", 409);
  }
  const varianceRows = recountRequiredDetails(header, details);
  if (varianceRows.length && Number(round.roundNo) < 2) {
    fail("Selisih melebihi toleransi; recount wajib dilakukan sebelum approval.", 409);
  }
  const reason = String(acceptanceReason || "").trim();
  if (varianceRows.length && !reason) {
    fail("Alasan penerimaan selisih setelah recount wajib diisi.", 400);
  }
  const checkedAt = new Date();
  const data = {
    status: "WAITING_APPROVAL",
    checkerBy: checker,
    checkerApprovedAt: checkedAt,
  };
  if (reason) {
    data.notes = [header.notes, "CHECKER ACCEPTANCE " + checkedAt.toISOString() + " oleh " + checker + ": " + reason]
      .filter(Boolean)
      .join("\n");
  }
  const updated = await tx.stockOpnameHeader.update({ where: { id: header.id }, data });
  return { header: updated, recountRequiredDetails: varianceRows };
}

async function startStockOpnameRecount(tx, {
  header,
  round,
  requestedBy,
  reason,
}) {
  if (!header || !["WAITING_CHECK", "WAITING_APPROVAL", "APPROVED"].includes(header.status)) {
    fail("Status Stock Opname tidak dapat diminta recount.", 409);
  }
  if (!round || round.roundNo !== header.currentRoundNo || !["SUBMITTED", "ACTIVE"].includes(round.status)) {
    fail("Count round terakhir tidak valid.", 409);
  }
  const requestReason = String(reason || "").trim();
  if (!requestReason) fail("Alasan recount wajib diisi.");
  const requester = String(requestedBy || "").trim();
  const nextRoundNo = Number(round.roundNo) + 1;
  await tx.stockOpnameCountRound.update({
    where: { id: round.id },
    data: { status: "SUPERSEDED", requestReason, requestedBy: requester || null },
  });
  const nextRound = await tx.stockOpnameCountRound.create({
    data: {
      stoHeaderId: header.id,
      roundNo: nextRoundNo,
      status: "ACTIVE",
      requestReason,
      requestedBy: requester || null,
      startedBy: requester || null,
      startedAt: new Date(),
    },
  });
  await tx.stockOpnameDetail.updateMany({
    where: { stoHeaderId: header.id, isDeleted: false },
    data: {
      actualQty: null,
      varianceQty: 0,
      varianceStatus: "MATCH",
      reason: null,
      countedBy: null,
      countedAt: null,
    },
  });
  const note = [header.notes, "RECOUNT " + new Date().toISOString() + " oleh " + (requester || "system") + ": " + requestReason]
    .filter(Boolean)
    .join("\n");
  const updated = await tx.stockOpnameHeader.update({
    where: { id: header.id },
    data: {
      status: "COUNTING",
      currentRoundNo: nextRoundNo,
      notes: note,
      submittedBy: null,
      submittedAt: null,
      checkerBy: null,
      checkerApprovedAt: null,
      approvedBy: null,
      approvedAt: null,
    },
  });
  return { header: updated, round: nextRound };
}

module.exports = {
  submitStockOpnameRound,
  checkStockOpnameRound,
  startStockOpnameRecount,
  recountRequiredDetails,
};