const router = require("express").Router();
const ctrl = require("../../controllers/production/QualityInspectionController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// Helper routes HARUS di atas /:inspectionNumber
router.get("/generate-number", authorize("qualityInspections", "create"), ctrl.generateNumber);
router.get("/fg-receipts/pending", authorize("qualityInspections", "read"), ctrl.pendingFgReceipts);
router.get("/fg-receipts/history", authorize("qualityInspections", "read"), ctrl.fgReceiptHistory);
router.patch("/fg-receipts/:movementNumber/rollback", authorize("qualityInspections", "complete"), logger("qualityInspections", "rollback-fg-receipt", { modelName: "QualityInspection" }), ctrl.rollbackFgReceipt);
router.patch("/bulk-remove", authorize("qualityInspections", "delete"), logger("qualityInspections", "bulk-remove", { modelName: "QualityInspection" }), ctrl.bulkRemove);

// Status transitions
router.patch("/:inspectionNumber/complete", authorize("qualityInspections", "complete"), logger("qualityInspections", "complete", { modelName: "QualityInspection" }), ctrl.complete);
router.patch("/:inspectionNumber/receive-fg", authorize("qualityInspections", "complete"), logger("qualityInspections", "receive-fg", { modelName: "QualityInspection" }), ctrl.receiveFg);

// Standard CRUD
router.get("/",                  authorize("qualityInspections", "read"),   ctrl.list);
router.get("/:inspectionNumber", authorize("qualityInspections", "read"),   ctrl.get);
router.post("/",                 authorize("qualityInspections", "create"), logger("qualityInspections", "create"), ctrl.create);
router.patch("/:inspectionNumber",        authorize("qualityInspections", "update"), logger("qualityInspections", "update", { modelName: "QualityInspection" }), ctrl.update);
router.patch("/:inspectionNumber/remove", authorize("qualityInspections", "delete"), logger("qualityInspections", "delete", { modelName: "QualityInspection" }), ctrl.remove);

module.exports = router;
