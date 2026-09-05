"use strict";

const router = require("express").Router();
const controller = require("../../controllers/planning/PlanningSolverController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.get("/", authorize("monthlyProductionPlan", "read"), controller.list);
router.get("/:id", authorize("monthlyProductionPlan", "read"), controller.get);
router.post("/", authorize("monthlyProductionPlan", "update"), logger("planningSolver", "enqueue"), controller.enqueue);

module.exports = router;
