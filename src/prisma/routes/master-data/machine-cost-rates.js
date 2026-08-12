const router = require("express").Router();
const controller = require("../../controllers/master-data/MachineCostRateController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.get("/", authorize("machines", "read"), controller.list);
router.get("/:id", authorize("machines", "read"), controller.get);
router.post("/", authorize("machines", "create"), logger("machineCostRate", "create"), controller.create);
router.patch("/:id", authorize("machines", "update"), logger("machineCostRate", "update", { modelName: "machineCostRate" }), controller.update);
router.patch("/:id/remove", authorize("machines", "delete"), logger("machineCostRate", "delete"), controller.remove);

module.exports = router;
