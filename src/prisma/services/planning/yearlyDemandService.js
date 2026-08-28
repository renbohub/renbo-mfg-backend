"use strict";

const { consumeDeliveryTargets, planningPolicy } = require("./demandConsumptionService");
const { loadEfdConfiguration, resolveEfd } = require("./effectiveDemandRuleService");
const { loadAdditionalDemandCoverage } = require("./additionalDemandCoverageService");
const { isOpenForecast } = require("./forecastStatusPolicy");

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

function mergeAdditionalCoverageIntoYearlyItems(items, coverageByPartMonth) {
  for (const row of items || []) {
    for (const [month, metric] of Object.entries(row.months || {})) {
      const coverage = coverageByPartMonth?.get(`${month}|${row.partCode}`);
      if (!coverage) {
        metric.lock = { locked: false };
        metric.additional = {
          qty: 0,
          coveredFgStockQty: 0,
          coveredFirmReceiptQty: 0,
          generatedDeltaQty: 0,
          pendingDeltaQty: 0,
          uncoveredQty: 0,
          reductionQty: 0,
          sourceSalesOrders: [],
        };
        metric.currentQty = metric.po;
        continue;
      }
      metric.lock = {
        locked: true,
        lockedEfd: coverage.lockedEfdQty,
        forecastQtyLocked: coverage.forecastQtyLocked,
        poQtyLocked: coverage.poQtyLocked,
        baselineMpsNumbers: coverage.baselineMpsNumbers,
        baselineMrpNumbers: coverage.baselineMrpNumbers,
        lockedAt: coverage.locks.map((lock) => lock?.lockedAt).filter(Boolean).sort()[0] || null,
        lockedBy: unique(coverage.locks.map((lock) => lock?.lockedBy)).join(", ") || null,
        customerCodes: coverage.customerCodes,
      };
      metric.additional = {
        qty: coverage.additionalQty,
        coveredFgStockQty: coverage.coveredFgStockQty,
        coveredFirmReceiptQty: coverage.coveredFirmReceiptQty,
        generatedDeltaQty: coverage.generatedDeltaQty,
        pendingDeltaQty: coverage.pendingDeltaQty,
        uncoveredQty: coverage.uncoveredQty,
        reductionQty: coverage.reductionQty,
        sourceSalesOrders: coverage.sourceSalesOrders,
      };
      metric.currentQty = coverage.currentSoQty;
    }
  }
  return items;
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
  const forecasts = rawForecasts.filter((row) => row.forecastDetail && !row.forecastDetail.isDeleted && isOpenForecast(row.forecastDetail.forecast));
  const sales = rawSales.filter((row) => row.soDetail && !row.soDetail.isDeleted && row.soDetail.status !== "Cancelled" && row.soDetail.soHeader && !row.soDetail.soHeader.isDeleted && !["Draft", "Cancelled", "Superseded"].includes(row.soDetail.soHeader.status));
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
  const efdConfiguration = await loadEfdConfiguration(prisma);
  for (const row of items) {
    for (const [month, metric] of Object.entries(row.months)) {
      const resolved = resolveEfd({ forecastQty: metric.fcc, poQty: metric.po, calculatedQty: metric.eff, partCode: row.partCode, month }, efdConfiguration);
      metric.effCalculated = metric.eff;
      metric.efd = resolved.value;
      metric.eff = resolved.value;
      metric.efdSource = resolved.source;
      metric.efdOverride = resolved.override;
      metric.efdRuleMode = resolved.ruleMode;
    }
    row.totals.effCalculated = roundQty(Object.values(row.months).reduce((sum, metric) => sum + number(metric.effCalculated), 0));
    row.totals.efd = roundQty(Object.values(row.months).reduce((sum, metric) => sum + number(metric.efd), 0));
    row.totals.eff = row.totals.efd;
  }
  const query = String(options.q || "").trim().toLowerCase();
  if (query) items = items.filter((row) => [row.partCode, row.partNumber, row.partName, ...row.customerCodes].some((value) => String(value || "").toLowerCase().includes(query)));
  items.sort((left, right) => String(left.partNumber || left.partCode).localeCompare(String(right.partNumber || right.partCode)));

  const additionalCoverage = await loadAdditionalDemandCoverage(prisma, {
    year,
    customerCode,
    partCodes: items.map((row) => row.partCode),
  });
  mergeAdditionalCoverageIntoYearlyItems(items, additionalCoverage.byPartMonth);

  const totals = { fcc: 0, po: 0, consumedFcc: 0, poEffective: 0, unplannedPo: 0, poPullIn: 0, poPullOut: 0, eff: 0 };
  for (const row of items) for (const key of Object.keys(totals)) totals[key] += number(row.totals[key]);
  for (const key of Object.keys(totals)) totals[key] = roundQty(totals[key]);
  const pageSize = options.unpaginated === true ? Math.max(items.length, 1) : Math.min(Math.max(Number.parseInt(options.pageSize, 10) || 25, 10), 200);
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
      lockedScopeCount: additionalCoverage.items.length,
      additionalQty: roundQty(additionalCoverage.items.reduce((sum, row) => sum + number(row.additionalQty), 0)),
      pendingDeltaQty: roundQty(additionalCoverage.items.reduce((sum, row) => sum + number(row.pendingDeltaQty), 0)),
    },
    pagination: { page, pageSize, total, totalPages },
    filters: { customerCode: customerCode || null, customerOptions },
    efdRule: efdConfiguration.rule,
    formula: {
      code: "EFD",
      expression: efdConfiguration.rule.label,
      monthlyExpression: "EFD ditentukan oleh general rule, lalu dapat dioverride per part dan bulan",
      rules: [
        "Rule umum berlaku untuk seluruh part dan bulan yang tidak memiliki override.",
        "Override per sel dapat memilih Actual PO, Forecast, atau nilai manual.",
        "Saat sumber Actual PO dipilih tetapi PO = 0, sistem otomatis memakai Forecast.",
        "Perubahan EFD menandai MPS bulan terkait dan MPS bulan sebelumnya untuk dihitung ulang.",
      ],
    },
  };
}

module.exports = { aggregateYearlyDemand, buildYearlyDemand, mergeAdditionalCoverageIntoYearlyItems, validYear };
