const router = require("express").Router();
const ctrl = require("../../controllers/master-data/VendorProcessController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// special routes first
router.post("/bulk-create", authorize("vendorProcesses", "create"), logger("vendorProcess", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("vendorProcesses", "delete"), logger("vendorProcess", "bulk-remove", { modelName: 'vendorProcess' }), ctrl.bulkRemove);
router.get("/autocomplete", authorize("vendorProcesses", "read"), ctrl.autocomplete); // /vendorProcesses/autocomplete?q=...&limit=...

// standard CRUD routes
router.get("/", authorize("vendorProcesses", "read"), ctrl.list);
router.get("/:vendorProcessCode", authorize("vendorProcesses", "read"), ctrl.get);
router.post("/", authorize("vendorProcesses", "create"), logger("vendorProcess", "create"), ctrl.create);
router.patch("/:id", authorize("vendorProcesses", "update"), logger("vendorProcess", "update", { modelName: 'vendorProcess' }), ctrl.update);
router.patch("/:id/remove", authorize("vendorProcesses", "delete"), logger("vendorProcess", "delete"), ctrl.remove); // PATCH /vendorProcesses/:id/remove untuk soft delete

module.exports = router;
