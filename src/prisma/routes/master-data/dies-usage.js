const router = require("express").Router();
const ctrl = require("../../controllers/master-data/DiesUsageController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// special routes first
router.patch("/bulk-remove", authorize("dies", "delete"), logger("diesUsage", "bulk-remove", { modelName: 'dies_usage' }), ctrl.bulkRemove);
router.get("/dies/:diesId/history", authorize("dies", "read"), ctrl.history); // History for specific dies
router.get("/dies/:diesId/summary", authorize("dies", "read"), ctrl.summary); // Summary for specific dies

// standard CRUD routes
router.get("/", authorize("dies", "read"), ctrl.list);
router.get("/:id", authorize("dies", "read"), ctrl.get);
router.post("/", authorize("dies", "create"), logger("diesUsage", "create"), ctrl.create);
router.patch("/:id", authorize("dies", "update"), logger("diesUsage", "update", { modelName: 'dies_usage' }), ctrl.update);
router.patch("/:id/remove", authorize("dies", "delete"), logger("diesUsage", "delete"), ctrl.remove);

module.exports = router;
