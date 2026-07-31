const { prisma } = require("../../index");
const { buildCapacitySnapshot } = require("../../services/planning/capacityPlanningService");
const dailyProductionScheduleController = require("../production/DailyProductionScheduleController");
const {
  buildMaterialReadinessSnapshot,
} = require("../../services/planning/materialReadinessService");
const {
  planningMonthKey: monthKey,
  utcMonthStart: monthStart,
  utcMonthEnd: monthEnd,
  utcMonthEndInstant,
} = require("../../utils/planningMonth");
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const { isDiscreteUom, normalizeQuantity, splitQuantity } = require("../../utils/uomQuantity");
const include = { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } };

const text = (value) => String(value ?? "").trim() || null;
const isGeneratedProcess = (row) => String(row?.notes || "").includes("[MRP-PRODUCTION]");
const isChildFgReceipt = (row) => isGeneratedProcess(row)
  && String(row?.part?.itemType || "").trim().toUpperCase() === "FG";

async function nextPlanNumber(tx, value) {
  const prefix = `MPP-${monthKey(value).replace("-", "")}-`;
  const last = await tx.monthlyProductionPlan.findFirst({ where: { planNumber: { startsWith: prefix } }, orderBy: { planNumber: "desc" }, select: { planNumber: true } });
  const sequence = Number(last?.planNumber?.split("-").pop() || 0) + 1;
  return `${prefix}${String(sequence).padStart(3, "0")}`;
}

async function nextDailyPlanNumber(tx, value) {
  const date = value instanceof Date ? value : new Date(value);
  const prefix = `DPS-${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}-`;
  const last = await tx.dailyProductionSchedule.findFirst({
    where: { scheduleNumber: { startsWith: prefix } },
    orderBy: { scheduleNumber: "desc" },
    select: { scheduleNumber: true },
  });
  const sequence = number(last?.scheduleNumber?.split("-").pop()) + 1;
  return `${prefix}${String(sequence).padStart(3, "0")}`;
}

function dailyPlanMarker(planNumber, allocation, moNumber) {
  return `[PPIC-DPP:${planNumber}:${allocation.lineNumber}:${allocation.mbomProcessId}:${allocation.scheduleDate}:${allocation.shift}:${moNumber}:${allocation.routingMode}]`;
}

function serialize(plan) {
  if (!plan) return plan;
  const receiptLines = plan.details.filter((row) => !isGeneratedProcess(row));
  const childReceiptLines = plan.details.filter(isChildFgReceipt);
  const processLines = plan.details.filter((row) => isGeneratedProcess(row) && !isChildFgReceipt(row));
  return {
    ...plan,
    targetQty: receiptLines.reduce((sum, row) => sum + number(row.qtyPlanned), 0),
    actualQty: receiptLines.reduce((sum, row) => sum + number(row.qtyReleased), 0),
    forecastQty: receiptLines.reduce((sum, row) => sum + number(row.forecastQty), 0),
    bufferQty: receiptLines.reduce((sum, row) => sum + number(row.bufferQty), 0),
    actualSalesOrderQty: receiptLines.reduce((sum, row) => sum + number(row.actualSalesOrderQty), 0),
    lineCount: plan.details.length,
    receiptLineCount: receiptLines.length,
    childReceiptLineCount: childReceiptLines.length,
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
    uomCode: row.part?.productionUomCode || row.part?.baseUomCode || row.mbom?.uomCode || null,
    requiredDate: row.endDate,
    priority: number(row.priority) || 1,
    status: "Planned",
    notes: `[MPS-LINE:${row.lineNumber}] ${row.notes || ""}`.trim(),
  };
}

function sourcePartCode(row) {
  return String(row?.notes || "").match(/;\s*source\s+(.+?)(?:;|$)/i)?.[1]?.trim() || null;
}

// Production Plan is an execution proposal: PPIC may reduce/increase the
// forecast portion here without changing the approved MPS.  Actual SO remains
// a hard floor, and child/SFG quantities follow their parent FG proportionally.
function derivePlanDetails(mpsDetails, productionPercent) {
  const ratio = productionPercent / 100;
  const isProcess = (row) => isGeneratedProcess(row);
  const receipts = mpsDetails.filter((row) => !isProcess(row));
  const receiptById = new Map(receipts.map((row) => [row.id, row]));
  const receiptByLegacyKey = new Map(receipts.map((row) => [`${row.customerCode || ""}|${row.partCode}|${row.forecastPeriodOffset || ""}`, row]));
  const receiptByMonth = new Map(receipts.map((row) => [`${row.customerCode || ""}|${row.partCode}|${monthKey(row.startDate)}`, row]));
  const adjustedReceiptQty = new Map(receipts.map((row) => [row.id, Math.max(number(row.effectiveDemandQty) * ratio, number(row.actualSalesOrderQty))]));
  return mpsDetails.map((row) => {
    if (!isProcess(row)) {
      return {
        ...row,
        productionPercent,
        qtyPlanned: adjustedReceiptQty.get(row.id),
      };
    }
    const sourceId = String(row.notes || "").match(/\[MPS-SOURCE:([^\]]+)\]/)?.[1];
    const source = receiptById.get(sourceId) || receiptByLegacyKey.get(`${row.customerCode || ""}|${sourcePartCode(row) || ""}|${row.forecastPeriodOffset || ""}`) || receiptByMonth.get(`${row.customerCode || ""}|${sourcePartCode(row) || ""}|${monthKey(row.startDate)}`);
    if (!source) return { ...row, qtyPlanned: number(row.qtyPlanned) * ratio };
    const sourceOriginalQty = Math.max(number(source.qtyPlanned), 0);
    const childFactor = sourceOriginalQty > 0 ? number(row.qtyPlanned) / sourceOriginalQty : 1;
    return {
      ...row,
      forecastQty: number(row.forecastQty) || number(source.forecastQty), actualSalesOrderQty: number(row.actualSalesOrderQty) || number(source.actualSalesOrderQty), bufferBaseQty: number(row.bufferBaseQty) || number(source.bufferBaseQty), bufferPercent: number(row.bufferPercent) || number(source.bufferPercent), bufferQty: number(row.bufferQty) || number(source.bufferQty), effectiveDemandQty: number(row.effectiveDemandQty) || number(source.effectiveDemandQty), productionPercent,
      qtyPlanned: Math.max(adjustedReceiptQty.get(source.id) * childFactor, number(source.actualSalesOrderQty) * childFactor),
    };
  });
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
      if (!source) return detail;
      const synced = { ...detail, ...Object.fromEntries(["forecastQty", "actualSalesOrderQty", "bufferBaseQty", "bufferPercent", "bufferQty", "effectiveDemandQty"].map((field) => [field, source[field]])), mpsDetailId: source.id };
      if (plan.status === "Draft" && !isGeneratedProcess(detail)) {
        synced.qtyPlanned = Math.max(
          number(source.effectiveDemandQty) * number(detail.productionPercent || 100) / 100,
          number(source.actualSalesOrderQty),
        );
      }
      return synced;
    }),
  };
}

async function withManufacturingOrderTrace(plan) {
  if (!plan?.planNumber) return plan;
  const manufacturingOrders = await prisma.manufacturingOrder.findMany({
    where: {
      monthlyProductionPlanNumber: plan.planNumber,
      isDeleted: false,
    },
    select: {
      id: true,
      moNumber: true,
      monthlyProductionPlanLineNumber: true,
      qtyPlanned: true,
      qtyProduced: true,
      qtyGood: true,
      status: true,
      plannedStartDate: true,
      plannedEndDate: true,
      createdAt: true,
    },
    orderBy: [{ monthlyProductionPlanLineNumber: "asc" }, { createdAt: "asc" }],
  });
  const moIds = manufacturingOrders.map((mo) => mo.id).filter(Boolean);
  const moNumbers = manufacturingOrders.map((mo) => mo.moNumber).filter(Boolean);
  const dailyPlans = manufacturingOrders.length && (moIds.length || moNumbers.length) ? await prisma.dailyProductionSchedule.findMany({
    where: {
      isDeleted: false,
      OR: [
        ...(moIds.length ? [{ moId: { in: moIds } }] : []),
        ...(moNumbers.length ? [{ moNumber: { in: moNumbers } }] : []),
      ],
    },
    select: { scheduleNumber: true, scheduleDate: true, shift: true, moId: true, moNumber: true, woId: true, woNumber: true, partCode: true, processId: true, machineId: true, plannedQty: true, actualQty: true, status: true },
    orderBy: [{ scheduleDate: "asc" }, { shift: "asc" }],
  }) : [];
  const dailyByMo = new Map();
  for (const row of dailyPlans) {
    const key = row.moId || row.moNumber;
    if (!dailyByMo.has(key)) dailyByMo.set(key, []);
    dailyByMo.get(key).push(row);
  }
  const byLine = new Map();
  for (const mo of manufacturingOrders) {
    const key = Number(mo.monthlyProductionPlanLineNumber);
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(mo);
  }
  return {
    ...plan,
    manufacturingOrders,
    dailyProductionPlans: dailyPlans,
    details: plan.details.map((detail) => ({
      ...detail,
      manufacturingOrders: (byLine.get(Number(detail.lineNumber)) || []).map((mo) => ({ ...mo, dailyProductionPlans: dailyByMo.get(mo.moNumber) || dailyByMo.get(mo.id) || [] })),
    })),
  };
}

function displayReference(type, value, href, label = null) {
  if (!value) return null;
  return {
    type,
    value,
    label: label || String(value),
    href,
  };
}

async function withPlanDisplayReferences(plan) {
  const details = Array.isArray(plan?.details) ? plan.details : [];
  const partIds = [...new Set(details.map((row) => row.partId).filter(Boolean))];
  const partCodes = [...new Set(details.map((row) => row.partCode).filter(Boolean))];
  const sourceMpsNumber = String(plan?.sourceType || "").startsWith("MPS:")
    ? String(plan.sourceType).slice(4)
    : null;
  const [parts, bomHeaders, processBoms, sourceMps, sourceMrp] = await Promise.all([
    partIds.length || partCodes.length
      ? prisma.part.findMany({
        where: {
          isDeleted: false,
          OR: [
            ...(partIds.length ? [{ id: { in: partIds } }] : []),
            ...(partCodes.length ? [{ partCode: { in: partCodes } }] : []),
          ],
        },
        select: {
          id: true,
          partCode: true,
          partNumber: true,
          partName: true,
          itemType: true,
          partType: true,
        },
      })
      : [],
    partIds.length
      ? prisma.mBOMHeader.findMany({
        where: { partId: { in: partIds }, isDeleted: false },
        orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
        select: { noReg: true, partId: true, revision: true },
      })
      : [],
    partIds.length
      ? prisma.mBOMProcess.findMany({
        where: {
          isDeleted: false,
          mbomDetail: { partId: { in: partIds } },
        },
        orderBy: [{ noReg: "desc" }, { sequence: "asc" }],
        select: {
          noReg: true,
          mbomDetail: { select: { partId: true } },
        },
      })
      : [],
    sourceMpsNumber
      ? prisma.mPS.findFirst({
        where: { mpsNumber: sourceMpsNumber, isDeleted: false },
        select: { mpsNumber: true, mpsName: true, forecastNumber: true },
      })
      : null,
    sourceMpsNumber
      ? prisma.mRPRun.findFirst({
        where: {
          mpsNumber: sourceMpsNumber,
          isDeleted: false,
          isCurrentPlan: true,
          status: "Completed",
        },
        orderBy: { createdAt: "desc" },
        select: { runNumber: true, runDate: true, status: true },
      })
      : null,
  ]);
  const partById = new Map(parts.map((part) => [part.id, part]));
  const partByCode = new Map(parts.map((part) => [part.partCode, part]));
  const bomByPartId = new Map();
  for (const header of bomHeaders) {
    if (!bomByPartId.has(header.partId)) bomByPartId.set(header.partId, header);
  }
  for (const route of processBoms) {
    const partId = route.mbomDetail?.partId;
    if (partId && !bomByPartId.has(partId)) {
      bomByPartId.set(partId, { noReg: route.noReg, partId });
    }
  }
  const documentReferences = [
    displayReference(
      "FORECAST",
      sourceMps?.forecastNumber,
      sourceMps?.forecastNumber
        ? `/modules/sales/forecasts/${encodeURIComponent(sourceMps.forecastNumber)}`
        : null,
      sourceMps?.forecastNumber ? `Forecast ${sourceMps.forecastNumber}` : null,
    ),
    displayReference(
      "MPS",
      sourceMps?.mpsNumber || sourceMpsNumber,
      sourceMpsNumber
        ? `/modules/planning-ppic/mps/${encodeURIComponent(sourceMpsNumber)}`
        : null,
      sourceMpsNumber ? `Master Production Schedule ${sourceMpsNumber}` : null,
    ),
    displayReference(
      "MRP",
      sourceMrp?.runNumber,
      sourceMrp?.runNumber
        ? `/modules/planning-ppic/mrp/${encodeURIComponent(sourceMrp.runNumber)}`
        : null,
      sourceMrp?.runNumber ? `Material Requirements Plan ${sourceMrp.runNumber}` : null,
    ),
  ].filter(Boolean);
  return {
    ...plan,
    sourceMpsNumber,
    sourceMrpNumber: sourceMrp?.runNumber || null,
    sourceForecastNumber: sourceMps?.forecastNumber || null,
    documentReferences,
    details: details.map((detail) => {
      const part = partById.get(detail.partId) || partByCode.get(detail.partCode) || null;
      const bom = part?.id ? bomByPartId.get(part.id) : null;
      const lineType = !isGeneratedProcess(detail)
        ? "FG Receipt"
        : String(part?.itemType || "").toUpperCase() === "FG"
          ? "Child FG Receipt"
          : "Production Process";
      const referenceLinks = [
        displayReference(
          "PART",
          part?.partCode || detail.partCode,
          `/master-data/parts/${encodeURIComponent(part?.partCode || detail.partCode)}/edit?key=${encodeURIComponent(part?.partCode || detail.partCode)}`,
          [part?.partCode || detail.partCode, part?.partName].filter(Boolean).join(" · "),
        ),
        displayReference(
          "BOM",
          bom?.noReg,
          bom?.noReg
            ? `/modules/manufacturing-bom/bill-of-materials/${encodeURIComponent(bom.noReg)}/edit`
            : null,
          bom?.noReg ? `Bill of Material ${bom.noReg}` : null,
        ),
        displayReference(
          "PLANNED_ORDER",
          detail.plannedOrderNumber,
          detail.plannedOrderNumber
            ? `/modules/planning-ppic/planned-orders/${encodeURIComponent(detail.plannedOrderNumber)}`
            : null,
          detail.plannedOrderNumber ? `Planned Order ${detail.plannedOrderNumber}` : null,
        ),
        ...(detail.manufacturingOrders || []).map((mo) => displayReference(
          "MO",
          mo.moNumber,
          `/modules/production/manufacturing-orders/${encodeURIComponent(mo.moNumber)}`,
          `Manufacturing Order ${mo.moNumber}`,
        )),
      ].filter(Boolean);
      return {
        ...detail,
        part,
        bomNumber: bom?.noReg || null,
        lineType,
        displayName: part?.partName || part?.partNumber || detail.partCode,
        referenceLinks,
      };
    }),
  };
}

function planIssueReferences(issue, plan, sourceMrpNumber) {
  return [
    displayReference(
      "BOM",
      issue.bomNumber,
      issue.bomNumber
        ? `/modules/manufacturing-bom/bill-of-materials/${encodeURIComponent(issue.bomNumber)}/edit`
        : null,
      issue.bomNumber ? `Perbaiki BOM ${issue.bomNumber}` : null,
    ),
    displayReference(
      "PART",
      issue.partCode,
      issue.partCode
        ? `/master-data/parts/${encodeURIComponent(issue.partCode)}/edit?key=${encodeURIComponent(issue.partCode)}`
        : null,
      issue.partCode
        ? [issue.partCode, issue.partName].filter(Boolean).join(" · ")
        : null,
    ),
    displayReference(
      "PLANNED_ORDER",
      issue.orderNumber,
      issue.orderNumber
        ? `/modules/planning-ppic/planned-orders/${encodeURIComponent(issue.orderNumber)}`
        : null,
      issue.orderNumber ? `Planned Order ${issue.orderNumber}` : null,
    ),
    displayReference(
      "MRP",
      sourceMrpNumber,
      sourceMrpNumber
        ? `/modules/planning-ppic/mrp/${encodeURIComponent(sourceMrpNumber)}`
        : null,
      sourceMrpNumber ? `MRP ${sourceMrpNumber}` : null,
    ),
    displayReference(
      "CAPACITY",
      issue.source === "CAPACITY" ? plan.planNumber : null,
      issue.source === "CAPACITY"
        ? `/modules/planning-ppic/capacity-planning?planNumber=${encodeURIComponent(plan.planNumber)}`
        : null,
      issue.source === "CAPACITY" ? "Buka Capacity Planning" : null,
    ),
  ].filter(Boolean);
}

function buildPlanReadiness(plan, capacity, materialReadiness) {
  const materialPartNames = new Map(
    (materialReadiness?.items || []).map((item) => [item.partCode, item.partName]),
  );
  const capacityIssues = (capacity?.readiness?.issues || [])
    .filter((issue) => ["blocking", "warning", "overridable"].includes(String(issue.severity || "").toLowerCase()))
    .filter((issue) => issue.planNumber === plan.planNumber || String(issue.code || "").startsWith("PLAN_"))
    .map((issue) => ({ ...issue, source: "CAPACITY" }));
  const materialIssues = (materialReadiness?.issues || []).map((issue) => ({
    ...issue,
    partName: issue.partName || materialPartNames.get(issue.partCode) || null,
    source: "MATERIAL",
  }));
  const issues = [...capacityIssues, ...materialIssues].map((issue) => {
    const severity = String(issue.severity || "WARNING").toUpperCase();
    return {
      ...issue,
      severity,
      title: [
        issue.partCode,
        issue.partName,
        issue.processName || issue.processCode,
        issue.machineName || issue.machineCode,
      ].filter(Boolean).join(" · ") || issue.code,
      references: planIssueReferences(issue, plan, materialReadiness?.mrpRunNumber),
    };
  });
  const blockingCount = issues.filter((issue) => issue.severity === "BLOCKING").length;
  const warningCount = issues.filter((issue) => issue.severity === "WARNING").length;
  const overridableCount = issues.filter((issue) => issue.severity === "OVERRIDABLE").length;
  const capacityOverrideRequired = overridableCount > 0 && plan.capacityOverrideApproved !== true;
  return {
    ready: blockingCount === 0 && !capacityOverrideRequired,
    releaseReady: blockingCount === 0 && !capacityOverrideRequired,
    capacityOverrideRequired,
    summary: {
      blocking: blockingCount,
      warning: warningCount,
      overridable: overridableCount,
      receiptOnlyFg: Number(capacity?.summary?.fgReceiptLineCount || 0),
      unscheduled: Number(capacity?.summary?.unscheduledCount || 0),
    },
    issues,
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

exports.listDailyPlans = (req, res, next) => {
  req.query = { ...(req.query || {}), sourceModule: "PPIC" };
  return dailyProductionScheduleController.list(req, res, next);
};

exports.getDailyPlan = (req, res, next) => {
  req.query = { ...(req.query || {}), sourceModule: "PPIC" };
  req.params.scheduleNumber = req.params.scheduleNumber || req.params.planNumber;
  return dailyProductionScheduleController.get(req, res, next);
};

exports.get = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber: req.params.planNumber, isDeleted: false }, include });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan" });
    const [snapshot, materialReadiness, capacity] = await Promise.all([
      withMpsSnapshot(plan),
      buildMaterialReadinessSnapshot(prisma, plan),
      buildCapacitySnapshot(prisma, {
        planNumber: plan.planNumber,
        startDate: plan.periodStart,
        endDate: plan.periodEnd,
      }),
    ]);
    const traced = await withManufacturingOrderTrace(snapshot);
    const displayPlan = await withPlanDisplayReferences(traced);
    res.json({
      ...serialize(displayPlan),
      materialReadiness,
      capacityReadiness: capacity.readiness,
      capacitySummary: capacity.summary,
      capacityUnscheduled: capacity.unscheduled,
      planReadiness: buildPlanReadiness(displayPlan, capacity, materialReadiness),
    });
  } catch (error) { next(error); }
};

exports.materialReadiness = async (req, res, next) => {
  try {
    res.json(await buildMaterialReadinessSnapshot(prisma, req.params.planNumber));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
};

exports.createFromMps = async (req, res, next) => {
  try {
    const mpsNumber = text(req.body?.mpsNumber);
    if (!mpsNumber) return res.status(400).json({ message: "MPS wajib dipilih." });
    const productionPercent = req.body?.productionPercent == null ? 100 : Number(req.body.productionPercent);
    if (!Number.isFinite(productionPercent) || productionPercent < 0 || productionPercent > 100) return res.status(400).json({ message: "Persentase Production Plan harus antara 0 sampai 100." });
    const mps = await prisma.mPS.findFirst({
      where: { mpsNumber, isDeleted: false },
      include: { details: { where: { isDeleted: false, status: { not: "Cancelled" } }, include: { part: true }, orderBy: [{ startDate: "asc" }, { lineNumber: "asc" }] } },
    });
    if (!mps) return res.status(404).json({ message: "MPS tidak ditemukan." });
    if (mps.status !== "Confirmed") return res.status(409).json({ message: "MPS harus Confirmed sebelum dibuat menjadi Production Plan." });
    const validDetails = derivePlanDetails(mps.details, productionPercent);
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
        const planMonth = monthStart(key);
        const existing = await tx.monthlyProductionPlan.findFirst({ where: { sourceType, planMonth: { gte: monthStart(planMonth), lte: utcMonthEndInstant(planMonth) }, isDeleted: false }, include });
        if (existing) {
          if (existing.status === "Draft") {
            let nextLineNumber = Math.max(0, ...existing.details.map((row) => number(row.lineNumber))) + 1;
            const matchedIds = new Set();
            for (const row of details) {
              const sourceLineMarker = `[MPS-LINE:${row.lineNumber}]`;
              const matched = existing.details.find((detail) => detail.mpsDetailId === row.id || String(detail.notes || "").includes(sourceLineMarker));
              const data = detailFromMps(row, matched?.lineNumber || nextLineNumber++);
              if (matched) { matchedIds.add(matched.id); await tx.monthlyProductionPlanDetail.update({ where: { id: matched.id }, data }); }
              else await tx.monthlyProductionPlanDetail.create({ data: { ...data, planId: existing.id } });
            }
            const stale = existing.details.filter((detail) => !matchedIds.has(detail.id));
            if (stale.length) await tx.monthlyProductionPlanDetail.updateMany({ where: { id: { in: stale.map((detail) => detail.id) } }, data: { isDeleted: true, status: "Cancelled", notes: "Synchronized: MPS line no longer active" } });
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
            notes: `Production plan dari ${mps.mpsNumber}; material check ${completedMrp.runNumber}; adjustment ${productionPercent}% (minimum SO aktual)`,
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
    res.status(201).json({ items: result, total: result.length, sourceMpsNumber: mps.mpsNumber, mrpRunNumber: completedMrp.runNumber, productionPercent });
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
    const capacity = await buildCapacitySnapshot(prisma, {
      ...(req.body || {}),
      planNumber: plan.planNumber,
      startDate: plan.periodStart,
      endDate: plan.periodEnd,
      manualAllocation: true,
    });
    const materialReadiness = await buildMaterialReadinessSnapshot(prisma, plan);
    const hasOverridable = Number(capacity.readiness.overridableCount || 0) > 0 || Number(capacity.summary.overloadedCells || 0) > 0;
    const overrideApproved = plan.capacityOverrideApproved === true;
    if (!capacity.readiness.ok || (hasOverridable && !overrideApproved)) {
      return res.status(409).json({ message: "Production Plan belum dapat direlease. Lengkapi alokasi manual pada Capacity Check, pastikan tiap delivery phase tercukupi, lalu selesaikan blocker routing/overload.", code: "CAPACITY_NOT_READY", capacity: { summary: capacity.summary, readiness: capacity.readiness, deliveryCoverage: capacity.deliveryCoverage, unscheduled: capacity.unscheduled } });
    }
    if (!materialReadiness.ready) {
      return res.status(409).json({
        message: "Production Plan belum dapat direlease. Supplier/lead time atau jadwal kedatangan material dan purchase part belum siap.",
        code: "MATERIAL_NOT_READY",
        materialReadiness,
      });
    }
    const updated = await prisma.monthlyProductionPlan.update({ where: { planNumber: plan.planNumber }, data: { status: "Released", releasedBy: req.user?.username || req.user?.email || null, releasedAt: new Date() }, include });
    res.json({ ...serialize(updated), materialReadiness });
  } catch (error) { next(error); }
};

// PPIC owns the monthly-to-daily conversion. The capacity snapshot is the
// source of machine/date allocation; Production only consumes the resulting
// Daily Production Plan and follows its MO / Material Issue references.
exports.convertToDailyPlans = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber: req.params.planNumber, isDeleted: false },
      include,
    });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan." });
    if (!["Released", "In Progress"].includes(plan.status)) {
      return res.status(409).json({
        message: `Production Plan harus Released sebelum dikonversi ke Daily Production Plan. Status saat ini ${plan.status}.`,
        code: "MONTHLY_PLAN_NOT_RELEASED",
      });
    }

    {
    const draftAllocations = await prisma.productionPlanAllocation.findMany({
      where: { planId: plan.id, isDeleted: false, status: "Draft" },
      include: {
        mbomProcess: {
          select: {
            id: true,
            processId: true,
            sequence: true,
            process: { select: { processCode: true, processName: true } },
          },
        },
      },
      orderBy: [{ scheduleDate: "asc" }, { lineNumber: "asc" }, { createdAt: "asc" }],
    });
    if (!draftAllocations.length) {
      return res.status(409).json({
        message: "Belum ada draft allocation MPP yang perlu dipublikasikan. Atur tanggal, mesin, shift, dan qty dari Capacity Check terlebih dahulu.",
        code: "MANUAL_MPP_ALLOCATION_REQUIRED",
      });
    }

    const manufacturingOrders = await prisma.manufacturingOrder.findMany({
      where: {
        monthlyProductionPlanNumber: plan.planNumber,
        isDeleted: false,
        status: { not: "Cancelled" },
      },
      include: {
        part: { select: { partCode: true } },
        workOrders: {
          where: { isDeleted: false, status: { not: "Cancelled" } },
          orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
        },
      },
      orderBy: [{ monthlyProductionPlanLineNumber: "asc" }, { createdAt: "asc" }],
    });
    if (!manufacturingOrders.length) {
      return res.status(409).json({
        message: "MPP sudah dapat dialokasikan sebelum release, tetapi publish ke Daily Plan memerlukan MO/WO reference. Buat MO reference lalu ulangi publish.",
        code: "MO_REFERENCE_REQUIRED_FOR_PUBLISH",
      });
    }

    const mosByLine = new Map();
    for (const mo of manufacturingOrders) {
      const lineNumber = number(mo.monthlyProductionPlanLineNumber);
      if (!mosByLine.has(lineNumber)) mosByLine.set(lineNumber, []);
      mosByLine.get(lineNumber).push(mo);
    }
    const parentMOs = mosByLine.get(1) || [];
    const mosForLine = (lineNumber) => {
      const direct = mosByLine.get(number(lineNumber)) || [];
      return direct.length ? direct : parentMOs;
    };
    const moIds = manufacturingOrders.map((mo) => mo.id);
    const processIds = [...new Set(draftAllocations.map((row) => row.mbomProcess?.processId).filter(Boolean))];
    const committed = await prisma.dailyProductionSchedule.groupBy({
      by: ["moId", "processId"],
      where: {
        moId: { in: moIds },
        processId: { in: processIds },
        isDeleted: false,
        status: { in: ["Draft", "Released", "In Progress", "Completed"] },
      },
      _sum: { plannedQty: true },
    });
    const committedByMoProcess = new Map(committed.map((row) => [
      `${row.moId}|${row.processId}`,
      number(row._sum.plannedQty),
    ]));
    const remainingByMoProcess = new Map();
    const desired = [];
    const publishBlockers = [];

    for (const allocation of draftAllocations) {
      const processId = allocation.mbomProcess?.processId;
      const candidateMos = mosForLine(allocation.lineNumber);
      if (!processId) {
        publishBlockers.push({ allocationId: allocation.id, reason: "ROUTING_PROCESS_REFERENCE_MISSING" });
        continue;
      }
      if (!candidateMos.length) {
        publishBlockers.push({ allocationId: allocation.id, lineNumber: allocation.lineNumber, reason: "MO_REFERENCE_MISSING" });
        continue;
      }
      let qtyToAssign = number(allocation.plannedQty);
      for (const mo of candidateMos) {
        if (qtyToAssign <= 0.000001) break;
        const remainingKey = `${mo.id}|${processId}`;
        if (!remainingByMoProcess.has(remainingKey)) {
          remainingByMoProcess.set(
            remainingKey,
            Math.max(number(mo.qtyPlanned) - number(committedByMoProcess.get(remainingKey)), 0),
          );
        }
        const available = number(remainingByMoProcess.get(remainingKey));
        if (available <= 0) continue;
        const assignedQty = normalizeQuantity(Math.min(qtyToAssign, available), allocation.uomCode || mo.uomCode);
        const workOrder = (mo.workOrders || []).find((wo) => wo.processId === processId);
        if (!workOrder) {
          publishBlockers.push({
            allocationId: allocation.id,
            moNumber: mo.moNumber,
            processCode: allocation.mbomProcess?.process?.processCode || null,
            reason: "WORK_ORDER_REFERENCE_MISSING",
          });
          qtyToAssign = 0;
          break;
        }
        desired.push({ allocation, mo, workOrder, processId, assignedQty });
        remainingByMoProcess.set(remainingKey, available - assignedQty);
        qtyToAssign -= assignedQty;
      }
      if (qtyToAssign > 0.000001) {
        publishBlockers.push({
          allocationId: allocation.id,
          lineNumber: allocation.lineNumber,
          remainingQty: qtyToAssign,
          reason: "MO_QTY_NOT_AVAILABLE",
        });
      }
    }
    if (publishBlockers.length) {
      return res.status(409).json({
        message: "Draft allocation belum dapat dipublikasikan karena MO/WO reference atau sisa qty belum mencukupi.",
        code: "ALLOCATION_PUBLISH_BLOCKED",
        blockers: publishBlockers,
      });
    }

    const published = await prisma.$transaction(async (tx) => {
      const rows = [];
      for (const item of desired) {
        const marker = `[PPIC-MPP-ALLOCATION:${item.allocation.id}:${item.mo.moNumber}]`;
        const scheduleDate = new Date(item.allocation.scheduleDate);
        rows.push(await tx.dailyProductionSchedule.create({
          data: {
            scheduleNumber: await nextDailyPlanNumber(tx, scheduleDate),
            scheduleDate,
            shift: item.allocation.shift,
            moId: item.mo.id,
            moNumber: item.mo.moNumber,
            woId: item.workOrder.id,
            woNumber: item.workOrder.woNumber,
            partId: item.mo.partId,
            partCode: item.mo.part?.partCode || null,
            processId: item.processId,
            machineId: item.allocation.routingMode === "INHOUSE" ? item.allocation.machineId : null,
            plannedQty: item.assignedQty,
            uomCode: item.allocation.uomCode || item.mo.uomCode || null,
            sequence: number(item.allocation.mbomProcess?.sequence),
            status: "Draft",
            notes: `${marker} mode ${item.allocation.routingMode}${item.allocation.vendorId ? `; vendor ${item.allocation.vendorId}` : ""}${item.allocation.notes ? `; ${item.allocation.notes}` : ""}`,
            createdBy: req.user?.username || req.user?.email || null,
          },
        }));
      }
      await tx.productionPlanAllocation.updateMany({
        where: { id: { in: draftAllocations.map((row) => row.id) }, status: "Draft", isDeleted: false },
        data: {
          status: "Published",
          publishedAt: new Date(),
          publishedBy: req.user?.username || req.user?.email || null,
        },
      });
      return rows;
    });
    return res.status(201).json({
      planNumber: plan.planNumber,
      items: published,
      total: published.length,
      summary: {
        createdCount: published.length,
        publishedAllocationCount: draftAllocations.length,
        updatedCount: 0,
      },
      ownership: {
        planner: "PPIC",
        source: "Manual MPP Allocation",
        executor: "Production",
      },
    });
    }

    const capacity = await buildCapacitySnapshot(prisma, {
      ...(req.body || {}),
      planNumber: plan.planNumber,
      startDate: plan.periodStart,
      endDate: plan.periodEnd,
      ignoreDraftDailyPlans: true,
    });
    if (!capacity.readiness.ok) {
      return res.status(409).json({
        message: "Daily Production Plan belum dapat dibuat karena Capacity Check masih mempunyai blocker routing, mesin, atau cycle time.",
        code: "CAPACITY_BLOCKING",
        capacity: {
          summary: capacity.summary,
          readiness: capacity.readiness,
          unscheduled: capacity.unscheduled,
        },
      });
    }

    const unscheduled = (capacity.unscheduled || []).filter((row) => row.source === "PROPOSED" && row.reference === plan.planNumber);
    const allowPartial = Boolean(req.body?.allowPartial || plan.capacityOverrideApproved);
    if (unscheduled.length && !allowPartial) {
      return res.status(409).json({
        message: "Sebagian load belum memperoleh mesin/tanggal. Selesaikan Capacity Check atau gunakan override yang sudah di-approve.",
        code: "DAILY_PLAN_CAPACITY_INCOMPLETE",
        capacity: {
          summary: capacity.summary,
          readiness: capacity.readiness,
          unscheduled,
        },
      });
    }

    const rawAllocations = [];
    for (const machine of capacity.machines || []) {
      for (const [scheduleDate, cell] of Object.entries(machine.cells || {})) {
        for (const item of cell.items || []) {
          if (item.source !== "PROPOSED" || item.reference !== plan.planNumber || number(item.qty) <= 0 || !item.mbomProcessId) continue;
          const shiftCount = Math.min(Math.max(number(cell.capacityRule?.shiftsPerDay) || 1, 1), 3);
          const itemUom = item.uomCode || null;
          const shiftQuantities = splitQuantity(item.qty, shiftCount, itemUom);
          let remainingQty = normalizeQuantity(item.qty, itemUom);
          for (let shiftIndex = 1; shiftIndex <= shiftCount; shiftIndex += 1) {
            const shiftQty = shiftQuantities[shiftIndex - 1];
            remainingQty -= shiftQty;
            if (shiftQty <= 0) continue;
            rawAllocations.push({
              ...item,
              scheduleDate,
              shift: String(shiftIndex),
              qty: shiftQty,
              minutes: number(item.minutes) / shiftCount,
              machineId: machine.id,
              routingMode: "INHOUSE",
            });
          }
        }
      }
    }
    for (const item of capacity.vendorAssignments || []) {
      if (item.planNumber !== plan.planNumber || number(item.qty) <= 0 || !item.mbomProcessId) continue;
      rawAllocations.push({
        ...item,
        scheduleDate: String(item.scheduleDate).slice(0, 10),
        shift: "VENDOR",
        machineId: null,
        routingMode: "VENDOR",
      });
    }
    rawAllocations.sort((left, right) =>
      String(left.scheduleDate).localeCompare(String(right.scheduleDate))
      || number(left.sequence) - number(right.sequence)
      || String(left.shift).localeCompare(String(right.shift), undefined, { numeric: true }));

    if (!rawAllocations.length) {
      return res.status(409).json({
        message: "Capacity Check belum menghasilkan allocation harian untuk Production Plan ini.",
        code: "NO_DAILY_CAPACITY_ALLOCATION",
        capacity: { summary: capacity.summary, readiness: capacity.readiness, unscheduled },
      });
    }

    const lineNumbers = [...new Set(rawAllocations.map((row) => number(row.lineNumber)).filter(Boolean))];
    const routeIds = [...new Set(rawAllocations.map((row) => row.mbomProcessId).filter(Boolean))];
    const [manufacturingOrders, routes] = await Promise.all([
      prisma.manufacturingOrder.findMany({
        where: {
          monthlyProductionPlanNumber: plan.planNumber,
          isDeleted: false,
          status: { not: "Cancelled" },
        },
        include: {
          part: { select: { id: true, partCode: true } },
          workOrders: {
            where: { isDeleted: false, status: { not: "Cancelled" } },
            select: { id: true, woNumber: true, processId: true, sequence: true, machineId: true },
            orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
          },
        },
        orderBy: [{ monthlyProductionPlanLineNumber: "asc" }, { createdAt: "asc" }],
      }),
      prisma.mBOMProcess.findMany({
        where: { id: { in: routeIds }, isDeleted: false },
        select: { id: true, processId: true, sequence: true },
      }),
    ]);
    if (!manufacturingOrders.length) {
      return res.status(409).json({
        message: "Belum ada MO reference dari Monthly Production Plan. Buat/release MO dari PPIC terlebih dahulu.",
        code: "MO_REFERENCE_REQUIRED",
      });
    }

    const routeById = new Map(routes.map((row) => [row.id, row]));
    const mosByLine = new Map();
    for (const mo of manufacturingOrders) {
      const key = number(mo.monthlyProductionPlanLineNumber);
      if (!mosByLine.has(key)) mosByLine.set(key, []);
      mosByLine.get(key).push(mo);
    }
    const parentMOs = mosByLine.get(1) || [];
    const mosForLine = (lineNumber) => {
      const direct = mosByLine.get(number(lineNumber)) || [];
      // A process/WIP MPP line is executed by the FG parent MO's routing.
      // Falling back to that MO prevents invalid child MOs without an MBOM
      // and keeps the daily plan linked to the actual production order.
      return direct.length ? direct : parentMOs;
    };
    const missingMoLines = [...new Set(rawAllocations
      .map((row) => number(row.lineNumber))
      .filter((lineNumber) => !mosForLine(lineNumber).length))];

    const markerPrefix = `[PPIC-DPP:${plan.planNumber}:`;
    const moIds = manufacturingOrders.map((row) => row.id);
    const existingSchedules = await prisma.dailyProductionSchedule.findMany({
      where: {
        isDeleted: false,
        moId: { in: moIds },
        OR: [
          { notes: { contains: markerPrefix } },
          { status: { notIn: ["Draft", "Cancelled"] } },
        ],
      },
      orderBy: [{ scheduleDate: "asc" }, { shift: "asc" }, { sequence: "asc" }],
    });
    const committedByMoProcess = new Map();
    for (const row of existingSchedules.filter((item) => item.status !== "Draft" && item.status !== "Cancelled" && item.processId)) {
      const key = `${row.moId}|${row.processId}`;
      committedByMoProcess.set(key, number(committedByMoProcess.get(key)) + number(row.plannedQty));
    }
    const remainingByMoProcess = new Map();
    const desired = [];
    const capacitySkipped = [];

    for (const allocation of rawAllocations) {
      const route = routeById.get(allocation.mbomProcessId);
      if (!route?.processId) {
        capacitySkipped.push({ ...allocation, reason: "ROUTING_PROCESS_REFERENCE_MISSING" });
        continue;
      }
      let qtyToAssign = number(allocation.qty);
      for (const mo of mosForLine(number(allocation.lineNumber))) {
        const remainingKey = `${mo.id}|${route.processId}`;
        if (!remainingByMoProcess.has(remainingKey)) {
          remainingByMoProcess.set(
            remainingKey,
            Math.max(number(mo.qtyPlanned) - number(committedByMoProcess.get(remainingKey)), 0),
          );
        }
        const availableForMo = number(remainingByMoProcess.get(remainingKey));
        if (availableForMo <= 0 || qtyToAssign <= 0) continue;
        const assignedQty = isDiscreteUom(allocation.uomCode)
          ? Math.min(Math.round(qtyToAssign), Math.round(availableForMo))
          : Math.min(qtyToAssign, availableForMo);
        const workOrder = (mo.workOrders || []).find((row) => row.processId === route.processId) || null;
        desired.push({
          ...allocation,
          processId: route.processId,
          sequence: number(allocation.sequence || route.sequence),
          qty: assignedQty,
          mo,
          workOrder,
        });
        remainingByMoProcess.set(remainingKey, availableForMo - assignedQty);
        qtyToAssign -= assignedQty;
      }
      if (qtyToAssign > 0.000001) capacitySkipped.push({ ...allocation, qty: qtyToAssign, reason: "MO_RELEASE_QTY_NOT_AVAILABLE" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const draftRows = existingSchedules.filter((row) => row.status === "Draft" && String(row.notes || "").includes(markerPrefix));
      const draftByMarker = new Map(draftRows.map((row) => [String(row.notes || "").match(/\[PPIC-DPP:[^\]]+\]/)?.[0], row]).filter(([marker]) => marker));
      const retainedDraftIds = new Set();
      const rows = [];
      let createdCount = 0;
      let updatedCount = 0;

      for (const allocation of desired) {
        const marker = dailyPlanMarker(plan.planNumber, allocation, allocation.mo.moNumber);
        const existing = draftByMarker.get(marker);
        const scheduleDate = new Date(`${allocation.scheduleDate}T00:00:00.000Z`);
        const data = {
          scheduleDate,
          shift: allocation.shift,
          moId: allocation.mo.id,
          moNumber: allocation.mo.moNumber,
          woId: allocation.workOrder?.id || null,
          woNumber: allocation.workOrder?.woNumber || null,
          partId: allocation.mo.partId || null,
          partCode: allocation.partCode || allocation.mo.part?.partCode || null,
          processId: allocation.processId,
          machineId: allocation.routingMode === "INHOUSE" ? allocation.machineId : null,
          plannedQty: normalizeQuantity(allocation.qty, allocation.uomCode || allocation.mo.uomCode),
          uomCode: allocation.uomCode || allocation.mo.uomCode || null,
          sequence: number(allocation.sequence),
          status: "Draft",
          notes: `${marker} Capacity ${number(allocation.minutes)} min; mode ${allocation.routingMode}${allocation.vendorId ? `; vendor ${allocation.vendorId}` : ""}${allocation.diesId ? `; dies ${allocation.diesId}` : ""}.`,
          createdBy: req.user?.username || req.user?.email || null,
        };
        if (existing) {
          retainedDraftIds.add(existing.id);
          rows.push(await tx.dailyProductionSchedule.update({ where: { id: existing.id }, data }));
          updatedCount += 1;
        } else {
          rows.push(await tx.dailyProductionSchedule.create({
            data: { scheduleNumber: await nextDailyPlanNumber(tx, scheduleDate), ...data },
          }));
          createdCount += 1;
        }
      }

      const staleIds = draftRows.filter((row) => !retainedDraftIds.has(row.id)).map((row) => row.id);
      if (staleIds.length) {
        await tx.dailyProductionSchedule.updateMany({
          where: { id: { in: staleIds } },
          data: { isDeleted: true, status: "Cancelled" },
        });
      }
      return { rows, createdCount, updatedCount, cancelledCount: staleIds.length };
    });

    res.status(result.createdCount ? 201 : 200).json({
      planNumber: plan.planNumber,
      ownership: {
        planner: "PPIC",
        source: "Monthly Production Plan + Capacity Check",
        executor: "Production",
      },
      items: result.rows,
      total: result.rows.length,
      summary: {
        createdCount: result.createdCount,
        updatedCount: result.updatedCount,
        cancelledDraftCount: result.cancelledCount,
        unscheduledCount: unscheduled.length,
        skippedCapacityCount: capacitySkipped.length,
        missingMoLineCount: missingMoLines.length,
      },
      warnings: {
        unscheduled,
        missingMoLines,
        capacitySkipped,
      },
      capacity: {
        parameters: capacity.parameters,
        summary: capacity.summary,
        readiness: capacity.readiness,
      },
    });
  } catch (error) { next(error); }
};

// Persist PPIC's date/shift/qty decision before MPP release. This draft
// allocation deliberately has no MO/WO dependency; it is published to Daily
// Production Plan only after release has created the production references.
exports.createManualDailyPlan = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber: req.params.planNumber, isDeleted: false },
      include,
    });
    if (!plan) return res.status(404).json({ message: "Production Plan tidak ditemukan." });
    if (!["Draft", "Confirmed", "Released", "In Progress"].includes(plan.status)) {
      return res.status(409).json({ message: `MPP berstatus ${plan.status} tidak dapat menerima alokasi produksi baru.` });
    }
    const lineNumber = Number(req.body?.lineNumber);
    const mbomProcessId = text(req.body?.mbomProcessId);
    const scheduleDateText = String(req.body?.scheduleDate || "").slice(0, 10);
    const scheduleDate = new Date(`${scheduleDateText}T00:00:00.000Z`);
    const routingMode = String(req.body?.routingMode || "INHOUSE").toUpperCase();
    const shift = routingMode === "VENDOR" ? "VENDOR" : String(req.body?.shift || "1");
    const plannedQty = number(req.body?.plannedQty);
    const machineId = text(req.body?.machineId);
    const vendorId = text(req.body?.vendorId);
    const notes = text(req.body?.notes);
    if (!Number.isInteger(lineNumber) || lineNumber < 1 || !mbomProcessId || Number.isNaN(scheduleDate.getTime()) || plannedQty <= 0) {
      return res.status(400).json({ message: "Line, routing process, tanggal, dan qty alokasi wajib diisi." });
    }
    if (scheduleDate < plan.periodStart || scheduleDate > plan.periodEnd) {
      return res.status(400).json({ message: "Tanggal alokasi harus berada dalam periode MPP." });
    }
    if (!["INHOUSE", "VENDOR"].includes(routingMode) || (routingMode === "INHOUSE" && (!machineId || !["1", "2", "3"].includes(shift))) || (routingMode === "VENDOR" && !vendorId)) {
      return res.status(400).json({ message: "Pilih shift dan mesin untuk in-house, atau vendor untuk proses vendor." });
    }
    const line = plan.details.find((row) => Number(row.lineNumber) === lineNumber && !row.isDeleted);
    if (!line) return res.status(404).json({ message: "Line Production Plan tidak ditemukan." });
    const route = await prisma.mBOMProcess.findFirst({
      where: { id: mbomProcessId, isDeleted: false },
      include: {
        mbomDetail: { select: { partId: true, part: { select: { partCode: true } } } },
        process: { select: { processCode: true, processName: true } },
      },
    });
    if (!route || (line.partId && route.mbomDetail?.partId !== line.partId) || (!line.partId && route.mbomDetail?.part?.partCode !== line.partCode)) {
      return res.status(409).json({ message: "Routing process tidak sesuai dengan line Production Plan." });
    }
    if (!route.processId) return res.status(409).json({ message: "Routing belum mempunyai reference process." });
    if (routingMode === "INHOUSE") {
      const allowedMachines = [route.machineId, ...(Array.isArray(route.alternativeMachineIds) ? route.alternativeMachineIds : [])].filter(Boolean);
      if (!allowedMachines.includes(machineId)) return res.status(409).json({ message: "Mesin bukan mesin utama/alternatif pada routing MBOM." });
      if (!await prisma.machine.findFirst({ where: { id: machineId, isDeleted: false, status: "Active" } })) {
        return res.status(409).json({ message: "Mesin tidak aktif atau tidak ditemukan." });
      }
    } else if (!await prisma.vendor.findFirst({ where: { id: vendorId, isDeleted: false, status: "Active" } })) {
      return res.status(409).json({ message: "Vendor tidak aktif atau tidak ditemukan." });
    }

    const allocated = await prisma.productionPlanAllocation.aggregate({
      where: {
        planId: plan.id,
        lineNumber,
        mbomProcessId,
        isDeleted: false,
        status: { in: ["Draft", "Published"] },
      },
      _sum: { plannedQty: true },
    });
    const normalizedQty = normalizeQuantity(plannedQty, line.uomCode);
    const remainingQty = Math.max(number(line.qtyPlanned) - number(allocated._sum.plannedQty), 0);
    if (normalizedQty > remainingQty + 0.000001) {
      return res.status(409).json({ message: `Qty alokasi melebihi sisa MPP untuk proses ini. Sisa tersedia ${remainingQty} ${line.uomCode || ""}.` });
    }

    const allocation = await prisma.productionPlanAllocation.create({
      data: {
        planId: plan.id,
        lineNumber,
        mbomProcessId,
        scheduleDate,
        shift,
        machineId: routingMode === "INHOUSE" ? machineId : null,
        routingMode,
        vendorId: routingMode === "VENDOR" ? vendorId : null,
        plannedQty: normalizedQty,
        uomCode: line.uomCode || null,
        status: "Draft",
        notes,
        createdBy: req.user?.username || req.user?.email || null,
      },
    });
    res.status(201).json({
      planNumber: plan.planNumber,
      allocation,
      summary: {
        createdCount: 1,
        plannedQty: normalizedQty,
        remainingQty: normalizeQuantity(remainingQty - normalizedQty, line.uomCode),
      },
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

exports.removeManualAllocation = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber: req.params.planNumber, isDeleted: false },
      select: { id: true, planNumber: true },
    });
    if (!plan) return res.status(404).json({ message: "Production Plan tidak ditemukan." });
    const allocation = await prisma.productionPlanAllocation.findFirst({
      where: { id: req.params.allocationId, planId: plan.id, isDeleted: false },
    });
    if (!allocation) return res.status(404).json({ message: "Draft allocation tidak ditemukan." });
    if (allocation.status !== "Draft") {
      return res.status(409).json({ message: "Allocation yang sudah dipublikasikan tidak dapat dihapus dari Capacity Check." });
    }
    const updated = await prisma.productionPlanAllocation.update({
      where: { id: allocation.id },
      data: { status: "Cancelled", isDeleted: true },
    });
    res.json({ planNumber: plan.planNumber, allocation: updated });
  } catch (error) { next(error); }
};

exports.capacityOverride = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber: req.params.planNumber, isDeleted: false }, include });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan." });
    if (!["Draft", "Confirmed"].includes(plan.status)) return res.status(409).json({ message: "Capacity override hanya dapat dilakukan sebelum release." });
    const reason = String(req.body?.reason || req.body?.notes || "").trim();
    if (reason.length < 10) return res.status(400).json({ message: "Reason override minimal 10 karakter." });
    const updated = await prisma.monthlyProductionPlan.update({ where: { planNumber: plan.planNumber }, data: { capacityOverrideApproved: true, capacityOverrideReason: reason, capacityOverrideBy: req.user?.username || req.user?.email || "system", capacityOverrideAt: new Date() }, include });
    res.json({ ...serialize(updated), capacityOverride: { approved: true, reason } });
  } catch (error) { next(error); }
};

// PPIC may rebalance a plan to a machine alternative defined in the BOM routing.
// This deliberately writes a plan-level assignment, never mutating the MBOM
// default machine used by future plans.
exports.assignCapacityMachine = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber: req.params.planNumber, isDeleted: false }, include });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan." });
    if (!['Draft', 'Confirmed'].includes(plan.status)) return res.status(409).json({ message: "Penggantian mesin hanya dapat dilakukan sebelum Production Plan release." });
    const lineNumber = Number(req.body?.lineNumber);
    const mbomProcessId = text(req.body?.mbomProcessId);
    const machineId = text(req.body?.machineId);
    const diesId = text(req.body?.diesId);
    const vendorId = text(req.body?.vendorId);
    const routingMode = String(req.body?.routingMode || "INHOUSE").toUpperCase();
    const scheduleDate = new Date(`${String(req.body?.scheduleDate || '').slice(0, 10)}T00:00:00.000Z`);
    const reason = String(req.body?.reason || '').trim();
    if (!Number.isInteger(lineNumber) || lineNumber < 1 || !mbomProcessId || Number.isNaN(scheduleDate.getTime())) return res.status(400).json({ message: "Line, routing process, dan tanggal assignment wajib dipilih." });
    if (!["INHOUSE", "VENDOR"].includes(routingMode) || (routingMode === "INHOUSE" && !machineId) || (routingMode === "VENDOR" && !vendorId)) return res.status(400).json({ message: "Pilih mesin untuk INHOUSE atau vendor untuk VENDOR." });
    if (reason.length < 10) return res.status(400).json({ message: "Alasan perpindahan mesin minimal 10 karakter." });
    const line = plan.details.find((item) => Number(item.lineNumber) === lineNumber && !item.isDeleted);
    if (!line) return res.status(404).json({ message: "Detail Production Plan tidak ditemukan." });
    const route = await prisma.mBOMProcess.findFirst({ where: { id: mbomProcessId, isDeleted: false }, include: { mbomDetail: { select: { partId: true, part: { select: { partCode: true } } } } } });
    if (!route || (line.partId && route.mbomDetail?.partId !== line.partId) || (!line.partId && route.mbomDetail?.part?.partCode !== line.partCode)) return res.status(409).json({ message: "Routing process tidak sesuai dengan part pada Production Plan." });
    const alternatives = [route.machineId, ...(Array.isArray(route.alternativeMachineIds) ? route.alternativeMachineIds : [])].filter(Boolean);
    if (routingMode === "INHOUSE" && !alternatives.includes(machineId)) return res.status(409).json({ message: "Mesin bukan mesin utama/alternatif routing BOM." });
    const machine = machineId ? await prisma.machine.findFirst({ where: { id: machineId, isDeleted: false, status: 'Active' }, select: { id: true, machineCode: true, machineName: true } }) : null;
    if (routingMode === "INHOUSE" && !machine) return res.status(409).json({ message: "Mesin tidak aktif atau tidak ditemukan." });
    if (diesId && !await prisma.dies.findFirst({ where: { id: diesId, isDeleted: false, status: "Active" } })) return res.status(409).json({ message: "Dies/QD tidak aktif atau tidak ditemukan." });
    if (routingMode === "VENDOR" && !await prisma.vendor.findFirst({ where: { id: vendorId, isDeleted: false, status: "Active" } })) return res.status(409).json({ message: "Vendor tidak aktif atau tidak ditemukan." });
    const override = await prisma.capacityMachineOverride.upsert({
      where: { planId_lineNumber_mbomProcessId_scheduleDate: { planId: plan.id, lineNumber, mbomProcessId, scheduleDate } },
      create: { planId: plan.id, lineNumber, mbomProcessId, scheduleDate, machineId: routingMode === "INHOUSE" ? machineId : null, diesId, routingMode, vendorId: routingMode === "VENDOR" ? vendorId : null, reason, changedBy: req.user?.username || req.user?.email || 'system' },
      update: { machineId: routingMode === "INHOUSE" ? machineId : null, diesId, routingMode, vendorId: routingMode === "VENDOR" ? vendorId : null, reason, changedBy: req.user?.username || req.user?.email || 'system', changedAt: new Date(), isDeleted: false },
    });
    res.json({ planNumber: plan.planNumber, lineNumber, mbomProcessId, override: { ...override, machine } });
  } catch (error) { next(error); }
};

exports.setCapacityDay = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber: req.params.planNumber, isDeleted: false }, select: { id: true, planNumber: true, status: true, periodStart: true, periodEnd: true } });
    if (!plan) return res.status(404).json({ message: "Production Plan tidak ditemukan." });
    if (!['Draft', 'Confirmed'].includes(plan.status)) return res.status(409).json({ message: "Capacity harian hanya dapat diubah sebelum plan release." });
    const scheduleDate = new Date(`${String(req.body?.scheduleDate || '').slice(0, 10)}T00:00:00.000Z`);
    const machineId = text(req.body?.machineId);
    const dayStatus = String(req.body?.dayStatus || 'WORKING').toUpperCase();
    const shiftsPerDay = req.body?.shiftsPerDay == null ? null : Number(req.body.shiftsPerDay);
    const reason = String(req.body?.reason || "").trim();
    if (Number.isNaN(scheduleDate.getTime()) || scheduleDate < plan.periodStart || scheduleDate > plan.periodEnd) return res.status(400).json({ message: "Tanggal harus berada dalam periode Production Plan." });
    if (!['WORKING', 'HOLIDAY', 'OVERLOAD'].includes(dayStatus) || (shiftsPerDay != null && (![1, 2, 3].includes(shiftsPerDay)))) return res.status(400).json({ message: "Status atau jumlah shift harian tidak valid." });
    const time = (value) => value && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value)) ? String(value) : null;
    const overtimeStart = time(req.body?.overtimeStart);
    const overtimeEnd = time(req.body?.overtimeEnd);
    if (Boolean(overtimeStart) !== Boolean(overtimeEnd)) return res.status(400).json({ message: "Jam mulai dan selesai lembur harus diisi berpasangan." });
    if (overtimeStart && overtimeEnd && overtimeEnd <= overtimeStart) return res.status(400).json({ message: "Jam selesai lembur harus setelah jam mulai." });
    if (reason.length < 5) return res.status(400).json({ message: "Alasan perubahan capacity harian minimal 5 karakter." });
    if (!machineId || !await prisma.machine.findFirst({ where: { id: machineId, isDeleted: false } })) return res.status(400).json({ message: "Mesin wajib dipilih." });
    const row = await prisma.capacityDayOverride.upsert({
      where: { planId_machineId_scheduleDate: { planId: plan.id, machineId, scheduleDate } },
      create: {
        planId: plan.id,
        machineId,
        scheduleDate,
        dayStatus,
        shiftsPerDay,
        overtimeStart,
        overtimeEnd,
        reason,
        changedBy: req.user?.username || req.user?.email || 'system',
      },
      update: {
        dayStatus,
        shiftsPerDay,
        overtimeStart,
        overtimeEnd,
        reason,
        changedBy: req.user?.username || req.user?.email || 'system',
        changedAt: new Date(),
        isDeleted: false,
      },
    });
    res.json(row);
  } catch (error) { next(error); }
};

// Global machine calendar: usable even when no MPP/Production Plan exists.
// It is intentionally separate from plan-scoped overrides so a global rule
// cannot accidentally mutate a specific plan.
exports.setGlobalCapacityDay = async (req, res, next) => {
  try {
    const scheduleDate = new Date(`${String(req.body?.scheduleDate || '').slice(0, 10)}T00:00:00.000Z`);
    const machineId = text(req.body?.machineId);
    const dayStatus = String(req.body?.dayStatus || 'WORKING').toUpperCase();
    const shiftsPerDay = req.body?.shiftsPerDay == null ? null : Number(req.body.shiftsPerDay);
    const reason = String(req.body?.reason || '').trim();
    if (Number.isNaN(scheduleDate.getTime()) || !machineId) return res.status(400).json({ message: 'Mesin dan tanggal wajib dipilih.' });
    if (!['WORKING', 'HOLIDAY', 'OVERLOAD'].includes(dayStatus) || (shiftsPerDay != null && ![1, 2, 3].includes(shiftsPerDay))) return res.status(400).json({ message: 'Status atau jumlah shift harian tidak valid.' });
    const time = (value) => value && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value)) ? String(value) : null;
    const overtimeStart = time(req.body?.overtimeStart);
    const overtimeEnd = time(req.body?.overtimeEnd);
    if (Boolean(overtimeStart) !== Boolean(overtimeEnd)) return res.status(400).json({ message: 'Jam mulai dan selesai lembur harus diisi berpasangan.' });
    if (overtimeStart && overtimeEnd && overtimeEnd <= overtimeStart) return res.status(400).json({ message: 'Jam selesai lembur harus setelah jam mulai.' });
    if (reason.length < 5) return res.status(400).json({ message: 'Alasan perubahan capacity harian minimal 5 karakter.' });
    if (!await prisma.machine.findFirst({ where: { id: machineId, isDeleted: false }, select: { id: true } })) return res.status(400).json({ message: 'Mesin tidak ditemukan.' });
    const row = await prisma.capacityCalendarOverride.upsert({
      where: { machineId_scheduleDate: { machineId, scheduleDate } },
      create: { machineId, scheduleDate, dayStatus, shiftsPerDay, overtimeStart, overtimeEnd, reason, changedBy: req.user?.username || req.user?.email || 'system' },
      update: { dayStatus, shiftsPerDay, overtimeStart, overtimeEnd, reason, changedBy: req.user?.username || req.user?.email || 'system', changedAt: new Date(), isDeleted: false },
    });
    res.json({ scope: 'GLOBAL', ...row });
  } catch (error) { next(error); }
};
