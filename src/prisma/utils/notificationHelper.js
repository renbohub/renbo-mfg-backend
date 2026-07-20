const prisma = require("../index").prisma;

const toPathSafePoNumber = (poNumber) =>
  String(poNumber || "").replace(/\//g, "-");

/**
 * Notification Helper
 * Central utility untuk create & broadcast notifications via Socket.io
 */

const notificationHelper = {
  hasPermission(user, resource, action = "read") {
    if (!user || user.isDeleted) return false;
    if (user.isSuperAdmin) return true;

    const listMenu = Array.isArray(user.listMenu) ? user.listMenu : [];
    const requiredAction = String(action).toLowerCase();

    return listMenu.some((entry) => {
      if (!entry || typeof entry !== "object" || !entry.resource) return false;
      if (String(entry.resource).toLowerCase() !== String(resource).toLowerCase()) return false;

      const actions = Array.isArray(entry.actions)
        ? entry.actions.map((x) => String(x).toLowerCase())
        : [];

      if (actions.includes("*")) return true;
      if (actions.length === 0 && requiredAction === "read") return true;
      if (requiredAction === "read") {
        return ["read", "create", "update", "delete", "approve"].some((x) => actions.includes(x));
      }

      return actions.includes(requiredAction);
    });
  },

  async getUserIdsByPermission(resource, action) {
    const users = await prisma.user.findMany({
      where: { isDeleted: false },
      select: {
        id: true,
        isSuperAdmin: true,
        listMenu: true,
      },
    });

    return users
      .filter((user) => this.hasPermission(user, resource, action))
      .map((user) => user.id);
  },

  /**
   * Create notification dan broadcast via socket
   * @param {Object} data - Notification data
   * @param {string} data.type - Tipe notification (purchase_order, sales_order, dll)
   * @param {string} data.title - Judul notification
   * @param {string} data.message - Detail message
   * @param {string} [data.entityId] - ID/identifier entity terkait
   * @param {string} [data.entityUrl] - Deep link ke detail page
   * @param {string} [data.userId] - Target user (null = broadcast ke semua)
   * @param {Object} [data.metadata] - Additional data
   * @param {string} [data.createdBy] - User yang trigger notification
   * @returns {Promise<Object>} Created notification
   */
  async create(data) {
    try {
      const {
        type,
        title,
        message,
        entityId,
        entityUrl,
        userId,
        metadata = {},
        createdBy,
      } = data;

      // Validate required fields
      if (!type || !title || !message) {
        throw new Error("type, title, dan message wajib diisi");
      }

      // Create notification di database
      const notification = await prisma.notification.create({
        data: {
          type,
          title,
          message,
          entityId,
          entityUrl,
          userId,
          metadata,
          createdBy,
        },
      });

      // Broadcast via Socket.io
      this.broadcast(notification);

      return notification;
    } catch (error) {
      console.error("Error creating notification:", error);
      throw error;
    }
  },

  /**
   * Broadcast notification via Socket.io
   * @param {Object} notification - Notification object
   */
  broadcast(notification) {
    try {
      const io = global.io;
      if (!io) {
        console.warn("Socket.io not initialized, skipping broadcast");
        return;
      }

      if (notification.userId) {
        // Targeted notification ke specific user
        io.to(`user:${notification.userId}`).emit("notification", notification);
        console.log(`📨 Notification sent to user: ${notification.userId}`);
      } else {
        // Broadcast ke semua connected clients
        io.emit("notification", notification);
        console.log(`📢 Notification broadcasted to all users`);
      }
    } catch (error) {
      console.error("Error broadcasting notification:", error);
    }
  },

  /**
   * Mark notification sebagai read
   * @param {string} notificationId - ID notification
   * @param {string} userId - User ID (untuk security check)
   * @returns {Promise<Object>} Updated notification
   */
  async markAsRead(notificationId, userId) {
    try {
      // Verify notification belongs to user atau adalah broadcast notification
      const notification = await prisma.notification.findFirst({
        where: {
          id: notificationId,
          OR: [{ userId: userId }, { userId: null }],
        },
      });

      if (!notification) {
        throw new Error("Notification not found atau tidak memiliki akses");
      }

      const updated = await prisma.notification.update({
        where: { id: notificationId },
        data: {
          isRead: true,
          readAt: new Date(),
        },
      });

      return updated;
    } catch (error) {
      console.error("Error marking notification as read:", error);
      throw error;
    }
  },

  /**
   * Mark all notifications sebagai read untuk user tertentu
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Update result
   */
  async markAllAsRead(userId) {
    try {
      const result = await prisma.notification.updateMany({
        where: {
          OR: [{ userId: userId }, { userId: null }],
          isRead: false,
        },
        data: {
          isRead: true,
          readAt: new Date(),
        },
      });

      return result;
    } catch (error) {
      console.error("Error marking all notifications as read:", error);
      throw error;
    }
  },

  /**
   * Get unread count untuk user
   * @param {string} userId - User ID
   * @returns {Promise<number>} Unread count
   */
  async getUnreadCount(userId) {
    try {
      const count = await prisma.notification.count({
        where: {
          OR: [{ userId: userId }, { userId: null }],
          isRead: false,
        },
      });

      return count;
    } catch (error) {
      console.error("Error getting unread count:", error);
      throw error;
    }
  },

  /**
   * Helper untuk create notification Purchase Order
   * @param {string} action - create, update, approve, reject
   * @param {Object} po - Purchase Order object
   * @param {string} createdBy - User yang trigger action
   */
  async notifyPurchaseOrder(action, po, createdBy, options = {}) {
    const actionMessages = {
      create: {
        title: "Purchase Order Baru",
        message: `PO #${po.poNumber} telah dibuat oleh ${createdBy}. Total: Rp ${po.totalAmount?.toLocaleString() || 0}`,
      },
      update: {
        title: "Purchase Order Diupdate",
        message: `PO #${po.poNumber} telah diupdate oleh ${createdBy}`,
      },
      "submit-checking": {
        title: "Purchase Order Perlu Checking",
        message: `PO #${po.poNumber} telah diajukan oleh ${createdBy} dan menunggu ${po.status}`,
      },
      check: {
        title: "Purchase Order Perlu Checking",
        message: `PO #${po.poNumber} telah dicek oleh ${createdBy} dan menunggu ${po.status}`,
      },
      approve: {
        title: "Purchase Order Disetujui",
        message: `PO #${po.poNumber} telah disetujui`,
      },
      revise: {
        title: "Purchase Order Perlu Revisi",
        message: `PO #${po.poNumber} dikembalikan untuk revisi oleh ${createdBy}: ${po.revisionReason || "-"}`,
      },
      reject: {
        title: "Purchase Order Ditolak",
        message: `PO #${po.poNumber} telah ditolak`,
      },
    };

    const config = actionMessages[action];
    if (!config) {
      console.warn(`Unknown PO action: ${action}`);
      return;
    }

    let targetUserIds = Array.isArray(options.userIds) ? options.userIds : null;
    if (!targetUserIds && options.permission) {
      targetUserIds = await this.getUserIdsByPermission(
        options.permission.resource,
        options.permission.action,
      );
    }

    const notificationData = {
      type: "purchase_order",
      title: config.title,
      message: config.message,
      entityId: po.poNumber,
      entityUrl: `/app/purchasing/purchase-order/${toPathSafePoNumber(po.poNumber)}`,
      metadata: {
        action,
        supplierCode: po.supplierCode,
        totalAmount: po.totalAmount,
        status: po.status,
        revisionReason: po.revisionReason,
      },
      createdBy,
    };

    if (targetUserIds) {
      const uniqueUserIds = [...new Set(targetUserIds)].filter(Boolean);
      if (!uniqueUserIds.length) return [];

      return Promise.all(
        uniqueUserIds.map((userId) =>
          this.create({
            ...notificationData,
            userId,
          }),
        ),
      );
    }

    return this.create({
      ...notificationData,
      userId: null, // Broadcast ke semua user
    });
  },

  /**
   * Helper untuk create notification Sales Order
   * @param {string} action - create, update, confirm, approve, reject, cancel
   * @param {Object} so - Sales Order object
   * @param {string} createdBy - User yang trigger action
   */
  async notifySalesOrder(action, so, createdBy) {
    const actionMessages = {
      create: {
        title: "Sales Order Baru",
        message: `SO #${so.soNumber} telah dibuat oleh ${createdBy}. Total: Rp ${so.totalAmount?.toLocaleString() || 0}`,
      },
      update: {
        title: "Sales Order Diupdate",
        message: `SO #${so.soNumber} telah diupdate oleh ${createdBy}`,
      },
      confirm: {
        title: "Sales Order Dikonfirmasi",
        message: `SO #${so.soNumber} telah dikonfirmasi`,
      },
      approve: {
        title: "Sales Order Disetujui",
        message: `SO #${so.soNumber} telah disetujui`,
      },
      reject: {
        title: "Sales Order Ditolak",
        message: `SO #${so.soNumber} telah ditolak`,
      },
      cancel: {
        title: "Sales Order Dibatalkan",
        message: `SO #${so.soNumber} telah dibatalkan`,
      },
      complete: {
        title: "Sales Order Selesai",
        message: `SO #${so.soNumber} telah diselesaikan`,
      },
    };

    const config = actionMessages[action];
    if (!config) {
      console.warn(`Unknown SO action: ${action}`);
      return;
    }

    await this.create({
      type: "sales_order",
      title: config.title,
      message: config.message,
      entityId: so.soNumber,
      entityUrl: `/app/sales/sales-order/${so.soNumber}`,
      userId: null,
      metadata: {
        action,
        customerCode: so.customerCode,
        totalAmount: so.totalAmount,
        status: so.status,
      },
      createdBy,
    });
  },

  /**
   * Generic notification helper
   * @param {string} type - Notification type
   * @param {string} action - Action performed
   * @param {Object} entity - Entity object
   * @param {string} entityIdentifier - Entity identifier (e.g., poNumber, soNumber)
   * @param {string} createdBy - User yang trigger action
   * @param {string} entityUrl - Entity URL (dengan query param untuk modal)
   */
  async notifyGeneric(type, action, entity, entityIdentifier, createdBy, entityUrl = null) {
    await this.create({
      type,
      title: `${type} ${action}`,
      message: `${type} #${entityIdentifier} telah ${action} oleh ${createdBy}`,
      entityId: entityIdentifier,
      entityUrl, // Optional custom URL
      userId: null,
      metadata: { action },
      createdBy,
    });
  },

  /**
   * Helper untuk create notification EBOM
   */
  async notifyEBOM(action, ebom, createdBy) {
    const actionMessages = {
      create: {
        title: "EBOM Baru",
        message: `EBOM #${ebom.noReg} telah dibuat oleh ${createdBy}`,
      },
      update: {
        title: "EBOM Diupdate",
        message: `EBOM #${ebom.noReg} telah diupdate oleh ${createdBy}`,
      },
      pending: {
        title: "EBOM Diajukan",
        message: `EBOM #${ebom.noReg} telah diajukan oleh ${createdBy}`,
      },
      approved: {
        title: "EBOM Disetujui",
        message: `EBOM #${ebom.noReg} telah disetujui`,
      },
      rejected: {
        title: "EBOM Ditolak",
        message: `EBOM #${ebom.noReg} telah ditolak`,
      },
      obsolete: {
        title: "EBOM Obsolete",
        message: `EBOM #${ebom.noReg} telah dibuat obsolete`,
      },
    };

    const config = actionMessages[action];
    if (!config) return;

    await this.create({
      type: "ebom",
      title: config.title,
      message: config.message,
      entityId: ebom.noReg,
      entityUrl: `/app/engineering-bom/ebom/${ebom.noReg}`,
      userId: null,
      metadata: { action, status: ebom.status },
      createdBy,
    });
  },

  /**
   * Helper untuk create notification MBOM
   */
  async notifyMBOM(action, mbom, createdBy) {
    const actionMessages = {
      create: {
        title: "MBOM Baru",
        message: `MBOM #${mbom.noReg} telah dibuat oleh ${createdBy}`,
      },
      update: {
        title: "MBOM Diupdate",
        message: `MBOM #${mbom.noReg} telah diupdate oleh ${createdBy}`,
      },
      approve: {
        title: "MBOM Disetujui",
        message: `MBOM #${mbom.noReg} telah disetujui`,
      },
    };

    const config = actionMessages[action];
    if (!config) return;

    await this.create({
      type: "mbom",
      title: config.title,
      message: config.message,
      entityId: mbom.noReg,
      entityUrl: `/app/manufacturing-bom/mbom/${mbom.noReg}`,
      userId: null,
      metadata: { action },
      createdBy,
    });
  },

  /**
   * Helper untuk create notification Goods Receipt
  * @param {string} action - create, update, complete, reject
   * @param {Object} gr - Goods Receipt object
   * @param {string} createdBy - User yang trigger action
   */
  async notifyGoodsReceipt(action, gr, createdBy) {
    const actionMessages = {
      create: {
        title: "Goods Receipt Baru",
        message: `GR #${gr.grNumber} telah dibuat oleh ${createdBy}`,
      },
      update: {
        title: "Goods Receipt Diupdate",
        message: `GR #${gr.grNumber} telah diupdate oleh ${createdBy}`,
      },
      complete: {
        title: "Goods Receipt Selesai",
        message: `GR #${gr.grNumber} telah diselesaikan`,
      },
      reject: {
        title: "Goods Receipt Ditolak",
        message: `GR #${gr.grNumber} telah ditolak`,
      },
    };

    const config = actionMessages[action];
    if (!config) {
      console.warn(`Unknown Goods Receipt action: ${action}`);
      return;
    }

    await this.create({
      type: "goods_receipt",
      title: config.title,
      message: config.message,
      entityId: gr.grNumber,
      entityUrl: `/app/purchasing/good-receipt/${gr.grNumber}`,
      userId: null,
      metadata: {
        action,
        poNumber: gr.poNumber,
        warehouseCode: gr.warehouseCode,
        status: gr.status,
      },
      createdBy,
    });
  },

  /**
   * Helper untuk create notification Delivery Schedule
   * @param {string} action - create, update, schedule, in-progress, complete, cancel
   * @param {Object} ds - Delivery Schedule object
   * @param {string} createdBy - User yang trigger action
   */
  async notifyDeliverySchedule(action, ds, createdBy) {
    const actionMessages = {
      create: {
        title: "Delivery Schedule Baru",
        message: `Delivery Schedule #${ds.scheduleNumber} telah dibuat oleh ${createdBy}`,
      },
      update: {
        title: "Delivery Schedule Diupdate",
        message: `Delivery Schedule #${ds.scheduleNumber} telah diupdate oleh ${createdBy}`,
      },
      schedule: {
        title: "Delivery Dijadwalkan",
        message: `Delivery Schedule #${ds.scheduleNumber} telah dijadwalkan`,
      },
      'in-progress': {
        title: "Delivery Sedang Berlangsung",
        message: `Delivery Schedule #${ds.scheduleNumber} sedang dalam proses pengiriman`,
      },
      complete: {
        title: "Delivery Selesai",
        message: `Delivery Schedule #${ds.scheduleNumber} telah diselesaikan`,
      },
      cancel: {
        title: "Delivery Dibatalkan",
        message: `Delivery Schedule #${ds.scheduleNumber} telah dibatalkan`,
      },
    };

    const config = actionMessages[action];
    if (!config) {
      console.warn(`Unknown Delivery Schedule action: ${action}`);
      return;
    }

    await this.create({
      type: "delivery_schedule",
      title: config.title,
      message: config.message,
      entityId: ds.scheduleNumber,
      entityUrl: `/app/sales/so-delivery-schedule/${ds.scheduleNumber}`,
      userId: null,
      metadata: {
        action,
        soNumber: ds.soNumber,
        status: ds.status,
        plannedDate: ds.plannedDate,
      },
      createdBy,
    });
  },

  /**
   * Helper untuk create notification Quotation
   * @param {string} action - create, update, accept, reject, expire, convert
   * @param {Object} quotation - Quotation object
   * @param {string} createdBy - User yang trigger action
   */
  async notifyQuotation(action, quotation, createdBy) {
    const actionMessages = {
      create: {
        title: "Quotation Baru",
        message: `Quotation #${quotation.quotationNumber} telah dibuat oleh ${createdBy}. Total: Rp ${quotation.totalAmount?.toLocaleString() || 0}`,
      },
      update: {
        title: "Quotation Diupdate",
        message: `Quotation #${quotation.quotationNumber} telah diupdate oleh ${createdBy}`,
      },
      accept: {
        title: "Quotation Diterima",
        message: `Quotation #${quotation.quotationNumber} telah diterima`,
      },
      reject: {
        title: "Quotation Ditolak",
        message: `Quotation #${quotation.quotationNumber} telah ditolak`,
      },
      expire: {
        title: "Quotation Kadaluarsa",
        message: `Quotation #${quotation.quotationNumber} telah kadaluarsa`,
      },
      convert: {
        title: "Quotation Dikonversi",
        message: `Quotation #${quotation.quotationNumber} telah dikonversi ke Sales Order`,
      },
    };

    const config = actionMessages[action];
    if (!config) {
      console.warn(`Unknown Quotation action: ${action}`);
      return;
    }

    await this.create({
      type: "quotation",
      title: config.title,
      message: config.message,
      entityId: quotation.quotationNumber,
      entityUrl: `/app/sales/quotation/${quotation.quotationNumber}`,
      userId: null,
      metadata: {
        action,
        customerCode: quotation.customerCode,
        totalAmount: quotation.totalAmount,
        status: quotation.status,
      },
      createdBy,
    });
  },

  // ============================================
  // AUTO-CLEANUP FUNCTIONS
  // ============================================

  /**
   * Delete notifikasi yang lebih tua dari X hari
   * @param {number} days - Jumlah hari (default: 30)
   * @returns {Promise<Object>} Delete result { count }
   */
  async cleanupOldNotifications(days = 30) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const result = await prisma.notification.deleteMany({
        where: {
          createdAt: {
            lt: cutoffDate,
          },
        },
      });

      console.log(
        `🧹 Cleaned up ${result.count} notifications older than ${days} days`
      );
      return result;
    } catch (error) {
      console.error("Error cleaning up old notifications:", error);
      throw error;
    }
  },

  /**
   * Delete notifikasi yang sudah dibaca dan lebih tua dari X hari
   * @param {number} days - Jumlah hari (default: 7)
   * @returns {Promise<Object>} Delete result { count }
   */
  async cleanupReadNotifications(days = 7) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const result = await prisma.notification.deleteMany({
        where: {
          isRead: true,
          readAt: {
            lt: cutoffDate,
          },
        },
      });

      console.log(
        `🧹 Cleaned up ${result.count} read notifications older than ${days} days`
      );
      return result;
    } catch (error) {
      console.error("Error cleaning up read notifications:", error);
      throw error;
    }
  },

  /**
   * Limit notifikasi per user (hapus yang paling lama jika melebihi limit)
   * @param {string} userId - User ID (null untuk broadcast notifications)
   * @param {number} limit - Jumlah maksimal notifikasi per user (default: 100)
   * @returns {Promise<Object>} Delete result { count }
   */
  async limitUserNotifications(userId, limit = 100) {
    try {
      // Get total count untuk user ini
      const where = userId ? { userId } : { userId: null };
      const total = await prisma.notification.count({ where });

      if (total <= limit) {
        return { count: 0 }; // Tidak perlu cleanup
      }

      // Get ID dari notifikasi yang akan dihapus (yang paling lama)
      const toDelete = await prisma.notification.findMany({
        where,
        orderBy: { createdAt: "asc" },
        take: total - limit,
        select: { id: true },
      });

      const idsToDelete = toDelete.map((n) => n.id);

      const result = await prisma.notification.deleteMany({
        where: {
          id: { in: idsToDelete },
        },
      });

      console.log(
        `🧹 Cleaned up ${result.count} notifications for ${userId || "broadcast"} (limit: ${limit})`
      );
      return result;
    } catch (error) {
      console.error("Error limiting user notifications:", error);
      throw error;
    }
  },

  /**
   * Auto cleanup komprehensif (bisa dijadwalkan dengan cron)
   * @param {Object} options - Cleanup options
   * @param {number} options.oldDays - Hapus semua notifikasi lebih tua dari X hari (default: 30)
   * @param {number} options.readDays - Hapus notifikasi yang sudah dibaca lebih tua dari X hari (default: 7)
   * @param {number} options.userLimit - Limit notifikasi per user (default: 100)
   * @returns {Promise<Object>} Cleanup summary
   */
  async autoCleanup(options = {}) {
    try {
      const { oldDays = 30, readDays = 7, userLimit = 100 } = options;

      console.log("🚀 Starting notification auto-cleanup...");

      // 1. Cleanup notifikasi lama (> 30 hari)
      const oldResult = await this.cleanupOldNotifications(oldDays);

      // 2. Cleanup notifikasi yang sudah dibaca (> 7 hari)
      const readResult = await this.cleanupReadNotifications(readDays);

      // 3. Limit notifikasi per user
      // Get all unique userIds
      const users = await prisma.notification.findMany({
        where: { userId: { not: null } },
        distinct: ["userId"],
        select: { userId: true },
      });

      let limitCount = 0;
      for (const user of users) {
        const result = await this.limitUserNotifications(
          user.userId,
          userLimit
        );
        limitCount += result.count;
      }

      // Limit untuk broadcast notifications (userId = null)
      const broadcastResult = await this.limitUserNotifications(null, userLimit);
      limitCount += broadcastResult.count;

      const summary = {
        totalDeleted: oldResult.count + readResult.count + limitCount,
        oldNotifications: oldResult.count,
        readNotifications: readResult.count,
        limitExceeded: limitCount,
        timestamp: new Date(),
      };

      console.log("✅ Auto-cleanup completed:", summary);
      return summary;
    } catch (error) {
      console.error("Error in auto-cleanup:", error);
      throw error;
    }
  },
};

module.exports = { notificationHelper };
