require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
(async () => {
  await prisma.$transaction(async (tx) => {
    await tx.mPS.updateMany({ where: { isDeleted: false, mpsNumber: { in: ["MPS-2026-001", "MPS-2026-002"] } }, data: { status: "Completed" } });
    await tx.mPSDetail.updateMany({ where: { isDeleted: false, mpsNumber: { in: ["MPS-2026-001", "MPS-2026-002"] } }, data: { status: "Completed" } });
    await tx.monthlyProductionPlanDetail.updateMany({ where: { isDeleted: false, planId: { in: (await tx.monthlyProductionPlan.findMany({ where: { planNumber: { in: ["MPP-202608-001", "MPP-202609-001"] } }, select: { id: true } })).map((row) => row.id) } }, data: { status: "Completed", qtyReleased: { set: 0 } } });
    const planDetails = await tx.monthlyProductionPlanDetail.findMany({ where: { isDeleted: false, planId: { in: (await tx.monthlyProductionPlan.findMany({ where: { planNumber: { in: ["MPP-202608-001", "MPP-202609-001"] } }, select: { id: true } })).map((row) => row.id) } }, select: { id: true, qtyPlanned: true } });
    for (const row of planDetails) await tx.monthlyProductionPlanDetail.update({ where: { id: row.id }, data: { qtyReleased: row.qtyPlanned } });
    await tx.mRPRun.updateMany({ where: { isDeleted: false }, data: { isCurrentPlan: false } });
    await tx.mRPRun.updateMany({ where: { runNumber: { in: ["MRP-20260727-004", "MRP-20260727-005"] } }, data: { isCurrentPlan: true } });
    const pos = await tx.purchaseOrder.findMany({ where: { isDeleted: false }, select: { poNumber: true } });
    for (const po of pos) {
      const details = await tx.purchaseOrderDetail.findMany({ where: { poNumber: po.poNumber, isDeleted: false }, select: { qty: true, qtyReceived: true } });
      if (details.length && details.every((row) => Number(row.qtyReceived || 0) + 1e-9 >= Number(row.qty || 0))) await tx.purchaseOrder.update({ where: { poNumber: po.poNumber }, data: { status: "Completed" } });
    }
  });
  console.log("flow status finalized");
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
