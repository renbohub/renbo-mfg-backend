const router = require("express").Router();
const ctrl = require("../../controllers/master-data/EmployeeController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");
const { uploadEmployeeImages } = require("../../middleware/uploads");

// special routes first
router.post("/bulk-create", authorize("employees", "create"), logger("employee", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("employees", "delete"), logger("employee", "bulk-remove", { modelName: 'employee' }), ctrl.bulkRemove);
router.get("/generate-code", authorize("employees", "read"), ctrl.generateCode);
router.get("/all-codes", authorize("employees", "read"), ctrl.getAllCodes);
router.get("/autocomplete", authorize("employees", "read"), ctrl.autocomplete);

// standard CRUD routes
router.get("/", authorize("employees", "read"), ctrl.list);
router.get("/:employeeId", authorize("employees", "read"), ctrl.get);
router.post("/", authorize("employees", "create"), uploadEmployeeImages, logger("employee", "create"), ctrl.create);
router.patch("/:id", authorize("employees", "update"), uploadEmployeeImages, logger("employee", "update", { modelName: 'employee' }), ctrl.update);
router.patch("/:id/remove", authorize("employees", "delete"), logger("employee", "delete"), ctrl.remove);

module.exports = router;
