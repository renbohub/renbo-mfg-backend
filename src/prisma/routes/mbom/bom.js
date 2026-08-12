const router = require("express").Router();
const c = require("../../controllers/mbom/BOMController");
const drafts = require("../../controllers/mbom/BOMDraftController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");
const { approvalGate } = require("../../services/approvalRuleService");
const mbomDraftApproval = approvalGate({ moduleCode: "manufacturing-bom", pageCode: "bill-of-materials", actionCode: "approve", documentType: "MBOMDraft", param: "id", model: "mBOMDraft", lookupField: "id", numberField: "draftNumber" });

// Stats dan bulk actions hashes di atas /:id agar tidak tertangkap sebagai ID
router.patch("/bulk-remove", authorize("mbom", "delete"), logger("mbom", "bulk-remove", { modelName: 'mBOMHeader' }), c.bulkRemove);
router.get("/drafts", authorize("mbom", "read"), drafts.list);
router.get("/drafts/:id", authorize("mbom", "read"), drafts.get);
router.post("/drafts", authorize("mbom", "create"), drafts.create);
router.patch("/drafts/:id", authorize("mbom", "update"), drafts.update);
router.post("/drafts/:id/complete", authorize("mbom", "create"), mbomDraftApproval, drafts.complete);
router.delete("/drafts/:id", authorize("mbom", "delete"), drafts.remove);

// Standard CRUD (logger untuk semua CUD operations)
router.get("/", authorize("mbom", "read"), c.list);
router.get("/:noReg/report", authorize("mbom", "export"), c.report);
router.get("/:noReg", authorize("mbom", "read"), c.get);
router.post("/", authorize("mbom", "create"), logger("mbom", "create"), c.create);
router.patch("/:id", authorize("mbom", "update"), logger("mbom", "update", { 
  modelName: 'mBOMHeader',
  includeOptions: {
    details: {
      where: { isDeleted: false },
      include: { part: { include: { material: true } } }
    }
  }
}), c.update);
router.delete("/:noReg", authorize("mbom", "delete"), logger("mbom", "delete"), c.remove);

module.exports = router;
