const router = require("express").Router();
const ctrl = require("../../controllers/master-data/VendorPriceListController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");
const { uploadQuotationFiles } = require("../../middleware/uploads");

// special routes first
router.post("/bulk-create", authorize("vendorPriceLists", "create"), logger("vendorPriceList", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("vendorPriceLists", "delete"), logger("vendorPriceList", "bulk-remove", { modelName: 'vendorPriceList' }), ctrl.bulkRemove);

// standard CRUD routes
router.get("/", authorize("vendorPriceLists", "read"), ctrl.list);
router.get("/:id", authorize("vendorPriceLists", "read"), ctrl.get);
router.post("/", authorize("vendorPriceLists", "create"), uploadQuotationFiles, logger("vendorPriceList", "create"), ctrl.create);
router.patch("/:id", authorize("vendorPriceLists", "update"), uploadQuotationFiles, logger("vendorPriceList", "update", { modelName: 'vendorPriceList' }), ctrl.update);
router.patch("/:id/remove", authorize("vendorPriceLists", "delete"), logger("vendorPriceList", "delete"), ctrl.remove); // PATCH /vendorPriceLists/:id/remove untuk soft delete

module.exports = router;
