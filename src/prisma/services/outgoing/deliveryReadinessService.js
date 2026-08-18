const {
  buildSoLineReferenceNumber,
} = require("../production/sales-order/soReservationService");
const {
  buildExcludeSpecialRackCondition,
  generateReservationNumber,
} = require("../../controllers/inventory/utils/stockReservationHelpers");
const {
  assertStockBalanceNotFrozen,
} = require("../../controllers/inventory/utils/stockOpnameFreezeGuard");

const TOLERANCE = 0.000001;
const FG_STOCK_TYPES = ["Finished Goods", "FG"];
const qty = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const roundQty = (value) => Math.round((qty(value) + Number.EPSILON) * 1000000) / 1000000;

async function reserveFreeFinishedGoods(tx, schedule, detail, shortageQty, performedBy) {
  let remaining = roundQty(shortageQty);
  if (remaining <= TOLERANCE) return;

  const balances = await tx.stockBalance.findMany({
    where: {
      AND: [
        {
          partCode: detail.soDetail.partCode,
          ...(detail.soDetail.uomCode ? { uomCode: detail.soDetail.uomCode } : {}),
          stockType: { in: FG_STOCK_TYPES },
          qtyAvailable: { gt: 0 },
          isDeleted: false,
        },
        buildExcludeSpecialRackCondition(),
      ],
    },
    orderBy: [{ lastMovement: "asc" }, { createdAt: "asc" }],
  });

  for (const balance of balances) {
    if (remaining <= TOLERANCE) break;
    const take = roundQty(Math.min(remaining, qty(balance.qtyAvailable)));
    if (take <= TOLERANCE) continue;
    await assertStockBalanceNotFrozen(tx, balance.id);
    const reservationNumber = await generateReservationNumber(tx, new Date());
    const referenceNumber = buildSoLineReferenceNumber(schedule.soNumber, detail.soDetail.lineNumber);
    await tx.stockReservation.create({
      data: {
        reservationNumber,
        reservationDate: new Date(),
        stockBalanceId: balance.id,
        warehouseCode: balance.warehouseCode,
        rackCode: balance.rackCode || null,
        lotNumber: balance.lotNumber || null,
        partCode: balance.partCode,
        partNumber: balance.partNumber || detail.soDetail.partNumber || null,
        partName: balance.partName || detail.soDetail.partName || null,
        productId: balance.productId || null,
        description: balance.description || null,
        spec: balance.spec || null,
        thickness: balance.thickness ?? null,
        width: balance.width ?? null,
        CSP: balance.CSP || null,
        qtyReserved: take,
        qtyReleased: 0,
        referenceType: "SO",
        referenceNumber,
        status: "Active",
        notes: `[AUTO-DELIVERY] Reserved saat shipment ${schedule.scheduleNumber} oleh ${performedBy || "system"}`,
      },
    });
    await tx.stockBalance.update({
      where: { id: balance.id },
      data: {
        qtyReserved: { increment: take },
        qtyAvailable: { decrement: take },
        lastMovement: new Date(),
      },
    });
    remaining = roundQty(remaining - take);
  }
}

async function resolveDeliveryReadiness(tx, scheduleNumber, options = {}) {
  const schedule = await tx.deliverySchedule.findFirst({
    where: { scheduleNumber, isDeleted: false },
    include: {
      details: {
        where: { isDeleted: false },
        orderBy: { lineNumber: "asc" },
        include: { soDetail: true },
      },
    },
  });
  if (!schedule) {
    throw Object.assign(new Error("Delivery Schedule tidak ditemukan."), { statusCode: 404 });
  }

  const lineResults = [];
  for (const detail of schedule.details) {
    const requiredQty = roundQty(Math.max(0, qty(detail.qty) - qty(detail.qtyDelivered)));
    const referenceNumber = buildSoLineReferenceNumber(schedule.soNumber, detail.soDetail.lineNumber);
    const reservations = await tx.stockReservation.findMany({
      where: { referenceType: "SO", referenceNumber, status: "Active", isDeleted: false },
      include: { stockBalance: true },
      orderBy: { createdAt: "asc" },
    });
    let reservedQty = roundQty(reservations.reduce((sum, reservation) => {
      if (!FG_STOCK_TYPES.includes(reservation.stockBalance?.stockType)) return sum;
      const open = Math.max(0, qty(reservation.qtyReserved) - qty(reservation.qtyReleased));
      return sum + Math.min(open, qty(reservation.stockBalance?.qtyOnHand));
    }, 0));

    if (options.reserveShortage && reservedQty + TOLERANCE < requiredQty) {
      await reserveFreeFinishedGoods(tx, schedule, detail, requiredQty - reservedQty, options.performedBy);
      const refreshed = await tx.stockReservation.findMany({
        where: { referenceType: "SO", referenceNumber, status: "Active", isDeleted: false },
        include: { stockBalance: true },
      });
      reservedQty = roundQty(refreshed.reduce((sum, reservation) => {
        if (!FG_STOCK_TYPES.includes(reservation.stockBalance?.stockType)) return sum;
        const open = Math.max(0, qty(reservation.qtyReserved) - qty(reservation.qtyReleased));
        return sum + Math.min(open, qty(reservation.stockBalance?.qtyOnHand));
      }, 0));
    }

    const free = await tx.stockBalance.aggregate({
      where: {
        AND: [
          {
            partCode: detail.soDetail.partCode,
            ...(detail.soDetail.uomCode ? { uomCode: detail.soDetail.uomCode } : {}),
            stockType: { in: FG_STOCK_TYPES },
            qtyAvailable: { gt: 0 },
            isDeleted: false,
          },
          buildExcludeSpecialRackCondition(),
        ],
      },
      _sum: { qtyAvailable: true },
    });
    const freeQty = roundQty(free._sum.qtyAvailable);
    const availableQty = roundQty(reservedQty + freeQty);
    const shortageQty = roundQty(Math.max(0, requiredQty - availableQty));
    lineResults.push({
      lineNumber: detail.lineNumber,
      soLineNumber: detail.soDetail.lineNumber,
      partCode: detail.soDetail.partCode,
      partNumber: detail.soDetail.partNumber,
      partName: detail.soDetail.partName,
      uomCode: detail.soDetail.uomCode,
      requiredQty,
      reservedQty,
      freeQty,
      availableQty,
      shortageQty,
      ready: shortageQty <= TOLERANCE,
    });
  }

  const blockedLines = lineResults.filter((line) => !line.ready);
  const fgRequiredQty = roundQty(lineResults.reduce((sum, line) => sum + line.requiredQty, 0));
  const fgAvailableQty = roundQty(lineResults.reduce((sum, line) => sum + line.availableQty, 0));
  const fgShortageQty = roundQty(lineResults.reduce((sum, line) => sum + line.shortageQty, 0));
  const fgReady = blockedLines.length === 0;
  return {
    fgReady,
    fgRequiredQty,
    fgAvailableQty,
    fgShortageQty,
    fgReadinessCode: fgReady ? "READY" : "WAITING_FG_RECEIPT",
    fgReadinessMessage: fgReady
      ? `FG cukup untuk shipment ${schedule.scheduleNumber}.`
      : `Shipment belum dapat dikirim. Menunggu FG Receipt/stock: ${blockedLines.map((line) => `${line.partCode || "-"} kurang ${line.shortageQty} ${line.uomCode || ""}`).join(", ")}.`,
    fgLines: lineResults,
  };
}

module.exports = { resolveDeliveryReadiness };
