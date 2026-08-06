const crypto = require("crypto");
const { prisma } = require("../../index");
const { mapDoc } = require("../../utils/mapDoc");
const { parseWorkbookUpload } = require("../../services/system/excelWorkbookImportService");

const text = (value) => String(value ?? "").trim();
const rowError = (row) => {
  if (!row || typeof row !== "object" || Array.isArray(row)) return { code: "ROW_NOT_OBJECT", message: "sourceJson harus berupa object." };
  if (!text(row.sheetName)) return { code: "SHEET_REQUIRED", message: "sheetName wajib diisi." };
  if (!Number.isInteger(Number(row.rowNumber)) || Number(row.rowNumber) < 1) return { code: "ROW_NUMBER_REQUIRED", message: "rowNumber harus berupa integer >= 1." };
  if (!row.sourceJson || typeof row.sourceJson !== "object" || Array.isArray(row.sourceJson)) return { code: "SOURCE_REQUIRED", message: "sourceJson wajib berupa object." };
  if (Object.keys(row.sourceJson).length === 0) return { code: "SOURCE_EMPTY", message: "sourceJson tidak boleh kosong." };
  return null;
};

async function generateBatchNumber(tx) {
  const prefix = `IMP-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-`;
  const last = await tx.excelImportBatch.findFirst({ where: { batchNumber: { startsWith: prefix } }, orderBy: { batchNumber: "desc" }, select: { batchNumber: true } });
  const next = last?.batchNumber ? Number(last.batchNumber.split("-").pop()) + 1 : 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
}

function normalizeRows(rows = []) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => {
    const normalized = { sheetName: text(row?.sheetName), rowNumber: Number(row?.rowNumber || index + 1), sourceJson: row?.sourceJson || row?.data || row };
    const error = rowError(normalized);
    return { ...normalized, status: error ? "ERROR" : "VALID", errorCode: error?.code || null, errorMessage: error?.message || null };
  });
}

exports.preview = async (req, res) => {
  const rows = normalizeRows(req.body?.rows);
  res.json({ fileName: text(req.body?.fileName), fileType: text(req.body?.fileType || "xlsx"), rowCount: rows.length, errorCount: rows.filter((row) => row.status === "ERROR").length, rows });
};

exports.uploadPreview = async (req, res, next) => {
  try {
    const parsed = parseWorkbookUpload(req.file);
    const rows = normalizeRows(parsed.rows);
    res.json({
      ...parsed,
      rowCount: rows.length,
      errorCount: rows.filter((row) => row.status === "ERROR").length,
      rows,
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1)); const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20))); const q = text(req.query.q);
    const where = q ? { OR: [{ batchNumber: { contains: q, mode: "insensitive" } }, { fileName: { contains: q, mode: "insensitive" } }, { sourcePeriod: { contains: q, mode: "insensitive" } }] } : {};
    const [items, total] = await Promise.all([prisma.excelImportBatch.findMany({ where, include: { _count: { select: { rows: true } } }, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }), prisma.excelImportBatch.count({ where })]);
    res.json({ items: items.map((item) => mapDoc({ ...item, rowCount: item.rowCount || item._count?.rows || 0 })), total, page, limit });
  } catch (error) { next(error); }
};

exports.get = async (req, res, next) => {
  try {
    const item = await prisma.excelImportBatch.findFirst({ where: { OR: [{ id: req.params.key }, { batchNumber: req.params.key }] }, include: { rows: { orderBy: [{ sheetName: "asc" }, { rowNumber: "asc" }] } } });
    if (!item) return res.status(404).json({ message: "Import batch tidak ditemukan." });
    res.json(mapDoc(item));
  } catch (error) { next(error); }
};

exports.create = async (req, res, next) => {
  try {
    const fileName = text(req.body?.fileName); const fileType = text(req.body?.fileType || "xlsx").toLowerCase(); const importType = text(req.body?.importType || "FORECAST").toUpperCase(); const rows = normalizeRows(req.body?.rows);
    if (!fileName) return res.status(400).json({ message: "fileName wajib diisi." });
    if (!rows.length) return res.status(400).json({ message: "Minimal satu row diperlukan untuk import staging." });
    const errorCount = rows.filter((row) => row.status === "ERROR").length;
    if (!["FORECAST", "SALES_HISTORY", "MATERIAL_DEMAND_HISTORY"].includes(importType)) return res.status(400).json({ message: "importType tidak didukung." });
    const sourceChecksum = text(req.body?.sourceChecksum) || crypto.createHash("sha256").update(JSON.stringify({ fileName, fileType, importType, rows })).digest("hex");
    const existing = await prisma.excelImportBatch.findFirst({
      where: { sourceChecksum, fileType, importType, status: { in: ["VALIDATED", "VALIDATION_ERROR", "APPROVED", "APPLIED"] } },
      include: { rows: { orderBy: [{ sheetName: "asc" }, { rowNumber: "asc" }] } },
    });
    if (existing) return res.json({ ...mapDoc(existing), idempotent: true });
    const item = await prisma.$transaction(async (tx) => {
      const batchNumber = await generateBatchNumber(tx);
      return tx.excelImportBatch.create({ data: { batchNumber, fileName, fileType, importType, sourceChecksum, sourcePeriod: text(req.body?.sourcePeriod) || null, status: errorCount ? "VALIDATION_ERROR" : "VALIDATED", rowCount: rows.length, errorCount, metadata: req.body?.metadata || null, notes: text(req.body?.notes) || null, createdBy: req.user?.username || req.user?.email || "system", rows: { create: rows.map((row) => ({ sheetName: row.sheetName, rowNumber: row.rowNumber, sourceJson: row.sourceJson, mappedJson: row.mappedJson || null, status: row.status, errorCode: row.errorCode, errorMessage: row.errorMessage })) } }, include: { rows: true } });
    });
    res.status(201).json(mapDoc(item));
  } catch (error) { next(error); }
};

exports.approve = async (req, res, next) => {
  try {
    const item = await prisma.excelImportBatch.findFirst({ where: { OR: [{ id: req.params.key }, { batchNumber: req.params.key }] } });
    if (!item) return res.status(404).json({ message: "Import batch tidak ditemukan." });
    if (item.status !== "VALIDATED") return res.status(409).json({ message: "Hanya batch VALIDATED yang dapat disetujui; selesaikan error row terlebih dahulu." });
    const updated = await prisma.excelImportBatch.update({ where: { id: item.id }, data: { status: "APPROVED", approvedBy: req.user?.username || req.user?.email || "system", approvedAt: new Date() } });
    res.json(mapDoc(updated));
  } catch (error) { next(error); }
};

module.exports = exports;
