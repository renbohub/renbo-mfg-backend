const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { generateDocNumber } = require("../purchasing/utils/purchasingHelpers");
const { generateMovementNumber } = require("../../utils/movementNumberGenerator");
const { assertStockBalanceNotFrozen } = require("./utils/stockOpnameFreezeGuard");

const ACTIVE_STATUSES = new Set(["DRAFT", "COUNTING", "WAITING_APPROVAL", "APPROVED", "ADJUSTED"]);
const fail = (message, statusCode = 400) => { const error = new Error(message); error.statusCode = statusCode; throw error; };

function statusGuard(current, expected) {
  if (Array.isArray(expected) ? !expected.includes(current) : current !== expected) fail(`Status STO ${current} tidak dapat diproses untuk aksi ini.`, 409);
}

function variance(systemQty, actualQty) {
  const system = Number(systemQty || 0);
  const actual = Number(actualQty);
  const value = Number.isFinite(actual) ? actual - system : 0;
  return { value, status: value === 0 ? "MATCH" : value < 0 ? "SHORTAGE" : "EXCESS" };
}

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 20)));
    const q = String(req.query.q || "").trim();
    const where = { isDeleted: false };
    if (req.query.stoType) where.stoType = String(req.query.stoType).toUpperCase();
    if (req.query.warehouseCode) where.warehouseCode = String(req.query.warehouseCode);
    if (req.query.status) where.status = String(req.query.status).toUpperCase();
    if (q) where.OR = [{ stoNo: { contains: q, mode: "insensitive" } }, { warehouseCode: { contains: q, mode: "insensitive" } }, { notes: { contains: q, mode: "insensitive" } }];
    const [items, total] = await Promise.all([
      prisma.stockOpnameHeader.findMany({ where, include: { _count: { select: { details: true } } }, orderBy: buildSort(req.query) || { stoDate: "desc" }, skip: (page - 1) * limit, take: limit }),
      prisma.stockOpnameHeader.count({ where }),
    ]);
    res.json({ items: items.map((item) => mapDoc({ ...item, detailCount: item._count?.details || 0 })), total, page, limit });
  } catch (error) { next(error); }
};

exports.get = async (req, res, next) => {
  try {
    const item = await prisma.stockOpnameHeader.findUnique({ where: { stoNo: req.params.stoNo }, include: { details: { where: { isDeleted: false }, orderBy: { id: "asc" } } } });
    if (!item || item.isDeleted) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    res.json(mapDoc(item));
  } catch (error) { next(error); }
};

exports.create = async (req, res, next) => {
  try {
    const body = req.body || {};
    const warehouseCode = String(body.warehouseCode || "").trim();
    const stoType = String(body.stoType || "MATERIAL").trim().toUpperCase();
    if (!warehouseCode) return res.status(400).json({ message: "warehouseCode wajib diisi." });
    if (!['MATERIAL', 'WIP', 'FG'].includes(stoType)) return res.status(400).json({ message: "stoType harus MATERIAL, WIP, atau FG." });
    const balances = await prisma.stockBalance.findMany({ where: { warehouseCode, isDeleted: false, ...(body.stockType ? { stockType: String(body.stockType) } : {}) }, orderBy: [{ partCode: "asc" }, { lotNumber: "asc" }] });
    const stoNo = await generateDocNumber("stockOpnameHeader", "STO", "stoNo");
    const header = await prisma.stockOpnameHeader.create({ data: { stoNo, stoType, warehouseCode, stoDate: body.stoDate ? new Date(body.stoDate) : new Date(), status: "DRAFT", notes: body.notes || null, createdBy: req.user?.username || req.user?.email || "system", details: { create: balances.map((balance) => ({ stockBalanceId: balance.id, partCode: balance.partCode, partNumber: balance.partNumber, partName: balance.partName, productId: balance.productId, description: balance.description, spec: balance.spec, thickness: balance.thickness, width: balance.width, CSP: balance.CSP, stockType: balance.stockType, warehouseCode: balance.warehouseCode, rackCode: balance.rackCode, lotNumber: balance.lotNumber, uomCode: balance.uomCode, systemQty: balance.qtyOnHand })) } }, include: { details: true } });
    res.status(201).json(mapDoc(header));
  } catch (error) { next(error); }
};

exports.startCounting = async (req, res, next) => {
  try {
    const item = await prisma.stockOpnameHeader.findUnique({ where: { stoNo: req.params.stoNo } });
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    statusGuard(item.status, "DRAFT");
    const updated = await prisma.stockOpnameHeader.update({ where: { id: item.id }, data: { status: "COUNTING", inventoryFrozen: true } });
    res.json(mapDoc(updated));
  } catch (error) { next(error); }
};

exports.countDetail = async (req, res, next) => {
  try {
    const detail = await prisma.stockOpnameDetail.findUnique({ where: { id: req.params.detailId }, include: { header: true } });
    if (!detail || detail.isDeleted) return res.status(404).json({ message: "Detail stock opname tidak ditemukan." });
    statusGuard(detail.header.status, "COUNTING");
    const actualQty = Number(req.body?.actualQty);
    if (!Number.isFinite(actualQty) || actualQty < 0) return res.status(400).json({ message: "actualQty harus berupa angka >= 0." });
    const result = variance(detail.systemQty, actualQty);
    const updated = await prisma.stockOpnameDetail.update({ where: { id: detail.id }, data: { actualQty, varianceQty: result.value, varianceStatus: result.status, reason: req.body?.reason || null, countedBy: req.user?.username || req.user?.email || "system", countedAt: new Date() } });
    res.json(mapDoc(updated));
  } catch (error) { next(error); }
};

exports.submit = async (req, res, next) => {
  try {
    const item = await prisma.stockOpnameHeader.findUnique({ where: { stoNo: req.params.stoNo }, include: { details: true } });
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    statusGuard(item.status, "COUNTING");
    if (item.details.some((detail) => detail.actualQty == null && !detail.isDeleted)) return res.status(409).json({ message: "Semua detail harus dihitung sebelum diajukan." });
    const updated = await prisma.stockOpnameHeader.update({ where: { id: item.id }, data: { status: "WAITING_APPROVAL", checkerBy: req.user?.username || req.user?.email || "system", checkerApprovedAt: new Date() } });
    res.json(mapDoc(updated));
  } catch (error) { next(error); }
};

exports.approve = async (req, res, next) => {
  try {
    const item = await prisma.stockOpnameHeader.findUnique({ where: { stoNo: req.params.stoNo } });
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    statusGuard(item.status, "WAITING_APPROVAL");
    const updated = await prisma.stockOpnameHeader.update({ where: { id: item.id }, data: { status: "APPROVED", approvedBy: req.user?.username || req.user?.email || "system", approvedAt: new Date() } });
    res.json(mapDoc(updated));
  } catch (error) { next(error); }
};

exports.adjust = async (req, res, next) => {
  try {
    const item = await prisma.stockOpnameHeader.findUnique({ where: { stoNo: req.params.stoNo }, include: { details: true } });
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    statusGuard(item.status, "APPROVED");
    const changed = await prisma.$transaction(async (tx) => {
      const movements = [];
      for (const detail of item.details.filter((row) => !row.isDeleted && Number(row.varianceQty || 0) !== 0)) {
        if (!detail.stockBalanceId) continue;
        const balance = await tx.stockBalance.findUnique({ where: { id: detail.stockBalanceId } });
        if (!balance) continue;
        await assertStockBalanceNotFrozen(tx, balance.id, { allowStoNo: item.stoNo });
        const before = Number(balance.qtyOnHand || 0);
        const after = Math.max(0, before + Number(detail.varianceQty || 0));
        const reserved = Number(balance.qtyReserved || 0);
        const qc = Number(balance.qtyQC || 0);
        await tx.stockBalance.update({ where: { id: balance.id }, data: { qtyOnHand: after, qtyAvailable: Math.max(0, after - reserved - qc), lastMovement: new Date() } });
        const movementNumber = await generateMovementNumber("ADJUSTMENT", tx);
        movements.push(await tx.stockMovement.create({ data: { movementNumber, movementDate: new Date(), movementType: "ADJUSTMENT", direction: Number(detail.varianceQty) < 0 ? "OUT" : "IN", transactionType: "STOCK_OPNAME", warehouseCode: detail.warehouseCode, rackCode: detail.rackCode, lotNumber: detail.lotNumber, partCode: detail.partCode, partNumber: detail.partNumber, partName: detail.partName, productId: detail.productId, description: detail.description, spec: detail.spec, thickness: detail.thickness, width: detail.width, CSP: detail.CSP, stockType: detail.stockType, qty: Math.abs(Number(detail.varianceQty)), deltaQty: Number(detail.varianceQty), qtyBefore: before, qtyAfter: after, adjustmentType: Number(detail.varianceQty) < 0 ? "DECREASE" : "INCREASE", uomCode: detail.uomCode, referenceType: "STOCK_OPNAME", referenceNumber: item.stoNo, notes: detail.reason || item.notes || null, performedBy: req.user?.username || req.user?.email || "system" } }));
        await tx.stockOpnameDetail.update({ where: { id: detail.id }, data: { adjustmentNumber: movementNumber } });
      }
      const updated = await tx.stockOpnameHeader.update({ where: { id: item.id }, data: { status: "ADJUSTED", inventoryFrozen: false, adjustedBy: req.user?.username || req.user?.email || "system", adjustedAt: new Date() }, include: { details: true } });
      return { updated, movements };
    });
    res.json({ ...mapDoc(changed.updated), movements: changed.movements.map(mapDoc) });
  } catch (error) { next(error); }
};

exports.close = async (req, res, next) => {
  try {
    const item = await prisma.stockOpnameHeader.findUnique({ where: { stoNo: req.params.stoNo } });
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    statusGuard(item.status, ["ADJUSTED", "APPROVED"]);
    const updated = await prisma.stockOpnameHeader.update({ where: { id: item.id }, data: { status: "CLOSED", inventoryFrozen: false, closedBy: req.user?.username || req.user?.email || "system", closedAt: new Date() } });
    res.json(mapDoc(updated));
  } catch (error) { next(error); }
};

module.exports = exports;
