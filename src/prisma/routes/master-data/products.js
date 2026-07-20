const router = require("express").Router();
const ctrl = require("../../controllers/master-data/ProductController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// special routes first
router.post("/bulk-create", authorize("products", "create"), logger("product", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("products", "delete"), logger("product", "bulk-remove", { modelName: 'product' }), ctrl.bulkRemove);
router.get("/generate-code", authorize("products", "read"), ctrl.generateCode);
router.get("/all-codes", authorize("products", "read"), ctrl.getAllCodes);
router.get("/autocomplete", authorize("products", "read"), ctrl.autocomplete);

// standard CRUD routes
router.get("/", authorize("products", "read"), ctrl.list);
router.get("/:productCode", authorize("products", "read"), ctrl.get);
router.post("/", authorize("products", "create"), logger("product", "create"), ctrl.create);
router.patch("/:id", authorize("products", "update"), logger("product", "update", { modelName: 'product' }), ctrl.update);
router.patch("/:id/remove", authorize("products", "delete"), logger("product", "delete"), ctrl.remove);

module.exports = router;
