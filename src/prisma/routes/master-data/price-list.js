const router = require("express").Router();
const ctrl = require("../../controllers/master-data/PriceListController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// special routes first
router.patch("/bulk-remove", authorize("priceList", "delete"), logger("priceList", "bulk-remove", { modelName: 'priceList' }), ctrl.bulkRemove);
router.get("/autocomplete", authorize("priceList", "read"), ctrl.autocomplete); // /price-lists/autocomplete?q=...&limit=...

// standard CRUD routes
router.get("/", authorize("priceList", "read"), ctrl.list);
router.get("/:id", authorize("priceList", "read"), ctrl.get);
router.post("/", authorize("priceList", "create"), logger("priceList", "create"), ctrl.create);
router.patch("/:id", authorize("priceList", "update"), logger("priceList", "update", { modelName: 'priceList' }), ctrl.update);
router.patch("/:id/remove", authorize("priceList", "delete"), logger("priceList", "delete"), ctrl.remove); // PATCH /price-lists/:id/remove untuk soft delete

module.exports = router;
