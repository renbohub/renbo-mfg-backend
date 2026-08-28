"use strict";

const { assessDemandFeasibility } = require("./demandFeasibilityService");
const { buildCapacitySnapshot } = require("./capacityPlanningService");
const { isOpenForecast } = require("./forecastStatusPolicy");

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const asDate = (value) => { const date = value instanceof Date ? new Date(value) : new Date(value); return Number.isNaN(date.getTime()) ? null : date; };
const dayDiff = (left, right) => Math.ceil((asDate(left) - asDate(right)) / 86400000);

function planningAnchorMonth(value = new Date()) {
  const date = asDate(value) || new Date();
  // The anchor is the first month in the three-month MPS delivery window:
  // day 1-19 = previous/current/next, day 20-EOM = current/next/next+1.
  const offset = date.getUTCDate() >= 20 ? 0 : -1;
  const anchor = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
  return anchor.toISOString().slice(0, 7);
}

function mpsWindowMonths(value = new Date()) {
  const anchor = planningAnchorMonth(value);
  const start = asDate(`${anchor}-01`);
  return [0, 1, 2].map((offset) => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1)).toISOString().slice(0, 7));
}

function priorityClass(score) {
  if (score >= 90) return "P0";
  if (score >= 70) return "P1";
  if (score >= 40) return "P2";
  return "P3";
}

function calculatePriority(input = {}) {
  const today = asDate(input.today || new Date());
  const targetDeliveryDate = asDate(input.targetDeliveryDate);
  const remainingDays = targetDeliveryDate ? dayDiff(targetDeliveryDate, today) : 999;
  const factors = {
    overdue: remainingDays < 0 ? Math.min(35, 30 + Math.abs(remainingDays)) : 0,
    dueHorizon: remainingDays <= 3 ? 25 : remainingDays <= 7 ? 20 : remainingDays <= 15 ? 14 : remainingDays <= 30 ? 7 : 2,
    firmness: String(input.sourceType).toUpperCase() === "SALES_ORDER" ? 15 : String(input.sourceType).toUpperCase() === "BUFFER" ? 3 : 8,
    customerPriority: Math.min(Math.max(number(input.customerPriority), 0), 10),
    urgent: input.urgentFlag ? 10 : 0,
    deliveryRisk: ["NOT_FEASIBLE", "AT_RISK"].includes(input.feasibilityStatus) ? (input.feasibilityStatus === "NOT_FEASIBLE" ? 10 : 5) : 0,
    materialRisk: ["SHORTAGE", "EXPEDITE_REQUIRED"].includes(input.materialStatus) ? 7 : 0,
    capacityRisk: input.capacityStatus === "CAPACITY_LATE" ? 8 : 0,
  };
  const systemScore = Math.min(Object.values(factors).reduce((sum, value) => sum + value, 0), 100);
  const manualAdjustment = Math.min(Math.max(number(input.manualPriorityAdjustment), -30), 30);
  const score = Math.min(Math.max(systemScore + manualAdjustment, 0), 100);
  return { score, systemScore, manualAdjustment, priorityClass: priorityClass(score), factors, remainingDays, targetDeliveryDate };
}

function procurementWindow(todayValue, requiredValue) {
  const today = asDate(todayValue);
  const required = asDate(requiredValue);
  if (!today || !required) return "FUTURE";
  if (required < today) return "EXPEDITE";
  if (required.getUTCFullYear() === today.getUTCFullYear() && required.getUTCMonth() === today.getUTCMonth()) return "CURRENT_MONTH";
  const next = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
  if (required.getUTCFullYear() === next.getUTCFullYear() && required.getUTCMonth() === next.getUTCMonth()) return required.getUTCDate() <= 15 ? "NEXT_MONTH_01_15" : "NEXT_MONTH_16_EOM";
  return "FUTURE";
}

function demandGroupKey(row) {
  return `${String(row.customerCode || "-").trim().toUpperCase()}|${String(row.partCode || "-").trim().toUpperCase()}`;
}

function capacityHorizonMonths(targetDates = []) {
  const dates = targetDates.map(asDate).filter(Boolean).sort((left, right) => left - right);
  if (!dates.length) return [];
  const first = new Date(Date.UTC(dates[0].getUTCFullYear(), dates[0].getUTCMonth() - 1, 1));
  const lastDate = dates.at(-1);
  const last = new Date(Date.UTC(lastDate.getUTCFullYear(), lastDate.getUTCMonth(), 1));
  const months = [];
  for (let cursor = first; cursor <= last && months.length < 18; cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))) {
    months.push(cursor.toISOString().slice(0, 7));
  }
  return months;
}

function normalizeFgFinishSplits(input, options = {}) {
  const demandQty = Math.max(number(options.demandQty), 0);
  const fallbackDate = asDate(options.fallbackDate || options.deliveryDate);
  const deliveryDate = asDate(options.deliveryDate);
  const raw = Array.isArray(input) && input.length ? input : [{ targetFinishDate: fallbackDate, qty: demandQty }];
  const splits = raw.map((row, index) => {
    const targetFinishDate = asDate(row.targetFinishDate || row.fgRequiredDate || row.date);
    const qty = number(row.qty);
    if (!targetFinishDate || qty <= 0) throw Object.assign(new Error(`FG finish split ${index + 1} wajib memiliki tanggal valid dan qty lebih dari 0.`), { statusCode: 400 });
    if (deliveryDate && targetFinishDate > deliveryDate) throw Object.assign(new Error(`FG finish split ${index + 1} tidak boleh melewati target delivery customer.`), { statusCode: 400 });
    return { phaseNumber: index + 1, targetFinishDate, qty, notes: String(row.notes || "").trim() || null };
  }).sort((left, right) => left.targetFinishDate - right.targetFinishDate || left.phaseNumber - right.phaseNumber)
    .map((row, index) => ({ ...row, phaseNumber: index + 1 }));
  const total = splits.reduce((sum, row) => sum + row.qty, 0);
  if (Math.abs(total - demandQty) > 0.005) throw Object.assign(new Error(`Total qty target finish FG (${total}) harus sama dengan effective demand (${demandQty}).`), { statusCode: 400 });
  return splits;
}

// Forecast delivery phases are the presentation anchor. Firm SO quantities are
// allocated FIFO into the matching customer/part phases and shown as Actual SO,
// so the same demand is never rendered twice. Any excess SO remains visible as
// UNPLANNED_SO because hiding firm demand would be unsafe.
function mergeForecastWithActualSalesOrders({ forecastTargets = [], salesOrderTargets = [], planningPolicyByPart = new Map() } = {}) {
  const forecastRows = forecastTargets.map((target) => ({
    ...target,
    demandType: "FORECAST",
    forecastQty: Math.max(number(target.qty), 0),
    actualSalesOrderQty: 0,
    actualSalesOrders: [],
    _remainingForecast: Math.max(number(target.qty), 0),
  }));
  const forecastByGroup = new Map();
  for (const row of forecastRows) {
    const key = demandGroupKey(row);
    if (!forecastByGroup.has(key)) forecastByGroup.set(key, []);
    forecastByGroup.get(key).push(row);
  }
  for (const rows of forecastByGroup.values()) rows.sort((left, right) => asDate(left.targetDate) - asDate(right.targetDate) || number(left.phaseNumber) - number(right.phaseNumber));

  const unmatched = [];
  const forecastById = new Map(forecastRows.map((row) => [row.id, row]));
  const sales = salesOrderTargets.map((row) => ({ ...row, _remainingSales: Math.max(number(row.qty), 0), _remainingDelivered: Math.max(number(row.deliveredQty), 0) }))
    .sort((left, right) => asDate(left.targetDate) - asDate(right.targetDate) || String(left.sourceNumber).localeCompare(String(right.sourceNumber)));
  const allocate = (sale, forecast) => {
    if (!forecast || sale._remainingSales <= 0.000001 || forecast._remainingForecast <= 0.000001) return;
    const allocatedQty = Math.min(sale._remainingSales, forecast._remainingForecast);
    const deliveredQty = Math.min(sale._remainingDelivered, allocatedQty);
    const effectiveTargetDate = asDate(sale.targetDate) < asDate(forecast.targetDate) ? sale.targetDate : forecast.targetDate;
    forecast.actualSalesOrderQty += allocatedQty;
    forecast.actualSalesOrders.push({
      deliveryTargetId: sale.id,
      sourceNumber: sale.sourceNumber,
      sourceLineId: sale.sourceLineId,
      targetDate: sale.targetDate,
      effectiveTargetDate,
      matchedForecastTargetId: forecast.id,
      forecastTargetDate: forecast.targetDate,
      explicitForecastSelection: sale.consumesForecastTargetId === forecast.id,
      qty: allocatedQty,
      deliveredQty,
    });
    forecast._remainingForecast -= allocatedQty;
    sale._remainingSales -= allocatedQty;
    sale._remainingDelivered -= deliveredQty;
  };

  for (const sale of sales) {
    if (sale.consumesForecastTargetId) {
      const selected = forecastById.get(sale.consumesForecastTargetId);
      if (selected && demandGroupKey(selected) === demandGroupKey(sale)) allocate(sale, selected);
    }
  }
  for (const sale of sales) {
    const candidates = forecastByGroup.get(demandGroupKey(sale)) || [];
    if (!sale.consumesForecastTargetId) {
      for (const forecast of candidates) {
        if (sale._remainingSales <= 0.000001) break;
        allocate(sale, forecast);
      }
    }
    if (sale._remainingSales > 0.000001) {
      unmatched.push({
        ...sale,
        id: sale.id,
        demandType: "UNPLANNED_SO",
        forecastQty: 0,
        actualSalesOrderQty: sale._remainingSales,
        actualSalesOrders: [{ deliveryTargetId: sale.id, sourceNumber: sale.sourceNumber, sourceLineId: sale.sourceLineId, targetDate: sale.targetDate, effectiveTargetDate: sale.targetDate, matchedForecastTargetId: null, qty: sale._remainingSales, deliveredQty: Math.min(sale._remainingDelivered, sale._remainingSales) }],
        _remainingForecast: 0,
      });
    }
  }

  return [...forecastRows, ...unmatched]
    .map((row) => {
      const policy = String(planningPolicyByPart.get(row.partCode) || "MTS").toUpperCase();
      const effectiveDemandQty = policy === "MTO" && row.actualSalesOrderQty > 0
        ? row.actualSalesOrderQty
        : Math.max(row.forecastQty, row.actualSalesOrderQty);
      const deliveredQty = row.actualSalesOrders.reduce((sum, actual) => sum + number(actual.deliveredQty), 0);
      const actualSplits = row.actualSalesOrders.map((actual) => ({
        targetDate: asDate(actual.effectiveTargetDate || actual.targetDate),
        qty: number(actual.qty),
        sourceType: "SALES_ORDER",
        sourceNumber: actual.sourceNumber,
        deliveryTargetId: actual.deliveryTargetId,
        matchedForecastTargetId: actual.matchedForecastTargetId || null,
      }));
      const forecastRemainder = Math.max(effectiveDemandQty - row.actualSalesOrderQty, 0);
      const rawSplits = [...actualSplits, ...(forecastRemainder > 0 ? [{ targetDate: asDate(row.targetDate), qty: forecastRemainder, sourceType: "FORECAST", sourceNumber: row.sourceNumber, deliveryTargetId: row.id }] : [])]
        .filter((split) => split.targetDate && split.qty > 0);
      const splitByDateAndSource = new Map();
      for (const split of rawSplits) {
        const key = `${split.targetDate.toISOString().slice(0, 10)}|${split.sourceType}|${split.sourceNumber || "-"}|${split.deliveryTargetId || "-"}`;
        const current = splitByDateAndSource.get(key);
        if (current) current.qty += split.qty; else splitByDateAndSource.set(key, { ...split });
      }
      const effectiveDeliverySplits = [...splitByDateAndSource.values()].sort((left, right) => left.targetDate - right.targetDate);
      const effectiveTargetDate = effectiveDeliverySplits[0]?.targetDate || asDate(row.targetDate);
      const pullForwardDays = row.demandType === "FORECAST" && effectiveTargetDate
        ? Math.max(dayDiff(row.targetDate, effectiveTargetDate), 0)
        : 0;
      const { _remainingForecast, _remainingSales, _remainingDelivered, ...publicRow } = row;
      return { ...publicRow, planningPolicy: policy, forecastTargetDate: row.demandType === "FORECAST" ? row.targetDate : null, effectiveTargetDate, effectiveDeliverySplits, pullForwardDays, effectiveDemandQty, outstandingQty: Math.max(effectiveDemandQty - deliveredQty, 0), actualSalesOrderDeliveredQty: deliveredQty };
    })
    .sort((left, right) => asDate(left.targetDate) - asDate(right.targetDate) || String(left.sourceNumber).localeCompare(String(right.sourceNumber)));
}

// Draft SO is visible to PPIC as provisional demand, but it must not consume
// Forecast or change effective demand before the Sales confirmation control.
function attachDraftSalesOrders(rows = [], draftSalesOrderTargets = []) {
  const result = rows.map((row) => ({ ...row, draftSalesOrderQty: 0, draftSalesOrders: [] }));
  const forecastById = new Map(result.filter((row) => row.demandType === "FORECAST").map((row) => [row.id, row]));
  const forecastByGroup = new Map();
  for (const row of forecastById.values()) {
    const key = demandGroupKey(row);
    if (!forecastByGroup.has(key)) forecastByGroup.set(key, []);
    forecastByGroup.get(key).push(row);
  }
  for (const candidates of forecastByGroup.values()) candidates.sort((left, right) => asDate(left.targetDate) - asDate(right.targetDate) || number(left.phaseNumber) - number(right.phaseNumber));
  for (const sale of [...draftSalesOrderTargets].sort((left, right) => asDate(left.targetDate) - asDate(right.targetDate))) {
    let forecast = sale.consumesForecastTargetId ? forecastById.get(sale.consumesForecastTargetId) : null;
    if (forecast && demandGroupKey(forecast) !== demandGroupKey(sale)) forecast = null;
    if (!forecast) forecast = (forecastByGroup.get(demandGroupKey(sale)) || [])[0] || null;
    if (!forecast) continue;
    const qty = Math.max(number(sale.qty), 0);
    forecast.draftSalesOrderQty += qty;
    forecast.draftSalesOrders.push({
      deliveryTargetId: sale.id,
      sourceNumber: sale.sourceNumber,
      sourceLineId: sale.sourceLineId,
      targetDate: sale.targetDate,
      qty,
      status: sale.soStatus || "Draft",
      matchedForecastTargetId: forecast.id,
      explicitForecastSelection: sale.consumesForecastTargetId === forecast.id,
    });
  }
  return result;
}

async function buildCapacityOverview(prisma, demandRows = []) {
  const forecastRows = demandRows.filter((row) => row.demandType === "FORECAST");
  const months = capacityHorizonMonths(forecastRows.map((row) => row.targetDate));
  const demandByMonth = new Map();
  for (const row of demandRows) {
    const splits = Array.isArray(row.effectiveDeliverySplits) && row.effectiveDeliverySplits.length
      ? row.effectiveDeliverySplits
      : [{ targetDate: row.effectiveTargetDate || row.targetDate, qty: row.effectiveDemandQty, sourceType: row.actualSalesOrderQty > 0 ? "SALES_ORDER" : "FORECAST" }];
    for (const split of splits) {
      const month = asDate(split.targetDate)?.toISOString().slice(0, 7);
      if (!month) continue;
      const current = demandByMonth.get(month) || { forecastQty: 0, actualSalesOrderQty: 0, effectiveDemandQty: 0, deliveryPhaseCount: 0 };
      if (split.sourceType === "SALES_ORDER") current.actualSalesOrderQty += number(split.qty);
      else current.forecastQty += number(split.qty);
      current.effectiveDemandQty += number(split.qty);
      current.deliveryPhaseCount += 1;
      demandByMonth.set(month, current);
    }
  }
  return Promise.all(months.map(async (month) => {
    const startDate = `${month}-01`;
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const endDate = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const snapshot = await buildCapacitySnapshot(prisma, { startDate, endDate, planningMode: "PRODUCTION" });
    const summary = snapshot.summary || {};
    const demand = demandByMonth.get(month) || { forecastQty: 0, actualSalesOrderQty: 0, effectiveDemandQty: 0, deliveryPhaseCount: 0 };
    const utilizationPercent = number(summary.utilizationPercent);
    const overloaded = number(summary.overloadedCells) > 0 || utilizationPercent > 100 || number(summary.unscheduledCount) > 0;
    const status = demand.effectiveDemandQty <= 0 ? "NO_DEMAND" : overloaded ? "NOT_ENOUGH" : utilizationPercent >= 85 ? "TIGHT" : "ENOUGH";
    return { month, ...demand, status, utilizationPercent, totalAvailableMinutes: number(summary.totalAvailableMinutes), totalLoadMinutes: number(summary.totalLoadMinutes), remainingMinutes: Math.max(number(summary.totalAvailableMinutes) - number(summary.totalLoadMinutes), 0), overloadedCells: number(summary.overloadedCells), unscheduledCount: number(summary.unscheduledCount), activeMachineCount: number(summary.activeMachineCount), planLineCount: number(summary.planLineCount) };
  }));
}

function consolidateRequirements(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    const requiredDate = asDate(row.requiredDate);
    const key = `${row.supplierCode || "-"}|${row.partCode}|${requiredDate?.toISOString().slice(0, 10) || "-"}`;
    if (!grouped.has(key)) grouped.set(key, { supplierCode: row.supplierCode || null, partCode: row.partCode, requiredDate, qty: 0, openingQty: 0, pegging: [], moq: number(row.moq), orderMultiple: number(row.orderMultiple), _supply: new Map() });
    const target = grouped.get(key);
    const qty = number(row.qty ?? row.grossRequirement);
    target.qty += qty;
    // Opening stock and open supply are planning snapshots shared by all
    // customer pegging rows. Count each physical source once after demand is
    // consolidated, never once per customer.
    target.openingQty = Math.max(target.openingQty, number(row.onHandQty));
    for (const [index, supply] of (row.openSupply || []).entries()) {
      if (asDate(supply.arrivalDate) > requiredDate) continue;
      const supplyKey = supply.id || `${supply.sourceType || "SUPPLY"}|${supply.sourceNumber || index}|${asDate(supply.arrivalDate)?.toISOString() || "-"}`;
      if (!target._supply.has(supplyKey)) target._supply.set(supplyKey, number(supply.qty));
    }
    target.pegging.push({ customerCode: row.customerCode || null, sourceType: row.sourceType || null, sourceNumber: row.sourceNumber || null, deliveryTargetId: row.deliveryTargetId || null, fgPartCode: row.fgPartCode || null, targetDeliveryDate: asDate(row.targetDeliveryDate), qty });
  }
  return [...grouped.values()].map((row) => {
    const eligibleSupplyQty = [...row._supply.values()].reduce((sum, qty) => sum + number(qty), 0);
    const coveredQty = Math.min(row.qty, row.openingQty + eligibleSupplyQty);
    const shortageQty = Math.max(row.qty - coveredQty, 0);
    const afterMoq = Math.max(shortageQty, row.moq || 0);
    const suggestedOrderQty = row.orderMultiple > 0 ? Math.ceil(afterMoq / row.orderMultiple) * row.orderMultiple : afterMoq;
    const { _supply, ...publicRow } = row;
    return { ...publicRow, eligibleSupplyQty, coveredQty, shortageQty, suggestedOrderQty };
  });
}

async function buildDemandRows(prisma, filters = {}) {
  const where = {
    isDeleted: false, status: "ACTIVE", sourceType: "FORECAST",
    ...(filters.startDate || filters.endDate ? { targetDate: { ...(filters.startDate ? { gte: asDate(filters.startDate) } : {}), ...(filters.endDate ? { lte: asDate(filters.endDate) } : {}) } } : {}),
    ...(filters.customerCode ? { customerCode: filters.customerCode } : {}),
    ...(filters.partCode ? { partCode: filters.partCode } : {}),
  };
  const [forecastTargets, salesOrderTargets, decisions] = await Promise.all([
    prisma.demandDeliveryTarget.findMany({ where, include: { forecastDetail: { include: { forecast: true } } }, orderBy: [{ targetDate: "asc" }, { sourceNumber: "asc" }, { phaseNumber: "asc" }] }),
    prisma.demandDeliveryTarget.findMany({ where: { isDeleted: false, status: "ACTIVE", sourceType: "SALES_ORDER", soDetail: { isDeleted: false, status: { not: "Cancelled" }, soHeader: { isDeleted: false, status: { notIn: ["Cancelled", "Superseded"] } } }, ...(filters.startDate || filters.endDate ? { targetDate: { ...(filters.startDate ? { gte: asDate(filters.startDate) } : {}), ...(filters.endDate ? { lte: asDate(filters.endDate) } : {}) } } : {}), ...(filters.customerCode ? { customerCode: filters.customerCode } : {}), ...(filters.partCode ? { partCode: filters.partCode } : {}) }, include: { soDetail: { include: { soHeader: true } } }, orderBy: [{ targetDate: "asc" }, { sourceNumber: "asc" }, { phaseNumber: "asc" }] }),
    prisma.demandPlanningDecision.findMany({ where: { isDeleted: false, ...(filters.status ? { status: filters.status } : {}) } }),
  ]);
  const activeForecastTargets = forecastTargets.filter((row) => row.forecastDetail && !row.forecastDetail.isDeleted && isOpenForecast(row.forecastDetail.forecast));
  const validSalesTargets = salesOrderTargets.filter((row) => row.soDetail && !row.soDetail.isDeleted && row.soDetail.status !== "Cancelled" && row.soDetail.soHeader && !row.soDetail.soHeader.isDeleted && !["Cancelled", "Superseded"].includes(row.soDetail.soHeader.status));
  const activeSalesTargets = validSalesTargets.filter((row) => row.soDetail.soHeader.status !== "Draft").map((row) => ({ ...row, deliveredQty: number(row.soDetail.qtyDelivered), soStatus: row.soDetail.soHeader.status }));
  const draftSalesTargets = validSalesTargets.filter((row) => row.soDetail.soHeader.status === "Draft").map((row) => ({ ...row, deliveredQty: number(row.soDetail.qtyDelivered), soStatus: "Draft" }));
  const allTargets = [...activeForecastTargets, ...activeSalesTargets, ...draftSalesTargets];
  const [customers, parts] = await Promise.all([
    prisma.customer.findMany({ where: { customerCode: { in: [...new Set(allTargets.map((row) => row.customerCode).filter(Boolean))] }, isDeleted: false }, select: { customerCode: true, customerClassification: true } }),
    prisma.part.findMany({ where: { partCode: { in: [...new Set(allTargets.map((row) => row.partCode).filter(Boolean))] }, isDeleted: false }, select: { partCode: true, planningPolicy: true, bufferStock: true } }),
  ]);
  const customerPriorityByCode = new Map(customers.map((row) => { const classes = (row.customerClassification || []).map((value) => String(value).toUpperCase()); return [row.customerCode, classes.some((value) => ["STRATEGIC","VIP","PRIORITY","A"].includes(value)) ? 10 : classes.some((value) => ["KEY ACCOUNT","B"].includes(value)) ? 6 : 0]; }));
  const partByCode = new Map(parts.map((row) => [row.partCode, row]));
  const targets = attachDraftSalesOrders(mergeForecastWithActualSalesOrders({ forecastTargets: activeForecastTargets, salesOrderTargets: activeSalesTargets, planningPolicyByPart: new Map(parts.map((row) => [row.partCode, row.planningPolicy])) }), draftSalesTargets);
  const decisionByTarget = new Map(decisions.map((row) => [row.deliveryTargetId, row]));
  return targets.map((target) => {
    const decision = decisionByTarget.get(target.id);
    const prioritySourceType = target.actualSalesOrderQty > 0 ? "SALES_ORDER" : "FORECAST";
    const effectiveTargetDate = target.effectiveTargetDate || target.targetDate;
    const priority = calculatePriority({ sourceType: prioritySourceType, targetDeliveryDate: effectiveTargetDate, customerPriority: customerPriorityByCode.get(target.customerCode), urgentFlag: decision?.urgentFlag, manualPriorityAdjustment: decision?.manualPriorityAdjustment, feasibilityStatus: decision?.feasibilityStatus, materialStatus: decision?.materialStatus, capacityStatus: decision?.capacityStatus });
    const masterBufferPercent = Math.max(number(partByCode.get(target.partCode)?.bufferStock), 0);
    const bufferPercent = decision ? Math.max(number(decision.bufferPercent), 0) : masterBufferPercent;
    const bufferQty = decision ? Math.max(number(decision.bufferQty), 0) : number(target.effectiveDemandQty) * bufferPercent / 100;
    const defaultFinishSplits = (target.effectiveDeliverySplits || []).map((split) => ({ targetFinishDate: split.targetDate, qty: split.qty }));
    const savedSplits = Array.isArray(decision?.fgFinishSplits) ? decision.fgFinishSplits : [];
    const savedSplitsStillProtectDueDate = savedSplits.every((split) => asDate(split.targetFinishDate || split.fgRequiredDate) <= asDate(effectiveTargetDate));
    const fgFinishSplits = normalizeFgFinishSplits(savedSplitsStillProtectDueDate && savedSplits.length ? savedSplits : defaultFinishSplits, { demandQty: target.effectiveDemandQty, fallbackDate: savedSplitsStillProtectDueDate ? (decision?.fgRequiredDate || effectiveTargetDate) : effectiveTargetDate, deliveryDate: effectiveTargetDate });
    const planningStatus = decision && !savedSplitsStillProtectDueDate ? "REPLAN_REQUIRED" : (decision?.status || "UNREVIEWED");
    const constraintDetails = decision?.constraintDetails && typeof decision.constraintDetails === "object" ? decision.constraintDetails : {};
    return { ...target, sourceType: target.demandType === "UNPLANNED_SO" ? "SALES_ORDER" : "FORECAST", targetDeliveryDate: target.targetDate, effectiveTargetDate, demandQty: target.effectiveDemandQty, systemPriorityScore: decision?.systemPriorityScore ?? priority.systemScore, priorityScoreBreakdown: decision?.priorityScoreBreakdown || priority.factors, manualPriorityAdjustment: decision?.manualPriorityAdjustment || 0, finalPriorityScore: decision?.finalPriorityScore ?? priority.score, priorityClass: decision?.priorityClass || priority.priorityClass, urgentFlag: Boolean(decision?.urgentFlag), fgRequiredDate: fgFinishSplits[0]?.targetFinishDate || (savedSplitsStillProtectDueDate ? decision?.fgRequiredDate : null) || effectiveTargetDate, fgFinishSplits, bufferPercent, bufferQty, masterBufferPercent, bufferSource: decision ? "PPIC_OVERRIDE" : "PART_MASTER", feasibilityStatus: decision?.feasibilityStatus || "NOT_SIMULATED", earliestFeasibleDeliveryDate: decision?.earliestFeasibleDeliveryDate || null, criticalConstraint: decision?.criticalConstraint || null, feasibilityOptions: { leadTimeControls: constraintDetails.leadTimeControls || { productionProcess: true, supplierLeadTime: true, receivingQc: true, safety: true }, supplierStrategy: constraintDetails.supplierStrategy || "PREFERRED", supplierSelections: constraintDetails.supplierSelections || {}, vendorProcessAdjustments: constraintDetails.vendorProcessAdjustments || [] }, supplierAlternatives: constraintDetails.supplierAlternatives || [], requiresRiskApproval: Boolean(constraintDetails.requiresRiskApproval), waivedRisks: constraintDetails.waivedRisks || [], planningStatus, decisionId: decision?.id || null };
  });
}

async function reviewDemand(prisma, deliveryTargetId, input, actor) {
  const target = await prisma.demandDeliveryTarget.findFirst({ where: { id: deliveryTargetId, isDeleted: false, status: "ACTIVE" } });
  if (!target) throw Object.assign(new Error("Delivery target tidak ditemukan."), { statusCode: 404 });
  if (number(input.manualPriorityAdjustment) !== 0 && !String(input.manualAdjustmentReason || "").trim()) throw Object.assign(new Error("Alasan manual priority adjustment wajib diisi."), { statusCode: 400 });
  const demandRow = (await buildDemandRows(prisma, { customerCode: target.customerCode, partCode: target.partCode })).find((row) => row.id === target.id);
  const effectiveQty = Math.max(number(demandRow?.demandQty ?? target.qty), 0);
  const effectiveTargetDate = demandRow?.effectiveTargetDate || target.targetDate;
  const feasibility = input.runFeasibility === false ? null : await assessDemandFeasibility(prisma, { sourceType: demandRow?.actualSalesOrderQty > 0 ? "SALES_ORDER" : target.sourceType, sourceNumber: target.sourceNumber, deliveryTargetId: target.id, customerCode: target.customerCode, partCode: target.partCode, quantity: effectiveQty, requestedDeliveryDate: effectiveTargetDate, planNumber: input.planNumber, leadTimeControls: input.leadTimeControls, supplierStrategy: input.supplierStrategy, supplierSelections: input.supplierSelections, vendorProcessAdjustments: input.vendorProcessAdjustments });
  const customer = target.customerCode ? await prisma.customer.findFirst({ where: { customerCode: target.customerCode, isDeleted: false }, select: { customerClassification: true } }) : null;
  const customerClasses = (customer?.customerClassification || []).map((value) => String(value).toUpperCase());
  const masterCustomerPriority = customerClasses.some((value) => ["STRATEGIC","VIP","PRIORITY","A"].includes(value)) ? 10 : customerClasses.some((value) => ["KEY ACCOUNT","B"].includes(value)) ? 6 : 0;
  const priority = calculatePriority({ sourceType: demandRow?.actualSalesOrderQty > 0 ? "SALES_ORDER" : target.sourceType, targetDeliveryDate: effectiveTargetDate, customerPriority: input.customerPriority ?? masterCustomerPriority, urgentFlag: input.urgentFlag, manualPriorityAdjustment: input.manualPriorityAdjustment, feasibilityStatus: feasibility?.status, materialStatus: feasibility?.materialStatus, capacityStatus: feasibility?.capacityStatus });
  const part = await prisma.part.findFirst({ where: { partCode: target.partCode, isDeleted: false }, select: { bufferStock: true } });
  const bufferPercent = input.bufferPercent == null ? Math.max(number(part?.bufferStock), 0) : Math.max(number(input.bufferPercent), 0);
  const bufferQty = input.bufferQty == null ? effectiveQty * bufferPercent / 100 : Math.max(number(input.bufferQty), 0);
  const fallbackFgRequiredDate = asDate(input.fgRequiredDate) || feasibility?.fgRequiredDate || effectiveTargetDate;
  const fgFinishSplits = normalizeFgFinishSplits(input.fgFinishSplits, { demandQty: effectiveQty, fallbackDate: fallbackFgRequiredDate, deliveryDate: effectiveTargetDate });
  const data = {
    sourceType: target.sourceType, sourceNumber: target.sourceNumber, sourceLineId: target.sourceLineId, deliveryTargetId: target.id, customerCode: target.customerCode, partCode: target.partCode, targetDeliveryDate: target.targetDate, demandQty: effectiveQty,
    systemPriorityScore: priority.systemScore, manualPriorityAdjustment: priority.manualAdjustment, manualAdjustmentReason: String(input.manualAdjustmentReason || "").trim() || null, finalPriorityScore: priority.score, priorityClass: priority.priorityClass, priorityScoreBreakdown: priority.factors, urgentFlag: Boolean(input.urgentFlag),
    fgRequiredDate: fgFinishSplits[0]?.targetFinishDate || fallbackFgRequiredDate, fgFinishSplits: fgFinishSplits.map((row) => ({ ...row, targetFinishDate: row.targetFinishDate.toISOString() })), bufferPercent, bufferQty, displacementPolicy: input.displacementPolicy || "SIMULATE_FIRST", displacementReason: input.displacementReason || null,
    feasibilityStatus: feasibility?.status || input.feasibilityStatus || "NOT_SIMULATED", earliestFeasibleDeliveryDate: feasibility?.earliestFeasibleDeliveryDate || null, criticalConstraint: feasibility?.criticalConstraint || null, constraintDetails: { ...(feasibility?.constraintDetails || {}), forecastTargetDate: target.targetDate, effectiveTargetDate, pullForwardDays: demandRow?.pullForwardDays || 0 }, materialStatus: feasibility?.materialStatus || null, capacityStatus: feasibility?.capacityStatus || null,
    reviewedBy: actor || null, reviewedAt: new Date(), status: input.status || "REVIEWED", sourceChangedAt: target.updatedAt,
  };
  return prisma.demandPlanningDecision.upsert({ where: { deliveryTargetId: target.id }, create: data, update: { ...data, isDeleted: false } });
}

module.exports = { planningAnchorMonth, mpsWindowMonths, priorityClass, calculatePriority, procurementWindow, consolidateRequirements, capacityHorizonMonths, normalizeFgFinishSplits, mergeForecastWithActualSalesOrders, attachDraftSalesOrders, buildCapacityOverview, buildDemandRows, reviewDemand };
