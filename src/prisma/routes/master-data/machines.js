const router = require("express").Router();
const ctrl = require("../../controllers/master-data/MachineController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");
const { uploadMachineFiles } = require("../../middleware/uploads");

// Special routes first
router.patch("/bulk-remove", authorize("machines", "delete"), logger("machine", "bulk-remove", { modelName: "machine" }), ctrl.bulkRemove);
router.get("/generate-code", authorize("machines", "read"), ctrl.generateCode);
router.get("/all-codes", authorize("machines", "read"), ctrl.getAllCodes);
router.get("/autocomplete", authorize("machines", "read"), ctrl.autocomplete);

// Standard CRUD routes
router.get("/", authorize("machines", "read"), ctrl.list);
router.get("/:machineCode", authorize("machines", "read"), ctrl.get);
router.post("/", authorize("machines", "create"), uploadMachineFiles, logger("machine", "create"), ctrl.create);
router.patch("/:id", authorize("machines", "update"), uploadMachineFiles, logger("machine", "update", { modelName: "machine" }), ctrl.update);
router.patch("/:id/remove", authorize("machines", "delete"), logger("machine", "delete"), ctrl.remove);

module.exports = router;
