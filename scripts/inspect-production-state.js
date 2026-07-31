require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { prisma } = require("../src/prisma");

(async () => {
  const [mos, wos, logs, qcs, receipts, schedules, pos, prs] = await Promise.all([
    prisma.manufacturingOrder.findMany({ where: { isDeleted: false }, select: { moNumber: true, status: true, qtyPlanned: true, qtyProduced: true, qtyGood: true, qtyReject: true, part: { select: { partCode: true, partName: true } }, plannedStartDate: true }, orderBy: { moNumber: "asc" } }),
    prisma.workOrder.findMany({ where: { isDeleted: false }, select: { woNumber: true, moId: true, status: true, sequence: true, outputPartCode: true, plannedQty: true, qtyProduced: true, qtyGood: true, qtyReject: true, plannedDate: true, processId: true, process: { select: { processCode: true, processName: true } } }, orderBy: { woNumber: "asc" } }),
    prisma.productionLog.findMany({ where: { isDeleted: false }, select: { logNumber: true, status: true, qtyProduced: true, qtyGood: true, qtyReject: true, moId: true, woId: true }, orderBy: { logNumber: "asc" } }),
    prisma.qualityInspection.findMany({ where: { isDeleted: false }, select: { inspectionNumber: true, status: true, decision: true, qtyInspected: true, qtyPassed: true, qtyFailed: true, productionLogId: true }, orderBy: { inspectionNumber: "asc" } }),
    prisma.goodsReceipt.findMany({ where: { isDeleted: false }, select: { grNumber: true, status: true, poNumber: true }, orderBy: { grNumber: "asc" } }),
    prisma.deliverySchedule.findMany({ where: { isDeleted: false }, select: { scheduleNumber: true, status: true, soNumber: true }, orderBy: { scheduleNumber: "asc" } }),
    prisma.purchaseOrder.findMany({ where: { isDeleted: false }, select: { poNumber: true, status: true, supplierCode: true }, orderBy: { poNumber: "asc" } }),
    prisma.purchaseRequisition.findMany({ where: { isDeleted: false }, select: { prNumber: true, status: true }, orderBy: { prNumber: "asc" } }),
  ]);
  console.log(JSON.stringify({ mos, wos, logs, qcs, receipts, schedules, pos, prs }, null, 2));
  await prisma.$disconnect();
})().catch(async (error) => { console.error(error); await prisma.$disconnect(); process.exit(1); });
