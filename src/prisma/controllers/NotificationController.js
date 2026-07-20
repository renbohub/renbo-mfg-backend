const prisma = require("../index").prisma;
const { notificationHelper } = require("../utils/notificationHelper");

/**
 * List notifications untuk current user dengan pagination
 * Query params: page, limit, type, isRead
 */
exports.list = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, type, isRead } = req.query;
    const userId = req.user.id; // Dari auth middleware

    const skip = (page - 1) * limit;
    const where = {
      OR: [{ userId: userId }, { userId: null }], // User's notifications + broadcast
    };

    // Filter by type
    if (type) {
      where.type = type;
    }

    // Filter by read status
    if (isRead !== undefined) {
      where.isRead = isRead === "true";
    }

    const [items, total] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: Number(skip),
        take: Number(limit),
      }),
      prisma.notification.count({ where }),
    ]);

    res.json({
      items,
      total,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (e) {
    next(e);
  }
};

/**
 * Get notification by ID
 */
exports.get = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const notification = await prisma.notification.findFirst({
      where: {
        id,
        OR: [{ userId: userId }, { userId: null }],
      },
    });

    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    res.json(notification);
  } catch (e) {
    next(e);
  }
};

/**
 * Mark notification as read
 */
exports.markAsRead = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const notification = await notificationHelper.markAsRead(id, userId);
    res.json(notification);
  } catch (e) {
    next(e);
  }
};

/**
 * Mark all notifications as read untuk current user
 */
exports.markAllAsRead = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const result = await notificationHelper.markAllAsRead(userId);

    res.json({
      message: "Semua notifikasi telah ditandai sebagai dibaca",
      count: result.count,
    });
  } catch (e) {
    next(e);
  }
};

/**
 * Get unread notification count untuk current user
 */
exports.getUnreadCount = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const count = await notificationHelper.getUnreadCount(userId);

    res.json({ count });
  } catch (e) {
    next(e);
  }
};

/**
 * Delete notification - ADMIN ONLY
 * User biasa tidak bisa delete notification secara manual.
 * Notification akan auto-cleanup via cron (sudah dibaca > 7 hari, atau > 30 hari).
 */
exports.remove = async (req, res, next) => {
  try {
    const { id } = req.params;

    const notification = await prisma.notification.findFirst({
      where: { id },
    });

    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    await prisma.notification.delete({
      where: { id },
    });

    res.json({ message: "Notification deleted successfully" });
  } catch (e) {
    next(e);
  }
};

/**
 * Auto cleanup notifikasi (komprehensif) - ADMIN ONLY for Emergency Manual Trigger
 * NOTE: Cleanup sudah berjalan otomatis via cron setiap hari jam 2 pagi.
 * Endpoint ini hanya untuk emergency manual trigger jika diperlukan.
 * 
 * Menghapus:
 * 1. Notifikasi lama (> oldDays, default 30)
 * 2. Notifikasi yang sudah dibaca (> readDays, default 7)
 * 3. Notifikasi melebihi limit per user (default 100)
 * 
 * Query params:
 * - oldDays: hapus semua notifikasi lebih tua dari X hari (default: 30)
 * - readDays: hapus notifikasi yang sudah dibaca lebih tua dari X hari (default: 7)
 * - userLimit: limit notifikasi per user (default: 100)
 */
exports.autoCleanup = async (req, res, next) => {
  try {
    const { oldDays = 30, readDays = 7, userLimit = 100 } = req.query;

    const summary = await notificationHelper.autoCleanup({
      oldDays: Number(oldDays),
      readDays: Number(readDays),
      userLimit: Number(userLimit),
    });

    res.json({
      message: "Auto-cleanup completed successfully",
      summary,
    });
  } catch (e) {
    next(e);
  }
};
