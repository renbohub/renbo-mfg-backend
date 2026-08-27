const { prisma } = require("../../index");
const { resolveApprovalRule } = require("../../services/approvalRuleService");

const INCLUDE = {
  steps: {
    where: { isDeleted: false },
    orderBy: { stepOrder: "asc" },
    include: { role: { select: { id: true, roleCode: true, roleName: true, isActive: true } } },
  },
  _count: { select: { requests: true } },
};

const DOCUMENT_STATUS_LIFECYCLES = {
  "purchasing/purchase-requisitions": ["Draft", "Submitted", "Approved", "Rejected", "Partially Ordered", "Completed"],
  "purchasing/purchase-order": ["Draft", "Submitted", "Approved", "Rejected", "Sent", "Confirmed", "Partial Receipt", "Completed", "Cancelled"],
  "purchasing/purchase-invoices": ["Draft", "Submitted", "Matched", "Need Review", "Approved", "Posted", "Paid", "Cancelled"],
  "sales/forecasts": ["Draft", "Submitted", "Confirmed", "Rejected", "Partial Product", "Consumed", "Closed", "Obsolete"],
  "production/production-logs": ["Open", "Submitted", "Approved", "Rejected"],
  "inventory/stock-opname": ["DRAFT", "COUNTING", "WAITING_CHECK", "WAITING_APPROVAL", "APPROVED", "ADJUSTED", "CLOSED", "CANCELLED", "REJECTED"],
};

function actor(req) {
  return req.user?.username || req.user?.email || "system";
}

function code(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function nullableNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function positiveInt(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(Math.trunc(parsed), 1) : fallback;
}

function normalizeConditions(value) {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      const error = new Error("Conditions harus berupa JSON yang valid.");
      error.statusCode = 400;
      throw error;
    }
  }
  return typeof value === "object" ? value : null;
}

function normalizeRule(body, req, current = {}) {
  const ruleCode = body.ruleCode === undefined ? current.ruleCode : code(body.ruleCode);
  const ruleName = body.ruleName === undefined ? current.ruleName : String(body.ruleName || "").trim();
  const moduleCode = String(body.moduleCode ?? current.moduleCode ?? "").trim().toLowerCase();
  const pageCode = String(body.pageCode ?? current.pageCode ?? "").trim().toLowerCase();
  const actionCode = String(body.actionCode ?? current.actionCode ?? "approve").trim().toLowerCase();
  if (!ruleCode || !ruleName || !moduleCode || !pageCode || !actionCode) {
    const error = new Error("Kode, nama, module, halaman, dan action approval wajib diisi.");
    error.statusCode = 400;
    throw error;
  }
  const minAmount = body.minAmount === undefined ? current.minAmount ?? null : nullableNumber(body.minAmount);
  const maxAmount = body.maxAmount === undefined ? current.maxAmount ?? null : nullableNumber(body.maxAmount);
  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
    const error = new Error("Minimum amount tidak boleh melebihi maximum amount.");
    error.statusCode = 400;
    throw error;
  }
  return {
    ruleCode,
    ruleName,
    moduleCode,
    pageCode,
    actionCode,
    documentType: body.documentType === undefined ? current.documentType ?? null : body.documentType || null,
    description: body.description === undefined ? current.description ?? null : body.description || null,
    priority: positiveInt(body.priority ?? current.priority, 100),
    minAmount,
    maxAmount,
    currencyCode: body.currencyCode === undefined ? current.currencyCode ?? null : body.currencyCode || null,
    conditions: body.conditions === undefined ? current.conditions ?? null : normalizeConditions(body.conditions),
    requireSequential: body.requireSequential === undefined ? current.requireSequential !== false : body.requireSequential !== false,
    allowSelfApproval: body.allowSelfApproval === undefined ? current.allowSelfApproval === true : body.allowSelfApproval === true,
    effectiveFrom: body.effectiveFrom === undefined ? current.effectiveFrom ?? null : nullableDate(body.effectiveFrom),
    effectiveUntil: body.effectiveUntil === undefined ? current.effectiveUntil ?? null : nullableDate(body.effectiveUntil),
    isActive: body.isActive === undefined ? current.isActive !== false : body.isActive !== false,
    updatedBy: actor(req),
  };
}

function normalizeSteps(value, isActive, rule = {}) {
  const lifecycle = DOCUMENT_STATUS_LIFECYCLES[`${rule.moduleCode || ""}/${rule.pageCode || ""}`] || null;
  const normalizeDocumentStatus = (value, field, index) => {
    const status = value == null || value === "" ? null : String(value).trim();
    if (status && lifecycle && !lifecycle.includes(status)) {
      const error = new Error(`Step ${index + 1}: ${field} \"${status}\" tidak ada pada lifecycle aktual ${rule.moduleCode}/${rule.pageCode}. Pilihan valid: ${lifecycle.join(", ")}.`);
      error.statusCode = 400;
      throw error;
    }
    return status;
  };
  const steps = (Array.isArray(value) ? value : [])
    .filter((step) => step && step.isDeleted !== true)
    .map((step, index) => ({
      stepOrder: index + 1,
      stepName: String(step.stepName || `Approval Level ${index + 1}`).trim(),
      approverRoleId: step.approverRoleId || null,
      permissionAction: String(step.permissionAction || "approve").trim().toLowerCase(),
      requiredApprovals: positiveInt(step.requiredApprovals, 1),
      pendingStatus: normalizeDocumentStatus(step.pendingStatus, "status saat menunggu", index),
      approvedStatus: normalizeDocumentStatus(step.approvedStatus, "status setelah disetujui", index),
      rejectedStatus: normalizeDocumentStatus(step.rejectedStatus, "status jika ditolak", index),
      slaHours: step.slaHours === "" || step.slaHours === null || step.slaHours === undefined ? null : positiveInt(step.slaHours, 1),
      canDelegate: step.canDelegate === true,
      isActive: step.isActive !== false,
      isDeleted: false,
    }));
  if (isActive && steps.length === 0) {
    const error = new Error("Approval rule aktif wajib mempunyai minimal satu step.");
    error.statusCode = 400;
    throw error;
  }
  return steps;
}

exports.list = async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    const where = {
      isDeleted: String(req.query.isDeleted || "false") === "true",
      ...(req.query.moduleCode ? { moduleCode: String(req.query.moduleCode).toLowerCase() } : {}),
      ...(req.query.pageCode ? { pageCode: String(req.query.pageCode).toLowerCase() } : {}),
      ...(q ? {
        OR: [
          { ruleCode: { contains: q, mode: "insensitive" } },
          { ruleName: { contains: q, mode: "insensitive" } },
          { description: { contains: q, mode: "insensitive" } },
        ],
      } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.approvalRule.findMany({ where, include: INCLUDE, orderBy: [{ moduleCode: "asc" }, { pageCode: "asc" }, { priority: "asc" }] }),
      prisma.approvalRule.count({ where }),
    ]);
    res.json({ items, total });
  } catch (error) {
    next(error);
  }
};

exports.get = async (req, res, next) => {
  try {
    const rule = await prisma.approvalRule.findFirst({
      where: { isDeleted: false, OR: [{ id: req.params.id }, { ruleCode: code(req.params.id) }] },
      include: INCLUDE,
    });
    if (!rule) return res.status(404).json({ message: "Approval rule tidak ditemukan." });
    res.json(rule);
  } catch (error) {
    next(error);
  }
};

exports.roles = async (_req, res, next) => {
  try {
    const items = await prisma.role.findMany({
      where: { isDeleted: false, isActive: true },
      orderBy: { roleName: "asc" },
      select: { id: true, roleCode: true, roleName: true, description: true },
    });
    res.json({ items, total: items.length });
  } catch (error) {
    next(error);
  }
};

exports.resolve = async (req, res, next) => {
  try {
    const rule = await resolveApprovalRule({
      moduleCode: req.query.moduleCode,
      pageCode: req.query.pageCode,
      actionCode: req.query.actionCode,
      documentType: req.query.documentType,
      amount: req.query.amount,
      currencyCode: req.query.currencyCode,
      context: req.body?.context || req.query,
    });
    res.json({ matched: Boolean(rule), rule });
  } catch (error) {
    next(error);
  }
};

exports.simulate = async (req, res, next) => {
  try {
    const input = { ...req.query, ...(req.body || {}) };
    const rule = await resolveApprovalRule({
      moduleCode: input.moduleCode,
      pageCode: input.pageCode,
      actionCode: input.actionCode,
      documentType: input.documentType,
      amount: input.amount,
      currencyCode: input.currencyCode,
      context: input.context || input,
    });
    res.json({
      matched: Boolean(rule),
      rule: rule ? { id: rule.id, ruleCode: rule.ruleCode, ruleName: rule.ruleName, requireSequential: rule.requireSequential } : null,
      steps: (rule?.steps || []).map((step) => ({ stepOrder: step.stepOrder, stepName: step.stepName, role: step.role?.roleName || step.role?.roleCode || null, requiredApprovals: step.requiredApprovals, slaHours: step.slaHours, canDelegate: step.canDelegate })),
    });
  } catch (error) { next(error); }
};

exports.dashboard = async (_req, res, next) => {
  try {
    const [pending, overdue, rejected, revisionRequired, approvedToday] = await Promise.all([
      prisma.approvalRequest.count({ where: { isDeleted: false, status: { in: ["Pending", "In Approval"] } } }),
      prisma.approvalRequest.count({ where: { isDeleted: false, status: { in: ["Pending", "In Approval"] }, requestedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }),
      prisma.approvalRequest.count({ where: { isDeleted: false, status: "Rejected" } }),
      prisma.approvalRequest.count({ where: { isDeleted: false, status: "Revision Required" } }),
      prisma.approvalRequest.count({ where: { isDeleted: false, status: "Approved", completedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } }),
    ]);
    res.json({ pending, overdue, rejected, revisionRequired, approvedToday });
  } catch (error) { next(error); }
};

exports.create = async (req, res, next) => {
  try {
    const data = normalizeRule(req.body, req);
    const steps = normalizeSteps(req.body.steps, data.isActive, data);
    data.createdBy = actor(req);
    const rule = await prisma.approvalRule.create({
      data: { ...data, steps: { create: steps } },
      include: INCLUDE,
    });
    res.status(201).json(rule);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

exports.update = async (req, res, next) => {
  try {
    const existing = await prisma.approvalRule.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.isDeleted) return res.status(404).json({ message: "Approval rule tidak ditemukan." });
    const data = normalizeRule(req.body, req, existing);
    const steps = req.body.steps === undefined ? null : normalizeSteps(req.body.steps, data.isActive, data);
    const rule = await prisma.$transaction(async (tx) => {
      await tx.approvalRule.update({ where: { id: existing.id }, data });
      if (steps) {
        const activeRequestCount = await tx.approvalRequest.count({
          where: { approvalRuleId: existing.id, isDeleted: false, status: { in: ["Pending", "In Approval"] } },
        });
        if (activeRequestCount > 0) {
          const error = new Error("Step tidak dapat diubah karena masih ada approval request aktif. Nonaktifkan atau selesaikan request terlebih dahulu.");
          error.statusCode = 409;
          throw error;
        }
        await tx.approvalRuleStep.deleteMany({ where: { approvalRuleId: existing.id } });
        if (steps.length) await tx.approvalRuleStep.createMany({ data: steps.map((step) => ({ ...step, approvalRuleId: existing.id })) });
      }
      return tx.approvalRule.findUnique({ where: { id: existing.id }, include: INCLUDE });
    });
    res.json(rule);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const activeRequestCount = await prisma.approvalRequest.count({
      where: { approvalRuleId: req.params.id, isDeleted: false, status: { in: ["Pending", "In Approval"] } },
    });
    if (activeRequestCount) return res.status(409).json({ message: "Rule masih dipakai approval request aktif." });
    const result = await prisma.approvalRule.updateMany({
      where: { id: req.params.id, isDeleted: false },
      data: { isDeleted: true, isActive: false, updatedBy: actor(req) },
    });
    if (!result.count) return res.status(404).json({ message: "Approval rule tidak ditemukan." });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
};
