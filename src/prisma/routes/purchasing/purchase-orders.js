const router = require("express").Router();
const ctrl = require("../../controllers/purchasing/PurchaseOrderController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");
const { uploadQuotationFiles } = require("../../middleware/uploads");
const { approvalGate } = require("../../services/approvalRuleService");

const purchaseOrderApproval = approvalGate({ moduleCode: "purchasing", pageCode: "purchase-order", actionCode: "approve", documentType: "PurchaseOrder", param: "poNumber", model: "purchaseOrder", lookupField: "poNumber", numberField: "poNumber" });
const purchaseOrderRejection = approvalGate({ moduleCode: "purchasing", pageCode: "purchase-order", actionCode: "approve", documentType: "PurchaseOrder", param: "poNumber", model: "purchaseOrder", lookupField: "poNumber", numberField: "poNumber", decision: "Rejected" });

// Helper routes di atas /:id/:poNumber agar tidak tertangkap sebagai ID
router.get("/generate-number", authorize("purchaseOrder", "create"), ctrl.generateNumber);
router.get("/by-number", authorize("purchaseOrder", "read"), ctrl.get);
router.patch("/bulk-remove", authorize("purchaseOrder", "delete"), logger("purchaseOrder", "bulk-remove", { modelName: 'purchaseOrder' }), ctrl.bulkRemove);

// Standard CRUD (logger untuk semua CUD operations)
router.get("/", authorize("purchaseOrder", "read"), ctrl.list);
router.get("/:poNumber/revisions", authorize("purchaseOrder", "read"), ctrl.revisionHistory);
router.post("/:poNumber/revisions/:commentId/replies", authorize("purchaseOrder", "read"), logger("purchaseOrder", "reply-revision", {
  paramKey: 'poNumber',
  entityField: 'poNumber',
}), ctrl.replyRevisionComment);
router.get("/:poNumber", authorize("purchaseOrder", "read"), ctrl.get);
router.post("/", authorize("purchaseOrder", "create"), uploadQuotationFiles, logger("purchaseOrder", "create"), ctrl.create);
router.patch("/:id", authorize("purchaseOrder", "update"), uploadQuotationFiles, logger("purchaseOrder", "update", {
  modelName: 'purchaseOrder',
  entityField: 'poNumber',
  includeOptions: {
    details: {
      where: { isDeleted: false }
    }
  }
}), ctrl.update);
router.patch("/:poNumber/send", authorize("purchaseOrder", "update"), logger("purchaseOrder", "send", {
  paramKey: 'poNumber',
  entityField: 'poNumber',
}), ctrl.send);
router.patch("/:poNumber/confirm", authorize("purchaseOrder", "approve"), logger("purchaseOrder", "confirm", {
  paramKey: 'poNumber',
  entityField: 'poNumber',
}), ctrl.confirm);
router.patch("/:poNumber/submit-checking", authorize("purchaseOrder", "update"), logger("purchaseOrder", "submit-checking", {
  paramKey: 'poNumber',
  entityField: 'poNumber',
}), ctrl.submitChecking);
router.patch("/:poNumber/approve", authorize("purchaseOrder", "approve"), purchaseOrderApproval, logger("purchaseOrder", "approve", {
  paramKey: 'poNumber',
  entityField: 'poNumber',
}), ctrl.approve);
router.patch("/:poNumber/revise", authorize("purchaseOrder", "approve"), logger("purchaseOrder", "revise", {
  paramKey: 'poNumber',
  entityField: 'poNumber',
}), ctrl.revise);
router.patch("/:poNumber/reject", authorize("purchaseOrder", "approve"), purchaseOrderRejection, logger("purchaseOrder", "reject", {
  paramKey: 'poNumber',
  entityField: 'poNumber',
}), ctrl.reject);
router.patch("/:poNumber/manual-complete", authorize("purchaseOrder", "manual-complete"), logger("purchaseOrder", "manual-complete", {
  paramKey: 'poNumber',
  entityField: 'poNumber',
}), ctrl.manualComplete);
router.patch("/:poNumber/cancel", authorize("purchaseOrder", "approve"), logger("purchaseOrder", "cancel", {
  paramKey: 'poNumber',
  entityField: 'poNumber',
}), ctrl.cancel);
router.delete("/:poNumber", authorize("purchaseOrder", "delete"), logger("purchaseOrder", "delete", {
  paramKey: 'poNumber',
  entityField: 'poNumber',
}), ctrl.remove);

module.exports = router;
