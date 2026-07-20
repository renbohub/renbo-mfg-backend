const router = require("express").Router();
const ctrl = require("../../controllers/master-data/DepartmentController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// special routes first
router.post("/bulk-create", authorize("departments", "create"), logger("department", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("departments", "delete"), logger("department", "bulk-remove", { modelName: 'department' }), ctrl.bulkRemove);
router.get("/generate-code", authorize("departments", "read"), ctrl.generateCode);
router.get("/all-codes", authorize("departments", "read"), ctrl.getAllCodes);
router.get("/autocomplete", authorize("departments", "read"), ctrl.autocomplete);

// standard CRUD routes
router.get("/", authorize("departments", "read"), ctrl.list);
router.get("/:departmentCode", authorize("departments", "read"), ctrl.get);
router.post("/", authorize("departments", "create"), logger("department", "create"), ctrl.create);
router.patch("/:id", authorize("departments", "update"), logger("department", "update", { modelName: 'department' }), ctrl.update);
router.patch("/:id/remove", authorize("departments", "delete"), logger("department", "delete"), ctrl.remove);

module.exports = router;
