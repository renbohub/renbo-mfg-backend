const router = require("express").Router();
const ctrl = require("../../controllers/production/ManufacturingOrderController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// Helper routes HARUS di atas /:moNumber
router.get("/generate-number", authorize("manufacturingOrders", "create"), ctrl.generateNumber);
router.get("/autocomplete", authorize("manufacturingOrders", "read"), ctrl.autocomplete);
router.post("/bulk-create", authorize("manufacturingOrders", "create"), logger("manufacturingOrders", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("manufacturingOrders", "delete"), logger("manufacturingOrders", "bulk-remove", { modelName: "ManufacturingOrder" }), ctrl.bulkRemove);

// Generate Work Orders dari MBOM routing
router.post("/:moNumber/generate-work-orders", authorize("manufacturingOrders", "generate"), logger("manufacturingOrders", "generate-work-orders", { modelName: "ManufacturingOrder" }), ctrl.generateWorkOrders);

// Availability check — cek stok material MBOM vs kebutuhan MO
router.get("/:moNumber/availability-check", authorize("manufacturingOrders", "read"), ctrl.availabilityCheck);

// Status transitions
router.patch("/:moNumber/release",  authorize("manufacturingOrders", "release"), logger("manufacturingOrders", "release",  { modelName: "ManufacturingOrder" }), ctrl.release);
router.patch("/:moNumber/start",    authorize("manufacturingOrders", "start"), logger("manufacturingOrders", "start",    { modelName: "ManufacturingOrder" }), ctrl.start);
router.patch("/:moNumber/complete", authorize("manufacturingOrders", "complete"), logger("manufacturingOrders", "complete", { modelName: "ManufacturingOrder" }), ctrl.complete);
router.patch("/:moNumber/cancel",   authorize("manufacturingOrders", "cancel"), logger("manufacturingOrders", "cancel",   { modelName: "ManufacturingOrder" }), ctrl.cancel);

// Standard CRUD
router.get("/",          authorize("manufacturingOrders", "read"),   ctrl.list);
router.get("/:moNumber", authorize("manufacturingOrders", "read"),   ctrl.get);
router.post("/",         authorize("manufacturingOrders", "create"), logger("manufacturingOrders", "create"), ctrl.create);
router.patch("/:moNumber",        authorize("manufacturingOrders", "update"), logger("manufacturingOrders", "update", { modelName: "ManufacturingOrder" }), ctrl.update);
router.patch("/:moNumber/remove", authorize("manufacturingOrders", "delete"), logger("manufacturingOrders", "delete", { modelName: "ManufacturingOrder" }), ctrl.remove);

module.exports = router;
