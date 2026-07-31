require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
const soCtrl = require("../src/prisma/controllers/sales/SalesOrderController");
const forecastCtrl = require("../src/prisma/controllers/planning/ForecastController");

function invoke(fn, { body = {}, params = {}, user = { username: "system" } } = {}) {
  return new Promise((resolve, reject) => {
    const req = { body, params, query: {}, user };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { resolve({ statusCode: this.statusCode, body: value }); } };
    Promise.resolve(fn(req, res, reject)).catch(reject);
  });
}

(async () => {
  const forecast = await prisma.forecast.findFirst({ where: { forecastNumber: "FCT-2026-001", isDeleted: false }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } } });
  if (!forecast) throw new Error("FCT-2026-001 tidak ditemukan.");
  const partCode = forecast.details[0]?.partCode;
  const part = await prisma.part.findUnique({ where: { partCode }, select: { partCode: true, partNumber: true, partName: true, baseUomCode: true } });
  if (!part) throw new Error(`Part forecast ${partCode} tidak ditemukan.`);

  const so = await invoke(soCtrl.create, { body: {
    soNumber: "SO-REAL-001",
    soDate: "2026-07-28",
    customerCode: forecast.customerCode || "C001",
    customerName: "REAL TEST CUSTOMER",
    currencyCode: "IDR",
    status: "Draft",
    details: [
      { partCode, partNumber: part.partNumber, partName: part.partName, uomCode: part.baseUomCode || "pcs", qty: 8000, deliveryDate: "2026-08-31", unitPrice: 0 },
      { partCode, partNumber: part.partNumber, partName: part.partName, uomCode: part.baseUomCode || "pcs", qty: 10000, deliveryDate: "2026-09-30", unitPrice: 0 },
    ],
  } });
  if (so.statusCode >= 300) throw new Error(`SO create gagal: ${JSON.stringify(so.body)}`);
  const confirmedSo = await invoke(soCtrl.confirm, { params: { soNumber: "SO-REAL-001" } });
  if (confirmedSo.statusCode >= 300) throw new Error(`SO confirm gagal: ${JSON.stringify(confirmedSo.body)}`);

  // Forecast confirmation is a state update (there is no separate confirm endpoint).
  const confirmedForecast = await prisma.forecast.update({ where: { forecastNumber: forecast.forecastNumber }, data: { status: "Confirmed" } });
  console.log(JSON.stringify({ so: confirmedSo.body, forecast: confirmedForecast }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
