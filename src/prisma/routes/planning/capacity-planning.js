const router = require("express").Router();
const ctrl = require("../../controllers/planning/CapacityPlanningController");
const { authorize } = require("../../middleware/auth");

router.get("/plans/:planNumber/check", authorize("monthlyProductionPlan", "read"), ctrl.checkPlan);
router.get("/scenarios", authorize("monthlyProductionPlan", "read"), ctrl.getScenarios);
router.put("/scenarios/:scenarioKey", authorize("monthlyProductionPlan", "update"), ctrl.saveScenario);
router.get("/presets", authorize("monthlyProductionPlan", "read"), ctrl.getPresets);
router.post("/presets", authorize("monthlyProductionPlan", "update"), ctrl.createPreset);
router.put("/presets/:presetId", authorize("monthlyProductionPlan", "update"), ctrl.updatePreset);
router.get("/", authorize("monthlyProductionPlan", "read"), ctrl.snapshot);

module.exports = router;
