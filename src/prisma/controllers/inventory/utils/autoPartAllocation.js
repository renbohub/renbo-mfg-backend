const { generateReservationNumber } = require("./stockReservationHelpers");

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

/**
 * Reserve newly received material automatically when its Material Master is
 * linked to exactly one active RAW MATERIAL part. Materials shared by two or
 * more parts remain free stock and must be allocated manually.
 */
async function autoAllocateMaterialReceipt(tx, {
  stockBalanceId,
  receivedQty,
  reservationDate = new Date(),
  sourceType = "STOCK_RECEIPT",
  sourceNumber = null,
} = {}) {
  const requestedQty = number(receivedQty);
  if (!stockBalanceId || requestedQty <= 0) return { allocated: false, reason: "NO_RECEIPT_QTY" };

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`AUTO_PART_ALLOCATION|${stockBalanceId}`}, 0))`;
  const stock = await tx.stockBalance.findFirst({
    where: { id: stockBalanceId, isDeleted: false },
  });
  if (!stock || stock.stockType !== "Material" || !stock.materialId) {
    return { allocated: false, reason: "NOT_MATERIAL_STOCK" };
  }

  const targetParts = await tx.part.findMany({
    where: {
      isDeleted: false,
      status: { not: "Inactive" },
      itemType: "RAW",
      rawType: "MATERIAL",
      materialId: stock.materialId,
    },
    select: { partCode: true, partNumber: true, partName: true },
    orderBy: [{ partNumber: "asc" }, { partCode: "asc" }],
    take: 2,
  });
  if (targetParts.length !== 1) {
    return { allocated: false, reason: targetParts.length ? "MULTIPLE_TARGET_PARTS" : "NO_TARGET_PART" };
  }

  const qty = Math.min(requestedQty, Math.max(number(stock.qtyAvailable), 0));
  if (qty <= 0) return { allocated: false, reason: "NO_FREE_RECEIPT_QTY" };

  const target = targetParts[0];
  const effectiveDate = new Date(reservationDate);
  const safeDate = Number.isNaN(effectiveDate.getTime()) ? new Date() : effectiveDate;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`STOCK_RESERVATION_NUMBER|${safeDate.toISOString().slice(0, 10)}`}, 0))`;
  const reservationNumber = await generateReservationNumber(tx, safeDate);

  await tx.stockBalance.update({
    where: { id: stock.id },
    data: {
      qtyReserved: number(stock.qtyReserved) + qty,
      qtyAvailable: Math.max(number(stock.qtyAvailable) - qty, 0),
    },
  });
  const reservation = await tx.stockReservation.create({
    data: {
      reservationNumber,
      reservationDate: safeDate,
      stockBalanceId: stock.id,
      warehouseCode: stock.warehouseCode,
      rackCode: stock.rackCode,
      lotNumber: stock.lotNumber,
      partCode: stock.partCode,
      partNumber: stock.partNumber,
      partName: stock.partName,
      materialId: stock.materialId,
      materialCode: stock.materialCode,
      materialName: stock.materialName,
      materialType: stock.materialType,
      targetPartCode: target.partCode,
      targetPartNumber: target.partNumber,
      targetPartName: target.partName,
      productId: stock.productId,
      description: stock.description,
      spec: stock.spec,
      thickness: stock.thickness,
      width: stock.width,
      CSP: stock.CSP,
      qtyReserved: qty,
      referenceType: "PART_ALLOCATION",
      referenceNumber: target.partCode,
      notes: [`[AUTO-PART-ALLOCATION] ${stock.materialCode || stock.materialId} -> ${target.partCode}`, sourceNumber ? `${sourceType}: ${sourceNumber}` : sourceType].filter(Boolean).join(" | "),
    },
  });

  return { allocated: true, qty, targetPartCode: target.partCode, reservationNumber: reservation.reservationNumber };
}

module.exports = { autoAllocateMaterialReceipt };
