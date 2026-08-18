"use strict";

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

function planningPolicy(partOrPolicy) {
  const value = typeof partOrPolicy === "string"
    ? partOrPolicy
    : partOrPolicy?.planningPolicy;
  return String(value || "MTO").trim().toUpperCase() === "MTS" ? "MTS" : "MTO";
}

// Forecast consumption is quantity based for both policies. A partial SO may
// replace only the matched Forecast quantity; it must never erase the remaining
// provisional demand. Policy still remains available for reporting/governance.
function effectiveDemandQty({ forecastQty, salesOrderQty, part, policy }) {
  const forecast = Math.max(number(forecastQty), 0);
  const salesOrder = Math.max(number(salesOrderQty), 0);
  const resolvedPolicy = planningPolicy(policy || part);
  return Math.max(forecast, salesOrder);
}

function effectiveDemandWithBuffer({ forecastQty, salesOrderQty, bufferQty, part, policy }) {
  return effectiveDemandQty({ forecastQty, salesOrderQty, part, policy })
    + Math.max(number(bufferQty), 0);
}

function consumeDeliveryTargets({ forecastTargets = [], salesOrderTargets = [], part, policy }) {
  const resolvedPolicy = planningPolicy(policy || part);
  const forecast = forecastTargets
    .map((row) => ({ ...row, remaining: Math.max(number(row.qty), 0) }))
    .sort((left, right) => new Date(left.targetDate) - new Date(right.targetDate));
  const sales = salesOrderTargets
    .map((row) => ({ ...row, remaining: Math.max(number(row.qty), 0) }))
    .sort((left, right) => new Date(left.targetDate) - new Date(right.targetDate));
  const result = [];
  const forecastById = new Map(forecast.map((row) => [row.id, row]));
  const allocate = (sale, target) => {
    if (!target || target.remaining <= 0.000001 || sale.remaining <= 0.000001) return;
    const qty = Math.min(sale.remaining, target.remaining);
    const targetDate = new Date(sale.targetDate) < new Date(target.targetDate) ? sale.targetDate : target.targetDate;
    result.push({
      ...sale,
      qty,
      targetDate,
      sourceType: "SALES_ORDER",
      matchedForecastTargetId: target.id,
      forecastTargetDate: target.targetDate,
    });
    sale.remaining -= qty;
    target.remaining -= qty;
  };

  // Explicit phase pegging always wins over FIFO. It allows an August SO to
  // pull a specifically selected September Forecast phase into August while
  // leaving the Marketing commitment itself untouched.
  for (const sale of sales) {
    if (!sale.consumesForecastTargetId) continue;
    const selected = forecastById.get(sale.consumesForecastTargetId);
    if (selected) allocate(sale, selected);
    else if (sale.matchedForecastTargetId === sale.consumesForecastTargetId && sale.remaining > 0.000001) {
      result.push({ ...sale, qty: sale.remaining, sourceType: "SALES_ORDER", matchedForecastTargetId: sale.matchedForecastTargetId });
      sale.remaining = 0;
    }
  }

  let forecastIndex = 0;
  for (const sale of sales) {
    // If a Forecast phase was explicitly selected, any excess SO quantity is
    // unplanned demand; do not silently consume a different Forecast phase.
    if (sale.consumesForecastTargetId) {
      if (sale.remaining > 0.000001) result.push({ ...sale, qty: sale.remaining, sourceType: "SALES_ORDER", matchedForecastTargetId: null });
      continue;
    }
    while (sale.remaining > 0.000001 && forecastIndex < forecast.length) {
      const target = forecast[forecastIndex];
      if (target.remaining <= 0.000001) { forecastIndex += 1; continue; }
      allocate(sale, target);
    }
    if (sale.remaining > 0.000001) {
      result.push({ ...sale, qty: sale.remaining, sourceType: "SALES_ORDER" });
    }
  }
  for (const target of forecast) {
    if (target.remaining > 0.000001) {
      result.push({ ...target, qty: target.remaining, sourceType: "FORECAST", demandPolicy: resolvedPolicy });
    }
  }
  return result.sort((left, right) => new Date(left.targetDate) - new Date(right.targetDate));
}

module.exports = { planningPolicy, effectiveDemandQty, effectiveDemandWithBuffer, consumeDeliveryTargets };
