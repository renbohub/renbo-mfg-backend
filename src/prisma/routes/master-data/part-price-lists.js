const router = require("express").Router();
const ctrl = require("../../controllers/master-data/PartPriceListController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// special routes first
router.post("/bulk-create", authorize("partPriceLists", "create"), logger("partPriceList", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("partPriceLists", "delete"), logger("partPriceList", "bulk-remove", { modelName: 'partPriceList' }), ctrl.bulkRemove);

// standard CRUD routes
router.get("/", authorize("partPriceLists", "read"), ctrl.list);
router.get("/:id", authorize("partPriceLists", "read"), ctrl.get);
router.post("/", authorize("partPriceLists", "create"), logger("partPriceList", "create"), ctrl.create);
router.patch("/:id", authorize("partPriceLists", "update"), logger("partPriceList", "update", { modelName: 'partPriceList' }), ctrl.update);
router.patch("/:id/remove", authorize("partPriceLists", "delete"), logger("partPriceList", "delete"), ctrl.remove); // PATCH /partPriceLists/:id/remove untuk soft delete

module.exports = router;
