const router = require("express").Router();
const ctrl = require("../../controllers/master-data/PartController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");
const { uploadPartWithAttachments } = require("../../middleware/uploads");

// special routes first
router.post("/bulk-create", authorize("parts", "create"), logger("part", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("parts", "delete"), logger("part", "bulk-remove", { modelName: 'part' }), ctrl.bulkRemove);
router.get("/all-codes", authorize("parts", "read"), ctrl.getAllCodes);
router.get("/migrate-part-codes/candidates", authorize("parts", "read"), ctrl.partCodeMigrationCandidates);
router.post("/migrate-part-codes", authorize("parts", "update"), logger("part", "migrate-part-codes", { modelName: 'part' }), ctrl.migratePartCodesToPrimaryCustomer);
router.post("/:id/clone", authorize("parts", "create"), logger("part", "clone", { modelName: 'part' }), ctrl.clone);

// CRUD routes
router.get("/", authorize("parts", "read"), ctrl.list);
router.get("/:partCode", authorize("parts", "read"), ctrl.get);
router.post("/", authorize("parts", "create"), uploadPartWithAttachments, logger("part", "create"), ctrl.create);
router.patch("/:id", authorize("parts", "update"), uploadPartWithAttachments, logger("part", "update", { modelName: 'part' }), ctrl.update);
router.patch("/:id/remove", authorize("parts", "delete"), logger("part", "delete"), ctrl.remove); // PATCH /parts/:id/remove untuk soft delete

module.exports = router;
