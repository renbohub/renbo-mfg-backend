"use strict";
const router = require("express").Router();
const { prisma } = require("../../index");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");
const service = require("../../services/planning/customerSupplyService");
const handler = (fn, mutation = false) => async (req, res, next) => {
  try {
    const actor = req.user?.username || req.user?.email || "system";
    const result = mutation
      ? await prisma.$transaction((tx) => fn(tx, req, actor), { isolationLevel: "Serializable", timeout: 30000 })
      : await fn(prisma, req, actor);
    return res.json(result);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message, code: error.code });
    if (["P2034", "P2002"].includes(error.code)) return res.status(409).json({ message: "Data telah berubah atau permintaan sudah diproses. Muat ulang sebelum mencoba lagi." });
    next(error);
  }
};
router.get("/options", authorize("purchaseRequisition", "read"), handler((db) => service.options(db)));
router.get("/mrp/:runNumber", authorize("purchaseRequisition", "read"), handler((db, req) => service.mrpNeeds(db, req.params.runNumber)));
router.get("/", authorize("purchaseRequisition", "read"), handler((db, req) => service.list(db, req.query)));
router.post("/from-mrp", authorize("purchaseRequisition", "create"), logger("customer-supply", "create"), handler((tx, req, actor) => service.createFromMrp(tx, req.body, actor), true));
router.post("/", authorize("purchaseRequisition", "create"), logger("customer-supply", "create"), handler((tx, req, actor) => service.create(tx, { partCode: req.body.partCode, customerCode: req.body.customerCode, uomCode: req.body.uomCode, qtyRequested: req.body.qtyRequested, requiredDate: req.body.requiredDate, notes: req.body.notes, idempotencyKey: req.body.idempotencyKey }, actor), true));
for (const [path, fn, resource, action] of [
  ["/:id/cancel", (tx, req, actor) => service.cancelRequest(tx, req.params.id, req.body, actor), "purchaseRequisition", "update"],
  ["/:id/shipments", (tx, req, actor) => service.addShipment(tx, req.params.id, req.body, actor), "purchaseRequisition", "update"],
  ["/:id/shipments/:shipmentId/confirm", (tx, req, actor) => service.confirmShipment(tx, req.params.id, req.params.shipmentId, req.body, actor), "purchaseRequisition", "update"],
  ["/:id/shipments/:shipmentId/cancel", (tx, req, actor) => service.cancelShipment(tx, req.params.id, req.params.shipmentId, req.body, actor), "purchaseRequisition", "update"],
  ["/:id/shipments/:shipmentId/reschedule", (tx, req, actor) => service.rescheduleShipment(tx, req.params.id, req.params.shipmentId, req.body, actor), "purchaseRequisition", "update"],
  ["/:id/shipments/:shipmentId/receive", (tx, req, actor) => service.receive(tx, req.params.id, req.params.shipmentId, req.body, actor), "purchaseOrder", "create"],
  ["/:id/receipts/:receiptId/inspect", (tx, req, actor) => service.inspectReceipt(tx, req.params.id, req.params.receiptId, req.body, actor), "purchaseOrder", "update"],
  ["/:id/receipts/:receiptId/issue", (tx, req, actor) => service.issue(tx, req.params.id, req.params.receiptId, req.body, actor), "stockBalance", "update"],
]) router.post(path, authorize(resource, action), logger("customer-supply", "update"), handler(fn, true));
module.exports = router;
