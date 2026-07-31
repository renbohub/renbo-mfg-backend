require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
(async () => {
  const [forecast, so, mps, runs, orders] = await Promise.all([
    prisma.forecast.findMany({ where: { isDeleted: false }, select: { forecastNumber: true, status: true } }),
    prisma.salesOrderHeader.findMany({ where: { isDeleted: false }, select: { soNumber: true, status: true, details: { where: { isDeleted: false }, select: { partCode: true, qty: true, qtyDelivered: true, deliveryDate: true } } } }),
    prisma.mPS.findMany({ where: { isDeleted: false }, select: { mpsNumber: true, forecastNumber: true, status: true, details: { where: { isDeleted: false }, select: { partCode: true, forecastQty: true, actualSalesOrderQty: true, bufferQty: true, effectiveDemandQty: true, productionPercent: true, startDate: true, notes: true } } } }),
    prisma.mRPRun.findMany({ where: { isDeleted: false }, select: { runNumber: true, mpsNumber: true, status: true, totalRequirements: true, totalPlannedOrders: true, soDemandConsumedQty: true } }),
    prisma.plannedOrder.findMany({ where: { isDeleted: false }, select: { partCode: true, orderType: true, qty: true, requiredDate: true, status: true, referenceNumber: true } }),
  ]);
  console.log(JSON.stringify({ forecast, so, mps, runs, orders }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
