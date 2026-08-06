const crypto = require("crypto");
const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { queueDirtyPartCodes } = require("../../utils/mrpDirtyQueue");
const { generateMovementNumber } = require("../../utils/movementNumberGenerator");
const {
  assertStockBalanceNotFrozen,
  assertWarehouseNotFrozen,
} = require("./utils/stockOpnameFreezeGuard");
const { getFormulaSet, evaluateFromSet } = require("../../services/masterFormulaService");
const { assertQuantity } = require("../../utils/uomQuantity");
const {
  listMaterialPieceSources,
  resolveMaterialPieceConversion,
} = require("../../services/inventory/materialPieceConversionService");
const { lockStockBalanceIdentity } = require("../../services/inventory/stockBalanceLockService");

const MOVEMENT_TYPES = new Set(["IN", "OUT", "TRANSFER", "ADJUSTMENT"]);
const MATERIAL_PIECE_MODE = "MATERIAL_FROM_PART_PCS";

const number = (value, label) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    const error = new Error(`${label} harus berupa angka lebih besar dari 0.`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
};

const text = (value) => {
  const normalized = String(value ?? "").trim();
  return normalized || null;
};

function identityWhere(input, warehouseCode, rackCode) {
  return {
    warehouseCode,
    rackCode: text(rackCode),
    lotNumber: text(input.lotNumber),
    materialId: text(input.materialId),
    materialCode: text(input.materialCode),
    partCode: text(input.partCode),
    partNumber: text(input.partNumber),
    productId: text(input.productId),
    description: text(input.description),
    spec: text(input.spec),
    thickness: input.thickness == null || input.thickness === "" ? null : Number(input.thickness),
    width: input.width == null || input.width === "" ? null : Number(input.width),
    CSP: text(input.CSP || input.csp),
    uomCode: text(input.uomCode),
    stockType: text(input.stockType),
    isDeleted: false,
  };
}

async function findOrCreateBalance(tx, input, warehouseCode, rackCode, qty, direction, formulas) {
  const where = identityWhere(input, warehouseCode, rackCode);
  await lockStockBalanceIdentity(tx, where);
  const existing = await tx.stockBalance.findFirst({ where, select: { id: true, qtyOnHand: true, qtyReserved: true, qtyQC: true, qtyAvailable: true } });
  if (direction === "OUT" && !existing) {
    const error = new Error("Saldo stok untuk item/lot/lokasi tersebut tidak ditemukan.");
    error.statusCode = 409;
    throw error;
  }
  if (direction === "OUT" && Number(existing.qtyAvailable ?? existing.qtyOnHand ?? 0) < qty) {
    const error = new Error("Qty stok tersedia tidak mencukupi.");
    error.statusCode = 409;
    throw error;
  }
  const before = Number(existing?.qtyOnHand || 0);
  const after = direction === "OUT" ? before - qty : before + qty;
  const reserved = Number(existing?.qtyReserved || 0);
  const qc = Number(existing?.qtyQC || 0);
  if (existing) {
    await assertStockBalanceNotFrozen(tx, existing.id);
    const qtyAvailable = evaluateFromSet(formulas, "INVENTORY_AVAILABLE_QTY", {
      qtyOnHand: after,
      qtyReserved: reserved,
      qtyQC: qc,
    });
    const balance = await tx.stockBalance.update({ where: { id: existing.id }, data: { qtyOnHand: after, qtyAvailable, lastMovement: new Date() } });
    return { balance, before, after };
  }
  const qtyAvailable = evaluateFromSet(formulas, "INVENTORY_AVAILABLE_QTY", {
    qtyOnHand: qty,
    qtyReserved: 0,
    qtyQC: 0,
  });
  await assertWarehouseNotFrozen(tx, warehouseCode);
  const balance = await tx.stockBalance.create({
    data: {
      ...where,
      materialName: text(input.materialName),
      materialType: text(input.materialType),
      partName: text(input.partName),
      stockType: text(input.stockType),
      qtyOnHand: qty,
      qtyReserved: 0,
      qtyQC: 0,
      qtyAvailable,
      lastMovement: new Date(),
    },
  });
  return { balance, before: 0, after: qty };
}

async function assertInventoryLocation(tx, warehouseCode, rackCode) {
  const warehouse = await tx.warehouse.findFirst({
    where: { warehouseCode, isDeleted: false, isActive: true },
    select: { warehouseCode: true },
  });
  if (!warehouse) {
    const error = new Error(`Warehouse ${warehouseCode} tidak aktif atau tidak ditemukan.`);
    error.statusCode = 400;
    throw error;
  }
  const normalizedRack = text(rackCode);
  if (!normalizedRack) return;
  const rack = await tx.rack.findFirst({
    where: { rackCode: normalizedRack, isDeleted: false, isActive: true },
    select: { rackCode: true, warehouseCode: true },
  });
  if (!rack) {
    const error = new Error(`Rack ${normalizedRack} tidak aktif atau tidak ditemukan.`);
    error.statusCode = 400;
    throw error;
  }
  if (rack.warehouseCode && rack.warehouseCode !== warehouseCode) {
    const error = new Error(`Rack ${normalizedRack} bukan milik warehouse ${warehouseCode}.`);
    error.statusCode = 409;
    throw error;
  }
}

async function resolveMovementItem(tx, input) {
  const isMaterial = String(input.stockType || "").toLowerCase() === "material";
  if (isMaterial) {
    const materialId = text(input.materialId);
    const materialCode = text(input.materialCode);
    if (!materialId && !materialCode) {
      const error = new Error("Master Material wajib dipilih untuk Stock Type Material.");
      error.statusCode = 400;
      throw error;
    }
    const material = await tx.material.findFirst({
      where: { isDeleted: false, ...(materialId ? { id: materialId } : { materialCode }) },
      select: { id: true, materialCode: true, materialName: true, materialType: true, spec: true, thickness: true, width: true, CSP: true },
    });
    if (!material) {
      const error = new Error("Master Material tidak ditemukan.");
      error.statusCode = 400;
      throw error;
    }
    return {
      ...input,
      materialId: material.id,
      materialCode: material.materialCode,
      materialName: material.materialName || input.materialName || null,
      materialType: material.materialType || input.materialType || null,
      partCode: null,
      partNumber: null,
      partName: null,
      spec: input.spec || material.spec || null,
      thickness: input.thickness ?? material.thickness ?? null,
      width: input.width ?? material.width ?? null,
      CSP: input.CSP || material.CSP || null,
    };
  }
  const partBackedTypes = new Set(["purchase part", "wip", "finished goods"]);
  if (partBackedTypes.has(String(input.stockType || "").toLowerCase())) {
    const partCode = text(input.partCode);
    if (!partCode) {
      const error = new Error(`Master Part wajib dipilih untuk Stock Type ${input.stockType}.`);
      error.statusCode = 400;
      throw error;
    }
    const part = await tx.part.findFirst({
      where: { partCode, isDeleted: false },
      select: { partCode: true, partNumber: true, partName: true },
    });
    if (!part) {
      const error = new Error("Master Part tidak ditemukan.");
      error.statusCode = 400;
      throw error;
    }
    return {
      ...input,
      materialId: null,
      materialCode: null,
      materialName: null,
      materialType: null,
      partCode: part.partCode,
      partNumber: part.partNumber || input.partNumber || null,
      partName: part.partName || input.partName || null,
    };
  }
  return { ...input, materialId: null, materialCode: null, materialName: null, materialType: null };
}

function movementData(input, movementNumber, movementType, direction, warehouseCode, rackCode, qty, deltaQty, transferGroupId = null) {
  return {
    movementNumber,
    movementDate: input.movementDate ? new Date(input.movementDate) : new Date(),
    movementType,
    direction,
    transactionType: text(input.transactionType) || (movementType === "ADJUSTMENT" ? "STOCK_OPNAME" : "MANUAL"),
    warehouseCode,
    rackCode: text(rackCode),
    destinationWarehouseCode: text(input.destinationWarehouseCode),
    destinationRackCode: text(input.destinationRackCode),
    lotNumber: text(input.lotNumber),
    partCode: text(input.partCode),
    partNumber: text(input.partNumber),
    partName: text(input.partName),
    materialId: text(input.materialId),
    materialCode: text(input.materialCode),
    materialName: text(input.materialName),
    materialType: text(input.materialType),
    productId: text(input.productId),
    description: text(input.description),
    spec: text(input.spec),
    thickness: input.thickness == null || input.thickness === "" ? null : Number(input.thickness),
    width: input.width == null || input.width === "" ? null : Number(input.width),
    CSP: text(input.CSP || input.csp),
    stockType: text(input.stockType),
    qty,
    deltaQty,
    qtyBefore: input.qtyBefore == null ? null : Number(input.qtyBefore),
    qtyAfter: input.qtyAfter == null ? null : Number(input.qtyAfter),
    adjustmentType: text(input.adjustmentType),
    transferGroupId,
    uomCode: text(input.uomCode),
    qualityBucket: text(input.qualityBucket),
    referenceType: text(input.referenceType),
    referenceNumber: text(input.referenceNumber),
    notes: text(input.notes),
    performedBy: text(input.performedBy),
  };
}

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 20)));
    const q = String(req.query.q || "").trim();
    const where = { isDeleted: false };
    if (req.query.movementType) where.movementType = String(req.query.movementType).toUpperCase();
    if (req.query.warehouseCode) where.warehouseCode = String(req.query.warehouseCode);
    if (req.query.stockType) where.stockType = String(req.query.stockType);
    if (req.query.dateFrom || req.query.dateTo) {
      where.movementDate = {};
      if (req.query.dateFrom) where.movementDate.gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) where.movementDate.lte = new Date(req.query.dateTo);
    }
    if (q) where.OR = [{ movementNumber: { contains: q, mode: "insensitive" } }, { materialCode: { contains: q, mode: "insensitive" } }, { materialName: { contains: q, mode: "insensitive" } }, { partCode: { contains: q, mode: "insensitive" } }, { partNumber: { contains: q, mode: "insensitive" } }, { partName: { contains: q, mode: "insensitive" } }, { lotNumber: { contains: q, mode: "insensitive" } }, { referenceNumber: { contains: q, mode: "insensitive" } }];
    const [items, total] = await Promise.all([
      prisma.stockMovement.findMany({ where, orderBy: buildSort(req.query) || { movementDate: "desc" }, skip: (page - 1) * limit, take: limit }),
      prisma.stockMovement.count({ where }),
    ]);
    const mappedItems = items.map(mapDoc);
    const partCodes = [...new Set(mappedItems.map((item) => item.partCode).filter(Boolean))];
    const parts = partCodes.length ? await prisma.part.findMany({
      where: { partCode: { in: partCodes }, isDeleted: false },
      select: {
        partCode: true,
        partNumber: true,
        process: { select: { processName: true } },
        mbomDetails: {
          where: { isDeleted: false, mbomHeader: { isDeleted: false } },
          select: {
            mbomHeader: { select: { revision: true } },
            mbomProcesses: {
              where: { isDeleted: false },
              orderBy: { sequence: "asc" },
              select: { sequence: true, occurrenceCode: true, process: { select: { processName: true } } },
            },
          },
        },
      },
    }) : [];
    const partInfoByCode = new Map(parts.map((part) => {
      const bomProcesses = part.mbomDetails.flatMap((detail) => (detail.mbomProcesses || []).map((item) => ({ ...item, revision: detail.mbomHeader?.revision || 0 })))
        .sort((left, right) => Number(right.revision || 0) - Number(left.revision || 0) || Number(left.sequence || 0) - Number(right.sequence || 0));
      const bomProcess = bomProcesses.find((item) => item.process?.processName || item.occurrenceCode);
      return [part.partCode, { partNumber: part.partNumber, processName: bomProcess?.occurrenceCode || bomProcess?.process?.processName || part.process?.processName || null }];
    }));
    res.json({ items: mappedItems.map((item) => ({ ...item, partNumber: partInfoByCode.get(item.partCode)?.partNumber || item.partNumber || null, mbomProcessName: partInfoByCode.get(item.partCode)?.processName || null })), total, page, limit });
  } catch (error) { next(error); }
};

exports.get = async (req, res, next) => {
  try {
    const item = await prisma.stockMovement.findUnique({ where: { movementNumber: req.params.movementNumber } });
    if (!item || item.isDeleted) return res.status(404).json({ message: "Stock movement tidak ditemukan." });
    res.json(mapDoc(item));
  } catch (error) { next(error); }
};

exports.listMaterialPieceSources = async (req, res, next) => {
  try {
    const items = await listMaterialPieceSources(prisma, { q: req.query.q });
    res.json({ items, total: items.length });
  } catch (error) { next(error); }
};

function materialPieceAuditNote(input, conversion) {
  const audit = [
    `[PCS_TO_KG] ${conversion.sourcePartCode}`,
    `${conversion.sourceQtyPcs} PCS x ${conversion.grossWeightKgPerPcs} KG/PCS`,
    `= ${conversion.convertedQtyKg} KG ${conversion.materialCode}`,
    `BOM ${conversion.mbomNoReg}`,
  ].join(" | ");
  return [text(input.notes), audit].filter(Boolean).join("\n");
}

exports.create = async (req, res, next) => {
  try {
    const input = req.body || {};
    const usesMaterialPieceConversion = String(input.inputMode || "").toUpperCase() === MATERIAL_PIECE_MODE;
    const movementType = String(input.movementType || "").toUpperCase();
    if (!MOVEMENT_TYPES.has(movementType)) return res.status(400).json({ message: "movementType harus IN, OUT, TRANSFER, atau ADJUSTMENT." });
    const warehouseCode = text(input.warehouseCode);
    if (!warehouseCode) return res.status(400).json({ message: "warehouseCode wajib diisi." });
    const requestedQty = number(usesMaterialPieceConversion ? input.sourceQtyPcs : input.qty, usesMaterialPieceConversion ? "Qty sumber PCS" : "Qty");
    if (movementType === "TRANSFER" && !text(input.destinationWarehouseCode)) return res.status(400).json({ message: "destinationWarehouseCode wajib untuk transfer." });
    const formulas = await getFormulaSet(prisma, "inventory");
    const result = await prisma.$transaction(async (tx) => {
      const actor = input.performedBy || req.user?.username || req.user?.email || "system";
      await assertInventoryLocation(tx, warehouseCode, input.rackCode);
      if (movementType === "TRANSFER") {
        await assertInventoryLocation(tx, text(input.destinationWarehouseCode), input.destinationRackCode);
      }
      const conversion = usesMaterialPieceConversion
        ? await resolveMaterialPieceConversion(tx, { ...input, sourceQtyPcs: requestedQty })
        : null;
      const normalizedInput = conversion ? {
        ...input,
        stockType: "Material",
        materialId: conversion.materialId,
        materialCode: conversion.materialCode,
        materialName: conversion.materialName,
        materialType: conversion.materialType,
        spec: conversion.materialSpec,
        thickness: conversion.materialThickness,
        width: conversion.materialWidth,
        CSP: conversion.materialCSP,
        uomCode: conversion.targetUomCode,
        transactionType: text(input.transactionType) || "MANUAL_MATERIAL_CONVERSION",
        referenceType: text(input.referenceType) || "MATERIAL_PCS_CONVERSION",
        notes: materialPieceAuditNote(input, conversion),
      } : input;
      const qty = conversion?.convertedQtyKg ?? requestedQty;
      const payload = { ...(await resolveMovementItem(tx, normalizedInput)), performedBy: actor };
      // Piece/sheet/coil movements are discrete units. Reject fractional input
      // at the inventory boundary so balances and downstream reservations never
      // acquire values such as 11785.714 pcs.
      assertQuantity(qty, payload.uomCode, "Qty");
      if (movementType === "TRANSFER") {
        const transferGroupId = crypto.randomUUID();
        const source = await findOrCreateBalance(tx, payload, warehouseCode, input.rackCode, qty, "OUT", formulas);
        const destination = await findOrCreateBalance(tx, payload, input.destinationWarehouseCode, input.destinationRackCode, qty, "IN", formulas);
        const outNumber = await generateMovementNumber("OUT", tx);
        const inNumber = await generateMovementNumber("IN", tx);
        const out = await tx.stockMovement.create({ data: movementData({ ...payload, qtyBefore: source.before, qtyAfter: source.after }, outNumber, "TRANSFER", "OUT", warehouseCode, input.rackCode, qty, -qty, transferGroupId) });
        const incoming = await tx.stockMovement.create({ data: movementData({ ...payload, qtyBefore: destination.before, qtyAfter: destination.after }, inNumber, "TRANSFER", "IN", input.destinationWarehouseCode, input.destinationRackCode, qty, qty, transferGroupId) });
        await queueDirtyPartCodes(tx, [conversion?.sourcePartCode || payload.partCode], {
          reason: "STOCK",
          sourceNumber: transferGroupId,
          notes: "Transfer stock mengubah net availability MRP.",
        });
        return { items: [out, incoming], transferGroupId, conversion };
      }
      const adjustmentDecrease = movementType === "ADJUSTMENT" && (String(input.adjustmentType || "").toUpperCase() === "DECREASE" || Number(input.deltaQty) < 0);
      const direction = movementType === "OUT" || adjustmentDecrease ? "OUT" : "IN";
      const balance = await findOrCreateBalance(tx, payload, warehouseCode, input.rackCode, qty, direction, formulas);
      const movementNumber = await generateMovementNumber(movementType, tx);
      const movement = await tx.stockMovement.create({ data: movementData({ ...payload, qtyBefore: balance.before, qtyAfter: balance.after, adjustmentType: movementType === "ADJUSTMENT" ? (direction === "OUT" ? "DECREASE" : "INCREASE") : input.adjustmentType }, movementNumber, movementType, direction, warehouseCode, input.rackCode, qty, direction === "OUT" ? -qty : qty) });
      await queueDirtyPartCodes(tx, [conversion?.sourcePartCode || payload.partCode], {
        reason: "STOCK",
        sourceNumber: movementNumber,
        notes: "Stock movement mengubah net availability MRP.",
      });
      return { items: [movement], conversion };
    });
    res.status(201).json({ items: result.items.map(mapDoc), transferGroupId: result.transferGroupId || null, conversion: result.conversion || null });
  } catch (error) { next(error); }
};

module.exports = exports;
