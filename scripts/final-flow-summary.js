require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
(async () => {
  const [forecast, mps, mrp, mpp, prs, pos, gr, mos, so, schedules, stock, movements] = await Promise.all([
    prisma.forecast.findMany({ where: { isDeleted: false }, select: { forecastNumber: true, status: true }, orderBy: { forecastNumber: "asc" } }),
    prisma.mPS.findMany({ where: { isDeleted: false }, select: { mpsNumber: true, periodStart: true, periodEnd: true, status: true, details: { where: { isDeleted: false }, select: { partCode: true, forecastQty: true, bufferQty: true, effectiveDemandQty: true, qtyPlanned: true, status: true } } }, orderBy: { periodStart: "asc" } }),
    prisma.mRPRun.findMany({ where: { isDeleted: false }, select: { runNumber: true, mpsNumber: true, status: true, totalRequirements: true, totalPlannedOrders: true, isCurrentPlan: true }, orderBy: { createdAt: "asc" } }),
    prisma.monthlyProductionPlan.findMany({ where: { isDeleted: false }, select: { planNumber: true, status: true, details: { where: { isDeleted: false }, select: { lineNumber: true, partCode: true, qtyPlanned: true, status: true } } }, orderBy: { planMonth: "asc" } }),
    prisma.purchaseRequisition.findMany({ where: { isDeleted: false }, select: { prNumber: true, status: true, convertedToPO: true } }),
    prisma.purchaseOrder.findMany({ where: { isDeleted: false }, select: { poNumber: true, status: true, supplierCode: true } }),
    prisma.goodsReceipt.findMany({ where: { isDeleted: false }, select: { grNumber: true, status: true, poNumber: true } }),
    prisma.manufacturingOrder.findMany({ where: { isDeleted: false }, select: { moNumber: true, status: true, qtyPlanned: true, qtyGood: true }, orderBy: { moNumber: "asc" } }),
    prisma.salesOrderHeader.findMany({ where: { isDeleted: false }, select: { soNumber: true, status: true, details: { where: { isDeleted: false }, select: { lineNumber: true, qty: true, qtyDelivered: true } } } }),
    prisma.deliverySchedule.findMany({ where: { isDeleted: false }, select: { scheduleNumber: true, status: true, soNumber: true, details: { where: { isDeleted: false }, select: { qty: true, qtyDelivered: true } } }, orderBy: { scheduleNumber: "asc" } }),
    prisma.stockBalance.findMany({ where: { partCode: "C001-C002-000", stockType: "Finished Goods", isDeleted: false }, select: { lotNumber: true, qtyOnHand: true, qtyAvailable: true } }),
    prisma.stockMovement.count({ where: { referenceType: "DELIVERY_SCHEDULE", movementType: "OUT", isDeleted: false } }),
  ]);
  console.log(JSON.stringify({ forecast, mps, mrp, mpp, prs, pos, gr, mos, so, schedules, stock, deliveryOutboundMovements: movements }, null, 2));
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
