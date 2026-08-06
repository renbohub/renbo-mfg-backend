const { prisma } = require("../../index");
const { queueDirtyPartCodes } = require("../../utils/mrpDirtyQueue");
const { replaceDeliveryTargets, assertCompleteDeliveryTargets, markDownstreamDemandChange } = require("../../services/planning/demandDeliveryTargetService");
const { submitDocumentForApproval } = require("../../services/approvalRuleService");

const include = { details: { where: { isDeleted: false, part: { is: { isDeleted: false, itemType: "FG" } } }, orderBy: { lineNumber: "asc" }, include: { part: true, deliveryTargets: { where: { isDeleted: false, status: "ACTIVE" }, orderBy: { phaseNumber: "asc" } } } } };
const text = (value) => String(value ?? "").trim() || null;
const date = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const isGeneratedProcess = (row) => String(row?.notes || "").startsWith("[MRP-PRODUCTION]");

async function nextNumber(tx = prisma) {
  const year = new Date().getFullYear(); const prefix = `FCT-${year}-`;
  const rows = await tx.forecast.findMany({ where: { forecastNumber: { startsWith: prefix } }, select: { forecastNumber: true } });
  const max = rows.reduce((value, row) => Math.max(value, Number(row.forecastNumber.slice(prefix.length)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

// Satu baris berarti satu part pada satu bulan. Kolom M1-M3 lama tetap dipakai
// di storage agar tidak memutus data forecast yang sudah ada.
function detailData(row, index, forecastNumber, part) {
  return {
    forecastNumber, lineNumber: index + 1, partCode: part.partCode, partId: part.id, uomCode: text(row.uomCode),
    unitPrice: number(row.unitPrice),
    M1Forecast: date(row.forecastMonth || row.M1Forecast), M1Qty: number(row.forecastQty ?? row.M1Qty),
    M2Forecast: null, M2Qty: 0, M3Forecast: null, M3Qty: 0, notes: text(row.notes),
  };
}

async function normalizeForecastDetails(rows, tx, customerCode) {
  const selectedCustomerCode = text(customerCode);
  if (!selectedCustomerCode) throw Object.assign(new Error("Customer Forecast wajib dipilih sebelum memilih Part FG."), { statusCode: 400 });
  const normalizedCustomerCode = selectedCustomerCode.toUpperCase();
  const partIds = [...new Set(rows.map((row) => text(row.partId)).filter(Boolean))];
  const partCodes = [...new Set(rows.map((row) => text(row.partCode)).filter(Boolean))];
  const parts = (partIds.length || partCodes.length) ? await tx.part.findMany({
    where: {
      isDeleted: false,
      itemType: "FG",
      OR: [
        ...(partIds.length ? [{ id: { in: partIds } }] : []),
        ...(partCodes.length ? [{ partCode: { in: partCodes } }] : []),
      ],
    },
    select: { id: true, partCode: true, itemType: true, customerCode: true, customerCodes: true },
  }) : [];
  const byId = new Map(parts.map((part) => [part.id, part]));
  const byCode = new Map(parts.map((part) => [part.partCode, part]));
  return rows.map((row, index) => {
    const part = byId.get(text(row.partId)) || byCode.get(text(row.partCode));
    if (!part) {
      throw Object.assign(new Error(`Baris forecast ${index + 1} wajib memilih Part dengan item type FG. Child/WIP/RAW tidak boleh masuk Forecast.`), { statusCode: 400 });
    }
    const linkedCustomers = [part.customerCode, ...(part.customerCodes || [])].map((value) => String(value || "").trim().toUpperCase()).filter(Boolean);
    if (!linkedCustomers.includes(normalizedCustomerCode)) {
      throw Object.assign(new Error(`Baris forecast ${index + 1}: Part ${part.partCode} tidak terikat ke customer ${selectedCustomerCode}.`), { statusCode: 400 });
    }
    if (!text(row.forecastMonth || row.M1Forecast) || number(row.forecastQty ?? row.M1Qty) <= 0) {
      throw Object.assign(new Error(`Baris forecast ${index + 1} wajib memiliki bulan dan qty lebih dari 0.`), { statusCode: 400 });
    }
    return detailData(row, index, null, part);
  });
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

function deriveForecastPeriod(rows = []) {
  const months = toMonthlyRows(rows)
    .map((row) => date(row.forecastMonth))
    .filter(Boolean)
    .sort((a, b) => a - b);
  if (!months.length) throw Object.assign(new Error("Periode Forecast tidak dapat dihitung karena bulan forecast belum diisi."), { statusCode: 400 });
  const first = months[0];
  const last = months[months.length - 1];
  return {
    periodStart: new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1)),
    periodEnd: new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 0)),
  };
}

function serialize(doc) {
  if (!doc) return doc;
  return { ...doc, details: toMonthlyRows(doc.details) };
}

function headerData(body, user) {
  const demandBucket = String(body.demandBucket || "PLANNING").toUpperCase();
  if (!["FIXED", "PLANNING", "UNOFFICIAL"].includes(demandBucket)) throw Object.assign(new Error("Bucket demand harus FIXED, PLANNING, atau UNOFFICIAL."), { statusCode: 400 });
  const periodStart = date(body.periodStart); const periodEnd = date(body.periodEnd);
  if (!periodStart || !periodEnd) throw Object.assign(new Error("Periode Forecast wajib diisi dengan tanggal yang valid."), { statusCode: 400 });
  if (periodStart > periodEnd) throw Object.assign(new Error("Periode mulai tidak boleh melewati periode selesai."), { statusCode: 400 });
  return { forecastName: text(body.forecastName), periodStart, periodEnd, customerCode: text(body.customerCode), demandBucket, sourceBatchNumber: text(body.sourceBatchNumber), status: "Draft", notes: text(body.notes), createdBy: user?.username || user?.email || null };
}

const monthKey = (value) => { const d = date(value); return d && !Number.isNaN(d.getTime()) ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01` : null; };

async function buildConsumptionProgress(forecast) {
  const demand = toMonthlyRows(forecast.details || []);
  const mps = await prisma.mPS.findMany({ where: { forecastNumber: forecast.forecastNumber, isDeleted: false }, include: { details: { where: { isDeleted: false }, select: { partCode: true, customerCode: true, startDate: true, qtyPlanned: true, notes: true } } } });
  const planned = new Map();
  for (const header of mps) for (const row of header.details || []) {
    if (isGeneratedProcess(row)) continue;
    const key = `${row.partCode}|${monthKey(row.startDate)}`;
    planned.set(key, (planned.get(key) || 0) + number(row.qtyPlanned));
  }
  const byMonth = new Map();
  for (const row of demand) {
    const key = monthKey(row.forecastMonth); if (!key) continue;
    const partKey = `${row.partCode}|${key}`;
    const current = byMonth.get(key) || { month: key, forecastQty: 0, plannedQty: 0 };
    current.forecastQty += number(row.forecastQty); current.plannedQty += number(planned.get(partKey)); byMonth.set(key, current);
  }
  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).map((row) => ({ ...row, remainingQty: Math.max(row.forecastQty - row.plannedQty, 0), consumed: row.plannedQty + 0.000001 >= row.forecastQty }));
  return { months, remainingMonths: months.filter((row) => !row.consumed).map((row) => row.month.slice(0, 7)), consumedMonths: months.filter((row) => row.consumed).map((row) => row.month.slice(0, 7)) };
}

async function buildDemandSummary({ forecastNumber = null, startDate = null, endDate = null }) {
  const where = { isDeleted: false, status: { not: "Obsolete" }, ...(forecastNumber ? { forecastNumber } : { isCurrentVersion: true }) };
  const forecasts = await prisma.forecast.findMany({ where, include });
  const rows = forecasts.flatMap((forecast) => toMonthlyRows(forecast.details).map((detail) => ({ forecast, detail }))).filter(({ detail }) => {
    const key = monthKey(detail.forecastMonth); return key && (!startDate || key >= startDate) && (!endDate || key <= endDate);
  });
  const partCodes = [...new Set(rows.map(({ detail }) => detail.partCode))];
  const customers = [...new Set(rows.map(({ forecast }) => forecast.customerCode).filter(Boolean))];
  const sales = partCodes.length ? await prisma.salesOrderDetail.findMany({
    where: { isDeleted: false, partCode: { in: partCodes }, soHeader: { isDeleted: false, status: { in: ["Confirmed", "In Progress", "Ready to Deliver", "Delivered"] }, ...(customers.length ? { customerCode: { in: customers } } : {}) } },
    include: { soHeader: { select: { customerCode: true, soDate: true, deliveryDate: true } }, part: { select: { partName: true, partNumber: true } } },
  }) : [];
  const actual = new Map();
  for (const row of sales) {
    const key = monthKey(row.deliveryDate || row.soHeader.deliveryDate || row.soHeader.soDate); if (!key) continue;
    const group = `${row.soHeader.customerCode || "-"}|${row.partCode}|${key}`;
    const current = actual.get(group) || { qty: 0, revenue: 0 };
    current.qty += number(row.qty); current.revenue += number(row.totalAmount); actual.set(group, current);
  }
  const summary = new Map();
  for (const { forecast, detail } of rows) {
    const month = monthKey(detail.forecastMonth); const group = `${forecast.customerCode || "-"}|${detail.partCode}|${month}`;
    const current = summary.get(group) || { month, customerCode: forecast.customerCode, partCode: detail.partCode, partName: detail.part?.partName || null, partNumber: detail.part?.partNumber || null, uomCode: detail.uomCode, forecastQty: 0, forecastRevenue: 0, forecastNumbers: [], buckets: [] };
    current.forecastQty += number(detail.forecastQty); current.forecastRevenue += number(detail.forecastQty) * number(detail.unitPrice); current.forecastNumbers.push(forecast.forecastNumber); current.buckets.push(forecast.demandBucket); summary.set(group, current);
  }
  return [...summary.values()].map((row) => {
    const actualRow = actual.get(`${row.customerCode || "-"}|${row.partCode}|${row.month}`) || { qty: 0, revenue: 0 };
    return { ...row, forecastNumbers: [...new Set(row.forecastNumbers)], buckets: [...new Set(row.buckets)], actualSalesOrderQty: actualRow.qty, actualRevenue: actualRow.revenue, qtyVariance: actualRow.qty - row.forecastQty, revenueVariance: actualRow.revenue - row.forecastRevenue };
  }).sort((a, b) => `${a.month}|${a.customerCode}|${a.partCode}`.localeCompare(`${b.month}|${b.customerCode}|${b.partCode}`));
}

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(number(req.query.page) || 1, 1); const limit = Math.min(Math.max(number(req.query.limit) || 20, 1), 500); const q = text(req.query.q || req.query.search); const status = text(req.query.status);
    const where = { isDeleted: false, ...(status ? { status } : {}), ...(q ? { OR: [{ forecastNumber: { contains: q, mode: "insensitive" } }, { forecastName: { contains: q, mode: "insensitive" } }, { customerCode: { contains: q, mode: "insensitive" } }, { status: { contains: q, mode: "insensitive" } }] } : {}) };
    const [items, total] = await Promise.all([prisma.forecast.findMany({ where, include, orderBy: { periodStart: "desc" }, skip: (page - 1) * limit, take: limit }), prisma.forecast.count({ where })]);
    const mapped = await Promise.all(items.map(async (item) => ({ ...item, totalForecastQty: toMonthlyRows(item.details).reduce((sum, row) => sum + row.forecastQty, 0), partCount: new Set(item.details.map((row) => row.partCode)).size, itemScope: "FG ONLY", consumption: await buildConsumptionProgress(item) })));
    res.json({ items: mapped, total, page, limit });
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.get = async (req, res, next) => {
  try {
    const doc = await prisma.forecast.findFirst({ where: { forecastNumber: req.params.forecastNumber, isDeleted: false }, include });
    if (!doc) return res.status(404).json({ message: "Forecast tidak ditemukan" });
    res.json({ ...serialize(doc), consumption: await buildConsumptionProgress(doc) });
  } catch (error) { next(error); }
};

exports.demandSummary = async (req, res, next) => {
  try {
    const items = await buildDemandSummary({ forecastNumber: text(req.query.forecastNumber), startDate: text(req.query.startDate), endDate: text(req.query.endDate) });
    res.json({ items, total: items.length, summary: { forecastQty: items.reduce((sum, row) => sum + row.forecastQty, 0), actualSalesOrderQty: items.reduce((sum, row) => sum + row.actualSalesOrderQty, 0), forecastRevenue: items.reduce((sum, row) => sum + row.forecastRevenue, 0), actualRevenue: items.reduce((sum, row) => sum + row.actualRevenue, 0) } });
  } catch (error) { next(error); }
};

exports.monthlyConsumption = async (req, res, next) => {
  try {
    const detailRows = await buildDemandSummary({ startDate: text(req.query.startDate), endDate: text(req.query.endDate) });
    const months = new Map();
    for (const row of detailRows) {
      const item = months.get(row.month) || { month: row.month, forecastQty: 0, actualSalesOrderQty: 0, effectiveDemandQty: 0, forecastNumbers: new Set(), customerCodes: new Set(), partCodes: new Set() };
      item.forecastQty += number(row.forecastQty);
      item.actualSalesOrderQty += number(row.actualSalesOrderQty);
      item.effectiveDemandQty += Math.max(number(row.forecastQty), number(row.actualSalesOrderQty));
      row.forecastNumbers.forEach((value) => item.forecastNumbers.add(value));
      if (row.customerCode) item.customerCodes.add(row.customerCode);
      if (row.partCode) item.partCodes.add(row.partCode);
      months.set(row.month, item);
    }
    const monthKeys = [...months.keys()];
    const mpsRows = monthKeys.length ? await prisma.mPS.findMany({
      where: { sourceKey: { in: monthKeys.map((month) => `MONTH:${month.slice(0, 7)}`) }, isDeleted: false },
      include: { deliveryPlans: { where: { isDeleted: false, targetType: "CUSTOMER", lockedBySource: true }, orderBy: { plannedDate: "asc" } } },
    }) : [];
    const mpsByMonth = new Map(mpsRows.map((row) => [monthKey(row.periodStart), row]));
    const items = [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map((row) => {
      const mps = mpsByMonth.get(row.month);
      return { ...row, forecastNumbers: [...row.forecastNumbers], customerCodes: [...row.customerCodes], partCodes: [...row.partCodes], forecastCount: row.forecastNumbers.size, customerCount: row.customerCodes.size, partCount: row.partCodes.size, mpsNumber: mps?.mpsNumber || null, mpsStatus: mps?.status || "Belum dihitung", replanRequired: Boolean(mps?.replanRequired), replanReason: mps?.replanReason || null, earliestDeliveryDate: mps?.deliveryPlans?.[0]?.plannedDate || null, deliveryPhaseCount: mps?.deliveryPlans?.length || 0 };
    });
    res.json({ items, total: items.length });
  } catch (error) { next(error); }
};

exports.generateNumber = async (_req, res, next) => { try { res.json({ forecastNumber: await nextNumber() }); } catch (error) { next(error); } };

exports.create = async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body.details) ? req.body.details : [];
    if (!rows.length) return res.status(400).json({ message: "Minimal satu baris forecast wajib diisi" });
    if (rows.some((row) => !row.partCode || !row.forecastMonth)) return res.status(400).json({ message: "Part dan bulan forecast wajib diisi pada setiap baris" });
    const doc = await prisma.$transaction(async (tx) => {
      const forecastNumber = text(req.body.forecastNumber) || await nextNumber(tx);
      const details = await normalizeForecastDetails(rows, tx, req.body.customerCode);
      details.forEach((row) => { row.forecastNumber = forecastNumber; });
      const created = await tx.forecast.create({ data: { forecastNumber, versionGroup: text(req.body.versionGroup) || forecastNumber, version: 1, isCurrentVersion: true, ...headerData({ ...req.body, ...deriveForecastPeriod(details) }, req.user), details: { create: details.map(({ forecastNumber: _parent, ...row }) => row) } }, include });
      await replaceDeliveryTargets(tx, { sourceType: "FORECAST", sourceNumber: forecastNumber, customerCode: text(req.body.customerCode), lines: created.details, inputRows: rows, user: req.user?.username || req.user?.email });
      await queueDirtyPartCodes(tx, details.map((row) => row.partCode), {
        reason: "FORECAST",
        sourceNumber: forecastNumber,
        notes: "Forecast dibuat/diubah; net-change MRP dijadwalkan.",
      });
      return tx.forecast.findUnique({ where: { forecastNumber }, include });
    });
    res.status(201).json(serialize(doc));
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.update = async (req, res, next) => {
  try {
    const existing = await prisma.forecast.findFirst({ where: { forecastNumber: req.params.forecastNumber, isDeleted: false }, include: { details: { where: { isDeleted: false }, select: { partCode: true, M1Forecast: true, M1Qty: true, M2Forecast: true, M2Qty: true, M3Forecast: true, M3Qty: true, deliveryTargets: { where: { isDeleted: false } } } } } });
    if (!existing) return res.status(404).json({ message: "Forecast tidak ditemukan" });
    if (existing.status !== "Draft") return res.status(409).json({ message: `Forecast ${existing.forecastNumber} sudah ${existing.status} dan tidak dapat diedit. Gunakan workflow revisi.` });
    const doc = await prisma.$transaction(async (tx) => {
      const rows = Array.isArray(req.body.details) ? req.body.details : null;
      let periodDetails = existing.details;
      if (rows) {
        if (!rows.length || rows.some((row) => !row.partCode || !row.forecastMonth)) throw Object.assign(new Error("Part dan bulan forecast wajib diisi pada setiap baris"), { statusCode: 400 });
        await tx.forecastDetail.deleteMany({ where: { forecastNumber: existing.forecastNumber } });
        const details = await normalizeForecastDetails(rows, tx, req.body.customerCode || existing.customerCode);
        details.forEach((row) => { row.forecastNumber = existing.forecastNumber; });
        await tx.forecastDetail.createMany({ data: details });
        const createdLines = await tx.forecastDetail.findMany({ where: { forecastNumber: existing.forecastNumber, isDeleted: false }, orderBy: { lineNumber: "asc" } });
        periodDetails = createdLines;
        await replaceDeliveryTargets(tx, { sourceType: "FORECAST", sourceNumber: existing.forecastNumber, customerCode: text(req.body.customerCode || existing.customerCode), lines: createdLines, inputRows: rows, user: req.user?.username || req.user?.email, trackChange: true, previousTargets: existing.details.flatMap((row) => row.deliveryTargets || []), impactSourceNumbers: [existing.forecastNumber, existing.revisionOfForecastNumber] });
      } else {
        await normalizeForecastDetails(existing.details, tx, req.body.customerCode || existing.customerCode);
      }
      const data = headerData({ ...existing, ...req.body, ...deriveForecastPeriod(periodDetails) }, req.user); delete data.createdBy;
      const updated = await tx.forecast.update({ where: { forecastNumber: existing.forecastNumber }, data, include });
      await queueDirtyPartCodes(tx, [
        ...existing.details.map((row) => row.partCode),
        ...updated.details.map((row) => row.partCode),
      ], {
        reason: "FORECAST",
        sourceNumber: existing.forecastNumber,
        notes: "Forecast dibuat/diubah; net-change MRP dijadwalkan.",
      });
      return updated;
    });
    res.json(serialize(doc));
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

// Forecast revisions are versioned copies. The original forecast remains
// available for audit/MPS traceability while the new version starts as Draft.
exports.revise = async (req, res, next) => {
  try {
    const reason = text(req.body?.reason);
    if (!reason) return res.status(400).json({ message: "Alasan revisi Forecast wajib diisi." });
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.forecast.findFirst({
        where: { forecastNumber: req.params.forecastNumber, isDeleted: false },
        include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" }, include: { deliveryTargets: { where: { isDeleted: false, status: "ACTIVE" }, orderBy: { phaseNumber: "asc" } } } } },
      });
      if (!existing) throw Object.assign(new Error("Forecast tidak ditemukan"), { statusCode: 404 });
      if (!["Draft", "Confirmed", "Partial Product", "Consumed"].includes(existing.status)) {
        throw Object.assign(new Error(`Forecast berstatus ${existing.status} tidak dapat direvisi.`), { statusCode: 409 });
      }
      const forecastNumber = await nextNumber(tx);
      const revisionNumber = number(existing.revisionNumber) + 1;
      const notes = [existing.notes, `Revisi dari ${existing.forecastNumber}: ${reason}`].filter(Boolean).join("; ");
      const details = existing.details.map((row, index) => ({
        forecastNumber,
        lineNumber: index + 1,
        partCode: row.partCode,
        partId: row.partId,
        uomCode: row.uomCode,
        unitPrice: number(row.unitPrice),
        M1Forecast: row.M1Forecast,
        M1Qty: number(row.M1Qty),
        M2Forecast: row.M2Forecast,
        M2Qty: number(row.M2Qty),
        M3Forecast: row.M3Forecast,
        M3Qty: number(row.M3Qty),
        notes: row.notes,
      }));
      const created = await tx.forecast.create({
        data: {
          forecastNumber,
          ...headerData({ ...existing, ...deriveForecastPeriod(details), status: "Draft", notes }, req.user),
          versionGroup: existing.versionGroup || existing.forecastNumber,
          version: number(existing.version) + 1,
          isCurrentVersion: true,
          revisionOfForecastNumber: existing.forecastNumber,
          revisionNumber,
          revisionReason: reason,
          approvedBy: null,
          approvedDate: null,
          details: { create: details.map(({ forecastNumber: _parent, ...row }) => row) },
        },
        include,
      });
      await replaceDeliveryTargets(tx, { sourceType: "FORECAST", sourceNumber: forecastNumber, customerCode: existing.customerCode, lines: created.details, inputRows: existing.details.map((row) => ({ forecastMonth: row.M1Forecast, forecastQty: row.M1Qty, deliveryTargets: row.deliveryTargets })), user: req.user?.username || req.user?.email });
      await tx.forecast.update({
        where: { forecastNumber: existing.forecastNumber },
        data: {
          status: "Superseded",
          isCurrentVersion: false,
          notes: [existing.notes, `Digantikan oleh ${forecastNumber}: ${reason}`].filter(Boolean).join("; "),
        },
      });
      await markDownstreamDemandChange(tx, {
        sourceType: "FORECAST",
        sourceNumbers: [existing.forecastNumber],
        reason: `Forecast ${existing.forecastNumber} direvisi menjadi ${forecastNumber}; MPS, MRP, dan Purchase Suggestion wajib dihitung ulang.`,
        user: req.user?.username || req.user?.email,
        changeType: "FORECAST_REVISION",
      });
      await queueDirtyPartCodes(tx, details.map((row) => row.partCode), {
        reason: "FORECAST",
        sourceNumber: forecastNumber,
        notes: `Revisi ${existing.forecastNumber} dibuat; net-change MRP dijadwalkan.`,
      });
      const revised = await tx.forecast.findUnique({ where: { forecastNumber }, include });
      return { ...serialize(revised), previousForecastNumber: existing.forecastNumber };
    });
    res.status(201).json(result);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

// Draft forecast must be explicitly submitted before PPIC can consume it.
// Submission is intentionally separate from edit so the audit log captures
// the business transition and accidental status changes cannot bypass it.
exports.submit = async (req, res, next) => {
  try {
    const forecastNumber = text(req.params.forecastNumber);
    const forecast = await prisma.forecast.findFirst({
      where: { forecastNumber, isDeleted: false },
      include: { details: { where: { isDeleted: false } } },
    });
    if (!forecast) return res.status(404).json({ message: "Forecast tidak ditemukan" });
    if (forecast.status !== "Draft") return res.status(409).json({ message: `Forecast hanya dapat di-submit dari Draft. Status saat ini ${forecast.status}.` });
    if (!forecast.periodStart || !forecast.periodEnd || forecast.periodStart > forecast.periodEnd) return res.status(400).json({ message: "Periode Forecast belum valid." });
    const monthlyDetails = toMonthlyRows(forecast.details);
    if (!monthlyDetails.length || monthlyDetails.some((row) => !row.partCode || Number(row.forecastQty || 0) <= 0 || !row.forecastMonth)) return res.status(400).json({ message: "Forecast harus memiliki minimal satu part FG dengan bulan dan qty lebih dari 0." });
    await assertCompleteDeliveryTargets(prisma, "FORECAST", forecastNumber, forecast.details);
    const totalForecastQty = monthlyDetails.reduce((sum, row) => sum + number(row.forecastQty), 0);
    const result = await prisma.$transaction(async (tx) => {
      const approvalRequest = await submitDocumentForApproval({
        moduleCode: "sales",
        pageCode: "forecasts",
        actionCode: "approve",
        documentType: "Forecast",
        documentId: forecast.id,
        documentNumber: forecast.forecastNumber,
        amount: totalForecastQty,
        context: { ...forecast, totalForecastQty },
        requestedByUserId: req.user?.id,
        requestedBy: req.user?.username || req.user?.email,
        tx,
      });
      const updated = await tx.forecast.update({
        where: { forecastNumber },
        data: {
          status: "Submitted",
          approvedBy: null,
          approvedDate: null,
          notes: [forecast.notes, `Submitted for approval by ${req.user?.username || req.user?.email || "system"}`].filter(Boolean).join("; ") || null,
        },
        include,
      });
      return { updated, approvalRequest };
    });
    res.json({ ...serialize(result.updated), approvalRequest: result.approvalRequest });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

exports.approve = async (req, res, next) => {
  try {
    const forecastNumber = text(req.params.forecastNumber);
    const forecast = await prisma.forecast.findFirst({ where: { forecastNumber, isDeleted: false } });
    if (!forecast) return res.status(404).json({ message: "Forecast tidak ditemukan" });
    if (forecast.status !== "Submitted") return res.status(409).json({ message: `Forecast hanya dapat di-approve dari Submitted. Status saat ini ${forecast.status}.` });
    const updated = await prisma.forecast.update({
      where: { forecastNumber },
      data: {
        status: "Confirmed",
        approvedBy: req.user?.username || req.user?.email || "system",
        approvedDate: new Date(),
      },
      include,
    });
    res.json({ ...serialize(updated), approvalRequest: req.approval?.request || null });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

// Closing a forecast is an explicit business decision.  It is only allowed
// when every outstanding SO bucket is covered by MPS quantities; a partial
// forecast remains re-consumable with status "Partial Product".
exports.close = async (req, res, next) => {
  try {
    const forecastNumber = text(req.params.forecastNumber);
    const forecast = await prisma.forecast.findFirst({ where: { forecastNumber, isDeleted: false }, include: { details: { where: { isDeleted: false }, include: { part: true } } } });
    if (!forecast) return res.status(404).json({ message: "Forecast tidak ditemukan" });
    if (!["Partial Product", "Consumed"].includes(forecast.status)) return res.status(409).json({ message: `Forecast hanya dapat ditutup setelah consume/produksi parsial. Status saat ini ${forecast.status}.` });
    const mpsRows = await prisma.mPS.findMany({ where: { forecastNumber, isDeleted: false }, include: { details: { where: { isDeleted: false } } } });
    const plannedByBucket = new Map();
    for (const mps of mpsRows) for (const detail of mps.details || []) {
      if (isGeneratedProcess(detail)) continue;
      const key = `${detail.partCode}|${monthKey(detail.startDate)}`;
      plannedByBucket.set(key, (plannedByBucket.get(key) || 0) + number(detail.qtyPlanned));
    }
    const partCodes = [...new Set(forecast.details.map((row) => row.partCode).filter(Boolean))];
    const sales = partCodes.length ? await prisma.salesOrderDetail.findMany({ where: { isDeleted: false, partCode: { in: partCodes }, soHeader: { isDeleted: false, status: { in: ["Confirmed", "In Progress", "Ready to Deliver"] } } }, select: { partCode: true, qty: true, qtyDelivered: true, deliveryDate: true, soHeader: { select: { customerCode: true, soDate: true, deliveryDate: true } } } }) : [];
    const blockers = [];
    for (const sale of sales) {
      const bucketDate = sale.deliveryDate || sale.soHeader?.deliveryDate || sale.soHeader?.soDate;
      const key = `${sale.partCode}|${monthKey(bucketDate)}`;
      const outstanding = Math.max(number(sale.qty) - number(sale.qtyDelivered), 0);
      if (outstanding > 0 && number(plannedByBucket.get(key)) + 0.000001 < outstanding) blockers.push({ partCode: sale.partCode, month: monthKey(bucketDate), outstandingSoQty: outstanding, plannedQty: number(plannedByBucket.get(key)) });
    }
    if (blockers.length) return res.status(409).json({ message: "Forecast tidak dapat ditutup karena masih kurang dari outstanding SO aktual.", code: "SO_COVERAGE_REQUIRED", blockers });
    const updated = await prisma.forecast.update({ where: { forecastNumber }, data: { status: "Closed", notes: [forecast.notes, `Closed by ${req.user?.username || req.user?.email || "system"}`].filter(Boolean).join("; ") } });
    res.json(updated);
  } catch (error) { next(error); }
};

exports.remove = async (req, res, next) => {
  try {
    const doc = await prisma.forecast.findFirst({ where: { forecastNumber: req.params.forecastNumber, isDeleted: false }, include: { details: { where: { isDeleted: false }, select: { partCode: true } } } });
    if (!doc) return res.status(404).json({ message: "Forecast tidak ditemukan" });
    await prisma.$transaction(async (tx) => {
      await tx.forecast.update({ where: { forecastNumber: doc.forecastNumber }, data: { isDeleted: true, details: { updateMany: { where: {}, data: { isDeleted: true } } } } });
      await queueDirtyPartCodes(tx, doc.details.map((row) => row.partCode), {
        reason: "FORECAST",
        sourceNumber: doc.forecastNumber,
        notes: "Forecast dihapus; net-change MRP dijadwalkan.",
      });
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
};
