"use strict";

const router = require("express").Router();
const controller = require("../../controllers/master-data/YearlyWorkingCalendarController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.get("/", authorize("machines", "read"), controller.list);
router.post("/", authorize("machines", "create"), logger("yearlyWorkingCalendar", "create"), controller.create);
router.patch("/:eventId", authorize("machines", "update"), logger("yearlyWorkingCalendar", "update"), controller.update);
router.patch("/:eventId/remove", authorize("machines", "delete"), logger("yearlyWorkingCalendar", "delete"), controller.remove);

module.exports = router;
