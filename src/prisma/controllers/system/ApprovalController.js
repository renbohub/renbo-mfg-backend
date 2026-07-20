const { prisma } = require("../../index");
const {
  ACTIVE_REQUEST_STATUSES,
  REQUEST_INCLUDE,
  resolveApprovalRule,
  createApprovalRequest,
  processApprovalAction,
} = require("../../services/approvalRuleService");

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 200);
    const q = String(req.query.q || "").trim();
    const where = {
      isDeleted: false,
      ...(req.query.status ? { status: String(req.query.status) } : {}),
      ...(req.query.moduleCode ? { moduleCode: String(req.query.moduleCode).toLowerCase() } : {}),
      ...(req.query.pageCode ? { pageCode: String(req.query.pageCode).toLowerCase() } : {}),
      ...(q ? {
        OR: [
          { requestNumber: { contains: q, mode: "insensitive" } },
          { documentNumber: { contains: q, mode: "insensitive" } },
          { requestedBy: { contains: q, mode: "insensitive" } },
        ],
      } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.approvalRequest.findMany({
        where,
        include: REQUEST_INCLUDE,
        orderBy: { requestedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.approvalRequest.count({ where }),
    ]);
    res.json({ items, total, page, limit });
  } catch (error) {
    next(error);
  }
};

exports.get = async (req, res, next) => {
  try {
    const request = await prisma.approvalRequest.findFirst({
      where: { isDeleted: false, OR: [{ id: req.params.id }, { requestNumber: req.params.id }] },
      include: REQUEST_INCLUDE,
    });
    if (!request) return res.status(404).json({ message: "Approval request tidak ditemukan." });
    res.json(request);
  } catch (error) {
    next(error);
  }
};

exports.byDocument = async (req, res, next) => {
  try {
    const items = await prisma.approvalRequest.findMany({
      where: {
        moduleCode: String(req.params.moduleCode).toLowerCase(),
        pageCode: String(req.params.pageCode).toLowerCase(),
        documentId: req.params.documentId,
        isDeleted: false,
      },
      include: REQUEST_INCLUDE,
      orderBy: { requestedAt: "desc" },
    });
    res.json({ items, total: items.length });
  } catch (error) {
    next(error);
  }
};

exports.submit = async (req, res, next) => {
  try {
    const input = req.body || {};
    const rule = await resolveApprovalRule({
      moduleCode: input.moduleCode,
      pageCode: input.pageCode,
      actionCode: input.actionCode || "approve",
      documentType: input.documentType,
      amount: input.amount,
      currencyCode: input.currencyCode,
      context: input.context || {},
    });
    if (!rule) return res.status(404).json({ message: "Tidak ada approval rule aktif yang sesuai dokumen ini." });
    const request = await createApprovalRequest({
      rule,
      moduleCode: input.moduleCode,
      pageCode: input.pageCode,
      actionCode: input.actionCode || "approve",
      documentType: input.documentType,
      documentId: input.documentId,
      documentNumber: input.documentNumber,
      amount: input.amount,
      currencyCode: input.currencyCode,
      context: input.context,
      requestedByUserId: req.user?.id,
      requestedBy: req.user?.username || req.user?.email,
    });
    res.status(201).json(request);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

async function act(req, res, next, decision) {
  try {
    const result = await prisma.$transaction((tx) => processApprovalAction({
      requestNumber: req.params.requestNumber,
      user: req.user,
      decision,
      notes: req.body?.notes,
      metadata: req.body?.metadata,
      tx,
    }));
    res.json({
      message: result.final ? `Dokumen ${decision === "Rejected" ? "ditolak" : "selesai disetujui"}.` : "Approval dicatat dan diteruskan ke step berikutnya.",
      final: result.final,
      data: result.request,
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
}

exports.approve = (req, res, next) => act(req, res, next, "Approved");
exports.reject = (req, res, next) => act(req, res, next, "Rejected");

exports.cancel = async (req, res, next) => {
  try {
    const result = await prisma.approvalRequest.updateMany({
      where: {
        requestNumber: req.params.requestNumber,
        isDeleted: false,
        status: { in: ACTIVE_REQUEST_STATUSES },
        OR: [{ requestedByUserId: req.user?.id }, ...(req.user?.isSuperAdmin ? [{}] : [])],
      },
      data: { status: "Cancelled", completedAt: new Date() },
    });
    if (!result.count) return res.status(404).json({ message: "Request aktif tidak ditemukan atau bukan milik user." });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
};
