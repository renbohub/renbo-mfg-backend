"use strict";

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

function planningPolicy(partOrPolicy) {
  const value = typeof partOrPolicy === "string"
    ? partOrPolicy
    : partOrPolicy?.planningPolicy;
  return String(value || "MTO").trim().toUpperCase() === "MTS" ? "MTS" : "MTO";
}

// MTS keeps the larger of forecast and actual SO. MTO uses forecast only as a
// provisional signal; once an SO exists the firm order replaces the forecast.
function effectiveDemandQty({ forecastQty, salesOrderQty, part, policy }) {
  const forecast = Math.max(number(forecastQty), 0);
  const salesOrder = Math.max(number(salesOrderQty), 0);
  const resolvedPolicy = planningPolicy(policy || part);
  if (resolvedPolicy === "MTO" && salesOrder > 0) return salesOrder;
  return Math.max(forecast, salesOrder);
}

function consumeDeliveryTargets({ forecastTargets = [], salesOrderTargets = [], part, policy }) {
  const resolvedPolicy = planningPolicy(policy || part);
  const forecast = forecastTargets
    .map((row) => ({ ...row, remaining: Math.max(number(row.qty), 0) }))
    .sort((left, right) => new Date(left.targetDate) - new Date(right.targetDate));
  const sales = salesOrderTargets
    .map((row) => ({ ...row, remaining: Math.max(number(row.qty), 0) }))
    .sort((left, right) => new Date(left.targetDate) - new Date(right.targetDate));

  if (resolvedPolicy === "MTO" && sales.some((row) => row.remaining > 0.000001)) {
    return sales
      .filter((row) => row.remaining > 0.000001)
      .map((row) => ({ ...row, qty: row.remaining, sourceType: "SALES_ORDER" }));
  }

  const result = [];
  let forecastIndex = 0;
  for (const sale of sales) {
    while (sale.remaining > 0.000001 && forecastIndex < forecast.length) {
      const target = forecast[forecastIndex];
      if (target.remaining <= 0.000001) { forecastIndex += 1; continue; }
      const qty = Math.min(sale.remaining, target.remaining);
      const targetDate = new Date(sale.targetDate) < new Date(target.targetDate)
        ? sale.targetDate
        : target.targetDate;
      result.push({ ...sale, qty, targetDate, sourceType: "SALES_ORDER", matchedForecastTargetId: target.id });
      sale.remaining -= qty;
      target.remaining -= qty;
    }
    if (sale.remaining > 0.000001) {
      result.push({ ...sale, qty: sale.remaining, sourceType: "SALES_ORDER" });
    }
  }
  for (const target of forecast) {
    if (target.remaining > 0.000001) {
      result.push({ ...target, qty: target.remaining, sourceType: "FORECAST" });
    }
  }
  return result.sort((left, right) => new Date(left.targetDate) - new Date(right.targetDate));
}

module.exports = { planningPolicy, effectiveDemandQty, consumeDeliveryTargets };
