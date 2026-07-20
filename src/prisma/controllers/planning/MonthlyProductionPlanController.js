const { prisma } = require("../../index");
const { buildCapacitySnapshot } = require("../../services/planning/capacityPlanningService");
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const include = { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } };

const text = (value) => String(value ?? "").trim() || null;
const monthStart = (value) => { const date = new Date(value); return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)); };
const monthEnd = (value) => { const date = new Date(value); return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59, 999)); };
const monthKey = (value) => monthStart(value).toISOString().slice(0, 7);
const isGeneratedProcess = (row) => String(row?.notes || "").includes("[MRP-PRODUCTION]");

async function nextPlanNumber(tx, value) {
  const prefix = `MPP-${monthKey(value).replace("-", "")}-`;
  const last = await tx.monthlyProductionPlan.findFirst({ where: { planNumber: { startsWith: prefix } }, orderBy: { planNumber: "desc" }, select: { planNumber: true } });
  const sequence = Number(last?.planNumber?.split("-").pop() || 0) + 1;
  return `${prefix}${String(sequence).padStart(3, "0")}`;
}

function serialize(plan) {
  if (!plan) return plan;
  const receiptLines = plan.details.filter((row) => !isGeneratedProcess(row));
  const processLines = plan.details.filter(isGeneratedProcess);
  return {
    ...plan,
    targetQty: receiptLines.reduce((sum, row) => sum + number(row.qtyPlanned), 0),
    actualQty: receiptLines.reduce((sum, row) => sum + number(row.qtyReleased), 0),
    forecastQty: receiptLines.reduce((sum, row) => sum + number(row.forecastQty), 0),
    bufferQty: receiptLines.reduce((sum, row) => sum + number(row.bufferQty), 0),
    actualSalesOrderQty: receiptLines.reduce((sum, row) => sum + number(row.actualSalesOrderQty), 0),
    lineCount: plan.details.length,
    receiptLineCount: receiptLines.length,
    processLineCount: processLines.length,
    sourceMpsNumber: String(plan.sourceType || "").startsWith("MPS:") ? String(plan.sourceType).slice(4) : null,
  };
}

function detailFromMps(row, lineNumber) {
  return {
    lineNumber,
    plannedOrderNumber: null,
    partCode: row.partCode,
    partId: row.partId || row.part?.id || null,
    mpsDetailId: row.id,
    forecastQty: number(row.forecastQty),
    actualSalesOrderQty: number(row.actualSalesOrderQty),
    bufferBaseQty: number(row.bufferBaseQty),
    bufferPercent: number(row.bufferPercent),
    bufferQty: number(row.bufferQty),
    productionPercent: number(row.productionPercent || 100),
    effectiveDemandQty: number(row.effectiveDemandQty),
    qtyPlanned: number(row.qtyPlanned),
    uomCode: row.part?.uomCode || null,
    requiredDate: row.endDate,
    priority: number(row.priority) || 1,
    status: "Planned",
    notes: `[MPS-LINE:${row.lineNumber}] ${row.notes || ""}`.trim(),
  };
}

async function withMpsSnapshot(plan) {
  const mpsNumber = String(plan?.sourceType || "").startsWith("MPS:") ? String(plan.sourceType).slice(4) : null;
  if (!mpsNumber) return plan;
  const mps = await prisma.mPS.findFirst({
    where: { mpsNumber, isDeleted: false },
    select: { details: { where: { isDeleted: false }, select: { id: true, lineNumber: true, forecastQty: true, actualSalesOrderQty: true, bufferBaseQty: true, bufferPercent: true, bufferQty: true, productionPercent: true, effectiveDemandQty: true, qtyPlanned: true } } },
  });
  if (!mps) return plan;
  const byId = new Map(mps.details.map((row) => [row.id, row]));
  const byLineNumber = new Map(mps.details.map((row) => [String(row.lineNumber), row]));
  return {
    ...plan,
    details: plan.details.map((detail) => {
      const sourceLine = String(detail.notes || "").match(/\[MPS-LINE:(\d+)\]/)?.[1];
      const source = byId.get(detail.mpsDetailId) || byLineNumber.get(sourceLine);
      return source ? { ...detail, ...Object.fromEntries(["forecastQty", "actualSalesOrderQty", "bufferBaseQty", "bufferPercent", "bufferQty", "productionPercent", "effectiveDemandQty"].map((field) => [field, source[field]])), mpsDetailId: source.id } : detail;
    }),
  };
}

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(number(req.query.page) || 1, 1); const limit = Math.min(Math.max(number(req.query.limit) || 20, 1), 500); const q = String(req.query.q || req.query.search || "").trim();
    const where = { isDeleted: false, ...(q ? { OR: [{ planNumber: { contains: q, mode: "insensitive" } }, { status: { contains: q, mode: "insensitive" } }] } : {}) };
    const [items, total] = await Promise.all([prisma.monthlyProductionPlan.findMany({ where, include, orderBy: { planMonth: "desc" }, skip: (page - 1) * limit, take: limit }), prisma.monthlyProductionPlan.count({ where })]);
    res.json({ items: items.map(serialize), total, page, limit });
  } catch (error) { next(error); }
};

exports.get = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber: req.params.planNumber, isDeleted: false }, include });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan" });
    res.json(serialize(await withMpsSnapshot(plan)));
  } catch (error) { next(error); }
};

exports.createFromMps = async (req, res, next) => {
  try {
    const mpsNumber = text(req.body?.mpsNumber);
    if (!mpsNumber) return res.status(400).json({ message: "MPS wajib dipilih." });
    const mps = await prisma.mPS.findFirst({
      where: { mpsNumber, isDeleted: false },
      include: { details: { where: { isDeleted: false, status: { not: "Cancelled" } }, include: { part: true }, orderBy: [{ startDate: "asc" }, { lineNumber: "asc" }] } },
    });
    if (!mps) return res.status(404).json({ message: "MPS tidak ditemukan." });
    if (mps.status !== "Confirmed") return res.status(409).json({ message: "MPS harus Confirmed sebelum dibuat menjadi Production Plan." });
    const validDetails = mps.details.filter((row) => !(isGeneratedProcess(row) && String(row.part?.itemType || "").toUpperCase() === "FG"));
    if (!validDetails.length) return res.status(400).json({ message: "MPS belum mempunyai FG receipt atau child/SFG process." });
    const completedMrp = await prisma.mRPRun.findFirst({ where: { mpsNumber, isDeleted: false, isCurrentPlan: true, status: "Completed" }, orderBy: { createdAt: "desc" }, select: { runNumber: true } });
    if (!completedMrp) return res.status(409).json({ message: "Jalankan MRP sampai Completed sebelum membuat Production Plan agar material sudah diperiksa." });

    const grouped = new Map();
    for (const row of validDetails) {
      const key = monthKey(row.startDate);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }
    const sourceType = `MPS:${mps.mpsNumber}`;
    const result = await prisma.$transaction(async (tx) => {
      const plans = [];
      for (const [key, details] of grouped.entries()) {
        const planMonth = new Date(`${key}-01T00:00:00.000Z`);
        const existing = await tx.monthlyProductionPlan.findFirst({ where: { sourceType, planMonth: { gte: monthStart(planMonth), lte: monthEnd(planMonth) }, isDeleted: false }, include });
        if (existing) {
          if (existing.status === "Draft") {
            let nextLineNumber = Math.max(0, ...existing.details.map((row) => number(row.lineNumber))) + 1;
            for (const row of details) {
              const sourceLineMarker = `[MPS-LINE:${row.lineNumber}]`;
              const matched = existing.details.find((detail) => detail.mpsDetailId === row.id || String(detail.notes || "").includes(sourceLineMarker));
              const data = detailFromMps(row, matched?.lineNumber || nextLineNumber++);
              if (matched) await tx.monthlyProductionPlanDetail.update({ where: { id: matched.id }, data });
              else await tx.monthlyProductionPlanDetail.create({ data: { ...data, planId: existing.id } });
            }
          }
          const synchronized = await tx.monthlyProductionPlan.findFirst({ where: { id: existing.id }, include });
          plans.push({ ...serialize(synchronized), existing: true, synchronized: existing.status === "Draft" });
          continue;
        }
        const planNumber = await nextPlanNumber(tx, planMonth);
        const created = await tx.monthlyProductionPlan.create({
          data: {
            planNumber,
            planMonth,
            periodStart: monthStart(planMonth),
            periodEnd: monthEnd(planMonth),
            status: "Draft",
            sourceType,
            notes: `Production plan dari ${mps.mpsNumber}; material check ${completedMrp.runNumber}`,
            createdBy: req.user?.username || req.user?.email || null,
            details: {
              create: details.map((row, index) => detailFromMps(row, index + 1)),
            },
          },
          include,
        });
        plans.push({ ...serialize(created), existing: false });
      }
      return plans;
    });
    res.status(201).json({ items: result, total: result.length, sourceMpsNumber: mps.mpsNumber, mrpRunNumber: completedMrp.runNumber });
  } catch (error) { next(error); }
};

exports.confirm = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber: req.params.planNumber, isDeleted: false }, include });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan." });
    if (plan.status !== "Draft") return res.status(409).json({ message: `Production Plan tidak dapat dikonfirmasi dari status ${plan.status}.` });
    if (!plan.details.length) return res.status(400).json({ message: "Production Plan tanpa detail tidak dapat dikonfirmasi." });
    const updated = await prisma.monthlyProductionPlan.update({ where: { planNumber: plan.planNumber }, data: { status: "Confirmed", confirmedBy: req.user?.username || req.user?.email || null, confirmedAt: new Date() }, include });
    res.json(serialize(updated));
  } catch (error) { next(error); }
};

exports.release = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber: req.params.planNumber, isDeleted: false }, include });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan." });
    if (plan.status !== "Confirmed") return res.status(409).json({ message: `Production Plan harus Confirmed sebelum release, status saat ini ${plan.status}.` });
    const capacity = await buildCapacitySnapshot(prisma, { ...(req.body || {}), planNumber: plan.planNumber, startDate: plan.periodStart, endDate: plan.periodEnd });
    if (!capacity.readiness.ok || capacity.summary.unscheduledCount > 0 || capacity.summary.overloadedCells > 0) {
      return res.status(409).json({ message: "Production Plan belum dapat direlease. Lengkapi routing machine/cycle time dan selesaikan overload pada Capacity Planning.", code: "CAPACITY_NOT_READY", capacity: { summary: capacity.summary, readiness: capacity.readiness, unscheduled: capacity.unscheduled } });
    }
    const updated = await prisma.monthlyProductionPlan.update({ where: { planNumber: plan.planNumber }, data: { status: "Released", releasedBy: req.user?.username || req.user?.email || null, releasedAt: new Date() }, include });
    res.json(serialize(updated));
  } catch (error) { next(error); }
};
