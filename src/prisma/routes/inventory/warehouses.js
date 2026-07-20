const router = require("express").Router();
const ctrl = require("../../controllers/inventory/WarehouseController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// Special routes first
router.get("/generate-code", authorize("warehouses", "read"), ctrl.generateCode);
router.get("/all-codes", authorize("warehouses", "read"), ctrl.allCodes);
router.post("/bulk-create", authorize("warehouses", "create"), logger("warehouse", "bulk-create", { modelName: 'warehouse' }), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("warehouses", "delete"), logger("warehouse", "bulk-remove", { modelName: 'warehouse' }), ctrl.bulkRemove);

// Standard CRUD routes
router.get("/", authorize("warehouses", "read"), ctrl.list);
router.get("/:code", authorize("warehouses", "read"), ctrl.get);
router.post("/", authorize("warehouses", "create"), logger("warehouse", "create"), ctrl.create);
router.patch("/:code", authorize("warehouses", "update"), logger("warehouse", "update", { modelName: 'warehouse' }), ctrl.update);
router.patch("/:code/remove", authorize("warehouses", "delete"), logger("warehouse", "delete"), ctrl.remove);

module.exports = router;
