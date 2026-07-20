const router = require("express").Router();
const ctrl = require("../../controllers/master-data/UomController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// special routes first
router.post("/bulk-create", authorize("uom", "create"), logger("uom", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("uom", "delete"), logger("uom", "bulk-remove", { modelName: 'uom' }), ctrl.bulkRemove);
router.get("/all-codes", authorize("uom", "read"), ctrl.getAllCodes); // /uom/all-codes
router.get("/autocomplete", authorize("uom", "read"), ctrl.autocomplete); // /uom/autocomplete?q=...&limit=...

// standard CRUD routes
router.get("/", authorize("uom", "read"), ctrl.list);
router.get("/:uomCode", authorize("uom", "read"), ctrl.get);
router.post("/", authorize("uom", "create"), logger("uom", "create"), ctrl.create);
router.patch("/:id", authorize("uom", "update"), logger("uom", "update", { modelName: 'uom' }), ctrl.update);
router.patch("/:id/remove", authorize("uom", "delete"), logger("uom", "delete"), ctrl.remove); // PATCH /uom/:id/remove untuk soft delete

module.exports = router;
