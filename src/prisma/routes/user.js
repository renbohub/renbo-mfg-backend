const router = require("express").Router();
const ctrl = require("../controllers/AuthController");
const { auth, authorize } = require("../middleware/auth");

// Self profile routes
router.get("/profile", auth, ctrl.profile);
router.patch("/profile", auth, ctrl.updateProfile);
router.patch("/profile/password", auth, ctrl.updateProfilePassword);

// special routes first
router.post("/bulk-remove", auth, authorize("users", "delete"), ctrl.bulkRemove);
router.get("/stats", auth, authorize("users", "read"), ctrl.stats);

// standard CRUD routes
router.get("/list", auth, authorize("users", "read"), ctrl.list);
router.get("/email/:email", auth, authorize("users", "read"), ctrl.getByEmail);
router.get("/:username", auth, authorize("users", "read"), ctrl.get);
router.patch("/:id", auth, authorize("users", "update"), ctrl.update);
router.patch(
  "/:id/password",
  auth,
  authorize("users", "update"),
  ctrl.updatePassword
);
router.delete("/:id", auth, authorize("users", "delete"), ctrl.remove);


module.exports = router;
