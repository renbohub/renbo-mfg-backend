const { prisma } = require("../../index");
const { mapDoc } = require("../../utils/mapDoc");

const text = (value) => String(value ?? "").trim() || null;
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

const MONTH_NAMES = new Map([
  ["jan", 0], ["january", 0], ["januari", 0],
  ["feb", 1], ["february", 1], ["februari", 1],
  ["mar", 2], ["march", 2], ["maret", 2],
  ["apr", 3], ["april", 3],
  ["may", 4], ["mei", 4],
  ["jun", 5], ["june", 5], ["juni", 5],
  ["jul", 6], ["july", 6], ["juli", 6],
  ["aug", 7], ["august", 7], ["agustus", 7],
  ["sep", 8], ["sept", 8], ["september", 8],
  ["oct", 9], ["okt", 9], ["october", 9], ["oktober", 9],
  ["nov", 10], ["november", 10],
  ["dec", 11], ["des", 11], ["december", 11], ["desember", 11],
]);

const aliases = (source, names) => {
  const keys = Object.keys(source || {});
  for (const name of names) {
    const direct = keys.find((key) => key.toLowerCase().trim() === name);
    if (direct && source[direct] !== undefined && source[direct] !== null && String(source[direct]).trim() !== "") return source[direct];
  }
  return null;
};

function dateMonth(value, fallbackYear = new Date().getFullYear()) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
  const raw = String(value).trim();
  const match = raw.toLowerCase().match(/^([a-z]+)[\s\-]*(\d{4})?$/i);
  const month = MONTH_NAMES.get(match?.[1] || raw.toLowerCase());
  if (match && month !== undefined) return new Date(Date.UTC(Number(match?.[2] || fallbackYear), month, 1));
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime()) && /\d/.test(raw)) return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), 1));
  return null;
}

function normalizeRow(row, fallback = {}) {
  const source = row?.sourceJson || row?.data || row || {};
  const defaultYear = Number(fallback.defaultYear) || new Date().getFullYear();
  const customerCode = text(aliases(source, ["customer code", "customer", "customer_code", "cust code", "cust"] ) || fallback.customerCode);
  const partCode = text(aliases(source, ["part code", "partcode", "part_code", "kode part", "kode internal"]));
  const partNumber = text(aliases(source, ["part number", "part no", "part no.", "partnumber", "part_number", "drawing number", "drawing no"]));
  const partName = text(aliases(source, ["part name", "partname", "part_name", "nama part", "description"]));
  const uomCode = text(aliases(source, ["uom", "unit", "satuan", "uom code"]) || fallback.uomCode);
  const unitPrice = number(aliases(source, ["unit price", "price", "harga", "harga satuan", "price per pcs", "price/pcs"]));
  const notes = text(aliases(source, ["notes", "note", "catatan"]));
  const singleMonth = dateMonth(aliases(source, ["forecast month", "bulan forecast", "forecast_month", "month", "bulan", "period"]), defaultYear);
  const singleQty = number(aliases(source, ["forecast qty", "qty forecast", "forecast", "qty", "quantity"]));
  const periods = [];
  if (singleMonth && singleQty > 0) periods.push({ forecastMonth: singleMonth, forecastQty: singleQty });
  for (const [key, value] of Object.entries(source)) {
    const month = dateMonth(key, defaultYear);
    const qty = number(value);
    if (month && qty > 0 && !periods.some((item) => item.forecastMonth.getTime() === month.getTime())) periods.push({ forecastMonth: month, forecastQty: qty });
  }
  return { customerCode, partCode, partNumber, partName, uomCode, unitPrice, notes, periods };
}

async function buildPreview(rows, fallback = {}) {
  const normalized = rows.map((row) => ({ row, mapped: normalizeRow(row, fallback) }));
  const codes = [...new Set(normalized.map(({ mapped }) => mapped.partCode).filter(Boolean))];
  const numbers = [...new Set(normalized.map(({ mapped }) => mapped.partNumber).filter(Boolean))];
  const parts = (codes.length || numbers.length) ? await prisma.part.findMany({ where: { isDeleted: false, itemType: "FG", OR: [...(codes.length ? [{ partCode: { in: codes } }] : []), ...(numbers.length ? [{ partNumber: { in: numbers } }] : [])] }, select: { id: true, partCode: true, partNumber: true, partName: true, baseUomCode: true, salesUomCode: true, itemType: true } }) : [];
  const byCode = new Map(parts.map((part) => [part.partCode, part]));
  const byNumber = new Map(parts.filter((part) => part.partNumber).map((part) => [part.partNumber, part]));
  const detailRows = [];
  const errors = [];
  for (const { row, mapped } of normalized) {
    const sourceRow = Number(row.rowNumber || 0) || null;
    const part = byCode.get(mapped.partCode) || byNumber.get(mapped.partNumber);
    if (!mapped.customerCode) errors.push({ sheetName: row.sheetName, rowNumber: sourceRow, code: "CUSTOMER_REQUIRED", message: "Customer code wajib tersedia pada row atau fallback import." });
    if (!mapped.partCode && !mapped.partNumber) errors.push({ sheetName: row.sheetName, rowNumber: sourceRow, code: "PART_REQUIRED", message: "Part code internal atau part number drawing wajib tersedia." });
    if ((mapped.partCode || mapped.partNumber) && !part) errors.push({ sheetName: row.sheetName, rowNumber: sourceRow, code: "FG_PART_NOT_FOUND", message: `Part ${mapped.partCode || mapped.partNumber} tidak ditemukan sebagai FG aktif.` });
    if (!mapped.periods.length) errors.push({ sheetName: row.sheetName, rowNumber: sourceRow, code: "FORECAST_PERIOD_REQUIRED", message: "Minimal satu bulan forecast dengan qty > 0 wajib tersedia." });
    if (!part || !mapped.customerCode) continue;
    mapped.periods.forEach((period) => detailRows.push({ sheetName: row.sheetName, rowNumber: sourceRow, customerCode: mapped.customerCode, partId: part.id, partCode: part.partCode, partNumber: part.partNumber, partName: part.partName, uomCode: mapped.uomCode || part.salesUomCode || part.baseUomCode || null, unitPrice: mapped.unitPrice, notes: mapped.notes, ...period }));
  }
  const unique = new Map();
  detailRows.forEach((row) => {
    const key = [row.customerCode, row.partCode, row.forecastMonth.toISOString().slice(0, 10)].join("|");
    const current = unique.get(key);
    if (current) { current.forecastQty += row.forecastQty; current.unitPrice = current.unitPrice || row.unitPrice; current.notes = [current.notes, row.notes].filter(Boolean).join("; ") || null; }
    else unique.set(key, { ...row });
  });
  const items = [...unique.values()];
  const headers = [...items.reduce((map, row) => {
    const group = map.get(row.customerCode) || { customerCode: row.customerCode, details: [] };
    group.details.push(row); map.set(row.customerCode, group); return map;
  }, new Map()).values()].map((group) => ({ ...group, periodStart: new Date(Math.min(...group.details.map((detail) => detail.forecastMonth.getTime()))), periodEnd: new Date(Math.max(...group.details.map((detail) => detail.forecastMonth.getTime()))), totalForecastQty: group.details.reduce((sum, detail) => sum + detail.forecastQty, 0) }));
  return { items, headers, errors };
}

async function nextForecastNumber(tx) {
  const year = new Date().getFullYear(); const prefix = `FCT-${year}-`;
  const rows = await tx.forecast.findMany({ where: { forecastNumber: { startsWith: prefix } }, select: { forecastNumber: true } });
  const max = rows.reduce((value, row) => Math.max(value, Number(row.forecastNumber.slice(prefix.length)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

async function loadBatch(key) {
  const batch = await prisma.excelImportBatch.findFirst({ where: { OR: [{ id: key }, { batchNumber: key }] }, include: { rows: { orderBy: [{ sheetName: "asc" }, { rowNumber: "asc" }] } } });
  if (!batch) throw Object.assign(new Error("Import batch tidak ditemukan."), { statusCode: 404 });
  return batch;
}

exports.preview = async (req, res, next) => {
  try {
    const batch = req.body?.batchKey ? await loadBatch(String(req.body.batchKey)) : null;
    const rows = batch ? batch.rows : (Array.isArray(req.body?.rows) ? req.body.rows : []);
    if (!rows.length) return res.status(400).json({ message: "Minimal satu row staging diperlukan untuk preview forecast." });
    const result = await buildPreview(rows, { customerCode: text(req.body?.customerCode) || text(batch?.metadata?.customerCode), defaultYear: req.body?.defaultYear || batch?.metadata?.defaultYear });
    res.json({
      batchNumber: batch?.batchNumber || null,
      rowCount: rows.length,
      mappedCount: result.items.length,
      errorCount: result.errors.length,
      lines: result.items,
      summary: {
        validLineCount: result.items.length,
        totalForecastQty: result.items.reduce((sum, item) => sum + number(item.forecastQty), 0),
        errorCount: result.errors.length,
      },
      ...result,
    });
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.apply = async (req, res, next) => {
  try {
    const batch = await loadBatch(req.params.key);
    if (batch.status === "APPLIED") return res.json({ idempotent: true, message: "Batch sudah pernah diaplikasikan; tidak ada forecast baru yang dibuat.", batch: mapDoc(batch) });
    if (batch.status !== "APPROVED") return res.status(409).json({ message: "Batch harus berstatus APPROVED sebelum diterapkan ke Forecast." });
    const result = await buildPreview(batch.rows, { customerCode: text(req.body?.customerCode) || text(batch.metadata?.customerCode), defaultYear: req.body?.defaultYear || batch.metadata?.defaultYear });
    if (result.errors.length) return res.status(409).json({ message: "Preview forecast masih memiliki error mapping.", errors: result.errors });
    const created = await prisma.$transaction(async (tx) => {
      const forecasts = [];
      for (const group of result.headers) {
        const forecastNumber = await nextForecastNumber(tx);
        const marker = `[EXCEL-IMPORT:${batch.batchNumber}]`;
        const forecast = await tx.forecast.create({ data: { forecastNumber, forecastName: `Import ${batch.fileName} · ${group.customerCode}`, customerCode: group.customerCode, versionGroup: forecastNumber, version: 1, isCurrentVersion: true, demandBucket: String(req.body?.demandBucket || batch.metadata?.demandBucket || "PLANNING").toUpperCase(), sourceBatchNumber: batch.batchNumber, periodStart: group.periodStart, periodEnd: group.periodEnd, status: "Draft", notes: `${marker}${req.body?.notes ? ` ${text(req.body.notes)}` : ""}`, createdBy: req.user?.username || req.user?.email || "system", details: { create: group.details.map((detail, index) => ({ lineNumber: index + 1, partCode: detail.partCode, partId: detail.partId, uomCode: detail.uomCode, unitPrice: detail.unitPrice, M1Forecast: detail.forecastMonth, M1Qty: detail.forecastQty, M2Forecast: null, M2Qty: 0, M3Forecast: null, M3Qty: 0, notes: detail.notes })) } }, include: { details: true } });
        forecasts.push(forecast);
      }
      await tx.excelImportRow.updateMany({ where: { batchId: batch.id }, data: { status: "APPLIED" } });
      const metadata = { ...(batch.metadata || {}), forecastNumbers: forecasts.map((forecast) => forecast.forecastNumber), mappedCount: result.items.length, appliedAt: new Date().toISOString() };
      const updatedBatch = await tx.excelImportBatch.update({ where: { id: batch.id }, data: { status: "APPLIED", metadata }, include: { rows: true } });
      return { forecasts, batch: updatedBatch };
    });
    res.json({ idempotent: false, forecastCount: created.forecasts.length, forecasts: created.forecasts.map(mapDoc), batch: mapDoc(created.batch) });
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

module.exports = exports;
