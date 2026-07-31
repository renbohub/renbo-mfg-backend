const { prisma } = require("../index");
const {
  activityEvent,
  classifyAlarm,
  clean,
  inferModuleFromLog,
  inferPageFromLog,
  resolvePageContext,
} = require("../utils/pageContext");

const MAX_LIMIT = 200;

function limitOf(value, fallback = 30) {
  return Math.min(Math.max(Number(value) || fallback, 1), MAX_LIMIT);
}

function requireScope(req, res) {
  const moduleCode = clean(req.query.module || req.body?.module);
  const pageCode = clean(req.query.page || req.body?.page);
  const recordKey = clean(req.query.record || req.body?.record);
  if (!moduleCode || !pageCode) {
    res.status(400).json({ message: "module dan page wajib diisi." });
    return null;
  }
  return { moduleCode, pageCode, recordKey };
}

function scopedLogWhere(scope) {
  const where = {
    moduleCode: { equals: scope.moduleCode, mode: "insensitive" },
    pageCode: { equals: scope.pageCode, mode: "insensitive" },
  };
  if (scope.recordKey) {
    where.OR = [
      { recordKey: { equals: scope.recordKey, mode: "insensitive" } },
      { recordKey: null, entityId: { equals: scope.recordKey, mode: "insensitive" } },
    ];
  }
  return where;
}

function scopedCommentWhere(scope) {
  return {
    moduleCode: { equals: scope.moduleCode, mode: "insensitive" },
    pageCode: { equals: scope.pageCode, mode: "insensitive" },
    recordKey: scope.recordKey
      ? { equals: scope.recordKey, mode: "insensitive" }
      : null,
    isDeleted: false,
  };
}

function serializeLog(item) {
  const details = item.changes?.errorDetails || item.changes?.workflowDetails || null;
  const alarmType = item.logType === "ALARM"
    ? "ALARM"
    : item.logType === "ERROR" || item.statusCode >= 400 || item.errorMessage
      ? classifyAlarm(item.statusCode, details || { message: item.errorMessage }) || "ERROR"
      : null;
  const event = alarmType ? null : activityEvent(item.action, item.method, item.url, details || {}, item.statusCode);
  if (!alarmType && !event) return null;
  return {
    id: item.id,
    type: alarmType || "LOG",
    module: inferModuleFromLog(item),
    page: inferPageFromLog(item),
    record: item.recordKey || item.entityId || null,
    action: event || item.action,
    method: item.method,
    url: item.url,
    statusCode: item.statusCode,
    responseTime: item.responseTime,
    username: item.username || "System",
    message: item.errorMessage || null,
    details,
    changes: item.changes || null,
    createdAt: item.createdAt,
  };
}

function serializeComment(item) {
  return {
    id: item.id,
    type: "COMMENT",
    module: item.moduleCode,
    page: item.pageCode,
    record: item.recordKey,
    username: item.username || "User",
    message: item.message,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

exports.list = async (req, res, next) => {
  try {
    const scope = requireScope(req, res);
    if (!scope) return;
    const limit = limitOf(req.query.limit);
    const logWhere = scopedLogWhere(scope);
    const [activityRows, errorRows, comments] = await Promise.all([
      prisma.log.findMany({
        where: {
          ...logWhere,
          logType: "ACTIVITY",
          statusCode: { lt: 400 },
          errorMessage: null,
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(limit * 8, 800),
      }),
      prisma.log.findMany({
        where: {
          AND: [
            logWhere,
            {
              OR: [
                { logType: "ERROR" },
                { logType: "ALARM" },
                { statusCode: { gte: 400 } },
                { errorMessage: { not: null } },
              ],
            },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      prisma.pageComment.findMany({
        where: scopedCommentWhere(scope),
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
    ]);

    const activities = activityRows.map(serializeLog).filter(Boolean).slice(0, limit);
    const errors = errorRows.map(serializeLog).filter(Boolean).slice(0, limit);
    res.json({
      context: scope,
      activities,
      errors,
      comments: comments.map(serializeComment),
      counts: {
        activities: activities.length,
        errors: errors.length,
        comments: comments.length,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.createComment = async (req, res, next) => {
  try {
    const scope = requireScope(req, res);
    if (!scope) return;
    const message = clean(req.body?.message, 4000);
    if (!message) return res.status(400).json({ message: "Komentar wajib diisi." });
    const comment = await prisma.pageComment.create({
      data: {
        ...scope,
        message,
        userId: req.user?.id || null,
        username: req.user?.fullName || req.user?.username || null,
      },
    });
    res.status(201).json(serializeComment(comment));
  } catch (error) {
    next(error);
  }
};

exports.reportClientError = async (req, res, next) => {
  try {
    const scope = requireScope(req, res);
    if (!scope) return;
    const message = clean(req.body?.message, 2000);
    if (!message) return res.status(400).json({ message: "Pesan error wajib diisi." });
    const context = resolvePageContext(req, scope.recordKey);
    const log = await prisma.log.create({
      data: {
        nameRoute: scope.pageCode,
        action: "error",
        method: "CLIENT",
        url: clean(req.body?.url, 1000) || req.originalUrl,
        statusCode: 500,
        userId: req.user?.id || null,
        username: req.user?.username || null,
        ipAddress: req.ip || null,
        userAgent: req.get("user-agent") || null,
        entityId: scope.recordKey,
        changes: req.body?.stack ? { errorDetails: { stack: clean(req.body.stack, 6000) } } : null,
        errorMessage: message,
        moduleCode: context.moduleCode || scope.moduleCode,
        pageCode: context.pageCode || scope.pageCode,
        recordKey: scope.recordKey,
        logType: "ERROR",
      },
    });
    res.status(201).json(serializeLog(log));
  } catch (error) {
    next(error);
  }
};

exports.overview = async (req, res, next) => {
  try {
    const requestedModule = clean(req.query.module);
    const requestedType = clean(req.query.type)?.toUpperCase();
    const q = clean(req.query.q, 200);
    const limit = limitOf(req.query.limit, 100);
    const logWhere = {};
    if (requestedModule) {
      logWhere.OR = [
        { moduleCode: { equals: requestedModule, mode: "insensitive" } },
        { moduleCode: null },
      ];
    }
    if (q) {
      const search = [
        { nameRoute: { contains: q, mode: "insensitive" } },
        { url: { contains: q, mode: "insensitive" } },
        { username: { contains: q, mode: "insensitive" } },
        { errorMessage: { contains: q, mode: "insensitive" } },
        { entityId: { contains: q, mode: "insensitive" } },
      ];
      logWhere.AND = [{ OR: search }];
    }
    if (requestedType === "ERROR" || requestedType === "ALARM") {
      logWhere.AND = [
        ...(logWhere.AND || []),
        { OR: [{ logType: "ERROR" }, { logType: "ALARM" }, { statusCode: { gte: 400 } }, { errorMessage: { not: null } }] },
      ];
    } else if (requestedType === "ACTIVITY" || requestedType === "LOG") {
      logWhere.logType = "ACTIVITY";
      logWhere.statusCode = { lt: 400 };
      logWhere.errorMessage = null;
    }

    const includeComments = !requestedType || requestedType === "COMMENT";
    const includeLogs = requestedType !== "COMMENT";
    const [logs, comments] = await Promise.all([
      includeLogs
        ? prisma.log.findMany({ where: logWhere, orderBy: { createdAt: "desc" }, take: limit * 2 })
        : [],
      includeComments
        ? prisma.pageComment.findMany({
            where: {
              isDeleted: false,
              ...(requestedModule
                ? { moduleCode: { equals: requestedModule, mode: "insensitive" } }
                : {}),
              ...(q
                ? {
                    OR: [
                      { message: { contains: q, mode: "insensitive" } },
                      { username: { contains: q, mode: "insensitive" } },
                      { pageCode: { contains: q, mode: "insensitive" } },
                      { recordKey: { contains: q, mode: "insensitive" } },
                    ],
                  }
                : {}),
            },
            orderBy: { createdAt: "desc" },
            take: limit,
          })
        : [],
    ]);

    const items = [
      ...logs.map(serializeLog).filter(Boolean),
      ...comments.map(serializeComment),
    ]
      .filter((item) => !requestedModule || item.module.toLowerCase() === requestedModule.toLowerCase())
      .filter((item) => {
        if (!requestedType) return true;
        if (requestedType === "COMMENT") return item.type === "COMMENT";
        if (requestedType === "ACTIVITY" || requestedType === "LOG") return item.type === "LOG";
        if (requestedType === "ALARM") return item.type === "ALARM" || item.type === "ERROR";
        return item.type === requestedType;
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit);

    const grouped = items.reduce((result, item) => {
      const key = item.module || "system";
      if (!result[key]) result[key] = { module: key, total: 0, activities: 0, alarms: 0, errors: 0, comments: 0 };
      result[key].total += 1;
      if (item.type === "ERROR") result[key].errors += 1;
      else if (item.type === "ALARM") result[key].alarms += 1;
      else if (item.type === "COMMENT") result[key].comments += 1;
      else result[key].activities += 1;
      return result;
    }, {});

    res.json({ items, groups: Object.values(grouped).sort((a, b) => a.module.localeCompare(b.module)) });
  } catch (error) {
    next(error);
  }
};
