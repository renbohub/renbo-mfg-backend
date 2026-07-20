const router = require("express").Router();
const ctrl = require("../controllers/NotificationController");
const { authorize } = require("../middleware/auth");

// All users can access their own notifications
router.get("/", ctrl.list);
router.get("/unread-count", ctrl.getUnreadCount);
router.get("/:id", ctrl.get);
router.put("/:id/read", ctrl.markAsRead);
router.post("/mark-all-read", ctrl.markAllAsRead);

// Admin only - delete notification
router.delete("/:id", authorize("notifications", "delete"), ctrl.remove);

// Admin only - emergency manual cleanup trigger
// NOTE: Auto-cleanup sudah berjalan via cron setiap hari jam 2 pagi
// Endpoint ini hanya untuk emergency manual trigger
router.post("/auto-cleanup", authorize("notifications", "delete"), ctrl.autoCleanup);

module.exports = router;
