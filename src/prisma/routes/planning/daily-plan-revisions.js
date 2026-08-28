const router = require("express").Router();
const ctrl = require("../../controllers/planning/DailyPlanRevisionController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.get("/workspace", authorize("monthlyProductionPlan", "read"), ctrl.workspace);
router.post("/auto-correct", authorize("monthlyProductionPlan", "update"), logger("dailyPlanRevision", "auto-correct-placement"), ctrl.autoCorrectPlacement);
router.post("/", authorize("monthlyProductionPlan", "update"), logger("dailyPlanRevision", "create"), ctrl.create);
router.patch("/:revisionId/items/:scheduleId", authorize("monthlyProductionPlan", "update"), logger("dailyPlanRevision", "update-item"), ctrl.updateItem);
router.post("/:revisionId/items/:scheduleId/release", authorize("monthlyProductionPlan", "release"), logger("dailyPlanRevision", "release-item"), ctrl.releaseItem);
router.post("/:revisionId/validate", authorize("monthlyProductionPlan", "update"), logger("dailyPlanRevision", "validate"), ctrl.validate);
router.post("/:revisionId/release", authorize("monthlyProductionPlan", "release"), logger("dailyPlanRevision", "release"), ctrl.release);

module.exports = router;
