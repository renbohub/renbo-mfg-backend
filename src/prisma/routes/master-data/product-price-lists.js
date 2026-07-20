const router = require("express").Router();
const ctrl = require("../../controllers/master-data/ProductPriceListController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// special routes first
router.post("/bulk-create", authorize("productPriceLists", "create"), logger("productPriceList", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("productPriceLists", "delete"), logger("productPriceList", "bulk-remove", { modelName: 'productPriceList' }), ctrl.bulkRemove);

// standard CRUD routes
router.get("/", authorize("productPriceLists", "read"), ctrl.list);
router.get("/:id", authorize("productPriceLists", "read"), ctrl.get);
router.post("/", authorize("productPriceLists", "create"), logger("productPriceList", "create"), ctrl.create);
router.patch("/:id", authorize("productPriceLists", "update"), logger("productPriceList", "update", { modelName: 'productPriceList' }), ctrl.update);
router.patch("/:id/remove", authorize("productPriceLists", "delete"), logger("productPriceList", "delete"), ctrl.remove);

module.exports = router;
