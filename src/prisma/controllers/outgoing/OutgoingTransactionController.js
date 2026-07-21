const crypto = require("crypto");
const { prisma } = require("../../index");
const scheduleNumber = () => `DS-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

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
    const item = await transitionSchedule(req.params.scheduleNumber, "On Process", { status: "In Transit", actualDate: new Date(), shippedAt: new Date(), trackingNumber: req.body.trackingNumber || null, shippingMethod: req.body.shippingMethod || undefined, vehicle: req.body.vehicle || null, driver: req.body.driver || null, carrier: req.body.carrier || null, deliveredBy: req.user?.username || req.user?.email || null });
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
      const schedule = await tx.deliverySchedule.findFirst({ where: { scheduleNumber: req.params.scheduleNumber, status: "In Transit", isDeleted: false }, include: { details: true } });
      if (!schedule) throw Object.assign(new Error("Shipment in transit not found"), { statusCode: 409 });
      await Promise.all(schedule.details.map((detail) => tx.deliveryScheduleDetail.update({ where: { id: detail.id }, data: { qtyDelivered: detail.qty } }).then(() => tx.salesOrderDetail.update({ where: { id: detail.soDetailId }, data: { qtyDelivered: { increment: detail.qty } } }))));
      return tx.deliverySchedule.update({ where: { id: schedule.id }, data: { status: "Delivered", deliveredAt: new Date(), receivedBy: req.body.receivedBy || null, receivedSignature: req.body.receivedSignature || null, podUrl: req.body.podUrl || null } });
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
