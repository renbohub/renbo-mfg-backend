"use strict";

const crypto = require("node:crypto");

const number = (value) => (Number.isFinite(Number(value)) ? Math.max(Number(value), 0) : 0);
const rounded = (value) => Math.round((number(value) + Number.EPSILON) * 1000000) / 1000000;

function buildCutLine(input = {}) {
  const plannedQty = rounded(input.plannedQty);
  const producedQty = rounded(input.producedQty);
  const wipQty = rounded(input.wipQty);
  const protectedProductionQty = rounded(Math.max(producedQty, wipQty));
  const cuttableQty = rounded(Math.max(plannedQty - protectedProductionQty, 0));
  const requestedCutQty = rounded(input.requestedQty);
  const approvedCutQty = rounded(Math.min(requestedCutQty, cuttableQty));
  const supplierPoQty = rounded(input.supplierPoQty);
  return {
    plannedQty,
    producedQty,
    wipQty,
    protectedProductionQty,
    cuttableQty,
    requestedCutQty,
    approvedCutQty,
    supplierPoQty,
    supplierPoProtected: supplierPoQty > 0,
    status: approvedCutQty <= 0 ? "BLOCKED" : approvedCutQty < requestedCutQty ? "PARTIAL" : "CUTTABLE",
  };
}

function summarizeCutPreview(lines = []) {
  const sum = (key) => rounded(lines.reduce((total, row) => total + number(row[key]), 0));
  const requestedQty = sum("requestedCutQty");
  const approvedCutQty = sum("approvedCutQty");
  const supplierPoQty = sum("supplierPoQty");
  return {
    requestedQty,
    approvedCutQty,
    protectedProductionQty: sum("protectedProductionQty"),
    supplierPoQty,
    blockedQty: rounded(Math.max(requestedQty - approvedCutQty, 0)),
    hasSupplierPoWarning: supplierPoQty > 0,
  };
}

function conflict(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function previewProductionCut(tx, { baselineLockId, requestedQty }) {
  const lock = await tx.planningBaselineLock.findFirst({ where: { id: baselineLockId, status: "ACTIVE" } });
  if (!lock) throw conflict("BASELINE_LOCK_NOT_FOUND", "Baseline lock tidak aktif atau tidak ditemukan.");
  const detailId = lock.sourceSnapshot?.mpsDetailId;
  const detail = detailId ? await tx.mPSDetail.findFirst({ where: { id: detailId, isDeleted: false }, include: { part: { select: { id: true, partCode: true, partNumber: true, partName: true } } } }) : null;
  if (!detail) throw conflict("BASELINE_DETAIL_NOT_FOUND", "Detail MPS pada snapshot baseline tidak ditemukan.");
  const monthStart = new Date(lock.periodMonth);
  const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
  const manufacturingOrders = await tx.manufacturingOrder.findMany({
    where: { isDeleted: false, partId: detail.partId, status: { not: "Cancelled" }, OR: [{ plannedEndDate: { gte: monthStart, lt: monthEnd } }, { plannedStartDate: { gte: monthStart, lt: monthEnd } }] },
    include: { wipEntries: { where: { isDeleted: false }, select: { qty: true, direction: true, costType: true } } },
    orderBy: [{ plannedStartDate: "desc" }, { moNumber: "desc" }],
  });
  const prSources = await tx.purchaseRequisitionSource.findMany({
    where: { isDeleted: false, OR: [{ mpsDetailId: detail.id }, { mpsNumber: lock.baselineMpsNumber }] },
    include: { prDetail: { include: { poDetails: { where: { isDeleted: false }, include: { po: { select: { status: true } } } } } } },
  });
  const priorCutLines = await tx.planningAdjustmentLine.findMany({
    where: { partCode: detail.partCode, adjustment: { baselineLockId, status: { in: ["APPROVED", "APPLIED"] } } },
    select: { approvedCutQty: true, appliedCutQty: true },
  });
  const priorCutQty = rounded(priorCutLines.reduce((sum, row) => sum + (number(row.appliedCutQty) || number(row.approvedCutQty)), 0));
  const protectedPoLines = new Map(prSources.flatMap((source) => source.prDetail.poDetails).filter((row) => !["Cancelled", "Rejected"].includes(row.po.status)).map((row) => [row.id, row]));
  const supplierPoQty = rounded([...protectedPoLines.values()].reduce((sum, row) => sum + number(row.qty), 0));
  const moPlannedQty = rounded(manufacturingOrders.reduce((sum, row) => sum + number(row.qtyPlanned), 0));
  const producedQty = rounded(manufacturingOrders.reduce((sum, row) => sum + (row.status === "Completed" ? number(row.qtyPlanned) : Math.max(number(row.qtyProduced), number(row.qtyGood))), 0));
  const wipQty = rounded(manufacturingOrders.reduce((sum, row) => {
    const byCostType = new Map();
    for (const entry of row.wipEntries) byCostType.set(entry.costType, (byCostType.get(entry.costType) || 0) + (entry.direction === "OUT" ? -number(entry.qty) : number(entry.qty)));
    return sum + Math.max(0, ...byCostType.values());
  }, 0));
  const reductionAvailable = rounded(Math.max(number(lock.efdQtyLocked) - number(lock.poQtyLocked), 0));
  const requested = rounded(requestedQty == null ? reductionAvailable : requestedQty);
  const line = {
    ...buildCutLine({ plannedQty: moPlannedQty || Math.max(number(detail.qtyPlanned) - priorCutQty, 0), producedQty, wipQty, requestedQty: requested, supplierPoQty }),
    mpsNumber: lock.baselineMpsNumber,
    mpsDetailId: detail.id,
    partCode: detail.partCode,
    manufacturingOrders: manufacturingOrders.map((row) => ({ id: row.id, moNumber: row.moNumber, status: row.status, notes: row.notes || null, plannedQty: number(row.qtyPlanned), producedQty: row.status === "Completed" ? number(row.qtyPlanned) : Math.max(number(row.qtyProduced), number(row.qtyGood)) })),
  };
  const snapshot = { baselineLockId, customerCode: lock.customerCode, partCode: lock.partCode, periodMonth: lock.periodMonth, baselineMpsNumber: lock.baselineMpsNumber, line };
  return { lock, lines: [line], summary: summarizeCutPreview([line]), sourceFingerprint: fingerprint(snapshot), sourceSnapshot: snapshot };
}

async function nextAdjustmentNumber(tx, periodMonth) {
  const month = new Date(periodMonth).toISOString().slice(0, 7).replace("-", "");
  const prefix = `CUT-${month}-`;
  const rows = await tx.planningAdjustment.findMany({ where: { adjustmentNumber: { startsWith: prefix } }, select: { adjustmentNumber: true } });
  const sequence = rows.reduce((max, row) => Math.max(max, Number(row.adjustmentNumber.slice(prefix.length)) || 0), 0) + 1;
  return `${prefix}${String(sequence).padStart(3, "0")}`;
}

async function createProductionCut(tx, { baselineLockId, requestedQty, expectedFingerprint, reason, actor }) {
  if (String(reason || "").trim().length < 10) throw conflict("PRODUCTION_CUT_REASON_REQUIRED", "Alasan Production Cut minimal 10 karakter.");
  const preview = await previewProductionCut(tx, { baselineLockId, requestedQty });
  if (expectedFingerprint && expectedFingerprint !== preview.sourceFingerprint) throw conflict("PRODUCTION_CUT_SOURCE_CHANGED", "Qty produksi, WIP, atau supplier PO berubah setelah preview.");
  if (preview.summary.approvedCutQty <= 0) throw conflict("PRODUCTION_CUT_NOT_AVAILABLE", "Tidak ada qty produksi yang masih dapat dikurangi.");
  const adjustment = await tx.planningAdjustment.create({
    data: {
      adjustmentNumber: await nextAdjustmentNumber(tx, preview.lock.periodMonth),
      baselineLockId,
      requestedQty: preview.summary.requestedQty,
      approvedQty: 0,
      appliedQty: 0,
      status: "PENDING_APPROVAL",
      reason: String(reason).trim(),
      sourceFingerprint: preview.sourceFingerprint,
      sourceSnapshot: preview.sourceSnapshot,
      requestedBy: actor || "system",
      lines: { create: preview.lines.map((line) => ({ mpsNumber: line.mpsNumber, mpsDetailId: line.mpsDetailId, partCode: line.partCode, requestedCutQty: line.requestedCutQty, plannedQty: line.plannedQty, producedQty: line.producedQty, wipQty: line.wipQty, supplierPoQty: line.supplierPoQty, status: line.status, metadata: { manufacturingOrders: line.manufacturingOrders, supplierPoProtected: line.supplierPoProtected } })) },
    },
    include: { lines: true },
  });
  return { adjustment, preview };
}

async function approveProductionCut(tx, { adjustmentNumber, actor }) {
  const adjustment = await tx.planningAdjustment.findFirst({ where: { adjustmentNumber, status: "PENDING_APPROVAL" }, include: { lines: true } });
  if (!adjustment) throw conflict("PRODUCTION_CUT_NOT_PENDING", "Production Cut tidak ditemukan atau sudah diproses.");
  const fresh = await previewProductionCut(tx, { baselineLockId: adjustment.baselineLockId, requestedQty: adjustment.requestedQty });
  if (fresh.sourceFingerprint !== adjustment.sourceFingerprint) throw conflict("PRODUCTION_CUT_SOURCE_CHANGED", "Qty produksi, WIP, atau supplier PO berubah; buat preview Production Cut baru.");
  let remaining = fresh.summary.approvedCutQty;
  for (const mo of fresh.lines[0].manufacturingOrders) {
    if (remaining <= 0) break;
    const protectedQty = number(mo.producedQty);
    const available = Math.max(number(mo.plannedQty) - protectedQty, 0);
    const cut = Math.min(available, remaining);
    if (cut > 0) await tx.manufacturingOrder.update({ where: { id: mo.id }, data: { qtyPlanned: rounded(number(mo.plannedQty) - cut), notes: [mo.notes, `Production Cut ${adjustmentNumber}; produced quantity tetap dilindungi.`].filter(Boolean).join("\n") } });
    remaining = rounded(remaining - cut);
  }
  await tx.planningAdjustmentLine.updateMany({ where: { adjustmentId: adjustment.id }, data: { approvedCutQty: fresh.summary.approvedCutQty, appliedCutQty: fresh.summary.approvedCutQty, status: "APPLIED" } });
  return tx.planningAdjustment.update({ where: { id: adjustment.id }, data: { approvedQty: fresh.summary.approvedCutQty, appliedQty: fresh.summary.approvedCutQty, status: "APPLIED", approvedBy: actor || "system", approvedAt: new Date(), appliedBy: actor || "system", appliedAt: new Date() }, include: { lines: true } });
}

module.exports = { buildCutLine, summarizeCutPreview, previewProductionCut, createProductionCut, approveProductionCut };
