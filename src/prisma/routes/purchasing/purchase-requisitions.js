const router = require("express").Router();
const ctrl = require("../../controllers/purchasing/PurchaseRequisitionController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");
const { approvalGate } = require("../../services/approvalRuleService");

const gate = (decision) => approvalGate({ moduleCode: "purchasing", pageCode: "purchase-requisitions", actionCode: "approve", documentType: "PurchaseRequisition", param: "prNumber", model: "purchaseRequisition", lookupField: "prNumber", numberField: "prNumber", decision, requireExistingRequest: true });
router.get("/", authorize("purchaseOrder", "read"), ctrl.list);
router.post("/", authorize("purchaseOrder", "create"), logger("purchaseRequisition", "create"), ctrl.create);
router.post("/consolidate-to-po", authorize("purchaseOrder", "create"), logger("purchaseRequisition", "consolidate-to-po"), ctrl.consolidateToPO);
router.get("/:prNumber", authorize("purchaseOrder", "read"), ctrl.get);
router.patch("/:prNumber", authorize("purchaseOrder", "update"), logger("purchaseRequisition", "update"), ctrl.update);
router.post("/:prNumber/submit", authorize("purchaseOrder", "update"), logger("purchaseRequisition", "submit"), ctrl.submit);
// Frontend workflow proxy historically uses PATCH for PR state transitions.
router.patch("/:prNumber/submit", authorize("purchaseOrder", "update"), logger("purchaseRequisition", "submit"), ctrl.submit);
router.post("/:prNumber/approve", authorize("purchaseOrder", "approve"), gate("Approved"), logger("purchaseRequisition", "approve"), ctrl.approve);
router.patch("/:prNumber/approve", authorize("purchaseOrder", "approve"), gate("Approved"), logger("purchaseRequisition", "approve"), ctrl.approve);
router.post("/:prNumber/reject", authorize("purchaseOrder", "approve"), gate("Rejected"), logger("purchaseRequisition", "reject"), ctrl.reject);
router.patch("/:prNumber/reject", authorize("purchaseOrder", "approve"), gate("Rejected"), logger("purchaseRequisition", "reject"), ctrl.reject);
router.patch("/:prNumber/confirm-suppliers", authorize("purchaseOrder", "update"), logger("purchaseRequisition", "confirm-suppliers"), ctrl.confirmSuppliers);
router.post("/:prNumber/confirm-suppliers", authorize("purchaseOrder", "update"), logger("purchaseRequisition", "confirm-suppliers"), ctrl.confirmSuppliers);
router.post("/:prNumber/convert-to-po", authorize("purchaseOrder", "create"), logger("purchaseRequisition", "convert-to-po"), ctrl.convertToPO);
router.post("/:prNumber/make-po", authorize("purchaseOrder", "create"), logger("purchaseRequisition", "make-po"), ctrl.convertToPO);
router.delete("/:prNumber", authorize("purchaseOrder", "delete"), logger("purchaseRequisition", "delete"), ctrl.remove);
module.exports = router;
