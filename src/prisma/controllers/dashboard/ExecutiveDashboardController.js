const { prisma } = require("../../index");
const { calculateLiveMbomCosts } = require("../../services/mbomLiveCostingService");
const { isDiscreteUom, normalizeQuantity } = require("../../utils/uomQuantity");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
};
const yearRange = (year) => ({
  gte: new Date(year, 0, 1),
  lt: new Date(year + 1, 0, 1),
});
const monthBucket = () => Array(12).fill(0);
const addMonth = (bucket, date, value) => {
  const parsed = date ? new Date(date) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return;
  bucket[parsed.getMonth()] += number(value);
};
const sum = (values) => values.reduce((total, value) => total + number(value), 0);
const percent = (actual, plan) => (number(plan) > 0 ? round((number(actual) / number(plan)) * 100, 1) : 0);
const signed = (value) => `${number(value) >= 0 ? "+" : ""}${round(value, 1)}%`;
const kpi = (label, value, format, note, trend = null, tone = "neutral") => ({ label, value: round(value), format, note, trend, tone });
const METRIC_LABELS = {
  QTY: "Qty",
  VALUE: "Rupiah",
  PLAN_QTY: "Plan vs Actual Qty",
  PLAN_VALUE: "Plan vs Actual Rupiah",
  MATERIAL_KG: "Material KG",
  QUALITY: "Good vs Reject",
  CUMULATIVE: "Kumulatif",
  VARIANCE: "Variance",
  PRICE: "Price (Rp)",
  PCS: "Production PCS",
  KG: "Material KG",
};
const cumulative = (values) => {
  let running = 0;
  return values.map((value) => { running += number(value); return round(running); });
};
const monthlyRows = (plan, actual, labels = MONTHS) => labels.map((period, index) => {
  const planValue = number(plan[index]);
  const actualValue = number(actual[index]);
  return {
    period,
    plan: round(planValue),
    actual: round(actualValue),
    variance: round(actualValue - planValue),
    attainment: percent(actualValue, planValue),
  };
});
const table = (title, columns, rows, note = null) => ({ title, columns, rows, note });
const exception = (severity, code, title, detail, value = null, link = null) => ({ severity, code, title, detail, value, link });
const forecastAccuracy = (plan, actual) => {
  const comparable = plan.map((value, index) => ({ plan: number(value), actual: number(actual[index]) })).filter((row) => row.plan > 0);
  if (!comparable.length) return { accuracy: 0, mape: 0, bias: 0 };
  const mape = sum(comparable.map((row) => Math.abs(row.actual - row.plan) / row.plan)) / comparable.length * 100;
  const planTotal = sum(comparable.map((row) => row.plan));
  const bias = planTotal ? (sum(comparable.map((row) => row.actual - row.plan)) / planTotal) * 100 : 0;
  return { accuracy: round(Math.max(0, 100 - mape), 1), mape: round(mape, 1), bias: round(bias, 1) };
};
const SALES_ACTUAL_BASIS = {
  BOOKED: "Customer PO / SO",
  DELIVERED: "Delivered / POD",
  INVOICED: "Sales Invoice",
  RECOGNIZED: "Revenue Recognized",
};
const normalizeActualBasis = (value) => SALES_ACTUAL_BASIS[String(value || "").toUpperCase()] ? String(value).toUpperCase() : "BOOKED";
const comparisonPayload = ({ module, title, subtitle, year, modes, defaultMetric = "QTY", labelsByMetric = null, kpis, kpisByMetric = null, insights, insightsByMetric = null, context = [], detailTables = [], exceptions = [], definitions = [] }) => ({
  module,
  title,
  subtitle,
  year,
  periodLabel: `Januari–Desember ${year}`,
  generatedAt: new Date(),
  defaultMetric,
  metricOptions: Object.keys(modes).map((value) => ({ value, label: METRIC_LABELS[value] || value })),
  comparison: { labels: MONTHS, ...(labelsByMetric ? { labelsByMetric } : {}), modes },
  kpis,
  ...(kpisByMetric ? { kpisByMetric } : {}),
  insights,
  ...(insightsByMetric ? { insightsByMetric } : {}),
  context,
  detailTables,
  exceptions,
  definitions,
});

async function salesDashboard(year, module = "sales", options = {}) {
  const years = [year, year - 1, year - 2];
  const actualBasis = normalizeActualBasis(options.actualBasis);
  const qtyByYear = new Map(years.map((value) => [value, monthBucket()]));
  const valueByYear = new Map(years.map((value) => [value, monthBucket()]));
  const orderCount = new Map(years.map((value) => [value, 0]));
  let pipelineCount = 0;
  if (actualBasis === "BOOKED") {
    const orders = await prisma.salesOrderHeader.findMany({
      where: { isDeleted: false, status: { not: "Cancelled" }, soDate: { gte: new Date(year - 2, 0, 1), lt: new Date(year + 1, 0, 1) } },
      select: {
        soNumber: true, soDate: true, status: true, totalAmount: true, currencyCode: true,
        currency: { select: { exchangeRate: true } },
        details: { where: { isDeleted: false, status: { not: "Cancelled" } }, select: { qty: true, totalAmount: true, unitPrice: true } },
      },
    });
    orders.forEach((order) => {
      const orderYear = new Date(order.soDate).getFullYear();
      if (!qtyByYear.has(orderYear)) return;
      const rate = order.currencyCode === "IDR" ? 1 : number(order.currency?.exchangeRate) || 1;
      const quantity = sum(order.details.map((detail) => detail.qty));
      const detailValue = sum(order.details.map((detail) => detail.totalAmount || number(detail.qty) * number(detail.unitPrice)));
      addMonth(qtyByYear.get(orderYear), order.soDate, quantity);
      addMonth(valueByYear.get(orderYear), order.soDate, (number(order.totalAmount) || detailValue) * rate);
      orderCount.set(orderYear, orderCount.get(orderYear) + 1);
    });
    pipelineCount = orders.filter((order) => ["Draft", "Confirmed", "In Progress", "Ready to Deliver"].includes(order.status)).length;
  } else if (actualBasis === "DELIVERED") {
    const schedules = await prisma.deliverySchedule.findMany({
      where: {
        isDeleted: false,
        status: "Delivered",
        OR: [
          { actualDate: { gte: new Date(year - 2, 0, 1), lt: new Date(year + 1, 0, 1) } },
          { deliveredAt: { gte: new Date(year - 2, 0, 1), lt: new Date(year + 1, 0, 1) } },
        ],
      },
      select: {
        scheduleNumber: true, actualDate: true, deliveredAt: true,
        soHeader: { select: { currencyCode: true, currency: { select: { exchangeRate: true } } } },
        details: { where: { isDeleted: false }, select: { qtyDelivered: true, soDetail: { select: { unitPrice: true } } } },
      },
    });
    schedules.forEach((schedule) => {
      const actualDate = schedule.actualDate || schedule.deliveredAt;
      const actualYear = new Date(actualDate).getFullYear();
      if (!qtyByYear.has(actualYear)) return;
      const rate = schedule.soHeader?.currencyCode === "IDR" ? 1 : number(schedule.soHeader?.currency?.exchangeRate) || 1;
      const quantity = sum(schedule.details.map((detail) => detail.qtyDelivered));
      const value = sum(schedule.details.map((detail) => number(detail.qtyDelivered) * number(detail.soDetail?.unitPrice))) * rate;
      addMonth(qtyByYear.get(actualYear), actualDate, quantity);
      addMonth(valueByYear.get(actualYear), actualDate, value);
      orderCount.set(actualYear, orderCount.get(actualYear) + 1);
    });
  } else {
    const ledger = await prisma.salesActualLedger.findMany({
      where: {
        actualBasis,
        actualDate: { gte: new Date(year - 2, 0, 1), lt: new Date(year + 1, 0, 1) },
        status: "POSTED",
        isDeleted: false,
      },
      select: { actualDate: true, qty: true, amountIdr: true, sourceNumber: true },
    });
    ledger.forEach((row) => {
      const actualYear = new Date(row.actualDate).getFullYear();
      if (!qtyByYear.has(actualYear)) return;
      addMonth(qtyByYear.get(actualYear), row.actualDate, row.qty);
      addMonth(valueByYear.get(actualYear), row.actualDate, row.amountIdr);
      orderCount.set(actualYear, orderCount.get(actualYear) + 1);
    });
  }
  if (["BOOKED", "DELIVERED"].includes(actualBasis)) {
    const imported = await prisma.salesActualLedger.findMany({
      where: {
        actualBasis,
        sourceType: "EXCEL_IMPORT",
        actualDate: { gte: new Date(year - 2, 0, 1), lt: new Date(year + 1, 0, 1) },
        status: "POSTED",
        isDeleted: false,
      },
      select: { actualDate: true, qty: true, amountIdr: true },
    });
    imported.forEach((row) => {
      const actualYear = new Date(row.actualDate).getFullYear();
      if (!qtyByYear.has(actualYear)) return;
      addMonth(qtyByYear.get(actualYear), row.actualDate, row.qty);
      addMonth(valueByYear.get(actualYear), row.actualDate, row.amountIdr);
      orderCount.set(actualYear, orderCount.get(actualYear) + 1);
    });
  }
  const forecastQty = monthBucket();
  const forecastValue = monthBucket();
  const forecasts = await prisma.forecast.findMany({
    where: { isDeleted: false, isCurrentVersion: true, status: { not: "Obsolete" } },
    select: {
      forecastNumber: true,
      details: {
        where: { isDeleted: false },
        select: { unitPrice: true, M1Forecast: true, M1Qty: true, M2Forecast: true, M2Qty: true, M3Forecast: true, M3Qty: true },
      },
    },
  });
  forecasts.forEach((forecast) => forecast.details.forEach((detail) => {
    [[detail.M1Forecast, detail.M1Qty], [detail.M2Forecast, detail.M2Qty], [detail.M3Forecast, detail.M3Qty]].forEach(([period, qty]) => {
      if (!period || new Date(period).getFullYear() !== year) return;
      addMonth(forecastQty, period, qty);
      addMonth(forecastValue, period, number(qty) * number(detail.unitPrice));
    });
  }));
  const currentQty = sum(qtyByYear.get(year));
  const currentValue = sum(valueByYear.get(year));
  const previousValue = sum(valueByYear.get(year - 1));
  const yoy = previousValue > 0 ? ((currentValue - previousValue) / previousValue) * 100 : 0;
  const bestMonthIndex = valueByYear.get(year).reduce((best, value, index, rows) => value > rows[best] ? index : best, 0);
  const currentOrders = orderCount.get(year);
  const qtyAccuracy = forecastAccuracy(forecastQty, qtyByYear.get(year));
  const valueAccuracy = forecastAccuracy(forecastValue, valueByYear.get(year));
  const salesExceptions = monthlyRows(forecastQty, qtyByYear.get(year))
    .filter((row) => row.plan > 0 && row.attainment < 90)
    .map((row) => exception("WARNING", "SALES_BELOW_FORECAST", `${row.period}: actual di bawah forecast`, `Attainment ${row.attainment}%`, Math.abs(row.variance), "/modules/sales"));
  const payload = comparisonPayload({
    module,
    title: module === "system" ? "Ringkasan Penjualan" : "Penjualan",
    subtitle: "Perbandingan penjualan bulanan tahun berjalan, tahun lalu, dan dua tahun lalu.",
    year,
    defaultMetric: "VALUE",
    modes: {
      QTY: years.map((value) => ({ name: String(value), data: qtyByYear.get(value) })),
      VALUE: years.map((value) => ({ name: String(value), data: valueByYear.get(value) })),
      PLAN_QTY: [{ name: "Forecast Plan", data: forecastQty }, { name: SALES_ACTUAL_BASIS[actualBasis], data: qtyByYear.get(year) }],
      PLAN_VALUE: [{ name: "Forecast Value", data: forecastValue }, { name: SALES_ACTUAL_BASIS[actualBasis], data: valueByYear.get(year) }],
    },
    kpis: [
      kpi("Revenue YTD", currentValue, "currency", `${currentOrders} sumber ${SALES_ACTUAL_BASIS[actualBasis]}`, signed(yoy), yoy >= 0 ? "positive" : "negative"),
      kpi("Volume YTD", currentQty, "number", `Total qty ${SALES_ACTUAL_BASIS[actualBasis]}`),
      kpi("Forecast Accuracy", qtyAccuracy.accuracy, "percent", `MAPE ${qtyAccuracy.mape}%`, signed(qtyAccuracy.bias), qtyAccuracy.accuracy >= 85 ? "positive" : "warning"),
      kpi("Revenue vs Forecast", currentValue - sum(forecastValue), "currency", `${percent(currentValue, sum(forecastValue))}% attainment`, null, currentValue >= sum(forecastValue) ? "positive" : "warning"),
    ],
    insights: [
      { label: "YoY Revenue", value: signed(yoy), tone: yoy >= 0 ? "positive" : "negative", note: `dibanding ${year - 1}` },
      { label: "Peak Month", value: MONTHS[bestMonthIndex], tone: "accent", note: "revenue tertinggi tahun berjalan" },
      { label: "Order Pipeline", value: String(pipelineCount), tone: "warning", note: actualBasis === "BOOKED" ? "SO belum terminal dalam tiga tahun data" : "Hanya relevan untuk basis Customer PO / SO" },
    ],
    context: [
      { label: "Current Year", value: year },
      { label: "Previous Year", value: year - 1 },
      { label: "Baseline", value: year - 2 },
    ],
    detailTables: [table("Forecast vs Actual per Bulan", [
      { key: "period", label: "Bulan" },
      { key: "plan", label: "Forecast Qty", format: "number" },
      { key: "actual", label: "Actual Qty", format: "number" },
      { key: "variance", label: "Variance", format: "number" },
      { key: "attainment", label: "Attainment", format: "percent" },
    ], monthlyRows(forecastQty, qtyByYear.get(year)), `Basis actual: ${SALES_ACTUAL_BASIS[actualBasis]}`)],
    exceptions: salesExceptions,
    definitions: [
      { label: "Forecast Accuracy", value: `${qtyAccuracy.accuracy}%`, note: "100% dikurangi MAPE bulanan" },
      { label: "Qty Bias", value: signed(qtyAccuracy.bias), note: "positif berarti actual di atas forecast" },
      { label: "Value Accuracy", value: `${valueAccuracy.accuracy}%`, note: "berdasarkan unit price Forecast" },
      { label: "Peak Revenue", value: MONTHS[bestMonthIndex], note: "bulan actual tertinggi" },
    ],
  });
  payload.actualBasis = actualBasis;
  payload.actualBasisLabel = SALES_ACTUAL_BASIS[actualBasis];
  payload.actualBasisOptions = Object.entries(SALES_ACTUAL_BASIS).map(([value, label]) => ({ value, label }));
  return payload;
}

async function productionDashboard(year) {
  const schedules = await prisma.dailyProductionSchedule.findMany({
    where: { isDeleted: false, status: { not: "Cancelled" }, scheduleDate: yearRange(year) },
    select: { scheduleDate: true, plannedQty: true, actualQty: true, status: true },
  });
  const logs = await prisma.productionLog.findMany({
    where: { isDeleted: false, status: { not: "Cancelled" }, logDate: yearRange(year) },
    select: { logNumber: true, logDate: true, qtyProduced: true, qtyGood: true, qtyReject: true, downtime: true, processCode: true, machineCode: true },
  });
  const plan = monthBucket(); const actual = monthBucket();
  schedules.forEach((row) => { addMonth(plan, row.scheduleDate, row.plannedQty); addMonth(actual, row.scheduleDate, row.actualQty); });
  const goodByMonth = monthBucket(); const rejectByMonth = monthBucket();
  logs.forEach((row) => { addMonth(goodByMonth, row.logDate, row.qtyGood); addMonth(rejectByMonth, row.logDate, row.qtyReject); });
  const planned = sum(plan); const realized = sum(actual);
  const produced = sum(logs.map((row) => row.qtyProduced));
  const good = sum(logs.map((row) => row.qtyGood));
  const reject = sum(logs.map((row) => row.qtyReject));
  const productionExceptions = monthlyRows(plan, actual)
    .filter((row) => row.plan > 0 && row.attainment < 95)
    .map((row) => exception("WARNING", "PRODUCTION_BEHIND_PLAN", `${row.period}: produksi tertinggal`, `Attainment ${row.attainment}%`, Math.abs(row.variance), "/modules/production"));
  logs.filter((row) => number(row.qtyProduced) > 0 && percent(row.qtyReject, row.qtyProduced) > 3)
    .slice(0, 20)
    .forEach((row) => productionExceptions.push(exception("CRITICAL", "HIGH_REJECT_RATE", row.logNumber, `${row.processCode || "Process"} / ${row.machineCode || "Machine"}: reject ${percent(row.qtyReject, row.qtyProduced)}%`, row.qtyReject, "/modules/production/production-logs")));
  return comparisonPayload({
    module: "production", title: "Production Execution", subtitle: "Perbandingan Daily Production Plan terhadap realisasi output per bulan.", year,
    modes: {
      QTY: [{ name: "Plan", data: plan }, { name: "Actual", data: actual }],
      QUALITY: [{ name: "Good Output", data: goodByMonth }, { name: "Reject", data: rejectByMonth }],
    },
    kpis: [
      kpi("Production Plan", planned, "number", "Total planned quantity"),
      kpi("Actual Output", realized, "number", `${percent(realized, planned)}% plan attainment`, `${signed(percent(realized, planned) - 100)}`, realized >= planned ? "positive" : "warning"),
      kpi("Good Rate", good, "number", `${percent(good, produced)}% dari production log`),
      kpi("NG / Reject", reject, "number", `${round(sum(logs.map((row) => row.downtime)), 1)} menit downtime`),
    ],
    insights: [
      { label: "Plan Attainment", value: `${percent(realized, planned)}%`, tone: realized >= planned ? "positive" : "warning", note: "actual dibanding plan" },
      { label: "Schedule Closed", value: String(schedules.filter((row) => row.status === "Completed").length), tone: "accent", note: "daily schedule completed" },
      { label: "Output Gap", value: round(realized - planned), tone: realized >= planned ? "positive" : "negative", note: "actual dikurangi plan" },
    ],
    detailTables: [table("Production Plan vs Actual", [
      { key: "period", label: "Bulan" }, { key: "plan", label: "Plan", format: "number" },
      { key: "actual", label: "Actual", format: "number" }, { key: "variance", label: "Gap", format: "number" },
      { key: "attainment", label: "Attainment", format: "percent" },
    ], monthlyRows(plan, actual))],
    exceptions: productionExceptions,
    definitions: [
      { label: "Yield", value: `${percent(good, produced)}%`, note: "good qty / produced qty" },
      { label: "Reject Rate", value: `${percent(reject, produced)}%`, note: "reject qty / produced qty" },
      { label: "Downtime", value: `${round(sum(logs.map((row) => row.downtime)), 1)} min`, note: "akumulasi production log" },
    ],
  });
}

async function planningDashboard(year) {
  const [plans, schedules] = await Promise.all([
    prisma.monthlyProductionPlan.findMany({
      where: { isDeleted: false, status: { not: "Cancelled" }, planMonth: yearRange(year) },
      select: { planMonth: true, details: { where: { isDeleted: false, status: { not: "Cancelled" } }, select: { partCode: true, qtyPlanned: true, uomCode: true } } },
    }),
    prisma.dailyProductionSchedule.findMany({
      where: { isDeleted: false, status: { not: "Cancelled" }, scheduleDate: yearRange(year) },
      select: { scheduleDate: true, partCode: true, actualQty: true, uomCode: true },
    }),
  ]);
  const partCodes = [...new Set([
    ...plans.flatMap((row) => row.details.map((detail) => detail.partCode)),
    ...schedules.map((row) => row.partCode),
  ].filter(Boolean))];
  const parts = partCodes.length ? await prisma.part.findMany({
    where: { partCode: { in: partCodes }, isDeleted: false },
    select: { partCode: true, baseUomCode: true, productionUomCode: true },
  }) : [];
  const partUomByCode = new Map(parts.map((part) => [part.partCode, part.productionUomCode || part.baseUomCode]));
  const rowUom = (row) => String(row.uomCode || partUomByCode.get(row.partCode) || "PCS").trim().toUpperCase();
  const isKg = (uomCode) => ["KG", "KGS", "KILOGRAM", "KILOGRAMS"].includes(uomCode);
  const planPcs = monthBucket(); const actualPcs = monthBucket();
  const planKg = monthBucket(); const actualKg = monthBucket();
  plans.forEach((row) => row.details.forEach((detail) => {
    const uomCode = rowUom(detail);
    if (isKg(uomCode)) addMonth(planKg, row.planMonth, normalizeQuantity(detail.qtyPlanned, uomCode));
    else if (isDiscreteUom(uomCode)) addMonth(planPcs, row.planMonth, normalizeQuantity(detail.qtyPlanned, uomCode));
  }));
  schedules.forEach((row) => {
    const uomCode = rowUom(row);
    if (isKg(uomCode)) addMonth(actualKg, row.scheduleDate, normalizeQuantity(row.actualQty, uomCode));
    else if (isDiscreteUom(uomCode)) addMonth(actualPcs, row.scheduleDate, normalizeQuantity(row.actualQty, uomCode));
  });
  const plannedPcs = sum(planPcs); const realizedPcs = sum(actualPcs);
  const plannedKg = sum(planKg); const realizedKg = sum(actualKg);
  const pcsRows = monthlyRows(planPcs, actualPcs);
  const kgRows = monthlyRows(planKg, actualKg);
  const planningExceptions = [
    ...pcsRows.filter((row) => row.plan > 0 && row.attainment < 95)
      .map((row) => exception("WARNING", "MPP_PCS_BEHIND_PLAN", `${row.period}: produksi PCS belum tercapai`, `Outstanding ${Math.max(row.plan - row.actual, 0)} PCS`, Math.max(row.plan - row.actual, 0), "/modules/planning-ppic/monthly-production-plans")),
    ...kgRows.filter((row) => row.plan > 0 && row.attainment < 95)
      .map((row) => exception("WARNING", "MPP_KG_BEHIND_PLAN", `${row.period}: material KG belum tercapai`, `Outstanding ${round(Math.max(row.plan - row.actual, 0))} KG`, Math.max(row.plan - row.actual, 0), "/modules/planning-ppic/monthly-production-plans")),
  ];
  const pcsKpis = [
    kpi("Plan PCS", plannedPcs, "number", `${plans.length} Monthly Production Plan`),
    kpi("Actual PCS", realizedPcs, "number", `${percent(realizedPcs, plannedPcs)}% realization`),
    kpi("Outstanding PCS", Math.max(plannedPcs - realizedPcs, 0), "number", "Unit produksi belum direalisasikan"),
    kpi("Variance PCS", realizedPcs - plannedPcs, "number", "Actual dikurangi plan", plannedPcs ? signed(percent(realizedPcs, plannedPcs) - 100) : null, plannedPcs ? (realizedPcs >= plannedPcs ? "positive" : "warning") : "neutral"),
  ];
  const kgKpis = [
    kpi("Plan KG", plannedKg, "number", "Material berbasis berat"),
    kpi("Actual KG", realizedKg, "number", `${percent(realizedKg, plannedKg)}% realization`),
    kpi("Outstanding KG", Math.max(plannedKg - realizedKg, 0), "number", "Material KG belum direalisasikan"),
    kpi("Variance KG", realizedKg - plannedKg, "number", "Actual dikurangi plan", plannedKg ? signed(percent(realizedKg, plannedKg) - 100) : null, plannedKg ? (realizedKg >= plannedKg ? "positive" : "warning") : "neutral"),
  ];
  return comparisonPayload({
    module: "planning-ppic", title: "PPIC Plan Control", subtitle: "Monthly Production Plan dibanding realisasi per UOM; PCS dan KG tidak dijumlahkan.", year,
    defaultMetric: "PCS",
    modes: {
      PCS: [{ name: "MPP Plan PCS", data: planPcs }, { name: "Production Actual PCS", data: actualPcs }],
      KG: [{ name: "MPP Plan KG", data: planKg }, { name: "Material Actual KG", data: actualKg }],
    },
    kpis: pcsKpis,
    kpisByMetric: { PCS: pcsKpis, KG: kgKpis },
    insights: [
      { label: "MPP Realization PCS", value: `${percent(realizedPcs, plannedPcs)}%`, tone: realizedPcs >= plannedPcs ? "positive" : "warning", note: "annual execution" },
      { label: "Active Plans", value: String(plans.length), tone: "accent", note: "plan dalam tahun berjalan" },
      { label: "Outstanding PCS", value: String(Math.max(plannedPcs - realizedPcs, 0)), tone: "warning", note: "unit belum direalisasikan" },
    ],
    insightsByMetric: {
      PCS: [
        { label: "MPP Realization PCS", value: `${percent(realizedPcs, plannedPcs)}%`, tone: realizedPcs >= plannedPcs ? "positive" : "warning", note: "annual execution" },
        { label: "Active Plans", value: String(plans.length), tone: "accent", note: "plan dalam tahun berjalan" },
        { label: "Outstanding PCS", value: String(Math.max(plannedPcs - realizedPcs, 0)), tone: "warning", note: "unit belum direalisasikan" },
      ],
      KG: [
        { label: "MPP Realization KG", value: `${percent(realizedKg, plannedKg)}%`, tone: realizedKg >= plannedKg ? "positive" : "warning", note: "annual execution" },
        { label: "Active Plans", value: String(plans.length), tone: "accent", note: "plan dalam tahun berjalan" },
        { label: "Outstanding KG", value: String(round(Math.max(plannedKg - realizedKg, 0))), tone: "warning", note: "berat belum direalisasikan" },
      ],
    },
    detailTables: [table("MPP vs Production Actual - PCS", [
      { key: "period", label: "Bulan" }, { key: "plan", label: "MPP Plan", format: "number" },
      { key: "actual", label: "Production Actual", format: "number" }, { key: "variance", label: "Variance", format: "number" },
      { key: "attainment", label: "Realization", format: "percent" },
    ], pcsRows, "PCS dibulatkan per baris sebelum agregasi."), table("MPP vs Material Actual - KG", [
      { key: "period", label: "Bulan" }, { key: "plan", label: "MPP Plan", format: "number" },
      { key: "actual", label: "Material Actual", format: "number" }, { key: "variance", label: "Variance", format: "number" },
      { key: "attainment", label: "Realization", format: "percent" },
    ], kgRows, "KG tetap mendukung angka desimal.")],
    exceptions: planningExceptions,
  });
}

async function purchasingDashboard(year, module = "purchasing") {
  const [orders, receipts, materialDemand] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where: { isDeleted: false, status: { not: "Cancelled" }, deliveryDate: yearRange(year) },
      select: {
        poNumber: true, deliveryDate: true, status: true, supplierCode: true, supplierName: true, currencyCode: true,
        currency: { select: { exchangeRate: true } },
        details: { where: { isDeleted: false }, select: { qty: true, qtyReceived: true, uomCode: true, conversionUomCode: true, conversionFactor: true, convertedPurchaseQty: true, unitPrice: true, totalAmount: true } },
      },
    }),
    prisma.goodsReceipt.findMany({
      where: { isDeleted: false, status: { not: "Cancelled" }, grDate: yearRange(year) },
      select: {
        grNumber: true, grDate: true, poNumber: true,
        details: { where: { isDeleted: false }, select: { qtyReceived: true, uomCode: true, totalPrice: true, poDetail: { select: { conversionUomCode: true, conversionFactor: true } } } },
      },
    }),
    prisma.materialDemandSnapshot.findMany({
      where: { isDeleted: false, status: "POSTED", periodMonth: yearRange(year) },
      select: { periodMonth: true, demandQtyKg: true },
    }),
  ]);
  const planQty = monthBucket(); const actualQty = monthBucket(); const planValue = monthBucket(); const actualValue = monthBucket();
  const demandKg = monthBucket(); const orderedKg = monthBucket(); const incomingKg = monthBucket();
  const purchaseKg = (detail, qtyField = "qty") => {
    const qty = number(detail?.[qtyField]);
    if (String(detail?.uomCode || "").toUpperCase() === "KG") return qty;
    if (String(detail?.conversionUomCode || "").toUpperCase() === "KG") {
      if (qtyField === "qty" && number(detail?.convertedPurchaseQty) > 0) return number(detail.convertedPurchaseQty);
      return qty * (number(detail?.conversionFactor) || 1);
    }
    return 0;
  };
  orders.forEach((row) => {
    const rate = row.currencyCode === "IDR" ? 1 : number(row.currency?.exchangeRate) || 1;
    addMonth(planQty, row.deliveryDate, sum(row.details.map((detail) => detail.qty)));
    addMonth(planValue, row.deliveryDate, sum(row.details.map((detail) => detail.totalAmount || number(detail.qty) * number(detail.unitPrice))) * rate);
    addMonth(orderedKg, row.deliveryDate, sum(row.details.map((detail) => purchaseKg(detail))));
  });
  receipts.forEach((row) => {
    addMonth(actualQty, row.grDate, sum(row.details.map((detail) => detail.qtyReceived)));
    addMonth(actualValue, row.grDate, sum(row.details.map((detail) => detail.totalPrice)));
    addMonth(incomingKg, row.grDate, sum(row.details.map((detail) => purchaseKg({ ...detail, conversionUomCode: detail.poDetail?.conversionUomCode, conversionFactor: detail.poDetail?.conversionFactor }, "qtyReceived"))));
  });
  materialDemand.forEach((row) => addMonth(demandKg, row.periodMonth, row.demandQtyKg));
  const planned = sum(planQty); const received = sum(actualQty);
  const supplierRows = [...orders.reduce((map, order) => {
    const key = order.supplierCode || order.supplierName || "UNASSIGNED";
    const current = map.get(key) || { supplier: key, plannedQty: 0, receivedQty: 0, gap: 0, overduePo: 0, poCount: 0 };
    const orderPlanned = sum(order.details.map((detail) => detail.qty));
    const orderReceived = sum(order.details.map((detail) => detail.qtyReceived));
    current.plannedQty += orderPlanned;
    current.receivedQty += orderReceived;
    current.poCount += 1;
    if (new Date(order.deliveryDate) < new Date() && !["Completed", "Cancelled"].includes(order.status) && orderReceived < orderPlanned) current.overduePo += 1;
    current.gap = current.receivedQty - current.plannedQty;
    map.set(key, current);
    return map;
  }, new Map()).values()].sort((a, b) => b.overduePo - a.overduePo || a.supplier.localeCompare(b.supplier));
  const purchasingExceptions = supplierRows.filter((row) => row.overduePo > 0)
    .map((row) => exception("CRITICAL", "PO_OVERDUE", `${row.supplier}: PO overdue`, `${row.overduePo} PO melewati delivery date`, Math.abs(row.gap), "/modules/purchasing/purchase-orders"));
  monthlyRows(demandKg, incomingKg).filter((row) => row.plan > 0 && row.attainment < 100)
    .forEach((row) => purchasingExceptions.push(exception("WARNING", "MATERIAL_INCOMING_SHORT", `${row.period}: incoming di bawah demand`, `Coverage ${row.attainment}%`, Math.max(row.plan - row.actual, 0), "/modules/purchasing/goods-receipts")));
  return comparisonPayload({
    module, title: module === "incoming" ? "Inbound Fulfilment" : "Purchasing Delivery Control",
    subtitle: "Rencana penerimaan berdasarkan PO delivery date dibanding Goods Receipt aktual.", year,
    defaultMetric: module === "purchasing" ? "VALUE" : "QTY",
    modes: {
      QTY: [{ name: "PO Plan", data: planQty }, { name: "GR Actual", data: actualQty }],
      VALUE: [{ name: "PO Value", data: planValue }, { name: "Received Value", data: actualValue }],
      MATERIAL_KG: [{ name: "Material Demand", data: demandKg }, { name: "PO Ordered", data: orderedKg }, { name: "Material Incoming", data: incomingKg }],
    },
    kpis: [
      kpi("PO Planned Qty", planned, "number", `${orders.length} Purchase Order`),
      kpi("Received Qty", received, "number", `${percent(received, planned)}% receipt coverage`),
      kpi("Planned Spend", sum(planValue), "currency", "PO sesuai delivery month"),
      kpi("Received Value", sum(actualValue), "currency", "Nilai Goods Receipt aktual"),
    ],
    insights: [
      { label: "Receipt Coverage", value: `${percent(received, planned)}%`, tone: received >= planned ? "positive" : "warning", note: "qty received vs PO plan" },
      { label: "Open Receipt Gap", value: round(Math.max(planned - received, 0)), tone: "warning", note: "qty belum diterima" },
      { label: "Goods Receipts", value: String(receipts.length), tone: "accent", note: "dokumen tahun berjalan" },
    ],
    detailTables: [
      table("Material Demand, PO, dan Incoming", [
        { key: "period", label: "Bulan" }, { key: "demandKg", label: "Demand KG", format: "number" },
        { key: "orderedKg", label: "PO KG", format: "number" }, { key: "incomingKg", label: "Incoming KG", format: "number" },
        { key: "gapKg", label: "Incoming - Demand", format: "number" }, { key: "coverage", label: "Coverage", format: "percent" },
      ], MONTHS.map((period, index) => ({ period, demandKg: round(demandKg[index]), orderedKg: round(orderedKg[index]), incomingKg: round(incomingKg[index]), gapKg: round(incomingKg[index] - demandKg[index]), coverage: percent(incomingKg[index], demandKg[index]) }))),
      table("Supplier Receipt Control", [
        { key: "supplier", label: "Supplier" }, { key: "poCount", label: "PO", format: "number" },
        { key: "plannedQty", label: "Ordered", format: "number" }, { key: "receivedQty", label: "Received", format: "number" },
        { key: "gap", label: "Gap", format: "number" }, { key: "overduePo", label: "Overdue", format: "number" },
      ], supplierRows),
    ],
    exceptions: purchasingExceptions,
    definitions: [
      { label: "Material Coverage", value: `${percent(sum(incomingKg), sum(demandKg))}%`, note: "incoming KG / historical demand KG" },
      { label: "PO Coverage", value: `${percent(sum(orderedKg), sum(demandKg))}%`, note: "ordered KG / demand KG" },
      { label: "Overdue PO", value: String(sum(supplierRows.map((row) => row.overduePo))), note: "melewati delivery date dan belum penuh diterima" },
    ],
  });
}

async function outgoingDashboard(year) {
  const schedules = await prisma.deliverySchedule.findMany({
    where: {
      isDeleted: false,
      status: { notIn: ["Cancelled", "Failed"] },
      OR: [{ plannedDate: yearRange(year) }, { actualDate: yearRange(year) }],
    },
    select: {
      plannedDate: true, actualDate: true, deliveredAt: true, status: true,
      details: { where: { isDeleted: false }, select: { qty: true, qtyDelivered: true } },
    },
  });
  const plan = monthBucket(); const actual = monthBucket();
  schedules.forEach((row) => {
    addMonth(plan, row.plannedDate, sum(row.details.map((detail) => detail.qty)));
    if (row.actualDate || row.deliveredAt) addMonth(actual, row.actualDate || row.deliveredAt, sum(row.details.map((detail) => detail.qtyDelivered)));
  });
  const planned = sum(plan); const delivered = sum(actual);
  const outgoingExceptions = schedules.filter((row) => row.status !== "Delivered" && new Date(row.plannedDate) < new Date())
    .map((row) => exception("CRITICAL", "DELIVERY_OVERDUE", `Delivery melewati rencana ${new Date(row.plannedDate).toISOString().slice(0, 10)}`, `Status ${row.status}`, sum(row.details.map((detail) => Math.max(number(detail.qty) - number(detail.qtyDelivered), 0))), "/modules/outgoing/delivery-schedules"));
  return comparisonPayload({
    module: "outgoing", title: "Delivery Performance", subtitle: "Delivery schedule plan dibanding Proof of Delivery aktual per bulan.", year,
    modes: {
      QTY: [{ name: "Delivery Plan", data: plan }, { name: "Delivered Actual", data: actual }],
      CUMULATIVE: [{ name: "Accumulated Plan", data: cumulative(plan) }, { name: "Accumulated Actual", data: cumulative(actual) }],
    },
    kpis: [
      kpi("Planned Delivery", planned, "number", `${schedules.length} delivery schedule`),
      kpi("Delivered", delivered, "number", `${percent(delivered, planned)}% fulfilment`),
      kpi("Outstanding", Math.max(planned - delivered, 0), "number", "Belum memiliki POD aktual"),
      kpi("Completed Schedules", schedules.filter((row) => row.status === "Delivered").length, "number", "Status Delivered"),
    ],
    insights: [
      { label: "Delivery Fulfilment", value: `${percent(delivered, planned)}%`, tone: delivered >= planned ? "positive" : "warning", note: "actual vs schedule" },
      { label: "Open Schedule", value: String(schedules.filter((row) => row.status !== "Delivered").length), tone: "warning", note: "belum delivered" },
      { label: "Delivery Gap", value: round(Math.max(planned - delivered, 0)), tone: "negative", note: "qty outstanding" },
    ],
    detailTables: [table("Delivery Plan, Actual, dan Outstanding", [
      { key: "period", label: "Bulan" }, { key: "plan", label: "Plan", format: "number" },
      { key: "actual", label: "Delivered", format: "number" }, { key: "outstanding", label: "Outstanding", format: "number" },
      { key: "accumulatedPlan", label: "Accumulated Plan", format: "number" }, { key: "accumulatedActual", label: "Accumulated Actual", format: "number" },
    ], MONTHS.map((period, index) => ({ period, plan: round(plan[index]), actual: round(actual[index]), outstanding: round(Math.max(plan[index] - actual[index], 0)), accumulatedPlan: cumulative(plan)[index], accumulatedActual: cumulative(actual)[index] })))],
    exceptions: outgoingExceptions,
    definitions: [{ label: "Schedule Overdue", value: String(outgoingExceptions.length), note: "planned date lewat dan belum Delivered" }],
  });
}

async function inventoryDashboard(year, options = {}) {
  const [balances, opnames] = await Promise.all([
    prisma.stockBalance.findMany({
      where: { isDeleted: false },
      select: { stockType: true, uomCode: true, partCode: true, partNumber: true, materialId: true, productId: true, qtyOnHand: true, qtyAvailable: true, qtyReserved: true, qtyQC: true, minStock: true },
    }),
    prisma.stockOpnameHeader.findMany({
      where: { isDeleted: false, stoDate: yearRange(year), status: { not: "DRAFT" } },
      select: { stoNo: true, stoType: true, stoDate: true, status: true, details: { where: { isDeleted: false, actualQty: { not: null } }, select: { stockType: true, systemQty: true, actualQty: true, varianceQty: true, varianceStatus: true } } },
    }),
  ]);
  const stockTypeOf = (row) => row.stockType || "Unclassified";
  const uomOf = (row) => String(row.uomCode || "Tanpa UOM").trim().toUpperCase();
  const types = [...new Set(balances.map(stockTypeOf))].sort();
  const quantityKey = (row) => `${stockTypeOf(row)} / ${uomOf(row)}`;
  const quantityGroups = [...new Set(balances.map(quantityKey))].sort();
  const qtyLabels = quantityGroups.length ? quantityGroups : ["Belum ada saldo"];
  const target = quantityGroups.length
    ? quantityGroups.map((key) => sum(balances.filter((row) => quantityKey(row) === key).map((row) => row.minStock)))
    : [0];
  const actual = quantityGroups.length
    ? quantityGroups.map((key) => sum(balances.filter((row) => quantityKey(row) === key).map((row) => row.qtyOnHand)))
    : [0];
  const onHand = sum(actual); const minimum = sum(target);
  const available = sum(balances.map((row) => row.qtyAvailable));
  const reserved = sum(balances.map((row) => row.qtyReserved));
  const lowStock = balances.filter((row) => number(row.minStock) > 0 && number(row.qtyAvailable) < number(row.minStock)).length;
  let valuationRows = balances.map((row) => ({ ...row, unitPrice: 0, onHandValue: 0, availableValue: 0, reservedQcValue: 0, priceSource: "Belum ada harga" }));
  if (options.includeValuation !== false && balances.length) {
    const costingDate = year === new Date().getFullYear() ? new Date() : new Date(year, 11, 31);
    const monthFields = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const partCodes = [...new Set(balances.map((row) => row.partCode).filter(Boolean))];
    const partNumbers = [...new Set(balances.map((row) => row.partNumber).filter(Boolean))];
    const materialIds = [...new Set(balances.map((row) => row.materialId).filter(Boolean))];
    const productIds = [...new Set(balances.map((row) => row.productId).filter(Boolean))];
    const [parts, currencies, bomHeaders, liveBomCosts] = await Promise.all([
      partCodes.length || partNumbers.length ? prisma.part.findMany({ where: { isDeleted: false, OR: [...(partCodes.length ? [{ partCode: { in: partCodes } }] : []), ...(partNumbers.length ? [{ partNumber: { in: partNumbers } }] : [])] }, select: { id: true, partCode: true, partNumber: true } }) : [],
      prisma.currency.findMany({ where: { isDeleted: false }, select: { currencyCode: true, exchangeRate: true } }),
      prisma.mBOMHeader.findMany({ where: { isDeleted: false, partId: { not: null } }, select: { id: true, partId: true, revision: true, updatedAt: true } }),
      calculateLiveMbomCosts(prisma, { costingDate }),
    ]);
    const partIds = parts.map((part) => part.id);
    const [partPrices, materialPrices, productPrices] = await Promise.all([
      partIds.length ? prisma.partPriceList.findMany({ where: { isDeleted: false, partId: { in: partIds } } }) : [],
      materialIds.length ? prisma.materialPriceList.findMany({ where: { isDeleted: false, materialId: { in: materialIds } } }) : [],
      productIds.length ? prisma.productPriceList.findMany({ where: { isDeleted: false, productId: { in: productIds } } }) : [],
    ]);
    const currencyRates = new Map(currencies.map((row) => [String(row.currencyCode).toUpperCase(), number(row.exchangeRate) || 1]));
    const toIdr = (value, currencyCode) => number(value) * (String(currencyCode || "IDR").toUpperCase() === "IDR" ? 1 : currencyRates.get(String(currencyCode).toUpperCase()) || 1);
    const latestPrice = (rows) => [...rows]
      .filter((row) => !row.pricingYear || number(row.pricingYear) <= year)
      .sort((left, right) => number(right.pricingYear) - number(left.pricingYear) || new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0))[0];
    const monthlyPrice = (row) => {
      for (let offset = 0; offset < 12; offset += 1) {
        const value = number(row?.[monthFields[(costingDate.getMonth() - offset + 12) % 12]]);
        if (value > 0) return toIdr(value, row.currencyCode);
      }
      return 0;
    };
    const partByCode = new Map(parts.map((part) => [part.partCode, part]));
    const partByNumber = new Map(parts.filter((part) => part.partNumber).map((part) => [part.partNumber, part]));
    const bomByPart = new Map();
    [...bomHeaders].sort((left, right) => number(right.revision) - number(left.revision) || new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0)).forEach((header) => {
      if (!bomByPart.has(header.partId)) bomByPart.set(header.partId, header);
    });
    valuationRows = balances.map((row) => {
      const part = partByCode.get(row.partCode) || partByNumber.get(row.partNumber);
      let priceRecord = null;
      let unitPrice = 0;
      let priceSource = "Belum ada harga";
      if (row.materialId) {
        priceRecord = latestPrice(materialPrices.filter((price) => price.materialId === row.materialId));
        unitPrice = monthlyPrice(priceRecord);
        if (unitPrice > 0) priceSource = "Material Price List";
      } else if (row.productId) {
        priceRecord = latestPrice(productPrices.filter((price) => price.productId === row.productId && (!price.uomCode || uomOf(price) === uomOf(row))));
        unitPrice = monthlyPrice(priceRecord);
        if (unitPrice > 0) priceSource = "Product Price List";
      } else if (part) {
        priceRecord = latestPrice(partPrices.filter((price) => price.partId === part.id));
        unitPrice = monthlyPrice(priceRecord);
        if (unitPrice > 0) priceSource = "Part Price List";
        if (unitPrice <= 0) {
          const bomHeader = bomByPart.get(part.id);
          unitPrice = number(liveBomCosts.get(bomHeader?.id)?.costPerUnit);
          if (unitPrice > 0) priceSource = "Live MBOM Costing";
        }
      }
      return {
        ...row,
        unitPrice,
        onHandValue: number(row.qtyOnHand) * unitPrice,
        availableValue: number(row.qtyAvailable) * unitPrice,
        reservedQcValue: (number(row.qtyReserved) + number(row.qtyQC)) * unitPrice,
        priceSource,
      };
    });
  }
  const priceLabels = types.length ? types : ["Belum ada nilai stok"];
  const onHandValueByType = priceLabels.map((type) => sum(valuationRows.filter((row) => stockTypeOf(row) === type).map((row) => row.onHandValue)));
  const availableValueByType = priceLabels.map((type) => sum(valuationRows.filter((row) => stockTypeOf(row) === type).map((row) => row.availableValue)));
  const inventoryValue = sum(valuationRows.map((row) => row.onHandValue));
  const availableValue = sum(valuationRows.map((row) => row.availableValue));
  const reservedQcValue = sum(valuationRows.map((row) => row.reservedQcValue));
  const pricedLines = valuationRows.filter((row) => number(row.qtyOnHand) === 0 || number(row.unitPrice) > 0).length;
  const unpricedLines = Math.max(valuationRows.length - pricedLines, 0);
  const opnameByType = new Map();
  opnames.forEach((header) => header.details.forEach((detail) => {
    const key = detail.stockType || header.stoType || "Unclassified";
    const row = opnameByType.get(key) || { stockType: key, systemQty: 0, physicalQty: 0, variance: 0, shortageLines: 0, excessLines: 0 };
    row.systemQty += number(detail.systemQty);
    row.physicalQty += number(detail.actualQty);
    row.variance += number(detail.varianceQty);
    if (detail.varianceStatus === "SHORTAGE") row.shortageLines += 1;
    if (detail.varianceStatus === "EXCESS") row.excessLines += 1;
    opnameByType.set(key, row);
  }));
  const opnameRows = [...opnameByType.values()].sort((a, b) => a.stockType.localeCompare(b.stockType));
  const varianceLabels = types.length ? types : ["Belum ada stock opname"];
  const systemByType = varianceLabels.map((type) => number(opnameByType.get(type)?.systemQty));
  const physicalByType = varianceLabels.map((type) => number(opnameByType.get(type)?.physicalQty));
  const inventoryExceptions = [];
  if (lowStock) inventoryExceptions.push(exception("WARNING", "LOW_STOCK", `${lowStock} stock line di bawah minimum`, "Periksa replenishment dan reservation", lowStock, "/modules/inventory/stock-balances"));
  opnameRows.filter((row) => row.shortageLines || row.excessLines).forEach((row) => inventoryExceptions.push(exception(row.shortageLines ? "CRITICAL" : "WARNING", "STOCK_OPNAME_VARIANCE", `${row.stockType}: variance stock opname`, `${row.shortageLines} shortage / ${row.excessLines} excess`, row.variance, "/modules/inventory/stock-opname")));
  const payload = comparisonPayload({
    module: "inventory", title: "Dashboard Stock", subtitle: "Posisi stok aktual, ketersediaan, reservasi, minimum stock, dan hasil stock opname.", year,
    modes: {
      QTY: [{ name: "Minimum Target", data: target }, { name: "On Hand Actual", data: actual }],
      PRICE: [{ name: "On Hand Value", data: onHandValueByType }, { name: "Available Value", data: availableValueByType }],
      VARIANCE: [{ name: "System Qty", data: systemByType }, { name: "Physical Count", data: physicalByType }],
    },
    labelsByMetric: { QTY: qtyLabels, PRICE: priceLabels, VARIANCE: varianceLabels },
    kpis: [
      kpi("On Hand", onHand, "number", `${balances.length} stock balance lines`),
      kpi("Available", available, "number", `${percent(available, onHand)}% dari on-hand`),
      kpi("Reserved / QC", reserved + sum(balances.map((row) => row.qtyQC)), "number", "Stok belum bebas digunakan"),
      kpi("Low Stock Lines", lowStock, "number", "Available di bawah minimum", null, lowStock ? "negative" : "positive"),
    ],
    kpisByMetric: {
      PRICE: [
        kpi("Inventory Value", inventoryValue, "currency", "On-hand berdasarkan harga referensi"),
        kpi("Available Value", availableValue, "currency", "Nilai stok bebas digunakan"),
        kpi("Reserved / QC Value", reservedQcValue, "currency", "Nilai stok belum bebas digunakan"),
        kpi("Unpriced Lines", unpricedLines, "number", "Saldo aktif tanpa referensi harga", null, unpricedLines ? "warning" : "positive"),
      ],
    },
    insights: [
      { label: "Coverage vs Minimum", value: `${percent(onHand, minimum)}%`, tone: onHand >= minimum ? "positive" : "negative", note: "on-hand terhadap minimum" },
      { label: "Stock Categories", value: String(types.length), tone: "accent", note: "kelompok saldo aktif" },
      { label: "Low Stock", value: String(lowStock), tone: lowStock ? "negative" : "positive", note: "line memerlukan tindakan" },
    ],
    insightsByMetric: {
      PRICE: [
        { label: "Valuation Coverage", value: `${percent(pricedLines, valuationRows.length)}%`, tone: unpricedLines ? "warning" : "positive", note: "line stok dengan harga" },
        { label: "Stock Value", value: new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", notation: "compact", maximumFractionDigits: 1 }).format(inventoryValue), tone: "accent", note: "nilai on-hand" },
        { label: "Unpriced", value: String(unpricedLines), tone: unpricedLines ? "negative" : "positive", note: "line perlu master harga" },
      ],
    },
    detailTables: [
      table("Stock Position per Kategori", [
        { key: "stockType", label: "Stock Type" }, { key: "uomCode", label: "UOM" }, { key: "minimum", label: "Minimum", format: "number" },
        { key: "onHand", label: "On Hand", format: "number" }, { key: "available", label: "Available", format: "number" },
        { key: "reservedQc", label: "Reserved + QC", format: "number" },
      ], quantityGroups.map((key) => { const rows = balances.filter((row) => quantityKey(row) === key); return { stockType: stockTypeOf(rows[0] || {}), uomCode: uomOf(rows[0] || {}), minimum: sum(rows.map((row) => row.minStock)), onHand: sum(rows.map((row) => row.qtyOnHand)), available: sum(rows.map((row) => row.qtyAvailable)), reservedQc: sum(rows.map((row) => number(row.qtyReserved) + number(row.qtyQC))) }; })),
      table("Inventory Valuation per Kategori", [
        { key: "stockType", label: "Stock Type" }, { key: "onHandValue", label: "On Hand Value", format: "currency" },
        { key: "availableValue", label: "Available Value", format: "currency" }, { key: "reservedQcValue", label: "Reserved + QC", format: "currency" },
        { key: "unpricedLines", label: "Unpriced Lines", format: "number" },
      ], types.map((type) => { const rows = valuationRows.filter((row) => stockTypeOf(row) === type); return { stockType: type, onHandValue: sum(rows.map((row) => row.onHandValue)), availableValue: sum(rows.map((row) => row.availableValue)), reservedQcValue: sum(rows.map((row) => row.reservedQcValue)), unpricedLines: rows.filter((row) => number(row.qtyOnHand) !== 0 && number(row.unitPrice) <= 0).length }; }), "Harga referensi: price list aktif terbaru; part in-house memakai Live MBOM Costing."),
      table("Stock Opname Reconciliation", [
        { key: "stockType", label: "Stock Type" }, { key: "systemQty", label: "System", format: "number" },
        { key: "physicalQty", label: "Physical", format: "number" }, { key: "variance", label: "Variance", format: "number" },
        { key: "shortageLines", label: "Shortage Lines", format: "number" }, { key: "excessLines", label: "Excess Lines", format: "number" },
      ], opnameRows),
    ],
    exceptions: inventoryExceptions,
    definitions: [
      { label: "Opname Documents", value: String(opnames.length), note: `status selain Draft pada ${year}` },
      { label: "Valuation Basis", value: "Reference Cost", note: "Price list aktif terbaru; fallback Live MBOM Costing untuk part in-house" },
      { label: "Unpriced Lines", value: String(unpricedLines), note: "Tidak dimasukkan ke nilai hingga master harga/cost tersedia" },
    ],
  });
  return payload;
}

async function bomDashboard(year) {
  const headers = await prisma.mBOMHeader.findMany({
    where: { isDeleted: false, createdAt: yearRange(year) },
    select: {
      createdAt: true,
      details: { where: { isDeleted: false }, select: { id: true, category: true, mbomProcesses: { where: { isDeleted: false }, select: { machineId: true, vendorId: true, routingMode: true, cycleTime: true } } } },
      mbomcostHeaders: { where: { isDeleted: false }, take: 1, select: { id: true } },
    },
  });
  const plan = monthBucket(); const actual = monthBucket();
  headers.forEach((header) => {
    addMonth(plan, header.createdAt, 1);
    const routed = header.details.length > 0 && header.details.every((detail) =>
      detail.mbomProcesses.every((process) =>
        String(detail.category || "").toUpperCase() === "VENDOR"
        || process.routingMode === "VENDOR"
        || (number(process.cycleTime) > 0 && process.machineId)));
    if (routed && header.mbomcostHeaders.length) addMonth(actual, header.createdAt, 1);
  });
  const total = sum(plan); const ready = sum(actual);
  return comparisonPayload({
    module: "manufacturing-bom", title: "BOM Governance", subtitle: "BOM baru dibanding BOM yang routing dan costing-nya lengkap.", year,
    modes: { QTY: [{ name: "BOM Created", data: plan }, { name: "Routing + Cost Ready", data: actual }] },
    kpis: [
      kpi("BOM Created", total, "number", `Tahun ${year}`),
      kpi("Fully Ready", ready, "number", `${percent(ready, total)}% governance coverage`),
      kpi("Action Required", Math.max(total - ready, 0), "number", "Routing atau costing belum lengkap"),
      kpi("Readiness", percent(ready, total), "percent", "Target 100%"),
    ],
    insights: [
      { label: "Governance Coverage", value: `${percent(ready, total)}%`, tone: ready === total ? "positive" : "warning", note: "routing dan cost complete" },
      { label: "BOM Gap", value: String(Math.max(total - ready, 0)), tone: "warning", note: "perlu dilengkapi" },
    ],
  });
}

async function systemDashboard(year, options = {}) {
  const [sales, production, purchasing, inventory] = await Promise.all([
    salesDashboard(year, "system", options),
    productionDashboard(year),
    purchasingDashboard(year),
    inventoryDashboard(year, { includeValuation: false }),
  ]);
  sales.title = "Ringkasan Sistem";
  sales.subtitle = "Penjualan, produksi, pembelian, dan persediaan.";
  sales.kpis = [
    sales.kpis[0],
    { ...production.kpis[1], label: "Production Actual" },
    { ...purchasing.kpis[1], label: "Purchase Received" },
    { ...inventory.kpis[1], label: "Inventory Available" },
  ];
  sales.insights = [
    ...sales.insights.slice(0, 1),
    ...production.insights.slice(0, 1),
    ...purchasing.insights.slice(0, 1),
    ...inventory.insights.slice(2, 3),
  ];
  sales.detailTables = [table("Plan vs Actual Lintas Modul", [
    { key: "module", label: "Modul" }, { key: "plan", label: "Plan / Target", format: "number" },
    { key: "actual", label: "Actual", format: "number" }, { key: "attainment", label: "Attainment", format: "percent" },
    { key: "status", label: "Status" },
  ], [
    { module: "Sales Qty", plan: sum(sales.comparison.modes.PLAN_QTY?.[0]?.data || []), actual: sum(sales.comparison.modes.PLAN_QTY?.[1]?.data || []), attainment: percent(sum(sales.comparison.modes.PLAN_QTY?.[1]?.data || []), sum(sales.comparison.modes.PLAN_QTY?.[0]?.data || [])), status: "Forecast vs actual" },
    { module: "Production", plan: production.kpis[0].value, actual: production.kpis[1].value, attainment: percent(production.kpis[1].value, production.kpis[0].value), status: "MPP execution" },
    { module: "Purchasing", plan: purchasing.kpis[0].value, actual: purchasing.kpis[1].value, attainment: percent(purchasing.kpis[1].value, purchasing.kpis[0].value), status: "PO vs GR" },
    { module: "Inventory", plan: sum(inventory.comparison.modes.QTY?.[0]?.data || []), actual: sum(inventory.comparison.modes.QTY?.[1]?.data || []), attainment: percent(sum(inventory.comparison.modes.QTY?.[1]?.data || []), sum(inventory.comparison.modes.QTY?.[0]?.data || [])), status: "Minimum vs on-hand" },
  ])];
  sales.exceptions = [...(sales.exceptions || []), ...(production.exceptions || []), ...(purchasing.exceptions || []), ...(inventory.exceptions || [])]
    .sort((a, b) => ({ CRITICAL: 0, WARNING: 1, INFO: 2 }[a.severity] ?? 3) - ({ CRITICAL: 0, WARNING: 1, INFO: 2 }[b.severity] ?? 3))
    .slice(0, 30);
  sales.definitions = [
    { label: "Open Exceptions", value: String(sales.exceptions.length), note: "gabungan sales, production, purchasing, dan inventory" },
    { label: "Critical", value: String(sales.exceptions.filter((row) => row.severity === "CRITICAL").length), note: "memerlukan tindakan segera" },
  ];
  return sales;
}

exports.get = async (req, res, next) => {
  try {
    const year = Math.min(2100, Math.max(2000, Number(req.query.year) || new Date().getFullYear()));
    const module = String(req.params.module || "system").toLowerCase();
    const builders = {
      system: systemDashboard,
      sales: (value, options) => salesDashboard(value, "sales", options),
      production: productionDashboard,
      "planning-ppic": planningDashboard,
      purchasing: (value) => purchasingDashboard(value, "purchasing"),
      incoming: (value) => purchasingDashboard(value, "incoming"),
      outgoing: outgoingDashboard,
      inventory: inventoryDashboard,
      "manufacturing-bom": bomDashboard,
    };
    const builder = builders[module];
    if (!builder) return res.status(404).json({ message: `Dashboard modul ${module} tidak tersedia.` });
    const options = { actualBasis: req.query.actualBasis };
    res.json(await builder(year, options));
  } catch (error) {
    next(error);
  }
};
