const router = require("express").Router();
const controller = require("../../controllers/system/ApprovalRuleController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.get("/roles", authorize("approval-rules", "read"), controller.roles);
router.get("/resolve", authorize("approval-rules", "read"), controller.resolve);
router.get("/", authorize("approval-rules", "read"), controller.list);
router.get("/:id", authorize("approval-rules", "read"), controller.get);
router.post("/", authorize("approval-rules", "create"), logger("approval-rules", "create"), controller.create);
router.patch("/:id", authorize("approval-rules", "update"), logger("approval-rules", "update", { modelName: "approvalRule" }), controller.update);
router.patch("/:id/remove", authorize("approval-rules", "delete"), logger("approval-rules", "delete", { modelName: "approvalRule" }), controller.remove);

module.exports = router;
