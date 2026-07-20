const router = require("express").Router();
const ctrl = require("../../controllers/production/WIPController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// Helper routes HARUS di atas /:entryNumber
router.get("/generate-number", authorize("wip", "create"), ctrl.generateNumber);
router.get("/summary", authorize("wip", "read"), ctrl.summary);
router.get("/qty-summary", authorize("wip", "read"), ctrl.qtySummary);
router.get("/semi-fg-stock", authorize("wip", "read"), ctrl.semiFGStock);
router.get("/balance/:moId", authorize("wip", "read"), ctrl.balanceByMO);
router.post("/transfer", authorize("wip", "transfer"), logger("wip", "transfer"), ctrl.wipTransfer);
router.patch("/bulk-remove", authorize("wip", "delete"), logger("wip", "bulk-remove", { modelName: "WIPEntry" }), ctrl.bulkRemove);

// Standard CRUD
router.get("/", authorize("wip", "read"), ctrl.list);
router.get("/:entryNumber", authorize("wip", "read"), ctrl.get);
router.post("/", authorize("wip", "create"), logger("wip", "create"), ctrl.create);
router.patch("/:entryNumber", authorize("wip", "update"), logger("wip", "update", { modelName: "WIPEntry" }), ctrl.update);
router.patch("/:entryNumber/remove", authorize("wip", "delete"), logger("wip", "delete"), ctrl.remove);

module.exports = router;
