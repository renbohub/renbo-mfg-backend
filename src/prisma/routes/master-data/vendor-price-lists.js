const router = require("express").Router();
const ctrl = require("../../controllers/master-data/VendorPriceListController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");
const { uploadQuotationFiles } = require("../../middleware/uploads");
const bomPrice = require('../../controllers/master-data/VendorBomPriceController');

// special routes first
router.get('/bom-fgs', authorize('vendorPriceLists','read'), bomPrice.fgs);
router.get('/bom-fgs/:key', authorize('vendorPriceLists','read'), bomPrice.fg);
router.get('/bom-context/:id', authorize('vendorPriceLists','read'), bomPrice.context);
router.post('/bom-preview', authorize('vendorPriceLists','read'), bomPrice.preview);
// Individual create/update permissions are checked for every child-part price in the transaction.
router.post('/bom-save', authorize('vendorPriceLists','read'), uploadQuotationFiles, logger('vendorPriceList','save-bom-prices'), bomPrice.save);
router.post("/bulk-create", authorize("vendorPriceLists", "create"), logger("vendorPriceList", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("vendorPriceLists", "delete"), logger("vendorPriceList", "bulk-remove", { modelName: 'vendorPriceList' }), ctrl.bulkRemove);

// standard CRUD routes
router.get("/", authorize("vendorPriceLists", "read"), ctrl.list);
router.get("/:id", authorize("vendorPriceLists", "read"), ctrl.get);
router.post("/", authorize("vendorPriceLists", "create"), uploadQuotationFiles, logger("vendorPriceList", "create"), ctrl.create);
router.patch("/:id", authorize("vendorPriceLists", "update"), uploadQuotationFiles, logger("vendorPriceList", "update", { modelName: 'vendorPriceList' }), ctrl.update);
router.patch("/:id/remove", authorize("vendorPriceLists", "delete"), logger("vendorPriceList", "delete"), ctrl.remove); // PATCH /vendorPriceLists/:id/remove untuk soft delete

module.exports = router;
