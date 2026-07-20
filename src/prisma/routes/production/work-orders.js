const router = require("express").Router();
const ctrl = require("../../controllers/production/WorkOrderController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// Helper routes HARUS di atas /:woNumber
router.get("/generate-number", authorize("workOrders", "create"), ctrl.generateNumber);
router.get("/autocomplete",    authorize("workOrders", "read"),   ctrl.autocomplete);
// Dispatch list — daftar WO per process untuk operator lantai
// GET /dispatch?processId=X&date=2026-04-06
router.get("/dispatch",        authorize("workOrders", "read"),   ctrl.dispatch);
router.patch("/bulk-remove", authorize("workOrders", "delete"), logger("workOrders", "bulk-remove", { modelName: "WorkOrder" }), ctrl.bulkRemove);

// Status transitions
router.patch("/:woNumber/start",    authorize("workOrders", "start"), logger("workOrders", "start",    { modelName: "WorkOrder" }), ctrl.start);
router.patch("/:woNumber/complete", authorize("workOrders", "complete"), logger("workOrders", "complete", { modelName: "WorkOrder" }), ctrl.complete);
router.patch("/:woNumber/cancel",   authorize("workOrders", "cancel"), logger("workOrders", "cancel",   { modelName: "WorkOrder" }), ctrl.cancel);

// Standard CRUD
router.get("/",          authorize("workOrders", "read"),   ctrl.list);
router.get("/:woNumber", authorize("workOrders", "read"),   ctrl.get);
router.post("/",         authorize("workOrders", "create"), logger("workOrders", "create"), ctrl.create);
router.patch("/:woNumber",        authorize("workOrders", "update"), logger("workOrders", "update", { modelName: "WorkOrder" }), ctrl.update);
router.patch("/:woNumber/remove", authorize("workOrders", "delete"), logger("workOrders", "delete", { modelName: "WorkOrder" }), ctrl.remove);

module.exports = router;
