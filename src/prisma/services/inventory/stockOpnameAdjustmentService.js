"use strict";

const { evaluateStockOpnameAdjustment } = require("./stockOpnameDomain");
const { generateMovementNumber } = require("../../utils/movementNumberGenerator");
const { assertStockBalanceNotFrozen } = require("../../controllers/inventory/utils/stockOpnameFreezeGuard");

function fail(message, statusCode = 400, conflicts = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (conflicts) error.conflicts = conflicts;
  throw error;
}

const activeVarianceDetails = (details) => (Array.isArray(details) ? details : [])
  .filter((detail) => !detail.isDeleted && Number(detail.varianceQty ?? (Number(detail.actualQty || 0) - Number(detail.systemQty || 0))) !== 0);

function detailLabel(detail) {
  return detail.materialCode || detail.partCode || detail.partNumber || detail.description || detail.id;
}

async function previewStockOpnameAdjustment(tx, { header, details }) {
  if (!header || header.status !== "APPROVED") fail("Hanya Stock Opname APPROVED yang dapat diposting.", 409);
  const rows = activeVarianceDetails(details);
  const balanceIds = rows.map((detail) => detail.stockBalanceId).filter(Boolean);
  const balances = balanceIds.length
    ? await tx.stockBalance.findMany({ where: { id: { in: balanceIds } } })
    : [];
  const byId = new Map(balances.map((balance) => [balance.id, balance]));
  const conflicts = [];
  const lines = rows.map((detail) => {
    if (!detail.stockBalanceId) {
      if (!detail.isUnexpected) {
        conflicts.push({
          detailId: detail.id,
          item: detailLabel(detail),
          type: "MISSING_STOCK_BALANCE",
          message: "Detail expected tidak memiliki stock balance.",
        });
      }
      return { detail, balance: null, foundStock: Boolean(detail.isUnexpected) };
    }
    const balance = byId.get(detail.stockBalanceId);
    if (!balance || balance.isDeleted) {
      conflicts.push({
        detailId: detail.id,
        item: detailLabel(detail),
        type: "STOCK_BALANCE_NOT_FOUND",
        message: "Stock balance tidak ditemukan atau sudah dihapus.",
      });
      return { detail, balance: null, foundStock: false };
    }
    const before = Number(balance.qtyOnHand || 0);
    if (Math.abs(before - Number(detail.systemQty || 0)) > 1e-9) {
      conflicts.push({
        detailId: detail.id,
        item: detailLabel(detail),
        type: "BALANCE_CHANGED_AFTER_FREEZE",
        systemQty: Number(detail.systemQty || 0),
        currentQty: before,
        message: "Saldo berubah setelah freeze; recount wajib dilakukan.",
      });
    }
    const commitment = evaluateStockOpnameAdjustment({
      actualQty: detail.actualQty,
      qtyReserved: balance.qtyReserved,
      qtyQC: balance.qtyQC,
    });
    if (commitment.conflict) {
      conflicts.push({
        detailId: detail.id,
        item: detailLabel(detail),
        type: "RESERVATION_QC_CONFLICT",
        actualQty: Number(detail.actualQty || 0),
        reservedQty: Number(balance.qtyReserved || 0),
        qcQty: Number(balance.qtyQC || 0),
        committedQty: commitment.committedQty,
        message: "Actual stock lebih kecil dari Reserved + QC.",
      });
    }
    return { detail, balance, foundStock: false, commitment };
  });
  return { lines, conflicts };
}

function identityData(detail) {
  return {
    warehouseCode: detail.warehouseCode,
    rackCode: detail.rackCode || null,
    lotNumber: detail.lotNumber || null,
    partCode: detail.partCode || null,
    partNumber: detail.partNumber || null,
    partName: detail.partName || null,
    materialId: detail.materialId || null,
    materialCode: detail.materialCode || null,
    materialName: detail.materialName || null,
    materialType: detail.materialType || null,
    productId: detail.productId || null,
    description: detail.description || null,
    spec: detail.spec || null,
    thickness: detail.thickness ?? null,
    width: detail.width ?? null,
    CSP: detail.CSP || null,
    uomCode: detail.uomCode || null,
    stockType: detail.stockType || null,
  };
}

async function postStockOpnameAdjustment(tx, {
  header,
  details,
  performedBy,
  movementNumberFactory = (db) => generateMovementNumber("ADJUSTMENT", db),
  assertNotFrozen = (db, balanceId, options) => assertStockBalanceNotFrozen(db, balanceId, options),
}) {
  const preview = await previewStockOpnameAdjustment(tx, { header, details });
  if (preview.conflicts.length) {
    fail("Stock Opname memiliki conflict yang harus diselesaikan sebelum posting.", 409, preview.conflicts);
  }
  const actor = String(performedBy || "").trim() || "system";
  const movements = [];
  for (const line of preview.lines) {
    const detail = line.detail;
    const actualQty = Number(detail.actualQty || 0);
    let balance = line.balance;
    let before = 0;
    if (line.foundStock) {
      balance = await tx.stockBalance.create({
        data: {
          ...identityData(detail),
          qtyOnHand: actualQty,
          qtyReserved: 0,
          qtyQC: 0,
          qtyAvailable: actualQty,
          lastMovement: new Date(),
        },
      });
    } else {
      await assertNotFrozen(tx, balance.id, { allowStoNo: header.stoNo });
      before = Number(balance.qtyOnHand || 0);
      const reserved = Number(balance.qtyReserved || 0);
      const qc = Number(balance.qtyQC || 0);
      await tx.stockBalance.update({
        where: { id: balance.id },
        data: {
          qtyOnHand: actualQty,
          qtyAvailable: actualQty - reserved - qc,
          lastMovement: new Date(),
        },
      });
    }
    const deltaQty = actualQty - Number(detail.systemQty || 0);
    const movementNumber = await movementNumberFactory(tx);
    const movement = await tx.stockMovement.create({
      data: {
        movementNumber,
        movementDate: new Date(),
        movementType: "ADJUSTMENT",
        direction: deltaQty < 0 ? "OUT" : "IN",
        transactionType: "STOCK_OPNAME",
        ...identityData(detail),
        qty: Math.abs(deltaQty),
        deltaQty,
        qtyBefore: before,
        qtyAfter: actualQty,
        adjustmentType: deltaQty < 0 ? "DECREASE" : "INCREASE",
        referenceType: "STOCK_OPNAME",
        referenceNumber: header.stoNo,
        notes: detail.reason || header.notes || null,
        performedBy: actor,
      },
    });
    movements.push(movement);
    await tx.stockOpnameDetail.update({
      where: { id: detail.id },
      data: {
        stockBalanceId: balance.id,
        adjustmentNumber: movementNumber,
        resolutionStatus: detail.isUnexpected ? "RESOLVED" : detail.resolutionStatus,
      },
    });
  }
  const adjustedAt = new Date();
  const updated = await tx.stockOpnameHeader.update({
    where: { id: header.id },
    data: {
      status: "ADJUSTED",
      inventoryFrozen: false,
      adjustedBy: actor,
      adjustedAt,
    },
  });
  return { header: updated, movements, conflicts: [] };
}

module.exports = {
  previewStockOpnameAdjustment,
  postStockOpnameAdjustment,
};