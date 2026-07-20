const router = require("express").Router();
const ctrl = require("../../controllers/master-data/CurrencyController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// special routes first
router.post("/bulk-create", authorize("currencies", "create"), logger("currency", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("currencies", "delete"), logger("currency", "bulk-remove", { modelName: 'currency' }), ctrl.bulkRemove);
router.get("/all-codes", authorize("currencies", "read"), ctrl.getAllCodes); // /currencies/all-codes
router.get("/autocomplete", authorize("currencies", "read"), ctrl.autocomplete); // /currencies/autocomplete?q=...&limit=...

// standard CRUD routes
router.get("/", authorize("currencies", "read"), ctrl.list);
router.get("/:currencyCode", authorize("currencies", "read"), ctrl.get);
router.post("/", authorize("currencies", "create"), logger("currency", "create"), ctrl.create);
router.patch("/:id", authorize("currencies", "update"), logger("currency", "update", { modelName: 'currency' }), ctrl.update);
router.patch("/:id/remove", authorize("currencies", "delete"), logger("currency", "delete"), ctrl.remove); // PATCH /currencies/:id/remove untuk soft delete

module.exports = router;
