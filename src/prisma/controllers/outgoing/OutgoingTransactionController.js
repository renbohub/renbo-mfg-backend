const crypto = require("crypto");
const { prisma } = require("../../index");
const { buildSoLineReferenceNumber } = require("../../services/production/sales-order/soReservationService");
const { syncOperationalSalesOrderStatus } = require("../../services/production/sales-order/soStatusService");
const { resolveDeliveryReadiness } = require("../../services/outgoing/deliveryReadinessService");
const { assertStockBalanceNotFrozen } = require("../inventory/utils/stockOpnameFreezeGuard");
const scheduleNumber = () => `DS-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const numberValue = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

exports.deliveryBoard = async (req, res, next) => {
  try {
    const today = new Date();
    const defaultFrom = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const defaultTo = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0, 23, 59, 59, 999));
    const from = req.query.from ? new Date(`${req.query.from}T00:00:00.000Z`) : defaultFrom;
    const to = req.query.to ? new Date(`${req.query.to}T23:59:59.999Z`) : defaultTo;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return res.status(400).json({ message: "Periode delivery board tidak valid" });

    const schedules = await prisma.deliverySchedule.findMany({
      where: {
        isDeleted: false,
        status: { notIn: ["Cancelled", "Failed"] },
        plannedDate: { gte: from, lte: to },
      },
      include: {
        soHeader: { select: { customerCode: true, customerName: true } },
        details: {
          where: { isDeleted: false },
          include: { soDetail: true },
          orderBy: { lineNumber: "asc" },
        },
      },
      orderBy: [{ plannedDate: "asc" }, { scheduleNumber: "asc" }],
      take: 1500,
    });

    const rows = schedules.flatMap((schedule) => schedule.details.map((detail) => ({
      itemType: "FINISHED_GOOD",
      scheduleNumber: schedule.scheduleNumber,
      soNumber: schedule.soNumber,
      customerCode: schedule.soHeader?.customerCode,
      customerName: schedule.soHeader?.customerName || schedule.soHeader?.customerCode || "Customer belum ditentukan",
      partCode: detail.soDetail?.partCode || detail.soDetail?.partNumber || "-",
      partNumber: detail.soDetail?.partNumber,
      partName: detail.soDetail?.partName,
      plannedAt: schedule.plannedDate,
      actualAt: schedule.actualDate || schedule.deliveredAt,
      plannedQty: numberValue(detail.qty),
      deliveredQty: numberValue(detail.qtyDelivered),
      outstandingQty: Math.max(numberValue(detail.qty) - numberValue(detail.qtyDelivered), 0),
      uomCode: detail.soDetail?.uomCode,
      status: schedule.status,
      shippingMethod: schedule.shippingMethod,
      vehicle: schedule.vehicle,
    })));

    res.json({
      period: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      generatedAt: new Date(),
      rows,
    });
  } catch (error) { next(error); }
};

async function consumeSalesReservations(tx, soNumber, soDetail, qty, performedBy) {
  let remaining = Number(qty || 0);
  const referenceNumber = buildSoLineReferenceNumber(soNumber, soDetail.lineNumber);
  const reservations = await tx.stockReservation.findMany({
    where: {
      referenceType: "SO",
      referenceNumber,
      status: "Active",
      isDeleted: false,
      stockBalance: { is: { stockType: { in: ["Finished Goods", "FG"] }, isDeleted: false } },
    },
    orderBy: { createdAt: "asc" },
    include: { stockBalance: true },
  });
  for (const reservation of reservations) {
    if (remaining <= 0) break;
    const open = Math.max(0, Number(reservation.qtyReserved || 0) - Number(reservation.qtyReleased || 0));
    const available = Number(reservation.stockBalance?.qtyOnHand || 0);
    const take = Math.min(remaining, open, available);
    if (take <= 0) continue;
    const balance = reservation.stockBalance;
    await assertStockBalanceNotFrozen(tx, balance.id);
    const qtyBefore = Number(balance.qtyOnHand || 0);
    const qtyAfter = qtyBefore - take;
    const reservedAfter = Math.max(0, Number(balance.qtyReserved || 0) - take);
    await tx.stockBalance.update({ where: { id: balance.id }, data: { qtyOnHand: qtyAfter, qtyReserved: reservedAfter, qtyAvailable: Math.max(0, qtyAfter - reservedAfter - Number(balance.qtyQC || 0)), lastMovement: new Date() } });
    const releasedAfter = Number(reservation.qtyReleased || 0) + take;
    await tx.stockReservation.update({ where: { id: reservation.id }, data: { qtyReleased: releasedAfter, status: releasedAfter + 0.0001 >= Number(reservation.qtyReserved || 0) ? "Released" : "Active" } });
    await tx.stockMovement.create({ data: { movementNumber: `OUT-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, movementDate: new Date(), movementType: "OUT", direction: "OUT", transactionType: "SALES", warehouseCode: balance.warehouseCode, rackCode: balance.rackCode || null, lotNumber: balance.lotNumber || null, partCode: balance.partCode, partNumber: balance.partNumber || null, partName: balance.partName || null, materialId: balance.materialId || null, materialCode: balance.materialCode || null, materialName: balance.materialName || null, materialType: balance.materialType || null, productId: balance.productId || null, description: balance.description || null, spec: balance.spec || null, thickness: balance.thickness ?? null, width: balance.width ?? null, CSP: balance.CSP || null, stockType: balance.stockType || "Finished Goods", qty: take, deltaQty: -take, qtyBefore, qtyAfter, uomCode: balance.uomCode || soDetail.uomCode || null, qualityBucket: "GOOD", referenceType: "DELIVERY_SCHEDULE", referenceNumber: soNumber, notes: `Outbound otomatis untuk ${soNumber} / line ${soDetail.lineNumber}`, performedBy: performedBy || "system" } });
    remaining -= take;
  }
  if (remaining > 0.0001) throw Object.assign(new Error(`Stok/reservation FG tidak cukup untuk SO ${soNumber} line ${soDetail.lineNumber}. Kekurangan ${remaining}.`), { statusCode: 409 });
}

async function transitionSchedule(scheduleNumber, expectedStatus, data) {
  return prisma.$transaction(async (tx) => {
    const schedule = await tx.deliverySchedule.findFirst({ where: { scheduleNumber, status: expectedStatus, isDeleted: false } });
    if (!schedule) throw Object.assign(new Error(`Delivery Schedule must be ${expectedStatus} before this action`), { statusCode: 409 });
    return tx.deliverySchedule.update({ where: { id: schedule.id }, data });
  });
}

exports.createSchedule = async (req, res, next) => {
  try {
    const { soNumber, plannedDate, details = [], deliveryAddress, shippingMethod, notes } = req.body;
    if (!soNumber || !plannedDate || !details.length) return res.status(400).json({ message: "soNumber, plannedDate, and details are required" });
    const item = await prisma.$transaction(async (tx) => {
      const so = await tx.salesOrderHeader.findFirst({ where: { soNumber, isDeleted: false }, include: { details: { where: { isDeleted: false } } } });
      if (!so) throw Object.assign(new Error("Sales Order not found"), { statusCode: 404 });
      if (!["Confirmed", "Approved", "Ready to Deliver", "In Progress"].includes(so.status)) throw Object.assign(new Error(`Sales Order harus Confirmed/Approved sebelum Delivery Schedule. Status saat ini ${so.status}.`), { statusCode: 409 });
      const number = scheduleNumber();
      const scheduleDetails = details.map((line, index) => {
        const soDetail = so.details.find((detail) => detail.id === line.soDetailId);
        if (!soDetail || Number(line.qty) <= 0) throw Object.assign(new Error(`Invalid delivery detail at line ${index + 1}`), { statusCode: 400 });
        const remaining = Number(soDetail.qty || 0) - Number(soDetail.qtyDelivered || 0);
        if (Number(line.qty) > remaining) throw Object.assign(new Error(`Delivery quantity exceeds outstanding SO on line ${index + 1}`), { statusCode: 409 });
        return { soDetailId: soDetail.id, lineNumber: index + 1, qty: Number(line.qty), notes: line.notes || null };
      });
      for (const line of scheduleDetails) {
        const reserved = await tx.deliveryScheduleDetail.aggregate({ where: { soDetailId: line.soDetailId, isDeleted: false, schedule: { is: { isDeleted: false, status: { notIn: ["Cancelled", "Failed"] } } } }, _sum: { qty: true } });
        const soDetail = so.details.find((detail) => detail.id === line.soDetailId);
        if (Number(reserved._sum.qty || 0) + line.qty > Number(soDetail.qty || 0)) throw Object.assign(new Error(`Delivery quantity is already allocated on SO line ${line.lineNumber}`), { statusCode: 409 });
      }
      return tx.deliverySchedule.create({ data: { scheduleNumber: number, soNumber, plannedDate: new Date(plannedDate), deliveryAddress: deliveryAddress || so.shippingAddress || null, shippingMethod: shippingMethod || null, notes: notes || null, details: { create: scheduleDetails } }, include: { details: true } });
    });
    res.status(201).json(item);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.markShipment = async (req, res, next) => {
  try {
    const item = await prisma.$transaction(async (tx) => {
      const schedule = await tx.deliverySchedule.findFirst({
        where: { scheduleNumber: req.params.scheduleNumber, status: "On Process", isDeleted: false },
      });
      if (!schedule) {
        throw Object.assign(new Error("Delivery Schedule must be On Process before this action"), { statusCode: 409 });
      }
      const readiness = await resolveDeliveryReadiness(tx, schedule.scheduleNumber, {
        reserveShortage: true,
        performedBy: req.user?.username || req.user?.email || "system",
      });
      if (!readiness.fgReady) {
        throw Object.assign(new Error(readiness.fgReadinessMessage), { statusCode: 409 });
      }
      return tx.deliverySchedule.update({
        where: { id: schedule.id },
        data: { status: "In Transit", actualDate: new Date(), shippedAt: new Date(), trackingNumber: req.body.trackingNumber || null, shippingMethod: req.body.shippingMethod || undefined, vehicle: req.body.vehicle || null, driver: req.body.driver || null, carrier: req.body.carrier || null, deliveredBy: req.user?.username || req.user?.email || null },
      });
    });
    res.json(item);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.pick = async (req, res, next) => {
  try {
    const item = await transitionSchedule(req.params.scheduleNumber, "Scheduled", { status: "On Process", pickedAt: new Date(), notes: req.body.notes || undefined });
    res.json(item);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.pack = async (req, res, next) => {
  try {
    const item = await transitionSchedule(req.params.scheduleNumber, "On Process", { packedAt: new Date(), notes: req.body.notes || undefined });
    res.json(item);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.confirmPod = async (req, res, next) => {
  try {
    const item = await prisma.$transaction(async (tx) => {
      const schedule = await tx.deliverySchedule.findFirst({ where: { scheduleNumber: req.params.scheduleNumber, status: "In Transit", isDeleted: false }, include: { details: { include: { soDetail: true } }, soHeader: true } });
      if (!schedule) throw Object.assign(new Error("Shipment in transit not found"), { statusCode: 409 });
      for (const detail of schedule.details) {
        await consumeSalesReservations(tx, schedule.soNumber, detail.soDetail, detail.qty, req.user?.username || req.user?.email || "system");
        await tx.deliveryScheduleDetail.update({ where: { id: detail.id }, data: { qtyDelivered: detail.qty } });
        await tx.salesOrderDetail.update({ where: { id: detail.soDetailId }, data: { qtyDelivered: { increment: detail.qty } } });
      }
      const delivered = await tx.deliverySchedule.update({ where: { id: schedule.id }, data: { status: "Delivered", deliveredAt: new Date(), receivedBy: req.body.receivedBy || null, receivedSignature: req.body.receivedSignature || null, podUrl: req.body.podUrl || null } });
      await syncOperationalSalesOrderStatus(tx, schedule.soNumber);
      return delivered;
    });
    res.json(item);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.markFailed = async (req, res, next) => {
  try {
    if (!req.body.failureReason) return res.status(400).json({ message: "failureReason is required" });
    const item = await transitionSchedule(req.params.scheduleNumber, "In Transit", { status: "Failed", failureReason: req.body.failureReason, returnedQty: Number(req.body.returnedQty || 0), notes: req.body.notes || undefined });
    res.json(item);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};
