const router = require("express").Router();
const ctrl = require("../../controllers/master-data/PartController");
const { authorize } = require("../../middleware/auth");
const { uploadPartAttachment } = require("../../middleware/uploads");

// List & search
router.get("/", authorize("part-attachments", "read"), ctrl.listAttachments);

// Get by ID
router.get("/:id", authorize("part-attachments", "read"), ctrl.getAttachment);

// Get by Part ID
router.get(
  "/by-part/:partId",
  authorize("part-attachments", "read"),
  ctrl.getAttachmentsByPartId
);

// Create (dengan upload, support multiple files)
router.post(
  "/",
  authorize("part-attachments", "create"),
  uploadPartAttachment.array("files", 10),
  ctrl.createAttachment
);

// Update (dengan upload, support multiple files baru)
router.put(
  "/:id",
  authorize("part-attachments", "update"),
  uploadPartAttachment.array("files", 10),
  ctrl.updateAttachment
);

// Soft delete
router.delete("/:id", authorize("part-attachments", "delete"), ctrl.removeAttachment);

// Bulk delete
router.post(
  "/bulk-remove",
  authorize("part-attachments", "delete"),
  ctrl.bulkRemoveAttachments
);

module.exports = router;
