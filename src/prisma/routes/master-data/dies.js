const router = require("express").Router();
const ctrl = require("../../controllers/master-data/DiesController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");
const { uploadDiesFiles } = require("../../middleware/uploads");

// special routes first
router.patch("/bulk-remove", authorize("dies", "delete"), logger("dies", "bulk-remove", { modelName: 'dies' }), ctrl.bulkRemove);
router.get("/stats", authorize("dies", "read"), ctrl.stats);
router.get("/autocomplete", authorize("dies", "read"), ctrl.autocomplete); // /dies/autocomplete?q=...&limit=...
router.get("/generate-code", authorize("dies", "read"), ctrl.generateCode);
router.get("/all-codes", authorize("dies", "read"), ctrl.getAllCodes); // /dies/all-codes

// shot counter management
router.patch("/:id/update-shot-counter", authorize("dies", "update"), logger("dies", "update-shot-counter"), ctrl.updateShotCounter);
router.patch("/:id/reset-shot-counter", authorize("dies", "update"), logger("dies", "reset-shot-counter"), ctrl.resetShotCounter);

// standard CRUD routes
router.get("/", authorize("dies", "read"), ctrl.list);
router.get("/:diesCode", authorize("dies", "read"), ctrl.get);
router.post("/", authorize("dies", "create"), uploadDiesFiles, logger("dies", "create"), ctrl.create);
router.patch("/:id", authorize("dies", "update"), uploadDiesFiles, logger("dies", "update", { modelName: 'dies' }), ctrl.update);
router.patch("/:id/remove", authorize("dies", "delete"), logger("dies", "delete"), ctrl.remove); // PATCH /dies/:id/remove untuk soft delete

module.exports = router;
