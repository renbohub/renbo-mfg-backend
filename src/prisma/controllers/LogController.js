const { prisma } = require('../index');
const { buildSort } = require('../utils/buildSort');
const { mapDoc } = require('../utils/mapDoc');

/**
 * List logs dengan filtering dan pagination
 * Query params:
 * - nameRoute: filter by route name
 * - action: filter by action (create, update, delete, dll)
 * - userId: filter by user ID
 * - username: filter by username
 * - statusCode: filter by HTTP status code
 * - method: filter by HTTP method (GET, POST, PUT, DELETE)
 * - dateFrom: filter from date (ISO format)
 * - dateTo: filter to date (ISO format)
 * - q: search in url or errorMessage
 * - page, limit, sort
 */
exports.list = async (req, res, next) => {
  try {
    const {
      nameRoute,
      action,
      userId,
      username,
      statusCode,
      method,
      dateFrom,
      dateTo,
      q,
      page = 1,
      limit = 50,
    } = req.query;

    // Build where clause
    const where = {};

    if (nameRoute) where.nameRoute = nameRoute;
    if (action) where.action = action;
    if (userId) where.userId = userId;
    if (username) where.username = { contains: username, mode: "insensitive" };
    if (statusCode) where.statusCode = parseInt(statusCode);
    if (method) where.method = method;

    // Date range filter
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) where.createdAt.lte = new Date(dateTo);
    }

    // Search in url or errorMessage
    if (q) {
      where.OR = [
        { url: { contains: q, mode: "insensitive" } },
        { errorMessage: { contains: q, mode: "insensitive" } },
      ];
    }

    // Sorting
    const allowedFields = [
      "nameRoute",
      "action",
      "method",
      "statusCode",
      "responseTime",
      "userId",
      "username",
      "ipAddress",
      "entityId",
      "createdAt",
    ];
    const sortObj = buildSort(req.query, {
      allowed: allowedFields,
      default: { createdAt: "desc" }, // Default sort by newest first
    });

    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.log.findMany({
        where,
        orderBy: sortObj,
        skip,
        take: Number(limit),
      }),
      prisma.log.count({ where }),
    ]);

    res.json({
      items: items.map(mapDoc),
      total,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (e) {
    next(e);
  }
};

/**
 * Get single log by ID
 */
exports.get = async (req, res, next) => {
  try {
    const { id } = req.params;

    const log = await prisma.log.findUnique({
      where: { id },
    });

    if (!log) {
      return res.status(404).json({ message: "Log tidak ditemukan" });
    }

    res.json(mapDoc(log));
  } catch (e) {
    next(e);
  }
};

/**
 * Get logs statistics/summary
 * Menampilkan statistik logs berdasarkan:
 * - Total logs by nameRoute
 * - Total logs by action
 * - Total logs by statusCode
 * - Average response time
 * - Error rate
 */
exports.stats = async (req, res, next) => {
  try {
    const { dateFrom, dateTo, nameRoute } = req.query;

    // Build where clause
    const where = {};
    if (nameRoute) where.nameRoute = nameRoute;

    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) where.createdAt.lte = new Date(dateTo);
    }

    const [
      totalLogs,
      byRoute,
      byAction,
      byStatus,
      avgResponseTime,
      errorCount,
    ] = await Promise.all([
      // Total logs
      prisma.log.count({ where }),

      // Group by nameRoute
      prisma.log.groupBy({
        by: ["nameRoute"],
        where,
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
      }),

      // Group by action
      prisma.log.groupBy({
        by: ["action"],
        where,
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
      }),

      // Group by statusCode
      prisma.log.groupBy({
        by: ["statusCode"],
        where,
        _count: { id: true },
        orderBy: { statusCode: "asc" },
      }),

      // Average response time
      prisma.log.aggregate({
        where: { ...where, responseTime: { not: null } },
        _avg: { responseTime: true },
      }),

      // Error count (statusCode >= 400)
      prisma.log.count({
        where: { ...where, statusCode: { gte: 400 } },
      }),
    ]);

    res.json({
      totalLogs,
      errorCount,
      errorRate:
        totalLogs > 0
          ? ((errorCount / totalLogs) * 100).toFixed(2) + "%"
          : "0%",
      avgResponseTime: avgResponseTime._avg.responseTime
        ? Math.round(avgResponseTime._avg.responseTime) + "ms"
        : null,
      byRoute: byRoute.map((r) => ({
        nameRoute: r.nameRoute,
        count: r._count.id,
      })),
      byAction: byAction.map((a) => ({ action: a.action, count: a._count.id })),
      byStatus: byStatus.map((s) => ({
        statusCode: s.statusCode,
        count: s._count.id,
      })),
    });
  } catch (e) {
    next(e);
  }
};

/**
 * Delete old logs (cleanup)
 * Body: { daysOld: number }
 * Contoh: { "daysOld": 90 } akan hapus logs > 90 hari
 */
exports.cleanup = async (req, res, next) => {
  try {
    const { daysOld } = req.body;

    if (!daysOld || daysOld < 1) {
      return res
        .status(400)
        .json({ message: "daysOld harus berisi angka minimal 1" });
    }

    const dateThreshold = new Date();
    dateThreshold.setDate(dateThreshold.getDate() - daysOld);

    const result = await prisma.log.deleteMany({
      where: {
        createdAt: { lt: dateThreshold },
      },
    });

    res.json({
      ok: true,
      message: `Berhasil menghapus ${result.count} log yang lebih lama dari ${daysOld} hari`,
      deletedCount: result.count,
    });
  } catch (e) {
    next(e);
  }
};

/**
 * Get recent activities by user
 * Untuk menampilkan aktivitas terakhir user
 */
exports.userActivities = async (req, res, next) => {
  try {
    const { userId, limit = 20 } = req.query;

    if (!userId) {
      return res.status(400).json({ message: "userId wajib diisi" });
    }

    const activities = await prisma.log.findMany({
      where: {
        userId,
        action: { notIn: ["error"] }, // Exclude error logs
      },
      orderBy: { createdAt: "desc" },
      take: Number(limit),
      select: {
        id: true,
        nameRoute: true,
        action: true,
        method: true,
        url: true,
        statusCode: true,
        createdAt: true,
      },
    });

    res.json({
      userId,
      activities: activities.map(mapDoc),
    });
  } catch (e) {
    next(e);
  }
};

/**
 * Export logs to CSV (optional feature)
 * Bisa ditambahkan nanti jika diperlukan
 */
exports.exportCsv = async (req, res, next) => {
  try {
    // TODO: Implement CSV export jika diperlukan
    res.status(501).json({ message: "Export CSV belum diimplementasikan" });
  } catch (e) {
    next(e);
  }
};
