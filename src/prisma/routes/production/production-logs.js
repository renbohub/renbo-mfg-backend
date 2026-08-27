const router = require("express").Router();
const ctrl = require("../../controllers/production/ProductionLogController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");
const { approvalGate } = require("../../services/approvalRuleService");
const productionLogApproval = approvalGate({ moduleCode: "production", pageCode: "production-logs", actionCode: "approve", documentType: "ProductionLog", param: "logNumber", model: "productionLog", lookupField: "logNumber", numberField: "logNumber", amountField: "qtyProduced", requireExistingRequest: true, allowCompletedRequestRetry: true, completedRetryDocumentStatuses: ["Submitted"] });

// Helper routes HARUS di atas /:logNumber
router.get("/generate-number", authorize("productionLogs", "create"), ctrl.generateNumber);
router.get("/hmi-reasons", authorize("productionLogs", "read"), ctrl.hmiReasons);
router.patch("/bulk-remove", authorize("productionLogs", "delete"), logger("productionLogs", "bulk-remove", { modelName: "ProductionLog" }), ctrl.bulkRemove);

// Status transitions
router.patch("/:logNumber/submit",  authorize("productionLogs", "submit"), logger("productionLogs", "submit",  { modelName: "ProductionLog" }), ctrl.submit);
router.patch("/:logNumber/approve", authorize("productionLogs", "approve"), productionLogApproval, logger("productionLogs", "approve", { modelName: "ProductionLog" }), ctrl.approve);
router.patch("/:logNumber/ensure-qc", authorize("qualityInspections", "create"), logger("qualityInspections", "ensure-production-qc"), ctrl.ensureQcRelease);

// Standard CRUD
router.get("/",          authorize("productionLogs", "read"),   ctrl.list);
router.get("/:logNumber", authorize("productionLogs", "read"),  ctrl.get);
router.post("/",          authorize("productionLogs", "create"), logger("productionLogs", "create"), ctrl.create);
router.patch("/:logNumber",        authorize("productionLogs", "update"), logger("productionLogs", "update", { modelName: "ProductionLog" }), ctrl.update);
router.patch("/:logNumber/remove", authorize("productionLogs", "delete"), logger("productionLogs", "delete", { modelName: "ProductionLog" }), ctrl.remove);

module.exports = router;
