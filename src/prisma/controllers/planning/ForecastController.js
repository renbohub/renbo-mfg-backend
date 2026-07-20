const { prisma } = require("../../index");

const include = { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" }, include: { part: true } } };
const text = (value) => String(value ?? "").trim() || null;
const date = (value) => value ? new Date(value) : null;
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

async function nextNumber(tx = prisma) {
  const year = new Date().getFullYear(); const prefix = `FCT-${year}-`;
  const rows = await tx.forecast.findMany({ where: { forecastNumber: { startsWith: prefix } }, select: { forecastNumber: true } });
  const max = rows.reduce((value, row) => Math.max(value, Number(row.forecastNumber.slice(prefix.length)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

// Satu baris berarti satu part pada satu bulan. Kolom M1-M3 lama tetap dipakai
// di storage agar tidak memutus data forecast yang sudah ada.
function detailData(row, index, forecastNumber) {
  return {
    forecastNumber, lineNumber: index + 1, partCode: text(row.partCode), partId: text(row.partId), uomCode: text(row.uomCode),
    M1Forecast: date(row.forecastMonth || row.M1Forecast), M1Qty: number(row.forecastQty ?? row.M1Qty),
    M2Forecast: null, M2Qty: 0, M3Forecast: null, M3Qty: 0, notes: text(row.notes),
  };
}

function toMonthlyRows(rows = []) {
  return rows.flatMap((row) => {
    const periods = [
      [row.M1Forecast, row.M1Qty], [row.M2Forecast, row.M2Qty], [row.M3Forecast, row.M3Qty],
    ].filter(([month, qty]) => month || number(qty) !== 0);
    return periods.map(([forecastMonth, forecastQty], index) => ({
      ...row, id: periods.length === 1 ? row.id : `${row.id}-${index + 1}`,
      forecastMonth, forecastQty: number(forecastQty), M1Forecast: undefined, M1Qty: undefined,
      M2Forecast: undefined, M2Qty: undefined, M3Forecast: undefined, M3Qty: undefined,
    }));
  });
}

function serialize(doc) {
  if (!doc) return doc;
  return { ...doc, details: toMonthlyRows(doc.details) };
}

function headerData(body, user) {
  return { forecastName: text(body.forecastName), periodStart: date(body.periodStart), periodEnd: date(body.periodEnd), customerCode: text(body.customerCode), status: text(body.status) || "Draft", notes: text(body.notes), createdBy: user?.username || user?.email || null };
}

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(number(req.query.page) || 1, 1); const limit = Math.min(Math.max(number(req.query.limit) || 20, 1), 500); const q = text(req.query.q || req.query.search);
    const where = { isDeleted: false, ...(q ? { OR: [{ forecastNumber: { contains: q, mode: "insensitive" } }, { forecastName: { contains: q, mode: "insensitive" } }, { customerCode: { contains: q, mode: "insensitive" } }, { status: { contains: q, mode: "insensitive" } }] } : {}) };
    const [items, total] = await Promise.all([prisma.forecast.findMany({ where, include, orderBy: { periodStart: "desc" }, skip: (page - 1) * limit, take: limit }), prisma.forecast.count({ where })]);
    res.json({ items: items.map((item) => ({ ...item, totalForecastQty: toMonthlyRows(item.details).reduce((sum, row) => sum + row.forecastQty, 0), partCount: new Set(item.details.map((row) => row.partCode)).size })), total, page, limit });
  } catch (error) { next(error); }
};

exports.get = async (req, res, next) => {
  try {
    const doc = await prisma.forecast.findFirst({ where: { forecastNumber: req.params.forecastNumber, isDeleted: false }, include });
    if (!doc) return res.status(404).json({ message: "Forecast tidak ditemukan" });
    res.json(serialize(doc));
  } catch (error) { next(error); }
};

exports.generateNumber = async (_req, res, next) => { try { res.json({ forecastNumber: await nextNumber() }); } catch (error) { next(error); } };

exports.create = async (req, res, next) => {
  try {
    if (!req.body.periodStart || !req.body.periodEnd) return res.status(400).json({ message: "Periode Forecast wajib diisi" });
    const rows = Array.isArray(req.body.details) ? req.body.details : [];
    if (!rows.length) return res.status(400).json({ message: "Minimal satu baris forecast wajib diisi" });
    if (rows.some((row) => !row.partCode || !row.forecastMonth)) return res.status(400).json({ message: "Part dan bulan forecast wajib diisi pada setiap baris" });
    const doc = await prisma.$transaction(async (tx) => {
      const forecastNumber = text(req.body.forecastNumber) || await nextNumber(tx);
      const details = rows.map((row, index) => detailData(row, index, forecastNumber));
      return tx.forecast.create({ data: { forecastNumber, ...headerData(req.body, req.user), details: { create: details.map(({ forecastNumber: _parent, ...row }) => row) } }, include });
    });
    res.status(201).json(serialize(doc));
  } catch (error) { next(error); }
};

exports.update = async (req, res, next) => {
  try {
    const existing = await prisma.forecast.findFirst({ where: { forecastNumber: req.params.forecastNumber, isDeleted: false } });
    if (!existing) return res.status(404).json({ message: "Forecast tidak ditemukan" });
    const doc = await prisma.$transaction(async (tx) => {
      const rows = Array.isArray(req.body.details) ? req.body.details : null;
      if (rows) {
        if (!rows.length || rows.some((row) => !row.partCode || !row.forecastMonth)) throw new Error("Part dan bulan forecast wajib diisi pada setiap baris");
        await tx.forecastDetail.deleteMany({ where: { forecastNumber: existing.forecastNumber } });
        await tx.forecastDetail.createMany({ data: rows.map((row, index) => detailData(row, index, existing.forecastNumber)) });
      }
      const data = headerData({ ...existing, ...req.body }, req.user); delete data.createdBy;
      return tx.forecast.update({ where: { forecastNumber: existing.forecastNumber }, data, include });
    });
    res.json(serialize(doc));
  } catch (error) { next(error); }
};

exports.remove = async (req, res, next) => {
  try {
    const doc = await prisma.forecast.findFirst({ where: { forecastNumber: req.params.forecastNumber, isDeleted: false } });
    if (!doc) return res.status(404).json({ message: "Forecast tidak ditemukan" });
    await prisma.forecast.update({ where: { forecastNumber: doc.forecastNumber }, data: { isDeleted: true, details: { updateMany: { where: {}, data: { isDeleted: true } } } } });
    res.json({ ok: true });
  } catch (error) { next(error); }
};
