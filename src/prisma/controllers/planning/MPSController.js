const { prisma } = require("../../index");

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const text = (value) => String(value ?? "").trim() || null;
const date = (value) => value ? new Date(value) : null;
const include = { details: { where: { isDeleted: false }, orderBy: [{ startDate: "asc" }, { lineNumber: "asc" }], include: { part: true, forecastDetail: true, mbom: true } } };
const GENERATED_PROCESS_PREFIX = "[MRP-PRODUCTION]";
const FG_RECEIPT_PREFIX = "[FG-RECEIPT]";
const isGeneratedProcess = (row) => String(row?.notes || "").startsWith(GENERATED_PROCESS_PREFIX);

async function nextNumber(tx = prisma) {
  const year = new Date().getFullYear(); const prefix = `MPS-${year}-`;
  const rows = await tx.mPS.findMany({ where: { mpsNumber: { startsWith: prefix } }, select: { mpsNumber: true } });
  const max = rows.reduce((value, row) => Math.max(value, Number(row.mpsNumber.slice(prefix.length)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

function monthEnd(value) { const d = new Date(value); return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function monthKey(value) { const d = new Date(value); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
function forecastPeriods(row) {
  return [[row.M1Forecast, row.M1Qty, 1], [row.M2Forecast, row.M2Qty, 2], [row.M3Forecast, row.M3Qty, 3]]
    .filter(([month, qty]) => month && number(qty) > 0)
    .map(([month, qty, offset]) => ({ month: new Date(month), qty: number(qty), offset }));
}

const OPEN_SO_HEADER_STATUSES = ["Confirmed", "In Progress", "In Production", "Ready to Deliver"];
const OPEN_SO_DETAIL_STATUSES = ["Pending", "In Planning", "In Production"];
const mpsBucketKey = (partCode, customerCode, bucketDate) => `${String(partCode || "").trim()}|${String(customerCode || "Tanpa Customer").trim() || "Tanpa Customer"}|${monthKey(bucketDate)}`;

async function buildActualSalesOrderByMpsBucket(tx, details = []) {
  const receiptDetails = details.filter((row) => !isGeneratedProcess(row) && row.partCode && row.startDate);
  const keys = new Set(receiptDetails.map((row) => mpsBucketKey(row.partCode, row.customerCode, row.startDate)));
  if (!keys.size) return { byBucket: new Map(), byDetailId: new Map() };
  const partCodes = [...new Set(receiptDetails.map((row) => row.partCode))];
  const soDetails = await tx.salesOrderDetail.findMany({
    where: {
      isDeleted: false, partCode: { in: partCodes }, status: { in: OPEN_SO_DETAIL_STATUSES },
      soHeader: { isDeleted: false, status: { in: OPEN_SO_HEADER_STATUSES } },
    },
    select: {
      soNumber: true, partCode: true, qty: true, qtyDelivered: true, deliveryDate: true,
      soHeader: { select: { customerCode: true, soDate: true, deliveryDate: true } },
    },
  });
  const byBucket = new Map();
  for (const row of soDetails) {
    const dueDate = row.deliveryDate || row.soHeader?.deliveryDate || row.soHeader?.soDate;
    if (!dueDate) continue;
    const key = mpsBucketKey(row.partCode, row.soHeader?.customerCode, dueDate);
    if (!keys.has(key)) continue;
    const outstandingQty = Math.max(number(row.qty) - number(row.qtyDelivered), 0);
    if (!outstandingQty) continue;
    const current = byBucket.get(key) || { qty: 0, soNumbers: [] };
    current.qty += outstandingQty;
    current.soNumbers.push(row.soNumber);
    byBucket.set(key, current);
  }
  return {
    byBucket,
    byDetailId: new Map(receiptDetails.map((row) => [row.id, byBucket.get(mpsBucketKey(row.partCode, row.customerCode, row.startDate)) || { qty: 0, soNumbers: [] }])),
  };
}

exports.generateNumber = async (_req, res, next) => { try { res.json({ mpsNumber: await nextNumber() }); } catch (error) { next(error); } };

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(number(req.query.page) || 1, 1); const limit = Math.min(Math.max(number(req.query.limit) || 20, 1), 500); const q = text(req.query.q || req.query.search);
    const where = { isDeleted: false, ...(q ? { OR: [{ mpsNumber: { contains: q, mode: "insensitive" } }, { mpsName: { contains: q, mode: "insensitive" } }, { forecastNumber: { contains: q, mode: "insensitive" } }, { status: { contains: q, mode: "insensitive" } }] } : {}) };
    const [items, total] = await Promise.all([prisma.mPS.findMany({ where, include, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }), prisma.mPS.count({ where })]);
    res.json({ items: items.map((item) => {
      const receiptLines = item.details.filter((row) => !isGeneratedProcess(row));
      const processLines = item.details.filter((row) => isGeneratedProcess(row) && String(row.part?.itemType || "").toUpperCase() !== "FG");
      return {
        ...item,
        totalPlannedQty: receiptLines.reduce((sum, row) => sum + number(row.qtyPlanned), 0),
        partCount: new Set(receiptLines.map((row) => row.partCode)).size,
        receiptLineCount: receiptLines.length,
        processLineCount: processLines.length,
      };
    }), total, page, limit });
  } catch (error) { next(error); }
};

exports.get = async (req, res, next) => {
  try {
    const doc = await prisma.mPS.findFirst({ where: { mpsNumber: req.params.mpsNumber, isDeleted: false }, include });
    if (!doc) return res.status(404).json({ message: "MPS tidak ditemukan" });
    const actualSo = await buildActualSalesOrderByMpsBucket(prisma, doc.details);
    doc.details = doc.details.map((row) => {
      const actual = actualSo.byDetailId.get(row.id);
      if (!actual) return row;
      return {
        ...row,
        actualSalesOrderQty: Math.max(number(row.actualSalesOrderQty), number(actual.qty)),
        soNumber: row.soNumber || [...new Set(actual.soNumbers)].join(",") || null,
      };
    });
    const productionPlans = await prisma.monthlyProductionPlan.findMany({
      where: { sourceType: `MPS:${doc.mpsNumber}`, isDeleted: false },
      select: { planNumber: true, planMonth: true, status: true, _count: { select: { details: true } } },
      orderBy: { planMonth: "asc" },
    });
    res.json({ ...doc, productionPlans });
  } catch (error) { next(error); }
};

exports.createFromForecast = async (req, res, next) => {
  try {
    const forecastNumber = text(req.body.forecastNumber);
    if (!forecastNumber) return res.status(400).json({ message: "Forecast wajib dipilih" });
    const forecast = await prisma.forecast.findFirst({
      where: { forecastNumber, isDeleted: false },
      include: {
        details: {
          where: { isDeleted: false },
          include: {
            part: {
              include: {
                mbomHeaders: {
                  where: { isDeleted: false },
                  orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
                  take: 1,
                },
              },
            },
          },
        },
      },
    });
    if (!forecast) return res.status(404).json({ message: "Forecast tidak ditemukan" });
    if (forecast.status !== "Confirmed") return res.status(409).json({ message: "Forecast harus berstatus Confirmed sebelum dibuat menjadi MPS" });
    const periods = forecast.details.flatMap((row) => forecastPeriods(row).map((period) => ({ row, ...period })));
    if (!periods.length) return res.status(400).json({ message: "Forecast belum memiliki demand bulanan dengan qty lebih dari nol" });
    const doc = await prisma.$transaction(async (tx) => {
      const mpsNumber = text(req.body.mpsNumber) || await nextNumber(tx);
      const periodStart = new Date(Math.min(...periods.map((row) => row.month.getTime())));
      const periodEnd = new Date(Math.max(...periods.map((row) => monthEnd(row.month).getTime())));
      const forecastByPartMonth = new Map(periods.map((item) => [`${item.row.partCode}|${monthKey(item.month)}`, number(item.qty)]));
      const details = periods.map(({ row, month, qty, offset }, index) => {
        const nextMonth = new Date(month.getFullYear(), month.getMonth() + 1, 1);
        const forecastQty = number(qty);
        const bufferBaseQty = number(forecastByPartMonth.get(`${row.partCode}|${monthKey(nextMonth)}`));
        const bufferPercent = Math.max(number(row.part?.bufferStock), 0);
        const bufferQty = Number(((bufferBaseQty * bufferPercent) / 100).toFixed(6));
        const effectiveDemandQty = forecastQty + bufferQty;
        return {
          lineNumber: index + 1, partCode: row.partCode, partId: row.partId || row.part?.id || null, mbomHeaderId: row.part?.mbomHeaders?.[0]?.id || null,
          forecastQty, actualSalesOrderQty: 0, bufferBaseQty, bufferPercent, bufferQty, effectiveDemandQty, productionPercent: 100,
          qtyPlanned: effectiveDemandQty, startDate: month, endDate: monthEnd(month), priority: 1, status: "Planned", customerCode: forecast.customerCode,
          forecastDetailId: row.id, forecastPeriodOffset: offset, notes: `${FG_RECEIPT_PREFIX} Generated from forecast ${forecast.forecastNumber}`,
        };
      });
      const actualSo = await buildActualSalesOrderByMpsBucket(tx, details);
      for (const detail of details) {
        const actual = actualSo.byBucket.get(mpsBucketKey(detail.partCode, detail.customerCode, detail.startDate)) || { qty: 0, soNumbers: [] };
        detail.actualSalesOrderQty = number(actual.qty);
        detail.soNumber = [...new Set(actual.soNumbers)].join(",") || null;
        detail.qtyPlanned = Math.max(detail.effectiveDemandQty, detail.actualSalesOrderQty);
      }
      const created = await tx.mPS.create({ data: { mpsNumber, mpsName: text(req.body.mpsName) || `MPS ${forecast.forecastNumber}`, periodStart, periodEnd, forecastNumber: forecast.forecastNumber, status: "Draft", notes: text(req.body.notes) || `Generated from confirmed forecast ${forecast.forecastNumber}`, createdBy: req.user?.username || req.user?.email || null, details: { create: details } }, include });
      await tx.forecast.update({ where: { forecastNumber: forecast.forecastNumber }, data: { status: "Consumed" } });
      return created;
    });
    res.status(201).json(doc);
  } catch (error) { next(error); }
};

exports.updateAdjustments = async (req, res, next) => {
  try {
    const detailIds = [...new Set(Array.isArray(req.body.detailIds) ? req.body.detailIds.filter(Boolean) : [])];
    const bufferPercent = Number(req.body.bufferPercent);
    const productionPercent = Number(req.body.productionPercent);
    const scope = req.body.scope === "parent" ? "PARENT_FG" : "LINE";
    if (!detailIds.length) return res.status(400).json({ message: "Detail MPS wajib dipilih" });
    if (!Number.isFinite(bufferPercent) || bufferPercent < 0 || bufferPercent > 100) return res.status(400).json({ message: "Buffer % harus antara 0 sampai 100" });
    if (!Number.isFinite(productionPercent) || productionPercent < 0 || productionPercent > 100) return res.status(400).json({ message: "Produksi % harus antara 0 sampai 100" });
    const doc = await prisma.mPS.findFirst({
      where: { mpsNumber: req.params.mpsNumber, isDeleted: false },
      include: { details: { where: { id: { in: detailIds }, isDeleted: false }, include: { part: true } } },
    });
    if (!doc) return res.status(404).json({ message: "MPS tidak ditemukan" });
    if (!["Draft", "Confirmed"].includes(doc.status)) return res.status(409).json({ message: `MPS status ${doc.status} tidak dapat disesuaikan` });
    if (doc.details.length !== detailIds.length) return res.status(404).json({ message: "Sebagian detail MPS tidak ditemukan" });
    if (doc.details.some((row) => isGeneratedProcess(row))) return res.status(400).json({ message: "Buffer dan persentase produksi hanya dapat diatur pada FG receipt" });
    let targetDetails = doc.details;
    if (scope === "PARENT_FG") {
      const parentPartCodes = [...new Set(doc.details.map((row) => row.partCode).filter(Boolean))];
      const allParentRows = await prisma.mPSDetail.findMany({
        where: { mpsNumber: doc.mpsNumber, partCode: { in: parentPartCodes }, isDeleted: false },
        include: { part: true },
      });
      targetDetails = allParentRows.filter((row) => !isGeneratedProcess(row));
    }
    const actualSo = await buildActualSalesOrderByMpsBucket(prisma, targetDetails);
    await prisma.$transaction(targetDetails.map((row) => {
      const actual = actualSo.byDetailId.get(row.id) || { qty: 0, soNumbers: [] };
      const bufferQty = Number(((number(row.bufferBaseQty) * bufferPercent) / 100).toFixed(6));
      const effectiveDemandQty = number(row.forecastQty) + bufferQty;
      const actualSalesOrderQty = Math.max(number(row.actualSalesOrderQty), number(actual.qty));
      const qtyPlanned = Math.max(Number(((effectiveDemandQty * productionPercent) / 100).toFixed(6)), actualSalesOrderQty);
      return prisma.mPSDetail.update({
        where: { id: row.id },
        data: { bufferPercent, bufferQty, bufferOverridden: true, bufferReferenceScope: scope, effectiveDemandQty, productionPercent, productionOverridden: true, actualSalesOrderQty, soNumber: [...new Set(actual.soNumbers)].join(",") || row.soNumber || null, qtyPlanned },
      });
    }));
    const updated = await prisma.mPS.findFirst({ where: { mpsNumber: doc.mpsNumber }, include });
    res.json(updated);
  } catch (error) { next(error); }
};

exports.confirm = async (req, res, next) => {
  try {
    const doc = await prisma.mPS.findFirst({ where: { mpsNumber: req.params.mpsNumber, isDeleted: false }, include: { details: { where: { isDeleted: false }, select: { id: true } } } });
    if (!doc) return res.status(404).json({ message: "MPS tidak ditemukan" });
    if (!doc.details.length) return res.status(400).json({ message: "MPS tanpa detail tidak dapat dikonfirmasi" });
    if (doc.status !== "Draft") return res.status(409).json({ message: `MPS tidak dapat dikonfirmasi dari status ${doc.status}` });
    const updated = await prisma.mPS.update({ where: { mpsNumber: doc.mpsNumber }, data: { status: "Confirmed", approvedBy: req.user?.username || req.user?.email || null, approvedDate: new Date() }, include });
    res.json(updated);
  } catch (error) { next(error); }
};
