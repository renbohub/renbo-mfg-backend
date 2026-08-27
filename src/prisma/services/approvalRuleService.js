const crypto = require("crypto");
const { prisma } = require("../index");

const ACTIVE_REQUEST_STATUSES = ["Pending", "In Approval"];

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function numberOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function canResumeCompletedApproval({ document, request, decision = "Approved", documentStatuses = [] } = {}) {
  if (!document || !request || !Array.isArray(documentStatuses) || !documentStatuses.length) return false;
  const expectedDecision = ["rejected", "reject"].includes(normalize(decision)) ? "Rejected" : "Approved";
  if (normalize(request.status) !== normalize(expectedDecision)) return false;
  if (!documentStatuses.map(normalize).includes(normalize(document.status))) return false;

  const completedAt = new Date(request.completedAt || 0).getTime();
  if (!Number.isFinite(completedAt) || completedAt <= 0) return false;
  const documentUpdatedAt = new Date(document.updatedAt || 0).getTime();
  // A document edited after the approval is a new version and must be
  // submitted again. Only resume the exact version whose posting failed.
  return !Number.isFinite(documentUpdatedAt) || documentUpdatedAt <= 0 || completedAt >= documentUpdatedAt;
}

function getPath(object, path) {
  return String(path || "").split(".").reduce((value, key) => value == null ? undefined : value[key], object);
}

function compareCondition(actual, expected) {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (Object.prototype.hasOwnProperty.call(expected, "$eq") && actual !== expected.$eq) return false;
    if (Object.prototype.hasOwnProperty.call(expected, "$ne") && actual === expected.$ne) return false;
    if (Array.isArray(expected.$in) && !expected.$in.includes(actual)) return false;
    if (Array.isArray(expected.$notIn) && expected.$notIn.includes(actual)) return false;
    if (Object.prototype.hasOwnProperty.call(expected, "$gte") && !(Number(actual) >= Number(expected.$gte))) return false;
    if (Object.prototype.hasOwnProperty.call(expected, "$gt") && !(Number(actual) > Number(expected.$gt))) return false;
    if (Object.prototype.hasOwnProperty.call(expected, "$lte") && !(Number(actual) <= Number(expected.$lte))) return false;
    if (Object.prototype.hasOwnProperty.call(expected, "$lt") && !(Number(actual) < Number(expected.$lt))) return false;
    if (Object.prototype.hasOwnProperty.call(expected, "$contains")) {
      if (Array.isArray(actual)) return actual.includes(expected.$contains);
      return String(actual ?? "").toLowerCase().includes(String(expected.$contains).toLowerCase());
    }
    return true;
  }
  if (Array.isArray(expected)) return expected.includes(actual);
  return String(actual ?? "").toLowerCase() === String(expected ?? "").toLowerCase();
}

function matchesConditions(context, conditions) {
  if (!conditions || typeof conditions !== "object" || Array.isArray(conditions)) return true;
  return Object.entries(conditions).every(([path, expected]) => compareCondition(getPath(context, path), expected));
}

function specificity(rule, moduleCode, pageCode, actionCode) {
  return Number(rule.moduleCode === moduleCode) + Number(rule.pageCode === pageCode) + Number(rule.actionCode === actionCode);
}

async function resolveApprovalRule({ moduleCode, pageCode, actionCode = "approve", documentType, amount, currencyCode, context = {}, tx = prisma } = {}) {
  const moduleKey = normalize(moduleCode);
  const pageKey = normalize(pageCode);
  const actionKey = normalize(actionCode || "approve");
  if (!moduleKey || !pageKey || !actionKey) return null;
  const now = new Date();
  const candidates = await tx.approvalRule.findMany({
    where: {
      isDeleted: false,
      isActive: true,
      moduleCode: { in: [moduleKey, "*"] },
      pageCode: { in: [pageKey, "*"] },
      actionCode: { in: [actionKey, "*"] },
      AND: [
        { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }] },
        { OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: now } }] },
      ],
    },
    include: {
      steps: {
        where: { isDeleted: false, isActive: true },
        orderBy: { stepOrder: "asc" },
        include: { role: { select: { id: true, roleCode: true, roleName: true, isActive: true, isDeleted: true } } },
      },
    },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  const numericAmount = numberOrNull(amount);
  const documentKey = normalize(documentType);
  const currencyKey = normalize(currencyCode);
  const matched = candidates.filter((rule) => {
    if (!rule.steps.length) return false;
    if (rule.documentType && normalize(rule.documentType) !== documentKey) return false;
    if (rule.currencyCode && normalize(rule.currencyCode) !== currencyKey) return false;
    if (rule.minAmount !== null && (numericAmount === null || numericAmount < Number(rule.minAmount))) return false;
    if (rule.maxAmount !== null && (numericAmount === null || numericAmount > Number(rule.maxAmount))) return false;
    return matchesConditions(context, rule.conditions);
  });
  matched.sort((a, b) => a.priority - b.priority || specificity(b, moduleKey, pageKey, actionKey) - specificity(a, moduleKey, pageKey, actionKey));
  return matched[0] || null;
}

function requestNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `APR-${date}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

const REQUEST_INCLUDE = {
  rule: {
    include: {
      steps: {
        where: { isDeleted: false, isActive: true },
        orderBy: { stepOrder: "asc" },
        include: { role: { select: { id: true, roleCode: true, roleName: true, isActive: true, isDeleted: true } } },
      },
    },
  },
  actions: { orderBy: { actedAt: "asc" } },
};

async function createApprovalRequest({ rule, moduleCode, pageCode, actionCode = "approve", documentType, documentId, documentNumber, amount, currencyCode, context, requestedByUserId, requestedBy, tx = prisma }) {
  if (!rule?.id) throw Object.assign(new Error("Approval rule aktif tidak ditemukan."), { statusCode: 404 });
  if (!documentId) throw Object.assign(new Error("Document ID wajib diisi."), { statusCode: 400 });
  const key = {
    moduleCode: normalize(moduleCode),
    pageCode: normalize(pageCode),
    actionCode: normalize(actionCode || "approve"),
    documentId: String(documentId),
  };
  const existing = await tx.approvalRequest.findFirst({
    where: { ...key, isDeleted: false, status: { in: ACTIVE_REQUEST_STATUSES } },
    include: REQUEST_INCLUDE,
  });
  if (existing) return existing;
  return tx.approvalRequest.create({
    data: {
      requestNumber: requestNumber(),
      approvalRuleId: rule.id,
      ...key,
      documentType: documentType || null,
      documentNumber: documentNumber || String(documentId),
      amount: numberOrNull(amount),
      currencyCode: currencyCode || null,
      currentStep: rule.steps[0]?.stepOrder || 1,
      status: "Pending",
      context: context && typeof context === "object" ? context : undefined,
      requestedByUserId: requestedByUserId || null,
      requestedBy: requestedBy || null,
    },
    include: REQUEST_INCLUDE,
  });
}

async function submitDocumentForApproval({ moduleCode, pageCode, actionCode = "approve", documentType, documentId, documentNumber, amount, currencyCode, context = {}, requestedByUserId, requestedBy, tx = prisma }) {
  const rule = await resolveApprovalRule({
    moduleCode,
    pageCode,
    actionCode,
    documentType,
    amount,
    currencyCode,
    context,
    tx,
  });
  if (!rule) {
    throw Object.assign(
      new Error(`Submit diblokir: approval rule aktif untuk ${moduleCode}/${pageCode} belum dikonfigurasi.`),
      { statusCode: 409 },
    );
  }
  return createApprovalRequest({
    rule,
    moduleCode,
    pageCode,
    actionCode,
    documentType,
    documentId,
    documentNumber,
    amount,
    currencyCode,
    context,
    requestedByUserId,
    requestedBy,
    tx,
  });
}

async function userRoleIds(userId, tx = prisma) {
  if (!userId) return [];
  const rows = await tx.userRole.findMany({
    where: { userId, isActive: true, role: { isDeleted: false, isActive: true } },
    select: { roleId: true },
  });
  return rows.map((row) => row.roleId);
}

async function hasPageAction(user, moduleCode, pageCode, action, tx = prisma) {
  if (user?.isSuperAdmin) return true;
  const roleIds = await userRoleIds(user?.id, tx);
  if (roleIds.length) {
    const permissions = await tx.rolePermission.findMany({
      where: {
        roleId: { in: roleIds },
        isDeleted: false,
        isActive: true,
        moduleCode: { in: [normalize(moduleCode), "*"] },
        pageCode: { in: [normalize(pageCode), "*"] },
      },
      select: { actions: true },
    });
    return permissions.some((permission) => {
      const actions = Array.isArray(permission.actions) ? permission.actions.map(normalize) : [];
      return actions.includes("*") || actions.includes(normalize(action));
    });
  }
  const legacy = Array.isArray(user?.listMenu) ? user.listMenu : [];
  return legacy.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const resource = normalize(entry.resource);
    if (![normalize(pageCode), normalize(moduleCode)].includes(resource)) return false;
    const actions = Array.isArray(entry.actions) ? entry.actions.map(normalize) : [];
    return actions.includes("*") || actions.includes(normalize(action));
  });
}

async function canApproveStep(user, request, step, tx = prisma) {
  if (user?.isSuperAdmin) return true;
  if (step.approverRoleId) {
    const roleIds = await userRoleIds(user?.id, tx);
    return roleIds.includes(step.approverRoleId);
  }
  return hasPageAction(user, request.moduleCode, request.pageCode, step.permissionAction || "approve", tx);
}

function approvalCounts(actions) {
  const counts = new Map();
  for (const action of actions || []) {
    if (action.action !== "Approved") continue;
    if (!counts.has(action.stepOrder)) counts.set(action.stepOrder, new Set());
    counts.get(action.stepOrder).add(action.actedByUserId || action.actedBy || action.id);
  }
  return counts;
}

function incompleteSteps(request) {
  const counts = approvalCounts(request.actions);
  return request.rule.steps.filter((step) => (counts.get(step.stepOrder)?.size || 0) < step.requiredApprovals);
}

async function applyIntermediateDocumentStatus(request, status, tx = prisma) {
  if (!status || !request?.documentId) return;
  const modelByType = {
    purchaserequisition: "purchaseRequisition",
    purchaseorder: "purchaseOrder",
    purchaseinvoice: "purchaseInvoice",
    forecast: "forecast",
    productionlog: "productionLog",
    stockopnameheader: "stockOpnameHeader",
  };
  const model = modelByType[normalize(request.documentType)];
  if (!model || typeof tx[model]?.updateMany !== "function") return;
  await tx[model].updateMany({ where: { id: request.documentId, isDeleted: false }, data: { status } });
}

async function processApprovalAction({ requestId, requestNumber: number, user, decision = "Approved", notes, metadata, deferFinalDocumentStatus = false, tx = prisma }) {
  const request = await tx.approvalRequest.findFirst({
    where: {
      isDeleted: false,
      ...(requestId ? { id: requestId } : { requestNumber: number }),
    },
    include: REQUEST_INCLUDE,
  });
  if (!request) throw Object.assign(new Error("Approval request tidak ditemukan."), { statusCode: 404 });
  if (!ACTIVE_REQUEST_STATUSES.includes(request.status)) {
    throw Object.assign(new Error(`Approval request sudah berstatus ${request.status}.`), { statusCode: 409 });
  }
  if (!request.rule.allowSelfApproval) {
    const sameUserId = request.requestedByUserId && request.requestedByUserId === user?.id;
    const sameUsername = request.requestedBy && normalize(request.requestedBy) === normalize(user?.username || user?.email);
    if (sameUserId || sameUsername) throw Object.assign(new Error("Self approval tidak diizinkan oleh rule."), { statusCode: 403 });
  }

  const openSteps = incompleteSteps(request);
  const eligibleSteps = request.rule.requireSequential
    ? openSteps.filter((step) => step.stepOrder === Math.min(...openSteps.map((item) => item.stepOrder)))
    : openSteps;
  let step = null;
  for (const candidate of eligibleSteps) {
    if (await canApproveStep(user, request, candidate, tx)) {
      step = candidate;
      break;
    }
  }
  if (!step) throw Object.assign(new Error("User tidak termasuk approver pada step aktif."), { statusCode: 403 });

  const normalizedDecision = normalize(decision) === "rejected" || normalize(decision) === "reject" ? "Rejected" : "Approved";
  const duplicate = request.actions.some((action) => action.stepOrder === step.stepOrder && action.action === normalizedDecision && action.actedByUserId === user?.id);
  if (duplicate) throw Object.assign(new Error("User sudah memberikan keputusan pada step ini."), { statusCode: 409 });

  await tx.approvalAction.create({
    data: {
      requestId: request.id,
      ruleStepId: step.id,
      stepOrder: step.stepOrder,
      action: normalizedDecision,
      actedByUserId: user?.id || null,
      actedBy: user?.username || user?.email || "system",
      notes: notes || null,
      metadata: metadata && typeof metadata === "object" ? metadata : undefined,
    },
  });

  if (normalizedDecision === "Rejected") {
    if (!deferFinalDocumentStatus) await applyIntermediateDocumentStatus(request, step.rejectedStatus || "Rejected", tx);
    const updated = await tx.approvalRequest.update({
      where: { id: request.id },
      data: { status: "Rejected", completedAt: new Date(), currentStep: step.stepOrder },
      include: REQUEST_INCLUDE,
    });
    return { request: updated, step, final: true, decision: normalizedDecision, shouldContinue: true };
  }

  const refreshed = await tx.approvalRequest.findUnique({ where: { id: request.id }, include: REQUEST_INCLUDE });
  const remaining = incompleteSteps(refreshed);
  const final = remaining.length === 0;
  const nextStep = final ? step.stepOrder : Math.min(...remaining.map((item) => item.stepOrder));
  const updated = await tx.approvalRequest.update({
    where: { id: request.id },
    data: { status: final ? "Approved" : "In Approval", currentStep: nextStep, completedAt: final ? new Date() : null },
    include: REQUEST_INCLUDE,
  });
  if (!final) {
    const activeStep = refreshed.rule.steps.find((item) => item.stepOrder === nextStep);
    await applyIntermediateDocumentStatus(request, activeStep?.pendingStatus || step.approvedStatus, tx);
  } else if (!deferFinalDocumentStatus) {
    await applyIntermediateDocumentStatus(request, step.approvedStatus || "Approved", tx);
  }
  return { request: updated, step, final, decision: normalizedDecision, shouldContinue: final };
}

function approvalGate(config) {
  return async (req, res, next) => {
    try {
      const parameter = config.param || "id";
      const identifier = req.params[parameter];
      let document = null;
      if (config.model && prisma[config.model]) {
        const lookupField = config.lookupField || parameter;
        document = await prisma[config.model].findUnique({ where: { [lookupField]: identifier } });
      }
      const context = { ...(document || {}), ...(req.body?.approvalContext || {}) };
      const documentId = document?.[config.idField || "id"] || identifier;
      const documentNumber = document?.[config.numberField || config.lookupField || parameter] || identifier;
      const amount = document?.[config.amountField || "totalAmount"] ?? req.body?.amount;
      const currencyCode = document?.[config.currencyField || "currencyCode"] ?? req.body?.currencyCode;
      const requestKey = {
        moduleCode: normalize(config.moduleCode),
        pageCode: normalize(config.pageCode),
        actionCode: normalize(config.actionCode || "approve"),
        documentId: String(documentId),
      };
      let request = await prisma.approvalRequest.findFirst({
        where: { ...requestKey, isDeleted: false, status: { in: ACTIVE_REQUEST_STATUSES } },
        include: REQUEST_INCLUDE,
      });
      if (!request) {
        if (config.allowCompletedRequestRetry) {
          const completedStatus = ["rejected", "reject"].includes(normalize(config.decision)) ? "Rejected" : "Approved";
          const completedRequest = await prisma.approvalRequest.findFirst({
            where: { ...requestKey, isDeleted: false, status: completedStatus },
            include: REQUEST_INCLUDE,
            orderBy: { completedAt: "desc" },
          });
          if (canResumeCompletedApproval({
            document,
            request: completedRequest,
            decision: completedStatus,
            documentStatuses: config.completedRetryDocumentStatuses,
          })) {
            req.approval = {
              request: completedRequest,
              final: true,
              decision: completedStatus,
              shouldContinue: true,
              resumedCompletedRequest: true,
            };
            return next();
          }
        }
        if (config.requireExistingRequest) {
          return res.status(409).json({ message: "Dokumen belum disubmit ke alur approval atau approval request aktif tidak ditemukan." });
        }
        const rule = await resolveApprovalRule({
          moduleCode: config.moduleCode,
          pageCode: config.pageCode,
          actionCode: config.actionCode || "approve",
          documentType: config.documentType,
          amount,
          currencyCode,
          context,
        });
        if (!rule) return next();
        request = await createApprovalRequest({
          rule,
          moduleCode: config.moduleCode,
          pageCode: config.pageCode,
          actionCode: config.actionCode || "approve",
          documentType: config.documentType,
          documentId,
          documentNumber,
          amount,
          currencyCode,
          context,
          requestedBy: document?.createdBy || document?.requestedBy || null,
        });
      }
      const result = await prisma.$transaction((tx) => processApprovalAction({
        requestId: request.id,
        user: req.user,
        decision: config.decision || "Approved",
        notes: req.body?.approvalNotes || req.body?.notes,
        metadata: req.body?.approvalMetadata,
        deferFinalDocumentStatus: true,
        tx,
      }));
      req.approval = result;
      if (result.shouldContinue) return next();
      return res.status(202).json({
        message: `Approval level ${result.step.stepOrder} selesai. Menunggu step berikutnya.`,
        approvalPending: true,
        data: result.request,
      });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
      next(error);
    }
  };
}

module.exports = {
  ACTIVE_REQUEST_STATUSES,
  REQUEST_INCLUDE,
  resolveApprovalRule,
  createApprovalRequest,
  submitDocumentForApproval,
  processApprovalAction,
  hasPageAction,
  approvalGate,
  canResumeCompletedApproval,
  matchesConditions,
};
