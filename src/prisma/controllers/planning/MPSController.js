const { prisma } = require("../../index");
const { getFormulaSet, evaluateFromSet } = require("../../services/masterFormulaService");
const { normalizeQuantity } = require("../../utils/uomQuantity");
const {
  planningMonthKey: monthKey,
  utcMonthStart,
  utcMonthEnd,
  nextPlanningMonthKey,
} = require("../../utils/planningMonth");
const { compareRoutingOperations } = require("../../utils/routingSequence");
const { syncMonthlyMps, previewMonthlyMbomSelections, normalizeMpsRunSelection } = require("../../services/planning/monthlyPlanningService");
const { planningAnchorMonth } = require("../../services/planning/demandPlanningService");
const { resolveMbomRevision, selectedRevisionId } = require("../../services/planning/mbomRevisionService");

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const text = (value) => String(value ?? "").trim() || null;
const date = (value) => value ? new Date(value) : null;
const include = { details: { where: { isDeleted: false }, orderBy: [{ startDate: "asc" }, { lineNumber: "asc" }], include: { part: { include: { process: true } }, forecastDetail: true, demandSources: { orderBy: [{ sourceType: "asc" }, { sourceNumber: "asc" }] }, mbom: true } } };
const GENERATED_PROCESS_PREFIX = "[MRP-PRODUCTION]";
const FG_RECEIPT_PREFIX = "[FG-RECEIPT]";
const isGeneratedProcess = (row) => String(row?.notes || "").startsWith(GENERATED_PROCESS_PREFIX);
function evaluateMpsBuffer(formulas, variables) {
  const result = evaluateFromSet(formulas, "MPS_BUFFER_QTY", variables);
  // MPS defines gross demand. Inventory is netted exactly once in MRP; using
  // FG stock here would reduce the same stock again during MRP explosion.
  return Math.max(result, 0);
}
const sourceKeyFor = (forecastNumber, periodKey, attempt = 0) => `FORECAST:${forecastNumber}:${periodKey}${attempt > 0 ? `:PARTIAL-${attempt}` : ""}`;
const sourcePeriodKey = (forecastNumber, sourceKey, fallback) => {
  const prefix = `FORECAST:${forecastNumber}:`;
  if (!String(sourceKey || "").startsWith(prefix)) return fallback;
  return String(sourceKey).slice(prefix.length).split(":")[0] || fallback;
};

function preferredExistingMps(left, right) {
  const rank = { Released: 5, Completed: 4, Confirmed: 3, Draft: 2, Cancelled: 1 };
  const difference = number(rank[right?.status]) - number(rank[left?.status]);
  if (difference) return difference > 0 ? right : left;
  return new Date(left?.createdAt || 0) <= new Date(right?.createdAt || 0) ? left : right;
}

async function existingMpsByMonth(tx, forecastNumber, periodKeys) {
  const wanted = new Set(periodKeys);
  const rows = await tx.mPS.findMany({
    where: { forecastNumber, isDeleted: false },
    include,
    orderBy: { createdAt: "asc" },
  });
  const result = new Map();
  for (const row of rows) {
    const key = sourcePeriodKey(forecastNumber, row.sourceKey, monthKey(row.periodStart));
    if (!wanted.has(key)) continue;
    result.set(key, result.has(key) ? preferredExistingMps(result.get(key), row) : row);
  }
  return result;
}

async function allMpsByMonth(tx, forecastNumber, periodKeys) {
  const wanted = new Set(periodKeys);
  const rows = await tx.mPS.findMany({
    where: { forecastNumber, isDeleted: false },
    include,
    orderBy: { createdAt: "asc" },
  });
  const result = new Map();
  for (const row of rows) {
    const key = sourcePeriodKey(forecastNumber, row.sourceKey, monthKey(row.periodStart));
    if (!wanted.has(key)) continue;
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(row);
  }
  return result;
}

function mpsResponse(docs, options = {}) {
  return {
    ...docs[0],
    items: docs,
    mpsNumbers: docs.map((doc) => doc.mpsNumber),
    idempotent: options.idempotent === true,
    createdCount: number(options.createdCount),
    message: options.idempotent
      ? `${docs.length} MPS bulanan sudah tersedia; tidak ada dokumen duplikat yang dibuat`
      : `${number(options.createdCount) || docs.length} MPS bulanan berhasil dibuat`,
  };
}

async function buildMpsReadiness(tx, doc) {
  const sourceDetails = (doc?.details || []).filter((row) => !isGeneratedProcess(row));
  const partIds = [...new Set(sourceDetails.map((row) => row.partId).filter(Boolean))];
  const headers = partIds.length ? await tx.mBOMHeader.findMany({
    where: { partId: { in: partIds }, isDeleted: false },
    orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
    include: {
      part: { select: { partCode: true, partName: true, baseUomCode: true, productionUomCode: true } },
      details: {
        where: { isDeleted: false },
        include: {
          part: {
            select: {
              partCode: true, partName: true, baseUomCode: true, purchaseUomCode: true,
              productionUomCode: true, supplierId: true, itemType: true, partType: true,
              supplierItems: { where: { isActive: true }, select: { id: true }, take: 1 },
              mbomHeaders: {
                where: { isDeleted: false },
                orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
                take: 1,
                select: {
                  noReg: true,
                  details: {
                    where: { isDeleted: false },
                    select: { id: true },
                    take: 1,
                  },
                },
              },
            },
          },
          children: {
            where: { isDeleted: false },
            select: { id: true },
          },
          mbomProcesses: {
            where: { isDeleted: false },
            include: {
              process: { select: { processCode: true, processName: true } },
              machine: { select: { machineCode: true, status: true } },
              vendor: { select: { vendorCode: true, status: true } },
            },
            orderBy: { sequence: "asc" },
          },
        },
        orderBy: [{ levelComponent: "asc" }, { createdAt: "asc" }],
      },
    },
  }) : [];
  const headerByPartId = new Map();
  headers.forEach((header) => { if (!headerByPartId.has(header.partId)) headerByPartId.set(header.partId, header); });
  const issues = [];
  const seen = new Set();
  const add = (severity, code, message, context = {}) => {
    const key = `${code}|${context.partCode || ""}|${context.processCode || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ severity, code, message, ...context });
  };
  for (const row of sourceDetails) {
    const partCode = row.partCode || row.part?.partCode || "-";
    const header = headerByPartId.get(row.partId);
    const receiptUom = row.uomCode || row.part?.productionUomCode || row.part?.baseUomCode;
    if (!receiptUom) add("BLOCKING", "FG_UOM_MISSING", `${partCode} belum memiliki Production/Base UOM untuk MPS.`, { partCode });
    if (!header) {
      add("BLOCKING", "FG_MBOM_MISSING", `${partCode} belum memiliki mBOM aktif untuk proses produksi.`, { partCode });
      continue;
    }
    const bomContext = { bomNumber: header.noReg };
    if (!header.uomCode && !header.part?.productionUomCode && !header.part?.baseUomCode) {
      add("BLOCKING", "MBOM_UOM_MISSING", `${partCode} belum memiliki UOM pada header mBOM atau Part Master.`, { partCode, ...bomContext });
    }
    for (const detail of header.details || []) {
      const detailCode = detail.part?.partCode || `BOM line ${detail.id}`;
      const category = String(detail.category || "").toUpperCase();
      const detailUom = detail.uomCode
        || (category === "PURCHASE" ? detail.part?.purchaseUomCode : detail.part?.productionUomCode)
        || detail.part?.baseUomCode;
      if (!detailUom) add("BLOCKING", "BOM_DETAIL_UOM_MISSING", `${detailCode} belum memiliki UOM yang dapat dipakai planning.`, { partCode: detailCode, parentPartCode: partCode, ...bomContext });
      if (category === "PURCHASE" && !detail.part?.supplierId && !(detail.part?.supplierItems || []).length) {
        add("WARNING", "PURCHASE_SUPPLIER_MISSING", `${detailCode} belum memiliki supplier default/preferred; PPIC/Purchasing wajib memilih supplier sebelum PR/PO.`, { partCode: detailCode, parentPartCode: partCode, ...bomContext });
      }
      const hasChildStructure = (detail.children || []).length > 0
        || (detail.part?.mbomHeaders || []).some((childBom) => (childBom.details || []).length > 0);
      const isFgReceiptOnly = String(detail.part?.itemType || "").toUpperCase() === "FG"
        && (
          String(detail.part?.partType || "STANDARD").toUpperCase() !== "COMP"
          || hasChildStructure
        );
      if (category !== "PURCHASE" && !(detail.mbomProcesses || []).length && !isFgReceiptOnly) {
        add("BLOCKING", "ROUTING_MISSING", `${detailCode} belum memiliki routing process pada mBOM.`, { partCode: detailCode, parentPartCode: partCode, ...bomContext });
      }
      for (const route of detail.mbomProcesses || []) {
        const processCode = route.process?.processCode || route.process?.processName || `sequence ${route.sequence}`;
        const effectiveRoutingMode = category === "VENDOR"
          ? "VENDOR"
          : String(route.routingMode || "INHOUSE").toUpperCase();
        if (effectiveRoutingMode === "VENDOR") {
          if (!route.vendorId || !route.vendor || String(route.vendor.status || "Active").toUpperCase() !== "ACTIVE") {
            add("WARNING", "ROUTING_VENDOR_SELECTED_AT_CAPACITY", `${detailCode} · ${processCode} bertipe vendor; vendor serta jadwal send/return dipilih saat Capacity Planning.`, { partCode: detailCode, parentPartCode: partCode, processCode, ...bomContext });
          }
        } else {
          if (!route.machineId || !route.machine || String(route.machine.status || "Active").toUpperCase() !== "ACTIVE") {
            add("BLOCKING", "ROUTING_MACHINE_MISSING", `${detailCode} · ${processCode} belum memiliki mesin aktif.`, { partCode: detailCode, parentPartCode: partCode, processCode, ...bomContext });
          }
          if (number(route.cycleTime) <= 0) {
            add("BLOCKING", "ROUTING_CYCLE_TIME_MISSING", `${detailCode} · ${processCode} belum memiliki cycle time.`, { partCode: detailCode, parentPartCode: partCode, processCode, ...bomContext });
          }
        }
      }
    }
  }
  return {
    ok: !issues.some((issue) => issue.severity === "BLOCKING"),
    blockingCount: issues.filter((issue) => issue.severity === "BLOCKING").length,
    warningCount: issues.filter((issue) => issue.severity === "WARNING").length,
    checkedFgCount: partIds.length,
    issues,
  };
}

async function nextNumber(tx = prisma) {
  const year = new Date().getFullYear(); const prefix = `MPS-${year}-`;
  const rows = await tx.mPS.findMany({ where: { mpsNumber: { startsWith: prefix } }, select: { mpsNumber: true } });
  const max = rows.reduce((value, row) => Math.max(value, Number(row.mpsNumber.slice(prefix.length)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

function forecastPeriods(row) {
  return [[row.M1Forecast, row.M1Qty, 1], [row.M2Forecast, row.M2Qty, 2], [row.M3Forecast, row.M3Qty, 3]]
    .filter(([month, qty]) => month && number(qty) > 0)
    .map(([month, qty, offset]) => ({ month: new Date(month), qty: number(qty), offset }));
}

const OPEN_SO_HEADER_STATUSES = ["Confirmed", "In Progress", "In Production", "Ready to Deliver"];
const OPEN_SO_DETAIL_STATUSES = ["Pending", "In Planning", "In Production"];
// SO is pegged to the planning bucket by part code and due month.  It must
// not depend on the Forecast ID (or customer stored on that Forecast).
const mpsBucketKey = (partCode, _customerCode, bucketDate) => `${String(partCode || "").trim()}|${monthKey(bucketDate)}`;

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

exports.mbomRevisionOptions = async (req, res, next) => {
  try {
    const months = String(req.query.months || "").split(",").map((value) => value.trim()).filter(Boolean);
    const selectedDeliveryTargetIds = String(req.query.selectedDeliveryTargetIds || "").split(",").map((value) => value.trim()).filter(Boolean);
    const anchor = text(req.query.planningAnchorMonth) || months[0] || planningAnchorMonth(new Date());
    const items = await previewMonthlyMbomSelections(prisma, {
      months: months.length ? months : undefined,
      planningAnchorMonth: anchor,
      selectedDeliveryTargetIds,
    });
    return res.json({ items, planningAnchorMonth: anchor });
  } catch (error) {
    return next(error);
  }
};

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(number(req.query.page) || 1, 1); const limit = Math.min(Math.max(number(req.query.limit) || 20, 1), 500); const q = text(req.query.q || req.query.search);
    const where = { isDeleted: false, ...(String(req.query.includeLegacy || "").toLowerCase() === "true" ? {} : { status: { not: "Superseded" } }), ...(q ? { OR: [{ mpsNumber: { contains: q, mode: "insensitive" } }, { mpsName: { contains: q, mode: "insensitive" } }, { forecastNumber: { contains: q, mode: "insensitive" } }, { status: { contains: q, mode: "insensitive" } }] } : {}) };
    const [items, total] = await Promise.all([prisma.mPS.findMany({ where, include, orderBy: [{ periodStart: "asc" }, { createdAt: "asc" }], skip: (page - 1) * limit, take: limit }), prisma.mPS.count({ where })]);
    res.json({ items: items.map((item) => {
      const receiptLines = item.details.filter((row) => !isGeneratedProcess(row));
      const processLines = item.details.filter((row) => isGeneratedProcess(row) && String(row.part?.itemType || "").toUpperCase() !== "FG");
      const forecastNumbers = [...new Set(receiptLines.flatMap((row) => {
        const captured = String(row.notes || "").match(/forecast\s+(.+?);\s*SO/i)?.[1] || "";
        return captured.split(",").map((value) => value.trim()).filter((value) => value && value !== "-");
      }))];
      const soNumbers = [...new Set(receiptLines.flatMap((row) => String(row.soNumber || "").split(",").map((value) => value.trim()).filter(Boolean)))];
      const targetDates = receiptLines.flatMap((row) => [row.customerTargetDate, ...(row.demandSources || []).map((source) => source.targetDeliveryDate)]).filter(Boolean).sort((left, right) => new Date(left) - new Date(right));
      const fgRequiredDates = receiptLines.flatMap((row) => [row.fgRequiredDate, ...(row.demandSources || []).map((source) => source.fgRequiredDate)]).filter(Boolean).sort((left, right) => new Date(left) - new Date(right));
      const customerCodes = [...new Set(receiptLines.flatMap((row) => [row.customerCode, ...(row.demandSources || []).map((source) => source.customerCode)]).filter((value) => value && value !== "MULTI"))];
      const deliveryTargetIds = [...new Set(receiptLines.flatMap((row) => [row.deliveryPhaseId, ...(row.demandSources || []).flatMap((source) => [source.deliveryTargetId, ...((Array.isArray(source.sourcePegging) ? source.sourcePegging : []).map((pegging) => pegging.deliveryTargetId))])]).filter(Boolean))];
      const priorityClasses = [...new Set(receiptLines.flatMap((row) => [row.priorityClass, ...(row.demandSources || []).map((source) => source.priorityClass)]).filter(Boolean))].sort();
      const bucketMonth = monthKey(item.periodStart);
      const targetMonths = [...new Set(targetDates.map(monthKey).filter(Boolean))];
      const bucketAligned = targetMonths.length === 0 || targetMonths.every((month) => month === bucketMonth);
      return {
        ...item,
        forecastNumbers,
        soNumbers,
        totalPlannedQty: receiptLines.reduce((sum, row) => sum + number(row.qtyPlanned), 0),
        partCount: new Set(receiptLines.map((row) => row.partCode)).size,
        receiptLineCount: receiptLines.length,
        processLineCount: processLines.length,
        targetDeliveryStart: targetDates[0] || item.periodStart,
        targetDeliveryEnd: targetDates.at(-1) || item.periodEnd,
        fgRequiredStart: fgRequiredDates[0] || null,
        fgRequiredEnd: fgRequiredDates.at(-1) || null,
        customerCount: customerCodes.length,
        deliveryPhaseCount: deliveryTargetIds.length,
        priorityClasses,
        bucketAligned,
        targetMonths,
      };
    }), total, page, limit });
  } catch (error) { next(error); }
};

// Read model for both newly generated monthly MPS and legacy MPS documents
// whose header covers more than one month.  It deliberately derives the month
// from each detail's startDate, so no historical document needs rewriting.
exports.monthlySummary = async (req, res, next) => {
  try {
    const details = await prisma.mPSDetail.findMany({
      where: { isDeleted: false, mps: { isDeleted: false, status: { not: "Superseded" } } },
      select: {
        mpsNumber: true, partCode: true, customerCode: true, startDate: true,
        forecastQty: true, actualSalesOrderQty: true, bufferQty: true, effectiveDemandQty: true, qtyPlanned: true, notes: true,
        mps: { select: { forecastNumber: true, status: true } },
        part: { select: { partCode: true, partNumber: true, partName: true, itemType: true, partType: true, productionUomCode: true, baseUomCode: true } },
      },
      orderBy: [{ startDate: "asc" }, { partCode: "asc" }],
      take: 10000,
    });
    const monthly = new Map();
    const receiptByMonth = new Map(details.filter((row) => !isGeneratedProcess(row) && row.startDate).map((row) => [`${row.customerCode || ""}|${row.partCode}|${monthKey(row.startDate)}`, row]));
    for (const row of details) {
      if (!row.startDate) continue;
      const month = monthKey(row.startDate);
      const customerCode = row.customerCode || "Tanpa Customer";
      const forecastNumber = row.mps?.forecastNumber
        || String(row.notes || "").match(/forecast\s+(.+?);\s*SO/i)?.[1]?.trim()
        || "Tanpa Forecast";
      const itemType = String(row.part?.itemType || "UNKNOWN").toUpperCase();
      const partType = String(row.part?.partType || "STANDARD").toUpperCase();
      const itemScope = itemType === "FG" && partType !== "COMP" ? "FG NON-COMP" : partType !== "COMP" ? "NON-COMP" : "COMP";
      const scheduleType = !isGeneratedProcess(row)
        ? "FG RECEIPT"
        : itemType === "FG"
          ? "CHILD FG RECEIPT"
          : "CHILD / PROCESS";
      const sourcePart = String(row.notes || "").match(/;\s*source\s+(.+?)(?:;|$)/i)?.[1]?.trim();
      const parent = isGeneratedProcess(row) ? receiptByMonth.get(`${row.customerCode || ""}|${sourcePart || ""}|${month}`) : null;
      const inherited = (field) => number(row[field]) || number(parent?.[field]);
      const uomCode = row.part?.productionUomCode || row.part?.baseUomCode || null;
      const key = [month, forecastNumber, customerCode, row.partCode, scheduleType, uomCode || "-"].join("|");
      const current = monthly.get(key) || { month, forecastNumber, customerCode, partCode: row.partCode || row.part?.partCode, partNumber: row.part?.partNumber || null, partName: row.part?.partName || null, itemType, partType, itemScope, scheduleType, uomCode, mpsNumbers: [], forecastQty: 0, actualSalesOrderQty: 0, bufferQty: 0, effectiveDemandQty: 0, qtyPlanned: 0 };
      current.mpsNumbers.push(row.mpsNumber);
      current.forecastQty += inherited("forecastQty");
      current.actualSalesOrderQty += inherited("actualSalesOrderQty");
      current.bufferQty += inherited("bufferQty");
      current.effectiveDemandQty += inherited("effectiveDemandQty");
      current.qtyPlanned += number(row.qtyPlanned);
      monthly.set(key, current);
    }
    const items = [...monthly.values()].map((row) => ({ ...row, mpsNumbers: [...new Set(row.mpsNumbers)], mpsCount: new Set(row.mpsNumbers).size })).sort((left, right) => `${left.month}|${left.forecastNumber}|${left.customerCode}|${left.partCode}`.localeCompare(`${right.month}|${right.forecastNumber}|${right.customerCode}|${right.partCode}`));
    res.json({ items, total: items.length, filters: { months: [...new Set(items.map((row) => row.month))], forecasts: [...new Set(items.map((row) => row.forecastNumber))], customers: [...new Set(items.map((row) => row.customerCode))] } });
  } catch (error) { next(error); }
};

exports.get = async (req, res, next) => {
  try {
    const doc = await prisma.mPS.findFirst({ where: { mpsNumber: req.params.mpsNumber, isDeleted: false }, include });
    if (!doc) return res.status(404).json({ message: "MPS tidak ditemukan" });
    // Keep the existing MPS screen readable during a rolling deployment: a
    // node process may still hold the previous Prisma client until restart.
    // Delivery phases will appear as soon as the generated client is loaded.
    const forecastReceiptDetailIds = doc.details.filter((row) => !isGeneratedProcess(row)).map((row) => row.id);
    const deliveryPlans = typeof prisma.mPSDeliveryPlan?.findMany === "function"
      ? await prisma.mPSDeliveryPlan.findMany({
        where: {
          mpsNumber: doc.mpsNumber,
          mpsDetailId: { in: forecastReceiptDetailIds },
          targetType: "CUSTOMER",
          isDeleted: false,
        },
        orderBy: [{ plannedDate: "asc" }, { phaseNumber: "asc" }],
      })
      : [];
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
    // Resolve the process column from the parent FG mBOM. Generated SFG rows
    // do not carry an mbomHeaderId, so use the source FG in their trace note.
    // Keep the same routing-number order used by capacity and WO generation.
    const receiptRows = doc.details.filter((row) => !isGeneratedProcess(row));
    const parentPartIds = [...new Set(receiptRows.map((row) => row.partId).filter(Boolean))];
    const generatedPartIds = [...new Set(doc.details.filter((row) => isGeneratedProcess(row)).map((row) => row.partId).filter(Boolean))];
    const directRoutingDetails = generatedPartIds.length ? await prisma.mBOMDetail.findMany({
      where: { partId: { in: generatedPartIds }, isDeleted: false, mbomProcesses: { some: { isDeleted: false } } },
      include: { part: true, mbomHeader: { select: { revision: true, updatedAt: true } }, mbomProcesses: { where: { isDeleted: false }, include: { process: true } } },
      orderBy: [{ updatedAt: "desc" }],
    }) : [];
    const directRoutingByPartId = new Map();
    directRoutingDetails.forEach((detail) => { if (!directRoutingByPartId.has(detail.partId)) directRoutingByPartId.set(detail.partId, detail); });
    const parentHeaders = parentPartIds.length ? await prisma.mBOMHeader.findMany({
      where: { partId: { in: parentPartIds }, isDeleted: false },
      orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
      include: { details: { where: { isDeleted: false }, include: { part: true, mbomProcesses: { where: { isDeleted: false }, include: { process: true } } } } },
    }) : [];
    const headerByPartId = new Map();
    parentHeaders.forEach((header) => { if (!headerByPartId.has(header.partId)) headerByPartId.set(header.partId, header); });
    const parentByCode = new Map(receiptRows.map((row) => [row.partCode, row]));
    doc.details = doc.details.map((row) => {
      if (!isGeneratedProcess(row)) return row;
      const sourceCode = String(row.notes || "").match(/;\s*source\s+(.+?)(?:;|$)/i)?.[1]?.trim();
      const parent = parentByCode.get(sourceCode);
      const header = parent ? headerByPartId.get(parent.partId) : null;
      const direct = directRoutingByPartId.get(row.partId);
      const child = direct || header?.details?.find((detail) => detail.part?.partCode === row.partCode);
      if (!header || !child) return row;
      // Only use routing attached to this part's own BOM detail. Do not walk
      // ancestors: that creates fabricated Finish Goods/Welding chains.
      const path = (child.mbomProcesses || [])
        .map((process) => ({
          id: process.id,
          name: process.process?.processName || process.process?.processCode || "Process",
          occurrenceCode: process.occurrenceCode || null,
          routingNumber: process.routingNumber || null,
          levelComponent: child.levelComponent,
          level: child.levelComponent,
          sequence: process.sequence,
        }))
        .sort(compareRoutingOperations);
      return path.length ? { ...row, processPath: path } : row;
    });
    // Expose the latest inventory position on every MPS line.  This is a
    // read-model enrichment only; the persisted MPS quantities remain the
    // result of the MPS/MRP run.  Child/SFG rows are included so PPIC can see
    // the stock that was available to net their dependent requirement.
    const stockPartCodes = [...new Set(doc.details.map((row) => row.partCode).filter(Boolean))];
    const stockRows = stockPartCodes.length ? await prisma.stockBalance.findMany({
      where: {
        partCode: { in: stockPartCodes },
        isDeleted: false,
        warehouse: { isDeleted: false, availableForProduction: true },
      },
      select: {
        id: true,
        partCode: true,
        warehouseCode: true,
        rackCode: true,
        lotNumber: true,
        stockType: true,
        uomCode: true,
        qtyOnHand: true,
        qtyAvailable: true,
        qtyReserved: true,
        qtyQC: true,
        warehouse: { select: { warehouseCode: true, warehouseName: true } },
      },
      orderBy: [{ partCode: "asc" }, { warehouseCode: "asc" }, { rackCode: "asc" }, { lotNumber: "asc" }],
    }) : [];
    const stockByPartCode = new Map();
    for (const row of stockRows) {
      if (!stockByPartCode.has(row.partCode)) stockByPartCode.set(row.partCode, {
        stockOnHandQty: 0,
        stockAvailableQty: 0,
        stockReservedQty: 0,
        stockQcQty: 0,
        stockBreakdown: { lines: [] },
      });
      const stock = stockByPartCode.get(row.partCode);
      stock.stockOnHandQty += Math.max(number(row.qtyOnHand), 0);
      stock.stockAvailableQty += Math.max(number(row.qtyAvailable), 0);
      stock.stockReservedQty += Math.max(number(row.qtyReserved), 0);
      stock.stockQcQty += Math.max(number(row.qtyQC), 0);
      stock.stockBreakdown.lines.push({
        stockBalanceId: row.id,
        warehouseCode: row.warehouseCode,
        warehouseName: row.warehouse?.warehouseName || null,
        rackCode: row.rackCode,
        lotNumber: row.lotNumber,
        stockType: row.stockType,
        uomCode: row.uomCode,
        qtyOnHand: Math.max(number(row.qtyOnHand), 0),
        qtyAvailable: Math.max(number(row.qtyAvailable), 0),
        qtyReserved: Math.max(number(row.qtyReserved), 0),
        qtyQC: Math.max(number(row.qtyQC), 0),
      });
    }
    doc.details = doc.details.map((row) => ({
      ...row,
      ...(stockByPartCode.get(row.partCode) || {
        stockOnHandQty: 0,
        stockAvailableQty: 0,
        stockReservedQty: 0,
        stockQcQty: 0,
        stockBreakdown: { lines: [] },
      }),
    }));
    const generatedRunNumbers = [...new Set(doc.details.map((row) => String(row.notes || "").match(/Generated from ([^;]+)/i)?.[1]?.trim()).filter(Boolean))];
    const productionTraceRows = generatedRunNumbers.length ? await prisma.mRPRequirement.findMany({
      where: { runNumber: { in: generatedRunNumbers }, isDeleted: false, orderType: "Production" },
      select: {
        id: true,
        runNumber: true,
        mpsDetailId: true,
        parentRequirementId: true,
        rootRequirementId: true,
        treePath: true,
        levelMBOM: true,
        partCode: true,
        grossRequirement: true,
        onHandQty: true,
        allocatedQty: true,
        netRequirement: true,
        plannedOrderQty: true,
        adjustedOrderQty: true,
        orderType: true,
        requiredDate: true,
        part: { select: { partCode: true, partNumber: true, partName: true } },
        mbomDetail: { select: { qty: true, uomCode: true, category: true } },
        parentRequirement: { select: { id: true, partCode: true, grossRequirement: true, netRequirement: true, orderType: true, part: { select: { partName: true } } } },
      },
      orderBy: [{ levelMBOM: "asc" }, { requiredDate: "asc" }],
    }) : [];
    doc.details = doc.details.map((row) => {
      const runNumber = String(row.notes || "").match(/Generated from ([^;]+)/i)?.[1]?.trim();
      const sourceMpsDetailId = String(row.notes || "").match(/\[MPS-SOURCE:([^\]]+)\]/)?.[1];
      if (!runNumber || !sourceMpsDetailId) return row;
      const mrpNettingTrace = productionTraceRows.filter((trace) => trace.runNumber === runNumber && trace.mpsDetailId === sourceMpsDetailId && trace.partCode === row.partCode);
      const hierarchyTrace = mrpNettingTrace.slice().sort((left, right) => Number(left.levelMBOM || 0) - Number(right.levelMBOM || 0) || String(left.treePath || "").localeCompare(String(right.treePath || "")))[0];
      return {
        ...row,
        mrpRunNumber: runNumber,
        mrpNettingTrace,
        bomHierarchy: hierarchyTrace ? {
          level: Number(hierarchyTrace.levelMBOM || 0),
          treePath: hierarchyTrace.treePath || null,
          parentPartCode: hierarchyTrace.parentRequirement?.partCode || null,
          parentPartName: hierarchyTrace.parentRequirement?.part?.partName || null,
        } : null,
      };
    });
    const productionPlans = await prisma.monthlyProductionPlan.findMany({
      where: { sourceType: `MPS:${doc.mpsNumber}`, isDeleted: false },
      select: { planNumber: true, planMonth: true, status: true, _count: { select: { details: true } } },
      orderBy: { planMonth: "asc" },
    });
    const [readiness, customers] = await Promise.all([
      buildMpsReadiness(prisma, doc),
      prisma.customer.findMany({
        // Legacy customer rows may predate the optional status field. Treat a
        // blank status as active so valid customers remain selectable.
        where: {
          isDeleted: false,
          OR: [{ status: "Active" }, { status: null }, { status: "" }],
        },
        select: { customerCode: true, customerName: true },
        orderBy: { customerCode: "asc" },
      }),
    ]);
    const cycleEnd = new Date(doc.periodStart);
    cycleEnd.setUTCMonth(cycleEnd.getUTCMonth() + 2, 0);
    cycleEnd.setUTCHours(23, 59, 59, 999);
    const followingDocuments = await prisma.mPS.findMany({
      where: {
        isDeleted: false,
        mpsNumber: { not: doc.mpsNumber },
        periodStart: { gt: doc.periodStart, lte: cycleEnd },
        status: { notIn: ["Superseded", "Cancelled"] },
      },
      include,
      orderBy: { periodStart: "asc" },
    });
    const cycleDocuments = [{ ...doc, deliveryPlans }, ...followingDocuments].slice(0, 2);
    const followingNumbers = cycleDocuments.slice(1).map((row) => row.mpsNumber);
    const followingDeliveryPlans = followingNumbers.length && typeof prisma.mPSDeliveryPlan?.findMany === "function"
      ? await prisma.mPSDeliveryPlan.findMany({
        where: { mpsNumber: { in: followingNumbers }, targetType: "CUSTOMER", isDeleted: false },
        orderBy: [{ plannedDate: "asc" }, { phaseNumber: "asc" }],
      })
      : [];
    for (const cycleDocument of cycleDocuments.slice(1)) {
      cycleDocument.deliveryPlans = followingDeliveryPlans.filter((row) => row.mpsNumber === cycleDocument.mpsNumber);
    }
    const planningCycle = {
      anchorMonth: monthKey(doc.periodStart),
      periodStart: cycleDocuments[0]?.periodStart || doc.periodStart,
      periodEnd: cycleDocuments.at(-1)?.periodEnd || doc.periodEnd,
      mpsNumbers: cycleDocuments.map((row) => row.mpsNumber),
      status: cycleDocuments.every((row) => ["Confirmed", "Released"].includes(row.status)) ? "LOCKED" : "DRAFT",
      documents: cycleDocuments,
    };
    res.json({ ...doc, productionPlans, deliveryPlans, deliveryCatalogs: { customers }, readiness, planningCycle });
  } catch (error) { next(error); }
};

// MPS only stores the customer delivery commitment. Vendor send/return phases
// are operational routing decisions and belong to Capacity Planning.
exports.createDeliveryPhase = async (req, res, next) => {
  try {
    if (String(req.body?.targetType || "CUSTOMER").trim().toUpperCase() === "CUSTOMER") {
      return res.status(409).json({ message: "Target delivery customer dimiliki Marketing. Ubah phase pada Forecast atau Sales Order, lalu hitung ulang MPS bulanan." });
    }
    const mpsNumber = req.params.mpsNumber;
    const requestedTargetType = String(req.body?.targetType || "CUSTOMER").trim().toUpperCase();
    const targetType = "CUSTOMER";
    const targetCode = text(req.body?.targetCode);
    const plannedDate = date(req.body?.plannedDate);
    const qtyPlanned = number(req.body?.qtyPlanned);
    const mpsDetailId = text(req.body?.mpsDetailId);
    if (requestedTargetType !== "CUSTOMER") {
      return res.status(400).json({ message: "Vendor schedule dikelola melalui Capacity Planning, bukan MPS." });
    }
    if (!targetCode || !plannedDate || Number.isNaN(plannedDate.getTime()) || qtyPlanned <= 0) {
      return res.status(400).json({ message: 'Customer, tanggal, dan qty delivery wajib diisi.' });
    }
    const mps = await prisma.mPS.findFirst({ where: { mpsNumber, isDeleted: false }, include: { details: { where: { isDeleted: false }, include: { part: true } } } });
    if (!mps) return res.status(404).json({ message: 'MPS tidak ditemukan.' });
    if (!['Draft', 'Confirmed'].includes(mps.status)) return res.status(409).json({ message: `Delivery planning tidak dapat diubah pada MPS ${mps.status}.` });
    const detail = mpsDetailId ? mps.details.find((row) => row.id === mpsDetailId) : mps.details.find((row) => row.partCode === text(req.body?.partCode));
    if (!detail) return res.status(404).json({ message: 'Baris MPS untuk delivery tidak ditemukan.' });
    if (isGeneratedProcess(detail)) {
      return res.status(400).json({ message: 'Customer delivery hanya dapat dijadwalkan dari baris forecast/FG Receipt.' });
    }
    const partner = await prisma.customer.findFirst({
      where: {
        customerCode: targetCode,
        isDeleted: false,
        OR: [{ status: 'Active' }, { status: null }, { status: '' }],
      },
      select: { customerCode: true, customerName: true },
    });
    if (!partner) return res.status(404).json({ message: 'Customer aktif tidak ditemukan.' });
    const allocated = await prisma.mPSDeliveryPlan.aggregate({
      where: { mpsNumber, mpsDetailId: detail.id, targetType, isDeleted: false, status: { not: 'Cancelled' } },
      _sum: { qtyPlanned: true },
    });
    if (number(allocated._sum.qtyPlanned) + qtyPlanned > number(detail.qtyPlanned) + 0.000001) {
      return res.status(409).json({ message: `Total phase delivery ${detail.partCode} melebihi target MPS ${detail.qtyPlanned}.` });
    }
    const last = await prisma.mPSDeliveryPlan.aggregate({ where: { mpsNumber }, _max: { phaseNumber: true } });
    const phase = await prisma.mPSDeliveryPlan.create({ data: {
      mpsNumber, mpsDetailId: detail.id, phaseNumber: number(last._max.phaseNumber) + 1, targetType,
      targetCode, targetName: partner.customerName,
      partCode: detail.partCode, plannedDate, qtyPlanned, uomCode: detail.part?.productionUomCode || detail.part?.baseUomCode || null,
      notes: text(req.body?.notes), createdBy: req.user?.username || req.user?.email || null,
    } });
    res.status(201).json(phase);
  } catch (error) { next(error); }
};

exports.removeDeliveryPhase = async (req, res, next) => {
  try {
    const phase = await prisma.mPSDeliveryPlan.findFirst({ where: { id: req.params.phaseId, mpsNumber: req.params.mpsNumber, isDeleted: false } });
    if (!phase) return res.status(404).json({ message: 'Phase delivery tidak ditemukan.' });
    if (phase.lockedBySource) return res.status(409).json({ message: "Phase ini bersumber dari Forecast/Sales Order. Revisi dilakukan oleh Marketing pada dokumen sumber." });
    await prisma.mPSDeliveryPlan.update({ where: { id: phase.id }, data: { isDeleted: true, status: 'Cancelled' } });
    res.json({ message: 'Phase delivery dibatalkan.' });
  } catch (error) { next(error); }
};

exports.readiness = async (req, res, next) => {
  try {
    const doc = await prisma.mPS.findFirst({ where: { mpsNumber: req.params.mpsNumber, isDeleted: false }, include });
    if (!doc) return res.status(404).json({ message: "MPS tidak ditemukan" });
    res.json(await buildMpsReadiness(prisma, doc));
  } catch (error) { next(error); }
};

async function createFromForecastLegacy(req, res, next) {
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
                },
              },
            },
          },
        },
      },
    });
    if (!forecast) return res.status(404).json({ message: "Forecast tidak ditemukan" });
    // Forecast adalah demand finished good. Data legacy yang pernah salah masuk
    // sebagai child/WIP/RAW tidak boleh ikut diturunkan ke MPS.
    const fgDetails = forecast.details.filter((row) => String(row.part?.itemType || "").toUpperCase() === "FG");
    const requestedMonths = Array.isArray(req.body.months)
      ? new Set(req.body.months.map((value) => String(value || "").slice(0, 7)).filter(Boolean))
      : null;
    const allPeriods = fgDetails.flatMap((row) => forecastPeriods(row).map((period) => ({ row, ...period })));
    const periods = requestedMonths
      ? allPeriods.filter((period) => requestedMonths.has(monthKey(period.month)))
      : allPeriods;
    if (forecast.details.length && !fgDetails.length) return res.status(400).json({ message: "Forecast hanya boleh berisi Part dengan item type FG" });
    if (!periods.length) return res.status(400).json({ message: "Forecast belum memiliki demand bulanan dengan qty lebih dari nol" });
    const periodKeys = [...new Set(periods.map((period) => monthKey(period.month)))].sort();
    const allowedStatuses = new Set(["Confirmed", "Consumed", "Partial Product"]);
    if (!allowedStatuses.has(forecast.status)) return res.status(409).json({ message: `Forecast harus berstatus Confirmed atau Partial Product sebelum dibuat menjadi MPS. Status saat ini ${forecast.status}.` });
    const formulas = await getFormulaSet(prisma, "planning");
    let transactionResult;
    try {
      transactionResult = await prisma.$transaction(async (tx) => {
        const periodsByMonth = new Map();
        for (const period of periods) {
          const key = monthKey(period.month);
          if (!periodsByMonth.has(key)) periodsByMonth.set(key, []);
          periodsByMonth.get(key).push(period);
        }
        if (text(req.body.mpsNumber) && periodsByMonth.size > 1) throw Object.assign(new Error("Nomor MPS manual hanya dapat dipakai bila forecast mencakup satu bulan"), { statusCode: 400 });
        // Buffer bulan berjalan selalu membaca seluruh horizon Forecast (bukan
        // hanya bulan yang dipilih pada eksekusi ini), sehingga M2 tetap dapat
        // memakai forecast M3 sebagai buffer walaupun M3 belum dibuatkan MPS.
        const forecastByPartMonth = new Map(allPeriods.map((item) => [`${item.row.partCode}|${monthKey(item.month)}`, number(item.qty)]));
        const allPeriodKeys = [...new Set(allPeriods.map((item) => monthKey(item.month)))].sort();
        const existingByMonth = await allMpsByMonth(tx, forecast.forecastNumber, allPeriodKeys);
        const stockCodes = [...new Set(allPeriods.map((item) => item.row.partCode).filter(Boolean))];
        const stockRows = stockCodes.length ? await tx.stockBalance.groupBy({
          by: ["partCode"],
          where: { partCode: { in: stockCodes }, isDeleted: false, warehouse: { isDeleted: false, availableForProduction: true } },
          _sum: { qtyAvailable: true },
        }) : [];
        const stockByPartCode = new Map(stockRows.map((row) => [row.partCode, Math.max(number(row._sum?.qtyAvailable), 0)]));
        const productionPercent = req.body?.productionPercent == null ? 100 : Number(req.body.productionPercent);
        if (!Number.isFinite(productionPercent) || productionPercent < 0 || productionPercent > 100) throw Object.assign(new Error("Persentase produksi forecast harus antara 0 sampai 100"), { statusCode: 400 });
        const docs = [];
        let createdCount = 0;
        for (const [periodKey, monthlyPeriods] of [...periodsByMonth.entries()].sort(([left], [right]) => left.localeCompare(right))) {
          const periodStart = utcMonthStart(monthlyPeriods[0].month);
          const existingRows = existingByMonth.get(periodKey) || [];
          const alreadyByPart = new Map();
          existingRows.flatMap((item) => item.details || []).filter((item) => !isGeneratedProcess(item)).forEach((item) => {
            alreadyByPart.set(item.partCode, (alreadyByPart.get(item.partCode) || 0) + number(item.qtyPlanned));
          });
          const probe = monthlyPeriods.map(({ row, month }) => ({ partCode: row.partCode, customerCode: forecast.customerCode, startDate: periodStart, endDate: utcMonthEnd(periodStart) }));
          const actualSo = await buildActualSalesOrderByMpsBucket(tx, probe);
          const details = monthlyPeriods.map(({ row, month, qty, offset }, index) => {
            const fullForecastQty = number(qty);
            const bufferBaseQty = number(forecastByPartMonth.get(`${row.partCode}|${nextPlanningMonthKey(month)}`));
            const bufferPercent = Math.max(number(row.part?.bufferStock), 0);
            const stockAvailableQty = stockByPartCode.get(row.partCode) || 0;
            const fullBufferQty = evaluateMpsBuffer(formulas, { bufferBaseQty, bufferPercent, stockAvailableQty });
            const fullEffectiveDemandQty = evaluateFromSet(formulas, "MPS_EFFECTIVE_DEMAND", { forecastQty: fullForecastQty, bufferQty: fullBufferQty });
            const alreadyPlannedQty = alreadyByPart.get(row.partCode) || 0;
            const remainingDemandQty = Math.max(fullEffectiveDemandQty - alreadyPlannedQty, 0);
            const forecastQty = Math.min(fullForecastQty, remainingDemandQty);
            const bufferQty = Math.max(remainingDemandQty - forecastQty, 0);
            const effectiveDemandQty = forecastQty + bufferQty;
            const actual = actualSo.byBucket.get(mpsBucketKey(row.partCode, forecast.customerCode, periodStart)) || { qty: 0, soNumbers: [] };
          const outstandingSoQty = Math.max(number(actual.qty) - alreadyPlannedQty, 0);
            const uomCode = row.uomCode || row.part?.uomCode || "pcs";
            const normalizedForecastQty = normalizeQuantity(forecastQty, uomCode);
            const normalizedBufferQty = normalizeQuantity(bufferQty, uomCode);
            const normalizedEffectiveDemandQty = normalizeQuantity(normalizedForecastQty + normalizedBufferQty, uomCode);
            const normalizedSoQty = normalizeQuantity(outstandingSoQty, uomCode);
            const mbomSelectionDate = periodStart;
            const mbomResolution = resolveMbomRevision({ revisions: row.part?.mbomHeaders || [], selectionDate: mbomSelectionDate, selectedId: selectedRevisionId(req.body.mbomSelections, periodKey, row.partCode) });
            return {
              lineNumber: index + 1, partCode: row.partCode, partId: row.partId || row.part?.id || null, mbomHeaderId: mbomResolution.revision?.id || null,
              mbomSelectionMode: mbomResolution.mode, mbomSelectionDate, mbomRevisionSnapshot: mbomResolution.revision?.revision ?? null, mbomNoRegSnapshot: mbomResolution.revision?.noReg || null, mbomSelectionWarning: mbomResolution.warning,
              forecastQty: normalizedForecastQty, actualSalesOrderQty: normalizedSoQty, bufferBaseQty: normalizeQuantity(bufferBaseQty, uomCode), bufferPercent, bufferQty: normalizedBufferQty, effectiveDemandQty: normalizedEffectiveDemandQty, productionPercent,
              qtyPlanned: normalizeQuantity(evaluateFromSet(formulas, "MPS_TARGET_QTY", { effectiveDemandQty: normalizedEffectiveDemandQty, productionPercent, actualSalesOrderQty: normalizedSoQty }), uomCode), uomCode, startDate: periodStart, endDate: utcMonthEnd(periodStart), priority: 1, status: "Planned", customerCode: forecast.customerCode,
              forecastDetailId: row.id, forecastPeriodOffset: offset, notes: `${FG_RECEIPT_PREFIX} Generated from forecast ${forecast.forecastNumber}`,
            };
          }).filter((detail) => detail.qtyPlanned > 0);
          if (!details.length) {
            if (existingRows[0]) docs.push(existingRows[0]);
            continue;
          }
          details.forEach((detail) => {
            const actual = actualSo.byBucket.get(mpsBucketKey(detail.partCode, detail.customerCode, detail.startDate)) || { qty: 0, soNumbers: [] };
            detail.soNumber = [...new Set(actual.soNumbers)].join(",") || null;
          });
          const mpsNumber = text(req.body.mpsNumber) || await nextNumber(tx);
          const mpsAttempt = existingRows.length;
          // MPSDetail is created through the nested MPS relation. Prisma's
          // checked nested input does not accept raw FK fields (partId,
          // mbomHeaderId, forecastDetailId), and MPSDetail has no persisted
          // uomCode column. Convert those references to relation connects and
          // keep uomCode transient for the calculation/UI only.
          const nestedDetails = details.map(({ partId, mbomHeaderId, forecastDetailId, uomCode, ...detail }) => ({
            ...detail,
            ...(partId ? { part: { connect: { id: partId } } } : {}),
            ...(mbomHeaderId ? { mbom: { connect: { id: mbomHeaderId } } } : {}),
            ...(forecastDetailId ? { forecastDetail: { connect: { id: forecastDetailId } } } : {}),
          }));
          docs.push(await tx.mPS.create({ data: { mpsNumber, sourceKey: sourceKeyFor(forecast.forecastNumber, periodKey, mpsAttempt), mpsName: text(req.body.mpsName) ? `${text(req.body.mpsName)} - ${periodKey}` : `MPS ${forecast.forecastNumber} - ${periodKey}${mpsAttempt ? ` (Partial ${mpsAttempt})` : ""}`, periodStart, periodEnd: utcMonthEnd(periodStart), forecastNumber: forecast.forecastNumber, status: "Draft", notes: text(req.body.notes) || `Generated from forecast ${forecast.forecastNumber} for ${periodKey}; production ${productionPercent}%`, createdBy: req.user?.username || req.user?.email || null, details: { create: nestedDetails } }, include }));
          createdCount += 1;
          existingByMonth.set(periodKey, [...existingRows, docs[docs.length - 1]]);
        }
        const finalByMonth = await allMpsByMonth(tx, forecast.forecastNumber, allPeriodKeys);
        let hasRemaining = false;
        for (const period of allPeriods) {
          const key = monthKey(period.month);
          const planned = (finalByMonth.get(key) || []).flatMap((item) => item.details || []).filter((item) => !isGeneratedProcess(item) && item.partCode === period.row.partCode).reduce((sum, item) => sum + number(item.qtyPlanned), 0);
          const bufferBaseQty = number(forecastByPartMonth.get(`${period.row.partCode}|${nextPlanningMonthKey(period.month)}`));
          const stockAvailableQty = stockByPartCode.get(period.row.partCode) || 0;
          const bufferQty = evaluateMpsBuffer(formulas, { bufferBaseQty, bufferPercent: Math.max(number(period.row.part?.bufferStock), 0), stockAvailableQty });
          const effective = evaluateFromSet(formulas, "MPS_EFFECTIVE_DEMAND", { forecastQty: number(period.qty), bufferQty });
          if (planned + 0.000001 < effective) { hasRemaining = true; break; }
        }
        await tx.forecast.update({ where: { forecastNumber: forecast.forecastNumber }, data: { status: hasRemaining ? "Partial Product" : "Consumed" } });
        return { docs, createdCount };
      });
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      const concurrent = await existingMpsByMonth(prisma, forecast.forecastNumber, periodKeys);
      if (concurrent.size !== periodKeys.length) throw error;
      const docs = periodKeys.map((key) => concurrent.get(key));
      return res.status(200).json(mpsResponse(docs, { idempotent: true, createdCount: 0 }));
    }
    res.status(transactionResult.createdCount ? 201 : 200).json(mpsResponse(transactionResult.docs, { idempotent: transactionResult.createdCount === 0, createdCount: transactionResult.createdCount }));
  } catch (error) { next(error); }
}

async function syncMonthlyDemand(req, res, next, requireForecast = false) {
  try {
    req.body = req.body || {};
    const explicitSelection = Array.isArray(req.body.selectedDeliveryTargetIds);
    const selectedDeliveryTargetIds = explicitSelection
      ? [...new Set(req.body.selectedDeliveryTargetIds.map((value) => String(value || "").trim()).filter(Boolean))]
      : [];
    if (explicitSelection && !selectedDeliveryTargetIds.length) {
      return res.status(400).json({ message: "Pilih minimal satu delivery target untuk membuat MPS." });
    }
    const forecastNumber = text(req.body.forecastNumber);
    if (requireForecast && !forecastNumber) {
      return res.status(400).json({ message: "Forecast wajib dipilih" });
    }
    if (forecastNumber) {
      const forecast = await prisma.forecast.findFirst({
        where: { forecastNumber, isDeleted: false, isCurrentVersion: true },
        select: {
          forecastNumber: true,
          status: true,
          details: {
            where: { isDeleted: false },
            select: {
              M1Forecast: true, M1Qty: true,
              M2Forecast: true, M2Qty: true,
              M3Forecast: true, M3Qty: true,
              deliveryTargets: { where: { isDeleted: false, status: "ACTIVE" }, select: { targetDate: true, qty: true } },
            },
          },
        },
      });
      if (!forecast) return res.status(404).json({ message: "Forecast tidak ditemukan" });
      if (!["Confirmed", "Consumed", "Partial Product"].includes(forecast.status)) {
        return res.status(409).json({
          message: `Forecast harus berstatus Confirmed sebelum masuk MPS bulanan. Status saat ini ${forecast.status}.`,
        });
      }
      if (!Array.isArray(req.body.months) || !req.body.months.length) {
        const targetMonths = forecast.details.flatMap((row) => (row.deliveryTargets || [])
          .filter((target) => number(target.qty) > 0)
          .map((target) => monthKey(target.targetDate))).filter(Boolean);
        req.body.months = targetMonths.length ? [...new Set(targetMonths)] : [...new Set(forecast.details.flatMap((row) => [
          number(row.M1Qty) > 0 ? monthKey(row.M1Forecast) : null,
          number(row.M2Qty) > 0 ? monthKey(row.M2Forecast) : null,
          number(row.M3Qty) > 0 ? monthKey(row.M3Forecast) : null,
        ]).filter(Boolean))];
      }
    }
    if (!requireForecast && (!Array.isArray(req.body.months) || !req.body.months.length)) {
      const anchor = text(req.body.planningAnchorMonth) || planningAnchorMonth(new Date());
      req.body.months = [anchor, nextPlanningMonthKey(anchor), nextPlanningMonthKey(nextPlanningMonthKey(anchor))];
    }
    const normalizedSelection = normalizeMpsRunSelection({
      months: req.body.months,
      selectedDeliveryTargetIds,
      selectionRequired: explicitSelection,
    });
    const result = await prisma.$transaction((tx) => syncMonthlyMps(tx, {
      months: normalizedSelection.months.length ? normalizedSelection.months : undefined,
      planningAnchorMonth: text(req.body.planningAnchorMonth) || req.body.months?.[0] || planningAnchorMonth(new Date()),
      simulationOnly: req.body.simulationOnly === true,
      selectedDeliveryTargetIds: normalizedSelection.selectedDeliveryTargetIds,
      mbomSelections: req.body.mbomSelections && typeof req.body.mbomSelections === "object"
        ? req.body.mbomSelections
        : undefined,
      runBy: req.user?.username || req.user?.email || "system",
    }));
    if (!result.docs.length) {
      return res.status(400).json({
        message: "Tidak ada demand Forecast/SO aktif pada bulan yang dipilih",
      });
    }
    return res.status(200).json({
      ...mpsResponse(result.docs, { idempotent: false, createdCount: 0 }),
      months: result.months,
      coveredSoNumbers: result.coveredSoNumbers,
      consumedForecasts: result.consumedForecasts,
      message: `${result.docs.length} MPS bulanan berhasil dihitung ulang dari seluruh Forecast dan SO aktif`,
    });
  } catch (error) {
    return next(error);
  }
}

exports.createFromForecast = (req, res, next) => syncMonthlyDemand(req, res, next, true);
exports.syncMonthly = (req, res, next) => syncMonthlyDemand(req, res, next, false);

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
    if (doc.status !== "Draft") return res.status(409).json({ message: `MPS status ${doc.status} tidak dapat disesuaikan. Buat/recalculate revisi Draft agar approval lama tidak berubah.` });
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
    const stockRows = await prisma.stockBalance.groupBy({
      by: ["partCode"],
      where: { partCode: { in: [...new Set(targetDetails.map((row) => row.partCode).filter(Boolean))] }, isDeleted: false, warehouse: { isDeleted: false, availableForProduction: true } },
      _sum: { qtyAvailable: true },
    });
    const stockByPartCode = new Map(stockRows.map((row) => [row.partCode, Math.max(number(row._sum?.qtyAvailable), 0)]));
    const actualSo = await buildActualSalesOrderByMpsBucket(prisma, targetDetails);
    const formulas = await getFormulaSet(prisma, "planning");
    await prisma.$transaction(targetDetails.map((row) => {
      const actual = actualSo.byDetailId.get(row.id) || { qty: 0, soNumbers: [] };
      const bufferQty = evaluateMpsBuffer(formulas, { bufferBaseQty: number(row.bufferBaseQty), bufferPercent, stockAvailableQty: stockByPartCode.get(row.partCode) || 0 });
      const effectiveDemandQty = evaluateFromSet(formulas, "MPS_EFFECTIVE_DEMAND", { forecastQty: number(row.forecastQty), bufferQty });
      const actualSalesOrderQty = Math.max(number(row.actualSalesOrderQty), number(actual.qty));
      const qtyPlanned = normalizeQuantity(evaluateFromSet(formulas, "MPS_TARGET_QTY", { effectiveDemandQty, productionPercent, actualSalesOrderQty }), row.uomCode || row.part?.uomCode || "pcs");
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
    const doc = await prisma.mPS.findFirst({ where: { mpsNumber: req.params.mpsNumber, isDeleted: false }, include });
    if (!doc) return res.status(404).json({ message: "MPS tidak ditemukan" });
    if (!doc.details.length) return res.status(400).json({ message: "MPS tanpa detail tidak dapat dikonfirmasi" });
    if (doc.replanRequired) return res.status(409).json({ message: doc.replanReason || "Target delivery berubah. Hitung ulang MPS bulanan sebelum konfirmasi.", code: "DELIVERY_REPLAN_REQUIRED" });
    if (doc.status !== "Draft") return res.status(409).json({ message: `MPS tidak dapat dikonfirmasi dari status ${doc.status}` });
    const readiness = await buildMpsReadiness(prisma, doc);
    if (!readiness.ok) return res.status(409).json({
      message: `MPS belum siap dikonfirmasi: ${readiness.blockingCount} blocker routing/UOM harus diperbaiki.`,
      code: "MPS_READINESS_BLOCKED",
      readiness,
    });
    const updated = await prisma.mPS.update({ where: { mpsNumber: doc.mpsNumber }, data: { status: "Confirmed", lifecycleStatus: "REVIEWED", simulationOnly: false, approvedBy: req.user?.username || req.user?.email || null, approvedDate: new Date() }, include });
    res.json(updated);
  } catch (error) { next(error); }
};
