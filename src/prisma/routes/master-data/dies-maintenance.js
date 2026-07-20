const router = require("express").Router();
const ctrl = require("../../controllers/master-data/DiesMaintenanceController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// special routes first
router.patch("/bulk-remove", authorize("dies", "delete"), logger("diesMaintenance", "bulk-remove", { modelName: 'dies_maintenance' }), ctrl.bulkRemove);
router.get("/generate-number", authorize("dies", "read"), ctrl.generateNumber);
router.get("/dies/:diesId/history", authorize("dies", "read"), ctrl.history); // History for specific dies

// standard CRUD routes
router.get("/", authorize("dies", "read"), ctrl.list);
router.get("/:maintenanceNumber", authorize("dies", "read"), ctrl.get);
router.post("/", authorize("dies", "create"), logger("diesMaintenance", "create"), ctrl.create);
router.patch("/:maintenanceNumber", authorize("dies", "update"), logger("diesMaintenance", "update", { modelName: 'dies_maintenance' }), ctrl.update);
router.patch("/:maintenanceNumber/remove", authorize("dies", "delete"), logger("diesMaintenance", "delete"), ctrl.remove);

module.exports = router;
