const express = require("express");
const ctrl = require("../controllers/supply-chain/SupplyChainReadController");
const { authorize } = require("../middleware/auth");

function readRouter(resource, list, get, param) {
  const router = express.Router();
  router.get("/", authorize(resource, "read"), list);
  router.get(`/:${param}`, authorize(resource, "read"), get);
  return router;
}

module.exports = {
  purchaseRequisitionsRouter: readRouter("purchaseOrder", ctrl.listPurchaseRequisitions, ctrl.getPurchaseRequisition, "prNumber"),
  purchaseInvoicesRouter: readRouter("purchaseOrder", ctrl.listPurchaseInvoices, ctrl.getPurchaseInvoice, "invoiceNumber"),
  goodsReceiptsRouter: readRouter("purchaseOrder", ctrl.listGoodsReceipts, ctrl.getGoodsReceipt, "grNumber"),
  incomingInspectionsRouter: readRouter("purchaseOrder", ctrl.listIncomingInspections, ctrl.getIncomingInspection, "inspectionNumber"),
  supplierDeliveriesRouter: readRouter("purchaseOrder", ctrl.listSupplierDeliveries, ctrl.getSupplierDelivery, "poNumber"),
  putawayRouter: readRouter("purchaseOrder", ctrl.listPutaway, ctrl.getPutaway, "movementNumber"),
  deliveryOrdersRouter: readRouter("salesOrder", ctrl.listDeliveryOrders, ctrl.getDeliveryOrder, "soNumber"),
  deliverySchedulesRouter: readRouter("salesOrder", ctrl.listDeliverySchedules, ctrl.getDeliverySchedule, "scheduleNumber"),
  pickingPackingRouter: readRouter("salesOrder", ctrl.listPickingPacking, ctrl.getPickingPacking, "scheduleNumber"),
  shipmentsRouter: readRouter("salesOrder", ctrl.listShipments, ctrl.getShipment, "scheduleNumber"),
};
