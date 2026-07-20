const router = require("express").Router();
const ctrl = require("../../controllers/master-data/ProcessController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// special routes first
router.post("/bulk-create", authorize("processes", "create"), logger("process", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("processes", "delete"), logger("process", "bulk-remove", { modelName: 'process' }), ctrl.bulkRemove);
router.get("/all-codes", authorize("processes", "read"), ctrl.getAllCodes); // /processes/all-codes
router.get("/autocomplete", authorize("processes", "read"), ctrl.autocomplete); // /processes/autocomplete?q=...&limit=...

// standard CRUD routes
router.get("/", authorize("processes", "read"), ctrl.list);
router.get("/:processCode", authorize("processes", "read"), ctrl.get);
router.post("/", authorize("processes", "create"), logger("process", "create"), ctrl.create);
router.patch("/:id", authorize("processes", "update"), logger("process", "update", { modelName: 'process' }), ctrl.update);
router.patch("/:id/remove", authorize("processes", "delete"), logger("process", "delete"), ctrl.remove); // PATCH /processes/:id/remove untuk soft delete

module.exports = router;
