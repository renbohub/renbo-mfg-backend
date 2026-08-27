const router = require("express").Router();
const ctrl = require("../../controllers/production/MachineAvailabilityEventController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");
router.post("/", authorize("dailyProductionSchedules", "update"), logger("machineAvailabilityEvent", "create"), ctrl.create);
router.patch("/:id/resolve", authorize("dailyProductionSchedules", "update"), logger("machineAvailabilityEvent", "resolve"), ctrl.resolve);
module.exports = router;
