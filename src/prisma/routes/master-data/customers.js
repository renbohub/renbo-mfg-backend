const router = require("express").Router();
const ctrl = require("../../controllers/master-data/CustomerController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// special routes first
router.post("/bulk-create", authorize("customers", "create"), logger("customer", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("customers", "delete"), logger("customer", "bulk-remove", { modelName: 'customer' }), ctrl.bulkRemove);
router.get("/stats", authorize("customers", "read"), ctrl.stats);
router.get("/autocomplete", authorize("customers", "read"), ctrl.autocomplete); // /customers/autocomplete?q=...&limit=...
router.get("/generate-code", authorize("customers", "read"), ctrl.generateCode);
router.get("/all-codes", authorize("customers", "read"), ctrl.getAllCodes); // /customers/all-codes

// standard CRUD routes
router.get("/", authorize("customers", "read"), ctrl.list);
router.get("/:customerCode", authorize("customers", "read"), ctrl.get);
router.post("/", authorize("customers", "create"), logger("customer", "create"), ctrl.create);
router.patch("/:id", authorize("customers", "update"), logger("customer", "update", { modelName: 'customer' }), ctrl.update);
router.patch("/:id/remove", authorize("customers", "delete"), logger("customer", "delete"), ctrl.remove); // PATCH /customers/:id/remove untuk soft delete

module.exports = router;
