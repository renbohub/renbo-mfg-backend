const { getFormulaSet, evaluateFromSet } = require("../masterFormulaService");
const { normalizeQuantity } = require("../../utils/uomQuantity");
const {
  effectiveDemandQty: resolvePolicyDemandQty,
  effectiveDemandWithBuffer,
  consumeDeliveryTargets,
} = require("./demandConsumptionService");
const {
  planningMonthKey,
  utcMonthStart,
  utcMonthEnd,
  nextPlanningMonthKey,
} = require("../../utils/planningMonth");
const {
  isRevisionEffectiveAt,
  monthlySelectionKey,
  resolveMbomRevision,
  selectedRevisionId,
} = require("./mbomRevisionService");

const FG_RECEIPT_PREFIX = "[FG-RECEIPT]";
const MONTHLY_SOURCE_PREFIX = "MONTH:";
const OPEN_FORECAST_STATUSES = ["Confirmed", "Consumed", "Partial Product"];
const OPEN_SO_STATUSES = ["Confirmed", "In Progress", "In Production", "Ready to Deliver"];
const OPEN_SO_LINE_STATUSES = ["Pending", "In Planning", "In Production"];

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const uniq = (values) => [...new Set(values.filter(Boolean))];
const sourceKeyForMonth = (month) => `${MONTHLY_SOURCE_PREFIX}${month}`;
const isGeneratedProcess = (row) => String(row?.notes || "").startsWith("[MRP-PRODUCTION]");

function normalizeMpsRunSelection(options = {}) {
  const months = uniq((Array.isArray(options.months) ? options.months : [])
    .map((value) => planningMonthKey(value))
    .filter(Boolean)).sort();
  const selectedDeliveryTargetIds = uniq((Array.isArray(options.selectedDeliveryTargetIds)
    ? options.selectedDeliveryTargetIds
    : []).map((value) => String(value || "").trim()).filter(Boolean));
  if (months.length > 3) {
    throw Object.assign(new Error("Satu run MPS maksimal mencakup 3 bulan Target Delivery."), { statusCode: 400 });
  }
  if (options.selectionRequired && !selectedDeliveryTargetIds.length) {
    throw Object.assign(new Error("Pilih minimal satu delivery target untuk membuat MPS."), { statusCode: 400 });
  }
  return { months, selectedDeliveryTargetIds };
}

function targetIncludedInMpsSelection(target, selectedIds) {
  if (!selectedIds?.size) return true;
  return selectedIds.has(String(target?.id || ""))
    || selectedIds.has(String(target?.consumesForecastTargetId || ""));
}

function forecastPeriods(detail) {
  return [
    { offset: 1, date: detail.M1Forecast, qty: number(detail.M1Qty) },
    { offset: 2, date: detail.M2Forecast, qty: number(detail.M2Qty) },
    { offset: 3, date: detail.M3Forecast, qty: number(detail.M3Qty) },
  ].filter((row) => row.date && row.qty > 0);
}

function outstandingTargets(targets, deliveredQty, outstandingQty, fallback) {
  let delivered = number(deliveredQty);
  let remaining = number(outstandingQty);
  const rows = [];
  for (const target of targets.length ? targets : [fallback]) {
    const available = Math.max(number(target.qty) - Math.min(delivered, number(target.qty)), 0);
    delivered = Math.max(delivered - number(target.qty), 0);
    const qty = Math.min(available, remaining);
    if (qty > 0.000001) rows.push({ ...target, qty });
    remaining -= qty;
    if (remaining <= 0.000001) break;
  }
  return rows;
}

function demandBucket(map, month, partCode, part) {
  const key = `${month}|${partCode}`;
  if (!map.has(key)) {
    map.set(key, {
      month,
      partCode,
      partId: part?.id || null,
      part,
      forecastQty: 0,
      actualSalesOrderQty: 0,
      forecastSources: [],
      soSources: [],
      customerCodes: [],
      forecastDetailIds: [],
      forecastOffsets: [],
      uomCodes: [],
      sourceRows: [],
      forecastTargets: [],
      soTargets: [],
    });
  }
  return map.get(key);
}

function targetDeliveryMonth(targetDate, anchorMonth) {
  const targetMonth = planningMonthKey(targetDate);
  if (!targetMonth) return null;
  return anchorMonth && targetMonth < anchorMonth ? anchorMonth : targetMonth;
}

function groupTargetsByDeliveryMonth(targets = [], anchorMonth = null) {
  const groups = new Map();
  for (const target of targets) {
    const month = targetDeliveryMonth(target?.targetDate, anchorMonth);
    if (!month || number(target?.qty) <= 0) continue;
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(target);
  }
  return groups;
}

function evaluateBuffer(formulas, variables) {
  const result = evaluateFromSet(formulas, "MPS_BUFFER_QTY", variables);
  // Keep MPS as gross demand. Stock coverage belongs to MRP netting only.
  return Math.max(result, 0);
}

function fgFinishSplitsForTarget(target, decision, uomCode) {
  const targetQty = normalizeQuantity(target?.qty, uomCode);
  const raw = Array.isArray(decision?.fgFinishSplits)
    ? decision.fgFinishSplits
        .map((row, index) => ({
          phaseNumber: Number(row?.phaseNumber || index + 1),
          targetFinishDate: row?.targetFinishDate || row?.fgRequiredDate || null,
          qty: number(row?.qty),
        }))
        .filter((row) => row.targetFinishDate && row.qty > 0)
    : [];
  const rows = raw.length ? raw : [{
    phaseNumber: 1,
    targetFinishDate: decision?.fgRequiredDate || target?.targetDate,
    qty: targetQty,
  }];
  rows.sort((left, right) => new Date(left.targetFinishDate) - new Date(right.targetFinishDate)
    || left.phaseNumber - right.phaseNumber);
  const rawTotal = rows.reduce((sum, row) => sum + row.qty, 0);
  let allocated = 0;
  return rows.map((row, index) => {
    const qty = index === rows.length - 1
      ? normalizeQuantity(targetQty - allocated, uomCode)
      : normalizeQuantity(targetQty * row.qty / rawTotal, uomCode);
    allocated = normalizeQuantity(allocated + qty, uomCode);
    return {
      phaseNumber: index + 1,
      targetFinishDate: row.targetFinishDate,
      qty,
    };
  }).filter((row) => row.qty > 0);
}

async function invalidateDownstreamPlans(tx, mpsNumbers, runBy) {
  const numbers = uniq(mpsNumbers || []);
  if (!numbers.length) return;
  const reason = `MPS ${numbers.join(", ")} dihitung ulang dari Forecast/SO; MRP dan Purchase Suggestion sebelumnya sudah kedaluwarsa.`;
  // Child/SFG lines are executable outputs of the previous MRP, not source
  // demand. Once the parent MPS changes they must disappear together with the
  // old current MRP; otherwise the detail page mixes new FG demand with stale
  // child quantities from an older calculation.
  await tx.mPSDetail.updateMany({
    where: {
      mpsNumber: { in: numbers },
      isDeleted: false,
      notes: { startsWith: "[MRP-PRODUCTION]" },
    },
    data: { isDeleted: true },
  });
  const currentRuns = await tx.mRPRun.findMany({
    where: { mpsNumber: { in: numbers }, isDeleted: false, isCurrentPlan: true },
    select: { runNumber: true },
  });
  const runNumbers = currentRuns.map((row) => row.runNumber);
  if (!runNumbers.length) return;
  await tx.mRPRun.updateMany({
    where: { runNumber: { in: runNumbers } },
    data: { isCurrentPlan: false },
  });
  const suggestions = await tx.purchaseSuggestion.findMany({
    where: { runNumber: { in: runNumbers }, isDeleted: false, status: { notIn: ["Converted to PR", "Cancelled"] } },
    select: { suggestionNumber: true, notes: true },
  });
  for (const suggestion of suggestions) {
    const notes = [suggestion.notes, reason, runBy ? `Replan by ${runBy}` : null].filter(Boolean).join(" | ");
    await tx.purchaseSuggestion.update({
      where: { suggestionNumber: suggestion.suggestionNumber },
      data: { status: "Replan Required", notes },
    });
  }
}

function adjustSourceRowQty(bucket, sourceType, sourceLineId, delta) {
  const row = bucket.sourceRows.find((item) => item.sourceType === sourceType && item.sourceLineId === sourceLineId);
  if (!row) return;
  row.qty = Math.max(number(row.qty) + delta, 0);
  bucket.sourceRows = bucket.sourceRows.filter((item) => number(item.qty) > 0.000001);
}

// Monthly buckets are presentation/execution buckets, while Forecast
// consumption is selected at delivery-phase level. Reconcile explicit links
// across month boundaries before MPS quantities are calculated.
function alignExplicitForecastConsumptionAcrossBuckets(buckets) {
  const forecastById = new Map();
  const sales = [];
  for (const [key, bucket] of buckets) {
    bucket.forecastTargets.forEach((target) => forecastById.set(target.id, { key, bucket, target }));
    bucket.soTargets.forEach((target) => sales.push({ key, bucket, target }));
  }
  sales.sort((left, right) => new Date(left.target.targetDate) - new Date(right.target.targetDate) || String(left.target.id).localeCompare(String(right.target.id)));

  for (const saleRef of sales) {
    const sale = saleRef.target;
    if (!sale.consumesForecastTargetId) continue;
    const forecastRef = forecastById.get(sale.consumesForecastTargetId);
    if (!forecastRef) continue;
    const saleMonth = planningMonthKey(sale.targetDate);
    const forecastMonth = planningMonthKey(forecastRef.target.targetDate);
    if (!saleMonth || !forecastMonth || saleMonth === forecastMonth) continue;
    const matchedQty = Math.min(number(sale.qty), number(forecastRef.target.qty));
    if (matchedQty <= 0.000001) continue;

    if (saleMonth < forecastMonth) {
      // The firm SO is earlier: consume the selected future Forecast from its
      // original month and keep the SO in its earlier execution month.
      const policy = String(forecastRef.bucket.part?.planningPolicy || "MTO").toUpperCase();
      const forecastReduction = policy === "MTO" ? number(forecastRef.target.qty) : matchedQty;
      forecastRef.target.qty = Math.max(number(forecastRef.target.qty) - forecastReduction, 0);
      forecastRef.bucket.forecastQty = Math.max(number(forecastRef.bucket.forecastQty) - forecastReduction, 0);
      adjustSourceRowQty(forecastRef.bucket, "FORECAST", forecastRef.target.sourceLineId, -forecastReduction);
      forecastRef.bucket.forecastTargets = forecastRef.bucket.forecastTargets.filter((target) => number(target.qty) > 0.000001);
      sale.matchedForecastTargetId = forecastRef.target.id;
      sale.forecastTargetDate = forecastRef.target.targetDate;
      if (number(sale.qty) > matchedQty + 0.000001) {
        saleRef.bucket.soTargets.push({ ...sale, qty: number(sale.qty) - matchedQty, consumesForecastTargetId: null, matchedForecastTargetId: null, forecastTargetDate: null });
        sale.qty = matchedQty;
      }
      continue;
    }

    // The selected Forecast is earlier than the SO. Move only the matched SO
    // quantity to the Forecast month because the earlier commitment wins.
    const matchedSale = { ...sale, qty: matchedQty, targetDate: forecastRef.target.targetDate };
    saleRef.bucket.soTargets = saleRef.bucket.soTargets.filter((target) => target !== sale);
    saleRef.bucket.actualSalesOrderQty = Math.max(number(saleRef.bucket.actualSalesOrderQty) - matchedQty, 0);
    adjustSourceRowQty(saleRef.bucket, "SALES_ORDER", sale.sourceLineId, -matchedQty);
    if (number(sale.qty) > matchedQty + 0.000001) saleRef.bucket.soTargets.push({ ...sale, qty: number(sale.qty) - matchedQty, consumesForecastTargetId: null });
    forecastRef.bucket.soTargets.push(matchedSale);
    forecastRef.bucket.actualSalesOrderQty += matchedQty;
    const sourceTemplate = saleRef.bucket.sourceRows.find((row) => row.sourceType === "SALES_ORDER" && row.sourceLineId === sale.sourceLineId);
    forecastRef.bucket.sourceRows.push({
      ...(sourceTemplate || { sourceType: "SALES_ORDER", sourceNumber: sale.sourceNumber, sourceLineId: sale.sourceLineId, forecastDetailId: null, soDetailId: sale.sourceLineId, customerCode: sale.customerCode, uomCode: sale.uomCode }),
      periodMonth: utcMonthStart(forecastMonth), qty: matchedQty, requiredDate: forecastRef.target.targetDate, effectiveRequiredDate: forecastRef.target.targetDate,
    });
  }

  for (const [key, bucket] of buckets) {
    if (number(bucket.forecastQty) <= 0.000001 && number(bucket.actualSalesOrderQty) <= 0.000001) buckets.delete(key);
  }
  return buckets;
}

async function collectMonthlyDemand(tx, requestedMonths = null, anchorMonth = null, selectedDeliveryTargetIds = null) {
  const currentMonth = planningMonthKey(new Date());
  const effectiveAnchor = anchorMonth || currentMonth;
  const selectedIds = selectedDeliveryTargetIds?.size
    ? selectedDeliveryTargetIds
    : (Array.isArray(selectedDeliveryTargetIds) && selectedDeliveryTargetIds.length
      ? new Set(selectedDeliveryTargetIds.map(String))
      : null);
  const [forecasts, soLines] = await Promise.all([
    tx.forecast.findMany({
      where: {
        isDeleted: false,
        isCurrentVersion: true,
        status: { in: OPEN_FORECAST_STATUSES },
      },
      select: {
        forecastNumber: true,
        customerCode: true,
        details: {
          where: { isDeleted: false },
          select: {
            id: true,
            partCode: true,
            uomCode: true,
            M1Forecast: true,
            M1Qty: true,
            M2Forecast: true,
            M2Qty: true,
            M3Forecast: true,
            M3Qty: true,
            deliveryTargets: { where: { isDeleted: false, status: "ACTIVE" }, orderBy: { phaseNumber: "asc" }, select: { id: true, targetDate: true, qty: true, customerCode: true, sourceType: true, consumesForecastTargetId: true } },
            part: {
              select: {
                id: true,
                partCode: true,
                itemType: true,
                planningPolicy: true,
                bufferStock: true,
                baseUomCode: true,
                productionUomCode: true,
                mbomHeaders: {
                  where: { isDeleted: false },
                  orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
                  select: { id: true, noReg: true, revision: true, revisionNote: true, effectiveDate: true, expiryDate: true, createdAt: true, isDeleted: true },
                },
              },
            },
          },
        },
      },
    }),
    tx.salesOrderDetail.findMany({
      where: {
        isDeleted: false,
        status: { in: OPEN_SO_LINE_STATUSES },
        soHeader: { isDeleted: false, status: { in: OPEN_SO_STATUSES } },
      },
      select: {
        id: true,
        soNumber: true,
        partCode: true,
        uomCode: true,
        qty: true,
        qtyDelivered: true,
        deliveryDate: true,
        deliveryTargets: { where: { isDeleted: false, status: "ACTIVE" }, orderBy: { phaseNumber: "asc" }, select: { id: true, targetDate: true, qty: true, customerCode: true, sourceType: true, consumesForecastTargetId: true } },
        part: {
          select: {
            id: true,
            partCode: true,
            itemType: true,
            planningPolicy: true,
            bufferStock: true,
            baseUomCode: true,
            productionUomCode: true,
            mbomHeaders: {
              where: { isDeleted: false },
              orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
              select: { id: true, noReg: true, revision: true, revisionNote: true, effectiveDate: true, expiryDate: true, createdAt: true, isDeleted: true },
            },
          },
        },
        soHeader: {
          select: {
            soDate: true,
            deliveryDate: true,
            customerCode: true,
          },
        },
      },
    }),
  ]);

  const buckets = new Map();
  // Buffer look-ahead follows the effective delivery-target month. It is
  // rebuilt after Forecast consumption so an SO that pulls a Forecast phase
  // forward cannot leave the same quantity behind as a future-month buffer.
  const forecastLookahead = new Map();
  for (const forecast of forecasts) {
    for (const detail of forecast.details) {
      if (String(detail.part?.itemType || "").toUpperCase() !== "FG") continue;
      const periods = forecastPeriods(detail);
      const fallbackTargets = periods.map((period) => ({ id: null, targetDate: utcMonthEnd(planningMonthKey(period.date)), qty: period.qty, customerCode: forecast.customerCode, sourceType: "FORECAST", forecastOffset: period.offset }));
      const targets = (detail.deliveryTargets || []).length
        ? detail.deliveryTargets.map((target) => ({ ...target, forecastOffset: periods.length === 1 ? periods[0].offset : null }))
        : fallbackTargets;
      const targetGroups = groupTargetsByDeliveryMonth(targets.filter((target) => targetIncludedInMpsSelection(target, selectedIds)), effectiveAnchor);
      for (const [month, monthTargets] of targetGroups) {
        if (!requestedMonths && month < currentMonth) continue;
        const monthQty = monthTargets.reduce((sum, target) => sum + number(target.qty), 0);
        const bucket = demandBucket(buckets, month, detail.partCode, detail.part);
        bucket.forecastQty += monthQty;
        bucket.forecastSources.push(forecast.forecastNumber);
        bucket.customerCodes.push(forecast.customerCode);
        bucket.forecastDetailIds.push(detail.id);
        bucket.forecastOffsets.push(...monthTargets.map((target) => target.forecastOffset).filter(Boolean));
        bucket.uomCodes.push(detail.uomCode);
        bucket.forecastTargets.push(...monthTargets.map((target) => ({ ...target, sourceNumber: forecast.forecastNumber, sourceLineId: detail.id, partCode: detail.partCode, uomCode: detail.uomCode })));
        const earliestTarget = [...monthTargets].sort((left, right) => new Date(left.targetDate) - new Date(right.targetDate))[0];
        bucket.sourceRows.push({
          sourceType: "FORECAST",
          sourceNumber: forecast.forecastNumber,
          sourceLineId: detail.id,
          forecastDetailId: detail.id,
          soDetailId: null,
          customerCode: forecast.customerCode,
          periodMonth: utcMonthStart(month),
          qty: monthQty,
          uomCode: detail.uomCode || detail.part?.productionUomCode || detail.part?.baseUomCode || "pcs",
          requiredDate: earliestTarget?.targetDate || utcMonthEnd(month),
          effectiveRequiredDate: earliestTarget?.targetDate || utcMonthEnd(month),
        });
      }
    }
  }

  for (const line of soLines) {
    if (String(line.part?.itemType || "").toUpperCase() !== "FG") continue;
    const dueDate = line.deliveryDate || line.soHeader?.deliveryDate || line.soHeader?.soDate;
    const outstandingQty = Math.max(number(line.qty) - number(line.qtyDelivered), 0);
    if (!outstandingQty) continue;
    const activeSoTargets = outstandingTargets(line.deliveryTargets || [], line.qtyDelivered, outstandingQty, { id: null, targetDate: dueDate, qty: outstandingQty, customerCode: line.soHeader?.customerCode, sourceType: "SALES_ORDER" })
      .filter((target) => targetIncludedInMpsSelection(target, selectedIds));
    const targetGroups = groupTargetsByDeliveryMonth(activeSoTargets, effectiveAnchor);
    for (const [month, monthTargets] of targetGroups) {
      const monthQty = monthTargets.reduce((sum, target) => sum + number(target.qty), 0);
      const bucket = demandBucket(buckets, month, line.partCode, line.part);
      bucket.actualSalesOrderQty += monthQty;
      bucket.soSources.push(line.soNumber);
      bucket.customerCodes.push(line.soHeader?.customerCode);
      bucket.uomCodes.push(line.uomCode);
      bucket.soTargets.push(...monthTargets.map((target) => ({ ...target, sourceNumber: line.soNumber, sourceLineId: line.id, partCode: line.partCode, uomCode: line.uomCode })));
      const earliestTarget = [...monthTargets].sort((left, right) => new Date(left.targetDate) - new Date(right.targetDate))[0];
      bucket.sourceRows.push({
        sourceType: "SALES_ORDER",
        sourceNumber: line.soNumber,
        sourceLineId: line.id,
        forecastDetailId: null,
        soDetailId: line.id,
        customerCode: line.soHeader?.customerCode,
        periodMonth: utcMonthStart(month),
        qty: monthQty,
        uomCode: line.uomCode || line.part?.productionUomCode || line.part?.baseUomCode || "pcs",
        requiredDate: earliestTarget?.targetDate || dueDate,
        effectiveRequiredDate: earliestTarget?.targetDate || dueDate,
      });
    }
  }

  alignExplicitForecastConsumptionAcrossBuckets(buckets);
  for (const bucket of buckets.values()) {
    const lookaheadKey = `${bucket.month}|${bucket.partCode}`;
    forecastLookahead.set(
      lookaheadKey,
      number(forecastLookahead.get(lookaheadKey)) + number(bucket.forecastQty),
    );
  }
  if (requestedMonths) {
    for (const [key, bucket] of buckets) {
      if (!requestedMonths.has(bucket.month)) buckets.delete(key);
    }
  }
  return { buckets, forecasts, forecastLookahead };
}

// SO consumes forecast FIFO. For the matched quantity, the earlier Marketing
// commitment wins. This prevents a later SO date from relaxing a forecast and
// lets an earlier SO pull production forward without duplicating the demand.
function effectiveDeliveryTargets(bucket) {
  return consumeDeliveryTargets({
    forecastTargets: bucket.forecastTargets,
    salesOrderTargets: bucket.soTargets,
    part: bucket.part,
  });
}

async function nextMonthlyMpsNumber(tx, month) {
  const preferred = `MPS-${month.replace("-", "")}`;
  const occupied = await tx.mPS.findUnique({ where: { mpsNumber: preferred }, select: { sourceKey: true } });
  if (!occupied || occupied.sourceKey === sourceKeyForMonth(month)) return preferred;
  let attempt = 1;
  while (attempt < 100) {
    const candidate = `${preferred}-${String(attempt).padStart(2, "0")}`;
    const exists = await tx.mPS.findUnique({ where: { mpsNumber: candidate }, select: { id: true } });
    if (!exists) return candidate;
    attempt += 1;
  }
  throw new Error(`Nomor MPS bulanan untuk ${month} tidak dapat dibuat`);
}

function lineNotes(bucket, syncedAt) {
  const forecasts = uniq(bucket.forecastSources).join(", ") || "-";
  const salesOrders = uniq(bucket.soSources).join(", ") || "-";
  return `${FG_RECEIPT_PREFIX} Monthly demand; forecast ${forecasts}; SO ${salesOrders}; synced ${syncedAt.toISOString()}`;
}

function resolveActiveCanonicalMpsStatus(currentStatus, demandChanged) {
  if (["Superseded", "Cancelled"].includes(currentStatus)) return "Draft";
  if (demandChanged && ["Confirmed", "Released", "Completed"].includes(currentStatus)) {
    return currentStatus === "Released" ? "Released" : "Draft";
  }
  return currentStatus;
}

function resolveActiveCanonicalMpsLifecycle(status, demandChanged, simulationOnly = false) {
  if (demandChanged && status === "Released") return "REPLAN_REQUIRED";
  if (simulationOnly) return "SIMULATED";
  if (status === "Released") return "RELEASED";
  if (status === "Completed") return "COMPLETED";
  if (status === "Confirmed") return demandChanged ? "DRAFT" : "REVIEWED";
  return "DRAFT";
}

async function previewMonthlyMbomSelections(tx, options = {}) {
  const selection = normalizeMpsRunSelection(options);
  const anchorMonth = planningMonthKey(options.planningAnchorMonth || selection.months[0] || new Date());
  const requestedMonths = selection.months.length
    ? new Set(selection.months)
    : null;
  const { buckets } = await collectMonthlyDemand(tx, requestedMonths, anchorMonth, selection.selectedDeliveryTargetIds);
  return [...buckets.values()].sort((left, right) => `${left.month}|${left.partCode}`.localeCompare(`${right.month}|${right.partCode}`)).map((bucket) => {
    const sourceDates = bucket.sourceRows.map((row) => row.effectiveRequiredDate || row.requiredDate).filter(Boolean).sort((left, right) => new Date(left) - new Date(right));
    const selectionDate = sourceDates[0] || utcMonthStart(bucket.month);
    const resolution = resolveMbomRevision({ revisions: bucket.part?.mbomHeaders || [], selectionDate });
    return {
      key: monthlySelectionKey(bucket.month, bucket.partCode),
      month: bucket.month,
      partId: bucket.partId,
      partCode: bucket.partCode,
      selectionDate,
      autoSelectedId: resolution.revision?.id || null,
      warning: resolution.warning,
      revisions: (bucket.part?.mbomHeaders || []).map((revision) => ({
        ...revision,
        effectiveForSelectionDate: isRevisionEffectiveAt(revision, selectionDate),
      })),
    };
  });
}

async function syncMonthlyMps(tx, options = {}) {
  const selection = normalizeMpsRunSelection(options);
  const anchorMonth = planningMonthKey(options.planningAnchorMonth || selection.months[0] || new Date());
  const requestedMonths = selection.months.length
    ? new Set(selection.months)
    : null;
  const selectedDemand = await collectMonthlyDemand(tx, requestedMonths, anchorMonth, selection.selectedDeliveryTargetIds);
  // Line selection limits which delivery targets become MPS rows, but buffer
  // must keep reading the complete next-month Forecast horizon. Otherwise
  // unchecking October would incorrectly erase September's look-ahead buffer.
  const completeDemand = selection.selectedDeliveryTargetIds.length
    ? await collectMonthlyDemand(tx, null, anchorMonth)
    : selectedDemand;
  const { buckets, forecasts } = selectedDemand;
  const forecastLookahead = completeDemand.forecastLookahead;
  const deliveryTargetIds = uniq([...buckets.values()].flatMap((bucket) => [...bucket.forecastTargets, ...bucket.soTargets].map((target) => target.id)));
  const decisions = deliveryTargetIds.length ? await tx.demandPlanningDecision.findMany({ where: { deliveryTargetId: { in: deliveryTargetIds }, isDeleted: false } }) : [];
  const decisionByTarget = new Map(decisions.map((row) => [row.deliveryTargetId, row]));
  const monthKeys = uniq([...buckets.values()].map((row) => row.month)).sort();
  const formulas = await getFormulaSet(tx, "planning");
  const partCodes = uniq([...buckets.values()].map((row) => row.partCode));
  const stockRows = partCodes.length
    ? await tx.stockBalance.groupBy({
      by: ["partCode"],
      where: {
        partCode: { in: partCodes },
        isDeleted: false,
        warehouse: { isDeleted: false, availableForProduction: true },
      },
      _sum: { qtyAvailable: true },
    })
    : [];
  const stockByPart = new Map(stockRows.map((row) => [row.partCode, Math.max(number(row._sum?.qtyAvailable), 0)]));
  const docs = [];
  const changedMpsNumbers = [];
  const coveredSoNumbers = new Set();
  const syncedAt = new Date();

  for (const month of monthKeys) {
    const sourceKey = sourceKeyForMonth(month);
    const monthlyBuckets = [...buckets.values()]
      .filter((row) => row.month === month)
      .sort((left, right) => left.partCode.localeCompare(right.partCode));
    let doc = await tx.mPS.findUnique({
      where: { sourceKey },
      include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } },
    });
    const wasCreated = !doc;
    if (!doc) {
      const mpsNumber = await nextMonthlyMpsNumber(tx, month);
      doc = await tx.mPS.create({
        data: {
          mpsNumber,
          sourceKey,
          mpsName: `MPS Bulanan ${month}`,
          periodStart: utcMonthStart(month),
          periodEnd: utcMonthEnd(month),
          forecastNumber: null,
          status: "Draft",
          planningAnchorMonth: utcMonthStart(anchorMonth),
          lifecycleStatus: options.simulationOnly ? "SIMULATED" : "DRAFT",
          simulationOnly: Boolean(options.simulationOnly),
          notes: `Konsolidasi demand Forecast dan Sales Order bulan ${month}`,
          createdBy: options.runBy || "system",
        },
        include: { details: { where: { isDeleted: false } } },
      });
    }
    const reviveCanonical = ["Superseded", "Cancelled"].includes(doc.status);
    await tx.mPS.updateMany({
      where: {
        id: { not: doc.id },
        isDeleted: false,
        periodStart: utcMonthStart(month),
        status: { in: ["Draft", "Confirmed"] },
        NOT: { sourceKey },
      },
      data: {
        status: "Superseded",
        notes: `Digantikan oleh ${doc.mpsNumber}, header MPS bulanan kanonis ${month}`,
      },
    });

    const existingRows = doc.details.filter((row) => !isGeneratedProcess(row));
    const protectReleasedBaseline = doc.status === "Released";
    const proposedDelta = [];
    let demandChanged = wasCreated || reviveCanonical || Boolean(doc.replanRequired);
    const existingByPart = new Map(existingRows.map((row) => [row.partCode, row]));
    const activePartCodes = new Set();
    if (!protectReleasedBaseline) await tx.mPSDeliveryPlan.deleteMany({ where: { mpsNumber: doc.mpsNumber, targetType: "CUSTOMER" } });
    let nextDeliveryPhase = 1;

    for (const [index, bucket] of monthlyBuckets.entries()) {
      activePartCodes.add(bucket.partCode);
      uniq(bucket.soSources).forEach((value) => coveredSoNumbers.add(value));
      const existing = existingByPart.get(bucket.partCode);
      // Use the next forecast month as a look-ahead source. The next month is
      // deliberately not part of `buckets` when PPIC processes one month at a
      // time, but it must still drive the current month's safety buffer.
      const nextForecastKey = `${nextPlanningMonthKey(month)}|${bucket.partCode}`;
      const bufferBaseQty = number(forecastLookahead.get(nextForecastKey));
      const bufferPercent = existing?.bufferOverridden
        ? number(existing.bufferPercent)
        : Math.max(number(bucket.part?.bufferStock), 0);
      const productionPercent = existing?.productionOverridden
        ? number(existing.productionPercent)
        : 100;
      const uomCode = uniq(bucket.uomCodes)[0]
        || bucket.part?.productionUomCode
        || bucket.part?.baseUomCode
        || "pcs";
      const forecastQty = normalizeQuantity(bucket.forecastQty, uomCode);
      const actualSalesOrderQty = normalizeQuantity(bucket.actualSalesOrderQty, uomCode);
      const bufferQty = normalizeQuantity(evaluateBuffer(formulas, {
        bufferBaseQty,
        bufferPercent,
        stockAvailableQty: stockByPart.get(bucket.partCode) || 0,
      }), uomCode);
      // MTO replaces provisional Forecast with firm SO, while MTS keeps the
      // larger signal. Buffer is an ending-inventory target and is therefore
      // added after that policy resolution; it must never be swallowed by the
      // MTO max(Forecast, SO) rule.
      const policyDemandQty = normalizeQuantity(resolvePolicyDemandQty({
        forecastQty,
        salesOrderQty: actualSalesOrderQty,
        part: bucket.part,
      }), uomCode);
      const formulaEffectiveDemandQty = normalizeQuantity(evaluateFromSet(formulas, "MPS_EFFECTIVE_DEMAND", {
        forecastQty: policyDemandQty,
        bufferQty,
      }), uomCode);
      const effectiveDemandQty = Math.max(formulaEffectiveDemandQty, normalizeQuantity(effectiveDemandWithBuffer({
        forecastQty,
        salesOrderQty: actualSalesOrderQty,
        bufferQty,
        part: bucket.part,
      }), uomCode));
      const formulaTargetQty = normalizeQuantity(evaluateFromSet(formulas, "MPS_TARGET_QTY", {
        effectiveDemandQty,
        productionPercent,
        actualSalesOrderQty,
      }), uomCode);
      const qtyPlanned = formulaTargetQty;
      const customerCodes = uniq(bucket.customerCodes);
      const forecastDetailIds = uniq(bucket.forecastDetailIds);
      const offsets = uniq(bucket.forecastOffsets);
      const effectiveTargets = effectiveDeliveryTargets(bucket);
      const decisionForTarget = (target) => decisionByTarget.get(target.matchedForecastTargetId || target.id) || decisionByTarget.get(target.id);
      const targetDecisions = effectiveTargets.map((target) => ({ target, decision: decisionForTarget(target) })).filter((row) => row.decision);
      const leadingDecision = [...targetDecisions].sort((left, right) => number(right.decision.finalPriorityScore) - number(left.decision.finalPriorityScore))[0]?.decision || null;
      const earliestTarget = [...effectiveTargets].sort((left, right) => new Date(left.targetDate) - new Date(right.targetDate))[0] || null;
      const finishSplitsByTarget = new Map(effectiveTargets.map((target) => [
        target.id,
        fgFinishSplitsForTarget(target, decisionForTarget(target), uomCode),
      ]));
      const earliestFgRequired = [...finishSplitsByTarget.values()].flat()
        .map((row) => row.targetFinishDate).filter(Boolean)
        .sort((left, right) => new Date(left) - new Date(right))[0]
        || earliestTarget?.targetDate || null;
      const mbomSelectionDate = earliestFgRequired || utcMonthStart(month);
      const mbomResolution = resolveMbomRevision({
        revisions: bucket.part?.mbomHeaders || [],
        selectionDate: mbomSelectionDate,
        selectedId: selectedRevisionId(options.mbomSelections, month, bucket.partCode),
      });
      const selectedMbom = mbomResolution.revision;
      const data = {
        lineNumber: index + 1,
        partCode: bucket.partCode,
        forecastQty,
        actualSalesOrderQty,
        bufferBaseQty: normalizeQuantity(bufferBaseQty, uomCode),
        bufferPercent,
        bufferQty,
        effectiveDemandQty,
        productionPercent,
        demandPolicy: String(bucket.part?.planningPolicy || "MTO").toUpperCase() === "MTS" ? "MTS" : "MTO",
        qtyPlanned,
        startDate: utcMonthStart(month),
        endDate: utcMonthEnd(month),
        priority: existing?.priority || 1,
        status: existing?.status === "Cancelled"
          || (existing?.status === "Completed" && qtyPlanned > number(existing.qtyPlanned) + 0.000001)
          ? "Planned"
          : (existing?.status || "Planned"),
        soNumber: uniq(bucket.soSources).join(",") || null,
        customerCode: customerCodes.length === 1 ? customerCodes[0] : (customerCodes.length ? "MULTI" : null),
        deliveryPhaseId: effectiveTargets.length === 1 ? effectiveTargets[0].id : null,
        customerTargetDate: earliestTarget?.targetDate || null,
        fgRequiredDate: earliestFgRequired,
        mbomSelectionMode: mbomResolution.mode,
        mbomSelectionDate: mbomResolution.selectionDate,
        mbomRevisionSnapshot: selectedMbom?.revision ?? null,
        mbomNoRegSnapshot: selectedMbom?.noReg || null,
        mbomSelectionWarning: mbomResolution.warning,
        priorityScore: leadingDecision?.finalPriorityScore ?? null,
        priorityClass: leadingDecision?.priorityClass || null,
        forecastPeriodOffset: offsets.length === 1 ? offsets[0] : null,
        notes: lineNotes(bucket, syncedAt),
        isDeleted: false,
        ...(bucket.partId ? { part: { connect: { id: bucket.partId } } } : {}),
        ...(selectedMbom?.id
          ? { mbom: { connect: { id: selectedMbom.id } } }
          : (existing?.mbomHeaderId ? { mbom: { disconnect: true } } : {})),
        ...(forecastDetailIds.length === 1
          ? { forecastDetail: { connect: { id: forecastDetailIds[0] } } }
          : (existing ? { forecastDetail: { disconnect: true } } : {})),
      };
      const lineChanged = !existing || [
        "forecastQty", "actualSalesOrderQty", "bufferBaseQty", "bufferPercent",
        "bufferQty", "effectiveDemandQty", "productionPercent", "qtyPlanned",
      ].some((field) => Math.abs(number(existing?.[field]) - number(data[field])) > 0.000001)
        || String(existing?.demandPolicy || "") !== String(data.demandPolicy || "")
        || String(existing?.soNumber || "") !== String(data.soNumber || "")
        || String(existing?.customerCode || "") !== String(data.customerCode || "")
        || String(existing?.mbomHeaderId || "") !== String(selectedMbom?.id || "")
        || String(existing?.mbomSelectionMode || "") !== String(data.mbomSelectionMode || "")
        || number(existing?.mbomRevisionSnapshot) !== number(data.mbomRevisionSnapshot)
        || String(existing?.mbomNoRegSnapshot || "") !== String(data.mbomNoRegSnapshot || "");
      if (lineChanged) {
        demandChanged = true;
      }
      if (protectReleasedBaseline) {
        if (lineChanged) proposedDelta.push({ partCode: bucket.partCode, currentQty: number(existing?.qtyPlanned), proposedQty: number(data.qtyPlanned), deltaQty: number(data.qtyPlanned) - number(existing?.qtyPlanned), currentCustomerTargetDate: existing?.customerTargetDate || null, proposedCustomerTargetDate: data.customerTargetDate || null, currentFgRequiredDate: existing?.fgRequiredDate || null, proposedFgRequiredDate: data.fgRequiredDate || null, currentPriorityScore: existing?.priorityScore ?? null, proposedPriorityScore: data.priorityScore ?? null, changeType: existing ? "UPDATED" : "ADDED" });
        continue;
      }
      const savedDetail = existing
        ? await tx.mPSDetail.update({ where: { id: existing.id }, data })
        : await tx.mPSDetail.create({ data: { ...data, mps: { connect: { mpsNumber: doc.mpsNumber } } } });
      await tx.mPSDemandSource.deleteMany({ where: { mpsDetailId: savedDetail.id } });
      if (bucket.sourceRows.length) {
        const effectiveDateBySource = new Map();
        for (const target of effectiveTargets) {
          const key = `${target.sourceType}|${target.sourceLineId}`;
          if (!effectiveDateBySource.has(key)) effectiveDateBySource.set(key, target.targetDate);
        }
        await tx.mPSDemandSource.createMany({
          data: bucket.sourceRows.map((source) => {
            const sourceTargets = effectiveTargets.filter((target) => target.sourceType === source.sourceType && target.sourceLineId === source.sourceLineId);
            const sourceDecisions = sourceTargets.map((target) => decisionForTarget(target)).filter(Boolean).sort((left, right) => number(right.finalPriorityScore) - number(left.finalPriorityScore));
            const sourceDecision = sourceDecisions[0] || null;
            return { ...source, effectiveRequiredDate: effectiveDateBySource.get(`${source.sourceType}|${source.sourceLineId}`) || source.effectiveRequiredDate, deliveryTargetId: sourceTargets.length === 1 ? sourceTargets[0].id : null, targetDeliveryDate: sourceTargets.map((target) => target.targetDate).filter(Boolean).sort((left, right) => new Date(left) - new Date(right))[0] || source.requiredDate, fgRequiredDate: sourceDecision?.fgRequiredDate || null, priorityScore: sourceDecision?.finalPriorityScore ?? null, priorityClass: sourceDecision?.priorityClass || null, bufferPercent: number(sourceDecision?.bufferPercent), bufferQty: number(sourceDecision?.bufferQty), sourcePegging: sourceTargets.map((target) => ({ deliveryTargetId: target.id, targetDeliveryDate: target.targetDate?.toISOString?.() || target.targetDate, matchedForecastTargetId: target.matchedForecastTargetId || null, forecastTargetDate: target.forecastTargetDate?.toISOString?.() || target.forecastTargetDate || null, qty: number(target.qty), customerCode: target.customerCode || null, priorityScore: decisionForTarget(target)?.finalPriorityScore ?? null, priorityClass: decisionForTarget(target)?.priorityClass || null, fgFinishSplits: (finishSplitsByTarget.get(target.id) || []).map((split) => ({ ...split, targetFinishDate: split.targetFinishDate?.toISOString?.() || split.targetFinishDate })) })), mpsDetailId: savedDetail.id };
          }),
        });
        if (effectiveTargets.length) {
          await tx.mPSDeliveryPlan.createMany({ data: effectiveTargets.flatMap((target) => (finishSplitsByTarget.get(target.id) || []).map((split) => ({
            mpsNumber: doc.mpsNumber,
            mpsDetailId: savedDetail.id,
            phaseNumber: nextDeliveryPhase++,
            targetType: "CUSTOMER",
            targetCode: target.customerCode || (customerCodes.length === 1 ? customerCodes[0] : "MULTI"),
            partCode: bucket.partCode,
            plannedDate: target.targetDate,
            fgRequiredDate: split.targetFinishDate,
            fgFinishSplitNumber: split.phaseNumber,
            qtyPlanned: split.qty,
            uomCode,
            sourceDeliveryTargetId: target.id,
            sourceType: target.sourceType,
            sourceNumber: target.sourceNumber || null,
            lockedBySource: true,
            notes: `${target.matchedForecastTargetId ? `SO lebih awal/efektif; match forecast target ${target.matchedForecastTargetId}` : "Target delivery Marketing"}; FG finish split ${split.phaseNumber}`,
            createdBy: options.runBy || "system",
          }))) });
        }
      }
    }

    const obsoleteIds = existingRows
      .filter((row) => !activePartCodes.has(row.partCode) && !["In Progress", "Completed"].includes(row.status))
      .map((row) => row.id);
    if (obsoleteIds.length) {
      demandChanged = true;
      if (protectReleasedBaseline) obsoleteIds.forEach((id) => { const existing = existingRows.find((row) => row.id === id); proposedDelta.push({ partCode: existing?.partCode || null, currentQty: number(existing?.qtyPlanned), proposedQty: 0, deltaQty: -number(existing?.qtyPlanned), changeType: "REMOVED" }); });
      else await tx.mPSDetail.updateMany({
        where: { id: { in: obsoleteIds } },
        data: { isDeleted: true, status: "Cancelled" },
      });
    }
    const nextStatus = resolveActiveCanonicalMpsStatus(doc.status, demandChanged);
    await tx.mPS.update({
      where: { id: doc.id },
      data: {
        mpsName: `MPS Bulanan ${month}`,
        periodStart: utcMonthStart(month),
        periodEnd: utcMonthEnd(month),
        forecastNumber: null,
        status: nextStatus,
        ...(demandChanged && !protectReleasedBaseline ? { approvedBy: null, approvedDate: null } : {}),
        notes: `Konsolidasi demand Forecast dan Sales Order bulan ${month}; terakhir dihitung ${syncedAt.toISOString()}`,
        replanRequired: false,
        replanReason: demandChanged && doc.status === "Released" ? "Demand source berubah setelah MPS released; review delta sebelum release ulang." : null,
        sourceDelta: demandChanged ? { detectedAt: syncedAt.toISOString(), source: "DEMAND_PLANNING", action: doc.status === "Released" ? "REVIEW_REQUIRED" : "RECALCULATED", ...(protectReleasedBaseline ? { proposedDelta } : {}) } : undefined,
        planningAnchorMonth: utcMonthStart(anchorMonth),
        lifecycleStatus: resolveActiveCanonicalMpsLifecycle(nextStatus, demandChanged, options.simulationOnly),
        simulationOnly: Boolean(options.simulationOnly),
        ...(demandChanged && doc.status === "Released" ? { replanRequired: true, sourceChangedAt: syncedAt } : { replanRequired: false }),
        lastReplannedAt: syncedAt,
      },
    });
    if (demandChanged && !protectReleasedBaseline) changedMpsNumbers.push(doc.mpsNumber);
    docs.push(await tx.mPS.findUnique({
      where: { id: doc.id },
      include: {
        details: {
          where: { isDeleted: false },
          orderBy: [{ startDate: "asc" }, { lineNumber: "asc" }],
          include: { part: { include: { process: true } }, forecastDetail: true, demandSources: { orderBy: [{ sourceType: "asc" }, { sourceNumber: "asc" }] }, mbom: true },
        },
      },
    }));
  }

  // A target may move to another delivery month after recalculation. Retire an
  // empty Draft/Confirmed header in the requested window so stale demand does
  // not remain executable under the old month. Released/Completed history is
  // preserved and explicitly marked for replan.
  if (requestedMonths) {
    const emptyMonths = [...requestedMonths].filter((month) => !monthKeys.includes(month));
    for (const month of emptyMonths) {
      const stale = await tx.mPS.findUnique({ where: { sourceKey: sourceKeyForMonth(month) } });
      if (!stale || stale.isDeleted || stale.status === "Superseded") continue;
      const protectedHistory = ["Released", "Completed"].includes(stale.status);
      await tx.mPS.update({
        where: { id: stale.id },
        data: protectedHistory ? {
          replanRequired: true,
          replanReason: `Tidak ada Target Delivery aktif pada ${month}; historical MPS dipertahankan dan memerlukan review.`,
          sourceChangedAt: syncedAt,
          lifecycleStatus: "REPLAN_REQUIRED",
          sourceDelta: { detectedAt: syncedAt.toISOString(), source: "TARGET_DELIVERY", action: "REMOVE_MONTH_REVIEW_REQUIRED" },
        } : {
          status: "Superseded",
          lifecycleStatus: "SUPERSEDED",
          notes: `Tidak ada Target Delivery aktif pada ${month}; superseded saat rolling MPS ${syncedAt.toISOString()}.`,
          replanRequired: false,
        },
      });
      changedMpsNumbers.push(stale.mpsNumber);
    }
  }

  await invalidateDownstreamPlans(tx, changedMpsNumbers, options.runBy);

  const consumedForecasts = [];
  const partialForecasts = [];
  const explicitlySelectedTargets = selection.selectedDeliveryTargetIds.length
    ? new Set(selection.selectedDeliveryTargetIds)
    : null;
  for (const forecast of forecasts) {
    const forecastTargets = forecast.details.flatMap((detail) => detail.deliveryTargets || []).filter((target) => number(target.qty) > 0);
    const periods = forecast.details.flatMap((detail) => forecastPeriods(detail));
    const hasProcessedPeriod = explicitlySelectedTargets && forecastTargets.length
      ? forecastTargets.some((target) => explicitlySelectedTargets.has(String(target.id)))
      : periods.some((period) => monthKeys.includes(planningMonthKey(period.date)));
    const hasRemainingPeriod = explicitlySelectedTargets && forecastTargets.length
      ? forecastTargets.some((target) => !explicitlySelectedTargets.has(String(target.id)))
      : periods.some((period) => !monthKeys.includes(planningMonthKey(period.date)));
    if (hasProcessedPeriod && hasRemainingPeriod) partialForecasts.push(forecast.forecastNumber);
    else if (hasProcessedPeriod) consumedForecasts.push(forecast.forecastNumber);
  }
  if (consumedForecasts.length) {
    await tx.forecast.updateMany({
      where: {
        forecastNumber: { in: consumedForecasts },
        status: { in: ["Confirmed", "Partial Product", "Consumed"] },
      },
      data: { status: "Consumed" },
    });
  }
  if (partialForecasts.length) {
    await tx.forecast.updateMany({
      where: {
        forecastNumber: { in: partialForecasts },
        status: { in: ["Confirmed", "Partial Product", "Consumed"] },
      },
      data: { status: "Partial Product" },
    });
  }

  return {
    docs,
    months: monthKeys,
    changedMpsNumbers,
    coveredSoNumbers: [...coveredSoNumbers],
    consumedForecasts,
    partialForecasts,
  };
}

module.exports = {
  MONTHLY_SOURCE_PREFIX,
  sourceKeyForMonth,
  targetDeliveryMonth,
  groupTargetsByDeliveryMonth,
  alignExplicitForecastConsumptionAcrossBuckets,
  resolveActiveCanonicalMpsStatus,
  resolveActiveCanonicalMpsLifecycle,
  normalizeMpsRunSelection,
  targetIncludedInMpsSelection,
  syncMonthlyMps,
  previewMonthlyMbomSelections,
};
