require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
(async () => {
  console.log(JSON.stringify(await prisma.mRPRun.findMany({ select: { runNumber: true, mpsNumber: true, status: true, totalPlannedOrders: true } }), null, 2));
  console.log(JSON.stringify(await prisma.plannedOrder.findMany({ select: { orderNumber: true, runNumber: true, orderType: true, partCode: true, qty: true, requiredDate: true, status: true } }), null, 2));
  console.log(JSON.stringify(await prisma.mRPRequirement.findMany({ select: { runNumber: true, partCode: true, levelMBOM: true, netRequirement: true, plannedOrderQty: true, orderType: true, requiredDate: true } }), null, 2));
})().catch(console.error).finally(() => prisma.$disconnect());
