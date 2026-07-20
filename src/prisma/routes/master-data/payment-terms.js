const router = require("express").Router();
const ctrl = require("../../controllers/master-data/PaymentTermController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// special routes first
router.post("/bulk-create", authorize("paymentTerm", "create"), logger("paymentTerm", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("paymentTerm", "delete"), logger("paymentTerm", "bulk-remove", { modelName: 'paymentTerm' }), ctrl.bulkRemove);
router.get("/all-codes", authorize("paymentTerm", "read"), ctrl.getAllCodes); // /paymentTerm/all-codes
router.get("/autocomplete", authorize("paymentTerm", "read"), ctrl.autocomplete); // /paymentTerm/autocomplete?q=...&limit=...

// standard CRUD routes
router.get("/", authorize("paymentTerm", "read"), ctrl.list);
router.get("/:termCode", authorize("paymentTerm", "read"), ctrl.get);
router.post("/", authorize("paymentTerm", "create"), logger("paymentTerm", "create"), ctrl.create);
router.patch("/:id", authorize("paymentTerm", "update"), logger("paymentTerm", "update", { modelName: 'paymentTerm' }), ctrl.update);
router.patch("/:id/remove", authorize("paymentTerm", "delete"), logger("paymentTerm", "delete"), ctrl.remove); // PATCH /paymentTerm/:id/remove untuk soft delete

module.exports = router;
