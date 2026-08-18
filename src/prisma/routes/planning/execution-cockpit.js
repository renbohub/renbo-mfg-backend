const router = require("express").Router();
const ctrl = require("../../controllers/planning/PlanningExecutionCockpitController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.get("/", authorize("mrp", "read"), ctrl.snapshot);
router.post("/:month/close", authorize("mrp", "release"), logger("mrp", "period-close"), ctrl.close);
router.post("/:month/reopen", authorize("mrp", "release"), logger("mrp", "period-reopen"), ctrl.reopen);

module.exports = router;
