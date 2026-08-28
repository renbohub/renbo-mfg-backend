const { isOpenForecast } = require("./forecastStatusPolicy");

const EPSILON = 0.000001;

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const validDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

function monthEnd(value) {
  const date = validDate(value);
  return date ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59, 999)) : null;
}

function phasesForRow(row, sourceType, fallbackDate) {
  const input = Array.isArray(row.deliveryTargets)
    ? row.deliveryTargets
    : (Array.isArray(row.deliveryPhases) ? row.deliveryPhases : []);
  const qty = number(sourceType === "FORECAST" ? (row.forecastQty ?? row.M1Qty) : row.qty);
  const phases = input.length ? input : [{ targetDate: fallbackDate, qty }];
  const normalized = phases.map((phase, index) => ({
    phaseNumber: index + 1,
    targetDate: validDate(phase.targetDate || phase.deliveryDate || phase.date),
    qty: number(phase.qty ?? phase.deliveryQty),
    notes: String(phase.notes || "").trim() || null,
    consumesForecastTargetId: sourceType === "SALES_ORDER"
      ? (String(phase.consumesForecastTargetId || phase.forecastTargetId || "").trim() || null)
      : null,
  }));
  if (normalized.some((phase) => !phase.targetDate || phase.qty <= 0)) {
    throw Object.assign(new Error("Setiap phase delivery wajib memiliki tanggal valid dan qty lebih dari 0."), { statusCode: 400 });
  }
  const phaseQty = normalized.reduce((sum, phase) => sum + phase.qty, 0);
  if (Math.abs(phaseQty - qty) > EPSILON) {
    throw Object.assign(new Error(`Total qty phase delivery (${phaseQty}) harus sama dengan qty demand (${qty}).`), { statusCode: 400 });
  }
  return normalized;
}

async function markDownstreamDemandChange(tx, options) {
  const sourceType = options.sourceType;
  const sourceNumbers = [...new Set((options.sourceNumbers || [options.sourceNumber]).filter(Boolean))];
  if (!sourceType || !sourceNumbers.length) return { mpsNumbers: [], planNumbers: [], suggestionNumbers: [] };
  const demandSources = await tx.mPSDemandSource.findMany({
    where: { sourceType, sourceNumber: { in: sourceNumbers } },
    select: { mpsDetailId: true, mpsDetail: { select: { mpsNumber: true } } },
  });
  const mpsNumbers = [...new Set(demandSources.map((row) => row.mpsDetail?.mpsNumber).filter(Boolean))];
  const detailIds = [...new Set(demandSources.map((row) => row.mpsDetailId).filter(Boolean))];
  const plans = detailIds.length ? await tx.monthlyProductionPlan.findMany({
    where: { isDeleted: false, details: { some: { mpsDetailId: { in: detailIds }, isDeleted: false } } },
    select: { id: true, planNumber: true },
  }) : [];
  const runs = mpsNumbers.length ? await tx.mRPRun.findMany({
    where: { mpsNumber: { in: mpsNumbers }, isDeleted: false, isCurrentPlan: true },
    select: { runNumber: true },
  }) : [];
  const runNumbers = runs.map((row) => row.runNumber);
  const changedAt = new Date();
  const reason = options.reason || `Demand ${sourceNumbers.join(", ")} berubah; MPS, MRP, dan Purchase Suggestion wajib dihitung ulang.`;
  if (mpsNumbers.length) await tx.mPS.updateMany({ where: { mpsNumber: { in: mpsNumbers } }, data: { replanRequired: true, replanReason: reason, sourceChangedAt: changedAt } });
  if (plans.length) await tx.monthlyProductionPlan.updateMany({ where: { id: { in: plans.map((row) => row.id) } }, data: { replanRequired: true, replanReason: reason, sourceChangedAt: changedAt } });
  let suggestions = [];
  if (runNumbers.length) {
    suggestions = await tx.purchaseSuggestion.findMany({
      where: { runNumber: { in: runNumbers }, isDeleted: false, status: { notIn: ["Converted to PR", "Cancelled"] } },
      select: { suggestionNumber: true, notes: true },
    });
    for (const suggestion of suggestions) {
      await tx.purchaseSuggestion.update({
        where: { suggestionNumber: suggestion.suggestionNumber },
        data: { status: "Replan Required", notes: [suggestion.notes, reason].filter(Boolean).join(" | ") },
      });
    }
  }
  await tx.planningChangeImpact.create({ data: {
    changeType: options.changeType || "DEMAND_CHANGED",
    sourceType,
    sourceNumber: sourceNumbers[0],
    oldValue: options.oldValue || undefined,
    newValue: options.newValue || undefined,
    affectedMpsNumbers: mpsNumbers,
    affectedPlanNumbers: plans.map((row) => row.planNumber),
    status: mpsNumbers.length || plans.length || suggestions.length ? "PENDING_REPLAN" : "NO_DOWNSTREAM_PLAN",
    changedBy: options.user || null,
  } });
  return { mpsNumbers, planNumbers: plans.map((row) => row.planNumber), suggestionNumbers: suggestions.map((row) => row.suggestionNumber) };
}

async function replaceDeliveryTargets(tx, options) {
  const { sourceType, sourceNumber, customerCode, lines, inputRows, user, headerDeliveryDate, trackChange = false, previousTargets = null, impactSourceNumbers = [sourceNumber] } = options;
  const oldTargets = previousTargets || await tx.demandDeliveryTarget.findMany({ where: { sourceType, sourceNumber, isDeleted: false }, orderBy: [{ sourceLineId: "asc" }, { phaseNumber: "asc" }] });
  await tx.demandDeliveryTarget.deleteMany({ where: { sourceType, sourceNumber } });
  const data = [];
  lines.forEach((line, index) => {
    const input = inputRows[index] || {};
    const fallbackDate = sourceType === "FORECAST"
      ? monthEnd(input.forecastMonth || input.M1Forecast || line.M1Forecast)
      : validDate(input.deliveryDate || line.deliveryDate || headerDeliveryDate);
    for (const phase of phasesForRow(input, sourceType, fallbackDate)) {
      data.push({
        sourceType,
        sourceNumber,
        sourceLineId: line.id,
        forecastDetailId: sourceType === "FORECAST" ? line.id : null,
        soDetailId: sourceType === "SALES_ORDER" ? line.id : null,
        phaseNumber: phase.phaseNumber,
        customerCode: customerCode || null,
        partCode: line.partCode,
        targetDate: phase.targetDate,
        qty: phase.qty,
        uomCode: line.uomCode || "PCS",
        notes: phase.notes,
        consumesForecastTargetId: phase.consumesForecastTargetId,
        createdBy: user || null,
        updatedBy: user || null,
      });
    }
  });
  const selectedForecastIds = [...new Set(data.map((row) => row.consumesForecastTargetId).filter(Boolean))];
  if (selectedForecastIds.length) {
    const selectedForecasts = await tx.demandDeliveryTarget.findMany({
      where: {
        id: { in: selectedForecastIds },
        sourceType: "FORECAST",
        status: "ACTIVE",
        isDeleted: false,
      },
      include: { forecastDetail: { include: { forecast: true } } },
    });
    const byId = new Map(selectedForecasts.map((row) => [row.id, row]));
    for (const row of data.filter((item) => item.consumesForecastTargetId)) {
      const forecast = byId.get(row.consumesForecastTargetId);
      if (!forecast || forecast.forecastDetail?.isDeleted || !isOpenForecast(forecast.forecastDetail?.forecast)) {
        throw Object.assign(new Error("Forecast target yang dipilih sudah tidak aktif. Muat ulang pilihan Forecast."), { statusCode: 409, code: "FORECAST_TARGET_INACTIVE" });
      }
      if (String(forecast.partCode).toUpperCase() !== String(row.partCode).toUpperCase()
        || String(forecast.customerCode || "").toUpperCase() !== String(row.customerCode || "").toUpperCase()) {
        throw Object.assign(new Error("Forecast target harus mempunyai customer dan part yang sama dengan phase Sales Order."), { statusCode: 400, code: "FORECAST_TARGET_MISMATCH" });
      }
    }
  }
  if (data.length) await tx.demandDeliveryTarget.createMany({ data });
  const auditRows = (rows) => rows.map((row) => ({ partCode: row.partCode, phaseNumber: row.phaseNumber, targetDate: validDate(row.targetDate)?.toISOString().slice(0, 10) || null, qty: number(row.qty), customerCode: row.customerCode || null, consumesForecastTargetId: row.consumesForecastTargetId || null })).sort((a, b) => `${a.partCode}|${a.phaseNumber}`.localeCompare(`${b.partCode}|${b.phaseNumber}`));
  const oldAudit = auditRows(oldTargets);
  const newAudit = auditRows(data);
  if (trackChange && JSON.stringify(oldAudit) !== JSON.stringify(newAudit)) {
    await markDownstreamDemandChange(tx, { sourceType, sourceNumbers: impactSourceNumbers, reason: `Target delivery atau quantity ${sourceNumber} berubah; MPS, MRP, dan Purchase Suggestion wajib dihitung ulang.`, user, changeType: "DELIVERY_TARGET_CHANGED", oldValue: oldAudit, newValue: newAudit });
  }
}

async function retireDeliveryTargets(tx, options) {
  const {
    sourceType,
    sourceNumber,
    status = "SUPERSEDED",
    user = null,
    markDeleted = false,
  } = options;
  if (!sourceType || !sourceNumber) return { count: 0 };
  return tx.demandDeliveryTarget.updateMany({
    where: { sourceType, sourceNumber, isDeleted: false, status: "ACTIVE" },
    data: {
      status,
      isDeleted: markDeleted,
      updatedBy: user,
    },
  });
}

async function assertCompleteDeliveryTargets(tx, sourceType, sourceNumber, lines) {
  const targets = await tx.demandDeliveryTarget.findMany({
    where: { sourceType, sourceNumber, isDeleted: false, status: "ACTIVE" },
  });
  const byLine = new Map();
  for (const target of targets) byLine.set(target.sourceLineId, number(byLine.get(target.sourceLineId)) + number(target.qty));
  const invalid = lines.find((line) => {
    const expected = sourceType === "FORECAST" ? number(line.M1Qty) : number(line.qty);
    return Math.abs(number(byLine.get(line.id)) - expected) > EPSILON;
  });
  if (invalid) throw Object.assign(new Error(`Phase delivery ${invalid.partCode || invalid.lineNumber} belum lengkap atau total qty tidak sama.`), { statusCode: 400 });
  return targets;
}

module.exports = { replaceDeliveryTargets, retireDeliveryTargets, assertCompleteDeliveryTargets, markDownstreamDemandChange };
