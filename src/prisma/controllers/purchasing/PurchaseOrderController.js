const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { notificationHelper } = require("../../utils/notificationHelper");
const { parseDate } = require("../../utils/parseDate");
const { parseFilter } = require("../../utils/parseFilter");
const { deleteQuotationFile } = require("../../middleware/uploads");
const { generatePONumber, calcTotal } = require("./utils/purchasingHelpers");
const { generateMovementNumber } = require("../../utils/movementNumberGenerator");
const { resolveItemIdentityInput, hasItemIdentity, buildIdentityWhere, normalizeText } = require("../inventory/utils/itemIdentity");
const { assertStockBalanceNotFrozen } = require("../inventory/utils/stockOpnameFreezeGuard");
const {
  convertPODetailNumericFields,
} = require("./utils/purchasingNumericConverter");
const {
  normalizeDetailUomCodes,
} = require("../../utils/uomCodeNormalizer");

const PO_STATUS = {
  DRAFT: "Draft",
  OPERATIONAL_CHECK: "Checking by Operational Manager",
  ENGINEERING_CHECK: "Checking by Engineering Manager",
  SACHO_CHECK: "Checking by Sacho",
  APPROVED: "Approved",
  REVISING: "Revising",
  REJECTED: "Rejected",
};

const PO_CHECK_FLOW = [
  {
    status: PO_STATUS.OPERATIONAL_CHECK,
    nextStatus: PO_STATUS.SACHO_CHECK,
    action: "check-operational-manager",
  },
  {
    status: PO_STATUS.ENGINEERING_CHECK,
    nextStatus: PO_STATUS.SACHO_CHECK,
    action: "check-engineering-manager",
  },
  {
    status: PO_STATUS.SACHO_CHECK,
    nextStatus: PO_STATUS.APPROVED,
    action: "check-sacho",
  },
];

const PO_EDITABLE_STATUSES = new Set([PO_STATUS.DRAFT, PO_STATUS.REVISING]);

const parseJsonField = (value, fallback = null) => {
  if (typeof value !== "string") return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const toQuotationFileRecord = (f) => ({
  fileName: f.originalname,
  fileUrl: `/uploads/quotations/${f.filename}`,
  fileType: f.mimetype,
  fileSize: f.size,
});

const deleteAllQuotationFiles = (arr) => {
  if (!Array.isArray(arr)) return;
  arr.forEach((item) => {
    if (item?.fileUrl) deleteQuotationFile(item.fileUrl);
  });
};

const cleanupUploadedQuotationFiles = (req) => {
  deleteAllQuotationFiles((req.files?.quotationFiles ?? []).map(toQuotationFileRecord));
};

const getFileUrl = (file) => (typeof file === "string" ? file : file?.fileUrl);

const parseJsonArrayField = (value) => {
  const parsed = parseJsonField(value, []);
  return Array.isArray(parsed) ? parsed : [];
};

const normalizeVendorPriceBreakdown = (value) => {
  if (value === undefined) return undefined;
  return parseJsonArrayField(value).map((item) => {
    const { _key, ...cleanItem } = item || {};
    return cleanItem;
  });
};

const resolveQuotationFiles = (dbFiles = [], existingQuotationFiles, uploadedFiles = []) => {
  const currentFiles = Array.isArray(dbFiles) ? dbFiles : [];
  const parsedExisting = parseJsonField(existingQuotationFiles, null);
  const keptUrls = Array.isArray(parsedExisting)
    ? parsedExisting.map(getFileUrl).filter(Boolean)
    : currentFiles.map((f) => f.fileUrl);

  currentFiles
    .filter((f) => !keptUrls.includes(f.fileUrl))
    .forEach((f) => deleteQuotationFile(f.fileUrl));

  return [
    ...currentFiles.filter((f) => keptUrls.includes(f.fileUrl)),
    ...uploadedFiles.map(toQuotationFileRecord),
  ];
};

const PO_SUBMIT_CHECKER_OPTIONS = [
  {
    status: PO_STATUS.OPERATIONAL_CHECK,
    action: "check-operational-manager",
    aliases: [
      "operational-manager",
      "operational manager",
      "operational",
      "operation",
      "om",
      PO_STATUS.OPERATIONAL_CHECK.toLowerCase(),
    ],
  },
  {
    status: PO_STATUS.ENGINEERING_CHECK,
    action: "check-engineering-manager",
    aliases: [
      "engineering-manager",
      "engineering manager",
      "engineering",
      "engineer",
      "em",
      PO_STATUS.ENGINEERING_CHECK.toLowerCase(),
    ],
  },
  {
    status: PO_STATUS.SACHO_CHECK,
    action: "check-sacho",
    aliases: [
      "sacho",
      "president-director",
      "president director",
      PO_STATUS.SACHO_CHECK.toLowerCase(),
    ],
  },
];

const normalizePOCheckerInput = (body = {}) => {
  const requestedChecker =
    body.checker ??
    body.checkBy ??
    body.checkerRole ??
    body.requestedChecker ??
    body.requestedCheckBy ??
    body.targetChecker ??
    body.status;

  if (!requestedChecker) return PO_SUBMIT_CHECKER_OPTIONS[0];

  const normalized = String(requestedChecker)
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");

  return PO_SUBMIT_CHECKER_OPTIONS.find((option) =>
    option.aliases.some((alias) => alias.replace(/_/g, "-") === normalized),
  );
};

const hasPOPermission = (user, action) => {
  if (!user || user.isDeleted) return false;
  if (user.isSuperAdmin) return true;

  const listMenu = Array.isArray(user.listMenu) ? user.listMenu : [];
  const requiredAction = String(action).toLowerCase();

  return listMenu.some((entry) => {
    if (!entry || typeof entry !== "object" || !entry.resource) return false;
    if (String(entry.resource).toLowerCase() !== "purchaseorder") return false;

    const actions = Array.isArray(entry.actions)
      ? entry.actions.map((x) => String(x).toLowerCase())
      : [];

    return actions.includes("*") || actions.includes(requiredAction);
  });
};

const getPONotificationUserIds = async (action) => {
  const users = await notificationHelper.getUserIdsByPermission(
    "purchaseOrder",
    action,
  );

  return [...new Set(users)];
};

const toPathSafePoNumber = (poNumber) =>
  String(poNumber || "").replace(/\//g, "-");

const emitPOStatusUpdate = async (po, action, actionBy) => {
  try {
    const io = global.io;
    if (!io || !po?.poNumber) return;

    const payload = {
      poNumber: po.poNumber,
      status: po.status,
      action,
      actionBy,
      updatedAt: po.updatedAt,
    };

    io.emit("purchase-order:status", payload);
  } catch (err) {
    console.error("Failed to emit PO status update:", err);
  }
};

const emitPORevisionComment = (payload) => {
  try {
    const io = global.io;
    if (!io || !payload?.poNumber) return;

    io.emit("purchase-order:revision-comment", payload);
  } catch (err) {
    console.error("Failed to emit PO revision comment:", err);
  }
};

const getPORevisionThreadUserIds = async (parentId, excludeUserId) => {
  if (!parentId) return [];

  const comments = await prisma.purchaseOrderComment.findMany({
    where: {
      OR: [{ id: parentId }, { parentId }],
    },
    select: { userId: true },
  });

  return [
    ...new Set(
      comments
        .map((comment) => comment.userId)
        .filter((userId) => userId && userId !== excludeUserId),
    ),
  ];
};

const notifyPORevisionReplyParticipants = async (poNumber, reply, actionBy) => {
  try {
    const userIds = await getPORevisionThreadUserIds(reply.parentId, reply.userId);
    if (!userIds.length) return;

    await Promise.all(
      userIds.map((userId) =>
        notificationHelper.create({
          type: "purchase_order",
          title: "Balasan Revision History PO",
          message: `${actionBy} membalas revision history PO #${poNumber}: ${reply.message}`,
          entityId: poNumber,
          entityUrl: `/app/purchasing/purchase-order/${toPathSafePoNumber(poNumber)}`,
          userId,
          metadata: {
            action: "revision-reply",
            poNumber,
            commentId: reply.parentId,
            replyId: reply.id,
          },
          createdBy: actionBy,
        }),
      ),
    );
  } catch (err) {
    console.error("Failed to notify PO revision reply participants:", err);
  }
};

const getPOCreatorNotificationUserIds = async (createdBy) => {
  if (!createdBy) return [];

  const users = await prisma.user.findMany({
    where: {
      isDeleted: false,
      OR: [{ username: createdBy }, { email: createdBy }],
    },
    select: { id: true },
  });

  return [...new Set(users.map((user) => user.id))];
};

// ============================================
// HELPER: Validasi PO boleh dihapus/dibatalkan
// ============================================
async function canRemoveOrCancelPO(prisma, poNumber) {
  // Cek apakah ada GR dengan status Completed untuk PO ini
  const completedGR = await prisma.goodsReceipt.findFirst({
    where: { poNumber, status: "Completed", isDeleted: false },
    select: { grNumber: true },
  });
  if (completedGR) {
    return {
      ok: false,
      message:
        "PO tidak dapat dihapus/dibatalkan karena sudah ada Goods Receipt dengan status Completed.",
    };
  }
  return { ok: true };
}
// ============================================
// HELPER: Recalculate status PR berdasar orderedQty
// ============================================
async function recalculatePRStatus(prismaClient, prNumber) {
  const details = await prismaClient.purchaseRequisitionDetail.findMany({
    where: { prNumber, isDeleted: false },
    select: { qty: true, orderedQty: true },
  });

  const allFullyOrdered =
    details.length > 0 &&
    details.every((d) => (d.orderedQty || 0) >= (d.qty || 0));
  const anyOrdered = details.some((d) => (d.orderedQty || 0) > 0);

  await prismaClient.purchaseRequisition.update({
    where: { prNumber },
    data: {
      status: allFullyOrdered
        ? "Completed"
        : anyOrdered
          ? "Partially Ordered"
          : "Approved",
    },
  });
}

// ============================================
// HELPER: Kembalikan orderedQty PR dari detail PO
// ============================================
async function restorePRQtyFromPO(prismaClient, poNumber) {
  const poDetails = await prismaClient.purchaseOrderDetail.findMany({
    where: {
      poNumber,
      isDeleted: false,
      prDetailId: { not: null },
    },
    select: { prDetailId: true, qty: true },
  });

  if (!poDetails.length) return [];

  const restoreQtyByPRDetailId = new Map();
  for (const d of poDetails) {
    const key = d.prDetailId;
    const prev = restoreQtyByPRDetailId.get(key) || 0;
    restoreQtyByPRDetailId.set(key, prev + (d.qty || 0));
  }

  const prDetailIds = Array.from(restoreQtyByPRDetailId.keys());
  const prDetails = await prismaClient.purchaseRequisitionDetail.findMany({
    where: { id: { in: prDetailIds } },
    select: { id: true, prNumber: true, orderedQty: true },
  });

  const affectedPRNumbers = new Set();

  for (const prDetail of prDetails) {
    const restoreQty = restoreQtyByPRDetailId.get(prDetail.id) || 0;
    if (restoreQty <= 0) continue;

    const nextOrderedQty = Math.max(0, (prDetail.orderedQty || 0) - restoreQty);
    await prismaClient.purchaseRequisitionDetail.update({
      where: { id: prDetail.id },
      data: { orderedQty: nextOrderedQty },
    });

    if (prDetail.prNumber) affectedPRNumbers.add(prDetail.prNumber);
  }

  return Array.from(affectedPRNumbers);
}

// ============================================
// REUSABLE INCLUDES & SELECTS
// ============================================
const PO_SIGNATORY_USER_SELECT = {
  id: true,
  username: true,
  fullName: true,
  email: true,
  employeeId: true,
  employee: {
    select: {
      employeeId: true,
      fullName: true,
      email: true,
      position: true,
      profilePhoto: true,
      signature: true,
    },
  },
};

const normalizeSignatoryUsername = (value) => String(value || '').trim().toLowerCase();

const mapUserSignatory = (user) => {
  if (!user) return null;

  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    email: user.email,
    employeeId: user.employeeId,
    employee: user.employee
      ? {
          employeeId: user.employee.employeeId,
          fullName: user.employee.fullName,
          email: user.employee.email,
          position: user.employee.position,
          profilePhoto: user.employee.profilePhoto,
          signature: user.employee.signature,
        }
      : null,
  };
};

const getPOSignatoryUsersByUsername = async (usernames = []) => {
  const normalizedUsernames = [
    ...new Set(
      usernames
        .map((username) => String(username || '').trim())
        .filter(Boolean),
    ),
  ];

  if (!normalizedUsernames.length) return new Map();

  const users = await prisma.user.findMany({
    where: {
      isDeleted: false,
      OR: normalizedUsernames.map((username) => ({
        username: { equals: username, mode: 'insensitive' },
      })),
    },
    select: PO_SIGNATORY_USER_SELECT,
  });

  return new Map(
    users.map((user) => [normalizeSignatoryUsername(user.username), mapUserSignatory(user)]),
  );
};

const attachPOSignatories = (po, userMap = new Map()) => {
  if (!po) return po;

  return {
    ...mapDoc(po),
    checked: userMap.get(normalizeSignatoryUsername(po.checkedBy)) || null,
    approved: userMap.get(normalizeSignatoryUsername(po.approvedBy)) || null,
  };
};

const mapPOResponse = async (po) => {
  const userMap = await getPOSignatoryUsersByUsername([po?.checkedBy, po?.approvedBy]);
  return attachPOSignatories(po, userMap);
};

const mapPOResponses = async (items = []) => {
  const userMap = await getPOSignatoryUsersByUsername(
    items.flatMap((po) => [po?.checkedBy, po?.approvedBy]),
  );

  return items.map((po) => attachPOSignatories(po, userMap));
};
const PO_INCLUDE = {
  supplier: {
    select: {
      supplierCode: true,
      supplierName: true,
      contact: true,
      phone: true,
      email: true,
      billingAddress: true,
      shippingAddress: true,
      leadTimeDays: true,
    },
  },
  vendor: {
    select: {
      vendorCode: true,
      vendorName: true,
      contact: true,
      phone: true,
      email: true,
      billingAddress: true,
      shippingAddress: true,
      leadTimeDays: true,
    },
  },
  currency: {
    select: {
      symbol: true,
    },
  },
  purchaseRequisitions: {
    select: {
      prNumber: true,
      pr: {
        select: {
          prNumber: true,
          requestedBy: true,
          department: true,
        },
      },
    },
  },
  details: {
    where: { isDeleted: false },
    orderBy: { lineNumber: "asc" },
    include: {
      product: {
        select: { productCode: true, productName: true, description: true },
      },
    },
  },
  goodsReceipts: {
    where: { isDeleted: false },
    select: { grNumber: true, grDate: true, status: true },
    orderBy: { grDate: "desc" },
  },
  _count: {
    select: { details: true, goodsReceipts: true },
  },
};

// ============================================
// LOCAL HELPERS
// ============================================

// Map + convert numeric fields untuk PO detail
const mapPODetail = (d, idx, defaultDeliveryDate) => {
  const c = convertPODetailNumericFields(d);
  const {
    _vendorPriceBreakdownOptions,
    _processPriceSelectionTouched,
    vendorPriceBreakdown,
    ...detail
  } = c;
  const normalizedVendorPriceBreakdown = normalizeVendorPriceBreakdown(vendorPriceBreakdown);

  return {
    ...detail,
    ...(normalizedVendorPriceBreakdown !== undefined
      ? { vendorPriceBreakdown: normalizedVendorPriceBreakdown }
      : {}),
    lineNumber: Number(c.lineNumber) || idx + 1,
    deliveryDate:
      parseDate(c.deliveryDate) ?? parseDate(defaultDeliveryDate) ?? null,
  };
};

// Khusus nested create Prisma: relasi harus pakai connect, bukan FK scalar langsung
const mapPODetailForNestedCreate = (d, idx, defaultDeliveryDate) => {
  const mapped = mapPODetail(d, idx, defaultDeliveryDate);
  const { prDetailId, productId, vendorPriceListId, ...rest } = mapped;

  return {
    ...rest,
    ...(prDetailId ? { prDetail: { connect: { id: prDetailId } } } : {}),
    ...(productId ? { product: { connect: { id: productId } } } : {}),
    ...(vendorPriceListId
      ? { vendorPriceList: { connect: { id: vendorPriceListId } } }
      : {}),
  };
};

const parsePoNumberFromSlug = (value) => {
  const prefixedPartnerSlugMatch = value.match(/^((?:P|E)-PO)-(.+)-(\d{2})-(\d{4})-(\d{2,})$/i);
  if (prefixedPartnerSlugMatch) {
    const [, rawPrefix, partnerCode, month, year, seq] = prefixedPartnerSlugMatch;
    return `${rawPrefix.toUpperCase()}/${partnerCode}/${month}/${year}/${seq}`;
  }

  const partnerSlugMatch = value.match(/^(.+)-(\d{2})-(\d{4})-(\d{2,})$/);
  if (partnerSlugMatch) {
    const [, partnerCode, month, year, seq] = partnerSlugMatch;
    return `${partnerCode}/${month}/${year}/${seq}`;
  }

  const slugMatch = value.match(
    /^((?:P|E)-PO|PO)-([A-Z]{2,4})-(\d{3})-MI-([IVX]+)-(\d{4})$/i,
  );
  if (!slugMatch) return null;

  const [, rawPrefix, rawTypeCode, seq, rawRomanMonth, year] = slugMatch;
  const prefix = rawPrefix.toUpperCase();
  const typeCode = rawTypeCode.toUpperCase();
  const romanMonth = rawRomanMonth.toUpperCase();

  return `${prefix}/${typeCode}/${seq}/MI/${romanMonth}/${year}`;
};

const getPONumberCandidates = (rawValue) => {
  if (!rawValue || typeof rawValue !== "string") return [];

  const decoded = decodeURIComponent(rawValue).trim();
  if (!decoded) return [];

  const candidates = [decoded];
  // Fallback jika frontend kirim slug path-safe: PO-..., P-PO-..., E-PO-...
  const poNumberFromSlug = parsePoNumberFromSlug(decoded);
  if (poNumberFromSlug) {
    candidates.push(poNumberFromSlug);
  }

  return [...new Set(candidates)];
};

const findPOByNumber = async (rawValue, include = PO_INCLUDE) => {
  const candidates = getPONumberCandidates(rawValue);
  if (!candidates.length) return null;

  return prisma.purchaseOrder.findFirst({
    where: { poNumber: { in: candidates } },
    include,
  });
};

const findPOBasicByNumber = async (rawValue, select) => {
  const candidates = getPONumberCandidates(rawValue);
  if (!candidates.length) return null;

  return prisma.purchaseOrder.findFirst({
    where: { poNumber: { in: candidates } },
    select,
  });
};

// ============================================
// GENERATE PO NUMBER
// ============================================
exports.generateNumber = async (req, res, next) => {
  try {
    const {
      poType = "Other",
      poNumberPrefix = null,
      supplierCode = null,
      vendorCode = null,
      partnerCode = null,
    } = req.query;
    const resolvedPartnerCode = partnerCode || supplierCode || vendorCode;
    const poNumber = await generatePONumber(poType, null, poNumberPrefix, resolvedPartnerCode);
    res.json({ poNumber });
  } catch (e) {
    next(e);
  }
};

// ============================================
// LIST PURCHASE ORDERS
// ============================================
exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      status,
      supplierCode,
      prNumber,
      dateFrom,
      dateTo,
      poType,
      category: detailCategory,
      page = 1,
      limit = 20,
    } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;

    if (supplierCode) {
      where.supplierCode = supplierCode;
    }

    if (prNumber) {
      where.purchaseRequisitions = { some: { prNumber } };
    }

    if (poType) {
      const poTypeArray = Array.isArray(poType) ? poType : [poType];
      where.poType = { in: poTypeArray };
    }

    if (detailCategory) {
      where.details = {
        some: {
          category: detailCategory,
          isDeleted: false,
        },
      };
    }

    if (dateFrom || dateTo) {
      where.poDate = {};
      if (dateFrom) where.poDate.gte = new Date(dateFrom);
      if (dateTo) where.poDate.lte = new Date(dateTo);
    }

    if (q) {
      const keyword = String(q).trim();
      where.OR = [
        { poNumber: { contains: keyword, mode: "insensitive" } },
        { supplierName: { contains: keyword, mode: "insensitive" } },
        { supplierCode: { contains: keyword, mode: "insensitive" } },
        { vendorName: { contains: keyword, mode: "insensitive" } },
        { vendorCode: { contains: keyword, mode: "insensitive" } },
        { quotationNumber: { contains: keyword, mode: "insensitive" } },
        { notes: { contains: keyword, mode: "insensitive" } },
        {
          details: {
            some: {
              isDeleted: false,
              OR: [
                { partCode: { contains: keyword, mode: "insensitive" } },
                { partNumber: { contains: keyword, mode: "insensitive" } },
                { partName: { contains: keyword, mode: "insensitive" } },
                { description: { contains: keyword, mode: "insensitive" } },
                {
                  product: {
                    is: {
                      OR: [
                        {
                          productCode: {
                            contains: keyword,
                            mode: "insensitive",
                          },
                        },
                        {
                          productName: {
                            contains: keyword,
                            mode: "insensitive",
                          },
                        },
                        {
                          description: {
                            contains: keyword,
                            mode: "insensitive",
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      ];
    }

    const orderBy = buildSort(req.query) || { poDate: "desc" };
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where,
        include: PO_INCLUDE,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.purchaseOrder.count({ where }),
    ]);

    res.json({
      items: await mapPOResponses(items),
      total,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (e) {
    next(e);
  }
};

// ============================================
// GET PO BY NUMBER
// ============================================
exports.get = async (req, res, next) => {
  try {
    const poNumberRaw = req.query.poNumber || req.params.poNumber;

    if (!poNumberRaw) {
      return res.status(400).json({ message: "poNumber wajib diisi" });
    }

    const po = await findPOByNumber(poNumberRaw, PO_INCLUDE);

    if (!po) {
      return res
        .status(404)
        .json({ message: "Purchase Order tidak ditemukan" });
    }

    res.json(await mapPOResponse(po));
  } catch (e) {
    next(e);
  }
};

// ============================================
// GET PO REVISION HISTORY
// ============================================
exports.revisionHistory = async (req, res, next) => {
  try {
    const { poNumber: poNumberRaw } = req.params;
    const existing = await findPOBasicByNumber(poNumberRaw, {
      poNumber: true,
      isDeleted: true,
    });

    if (!existing || existing.isDeleted) {
      return res
        .status(404)
        .json({ message: "Purchase Order tidak ditemukan" });
    }

    const comments = await prisma.purchaseOrderComment.findMany({
      where: {
        poNumber: existing.poNumber,
        type: "revision",
        parentId: null,
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(req.query.limit) || 50, 100),
      select: {
        id: true,
        message: true,
        fromStatus: true,
        toStatus: true,
        createdBy: true,
        userId: true,
        createdAt: true,
        replies: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            poNumber: true,
            parentId: true,
            type: true,
            message: true,
            fromStatus: true,
            toStatus: true,
            createdBy: true,
            userId: true,
            createdAt: true,
          },
        },
      },
    });

    res.json(
      comments.map((comment) => ({
        id: comment.id,
        poNumber: existing.poNumber,
        message: comment.message,
        fromStatus: comment.fromStatus,
        toStatus: comment.toStatus,
        createdBy: comment.createdBy,
        userId: comment.userId,
        createdAt: comment.createdAt,
        replies: comment.replies,
      })),
    );
  } catch (e) {
    next(e);
  }
};

// ============================================
// REPLY PO REVISION COMMENT
// ============================================
exports.replyRevisionComment = async (req, res, next) => {
  try {
    const { poNumber: poNumberRaw, commentId } = req.params;
    const message = String(req.body?.message || req.body?.comment || "").trim();

    if (!message) {
      return res.status(400).json({ message: "Balasan wajib diisi" });
    }

    const existing = await findPOBasicByNumber(poNumberRaw, {
      poNumber: true,
      isDeleted: true,
    });

    if (!existing || existing.isDeleted) {
      return res
        .status(404)
        .json({ message: "Purchase Order tidak ditemukan" });
    }

    const parent = await prisma.purchaseOrderComment.findFirst({
      where: {
        id: commentId,
        poNumber: existing.poNumber,
        type: "revision",
        parentId: null,
      },
      select: { id: true },
    });

    if (!parent) {
      return res
        .status(404)
        .json({ message: "Komentar revisi tidak ditemukan" });
    }

    const reply = await prisma.purchaseOrderComment.create({
      data: {
        poNumber: existing.poNumber,
        parentId: parent.id,
        type: "reply",
        message,
        createdBy: req.user?.username || req.user?.email || "System",
        userId: req.user?.id || null,
      },
      select: {
        id: true,
        poNumber: true,
        parentId: true,
        type: true,
        message: true,
        fromStatus: true,
        toStatus: true,
        createdBy: true,
        userId: true,
        createdAt: true,
      },
    });

    emitPORevisionComment({
      action: "reply-created",
      poNumber: existing.poNumber,
      parentId: parent.id,
      comment: reply,
      actionBy: reply.createdBy,
    });

    await notifyPORevisionReplyParticipants(
      existing.poNumber,
      reply,
      reply.createdBy,
    );

    res.status(201).json(reply);
  } catch (e) {
    next(e);
  }
};

// ============================================
// CREATE PO
// ============================================
exports.create = async (req, res, next) => {
  try {
    let { header, details } = req.body;
    header = parseJsonField(header, header) || {};
    details = parseJsonField(details, details) || [];
    details = await normalizeDetailUomCodes(prisma, details);
    const resolvedCurrencyCode = header.currencyCode || "IDR";
    const uploadedQuotationFiles = req.files?.quotationFiles ?? [];

    // Validate supplier OR vendor exists (read-only, aman di luar transaction)
    if (header.supplierCode) {
      const supplier = await prisma.supplier.findUnique({
        where: { supplierCode: header.supplierCode },
      });
      if (!supplier) {
        cleanupUploadedQuotationFiles(req);
        return res.status(404).json({ message: "Supplier tidak ditemukan" });
      }
    } else if (header.vendorCode) {
      const vendor = await prisma.vendor.findUnique({
        where: { vendorCode: header.vendorCode },
      });
      if (!vendor) {
        cleanupUploadedQuotationFiles(req);
        return res.status(404).json({ message: "Vendor tidak ditemukan" });
      }
    } else {
      cleanupUploadedQuotationFiles(req);
      return res
        .status(400)
        .json({ message: "supplierCode atau vendorCode harus diisi" });
    }

    const currency = await prisma.currency.findFirst({
      where: { currencyCode: resolvedCurrencyCode, isDeleted: false },
      select: { currencyCode: true },
    });
    if (!currency) {
      cleanupUploadedQuotationFiles(req);
      return res.status(404).json({ message: "Currency tidak ditemukan" });
    }

    const prNumbers = header.prNumbers ?? [];

    const po = await prisma.$transaction(async (tx) => {
      // Lock baris PR agar tidak ada concurrent PO yang mengubah orderedQty bersamaan
      if (prNumbers.length) {
        for (const prNum of prNumbers) {
          await tx.$queryRaw`
            SELECT id FROM "tbl_purchase_requisition"
            WHERE "pr_number" = ${prNum}
            AND "is_deleted" = false
            FOR UPDATE
          `;
        }
      }

      // Generate poNumber di dalam transaction agar sequential dan tidak duplicate
      const resolvedPoType = header.poType || "Other";
      const poNumber = await generatePONumber(
        resolvedPoType,
        tx,
        header.poNumberPrefix || null,
        header.supplierCode || header.vendorCode,
      );

      const created = await tx.purchaseOrder.create({
        data: {
          poNumber,
          poDate: parseDate(header.poDate) ?? new Date(),
          supplierName: header.supplierName || null,
          vendorName: header.vendorName || null,
          contact: header.contact || null,
          phone: header.phone || null,
          email: header.email || null,
          billingAddress: header.billingAddress || null,
          shippingAddress: header.shippingAddress || null,
          deliveryDate: parseDate(header.deliveryDate),
          paymentTerms: header.paymentTerms || null,
          quotationNumber: header.quotationNumber || null,
          quotationFiles: [
            ...parseJsonArrayField(header.quotationFiles),
            ...uploadedQuotationFiles.map(toQuotationFileRecord),
          ],
          poType: resolvedPoType,
          currency: { connect: { currencyCode: resolvedCurrencyCode } },
          status: PO_STATUS.APPROVED,
          totalAmount: calcTotal(details),
          notes: header.notes || null,
          createdBy:
            header.createdBy || req.user?.username || req.user?.email || null,
          approvedBy: header.createdBy || req.user?.username || req.user?.email || null,
          approvedDate: new Date(),
          ...(prNumbers.length && {
            purchaseRequisitions: {
              create: prNumbers.map((prNum) => ({ prNumber: prNum })),
            },
          }),
          ...(header.supplierCode && {
            supplier: { connect: { supplierCode: header.supplierCode } },
          }),
          ...(header.vendorCode && {
            vendor: { connect: { vendorCode: header.vendorCode } },
          }),
          details: details?.length
            ? {
                create: details.map((d, idx) =>
                  mapPODetailForNestedCreate(d, idx, header.deliveryDate),
                ),
              }
            : undefined,
        },
        include: PO_INCLUDE,
      });

      // Update PR status & orderedQty jika dibuat dari PR
      // Gunakan prDetailId yang dikirim frontend untuk link eksplisit
      if (prNumbers.length) {
        const prDetailIds = created.details
          .filter((pd) => pd.prDetailId)
          .map((pd) => ({ id: pd.id, prDetailId: pd.prDetailId, qty: pd.qty }));

        for (const { prDetailId, qty } of prDetailIds) {
          const prDetail = await tx.purchaseRequisitionDetail.findUnique({
            where: { id: prDetailId },
            select: { id: true, qty: true, orderedQty: true, prNumber: true },
          });
          if (!prDetail) continue;
          const addQty = Math.min(
            qty,
            Math.max(0, (prDetail.qty || 0) - (prDetail.orderedQty || 0)),
          );
          if (addQty > 0) {
            await tx.purchaseRequisitionDetail.update({
              where: { id: prDetailId },
              data: { orderedQty: { increment: addQty } },
            });
          }
        }

        // Recalculate status per PR
        for (const prNum of prNumbers) {
          const updatedDetails = await tx.purchaseRequisitionDetail.findMany({
            where: { prNumber: prNum, isDeleted: false },
            select: { qty: true, orderedQty: true },
          });
          const allFullyOrdered = updatedDetails.every(
            (d) => (d.orderedQty || 0) >= (d.qty || 0),
          );
          const anyOrdered = updatedDetails.some(
            (d) => (d.orderedQty || 0) > 0,
          );
          await tx.purchaseRequisition.update({
            where: { prNumber: prNum },
            data: {
              status: allFullyOrdered
                ? "Completed"
                : anyOrdered
                  ? "Partially Ordered"
                  : "Approved",
              convertedToPO: created.poNumber,
            },
          });
        }
      }

      return created;
    });

    res.status(201).json(await mapPOResponse(po));
  } catch (e) {
    cleanupUploadedQuotationFiles(req);
    next(e);
  }
};

// ============================================
// UPDATE PO
// ============================================
exports.update = async (req, res, next) => {
  try {
    const { id } = req.params;
    let { header, details } = req.body;
    header = parseJsonField(header, header) || {};
    details = parseJsonField(details, details);
    details = await normalizeDetailUomCodes(prisma, details);

    // Exclude immutable fields
    const {
      poNumber,
      createdAt,
      updatedAt,
      createdBy,
      prNumbers,
      category,
      poNumberPrefix,
      currencyCode,
      supplierCode,
      vendorCode,
      quotationFiles,
      existingQuotationFiles,
      ...rawData
    } = header;

    if (supplierCode && vendorCode) {
      cleanupUploadedQuotationFiles(req);
      return res
        .status(400)
        .json({
          message: "supplierCode dan vendorCode tidak boleh diisi bersamaan",
        });
    }

    const hasSupplierVendorPayload =
      supplierCode !== undefined || vendorCode !== undefined;
    if (hasSupplierVendorPayload && !supplierCode && !vendorCode) {
      return res
        .status(400)
        .json({ message: "supplierCode atau vendorCode harus diisi" });
    }

    if (supplierCode) {
      const supplier = await prisma.supplier.findUnique({
        where: { supplierCode },
        select: { supplierCode: true },
      });

      if (!supplier) {
        cleanupUploadedQuotationFiles(req);
        return res.status(404).json({ message: "Supplier tidak ditemukan" });
      }
    }

    if (vendorCode) {
      const vendor = await prisma.vendor.findUnique({
        where: { vendorCode },
        select: { vendorCode: true },
      });

      if (!vendor) {
        cleanupUploadedQuotationFiles(req);
        return res.status(404).json({ message: "Vendor tidak ditemukan" });
      }
    }

    if (
      currencyCode !== undefined &&
      currencyCode !== null &&
      currencyCode !== ""
    ) {
      const currency = await prisma.currency.findFirst({
        where: { currencyCode, isDeleted: false },
        select: { currencyCode: true },
      });

      if (!currency) {
        cleanupUploadedQuotationFiles(req);
        return res.status(404).json({ message: "Currency tidak ditemukan" });
      }
    }

    // null = tidak ada perubahan PR
    const newPrNumbers = prNumbers ?? null;

    const result = await prisma.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({
        where: { id },
        select: {
          poNumber: true,
          status: true,
          isDeleted: true,
          quotationFiles: true,
        },
      });

      if (!po) {
        throw Object.assign(new Error("Purchase Order tidak ditemukan"), {
          statusCode: 404,
        });
      }

      if (po.isDeleted) {
        throw Object.assign(new Error("Purchase Order sudah dihapus"), {
          statusCode: 400,
        });
      }

      if (!PO_EDITABLE_STATUSES.has(po.status)) {
        throw Object.assign(
          new Error(
            `PO dengan status ${po.status} tidak dapat diedit. Gunakan revisi terlebih dahulu.`,
          ),
          { statusCode: 400 },
        );
      }

      // Snapshot old details sebelum diubah (untuk kalkulasi delta orderedQty di PR)
      // Simpan prDetailId + qty untuk matching eksplisit
      const oldDetails = details
        ? await tx.purchaseOrderDetail.findMany({
            where: { poNumber: po.poNumber, isDeleted: false },
            select: { prDetailId: true, qty: true },
          })
        : [];

      // Update header
      const updateData = {
        ...rawData,
        deliveryDate: parseDate(rawData.deliveryDate) ?? undefined,
        approvedDate: parseDate(rawData.approvedDate) ?? undefined,
        quotationFiles: resolveQuotationFiles(
          po.quotationFiles,
          existingQuotationFiles ?? quotationFiles,
          req.files?.quotationFiles ?? [],
        ),
        ...(details ? { totalAmount: calcTotal(details) } : {}),
      };

      if (
        currencyCode !== undefined &&
        currencyCode !== null &&
        currencyCode !== ""
      ) {
        updateData.currency = { connect: { currencyCode } };
      }

      if (hasSupplierVendorPayload) {
        if (supplierCode) {
          updateData.supplier = { connect: { supplierCode } };
          updateData.vendor = { disconnect: true };
        } else {
          updateData.vendor = { connect: { vendorCode } };
          updateData.supplier = { disconnect: true };
        }
      }

      await tx.purchaseOrder.update({
        where: { id },
        data: updateData,
      });

      // Sinkronisasi junction prNumbers jika disediakan
      if (newPrNumbers !== null) {
        // Hapus semua junction lama, ganti dengan yang baru
        await tx.purchaseOrderPR.deleteMany({
          where: { poNumber: po.poNumber },
        });
        if (newPrNumbers.length > 0) {
          await tx.purchaseOrderPR.createMany({
            data: newPrNumbers.map((prNum) => ({
              poNumber: po.poNumber,
              prNumber: prNum,
            })),
            skipDuplicates: true,
          });
        }
      }

      // Update details jika disediakan
      let newDetailRows = [];
      if (details) {
        // Soft delete semua detail lama
        await tx.purchaseOrderDetail.updateMany({
          where: { poNumber: po.poNumber },
          data: { isDeleted: true },
        });

        // Buat detail baru (exclude id & timestamp agar tidak collision)
        newDetailRows = details.map((d, idx) => {
          const {
            id: _id,
            createdAt,
            updatedAt,
            ...mapped
          } = mapPODetail(d, idx, rawData.deliveryDate);

          return { ...mapped, poNumber: po.poNumber };
        });
        await tx.purchaseOrderDetail.createMany({ data: newDetailRows });
      }

      // Sinkronisasi orderedQty di PR details jika qty PO berubah
      // Matching berdasarkan prDetailId (eksplisit), bukan partCode
      if (details) {
        // Kumpulkan semua prDetailId yang terlibat (lama + baru)
        const involvedPrDetailIds = new Set([
          ...oldDetails.map((d) => d.prDetailId).filter(Boolean),
          ...newDetailRows.map((d) => d.prDetailId).filter(Boolean),
        ]);

        for (const prDetailId of involvedPrDetailIds) {
          const oldQty = oldDetails
            .filter((d) => d.prDetailId === prDetailId)
            .reduce((sum, d) => sum + (d.qty || 0), 0);
          const newQty = newDetailRows
            .filter((d) => d.prDetailId === prDetailId)
            .reduce((sum, d) => sum + (d.qty || 0), 0);
          const delta = newQty - oldQty;

          if (delta !== 0) {
            const prDetail = await tx.purchaseRequisitionDetail.findUnique({
              where: { id: prDetailId },
              select: { orderedQty: true },
            });
            if (!prDetail) continue;
            await tx.purchaseRequisitionDetail.update({
              where: { id: prDetailId },
              data: {
                orderedQty: Math.max(0, (prDetail.orderedQty || 0) + delta),
              },
            });
          }
        }

        // Recalculate status per PR yang terkait
        const linkedPRs = await tx.purchaseOrderPR.findMany({
          where: { poNumber: po.poNumber },
          select: { prNumber: true },
        });

        for (const { prNumber } of linkedPRs) {
          const updatedPRDetails = await tx.purchaseRequisitionDetail.findMany({
            where: { prNumber, isDeleted: false },
            select: { qty: true, orderedQty: true },
          });
          const allFullyOrdered = updatedPRDetails.every(
            (d) => (d.orderedQty || 0) >= (d.qty || 0),
          );
          const anyOrdered = updatedPRDetails.some(
            (d) => (d.orderedQty || 0) > 0,
          );

          await tx.purchaseRequisition.update({
            where: { prNumber },
            data: {
              status: allFullyOrdered
                ? "Completed"
                : anyOrdered
                  ? "Partially Ordered"
                  : "Approved",
            },
          });
        }
      }

      return tx.purchaseOrder.findUnique({
        where: { id },
        include: PO_INCLUDE,
      });
    });

    // Send notification untuk PO update
    try {
      await notificationHelper.notifyPurchaseOrder(
        "update",
        result,
        req.user?.username || "System",
      );
    } catch (notifErr) {
      console.error("Failed to send notification:", notifErr);
    }

    res.json(await mapPOResponse(result));
  } catch (e) {
    cleanupUploadedQuotationFiles(req);
    console.error("PO Update Error:", e);
    next(e);
  }
};

// ============================================
// SEND PO (Kirim ke Supplier → status: Sent)
// ============================================
exports.send = async (req, res, next) => {
  try {
    const { poNumber: poNumberRaw } = req.params;
    const existing = await findPOBasicByNumber(poNumberRaw, {
      poNumber: true,
      status: true,
      isDeleted: true,
    });
    if (!existing) {
      return res
        .status(404)
        .json({ message: "Purchase Order tidak ditemukan" });
    }

    if (existing.isDeleted) {
      return res.status(400).json({ message: "Purchase Order sudah dihapus" });
    }

    if (existing.status === "Sent") {
      return res.status(400).json({ message: "PO sudah dikirim" });
    }

    if (existing.status !== PO_STATUS.APPROVED) {
      return res.status(400).json({
        message: `PO dengan status ${existing.status} belum dapat dikirim. PO harus di-approve terlebih dahulu.`,
      });
    }

    const po = await prisma.purchaseOrder.update({
      where: { poNumber: existing.poNumber },
      data: { status: "Sent" },
    });

    await emitPOStatusUpdate(
      po,
      "send",
      req.user?.username || req.user?.email || "System",
    );

    res.json(await mapPOResponse(po));
  } catch (e) {
    next(e);
  }
};

// ============================================
// CONFIRM PO (Supplier konfirmasi → status: Confirmed)
// ============================================
exports.confirm = async (req, res, next) => {
  try {
    const { poNumber: poNumberRaw } = req.params;
    const existing = await findPOBasicByNumber(poNumberRaw, {
      poNumber: true,
      approvedBy: true,
      approvedDate: true,
    });
    if (!existing) {
      return res
        .status(404)
        .json({ message: "Purchase Order tidak ditemukan" });
    }

    const po = await prisma.purchaseOrder.update({
      where: { poNumber: existing.poNumber },
      data: {
        status: "Confirmed",
        approvedBy:
          existing.approvedBy ||
          req.user?.username ||
          req.user?.email ||
          "System",
        approvedDate: existing.approvedDate || new Date(),
      },
    });

    await emitPOStatusUpdate(
      po,
      "confirm",
      req.user?.username || req.user?.email || "System",
    );

    res.json(await mapPOResponse(po));
  } catch (e) {
    next(e);
  }
};

// ============================================
// SUBMIT PO FOR CHECKING (Draft/Revising -> selected checker)
// ============================================
exports.submitChecking = async (req, res, next) => {
  try {
    const { poNumber: poNumberRaw } = req.params;
    const existing = await findPOBasicByNumber(poNumberRaw, {
      poNumber: true,
      status: true,
      isDeleted: true,
    });

    if (!existing) {
      return res
        .status(404)
        .json({ message: "Purchase Order tidak ditemukan" });
    }

    if (existing.isDeleted) {
      return res.status(400).json({ message: "Purchase Order sudah dihapus" });
    }

    if (!PO_EDITABLE_STATUSES.has(existing.status)) {
      return res.status(400).json({
        message: `PO dengan status ${existing.status} tidak dapat diajukan checking`,
      });
    }

    const checkerOption = normalizePOCheckerInput(req.body);
    if (!checkerOption) {
      return res.status(400).json({
        message: "Checker PO tidak valid",
        allowedCheckers: PO_SUBMIT_CHECKER_OPTIONS.map(
          (option) => option.status,
        ),
      });
    }

    const actionBy = req.user?.username || req.user?.email || "System";
    const po = await prisma.purchaseOrder.update({
      where: { poNumber: existing.poNumber },
      data: { status: checkerOption.status },
      include: PO_INCLUDE,
    });

    try {
      await notificationHelper.notifyPurchaseOrder(
        "submit-checking",
        po,
        actionBy,
        {
          userIds: await getPONotificationUserIds(checkerOption.action),
        },
      );
    } catch (notifErr) {
      console.error("Failed to send notification:", notifErr);
    }

    await emitPOStatusUpdate(po, "submit-checking", actionBy);

    res.json(await mapPOResponse(po));
  } catch (e) {
    next(e);
  }
};

// ============================================
// CHECK / APPROVE PO STEP
// ============================================
exports.approve = async (req, res, next) => {
  try {
    const { poNumber: poNumberRaw } = req.params;
    const existing = await findPOBasicByNumber(poNumberRaw, {
      poNumber: true,
      status: true,
      isDeleted: true,
    });

    if (!existing) {
      return res
        .status(404)
        .json({ message: "Purchase Order tidak ditemukan" });
    }

    if (existing.isDeleted) {
      return res.status(400).json({ message: "Purchase Order sudah dihapus" });
    }

    if (existing.status === PO_STATUS.APPROVED) {
      return res.status(400).json({ message: "PO sudah disetujui" });
    }

    const flowStep = PO_CHECK_FLOW.find(
      (step) => step.status === existing.status,
    );
    if (!flowStep) {
      return res.status(400).json({
        message: `PO dengan status ${existing.status} tidak dapat di-check/approve`,
      });
    }

    if (
      !hasPOPermission(req.user, flowStep.action) &&
      !hasPOPermission(req.user, "approve")
    ) {
      return res.status(403).json({
        message: `Forbidden: No ${flowStep.action} access to purchaseOrder`,
      });
    }

    const actionBy = req.user?.username || req.user?.email || "System";
    const isFinalApproval = flowStep.nextStatus === PO_STATUS.APPROVED;
    const revisionReason = String(
      req.body?.revisionReason || req.body?.message || req.body?.comment || "",
    ).trim();

    if (revisionReason && isFinalApproval) {
      return res.status(400).json({
        message:
          "Pesan revisi hanya dapat dikirim pada tahap checking Operational/Engineering",
      });
    }

    const po = await prisma.purchaseOrder.update({
      where: { poNumber: existing.poNumber },
      data: {
        status: flowStep.nextStatus,
        ...(isFinalApproval
          ? {
              approvedBy: actionBy,
              approvedDate: new Date(),
            }
          : {
              checkedBy: actionBy,
              checkedDate: new Date(),
            }),
      },
      include: PO_INCLUDE,
    });

    if (revisionReason) {
      const comment = await prisma.purchaseOrderComment.create({
        data: {
          poNumber: po.poNumber,
          type: "revision",
          message: revisionReason,
          fromStatus: existing.status,
          toStatus: flowStep.nextStatus,
          createdBy: actionBy,
          userId: req.user?.id || null,
        },
      });

      emitPORevisionComment({
        action: "created",
        poNumber: po.poNumber,
        parentId: null,
        comment: { ...comment, replies: [] },
        actionBy,
      });
    }

    try {
      const nextStep = PO_CHECK_FLOW.find((step) => step.status === po.status);
      if (nextStep) {
        await notificationHelper.notifyPurchaseOrder("check", po, actionBy, {
          userIds: await getPONotificationUserIds(nextStep.action),
        });
      }
    } catch (notifErr) {
      console.error("Failed to send notification:", notifErr);
    }

    await emitPOStatusUpdate(
      po,
      isFinalApproval ? "approve" : "check",
      actionBy,
    );

    res.json(await mapPOResponse(po));
  } catch (e) {
    next(e);
  }
};

// ============================================
// REVISE PO (Checking -> Revising)
// ============================================
exports.revise = async (req, res, next) => {
  try {
    const { poNumber: poNumberRaw } = req.params;
    const revisionReason = String(
      req.body?.revisionReason || req.body?.message || req.body?.comment || "",
    ).trim();

    if (!revisionReason) {
      return res.status(400).json({ message: "Alasan revisi wajib diisi" });
    }

    const existing = await findPOBasicByNumber(poNumberRaw, {
      poNumber: true,
      status: true,
      isDeleted: true,
    });

    if (!existing) {
      return res
        .status(404)
        .json({ message: "Purchase Order tidak ditemukan" });
    }

    if (existing.isDeleted) {
      return res.status(400).json({ message: "Purchase Order sudah dihapus" });
    }

    const flowStep = PO_CHECK_FLOW.find(
      (step) => step.status === existing.status,
    );
    if (!flowStep) {
      return res.status(400).json({
        message: `PO dengan status ${existing.status} tidak dapat direvisi`,
      });
    }

    if (
      !hasPOPermission(req.user, flowStep.action) &&
      !hasPOPermission(req.user, "approve")
    ) {
      return res.status(403).json({
        message: `Forbidden: No ${flowStep.action} access to purchaseOrder`,
      });
    }

    const actionBy = req.user?.username || req.user?.email || "System";
    const po = await prisma.purchaseOrder.update({
      where: { poNumber: existing.poNumber },
      data: { status: PO_STATUS.REVISING },
      include: PO_INCLUDE,
    });

    const comment = await prisma.purchaseOrderComment.create({
      data: {
        poNumber: po.poNumber,
        type: "revision",
        message: revisionReason,
        fromStatus: existing.status,
        toStatus: PO_STATUS.REVISING,
        createdBy: actionBy,
        userId: req.user?.id || null,
      },
    });

    emitPORevisionComment({
      action: "created",
      poNumber: po.poNumber,
      parentId: null,
      comment: { ...comment, replies: [] },
      actionBy,
    });

    try {
      await notificationHelper.notifyPurchaseOrder(
        "revise",
        { ...po, revisionReason },
        actionBy,
        {
          userIds: await getPOCreatorNotificationUserIds(po.createdBy),
        },
      );
    } catch (notifErr) {
      console.error("Failed to send notification:", notifErr);
    }

    await emitPOStatusUpdate(po, "revise", actionBy);

    res.json(await mapPOResponse(po));
  } catch (e) {
    next(e);
  }
};

// ============================================
// REJECT PO (Checking -> Rejected)
// ============================================
exports.reject = async (req, res, next) => {
  try {
    const { poNumber: poNumberRaw } = req.params;
    const existing = await findPOBasicByNumber(poNumberRaw, {
      poNumber: true,
      status: true,
      isDeleted: true,
    });

    if (!existing) {
      return res
        .status(404)
        .json({ message: "Purchase Order tidak ditemukan" });
    }

    if (existing.isDeleted) {
      return res.status(400).json({ message: "Purchase Order sudah dihapus" });
    }

    if (existing.status === PO_STATUS.REJECTED) {
      return res.status(400).json({ message: "PO sudah ditolak" });
    }

    const flowStep = PO_CHECK_FLOW.find(
      (step) => step.status === existing.status,
    );
    if (!flowStep) {
      return res.status(400).json({
        message: `PO dengan status ${existing.status} tidak dapat di-reject`,
      });
    }

    if (
      !hasPOPermission(req.user, flowStep.action) &&
      !hasPOPermission(req.user, "approve")
    ) {
      return res.status(403).json({
        message: `Forbidden: No ${flowStep.action} access to purchaseOrder`,
      });
    }

    const actionBy = req.user?.username || req.user?.email || "System";
    const po = await prisma.$transaction(async (tx) => {
      const restoredPRs = await restorePRQtyFromPO(tx, existing.poNumber);

      const updatedPO = await tx.purchaseOrder.update({
        where: { poNumber: existing.poNumber },
        data: {
          status: PO_STATUS.REJECTED,
          approvedBy: actionBy,
          approvedDate: new Date(),
        },
        include: PO_INCLUDE,
      });

      const linkedPRs = await tx.purchaseOrderPR.findMany({
        where: { poNumber: existing.poNumber },
        select: { prNumber: true },
      });

      const affectedPRNumbers = new Set([
        ...linkedPRs.map((p) => p.prNumber),
        ...restoredPRs,
      ]);

      for (const prNumber of affectedPRNumbers) {
        await recalculatePRStatus(tx, prNumber);
      }

      return updatedPO;
    });

    await emitPOStatusUpdate(po, "reject", actionBy);

    res.json(await mapPOResponse(po));
  } catch (e) {
    next(e);
  }
};

const getDirectStockType = (poType) => {
  if (poType === "Consumable") return "Consumable";
  if (poType === "Material") return "Material";
  if (poType === "Out Process") return "OutProcess";
  return poType || "Other";
};

async function receiveRemainingPoToStock(tx, po, warehouseCode, rackCode, performedBy) {
  const warehouse = await tx.warehouse.findFirst({
    where: { warehouseCode, isActive: true, isDeleted: false },
    select: { warehouseCode: true },
  });
  if (!warehouse) throw Object.assign(new Error("Warehouse tujuan tidak valid atau tidak aktif"), { statusCode: 400 });

  if (rackCode) {
    const rack = await tx.rack.findFirst({ where: { rackCode, isActive: true, isDeleted: false }, select: { rackCode: true } });
    if (!rack) throw Object.assign(new Error("Rack tujuan tidak valid atau tidak aktif"), { statusCode: 400 });
  }

  const movementDate = new Date();
  for (const detail of po.details) {
    const qty = Math.max(0, Number(detail.qty || 0) - Number(detail.qtyReceived || 0));
    if (qty <= 0) continue;

    const identity = await resolveItemIdentityInput(tx, detail);
    if (!hasItemIdentity(identity)) {
      throw Object.assign(new Error(`Identitas stock kosong pada PO detail ${detail.lineNumber}`), { statusCode: 400 });
    }

    const identityWhere = buildIdentityWhere(identity);
    const existing = await tx.stockBalance.findFirst({
      where: { warehouseCode, rackCode: rackCode || null, lotNumber: null, ...identityWhere, uomCode: detail.uomCode || null, isDeleted: false },
      select: { id: true, qtyOnHand: true, qtyReserved: true, qtyQC: true },
    });
    const qtyBefore = Number(existing?.qtyOnHand || 0);
    const qtyReserved = Number(existing?.qtyReserved || 0);
    const qtyQC = Number(existing?.qtyQC || 0);
    const qtyAfter = qtyBefore + qty;
    const stockType = getDirectStockType(po.poType);

    await tx.stockMovement.create({
      data: {
        movementNumber: await generateMovementNumber("IN", tx), movementDate,
        movementType: "IN", direction: "IN", transactionType: "PURCHASE_RECEIVE",
        warehouseCode, rackCode: rackCode || null, lotNumber: null,
        partCode: identity.partCode || null, partNumber: identity.partNumber || null,
        partName: normalizeText(detail.partName) || identity.partName || null,
        productId: identity.productId || null, description: identity.description || null,
        spec: identity.spec || null, thickness: identity.thickness ?? null, width: identity.width ?? null,
        CSP: identity.CSP || null, stockType, qty, deltaQty: qty, qtyBefore, qtyAfter,
        uomCode: detail.uomCode || null, referenceType: "PO", referenceNumber: po.poNumber,
        notes: `Penerimaan langsung dari manual complete PO ${po.poNumber}`,
        performedBy,
      },
    });

    const balanceData = {
      partNumber: identity.partNumber || null, partName: normalizeText(detail.partName) || identity.partName || null,
      productId: identity.productId || null, description: identity.description || null, spec: identity.spec || null,
      thickness: identity.thickness ?? null, width: identity.width ?? null, CSP: identity.CSP || null,
      uomCode: detail.uomCode || null, stockType, qtyOnHand: qtyAfter, qtyReserved,
      qtyQC, qtyAvailable: Math.max(0, qtyAfter - qtyReserved - qtyQC), lastMovement: movementDate,
    };
    if (existing) {
      await assertStockBalanceNotFrozen(tx, existing.id);
      await tx.stockBalance.update({ where: { id: existing.id }, data: balanceData });
    } else {
      await tx.stockBalance.create({ data: { warehouseCode, rackCode: rackCode || null, lotNumber: null, partCode: identity.partCode || null, ...balanceData } });
    }
    await tx.purchaseOrderDetail.update({ where: { id: detail.id }, data: { qtyReceived: { increment: qty } } });
  }
}
// ============================================
// MANUAL COMPLETE PO (Tutup PO manual -> status: Completed)
// ============================================
exports.manualComplete = async (req, res, next) => {
  try {
    const { poNumber: poNumberRaw } = req.params;
    const existing = await findPOBasicByNumber(poNumberRaw, {
      poNumber: true,
      status: true,
      approvedBy: true,
      approvedDate: true,
      isDeleted: true,
    });

    if (!existing) {
      return res
        .status(404)
        .json({ message: "Purchase Order tidak ditemukan" });
    }

    if (existing.isDeleted) {
      return res.status(400).json({ message: "Purchase Order sudah dihapus" });
    }

    if (!["Approved", "Sent", "Confirmed", "Partial Receipt"].includes(existing.status)) {
      return res.status(400).json({ message: `PO dengan status ${existing.status} tidak dapat di-complete manual.` });
    }

    const warehouseCode = normalizeText(req.body?.warehouseCode);
    const rackCode = normalizeText(req.body?.rackCode) || null;
    if (!warehouseCode) {
      return res.status(400).json({ message: "Warehouse tujuan wajib dipilih" });
    }

    const performedBy = req.user?.username || req.user?.email || "System";
    const po = await prisma.$transaction(async (tx) => {
      const poForReceipt = await tx.purchaseOrder.findUnique({ where: { poNumber: existing.poNumber }, include: PO_INCLUDE });
      await receiveRemainingPoToStock(tx, poForReceipt, warehouseCode, rackCode, performedBy);
      return tx.purchaseOrder.update({
        where: { poNumber: existing.poNumber },
        data: { status: "Completed", approvedBy: existing.approvedBy || performedBy, approvedDate: existing.approvedDate || new Date() },
        include: PO_INCLUDE,
      });
    });
    await emitPOStatusUpdate(
      po,
      "manual-complete",
      req.user?.username || req.user?.email || "System",
    );

    res.json(await mapPOResponse(po));
  } catch (e) {
    next(e);
  }
};

// ============================================
// CANCEL PO (Batalkan PO → status: Cancelled)
// ============================================
exports.cancel = async (req, res, next) => {
  try {
    const { poNumber: poNumberRaw } = req.params;

    const existing = await findPOBasicByNumber(poNumberRaw, {
      poNumber: true,
      status: true,
    });

    if (!existing) {
      return res
        .status(404)
        .json({ message: "Purchase Order tidak ditemukan" });
    }

    // Validasi GR completed (DRY)
    const canProceed = await canRemoveOrCancelPO(prisma, existing.poNumber);
    if (!canProceed.ok) {
      return res.status(400).json({ message: canProceed.message });
    }

    if (["Partial Receipt", "Completed"].includes(existing.status)) {
      return res.status(400).json({
        message: `PO dengan status ${existing.status} tidak dapat dibatalkan`,
      });
    }

    if (existing.status === "Cancelled") {
      return res.status(400).json({ message: "PO sudah dibatalkan" });
    }

    const po = await prisma.$transaction(async (tx) => {
      const restoredPRs = await restorePRQtyFromPO(tx, existing.poNumber);

      const updatedPO = await tx.purchaseOrder.update({
        where: { poNumber: existing.poNumber },
        data: { status: "Cancelled" },
      });

      const linkedPRs = await tx.purchaseOrderPR.findMany({
        where: { poNumber: existing.poNumber },
        select: { prNumber: true },
      });

      const affectedPRNumbers = new Set([
        ...linkedPRs.map((p) => p.prNumber),
        ...restoredPRs,
      ]);

      for (const prNumber of affectedPRNumbers) {
        await recalculatePRStatus(tx, prNumber);
      }

      return updatedPO;
    });

    await emitPOStatusUpdate(
      po,
      "cancel",
      req.user?.username || req.user?.email || "System",
    );

    res.json(await mapPOResponse(po));
  } catch (e) {
    next(e);
  }
};

// ============================================
// SOFT DELETE
// ============================================
exports.remove = async (req, res, next) => {
  try {
    const { poNumber: poNumberRaw } = req.params;
    const existing = await findPOBasicByNumber(poNumberRaw, {
      poNumber: true,
      status: true,
      isDeleted: true,
    });
    if (!existing) {
      return res
        .status(404)
        .json({ message: "Purchase Order tidak ditemukan" });
    }

    if (existing.isDeleted) {
      return res.status(400).json({ message: "Purchase Order sudah dihapus" });
    }

    // Validasi GR completed (DRY)
    const canProceed = await canRemoveOrCancelPO(prisma, existing.poNumber);
    if (!canProceed.ok) {
      return res.status(400).json({ message: canProceed.message });
    }

    await prisma.$transaction(async (tx) => {
      let restoredPRs = [];
      if (existing.status !== "Cancelled") {
        restoredPRs = await restorePRQtyFromPO(tx, existing.poNumber);
      }

      await tx.purchaseOrderDetail.updateMany({
        where: { poNumber: existing.poNumber },
        data: { isDeleted: true },
      });

      await tx.purchaseOrder.update({
        where: { poNumber: existing.poNumber },
        data: { isDeleted: true },
      });

      const linkedPRs = await tx.purchaseOrderPR.findMany({
        where: { poNumber: existing.poNumber },
        select: { prNumber: true },
      });

      const affectedPRNumbers = new Set([
        ...linkedPRs.map((p) => p.prNumber),
        ...restoredPRs,
      ]);

      for (const prNumber of affectedPRNumbers) {
        await recalculatePRStatus(tx, prNumber);
      }
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
};

// ============================================
// BULK REMOVE
// ============================================
exports.bulkRemove = async (req, res, next) => {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res
        .status(400)
        .json({ message: "ids array required", received: req.body });
    }

    const docs = await prisma.purchaseOrder.findMany({
      where: { id: { in: ids } },
      select: { poNumber: true, id: true, status: true, isDeleted: true },
    });
    const activeDocs = docs.filter((d) => !d.isDeleted);
    const poNumbers = activeDocs.map((d) => d.poNumber);

    if (poNumbers.length === 0) {
      return res.json({ deletedCount: 0 });
    }

    // Validasi GR completed (DRY)
    const completedGRs = await prisma.goodsReceipt.findMany({
      where: {
        poNumber: { in: poNumbers },
        status: "Completed",
        isDeleted: false,
      },
      select: { poNumber: true },
    });
    const blockedPONumbers = new Set(completedGRs.map((gr) => gr.poNumber));
    if (blockedPONumbers.size > 0) {
      return res.status(400).json({
        message:
          "Beberapa PO tidak dapat dihapus/dibatalkan karena sudah ada Goods Receipt dengan status Completed.",
        blockedPONumbers: Array.from(blockedPONumbers),
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const nonCancelledPONumbers = activeDocs
        .filter((d) => d.status !== "Cancelled")
        .map((d) => d.poNumber);

      const affectedPRNumbers = new Set();
      for (const poNumber of nonCancelledPONumbers) {
        const restoredPRs = await restorePRQtyFromPO(tx, poNumber);
        restoredPRs.forEach((prNumber) => affectedPRNumbers.add(prNumber));
      }

      const linkedPRs = await tx.purchaseOrderPR.findMany({
        where: { poNumber: { in: poNumbers } },
        select: { prNumber: true },
      });
      linkedPRs.forEach((row) => affectedPRNumbers.add(row.prNumber));

      const detailResult = await tx.purchaseOrderDetail.updateMany({
        where: { poNumber: { in: poNumbers } },
        data: { isDeleted: true },
      });

      const headerResult = await tx.purchaseOrder.updateMany({
        where: { id: { in: activeDocs.map((d) => d.id) } },
        data: { isDeleted: true },
      });

      for (const prNumber of affectedPRNumbers) {
        await recalculatePRStatus(tx, prNumber);
      }

      return [detailResult, headerResult];
    });

    res.json({ deletedCount: result[1].count });
  } catch (e) {
    console.error("Bulk Remove Error:", e);
    next(e);
  }
};

