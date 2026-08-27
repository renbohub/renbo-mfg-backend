const { randomUUID } = require("crypto");
const { generateMovementNumber } = require("../../../utils/movementNumberGenerator");
const { assertStockBalanceNotFrozen, assertStockIdentityNotFrozen } = require("../../inventory/utils/stockOpnameFreezeGuard");
const { buildExcludeSpecialRackCondition } = require("../../inventory/utils/stockReservationHelpers");
const { assertQuantity } = require("../../../utils/uomQuantity");

const TOLERANCE = 0.000001;
const number = (value) => Number(value || 0);

function preferredPartBase(part = {}) {
  const rows = Array.isArray(part.partBases) ? part.partBases : [];
  return rows.find((row) => String(row.baseOn || "").trim().toUpperCase() === "ACTUAL")
    || rows.find((row) => ["QTN", "QUOTATION"].includes(String(row.baseOn || "").trim().toUpperCase()))
    || rows[0]
    || {};
}

function partStockIdentity(part = {}) {
  const base = preferredPartBase(part);
  return {
    partNumber: part.partNumber || null,
    partName: part.partName || null,
    productId: null,
    description: null,
    spec: part.material?.spec || null,
    thickness: base.thickness ?? null,
    width: base.width ?? null,
    CSP: base.CSP || null,
  };
}

async function resolveReceiptDefinition(tx, schedule, fgPartCode) {
  if (!schedule?.productionPlanId || !fgPartCode) return null;
  const [plan, receiptLines, allocation, header] = await Promise.all([
    tx.monthlyProductionPlan.findUnique({
      where: { id: schedule.productionPlanId },
      select: { id: true, planNumber: true },
    }),
    tx.monthlyProductionPlanDetail.findMany({
      where: {
        planId: schedule.productionPlanId,
        partCode: fgPartCode,
        isDeleted: false,
        notes: { contains: "[FG-RECEIPT:CHILD]" },
      },
      orderBy: [{ requiredDate: "asc" }, { lineNumber: "asc" }],
      select: {
        id: true,
        lineNumber: true,
        qtyPlanned: true,
        uomCode: true,
        deliveryPhaseId: true,
        requiredDate: true,
        fgRequiredDate: true,
      },
    }),
    schedule.productionPlanAllocationId && tx.productionPlanAllocation?.findUnique
      ? tx.productionPlanAllocation.findUnique({
          where: { id: schedule.productionPlanAllocationId },
          select: { id: true, deliveryPhaseId: true, fgRequiredDate: true },
        })
      : Promise.resolve(null),
    tx.mBOMHeader.findFirst({
      where: { isDeleted: false, part: { partCode: fgPartCode, isDeleted: false } },
      orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
      select: {
        noReg: true,
        part: {
          select: {
            id: true,
            partCode: true,
            partNumber: true,
            partName: true,
            itemType: true,
            material: { select: { spec: true } },
            partBases: {
              orderBy: { createdAt: "asc" },
              select: { baseOn: true, thickness: true, width: true, CSP: true },
            },
          },
        },
        details: {
          where: { isDeleted: false, parentDetailId: null },
          orderBy: [{ levelComponent: "asc" }, { createdAt: "asc" }],
          take: 2,
          select: {
            id: true,
            uomCode: true,
            part: { select: { id: true, partCode: true, itemType: true } },
          },
        },
      },
    }),
  ]);
  const phaseId = schedule.deliveryPhaseId || allocation?.deliveryPhaseId || null;
  const requiredFgDate = schedule.fgRequiredDate || allocation?.fgRequiredDate || null;
  const sameDay = (left, right) => left && right && new Date(left).toISOString().slice(0, 10) === new Date(right).toISOString().slice(0, 10);
  const phaseMatches = phaseId ? receiptLines.filter((line) => line.deliveryPhaseId === phaseId) : [];
  const dateMatches = requiredFgDate
    ? receiptLines.filter((line) => sameDay(line.fgRequiredDate, requiredFgDate))
    : [];
  const receiptLine = phaseMatches.length === 1
    ? phaseMatches[0]
    : dateMatches.length === 1
      ? dateMatches[0]
      : receiptLines.length === 1
        ? receiptLines[0]
        : null;
  if (!plan || !receiptLine || !header?.part || header.details.length !== 1) return null;
  const finalWip = header.details[0];
  if (!finalWip.part?.partCode || String(finalWip.part.itemType || "").trim().toUpperCase() !== "WIP") return null;
  return { plan, receiptLine, header, finalWip };
}

function childFgReceiptMarker(plan, receiptLine, fgPartCode) {
  return `[CHILD-FG-RECEIPT:${plan.planNumber}:${receiptLine.id}:${fgPartCode}]`;
}

async function upsertFgBalance(tx, source, definition, qty, uomCode, now) {
  const identity = partStockIdentity(definition.header.part);
  const where = {
    warehouseCode: source.warehouseCode,
    rackCode: source.rackCode || null,
    lotNumber: source.lotNumber || null,
    partCode: definition.header.part.partCode,
    ...identity,
    uomCode,
    stockType: "Finished Goods",
    isDeleted: false,
  };
  const existing = await tx.stockBalance.findFirst({
    where,
    select: { id: true, qtyOnHand: true, qtyReserved: true, qtyQC: true },
  });
  if (existing) {
    await assertStockBalanceNotFrozen(tx, existing.id);
    const qtyBefore = number(existing.qtyOnHand);
    const qtyAfter = qtyBefore + qty;
    const qtyReserved = number(existing.qtyReserved);
    const qtyQC = number(existing.qtyQC);
    const balance = await tx.stockBalance.update({
      where: { id: existing.id },
      data: {
        qtyOnHand: qtyAfter,
        qtyAvailable: Math.max(0, qtyAfter - qtyReserved - qtyQC),
        lastMovement: now,
      },
    });
    return { balance, qtyBefore, qtyAfter, identity };
  }
  await assertStockIdentityNotFrozen(tx, {
    warehouseCode: source.warehouseCode,
    rackCode: source.rackCode || null,
    lotNumber: source.lotNumber || null,
    stockType: "Finished Goods",
  });
  const balance = await tx.stockBalance.create({
    data: {
      warehouseCode: source.warehouseCode,
      rackCode: source.rackCode || null,
      lotNumber: source.lotNumber || null,
      partCode: definition.header.part.partCode,
      ...identity,
      uomCode,
      stockType: "Finished Goods",
      qtyOnHand: qty,
      qtyReserved: 0,
      qtyQC: 0,
      qtyAvailable: qty,
      lastMovement: now,
    },
  });
  return { balance, qtyBefore: 0, qtyAfter: qty, identity };
}

/**
 * Convert the released final WIP of a nested BOM into its implicit child-FG
 * receipt. The MPP child receipt line is the authorization and quantity cap;
 * the requesting successor DPP is the execution reference.
 */
async function materializeChildFgShortage(tx, schedule, fgItem, performedBy = "system") {
  const shortage = Math.max(0, number(fgItem?.shortage));
  if (shortage <= TOLERANCE || String(fgItem?.itemType || "").trim().toUpperCase() !== "FG") {
    return { convertedQty: 0 };
  }
  const definition = await resolveReceiptDefinition(tx, schedule, fgItem.partCode);
  if (!definition) return { convertedQty: 0 };

  const marker = childFgReceiptMarker(definition.plan, definition.receiptLine, fgItem.partCode);
  const legacyMarker = `[CHILD-FG-RECEIPT:${definition.plan.planNumber}:${fgItem.partCode}]`;
  const prior = await tx.stockMovement.aggregate({
    where: {
      isDeleted: false,
      direction: "IN",
      transactionType: "PRODUCTION",
      stockType: "Finished Goods",
      partCode: fgItem.partCode,
      OR: [
        { notes: { contains: marker } },
        {
          AND: [
            { notes: { contains: legacyMarker } },
            { notes: { contains: `MPP line ${definition.receiptLine.lineNumber}` } },
          ],
        },
      ],
    },
    _sum: { qty: true },
  });
  const remainingPlanQty = Math.max(0, number(definition.receiptLine.qtyPlanned) - number(prior._sum.qty));
  const qtyToConvert = Math.min(shortage, remainingPlanQty);
  if (qtyToConvert <= TOLERANCE) return { convertedQty: 0 };

  const uomCode = fgItem.uomCode || definition.receiptLine.uomCode || definition.finalWip.uomCode || null;
  assertQuantity(qtyToConvert, uomCode, `Child FG Receipt ${fgItem.partCode}`);
  const sources = await tx.stockBalance.findMany({
    where: {
      AND: [
        {
          isDeleted: false,
          stockType: "WIP",
          partCode: definition.finalWip.part.partCode,
          qtyAvailable: { gt: TOLERANCE },
          ...(uomCode ? { uomCode: { equals: uomCode, mode: "insensitive" } } : { uomCode: null }),
        },
        buildExcludeSpecialRackCondition(),
      ],
    },
    orderBy: [{ lastMovement: "asc" }, { createdAt: "asc" }],
  });
  const available = sources.reduce((sum, row) => sum + number(row.qtyAvailable), 0);
  if (available + TOLERANCE < qtyToConvert) {
    throw Object.assign(
      new Error(`Final WIP ${definition.finalWip.part.partCode} belum cukup untuk receipt ${fgItem.partCode}. Tersedia ${available}, dibutuhkan ${qtyToConvert}.`),
      { statusCode: 409, code: "CHILD_FG_FINAL_WIP_SHORT" },
    );
  }

  let remaining = qtyToConvert;
  const movements = [];
  for (const source of sources) {
    if (remaining <= TOLERANCE) break;
    const qty = Math.min(number(source.qtyAvailable), remaining);
    if (qty <= TOLERANCE) continue;
    await assertStockBalanceNotFrozen(tx, source.id);
    const now = new Date();
    const sourceQtyBefore = number(source.qtyOnHand);
    const sourceQtyAfter = sourceQtyBefore - qty;
    const sourceReserved = number(source.qtyReserved);
    const sourceQc = number(source.qtyQC);
    await tx.stockBalance.update({
      where: { id: source.id },
      data: {
        qtyOnHand: sourceQtyAfter,
        qtyAvailable: Math.max(0, sourceQtyAfter - sourceReserved - sourceQc),
        lastMovement: now,
      },
    });
    const target = await upsertFgBalance(tx, source, definition, qty, uomCode, now);
    const transferGroupId = randomUUID();
    const sourceMovementNumber = await generateMovementNumber("OUT", tx);
    await tx.stockMovement.create({
      data: {
        movementNumber: sourceMovementNumber,
        movementDate: now,
        movementType: "OUT",
        direction: "OUT",
        transactionType: "PRODUCTION",
        warehouseCode: source.warehouseCode,
        rackCode: source.rackCode || null,
        lotNumber: source.lotNumber || null,
        partCode: source.partCode,
        partNumber: source.partNumber || null,
        partName: source.partName || null,
        materialId: source.materialId || null,
        materialCode: source.materialCode || null,
        materialName: source.materialName || null,
        materialType: source.materialType || null,
        productId: source.productId || null,
        description: source.description || null,
        spec: source.spec || null,
        thickness: source.thickness ?? null,
        width: source.width ?? null,
        CSP: source.CSP || null,
        stockType: "WIP",
        qty,
        deltaQty: -qty,
        qtyBefore: sourceQtyBefore,
        qtyAfter: sourceQtyAfter,
        transferGroupId,
        uomCode,
        qualityBucket: "GOOD",
        referenceType: "DAILY_PRODUCTION_SCHEDULE",
        referenceNumber: schedule.scheduleNumber,
        notes: `${marker} consume ${source.partCode}; MPP line ${definition.receiptLine.lineNumber}`,
        performedBy,
      },
    });
    const targetMovementNumber = await generateMovementNumber("IN", tx);
    await tx.stockMovement.create({
      data: {
        movementNumber: targetMovementNumber,
        movementDate: now,
        movementType: "IN",
        direction: "IN",
        transactionType: "PRODUCTION",
        warehouseCode: source.warehouseCode,
        rackCode: source.rackCode || null,
        lotNumber: source.lotNumber || null,
        partCode: definition.header.part.partCode,
        ...target.identity,
        stockType: "Finished Goods",
        qty,
        deltaQty: qty,
        qtyBefore: target.qtyBefore,
        qtyAfter: target.qtyAfter,
        transferGroupId,
        uomCode,
        qualityBucket: "GOOD",
        referenceType: "DAILY_PRODUCTION_SCHEDULE",
        referenceNumber: schedule.scheduleNumber,
        notes: `${marker} receive dari ${source.partCode}; MPP line ${definition.receiptLine.lineNumber}`,
        performedBy,
      },
    });
    movements.push({ sourceMovementNumber, targetMovementNumber, qty, sourcePartCode: source.partCode });
    remaining -= qty;
  }
  return { convertedQty: qtyToConvert - Math.max(0, remaining), movements, definition };
}

module.exports = {
  childFgReceiptMarker,
  materializeChildFgShortage,
  resolveReceiptDefinition,
};
