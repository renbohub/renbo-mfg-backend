const router = require("express").Router();
const ctrl = require("../../controllers/master-data/SubProcessController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// special routes first
router.post("/bulk-create", authorize("subProcesses", "create"), logger("subProcess", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("subProcesses", "delete"), logger("subProcess", "bulk-remove", { modelName: 'subProcess' }), ctrl.bulkRemove);
router.get("/generate-code", authorize("subProcesses", "read"), ctrl.generateCode);
router.get("/all-codes", authorize("subProcesses", "read"), ctrl.getAllCodes);
router.get("/autocomplete", authorize("subProcesses", "read"), ctrl.autocomplete);

// standard CRUD routes
router.get("/", authorize("subProcesses", "read"), ctrl.list);
router.get("/:subProcessCode", authorize("subProcesses", "read"), ctrl.get);
router.post("/", authorize("subProcesses", "create"), logger("subProcess", "create"), ctrl.create);
router.patch("/:id", authorize("subProcesses", "update"), logger("subProcess", "update", { modelName: 'subProcess' }), ctrl.update);
router.patch("/:id/remove", authorize("subProcesses", "delete"), logger("subProcess", "delete"), ctrl.remove);

module.exports = router;
