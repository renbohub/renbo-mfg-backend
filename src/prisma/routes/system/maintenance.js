const router = require("express").Router();
const ctrl = require("../../controllers/system/MaintenanceController");
const { requireSuperAdmin } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.get("/planning-flow/status", requireSuperAdmin, ctrl.getPlanningFlowResetStatus);
router.post("/planning-flow/reset", requireSuperAdmin, logger("planningFlow", "delete"), ctrl.resetPlanningFlow);

router.get("/demand-flow/status", requireSuperAdmin, ctrl.getDemandResetStatus);
router.post("/demand-flow/reset", requireSuperAdmin, logger("demandFlow", "delete"), ctrl.resetDemandFlow);

module.exports = router;
