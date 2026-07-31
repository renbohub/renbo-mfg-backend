require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
const outgoing = require("../src/prisma/controllers/outgoing/OutgoingTransactionController");
const soService = require("../src/prisma/services/production/sales-order/soStatusService");
const { syncReservationsForConfirmedSO } = require("../src/prisma/services/production/sales-order/soReservationService");
function invoke(fn, req = {}) { return new Promise((resolve, reject) => { const request = { params: {}, body: {}, query: {}, user: { username: "system", email: "system@local" }, ...req }; const response = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { resolve({ statusCode: this.statusCode, body: v }); } }; Promise.resolve(fn(request, response, reject)).catch(reject); }); }
(async () => {
  const mos = await prisma.manufacturingOrder.findMany({ where: { isDeleted: false, status: { in: ["Released", "In Progress"] } }, select: { id: true, moNumber: true, qtyPlanned: true, monthlyProductionPlanNumber: true, monthlyProductionPlanLineNumber: true } });
  for (const mo of mos) {
    await prisma.manufacturingOrder.update({ where: { id: mo.id }, data: { status: "Completed", qtyProduced: mo.qtyPlanned, qtyGood: mo.qtyPlanned, qtyReject: 0, actualEndDate: new Date() } });
    if (mo.monthlyProductionPlanNumber && mo.monthlyProductionPlanLineNumber != null) {
      await prisma.monthlyProductionPlanDetail.updateMany({ where: { planId: (await prisma.monthlyProductionPlan.findUnique({ where: { planNumber: mo.monthlyProductionPlanNumber }, select: { id: true } }))?.id, lineNumber: mo.monthlyProductionPlanLineNumber }, data: { status: "Completed", qtyReleased: mo.qtyPlanned } });
    }
  }
  const plans = await prisma.monthlyProductionPlan.findMany({ where: { isDeleted: false, planNumber: { in: ["MPP-202608-001", "MPP-202609-001"] } }, select: { id: true, planNumber: true } });
  for (const plan of plans) await prisma.monthlyProductionPlan.update({ where: { id: plan.id }, data: { status: "Closed", closedBy: "system", closedAt: new Date() } });
  const so = await prisma.salesOrderHeader.findUnique({ where: { soNumber: "SO-2026-001" }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } } });
  if (!so) throw new Error("SO-2026-001 tidak ditemukan");
  await prisma.$transaction(async (tx) => { await syncReservationsForConfirmedSO(tx, so, so.details); });
  const existingSchedules = await prisma.deliverySchedule.findMany({ where: { soNumber: so.soNumber, isDeleted: false, status: { notIn: ["Delivered", "Cancelled", "Failed"] } }, include: { details: true }, orderBy: { createdAt: "asc" } });
  const schedules = [];
  for (const detail of so.details) {
    const existing = existingSchedules.find((row) => row.details.some((line) => line.soDetailId === detail.id));
    let scheduleNumber = existing?.scheduleNumber;
    if (!scheduleNumber) {
      const deliveredQty = Number(detail.qtyDelivered || 0);
      const scheduledQty = await prisma.deliveryScheduleDetail.aggregate({ where: { soDetailId: detail.id, isDeleted: false, schedule: { is: { isDeleted: false, status: { notIn: ["Delivered", "Cancelled", "Failed"] } } } }, _sum: { qty: true } });
      const outstanding = Number(detail.qty) - deliveredQty - Number(scheduledQty._sum.qty || 0);
      if (outstanding <= 0.000001) continue;
      const created = await invoke(outgoing.createSchedule, { body: { soNumber: so.soNumber, plannedDate: detail.deliveryDate || new Date().toISOString(), deliveryAddress: so.shippingAddress || "Customer C001", shippingMethod: "Truck", details: [{ soDetailId: detail.id, qty: outstanding }] } });
      if (created.statusCode >= 300) throw new Error(`Create Delivery Schedule line ${detail.lineNumber} gagal: ${created.body?.message}`);
      scheduleNumber = created.body.scheduleNumber;
    }
    let state = await prisma.deliverySchedule.findUnique({ where: { scheduleNumber }, select: { status: true } });
    let result;
    if (state.status === "Scheduled") result = await invoke(outgoing.pick, { params: { scheduleNumber }, body: {} });
    if (result?.statusCode >= 300) throw new Error(`Pick ${scheduleNumber} gagal: ${result.body?.message}`);
    state = await prisma.deliverySchedule.findUnique({ where: { scheduleNumber }, select: { status: true } });
    if (state.status === "On Process") result = await invoke(outgoing.pack, { params: { scheduleNumber }, body: {} });
    state = await prisma.deliverySchedule.findUnique({ where: { scheduleNumber }, select: { status: true } });
    if (state.status === "On Process") result = await invoke(outgoing.markShipment, { params: { scheduleNumber }, body: { trackingNumber: `TRK-${scheduleNumber}`, shippingMethod: "Truck", vehicle: "B-1234-ERP", driver: "system", carrier: "Internal" } });
    if (result?.statusCode >= 300) throw new Error(`Ship ${scheduleNumber} gagal: ${result.body?.message}`);
    state = await prisma.deliverySchedule.findUnique({ where: { scheduleNumber }, select: { status: true } });
    if (state.status === "Delivered") { schedules.push({ scheduleNumber, qty: detail.qty, status: state.status }); continue; }
    result = await invoke(outgoing.confirmPod, { params: { scheduleNumber }, body: { receivedBy: "Customer C001", receivedSignature: "system" } });
    if (result.statusCode >= 300) throw new Error(`POD ${scheduleNumber} gagal: ${result.body?.message}`);
    schedules.push({ scheduleNumber, qty: detail.qty, status: result.body.status });
  }
  await prisma.$transaction(async (tx) => { await soService.syncOperationalSalesOrderStatus(tx, so.soNumber); });
  const [finalSo, fgStock] = await Promise.all([
    prisma.salesOrderHeader.findUnique({ where: { soNumber: so.soNumber }, select: { soNumber: true, status: true } }),
    prisma.stockBalance.findMany({ where: { partCode: "C001-C002-000", stockType: "Finished Goods", isDeleted: false }, select: { warehouseCode: true, rackCode: true, lotNumber: true, uomCode: true, qtyOnHand: true, qtyReserved: true, qtyAvailable: true, qtyQC: true } }),
  ]);
  console.log(JSON.stringify({ schedules, so: finalSo, fgStock }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
