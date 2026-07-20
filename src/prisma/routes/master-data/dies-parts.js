const router = require("express").Router();
const ctrl = require("../../controllers/master-data/DiesPartController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// special routes first
router.patch("/bulk-remove", authorize("dies", "delete"), logger("diesPart", "bulk-remove"), ctrl.bulkRemove);

// standard CRUD routes
router.get("/", authorize("dies", "read"), ctrl.list);
router.get("/:id", authorize("dies", "read"), ctrl.get);
router.post("/", authorize("dies", "create"), logger("diesPart", "create"), ctrl.create);
router.patch("/:id", authorize("dies", "update"), logger("diesPart", "update"), ctrl.update);
router.patch("/:id/remove", authorize("dies", "delete"), logger("diesPart", "delete"), ctrl.remove); // PATCH /:id/remove untuk soft delete

module.exports = router;
