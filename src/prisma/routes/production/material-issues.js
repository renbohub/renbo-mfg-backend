const router = require("express").Router();
const ctrl = require("../../controllers/production/MaterialIssueController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// Helper routes HARUS di atas /:issueNumber
router.get("/generate-number", authorize("materialIssues", "create"), ctrl.generateNumber);
router.patch("/bulk-remove", authorize("materialIssues", "delete"), logger("materialIssues", "bulk-remove", { modelName: "MaterialIssue" }), ctrl.bulkRemove);

// Status transitions
router.patch("/:issueNumber/prepare", authorize("materialIssues", "issue"), logger("materialIssues", "prepare", { modelName: "MaterialIssue" }), ctrl.prepare);
router.patch("/:issueNumber/issue", authorize("materialIssues", "issue"), logger("materialIssues", "issue", { modelName: "MaterialIssue" }), ctrl.issue);
router.patch("/:issueNumber/close", authorize("materialIssues", "close"), logger("materialIssues", "close", { modelName: "MaterialIssue" }), ctrl.close);

// Standard CRUD
router.get("/",              authorize("materialIssues", "read"),   ctrl.list);
router.get("/:issueNumber",  authorize("materialIssues", "read"),   ctrl.get);
router.post("/",             authorize("materialIssues", "create"), logger("materialIssues", "create"), ctrl.create);
router.patch("/:issueNumber",        authorize("materialIssues", "update"), logger("materialIssues", "update", { modelName: "MaterialIssue" }), ctrl.update);
router.patch("/:issueNumber/remove", authorize("materialIssues", "delete"), logger("materialIssues", "delete", { modelName: "MaterialIssue" }), ctrl.remove);

module.exports = router;
