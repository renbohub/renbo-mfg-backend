const router = require("express").Router();
const controller = require("../../controllers/system/ApprovalController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.get("/document/:moduleCode/:pageCode/:documentId", authorize("approvals", "read"), controller.byDocument);
router.get("/", authorize("approvals", "read"), controller.list);
router.get("/:id", authorize("approvals", "read"), controller.get);
router.post("/submit", authorize("approvals", "submit"), logger("approvals", "submit"), controller.submit);
router.post("/:requestNumber/approve", authorize("approvals", "approve"), logger("approvals", "approve"), controller.approve);
router.post("/:requestNumber/reject", authorize("approvals", "approve"), logger("approvals", "reject"), controller.reject);
router.post("/:requestNumber/cancel", authorize("approvals", "update"), logger("approvals", "cancel"), controller.cancel);

module.exports = router;
