const router = require("express").Router();
const ctrl = require("../../controllers/planning/ForecastController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");
router.get("/generate-number", authorize("forecast", "create"), ctrl.generateNumber);
router.get("/", authorize("forecast", "read"), ctrl.list);
router.get("/:forecastNumber", authorize("forecast", "read"), ctrl.get);
router.post("/", authorize("forecast", "create"), logger("forecast", "create"), ctrl.create);
router.patch("/:forecastNumber", authorize("forecast", "update"), logger("forecast", "update", { modelName: "forecast", paramKey: "forecastNumber", whereKey: "forecastNumber" }), ctrl.update);
router.delete("/:forecastNumber", authorize("forecast", "delete"), logger("forecast", "delete", { paramKey: "forecastNumber", entityField: "forecastNumber" }), ctrl.remove);
module.exports = router;

