const router = require("express").Router();
const ctrl = require("../../controllers/inventory/LotMasterController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// Special routes first
router.get("/generate-number", authorize("lots", "read"), ctrl.generateNumber);
router.get("/all-lot-numbers", authorize("lots", "read"), ctrl.getAllLotNumbers);
router.patch("/bulk-remove", authorize("lots", "delete"), logger("lot", "bulk-remove", { modelName: "lot" }), ctrl.bulkRemove);

// Standard CRUD routes
router.get("/", authorize("lots", "read"), ctrl.list);
router.get("/:lotNumber", authorize("lots", "read"), ctrl.get);
router.post("/", authorize("lots", "create"), logger("lot", "create"), ctrl.create);
router.patch("/:lotNumber", authorize("lots", "update"), logger("lot", "update", { modelName: "lot" }), ctrl.update);
router.patch("/:lotNumber/remove", authorize("lots", "delete"), logger("lot", "delete"), ctrl.remove);

module.exports = router;
