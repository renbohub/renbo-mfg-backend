const { prisma } = require("../index");

const CONTEXT_HEADER = Object.freeze({
  module: "x-page-module",
  page: "x-page-code",
  record: "x-page-record",
});

function clean(value, max = 160) {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized.slice(0, max) : null;
}

function safeLogDetails(payload) {
  if (!payload || typeof payload !== "object") return null;
  const selected = {};
  ["code", "message", "approvalPending", "readiness", "issues", "blockers", "errors", "capacity", "detail"].forEach((key) => {
    if (payload[key] !== undefined && payload[key] !== null) selected[key] = payload[key];
  });
  if (!Object.keys(selected).length) return null;
  try {
    const serialized = JSON.stringify(selected);
    if (serialized.length <= 30000) return JSON.parse(serialized);
    const reduced = { ...selected };
    if (Array.isArray(reduced.issues)) reduced.issues = reduced.issues.slice(0, 40);
    if (Array.isArray(reduced.blockers)) reduced.blockers = reduced.blockers.slice(0, 40);
    if (Array.isArray(reduced.errors)) reduced.errors = reduced.errors.slice(0, 40);
    if (reduced.readiness?.issues) {
      reduced.readiness = { ...reduced.readiness, issues: reduced.readiness.issues.slice(0, 40) };
    }
    return JSON.parse(JSON.stringify(reduced));
  } catch {
    return { message: clean(payload.message, 2000) || "Detail respons tidak dapat diserialisasi" };
  }
}

function classifyAlarm(statusCode, payload = {}) {
  const status = Number(statusCode) || 0;
  if (status < 400) return null;
  const signal = `${payload?.code || ""} ${payload?.message || ""}`.toLowerCase();
  const hasBusinessBlocker = status < 500 && (
    status === 409
    || status === 422
    || /block|belum siap|harus diperbaiki|readiness|routing|uom|capacity|overload|approval/.test(signal)
    || Array.isArray(payload?.readiness?.issues)
    || Array.isArray(payload?.blockers)
  );
  return hasBusinessBlocker ? "ALARM" : "ERROR";
}

function activityEvent(action, method, url, payload = {}, statusCode = 200) {
  if (Number(statusCode) >= 400) return null;
  const signal = `${action || ""} ${url || ""}`.toLowerCase();
  const message = `${payload?.message || ""} ${payload?.status || ""}`.toLowerCase();
  if (payload?.approvalPending || /need[_ -]?approval|menunggu.*approval|pending.*approval|in approval/.test(`${signal} ${message}`)) return "NEED_APPROVAL";
  if (/reject|rejected/.test(`${signal} ${message}`)) return "REJECTED";
  if (/approve|approved|confirm|confirmed/.test(`${signal} ${message}`)) return "APPROVED";
  if (/submit|submitted/.test(`${signal} ${message}`)) return "SUBMIT";
  if (String(method).toUpperCase() === "DELETE" || /delete|bulk-remove/.test(signal)) return "DELETE";
  if (/create|add|from-forecast/.test(signal)) return "CREATE";
  if (/update|adjust|edit|revise/.test(signal) || ["PATCH", "PUT"].includes(String(method).toUpperCase())) return "UPDATE";
  if (String(action || "").toUpperCase() === "REQUEST" && String(method).toUpperCase() === "POST" && !/release|start|complete|close|convert|generate/.test(signal)) return "CREATE";
  return null;
}

function inferFromApiPath(value = "") {
  const parts = String(value).split("?")[0].split("/").filter(Boolean);
  const apiIndex = parts.indexOf("api");
  const path = apiIndex >= 0 ? parts.slice(apiIndex + 1) : parts;
  const first = path[0] || "system";
  const aliases = {
    planning: "planning-ppic",
    mbom: "manufacturing-bom",
    engineering: "manufacturing-bom",
    dashboard: "planning-ppic",
    approvals: "system",
    users: "system",
    logs: "system",
    notifications: "system",
  };
  const moduleCode = aliases[first] || first;
  let pageCode = path[1] || first;
  if (first === "master-data") pageCode = path[1] || "index";
  if (first === "mbom") pageCode = path[1] === "mbom" ? "bill-of-materials" : path[1];
  if (first === "planning") {
    const pageAliases = {
      mps: "master-production-schedule",
      mrp: "material-requirements-planning",
      "monthly-production-plans": "monthly-production-plans",
      forecasts: "consume-forecast",
    };
    pageCode = pageAliases[path[1]] || path[1] || "planning";
  }
  return { moduleCode: clean(moduleCode), pageCode: clean(pageCode) };
}

function resolvePageContext(req, entityId = null) {
  const inferred = inferFromApiPath(req.originalUrl || req.url);
  return {
    moduleCode: clean(req.get?.(CONTEXT_HEADER.module)) || inferred.moduleCode,
    pageCode: clean(req.get?.(CONTEXT_HEADER.page)) || inferred.pageCode,
    recordKey: clean(req.get?.(CONTEXT_HEADER.record)) || clean(entityId),
  };
}

function inferModuleFromLog(log = {}) {
  if (log.moduleCode) return log.moduleCode;
  return inferFromApiPath(log.url || log.nameRoute || "").moduleCode || "system";
}

function inferPageFromLog(log = {}) {
  if (log.pageCode) return log.pageCode;
  return inferFromApiPath(log.url || log.nameRoute || "").pageCode || log.nameRoute || "general";
}

function recordError(req, error, statusCode = 500, options = {}) {
  const context = resolvePageContext(req, options.recordKey);
  const message = clean(error?.message || options.message || "Unhandled error", 2000);
  setImmediate(async () => {
    try {
      await prisma.log.create({
        data: {
          nameRoute: options.nameRoute || context.pageCode || "system",
          action: "error",
          method: req.method || "UNKNOWN",
          url: req.originalUrl || req.url || "/",
          statusCode: Number(statusCode) || 500,
          responseTime: options.responseTime ?? null,
          userId: req.user?.id || null,
          username: req.user?.username || null,
          ipAddress: req.ip || null,
          userAgent: req.get?.("user-agent") || null,
          entityId: context.recordKey,
          requestParams: Object.keys(req.params || {}).length ? req.params : null,
          changes: error?.stack ? { errorDetails: { stack: clean(error.stack, 6000) } } : null,
          errorMessage: message,
          moduleCode: context.moduleCode,
          pageCode: context.pageCode,
          recordKey: context.recordKey,
          logType: "ERROR",
        },
      });
    } catch (logError) {
      console.error("Context error logger failed:", logError.message);
    }
  });
}

function attachContextAudit(req, res) {
  if (req.contextAuditAttached) return;
  const explicitModule = clean(req.get?.(CONTEXT_HEADER.module));
  const explicitPage = clean(req.get?.(CONTEXT_HEADER.page));
  if (!explicitModule || !explicitPage || String(req.originalUrl || "").includes("/api/page-context")) return;
  req.contextAuditAttached = true;
  const startedAt = Date.now();
  const originalJson = res.json.bind(res);
  res.json = function captureContextResponse(payload) {
    req.contextResponseBody = payload;
    return originalJson(payload);
  };
  res.once("finish", () => {
    if (req.activityLoggerAttached || req.contextErrorRecorded) return;
    const context = resolvePageContext(req);
    setImmediate(async () => {
      try {
        const payload = req.contextResponseBody || {};
        const alarmType = classifyAlarm(res.statusCode, payload);
        const event = activityEvent("request", req.method, req.originalUrl || req.url, payload, res.statusCode);
        if (!alarmType && !event) return;
        const details = safeLogDetails(payload);
        await prisma.log.create({
          data: {
            nameRoute: context.pageCode || "page",
            action: alarmType ? (alarmType === "ALARM" ? "BLOCKER" : "ERROR") : event,
            method: req.method,
            url: req.originalUrl || req.url,
            statusCode: res.statusCode,
            responseTime: Date.now() - startedAt,
            userId: req.user?.id || null,
            username: req.user?.username || null,
            ipAddress: req.ip || null,
            userAgent: req.get?.("user-agent") || null,
            entityId: context.recordKey,
            requestParams: Object.keys(req.params || {}).length ? req.params : null,
            changes: details ? { [alarmType ? "errorDetails" : "workflowDetails"]: details } : null,
            errorMessage: alarmType ? clean(payload?.message, 2000) || `Request failed with status ${res.statusCode}` : null,
            moduleCode: context.moduleCode,
            pageCode: context.pageCode,
            recordKey: context.recordKey,
            logType: alarmType || "ACTIVITY",
          },
        });
      } catch (error) {
        console.error("Context activity logger failed:", error.message);
      }
    });
  });
}

module.exports = {
  CONTEXT_HEADER,
  clean,
  inferFromApiPath,
  inferModuleFromLog,
  inferPageFromLog,
  resolvePageContext,
  recordError,
  attachContextAudit,
  activityEvent,
  classifyAlarm,
  safeLogDetails,
};
