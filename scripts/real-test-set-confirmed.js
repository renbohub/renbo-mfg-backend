require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
(async () => {
  const result = await prisma.forecast.updateMany({ where: { forecastNumber: "FCT-2026-001", isDeleted: false }, data: { status: "Confirmed" } });
  const forecast = await prisma.forecast.findFirst({ where: { forecastNumber: "FCT-2026-001", isDeleted: false }, select: { forecastNumber: true, status: true } });
  console.log(JSON.stringify({ updated: result.count, forecast }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
