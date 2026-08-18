const router = require("express").Router();
const ctrl = require("../../controllers/production/ProductionNgDispositionController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.get("/", authorize("qualityInspections", "read"), ctrl.list);
router.get("/:id", authorize("qualityInspections", "read"), ctrl.get);
router.patch("/:id/judge", authorize("qualityInspections", "approve"), logger("qualityInspections", "ng-judgment"), ctrl.judge);

module.exports = router;
