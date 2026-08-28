const router = require("express").Router();
const ctrl = require("../../controllers/purchasing/PurchaseSuggestionController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.get("/", authorize("purchaseOrder", "read"), ctrl.list);
router.post("/generate/:runNumber", authorize("mrp", "release"), logger("purchaseSuggestion", "generate"), ctrl.generate);
router.get("/:suggestionNumber", authorize("purchaseOrder", "read"), ctrl.get);
router.get("/:suggestionNumber/items/:itemId/supplier-master", authorize("purchaseOrder", "read"), ctrl.getSupplierMaster);
router.post("/:suggestionNumber/auto-confirm-suppliers", authorize("purchaseOrder", "update"), logger("purchaseSuggestion", "auto-supplier-confirmation"), ctrl.autoConfirmSuppliers);
router.patch("/:suggestionNumber/items/:itemId", authorize("purchaseOrder", "update"), logger("purchaseSuggestion", "supplier-confirmation"), ctrl.updateItem);
router.post("/:suggestionNumber/convert-to-pr", authorize("purchaseOrder", "create"), logger("purchaseSuggestion", "convert-to-pr"), ctrl.convertToPr);
router.delete("/:suggestionNumber", authorize("purchaseOrder", "delete"), logger("purchaseSuggestion", "delete"), ctrl.remove);

module.exports = router;
