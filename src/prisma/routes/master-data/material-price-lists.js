const router = require("express").Router();
const ctrl = require("../../controllers/master-data/MaterialPriceListController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// special routes first
router.post("/bulk-create", authorize("materialPriceLists", "create"), logger("materialPriceList", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("materialPriceLists", "delete"), logger("materialPriceList", "bulk-remove", { modelName: 'materialPriceList' }), ctrl.bulkRemove);

// standard CRUD routes
router.get("/", authorize("materialPriceLists", "read"), ctrl.list);
router.get("/:id", authorize("materialPriceLists", "read"), ctrl.get);
router.post("/", authorize("materialPriceLists", "create"), logger("materialPriceList", "create"), ctrl.create);
router.patch("/:id", authorize("materialPriceLists", "update"), logger("materialPriceList", "update", { modelName: 'materialPriceList' }), ctrl.update);
router.patch("/:id/remove", authorize("materialPriceLists", "delete"), logger("materialPriceList", "delete"), ctrl.remove); // PATCH /materialPriceLists/:id/remove untuk soft delete

module.exports = router;
