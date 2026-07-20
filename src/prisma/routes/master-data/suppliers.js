const router = require("express").Router();
const ctrl = require("../../controllers/master-data/SupplierController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// special routes first
router.post("/bulk-create", authorize("suppliers", "create"), logger("supplier", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("suppliers", "delete"), logger("supplier", "bulk-remove", { modelName: 'supplier' }), ctrl.bulkRemove);
router.get("/stats", authorize("suppliers", "read"), ctrl.stats);
router.get("/generate-code", authorize("suppliers", "read"), ctrl.generateCode);
router.get("/all-codes", authorize("suppliers", "read"), ctrl.getAllCodes); // /suppliers/all-codes

// standard CRUD routes
router.get("/", authorize("suppliers", "read"), ctrl.list);
router.get("/:supplierCode", authorize("suppliers", "read"), ctrl.get);
router.post("/", authorize("suppliers", "create"), logger("supplier", "create"), ctrl.create);
router.patch("/:id", authorize("suppliers", "update"), logger("supplier", "update", { modelName: 'supplier' }), ctrl.update);
router.patch("/:id/remove", authorize("suppliers", "delete"), logger("supplier", "delete"), ctrl.remove); // PATCH /suppliers/:id/remove untuk soft delete

module.exports = router;
