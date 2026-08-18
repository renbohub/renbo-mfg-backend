"use strict";

const { consumeDeliveryTargets, planningPolicy } = require("./demandConsumptionService");

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const roundQty = (value) => Math.round((number(value) + Number.EPSILON) * 1000000) / 1000000;
const monthKey = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 7);
};
const unique = (values) => [...new Set(values.filter(Boolean))];

function validYear(value) {
  const year = Number.parseInt(value, 10);
  const current = new Date().getUTCFullYear();
  return Number.isInteger(year) && year >= 2000 && year <= current + 10 ? year : current;
}

function emptyMetric(month) {
  return {
    month,
    fcc: 0,
    po: 0,
    consumedFcc: 0,
    poEffective: 0,
    unplannedPo: 0,
    poPullIn: 0,
    poPullOut: 0,
    eff: 0,
    lineage: { fccSources: [], poSources: [], effectiveSources: [], matchedPoCount: 0 },
  };
}

function sourceSummary(rows, field = "sourceNumber") {
  const values = unique(rows.map((row) => row[field])).sort();
  return { values: values.slice(0, 12), count: values.length, truncated: values.length > 12 };
}

function buildCustomerPartBucket({ customerCode, partCode, part, forecastTargets, salesOrderTargets, months }) {
  const forecastById = new Map(forecastTargets.map((row) => [row.id, row]));
  const effectiveRows = consumeDeliveryTargets({ forecastTargets, salesOrderTargets, part, policy: part?.planningPolicy });
  const metrics = new Map(months.map((month) => [month, emptyMetric(month)]));

  for (const row of forecastTargets) {
    const metric = metrics.get(monthKey(row.targetDate));
    if (!metric) continue;
    metric.fcc += number(row.qty);
    metric.lineage.fccSources.push(row.sourceNumber);
  }
  for (const row of salesOrderTargets) {
    const metric = metrics.get(monthKey(row.targetDate));
    if (!metric) continue;
    metric.po += number(row.qty);
    metric.lineage.poSources.push(row.sourceNumber);
  }
  for (const row of effectiveRows) {
    const effectiveMonth = monthKey(row.targetDate);
    const metric = metrics.get(effectiveMonth);
    if (!metric) continue;
    metric.eff += number(row.qty);
    metric.lineage.effectiveSources.push(row.sourceNumber);
    if (row.sourceType === "SALES_ORDER") {
      metric.poEffective += number(row.qty);
      if (!row.matchedForecastTargetId) metric.unplannedPo += number(row.qty);
      const originalMonth = monthKey(row.originalTargetDate);
      if (originalMonth && originalMonth !== effectiveMonth) {
        metric.poPullIn += number(row.qty);
        const originalMetric = metrics.get(originalMonth);
        if (originalMetric) originalMetric.poPullOut += number(row.qty);
      }
      if (row.matchedForecastTargetId) {
        metric.lineage.matchedPoCount += 1;
        const forecastMetric = metrics.get(monthKey(forecastById.get(row.matchedForecastTargetId)?.targetDate));
        if (forecastMetric) forecastMetric.consumedFcc += number(row.qty);
      }
    }
  }

  for (const metric of metrics.values()) {
    metric.fcc = roundQty(metric.fcc);
    metric.po = roundQty(metric.po);
    metric.consumedFcc = roundQty(Math.min(metric.consumedFcc, metric.fcc));
    metric.poEffective = roundQty(metric.poEffective);
    metric.unplannedPo = roundQty(metric.unplannedPo);
    metric.poPullIn = roundQty(metric.poPullIn);
    metric.poPullOut = roundQty(metric.poPullOut);
    metric.eff = roundQty(metric.eff);
    metric.lineage.fccSources = sourceSummary(metric.lineage.fccSources.map((sourceNumber) => ({ sourceNumber })));
    metric.lineage.poSources = sourceSummary(metric.lineage.poSources.map((sourceNumber) => ({ sourceNumber })));
    metric.lineage.effectiveSources = sourceSummary(metric.lineage.effectiveSources.map((sourceNumber) => ({ sourceNumber })));
  }

  return { customerCode: customerCode || null, partCode, planningPolicy: planningPolicy(part), metrics };
}

function aggregateYearlyDemand({ year, forecastTargets = [], salesOrderTargets = [], parts = [] }) {
  const months = Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, "0")}`);
  const partByCode = new Map(parts.map((part) => [part.partCode, part]));
  const grouped = new Map();
  const ensureGroup = (row) => {
    const key = `${row.customerCode || "-"}|${row.partCode}`;
    if (!grouped.has(key)) grouped.set(key, { customerCode: row.customerCode || null, partCode: row.partCode, forecasts: [], sales: [] });
    return grouped.get(key);
  };
  for (const row of forecastTargets) ensureGroup(row).forecasts.push({ ...row, originalTargetDate: row.targetDate });
  for (const row of salesOrderTargets) ensureGroup(row).sales.push({ ...row, originalTargetDate: row.targetDate });

  const byPart = new Map();
  for (const group of grouped.values()) {
    const part = partByCode.get(group.partCode) || { partCode: group.partCode };
    const bucket = buildCustomerPartBucket({ customerCode: group.customerCode, partCode: group.partCode, part, forecastTargets: group.forecasts, salesOrderTargets: group.sales, months });
    if (!byPart.has(group.partCode)) {
      byPart.set(group.partCode, {
        partCode: group.partCode,
        partNumber: part.partNumber || group.partCode,
        partName: part.partName || "-",
        uomCode: part.salesUomCode || part.baseUomCode || group.forecasts[0]?.uomCode || group.sales[0]?.uomCode || "pcs",
        planningPolicy: planningPolicy(part),
        customerCodes: [],
        months: Object.fromEntries(months.map((month) => [month, emptyMetric(month)])),
      });
    }
    const target = byPart.get(group.partCode);
    if (group.customerCode) target.customerCodes.push(group.customerCode);
    for (const [month, metric] of bucket.metrics) {
      const output = target.months[month];
      for (const field of ["fcc", "po", "consumedFcc", "poEffective", "unplannedPo", "poPullIn", "poPullOut", "eff"]) output[field] += number(metric[field]);
      output.lineage.matchedPoCount += number(metric.lineage.matchedPoCount);
      for (const sourceField of ["fccSources", "poSources", "effectiveSources"]) output.lineage[sourceField].push(...metric.lineage[sourceField].values);
    }
  }

  return [...byPart.values()].map((row) => {
    row.customerCodes = unique(row.customerCodes).sort();
    const totals = { fcc: 0, po: 0, consumedFcc: 0, poEffective: 0, unplannedPo: 0, poPullIn: 0, poPullOut: 0, eff: 0 };
    for (const metric of Object.values(row.months)) {
      for (const field of Object.keys(totals)) {
        metric[field] = roundQty(metric[field]);
        totals[field] += metric[field];
      }
      for (const sourceField of ["fccSources", "poSources", "effectiveSources"]) {
        const summary = sourceSummary(metric.lineage[sourceField].map((sourceNumber) => ({ sourceNumber })));
        metric.lineage[sourceField] = summary;
      }
    }
    row.totals = Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, roundQty(value)]));
    return row;
  });
}

async function buildYearlyDemand(prisma, options = {}) {
  const year = validYear(options.year);
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year + 1, 0, 1));
  const targetWhere = { isDeleted: false, status: "ACTIVE", targetDate: { gte: start, lt: end } };
  const [rawForecasts, rawSales] = await Promise.all([
    prisma.demandDeliveryTarget.findMany({
      where: { ...targetWhere, sourceType: "FORECAST" },
      include: { forecastDetail: { include: { forecast: true } } },
      orderBy: [{ targetDate: "asc" }, { sourceNumber: "asc" }, { phaseNumber: "asc" }],
    }),
    prisma.demandDeliveryTarget.findMany({
      where: { ...targetWhere, sourceType: "SALES_ORDER" },
      include: { soDetail: { include: { soHeader: true } } },
      orderBy: [{ targetDate: "asc" }, { sourceNumber: "asc" }, { phaseNumber: "asc" }],
    }),
  ]);
  const forecasts = rawForecasts.filter((row) => row.forecastDetail && !row.forecastDetail.isDeleted && row.forecastDetail.forecast && !row.forecastDetail.forecast.isDeleted && row.forecastDetail.forecast.isCurrentVersion && row.forecastDetail.forecast.status !== "Obsolete");
  const sales = rawSales.filter((row) => row.soDetail && !row.soDetail.isDeleted && row.soDetail.status !== "Cancelled" && row.soDetail.soHeader && !row.soDetail.soHeader.isDeleted && !["Draft", "Cancelled"].includes(row.soDetail.soHeader.status));
  const customerOptions = unique([...forecasts, ...sales].map((row) => row.customerCode)).sort();
  const customerCode = String(options.customerCode || "").trim();
  const filteredForecasts = customerCode ? forecasts.filter((row) => row.customerCode === customerCode) : forecasts;
  const filteredSales = customerCode ? sales.filter((row) => row.customerCode === customerCode) : sales;
  const partCodes = unique([...filteredForecasts, ...filteredSales].map((row) => row.partCode));
  const parts = partCodes.length ? await prisma.part.findMany({
    where: { partCode: { in: partCodes }, isDeleted: false },
    select: { partCode: true, partNumber: true, partName: true, planningPolicy: true, baseUomCode: true, salesUomCode: true },
  }) : [];
  let items = aggregateYearlyDemand({ year, forecastTargets: filteredForecasts, salesOrderTargets: filteredSales, parts });
  const query = String(options.q || "").trim().toLowerCase();
  if (query) items = items.filter((row) => [row.partCode, row.partNumber, row.partName, ...row.customerCodes].some((value) => String(value || "").toLowerCase().includes(query)));
  items.sort((left, right) => String(left.partNumber || left.partCode).localeCompare(String(right.partNumber || right.partCode)));

  const totals = { fcc: 0, po: 0, consumedFcc: 0, poEffective: 0, unplannedPo: 0, poPullIn: 0, poPullOut: 0, eff: 0 };
  for (const row of items) for (const key of Object.keys(totals)) totals[key] += number(row.totals[key]);
  for (const key of Object.keys(totals)) totals[key] = roundQty(totals[key]);
  const pageSize = Math.min(Math.max(Number.parseInt(options.pageSize, 10) || 25, 10), 200);
  const total = items.length;
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const page = Math.min(Math.max(Number.parseInt(options.page, 10) || 1, 1), totalPages);

  return {
    year,
    months: Array.from({ length: 12 }, (_, index) => ({ key: `${year}-${String(index + 1).padStart(2, "0")}`, index: index + 1 })),
    items: items.slice((page - 1) * pageSize, page * pageSize),
    totals,
    summary: {
      partCount: total,
      customerCount: unique(items.flatMap((row) => row.customerCodes)).length,
      forecastCoveragePercent: totals.eff > 0 ? roundQty((totals.consumedFcc / totals.eff) * 100) : 0,
    },
    pagination: { page, pageSize, total, totalPages },
    filters: { customerCode: customerCode || null, customerOptions },
    formula: {
      code: "EFF",
      expression: "FCC tersisa + PO firm pada tanggal efektif",
      monthlyExpression: "EFF = (FCC - FCC consumed) + (PO + pull-in - pull-out)",
      rules: [
        "Forecast Draft, Submitted, dan Confirmed yang masih current version tetap tampil sebagai FCC.",
        "Hanya Sales Order selain Draft/Cancelled yang dihitung sebagai PO firm.",
        "PO mengonsumsi FCC secara explicit pegging lebih dulu, lalu FIFO pada customer dan part yang sama.",
        "Tanggal EFF mengikuti tanggal paling awal antara target FCC dan target PO yang mengonsumsinya.",
      ],
    },
  };
}

module.exports = { aggregateYearlyDemand, buildYearlyDemand, validYear };
