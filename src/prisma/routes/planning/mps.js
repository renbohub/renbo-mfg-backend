const router = require("express").Router();
const ctrl = require("../../controllers/planning/MPSController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");
const { approvalGate } = require("../../services/approvalRuleService");

const mpsApproval = approvalGate({ moduleCode: "planning-ppic", pageCode: "master-production-schedule", actionCode: "approve", documentType: "MPS", param: "mpsNumber", model: "mPS", lookupField: "mpsNumber", numberField: "mpsNumber" });

router.get("/generate-number", authorize("mps", "create"), ctrl.generateNumber);
router.get("/monthly-summary", authorize("mps", "read"), ctrl.monthlySummary);
router.get("/mbom-revision-options", authorize("mps", "read"), ctrl.mbomRevisionOptions);
router.post("/from-forecast", authorize("mps", "create"), logger("mps", "create-from-forecast"), ctrl.createFromForecast);
router.post("/monthly-sync", authorize("mps", "create"), logger("mps", "sync-monthly-demand"), ctrl.syncMonthly);
router.get("/:mpsNumber/readiness", authorize("mps", "read"), ctrl.readiness);
router.post("/:mpsNumber/delivery-phases", authorize("mps", "update"), logger("mps", "create-delivery-phase", { modelName: "MPS", paramKey: "mpsNumber", whereKey: "mpsNumber" }), ctrl.createDeliveryPhase);
router.patch("/:mpsNumber/delivery-phases/:phaseId/remove", authorize("mps", "update"), logger("mps", "remove-delivery-phase", { modelName: "MPS", paramKey: "mpsNumber", whereKey: "mpsNumber" }), ctrl.removeDeliveryPhase);
router.patch("/:mpsNumber/adjustments", authorize("mps", "update"), logger("mps", "update-adjustments", { modelName: "MPS", paramKey: "mpsNumber", whereKey: "mpsNumber" }), ctrl.updateAdjustments);
router.patch("/:mpsNumber/confirm", authorize("mps", "approve"), mpsApproval, logger("mps", "confirm", { modelName: "MPS", paramKey: "mpsNumber", whereKey: "mpsNumber" }), ctrl.confirm);
router.get("/", authorize("mps", "read"), ctrl.list);
router.get("/:mpsNumber", authorize("mps", "read"), ctrl.get);
module.exports = router;
