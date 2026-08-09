const router = require("express").Router();
const ctrl = require("../../controllers/inventory/StockOpnameController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");
const { approvalGate } = require("../../services/approvalRuleService");
const stockOpnameApproval = approvalGate({ moduleCode: "inventory", pageCode: "stock-opname", actionCode: "approve", documentType: "StockOpnameHeader", param: "stoNo", model: "stockOpnameHeader", lookupField: "stoNo", numberField: "stoNo", requireExistingRequest: true });

router.get("/", authorize("stockOpname", "read"), ctrl.list);
router.get("/:stoNo", authorize("stockOpname", "read"), ctrl.get);
router.post("/", authorize("stockOpname", "create"), logger("stockOpname", "create"), ctrl.create);
router.patch("/:stoNo/start-counting", authorize("stockOpname", "update"), logger("stockOpname", "start-counting"), ctrl.startCounting);
router.patch("/:stoNo/details/:detailId/count", authorize("stockOpname", "update"), logger("stockOpname", "count-detail"), ctrl.countDetail);
router.patch("/:stoNo/blind-count", authorize("stockOpname", "update"), logger("stockOpname", "blind-count"), ctrl.blindCount);
router.patch("/:stoNo/bulk-count", authorize("stockOpname", "update"), logger("stockOpname", "bulk-count"), ctrl.bulkCount);
router.patch("/:stoNo/submit", authorize("stockOpname", "submit"), logger("stockOpname", "submit"), ctrl.submit);
router.patch("/:stoNo/approve", authorize("stockOpname", "approve"), stockOpnameApproval, logger("stockOpname", "approve"), ctrl.approve);
router.patch("/:stoNo/request-recount", authorize("stockOpname", "approve"), logger("stockOpname", "request-recount"), ctrl.requestRecount);
router.patch("/:stoNo/adjust", authorize("stockOpname", "adjust"), logger("stockOpname", "adjust"), ctrl.adjust);
router.patch("/:stoNo/close", authorize("stockOpname", "update"), logger("stockOpname", "close"), ctrl.close);
router.patch("/:stoNo/cancel", authorize("stockOpname", "update"), logger("stockOpname", "cancel"), ctrl.cancel);

module.exports = router;
