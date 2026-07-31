require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
const { syncManufacturingOrderQtyFromWorkOrders } = require("../src/prisma/controllers/production/services/productionWorkflowService");
(async () => {
  const mos = await prisma.manufacturingOrder.findMany({ where: { isDeleted: false, status: { not: "Cancelled" } }, select: { id: true, moNumber: true } });
  const result = [];
  for (const mo of mos) {
    const synced = await prisma.$transaction((tx) => syncManufacturingOrderQtyFromWorkOrders(tx, mo.id));
    result.push({ moNumber: mo.moNumber, status: synced?.status, qtyGood: synced?.qtyGood, qtyReject: synced?.qtyReject });
  }
  console.log(JSON.stringify(result, null, 2));
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
