const router = require("express").Router();
const ctrl = require("../../controllers/master-data/MaterialController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// special routes first
router.post("/bulk-create", authorize("materials", "create"), logger("material", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("materials", "delete"), logger("material", "bulk-remove", { modelName: 'material' }), ctrl.bulkRemove);
router.get("/all-codes", authorize("materials", "read"), ctrl.getAllCodes); // /materials/all-codes
router.get("/autocomplete", authorize("materials", "read"), ctrl.autocomplete); // /materials/autocomplete?q=...&limit=...
router.get("/generate-code", authorize("materials", "read"), ctrl.generateCode);

// standard CRUD routes
router.get("/", authorize("materials", "read"), ctrl.list);
router.get("/:materialCode", authorize("materials", "read"), ctrl.get);
router.post("/", authorize("materials", "create"), logger("material", "create"), ctrl.create);
router.patch("/:id", authorize("materials", "update"), logger("material", "update", { modelName: 'material' }), ctrl.update);
router.patch("/:id/remove", authorize("materials", "delete"), logger("material", "delete"), ctrl.remove); // PATCH /materials/:id/remove untuk soft delete

module.exports = router;
