const router = require("express").Router();
const ctrl = require("../../controllers/production/DowntimeLogController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.get("/generate-number", authorize("productionLogs", "create"), ctrl.generateNumber);

router.get("/", authorize("productionLogs", "read"), ctrl.list);
router.get("/:downtimeNumber", authorize("productionLogs", "read"), ctrl.get);
router.post("/", authorize("productionLogs", "create"), logger("productionLogs", "create-downtime-log", { modelName: "DowntimeLog" }), ctrl.create);
router.patch("/:downtimeNumber", authorize("productionLogs", "update"), logger("productionLogs", "update-downtime-log", { modelName: "DowntimeLog" }), ctrl.update);
router.patch("/:downtimeNumber/remove", authorize("productionLogs", "delete"), logger("productionLogs", "delete-downtime-log", { modelName: "DowntimeLog" }), ctrl.remove);

module.exports = router;
