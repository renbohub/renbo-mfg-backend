const router = require("express").Router();
const ctrl = require("../../controllers/master-data/DivisionController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// special routes first
router.patch("/bulk-remove", authorize("divisions", "delete"), logger("division", "bulk-remove", { modelName: 'division' }), ctrl.bulkRemove);
router.get("/generate-code", authorize("divisions", "read"), ctrl.generateCode);
router.get("/all-codes", authorize("divisions", "read"), ctrl.getAllCodes);
router.get("/autocomplete", authorize("divisions", "read"), ctrl.autocomplete);

// standard CRUD routes
router.get("/", authorize("divisions", "read"), ctrl.list);
router.get("/:divisionCode", authorize("divisions", "read"), ctrl.get);
router.post("/", authorize("divisions", "create"), logger("division", "create"), ctrl.create);
router.patch("/:id", authorize("divisions", "update"), logger("division", "update", { modelName: 'division' }), ctrl.update);
router.patch("/:id/remove", authorize("divisions", "delete"), logger("division", "delete"), ctrl.remove);

module.exports = router;
