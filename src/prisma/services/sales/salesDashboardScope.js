"use strict";

const BOOKED_STATUSES = ["Confirmed", "In Planning", "In Production", "In Progress", "Ready to Deliver", "Completed", "Delivered"];
function dashboardOptions(query = {}) {
  const customerCode = String(query.customerCode || "").trim();
  if (customerCode.length > 100 || /[\x00-\x1f]/.test(customerCode)) throw Object.assign(new Error("Filter customer tidak valid."), { statusCode: 400 });
  const period = String(query.period || "MONTH").toUpperCase();
  if (!["MONTH", "QUARTER", "YEAR"].includes(period)) throw Object.assign(new Error("Periode harus MONTH, QUARTER, atau YEAR."), { statusCode: 400 });
  return { customerCode, period };
}
function aggregateMonths(values, period) {
  const size = period === "YEAR" ? 12 : period === "QUARTER" ? 3 : 1;
  if (!Array.isArray(values) || values.length !== 12) throw new Error("Agregasi membutuhkan 12 bulan.");
  return Array.from({ length: 12 / size }, (_, index) => values.slice(index * size, (index + 1) * size).reduce((sum, value) => sum + Number(value || 0), 0));
}
function applyPeriod(payload, period) {
  if (period === "MONTH") return payload;
  const labels = period === "QUARTER" ? ["Q1", "Q2", "Q3", "Q4"] : [String(payload.year)];
  for (const series of Object.values(payload.comparison.modes)) for (const item of series) item.data = aggregateMonths(item.data, period);
  payload.comparison.labels = labels;
  payload.periodLabel = `${period === "QUARTER" ? "Kuartalan" : "Tahunan"} ${payload.year}`;
  const comparison = payload.detailTables[0];
  const monthly = comparison.rows;
  const plans = aggregateMonths(monthly.map(row => row.plan), period);
  const actuals = aggregateMonths(monthly.map(row => row.actual), period);
  comparison.title = `Forecast vs Actual ${period === "QUARTER" ? "per Kuartal" : "per Tahun"}`;
  comparison.columns[0].label = "Periode";
  comparison.rows = labels.map((label, i) => ({ period: label, plan: plans[i], actual: actuals[i], variance: actuals[i] - plans[i], attainment: plans[i] > 0 ? Math.round(actuals[i] / plans[i] * 1000) / 10 : null }));
  return payload;
}
module.exports = { BOOKED_STATUSES, dashboardOptions, aggregateMonths, applyPeriod };
