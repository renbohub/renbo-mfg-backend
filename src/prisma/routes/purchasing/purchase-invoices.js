const router = require("express").Router();
const controller = require("../../controllers/purchasing/PurchaseInvoiceController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");
const { approvalGate } = require("../../services/approvalRuleService");

const invoiceApproval = approvalGate({
  moduleCode: "purchasing",
  pageCode: "purchase-invoices",
  actionCode: "approve",
  documentType: "PurchaseInvoice",
  param: "invoiceNumber",
  model: "purchaseInvoice",
  lookupField: "invoiceNumber",
  numberField: "invoiceNumber",
});

router.get("/", authorize("purchaseOrder", "read"), controller.list);
router.get("/:invoiceNumber", authorize("purchaseOrder", "read"), controller.get);
router.post("/", authorize("purchaseOrder", "create"), logger("purchaseInvoice", "create"), controller.create);
router.patch("/:invoiceNumber", authorize("purchaseOrder", "update"), logger("purchaseInvoice", "update"), controller.update);
router.patch("/:invoiceNumber/submit", authorize("purchaseOrder", "update"), logger("purchaseInvoice", "submit"), controller.submit);
router.patch("/:invoiceNumber/approve", authorize("purchaseOrder", "approve"), invoiceApproval, logger("purchaseInvoice", "approve"), controller.approve);
router.patch("/:invoiceNumber/post", authorize("purchaseOrder", "approve"), logger("purchaseInvoice", "post"), controller.post);
router.patch("/:invoiceNumber/pay", authorize("purchaseOrder", "approve"), logger("purchaseInvoice", "pay"), controller.pay);
router.delete("/:invoiceNumber", authorize("purchaseOrder", "delete"), logger("purchaseInvoice", "delete"), controller.remove);

module.exports = router;
