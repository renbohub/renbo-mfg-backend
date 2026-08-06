const { getFormulaSet, evaluateFromSet } = require("../masterFormulaService");
const { normalizeQuantity } = require("../../utils/uomQuantity");
const {
  planningMonthKey,
  utcMonthStart,
  utcMonthEnd,
  nextPlanningMonthKey,
} = require("../../utils/planningMonth");

const FG_RECEIPT_PREFIX = "[FG-RECEIPT]";
const MONTHLY_SOURCE_PREFIX = "MONTH:";
const OPEN_FORECAST_STATUSES = ["Confirmed", "Consumed", "Partial Product"];
const OPEN_SO_STATUSES = ["Confirmed", "In Progress", "In Production", "Ready to Deliver"];
const OPEN_SO_LINE_STATUSES = ["Pending", "In Planning", "In Production"];

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const uniq = (values) => [...new Set(values.filter(Boolean))];
const sourceKeyForMonth = (month) => `${MONTHLY_SOURCE_PREFIX}${month}`;
const isGeneratedProcess = (row) => String(row?.notes || "").startsWith("[MRP-PRODUCTION]");

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

function evaluateBuffer(formulas, variables) {
  const result = evaluateFromSet(formulas, "MPS_BUFFER_QTY", variables);
  // Keep MPS as gross demand. Stock coverage belongs to MRP netting only.
  return Math.max(result, 0);
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

async function collectMonthlyDemand(tx, requestedMonths = null) {
  const currentMonth = planningMonthKey(new Date());
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
            deliveryTargets: { where: { isDeleted: false, status: "ACTIVE" }, orderBy: { phaseNumber: "asc" }, select: { id: true, targetDate: true, qty: true, customerCode: true, sourceType: true } },
            part: {
              select: {
                id: true,
                partCode: true,
                itemType: true,
                bufferStock: true,
                baseUomCode: true,
                productionUomCode: true,
                mbomHeaders: {
                  where: { isDeleted: false },
                  orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
                  take: 1,
                  select: { id: true },
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
        deliveryTargets: { where: { isDeleted: false, status: "ACTIVE" }, orderBy: { phaseNumber: "asc" }, select: { id: true, targetDate: true, qty: true, customerCode: true, sourceType: true } },
        part: {
          select: {
            id: true,
            partCode: true,
            itemType: true,
            bufferStock: true,
            baseUomCode: true,
            productionUomCode: true,
            mbomHeaders: {
              where: { isDeleted: false },
              orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
              take: 1,
              select: { id: true },
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
  // Buffer for the month being processed may come from the next forecast
  // month even when that month is intentionally not materialized into MPS yet
  // (for example, run August first and September later). Keep this look-ahead
  // map separate from demand buckets so September is used only as a buffer
  // source and never creates an August MPS line or delivery source.
  const forecastLookahead = new Map();
  for (const forecast of forecasts) {
    for (const detail of forecast.details) {
      if (String(detail.part?.itemType || "").toUpperCase() !== "FG") continue;
      for (const period of forecastPeriods(detail)) {
        const month = planningMonthKey(period.date);
        if (month && detail.partCode) {
          const lookaheadKey = `${month}|${detail.partCode}`;
          forecastLookahead.set(
            lookaheadKey,
            number(forecastLookahead.get(lookaheadKey)) + period.qty,
          );
        }
        if (!month || (requestedMonths && !requestedMonths.has(month))) continue;
        if (!requestedMonths && month < currentMonth) continue;
        const bucket = demandBucket(buckets, month, detail.partCode, detail.part);
        bucket.forecastQty += period.qty;
        bucket.forecastSources.push(forecast.forecastNumber);
        bucket.customerCodes.push(forecast.customerCode);
        bucket.forecastDetailIds.push(detail.id);
        bucket.forecastOffsets.push(period.offset);
        bucket.uomCodes.push(detail.uomCode);
        const periodTargets = (detail.deliveryTargets || []).length ? detail.deliveryTargets : [{ id: null, targetDate: utcMonthEnd(month), qty: period.qty, customerCode: forecast.customerCode, sourceType: "FORECAST" }];
        bucket.forecastTargets.push(...periodTargets.map((target) => ({ ...target, sourceNumber: forecast.forecastNumber, sourceLineId: detail.id, partCode: detail.partCode, uomCode: detail.uomCode })));
        bucket.sourceRows.push({
          sourceType: "FORECAST",
          sourceNumber: forecast.forecastNumber,
          sourceLineId: detail.id,
          forecastDetailId: detail.id,
          soDetailId: null,
          customerCode: forecast.customerCode,
          periodMonth: utcMonthStart(month),
          qty: period.qty,
          uomCode: detail.uomCode || detail.part?.productionUomCode || detail.part?.baseUomCode || "pcs",
          requiredDate: periodTargets[0]?.targetDate || period.date,
          effectiveRequiredDate: periodTargets[0]?.targetDate || period.date,
        });
      }
    }
  }

  for (const line of soLines) {
    if (String(line.part?.itemType || "").toUpperCase() !== "FG") continue;
    const dueDate = line.deliveryDate || line.soHeader?.deliveryDate || line.soHeader?.soDate;
    const dueMonth = planningMonthKey(dueDate);
    const month = !requestedMonths && dueMonth && dueMonth < currentMonth ? currentMonth : dueMonth;
    if (!month || (requestedMonths && !requestedMonths.has(month))) continue;
    const outstandingQty = Math.max(number(line.qty) - number(line.qtyDelivered), 0);
    if (!outstandingQty) continue;
    const bucket = demandBucket(buckets, month, line.partCode, line.part);
    bucket.actualSalesOrderQty += outstandingQty;
    bucket.soSources.push(line.soNumber);
    bucket.customerCodes.push(line.soHeader?.customerCode);
    bucket.uomCodes.push(line.uomCode);
    const activeSoTargets = outstandingTargets(line.deliveryTargets || [], line.qtyDelivered, outstandingQty, { id: null, targetDate: dueDate, qty: outstandingQty, customerCode: line.soHeader?.customerCode, sourceType: "SALES_ORDER" });
    bucket.soTargets.push(...activeSoTargets.map((target) => ({ ...target, sourceNumber: line.soNumber, sourceLineId: line.id, partCode: line.partCode, uomCode: line.uomCode })));
    bucket.sourceRows.push({
      sourceType: "SALES_ORDER",
      sourceNumber: line.soNumber,
      sourceLineId: line.id,
      forecastDetailId: null,
      soDetailId: line.id,
      customerCode: line.soHeader?.customerCode,
      periodMonth: utcMonthStart(month),
      qty: outstandingQty,
      uomCode: line.uomCode || line.part?.productionUomCode || line.part?.baseUomCode || "pcs",
      requiredDate: activeSoTargets[0]?.targetDate || dueDate,
      effectiveRequiredDate: activeSoTargets[0]?.targetDate || dueDate,
    });
  }

  return { buckets, forecasts, forecastLookahead };
}

// SO consumes forecast FIFO. For the matched quantity, the earlier Marketing
// commitment wins. This prevents a later SO date from relaxing a forecast and
// lets an earlier SO pull production forward without duplicating the demand.
function effectiveDeliveryTargets(bucket) {
  const forecast = bucket.forecastTargets.map((row) => ({ ...row, remaining: number(row.qty) }));
  const sales = bucket.soTargets.map((row) => ({ ...row, remaining: number(row.qty) }));
  const result = [];
  let forecastIndex = 0;
  for (const sale of sales) {
    while (sale.remaining > 0.000001 && forecastIndex < forecast.length) {
      const target = forecast[forecastIndex];
      if (target.remaining <= 0.000001) { forecastIndex += 1; continue; }
      const qty = Math.min(sale.remaining, target.remaining);
      const targetDate = new Date(sale.targetDate) < new Date(target.targetDate) ? sale.targetDate : target.targetDate;
      result.push({ ...sale, qty, targetDate, sourceType: "SALES_ORDER", matchedForecastTargetId: target.id });
      sale.remaining -= qty; target.remaining -= qty;
    }
    if (sale.remaining > 0.000001) result.push({ ...sale, qty: sale.remaining, sourceType: "SALES_ORDER" });
  }
  for (const target of forecast) if (target.remaining > 0.000001) result.push({ ...target, qty: target.remaining, sourceType: "FORECAST" });
  return result.sort((left, right) => new Date(left.targetDate) - new Date(right.targetDate));
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

async function syncMonthlyMps(tx, options = {}) {
  const requestedMonths = Array.isArray(options.months) && options.months.length
    ? new Set(options.months.map(planningMonthKey).filter(Boolean))
    : null;
  const { buckets, forecasts, forecastLookahead } = await collectMonthlyDemand(tx, requestedMonths);
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
          notes: `Konsolidasi demand Forecast dan Sales Order bulan ${month}`,
          createdBy: options.runBy || "system",
        },
        include: { details: { where: { isDeleted: false } } },
      });
    }
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
    let demandChanged = wasCreated || Boolean(doc.replanRequired);
    const existingByPart = new Map(existingRows.map((row) => [row.partCode, row]));
    const activePartCodes = new Set();
    await tx.mPSDeliveryPlan.deleteMany({ where: { mpsNumber: doc.mpsNumber, targetType: "CUSTOMER" } });
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
      const effectiveDemandQty = normalizeQuantity(evaluateFromSet(formulas, "MPS_EFFECTIVE_DEMAND", {
        forecastQty,
        bufferQty,
      }), uomCode);
      const qtyPlanned = normalizeQuantity(evaluateFromSet(formulas, "MPS_TARGET_QTY", {
        effectiveDemandQty,
        productionPercent,
        actualSalesOrderQty,
      }), uomCode);
      const customerCodes = uniq(bucket.customerCodes);
      const forecastDetailIds = uniq(bucket.forecastDetailIds);
      const offsets = uniq(bucket.forecastOffsets);
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
        forecastPeriodOffset: offsets.length === 1 ? offsets[0] : null,
        notes: lineNotes(bucket, syncedAt),
        isDeleted: false,
        ...(bucket.partId ? { part: { connect: { id: bucket.partId } } } : {}),
        ...(bucket.part?.mbomHeaders?.[0]?.id
          ? { mbom: { connect: { id: bucket.part.mbomHeaders[0].id } } }
          : {}),
        ...(forecastDetailIds.length === 1
          ? { forecastDetail: { connect: { id: forecastDetailIds[0] } } }
          : (existing ? { forecastDetail: { disconnect: true } } : {})),
      };
      if (!existing || [
        "forecastQty", "actualSalesOrderQty", "bufferBaseQty", "bufferPercent",
        "bufferQty", "effectiveDemandQty", "productionPercent", "qtyPlanned",
      ].some((field) => Math.abs(number(existing?.[field]) - number(data[field])) > 0.000001)
        || String(existing?.soNumber || "") !== String(data.soNumber || "")
        || String(existing?.customerCode || "") !== String(data.customerCode || "")) {
        demandChanged = true;
      }
      const savedDetail = existing
        ? await tx.mPSDetail.update({ where: { id: existing.id }, data })
        : await tx.mPSDetail.create({ data: { ...data, mps: { connect: { mpsNumber: doc.mpsNumber } } } });
      await tx.mPSDemandSource.deleteMany({ where: { mpsDetailId: savedDetail.id } });
      if (bucket.sourceRows.length) {
        const effectiveTargets = effectiveDeliveryTargets(bucket);
        const effectiveDateBySource = new Map();
        for (const target of effectiveTargets) {
          const key = `${target.sourceType}|${target.sourceLineId}`;
          if (!effectiveDateBySource.has(key)) effectiveDateBySource.set(key, target.targetDate);
        }
        await tx.mPSDemandSource.createMany({
          data: bucket.sourceRows.map((source) => ({ ...source, effectiveRequiredDate: effectiveDateBySource.get(`${source.sourceType}|${source.sourceLineId}`) || source.effectiveRequiredDate, mpsDetailId: savedDetail.id })),
        });
        if (effectiveTargets.length) {
          await tx.mPSDeliveryPlan.createMany({ data: effectiveTargets.map((target) => ({
            mpsNumber: doc.mpsNumber,
            mpsDetailId: savedDetail.id,
            phaseNumber: nextDeliveryPhase++,
            targetType: "CUSTOMER",
            targetCode: target.customerCode || (customerCodes.length === 1 ? customerCodes[0] : "MULTI"),
            partCode: bucket.partCode,
            plannedDate: target.targetDate,
            qtyPlanned: normalizeQuantity(target.qty, uomCode),
            uomCode,
            sourceDeliveryTargetId: target.id,
            sourceType: target.sourceType,
            lockedBySource: true,
            notes: target.matchedForecastTargetId ? `SO lebih awal/efektif; match forecast target ${target.matchedForecastTargetId}` : "Target delivery Marketing",
            createdBy: options.runBy || "system",
          })) });
        }
      }
    }

    const obsoleteIds = existingRows
      .filter((row) => !activePartCodes.has(row.partCode) && !["In Progress", "Completed"].includes(row.status))
      .map((row) => row.id);
    if (obsoleteIds.length) {
      demandChanged = true;
      await tx.mPSDetail.updateMany({
        where: { id: { in: obsoleteIds } },
        data: { isDeleted: true, status: "Cancelled" },
      });
    }
    await tx.mPS.update({
      where: { id: doc.id },
      data: {
        mpsName: `MPS Bulanan ${month}`,
        periodStart: utcMonthStart(month),
        periodEnd: utcMonthEnd(month),
        forecastNumber: null,
        status: demandChanged && ["Confirmed", "Released", "Completed"].includes(doc.status)
          ? "Draft"
          : (doc.status === "Cancelled" ? "Draft" : doc.status),
        ...(demandChanged ? { approvedBy: null, approvedDate: null } : {}),
        notes: `Konsolidasi demand Forecast dan Sales Order bulan ${month}; terakhir dihitung ${syncedAt.toISOString()}`,
        replanRequired: false,
        replanReason: null,
        lastReplannedAt: syncedAt,
      },
    });
    if (demandChanged) changedMpsNumbers.push(doc.mpsNumber);
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

  await invalidateDownstreamPlans(tx, changedMpsNumbers, options.runBy);

  const consumedForecasts = [];
  const partialForecasts = [];
  for (const forecast of forecasts) {
    const periods = forecast.details.flatMap((detail) => forecastPeriods(detail));
    const hasProcessedPeriod = periods.some((period) => monthKeys.includes(planningMonthKey(period.date)));
    const hasRemainingPeriod = periods.some((period) => !monthKeys.includes(planningMonthKey(period.date)));
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
  syncMonthlyMps,
};
