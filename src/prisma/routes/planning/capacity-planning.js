const router = require("express").Router();
const ctrl = require("../../controllers/planning/CapacityPlanningController");
const { authorize } = require("../../middleware/auth");

router.get("/plans/:planNumber/check", authorize("monthlyProductionPlan", "read"), ctrl.checkPlan);
router.get("/", authorize("monthlyProductionPlan", "read"), ctrl.snapshot);

module.exports = router;
