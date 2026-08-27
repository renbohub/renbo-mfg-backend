const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { generateDocNumber } = require("../purchasing/utils/purchasingHelpers");
const { generateMovementNumber } = require("../../utils/movementNumberGenerator");
const { assertStockBalanceNotFrozen } = require("./utils/stockOpnameFreezeGuard");
const { submitDocumentForApproval } = require("../../services/approvalRuleService");
const { STO_STOCK_TYPES, stockIdentityMatchesScope } = require("../../services/inventory/stockOpnameDomain");
const { startStockOpnameCounting, saveStockOpnameCountAttempt } = require("../../services/inventory/stockOpnameCountingService");
const { submitStockOpnameRound, checkStockOpnameRound, startStockOpnameRecount } = require("../../services/inventory/stockOpnameWorkflowService");
const { previewStockOpnameAdjustment, postStockOpnameAdjustment } = require("../../services/inventory/stockOpnameAdjustmentService");
const { resolveItemIdentityInput, hasItemIdentity, buildIdentityWhere } = require("./utils/itemIdentity");
const { resolveStockOpnameScope } = require("../../services/inventory/stockOpnameScopeService");

const FROZEN_STATUSES = ["COUNTING", "WAITING_CHECK", "WAITING_APPROVAL", "APPROVED"];

const fail = (message, statusCode = 400) => { const error = new Error(message); error.statusCode = statusCode; throw error; };
const actor = (req) => req.user?.username || req.user?.email || "system";
const counterName = (req, fallback = true) => {
  const value = String(req.body?.countedBy || req.body?.counterName || "").trim();
  return value || (fallback ? actor(req) : "");
};

function statusGuard(current, expected) {
  if (Array.isArray(expected) ? !expected.includes(current) : current !== expected) fail(`Status STO ${current} tidak dapat diproses untuk aksi ini.`, 409);
}

function variance(systemQty, actualQty) {
  const system = Number(systemQty || 0);
  const actual = Number(actualQty);
  const value = Number.isFinite(actual) ? actual - system : 0;
  return { value, status: value === 0 ? "MATCH" : value < 0 ? "SHORTAGE" : "EXCESS" };
}

function countSummary(details = []) {
  const active = details.filter((detail) => !detail.isDeleted);
  return active.reduce((summary, detail) => {
    summary.totalLines += 1;
    if (detail.actualQty != null) summary.countedLines += 1;
    else summary.uncountedLines += 1;
    const status = detail.actualQty == null ? "UNCOUNTED" : detail.varianceStatus || "MATCH";
    if (status === "MATCH") summary.matchLines += 1;
    if (status === "SHORTAGE") summary.shortageLines += 1;
    if (status === "EXCESS") summary.excessLines += 1;
    summary.systemQty += Number(detail.systemQty || 0);
    summary.actualQty += Number(detail.actualQty || 0);
    summary.varianceQty += Number(detail.varianceQty || 0);
    summary.absoluteVarianceQty += Math.abs(Number(detail.varianceQty || 0));
    return summary;
  }, {
    totalLines: 0,
    countedLines: 0,
    uncountedLines: 0,
    matchLines: 0,
    shortageLines: 0,
    excessLines: 0,
    systemQty: 0,
    actualQty: 0,
    varianceQty: 0,
    absoluteVarianceQty: 0,
  });
}

function mapStockOpname(item) {
  const details = item.details || [];
  const summary = countSummary(details);
  const mapped = mapDoc({
    ...item,
    detailCount: item._count?.details ?? summary.totalLines,
    countedCount: summary.countedLines,
    varianceCount: summary.shortageLines + summary.excessLines,
    countProgressPercent: summary.totalLines
      ? Math.round((summary.countedLines / summary.totalLines) * 10000) / 100
      : 0,
    countSummary: summary,
  });
  const rounds = Array.isArray(item.countRounds) ? item.countRounds : [];
  const currentRound = rounds.find((round) => round.roundNo === Number(item.currentRoundNo || 1)) || rounds[0] || null;
  mapped.currentRound = currentRound ? {
    id: currentRound.id,
    roundNo: currentRound.roundNo,
    status: currentRound.status,
    startedBy: currentRound.startedBy,
    startedAt: currentRound.startedAt,
    submittedBy: currentRound.submittedBy,
    submittedAt: currentRound.submittedAt,
    progress: {
      totalLines: summary.totalLines,
      countedLines: summary.countedLines,
      uncountedLines: summary.uncountedLines,
    },
  } : null;
  mapped.countRounds = rounds.map((round) => ({
    id: round.id,
    roundNo: round.roundNo,
    status: round.status,
    requestReason: round.requestReason,
    requestedBy: round.requestedBy,
    startedBy: round.startedBy,
    startedAt: round.startedAt,
    submittedBy: round.submittedBy,
    submittedAt: round.submittedAt,
    attemptCount: Array.isArray(round.attempts) ? round.attempts.length : 0,
    counters: [...new Set((round.attempts || []).map((attempt) => attempt.countedBy).filter(Boolean))],
    ...(!["DRAFT", "COUNTING"].includes(String(item.status || "").toUpperCase())
      ? { attempts: round.attempts || [] }
      : {}),
  }));
  if (["DRAFT", "COUNTING"].includes(String(item.status || "").toUpperCase())) {
    mapped.details = (mapped.details || []).map((detail) => {
      const { systemQty, varianceQty, varianceAmount, varianceStatus, ...blindDetail } = detail;
      return blindDetail;
    });
    mapped.varianceCount = null;
    mapped.countSummary = {
      totalLines: summary.totalLines,
      countedLines: summary.countedLines,
      uncountedLines: summary.uncountedLines,
    };
  }
  return mapped;
}

const normalizeIdentity = (value) => String(value || "").trim().toUpperCase();

async function findItem(stoNo, db = prisma) {
  return db.stockOpnameHeader.findFirst({
    where: { stoNo, isDeleted: false },
    include: {
      details: {
        where: { isDeleted: false },
        orderBy: [
          { rackCode: "asc" },
          { partCode: "asc" },
          { lotNumber: "asc" },
        ],
      },
      countRounds: {
        orderBy: { roundNo: "desc" },
        include: {
          attempts: {
            orderBy: [
              { stoDetailId: "asc" },
              { sequenceNo: "asc" },
            ],
          },
        },
      },
    },
  });
}

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 20)));
    const q = String(req.query.q || "").trim();
    const where = { isDeleted: false };
    if (req.query.stoType) where.stoType = String(req.query.stoType).toUpperCase();
    if (req.query.warehouseCode) where.warehouseCode = String(req.query.warehouseCode);
    if (req.query.status) where.status = String(req.query.status).toUpperCase();
    if (q) where.OR = [{ stoNo: { contains: q, mode: "insensitive" } }, { warehouseCode: { contains: q, mode: "insensitive" } }, { notes: { contains: q, mode: "insensitive" } }];
    const [items, total] = await Promise.all([
      prisma.stockOpnameHeader.findMany({
        where,
        include: {
          details: {
            where: { isDeleted: false },
            select: {
              actualQty: true,
              systemQty: true,
              varianceQty: true,
              varianceStatus: true,
              isDeleted: true,
            },
          },
          _count: { select: { details: true } },
        },
        orderBy: buildSort(req.query) || { stoDate: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.stockOpnameHeader.count({ where }),
    ]);
    res.json({ items: items.map(mapStockOpname), total, page, limit });
  } catch (error) { next(error); }
};

exports.get = async (req, res, next) => {
  try {
    const item = await findItem(req.params.stoNo);
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    res.json(mapStockOpname(item));
  } catch (error) { next(error); }
};

exports.previewScope = async (req, res, next) => {
  try {
    const preview = await resolveStockOpnameScope(prisma, req.body || {}, { includeBalances: false });
    res.json(preview);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

exports.create = async (req, res, next) => {
  try {
    const body = req.body || {};
    const resolved = await resolveStockOpnameScope(prisma, body, { includeBalances: true });
    if (!resolved.summary.lineCount) {
      return res.status(409).json({ message: "Tidak ada stock balance pada scope opname yang dipilih." });
    }
    const toleranceQty = Number(body.toleranceQty || 0);
    const tolerancePercent = Number(body.tolerancePercent || 0);
    if (!Number.isFinite(toleranceQty) || toleranceQty < 0) {
      return res.status(400).json({ message: "toleranceQty harus berupa angka >= 0." });
    }
    if (!Number.isFinite(tolerancePercent) || tolerancePercent < 0) {
      return res.status(400).json({ message: "tolerancePercent harus berupa angka >= 0." });
    }

    const stoNo = await generateDocNumber("stockOpnameHeader", "STO", "stoNo");
    const scopeNote = [
      resolved.scope.rackCodes.length ? "Scope rack: " + resolved.scope.rackCodes.join(", ") : null,
      resolved.scope.lotNumbers.length ? "Scope lot: " + resolved.scope.lotNumbers.join(", ") : null,
      body.notes || null,
    ].filter(Boolean).join(" | ");
    const header = await prisma.stockOpnameHeader.create({
      data: {
        stoNo,
        stoType: resolved.scope.stoType,
        countMode: resolved.scope.countMode,
        scopeJson: resolved.scope,
        warehouseCode: resolved.scope.warehouseCode,
        stoDate: body.stoDate ? new Date(body.stoDate) : new Date(),
        status: "DRAFT",
        notes: scopeNote || null,
        toleranceQty,
        tolerancePercent,
        createdBy: actor(req),
        details: {
          create: resolved.balances.map((balance) => ({
            stockBalanceId: balance.id,
            partCode: balance.partCode,
            partNumber: balance.partNumber,
            partName: balance.partName || balance.materialName,
            materialId: balance.materialId,
            materialCode: balance.materialCode,
            materialName: balance.materialName,
            materialType: balance.materialType,
            productId: balance.productId,
            description: balance.description || balance.materialCode,
            spec: balance.spec || balance.materialType,
            thickness: balance.thickness,
            width: balance.width,
            CSP: balance.CSP,
            stockType: balance.stockType,
            warehouseCode: balance.warehouseCode,
            rackCode: balance.rackCode,
            lotNumber: balance.lotNumber,
            uomCode: balance.uomCode,
            systemQty: balance.qtyOnHand,
          })),
        },
      },
      include: { details: true },
    });
    res.status(201).json({
      ...mapStockOpname(header),
      scopeWarnings: resolved.warnings,
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};
exports.startCounting = async (req, res, next) => {
  try {
    const item = await findItem(req.params.stoNo);
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    await prisma.$transaction((tx) => startStockOpnameCounting(tx, item, actor(req)));
    res.json(mapStockOpname(await findItem(item.stoNo)));
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

exports.countDetail = async (req, res, next) => {
  try {
    const item = await findItem(req.params.stoNo);
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    statusGuard(item.status, "COUNTING");
    const detail = item.details.find((row) => row.id === req.params.detailId);
    if (!detail) return res.status(404).json({ message: "Detail stock opname tidak ditemukan." });
    const round = item.countRounds.find((row) => row.roundNo === item.currentRoundNo && row.status === "ACTIVE");
    if (!round) return res.status(409).json({ message: "Count round aktif tidak ditemukan." });
    await prisma.$transaction((tx) => saveStockOpnameCountAttempt(tx, {
      header: item,
      round,
      detail,
      actualQty: req.body?.actualQty,
      countedBy: counterName(req, false),
      reason: req.body?.reason,
    }));
    res.json(mapStockOpname(await findItem(item.stoNo)));
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

exports.blindCount = async (req, res, next) => {
  try {
    const item = await findItem(req.params.stoNo);
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    statusGuard(item.status, "COUNTING");
    const rackCode = normalizeIdentity(req.body?.rackCode);
    const lotNumber = normalizeIdentity(req.body?.lotNumber);
    const stockType = normalizeIdentity(req.body?.stockType);
    const materialType = normalizeIdentity(req.body?.materialType);
    const materialIdentity = normalizeIdentity(req.body?.materialIdentity || req.body?.materialCode || req.body?.materialName);
    const partIdentity = normalizeIdentity(req.body?.partIdentity || req.body?.partCode || req.body?.partNumber);
    const partName = normalizeIdentity(req.body?.partName);
    if (!stockType) return res.status(400).json({ message: "Jenis stock wajib dipilih." });
    const isMaterial = stockType === "MATERIAL";
    if (isMaterial && (!materialType || !materialIdentity)) {
      return res.status(400).json({ message: "Jenis material dan nama/kode material wajib dipilih." });
    }
    if (!isMaterial && (!partIdentity || !partName)) {
      return res.status(400).json({ message: "Part No/Part Code dan Part Name wajib dipilih." });
    }
    const matches = item.details.filter((detail) =>
      normalizeIdentity(detail.rackCode) === rackCode
      && normalizeIdentity(detail.lotNumber) === lotNumber
      && normalizeIdentity(detail.stockType) === stockType
      && (isMaterial
        ? normalizeIdentity(detail.materialType) === materialType
          && [normalizeIdentity(detail.materialCode), normalizeIdentity(detail.materialName)].includes(materialIdentity)
        : [normalizeIdentity(detail.partCode), normalizeIdentity(detail.partNumber)].includes(partIdentity)
          && normalizeIdentity(detail.partName) === partName));
    if (!matches.length) {
      return res.status(404).json({ message: "Kombinasi jenis stock, material/part, rack, dan lot tidak termasuk scope Stock Opname ini." });
    }
    if (matches.length > 1) {
      return res.status(409).json({ message: "Kombinasi rack, lot, dan part tidak unik. Gunakan identitas part yang lebih spesifik." });
    }
    const round = item.countRounds.find((row) => row.roundNo === item.currentRoundNo && row.status === "ACTIVE");
    if (!round) return res.status(409).json({ message: "Count round aktif tidak ditemukan." });
    await prisma.$transaction((tx) => saveStockOpnameCountAttempt(tx, {
      header: item,
      round,
      detail: matches[0],
      actualQty: req.body?.actualQty,
      countedBy: counterName(req, false),
      reason: req.body?.reason,
    }));
    res.json(mapStockOpname(await findItem(item.stoNo)));
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

exports.foundStock = async (req, res, next) => {
  try {
    const item = await findItem(req.params.stoNo);
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    statusGuard(item.status, "COUNTING");
    const body = req.body || {};
    const stockType = String(body.stockType || "").trim();
    if (!STO_STOCK_TYPES[item.stoType]?.includes(stockType)) {
      return res.status(400).json({ message: "Stock type found stock tidak sesuai dengan STO." });
    }
    const countedBy = counterName(req, false);
    const reason = String(body.reason || "").trim();
    const uomCode = String(body.uomCode || "").trim() || null;
    if (!countedBy) return res.status(400).json({ message: "Nama petugas hitung wajib diisi." });
    if (!reason) return res.status(400).json({ message: "Alasan found stock wajib diisi." });
    if (!uomCode) return res.status(400).json({ message: "UOM found stock wajib diisi." });

    const result = await prisma.$transaction(async (tx) => {
      const identity = await resolveItemIdentityInput(tx, body, { enrichPartSnapshot: true });
      if (!hasItemIdentity(identity)) fail("Identitas item found stock wajib diisi.");
      const rackCode = String(body.rackCode || "").trim() || null;
      const lotNumber = String(body.lotNumber || "").trim() || null;
      if (rackCode) {
        const rack = await tx.rack.findFirst({
          where: { rackCode, warehouseCode: item.warehouseCode, isDeleted: false },
          select: { rackCode: true },
        });
        if (!rack) fail("Rack found stock tidak ditemukan pada warehouse STO.");
      }
      const scope = item.scopeJson || {
        version: 1,
        countMode: "FULL",
        stoType: item.stoType,
        warehouseCode: item.warehouseCode,
        stockTypes: STO_STOCK_TYPES[item.stoType],
        rackCodes: [],
        lotNumbers: [],
        stockBalanceIds: [],
        includeZeroBalance: true,
      };
      if (!stockIdentityMatchesScope({
        warehouseCode: item.warehouseCode,
        stockType,
        rackCode,
        lotNumber,
      }, scope)) {
        fail("Found stock berada di luar scope Stock Opname.", 409);
      }
      const existing = await tx.stockBalance.findFirst({
        where: {
          warehouseCode: item.warehouseCode,
          rackCode,
          lotNumber,
          stockType,
          uomCode,
          ...buildIdentityWhere(identity),
          isDeleted: false,
        },
        select: { id: true },
      });
      if (existing) fail("Kombinasi found stock sudah ada pada expected scope. Hitung detail existing.", 409);

      const detail = await tx.stockOpnameDetail.create({
        data: {
          stoHeaderId: item.id,
          stockBalanceId: null,
          warehouseCode: item.warehouseCode,
          rackCode,
          lotNumber,
          stockType,
          uomCode,
          partCode: identity.partCode || null,
          partNumber: identity.partNumber || null,
          partName: identity.partName || null,
          materialId: identity.materialId || null,
          materialCode: identity.materialCode || null,
          materialName: identity.materialName || null,
          materialType: identity.materialType || null,
          productId: identity.productId || null,
          description: identity.description || null,
          spec: identity.spec || null,
          thickness: identity.thickness ?? null,
          width: identity.width ?? null,
          CSP: identity.CSP || null,
          systemQty: 0,
          isUnexpected: true,
          resolutionStatus: "FOUND",
        },
      });
      const round = item.countRounds.find((row) => row.roundNo === item.currentRoundNo && row.status === "ACTIVE");
      if (!round) fail("Count round aktif tidak ditemukan.", 409);
      return saveStockOpnameCountAttempt(tx, {
        header: item,
        round,
        detail,
        actualQty: body.actualQty,
        countedBy,
        reason,
      });
    });
    res.json({ foundStock: result.detail, ...mapStockOpname(await findItem(item.stoNo)) });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

exports.bulkCount = async (req, res, next) => {
  try {
    const item = await findItem(req.params.stoNo);
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    statusGuard(item.status, "COUNTING");
    const counts = Array.isArray(req.body?.counts) ? req.body.counts : [];
    const defaultCountedBy = counterName(req, false);
    if (!counts.length) return res.status(400).json({ message: "counts wajib berisi minimal satu baris." });
    const detailById = new Map(item.details.map((detail) => [detail.id, detail]));
    const round = item.countRounds.find((row) => row.roundNo === item.currentRoundNo && row.status === "ACTIVE");
    if (!round) return res.status(409).json({ message: "Count round aktif tidak ditemukan." });
    await prisma.$transaction(async (tx) => {
      for (const count of counts) {
        const detail = detailById.get(count.detailId);
        if (!detail) fail("Detail " + (count.detailId || "-") + " bukan bagian dari " + item.stoNo + ".");
        await saveStockOpnameCountAttempt(tx, {
          header: item,
          round,
          detail,
          actualQty: count.actualQty,
          countedBy: String(count.countedBy || defaultCountedBy || "").trim(),
          reason: count.reason,
        });
      }
    });
    res.json(mapStockOpname(await findItem(item.stoNo)));
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};
exports.submit = async (req, res, next) => {
  try {
    const item = await findItem(req.params.stoNo);
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    const round = item.countRounds.find((row) => row.roundNo === item.currentRoundNo && row.status === "ACTIVE");
    const result = await prisma.$transaction((tx) => submitStockOpnameRound(tx, {
      header: item,
      round,
      details: item.details,
      submittedBy: actor(req),
    }));
    res.json({ ...mapStockOpname(await findItem(item.stoNo)), recountRequiredCount: result.recountRequiredDetails.length });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

exports.check = async (req, res, next) => {
  try {
    const item = await findItem(req.params.stoNo);
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    const round = item.countRounds.find((row) =>
      row.roundNo === item.currentRoundNo && row.status === "SUBMITTED");
    const currentCounters = [...new Set((round?.attempts || [])
      .filter((attempt) => attempt.isCurrent)
      .map((attempt) => attempt.countedBy)
      .filter(Boolean))];
    const result = await prisma.$transaction(async (tx) => {
      const checked = await checkStockOpnameRound(tx, {
        header: item,
        round,
        details: item.details,
        currentCounters,
        checkedBy: actor(req),
        acceptanceReason: req.body?.acceptanceReason || req.body?.reason,
      });
      const approvalRequest = await submitDocumentForApproval({
        moduleCode: "inventory",
        pageCode: "stock-opname",
        actionCode: "approve",
        documentType: "StockOpnameHeader",
        documentId: item.id,
        documentNumber: item.stoNo,
        context: checked.header,
        requestedByUserId: req.user?.id,
        requestedBy: actor(req),
        tx,
      });
      return { ...checked, approvalRequest };
    });
    res.json({
      ...mapStockOpname(await findItem(item.stoNo)),
      approvalRequest: result.approvalRequest,
      recountRequiredCount: result.recountRequiredDetails.length,
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

exports.approve = async (req, res, next) => {
  try {
    const item = await findItem(req.params.stoNo);
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    statusGuard(item.status, "WAITING_APPROVAL");
    const approver = actor(req);
    const currentRound = item.countRounds.find((row) => row.roundNo === item.currentRoundNo);
    const counters = (currentRound?.attempts || []).filter((attempt) => attempt.isCurrent).map((attempt) => attempt.countedBy);
    const forbidden = [item.createdBy, item.submittedBy, item.checkerBy, ...counters]
      .filter(Boolean)
      .map((value) => String(value).trim().toLowerCase());
    if (approver !== "system" && forbidden.includes(String(approver).trim().toLowerCase())) {
      return res.status(409).json({ message: "Maker, checker, submitter, atau penghitung ronde aktif tidak boleh menjadi approver Stock Opname yang sama." });
    }
    const updated = await prisma.stockOpnameHeader.update({
      where: { id: item.id },
      data: { status: "APPROVED", approvedBy: approver, approvedAt: new Date() },
    });
    res.json(mapDoc(updated));
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

exports.requestRecount = async (req, res, next) => {
  try {
    const item = await findItem(req.params.stoNo);
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    const round = item.countRounds.find((row) => row.roundNo === item.currentRoundNo);
    await prisma.$transaction((tx) => startStockOpnameRecount(tx, {
      header: item,
      round,
      requestedBy: actor(req),
      reason: req.body?.reason,
    }));
    res.json(mapStockOpname(await findItem(item.stoNo)));
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};
exports.previewAdjustment = async (req, res, next) => {
  try {
    const item = await findItem(req.params.stoNo);
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    const preview = await previewStockOpnameAdjustment(prisma, { header: item, details: item.details });
    res.json({
      stoNo: item.stoNo,
      canPost: preview.conflicts.length === 0,
      adjustmentLineCount: preview.lines.length,
      conflicts: preview.conflicts,
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message, conflicts: error.conflicts || [] });
    next(error);
  }
};

exports.adjust = async (req, res, next) => {
  try {
    const item = await findItem(req.params.stoNo);
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    const changed = await prisma.$transaction((tx) => postStockOpnameAdjustment(tx, {
      header: item,
      details: item.details,
      performedBy: actor(req),
    }));
    res.json({
      ...mapStockOpname(await findItem(item.stoNo)),
      movements: changed.movements.map(mapDoc),
      conflicts: [],
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({
      message: error.message,
      conflicts: error.conflicts || [],
    });
    next(error);
  }
};
exports.close = async (req, res, next) => {
  try {
    const item = await prisma.stockOpnameHeader.findUnique({ where: { stoNo: req.params.stoNo } });
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    statusGuard(item.status, ["ADJUSTED", "APPROVED"]);
    if (item.status === "APPROVED") {
      const varianceLines = await prisma.stockOpnameDetail.count({
        where: { stoHeaderId: item.id, isDeleted: false, varianceQty: { not: 0 } },
      });
      if (varianceLines > 0) return res.status(409).json({ message: "STO dengan selisih wajib Post Adjustment sebelum ditutup." });
    }
    const updated = await prisma.stockOpnameHeader.update({ where: { id: item.id }, data: { status: "CLOSED", inventoryFrozen: false, closedBy: actor(req), closedAt: new Date() } });
    res.json(mapDoc(updated));
  } catch (error) { next(error); }
};

exports.cancel = async (req, res, next) => {
  try {
    const item = await prisma.stockOpnameHeader.findFirst({ where: { stoNo: req.params.stoNo, isDeleted: false } });
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    statusGuard(item.status, ["DRAFT", "COUNTING", "WAITING_CHECK", "WAITING_APPROVAL"]);
    const reason = String(req.body?.reason || "").trim();
    if (!reason) return res.status(400).json({ message: "Alasan pembatalan wajib diisi." });
    const note = [item.notes, `CANCELLED ${new Date().toISOString()} oleh ${actor(req)}: ${reason}`].filter(Boolean).join("\n");
    const updated = await prisma.stockOpnameHeader.update({
      where: { id: item.id },
      data: { status: "CANCELLED", inventoryFrozen: false, notes: note, closedBy: actor(req), closedAt: new Date() },
    });
    res.json(mapDoc(updated));
  } catch (error) { next(error); }
};

module.exports = exports;
