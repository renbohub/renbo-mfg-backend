const router = require("express").Router();
const ctrl = require("../../controllers/purchasing/PurchaseSuggestionController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.get("/", authorize("purchaseOrder", "read"), ctrl.list);
router.post("/generate/:runNumber", authorize("mrp", "release"), logger("purchaseSuggestion", "generate"), ctrl.generate);
router.get("/:suggestionNumber", authorize("purchaseOrder", "read"), ctrl.get);
router.patch("/:suggestionNumber/items/:itemId", authorize("purchaseOrder", "update"), logger("purchaseSuggestion", "supplier-confirmation"), ctrl.updateItem);
router.post("/:suggestionNumber/convert-to-pr", authorize("purchaseOrder", "create"), logger("purchaseSuggestion", "convert-to-pr"), ctrl.convertToPr);
router.delete("/:suggestionNumber", authorize("purchaseOrder", "delete"), logger("purchaseSuggestion", "delete"), ctrl.remove);

module.exports = router;
