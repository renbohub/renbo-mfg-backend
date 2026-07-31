require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
(async () => {
  const active = async (model) => model.count({ where: { isDeleted: false } });
  const [forecast, so, mps, mrp, plans, dpp, mos, wos, logs, pr, po, gr, iqc, fgReceipt, deliveries, suppliers, warehouses, materialParts, machineRates] = await Promise.all([
    prisma.forecast.findMany({ where: { isDeleted: false }, select: { forecastNumber: true, status: true } }),
    active(prisma.salesOrderHeader), active(prisma.mPS), active(prisma.mRPRun), active(prisma.monthlyProductionPlan), active(prisma.dailyProductionSchedule), active(prisma.manufacturingOrder), active(prisma.workOrder), active(prisma.productionLog), active(prisma.purchaseRequisition), active(prisma.purchaseOrder), active(prisma.goodsReceipt), active(prisma.incomingInspection), prisma.stockMovement.count({ where: { isDeleted: false, OR: [{ transactionType: { contains: "FG", mode: "insensitive" } }, { notes: { contains: "FG Receipt", mode: "insensitive" } }] } }), active(prisma.deliverySchedule),
    prisma.supplier.count({ where: { isDeleted: false, status: "Active" } }),
    prisma.warehouse.count({ where: { isDeleted: false, isActive: true } }),
    prisma.part.groupBy({ by: ["materialId"], where: { isDeleted: false, materialId: { not: null } }, _count: { _all: true } }),
    prisma.machine.count({ where: { isDeleted: false, status: "Active", OR: [{ capacity: null }, { cycleTime: null }] } }),
  ]);
  const mpsRows = await prisma.mPSDetail.findMany({ where: { isDeleted: false, mpsNumber: { in: ["MPS-2026-001", "MPS-2026-002"] } }, select: { mpsNumber: true, partCode: true, forecastQty: true, actualSalesOrderQty: true, bufferQty: true, effectiveDemandQty: true, startDate: true } });
  const soRows = await prisma.salesOrderDetail.findMany({ where: { isDeleted: false, soNumber: "SO-REAL-001" }, select: { lineNumber: true, qty: true, qtyDelivered: true, deliveryDate: true } });
  const moRows = await prisma.manufacturingOrder.findMany({ where: { isDeleted: false }, select: { moNumber: true, status: true, qtyPlanned: true, qtyGood: true, qtyReject: true } });
  console.log(JSON.stringify({ forecast, counts: { so, mps, mrp, plans, dpp, mos, wos, logs, pr, po, gr, iqc, fgReceipt, deliveries }, soRows, mpsRows, moRows, masterConstraints: { activeSuppliers: suppliers, activeWarehouses: warehouses, materialPartGroups: materialParts, machinesMissingCapacityOrCycleTime: machineRates } }, null, 2));
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
