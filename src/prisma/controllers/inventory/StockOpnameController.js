const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { generateDocNumber } = require("../purchasing/utils/purchasingHelpers");
const { generateMovementNumber } = require("../../utils/movementNumberGenerator");
const { assertStockBalanceNotFrozen } = require("./utils/stockOpnameFreezeGuard");
const { submitDocumentForApproval } = require("../../services/approvalRuleService");

const FROZEN_STATUSES = ["COUNTING", "WAITING_APPROVAL", "APPROVED"];
const STO_STOCK_TYPES = {
  MATERIAL: ["Material", "Purchase Part"],
  WIP: ["WIP", "WP", "Semi-Finished"],
  FG: ["Finished Goods", "FG"],
};
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

exports.create = async (req, res, next) => {
  try {
    const body = req.body || {};
    const warehouseCode = String(body.warehouseCode || "").trim();
    const stoType = String(body.stoType || "MATERIAL").trim().toUpperCase();
    if (!warehouseCode) return res.status(400).json({ message: "warehouseCode wajib diisi." });
    if (!STO_STOCK_TYPES[stoType]) return res.status(400).json({ message: "stoType harus MATERIAL, WIP, atau FG." });
    const warehouse = await prisma.warehouse.findFirst({
      where: { warehouseCode, isDeleted: false, isActive: true },
      select: { warehouseCode: true },
    });
    if (!warehouse) return res.status(400).json({ message: "Warehouse tidak ditemukan atau tidak aktif." });
    const requestedStockType = String(body.stockType || "").trim();
    if (requestedStockType && !STO_STOCK_TYPES[stoType].includes(requestedStockType)) {
      return res.status(400).json({ message: `Stock type ${requestedStockType} tidak sesuai dengan STO ${stoType}.` });
    }
    const purchasePartCodes = stoType === "MATERIAL"
      ? (await prisma.part.findMany({
          where: { isDeleted: false, itemType: "RAW", rawType: "PURCHASE_PART" },
          select: { partCode: true },
        })).map((part) => part.partCode)
      : [];
    const canonicalStockTypeWhere = requestedStockType
      ? requestedStockType === "Purchase Part"
        ? { OR: [
            { stockType: "Purchase Part" },
            { stockType: "Part", partCode: { in: purchasePartCodes } },
          ] }
        : { stockType: requestedStockType }
      : stoType === "MATERIAL"
        ? { OR: [
            { stockType: { in: STO_STOCK_TYPES.MATERIAL } },
            { stockType: "Part", partCode: { in: purchasePartCodes } },
          ] }
        : { stockType: { in: STO_STOCK_TYPES[stoType] } };
    const balances = await prisma.stockBalance.findMany({
      where: {
        warehouseCode,
        isDeleted: false,
        ...canonicalStockTypeWhere,
        ...(body.rackCode ? { rackCode: String(body.rackCode) } : {}),
        ...(body.lotNumber ? { lotNumber: String(body.lotNumber) } : {}),
      },
      orderBy: [{ rackCode: "asc" }, { partCode: "asc" }, { lotNumber: "asc" }],
    });
    if (!balances.length) {
      return res.status(409).json({ message: "Tidak ada stock balance pada scope opname yang dipilih." });
    }
    const stoNo = await generateDocNumber("stockOpnameHeader", "STO", "stoNo");
    const scopeNote = [
      body.rackCode ? `Scope rack: ${body.rackCode}` : null,
      body.lotNumber ? `Scope lot: ${body.lotNumber}` : null,
      body.notes || null,
    ].filter(Boolean).join(" | ");
    const header = await prisma.stockOpnameHeader.create({
      data: {
        stoNo,
        stoType,
        warehouseCode,
        stoDate: body.stoDate ? new Date(body.stoDate) : new Date(),
        status: "DRAFT",
        notes: scopeNote || null,
        createdBy: actor(req),
        details: {
          create: balances.map((balance) => ({
            stockBalanceId: balance.id,
            partCode: balance.partCode,
            partNumber: balance.partNumber,
            partName: balance.partName || balance.materialName,
            // Preserve material identity in the frozen scope for dependent counting dropdowns.
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
    res.status(201).json(mapStockOpname(header));
  } catch (error) { next(error); }
};

exports.startCounting = async (req, res, next) => {
  try {
    const item = await findItem(req.params.stoNo);
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    statusGuard(item.status, "DRAFT");
    const balanceIds = item.details.map((detail) => detail.stockBalanceId).filter(Boolean);
    const updated = await prisma.$transaction(async (tx) => {
      const conflict = await tx.stockOpnameDetail.findFirst({
        where: {
          stockBalanceId: { in: balanceIds },
          isDeleted: false,
          header: {
            isDeleted: false,
            inventoryFrozen: true,
            status: { in: FROZEN_STATUSES },
            stoNo: { not: item.stoNo },
          },
        },
        select: { header: { select: { stoNo: true } } },
      });
      if (conflict) fail(`Scope stock sudah dibekukan oleh ${conflict.header.stoNo}.`, 409);
      const balances = await tx.stockBalance.findMany({
        where: { id: { in: balanceIds }, isDeleted: false },
        select: { id: true, qtyOnHand: true },
      });
      const qtyById = new Map(balances.map((balance) => [balance.id, Number(balance.qtyOnHand || 0)]));
      if (qtyById.size !== balanceIds.length) fail("Sebagian stock balance sudah tidak tersedia. Buat ulang dokumen opname.", 409);
      await Promise.all(item.details.map((detail) =>
        tx.stockOpnameDetail.update({
          where: { id: detail.id },
          data: {
            systemQty: qtyById.get(detail.stockBalanceId) || 0,
            actualQty: null,
            varianceQty: 0,
            varianceStatus: "MATCH",
            reason: null,
            countedBy: null,
            countedAt: null,
          },
        }),
      ));
      return tx.stockOpnameHeader.update({
        where: { id: item.id },
        data: { status: "COUNTING", inventoryFrozen: true },
        include: { details: { where: { isDeleted: false } } },
      });
    });
    res.json(mapStockOpname(updated));
  } catch (error) { next(error); }
};

exports.countDetail = async (req, res, next) => {
  try {
    const detail = await prisma.stockOpnameDetail.findUnique({ where: { id: req.params.detailId }, include: { header: true } });
    if (!detail || detail.isDeleted) return res.status(404).json({ message: "Detail stock opname tidak ditemukan." });
    if (detail.header.stoNo !== req.params.stoNo) return res.status(409).json({ message: "Detail bukan bagian dari dokumen Stock Opname ini." });
    statusGuard(detail.header.status, "COUNTING");
    const actualQty = Number(req.body?.actualQty);
    const countedBy = counterName(req, false);
    if (!Number.isFinite(actualQty) || actualQty < 0) return res.status(400).json({ message: "actualQty harus berupa angka >= 0." });
    if (!countedBy) return res.status(400).json({ message: "Nama petugas hitung wajib diisi." });
    const result = variance(detail.systemQty, actualQty);
    const updated = await prisma.stockOpnameDetail.update({ where: { id: detail.id }, data: { actualQty, varianceQty: result.value, varianceStatus: result.status, reason: req.body?.reason || null, countedBy, countedAt: new Date() } });
    const { systemQty, varianceQty, varianceAmount, varianceStatus, ...blindDetail } = mapDoc(updated);
    res.json(blindDetail);
  } catch (error) { next(error); }
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
    const actualQty = Number(req.body?.actualQty);
    const countedBy = counterName(req, false);
    if (!stockType) return res.status(400).json({ message: "Jenis stock wajib dipilih." });
    const isMaterial = stockType === "MATERIAL";
    if (isMaterial && (!materialType || !materialIdentity)) return res.status(400).json({ message: "Jenis material dan nama/kode material wajib dipilih." });
    if (!isMaterial && (!partIdentity || !partName)) return res.status(400).json({ message: "Part No/Part Code dan Part Name wajib dipilih." });
    if (!Number.isFinite(actualQty) || actualQty < 0) return res.status(400).json({ message: "Qty hasil hitung harus berupa angka >= 0." });
    if (!countedBy) return res.status(400).json({ message: "Nama petugas hitung wajib diisi." });
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
    const detail = matches[0];
    const result = variance(detail.systemQty, actualQty);
    await prisma.stockOpnameDetail.update({
      where: { id: detail.id },
      data: {
        actualQty,
        varianceQty: result.value,
        varianceStatus: result.status,
        countedBy,
        countedAt: new Date(),
      },
    });
    res.json(mapStockOpname(await findItem(item.stoNo)));
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
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
    const normalized = counts.map((count) => {
      const detail = detailById.get(count.detailId);
      if (!detail) fail(`Detail ${count.detailId || "-"} bukan bagian dari ${item.stoNo}.`, 400);
      const actualQty = Number(count.actualQty);
      if (!Number.isFinite(actualQty) || actualQty < 0) fail("Semua actualQty harus berupa angka >= 0.");
      const result = variance(detail.systemQty, actualQty);
      const countedBy = String(count.countedBy || defaultCountedBy || "").trim();
      if (!countedBy) fail("Nama petugas hitung wajib diisi untuk semua baris.");
      return { detail, actualQty, result, reason: String(count.reason || "").trim() || null, countedBy };
    });
    await prisma.$transaction(normalized.map(({ detail, actualQty, result, reason, countedBy }) =>
      prisma.stockOpnameDetail.update({
        where: { id: detail.id },
        data: {
          actualQty,
          varianceQty: result.value,
          varianceStatus: result.status,
          reason,
          countedBy,
          countedAt: new Date(),
        },
      }),
    ));
    res.json(mapStockOpname(await findItem(item.stoNo)));
  } catch (error) { next(error); }
};

exports.submit = async (req, res, next) => {
  try {
    const item = await prisma.stockOpnameHeader.findUnique({ where: { stoNo: req.params.stoNo }, include: { details: true } });
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    statusGuard(item.status, "COUNTING");
    if (item.details.some((detail) => detail.actualQty == null && !detail.isDeleted)) return res.status(409).json({ message: "Semua detail harus dihitung sebelum diajukan." });
    const result = await prisma.$transaction(async (tx) => {
      const approvalRequest = await submitDocumentForApproval({
        moduleCode: "inventory",
        pageCode: "stock-opname",
        actionCode: "approve",
        documentType: "StockOpnameHeader",
        documentId: item.id,
        documentNumber: item.stoNo,
        context: item,
        requestedByUserId: req.user?.id,
        requestedBy: actor(req),
        tx,
      });
      const updated = await tx.stockOpnameHeader.update({ where: { id: item.id }, data: { status: "WAITING_APPROVAL", checkerBy: actor(req), checkerApprovedAt: new Date() } });
      return { updated, approvalRequest };
    });
    res.json({ ...mapDoc(result.updated), approvalRequest: result.approvalRequest });
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.approve = async (req, res, next) => {
  try {
    const item = await prisma.stockOpnameHeader.findUnique({ where: { stoNo: req.params.stoNo } });
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    statusGuard(item.status, "WAITING_APPROVAL");
    const approver = actor(req);
    if (approver !== "system" && [item.createdBy, item.checkerBy].filter(Boolean).includes(approver)) {
      return res.status(409).json({ message: "Maker/checker tidak boleh menjadi approver Stock Opname yang sama." });
    }
    const updated = await prisma.stockOpnameHeader.update({ where: { id: item.id }, data: { status: "APPROVED", approvedBy: approver, approvedAt: new Date() } });
    res.json(mapDoc(updated));
  } catch (error) { next(error); }
};

exports.requestRecount = async (req, res, next) => {
  try {
    const item = await findItem(req.params.stoNo);
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    statusGuard(item.status, ["WAITING_APPROVAL", "APPROVED"]);
    const reason = String(req.body?.reason || "").trim();
    if (!reason) return res.status(400).json({ message: "Alasan recount wajib diisi." });
    const note = [item.notes, `RECOUNT ${new Date().toISOString()} oleh ${actor(req)}: ${reason}`].filter(Boolean).join("\n");
    const updated = await prisma.stockOpnameHeader.update({
      where: { id: item.id },
      data: {
        status: "COUNTING",
        notes: note,
        checkerBy: null,
        checkerApprovedAt: null,
        approvedBy: null,
        approvedAt: null,
      },
      include: { details: { where: { isDeleted: false } } },
    });
    res.json(mapStockOpname(updated));
  } catch (error) { next(error); }
};

exports.adjust = async (req, res, next) => {
  try {
    const item = await prisma.stockOpnameHeader.findUnique({ where: { stoNo: req.params.stoNo }, include: { details: true } });
    if (!item) return res.status(404).json({ message: "Stock opname tidak ditemukan." });
    statusGuard(item.status, "APPROVED");
    const changed = await prisma.$transaction(async (tx) => {
      const movements = [];
      for (const detail of item.details.filter((row) => !row.isDeleted && Number(row.varianceQty || 0) !== 0)) {
        if (!detail.stockBalanceId) fail(`Detail ${detail.id} tidak memiliki referensi stock balance. Minta recount sebelum posting.`, 409);
        const balance = await tx.stockBalance.findUnique({ where: { id: detail.stockBalanceId } });
        if (!balance || balance.isDeleted) fail(`Stock balance untuk detail ${detail.id} tidak ditemukan.`, 409);
        await assertStockBalanceNotFrozen(tx, balance.id, { allowStoNo: item.stoNo });
        const before = Number(balance.qtyOnHand || 0);
        if (Math.abs(before - Number(detail.systemQty || 0)) > 1e-9) {
          fail(`Saldo ${detail.partCode || detail.description || detail.id} berubah setelah freeze. Minta recount sebelum posting.`, 409);
        }
        const after = Number(detail.actualQty);
        const reserved = Number(balance.qtyReserved || 0);
        const qc = Number(balance.qtyQC || 0);
        await tx.stockBalance.update({ where: { id: balance.id }, data: { qtyOnHand: after, qtyAvailable: Math.max(0, after - reserved - qc), lastMovement: new Date() } });
        const movementNumber = await generateMovementNumber("ADJUSTMENT", tx);
        movements.push(await tx.stockMovement.create({ data: { movementNumber, movementDate: new Date(), movementType: "ADJUSTMENT", direction: Number(detail.varianceQty) < 0 ? "OUT" : "IN", transactionType: "STOCK_OPNAME", warehouseCode: detail.warehouseCode, rackCode: detail.rackCode, lotNumber: detail.lotNumber, partCode: detail.partCode, partNumber: detail.partNumber, partName: detail.partName, productId: detail.productId, description: detail.description, spec: detail.spec, thickness: detail.thickness, width: detail.width, CSP: detail.CSP, stockType: detail.stockType, qty: Math.abs(Number(detail.varianceQty)), deltaQty: Number(detail.varianceQty), qtyBefore: before, qtyAfter: after, adjustmentType: Number(detail.varianceQty) < 0 ? "DECREASE" : "INCREASE", uomCode: detail.uomCode, referenceType: "STOCK_OPNAME", referenceNumber: item.stoNo, notes: detail.reason || item.notes || null, performedBy: actor(req) } }));
        await tx.stockOpnameDetail.update({ where: { id: detail.id }, data: { adjustmentNumber: movementNumber } });
      }
      const updated = await tx.stockOpnameHeader.update({ where: { id: item.id }, data: { status: "ADJUSTED", inventoryFrozen: false, adjustedBy: actor(req), adjustedAt: new Date() }, include: { details: true } });
      return { updated, movements };
    });
    res.json({ ...mapDoc(changed.updated), movements: changed.movements.map(mapDoc) });
  } catch (error) { next(error); }
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
    statusGuard(item.status, ["DRAFT", "COUNTING", "WAITING_APPROVAL"]);
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
