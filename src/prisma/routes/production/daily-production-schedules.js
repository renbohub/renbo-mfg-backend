const router = require("express").Router();
const ctrl = require("../../controllers/production/DailyProductionScheduleController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.get("/generate-number", authorize("dailyProductionSchedules", "create"), ctrl.generateNumber);
router.post("/dispatch-from-work-orders", authorize("dailyProductionSchedules", "dispatch"), logger("dailyProductionSchedules", "dispatch"), ctrl.dispatchFromWorkOrders);
router.post("/:scheduleNumber/consume", authorize("dailyProductionSchedules", "release"), logger("dailyProductionSchedules", "consume"), ctrl.consume);
router.post("/:scheduleNumber/release", authorize("dailyProductionSchedules", "release"), logger("dailyProductionSchedules", "release"), ctrl.release);
router.post("/:scheduleNumber/start", authorize("dailyProductionSchedules", "start"), logger("dailyProductionSchedules", "start"), ctrl.start);
router.post("/:scheduleNumber/complete", authorize("dailyProductionSchedules", "complete"), logger("dailyProductionSchedules", "complete"), ctrl.complete);
router.post("/:scheduleNumber/cancel", authorize("dailyProductionSchedules", "cancel"), logger("dailyProductionSchedules", "cancel"), ctrl.cancel);

router.get("/", authorize("dailyProductionSchedules", "read"), ctrl.list);
router.get("/:scheduleNumber", authorize("dailyProductionSchedules", "read"), ctrl.get);
router.post("/", authorize("dailyProductionSchedules", "create"), logger("dailyProductionSchedules", "create"), ctrl.create);
router.patch("/:scheduleNumber", authorize("dailyProductionSchedules", "update"), logger("dailyProductionSchedules", "update"), ctrl.update);
router.patch("/:scheduleNumber/remove", authorize("dailyProductionSchedules", "delete"), logger("dailyProductionSchedules", "delete"), ctrl.remove);

module.exports = router;
