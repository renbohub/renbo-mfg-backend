const router = require("express").Router();
const ctrl = require("../../controllers/inventory/RackController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// Special routes first
router.get("/generate-code", authorize("racks", "read"), ctrl.generateCode);
router.get("/all-codes", authorize("racks", "read"), ctrl.allCodes);
router.get("/special-codes", authorize("racks", "read"), ctrl.specialCodes);
router.post("/bulk-create", authorize("racks", "create"), logger("rack", "bulk-create", { modelName: 'rack' }), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("racks", "delete"), logger("rack", "bulk-remove", { modelName: 'rack' }), ctrl.bulkRemove);

// Standard CRUD routes
router.get("/", authorize("racks", "read"), ctrl.list);
router.get("/list-special", authorize("racks", "read"), ctrl.listSpecial);
router.get("/:code", authorize("racks", "read"), ctrl.get);
router.post("/", authorize("racks", "create"), logger("rack", "create"), ctrl.create);
router.patch("/:code", authorize("racks", "update"), logger("rack", "update", { modelName: 'rack' }), ctrl.update);
router.patch("/:code/remove", authorize("racks", "delete"), logger("rack", "delete"), ctrl.remove);

module.exports = router;
