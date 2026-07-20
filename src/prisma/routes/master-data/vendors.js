const router = require("express").Router();
const ctrl = require("../../controllers/master-data/VendorController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// special routes first
router.post("/bulk-create", authorize("vendors", "create"), logger("vendor", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("vendors", "delete"), logger("vendor", "bulk-remove", { modelName: 'vendor' }), ctrl.bulkRemove);
router.get("/stats", authorize("vendors", "read"), ctrl.stats);
router.get("/generate-code", authorize("vendors", "read"), ctrl.generateCode);
router.get("/all-codes", authorize("vendors", "read"), ctrl.getAllCodes); // /vendors/all-codes

// standard CRUD routes
router.get("/", authorize("vendors", "read"), ctrl.list);
router.get("/:vendorCode", authorize("vendors", "read"), ctrl.get);
router.post("/", authorize("vendors", "create"), logger("vendor", "create"), ctrl.create);
router.patch("/:id", authorize("vendors", "update"), logger("vendor", "update", { modelName: 'vendor' }), ctrl.update);
router.patch("/:id/remove", authorize("vendors", "delete"), logger("vendor", "delete"), ctrl.remove); // PATCH /vendors/:id/remove untuk soft delete

module.exports = router;
