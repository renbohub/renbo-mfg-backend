require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
const outgoing = require("../src/prisma/controllers/outgoing/OutgoingTransactionController");
const soService = require("../src/prisma/services/production/sales-order/soStatusService");
const { syncReservationsForConfirmedSO } = require("../src/prisma/services/production/sales-order/soReservationService");
function invoke(fn, req = {}) { return new Promise((resolve, reject) => { const request = { params: {}, body: {}, query: {}, user: { username: "real-test", email: "real-test@local" }, ...req }; const response = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { resolve({ statusCode: this.statusCode, body: v }); } }; Promise.resolve(fn(request, response, (e) => reject(e))).catch(reject); }); }
(async () => {
  const so = await prisma.salesOrderHeader.findUnique({ where: { soNumber: "SO-REAL-001" }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } } });
  if (!so) throw new Error("SO-REAL-001 tidak ditemukan");
  await prisma.$transaction(async (tx) => { await syncReservationsForConfirmedSO(tx, so, so.details); });
  const schedules = [];
  for (const detail of so.details) {
    const created = await invoke(outgoing.createSchedule, { body: { soNumber: so.soNumber, plannedDate: detail.deliveryDate, deliveryAddress: "Customer C001", shippingMethod: "Truck", details: [{ soDetailId: detail.id, qty: Number(detail.qty) - Number(detail.qtyDelivered || 0) }] } });
    if (created.statusCode >= 300) { schedules.push({ lineNumber: detail.lineNumber, statusCode: created.statusCode, message: created.body?.message }); continue; }
    const scheduleNumber = created.body.scheduleNumber;
    let result = await invoke(outgoing.pick, { params: { scheduleNumber }, body: {} });
    if (result.statusCode < 300) result = await invoke(outgoing.pack, { params: { scheduleNumber }, body: {} });
    if (result.statusCode < 300) result = await invoke(outgoing.markShipment, { params: { scheduleNumber }, body: { trackingNumber: `TRK-${scheduleNumber}`, shippingMethod: "Truck", vehicle: "B-1234-ERP", driver: "real-test", carrier: "Internal" } });
    if (result.statusCode < 300) result = await invoke(outgoing.confirmPod, { params: { scheduleNumber }, body: { receivedBy: "Customer C001", receivedSignature: "real-test" } });
    schedules.push({ lineNumber: detail.lineNumber, scheduleNumber, statusCode: result.statusCode, status: result.body?.status, message: result.body?.message });
  }
  await prisma.$transaction(async (tx) => { await soService.syncOperationalSalesOrderStatus(tx, so.soNumber); });
  const [finalSo, fgStock, deliveries] = await Promise.all([
    prisma.salesOrderHeader.findUnique({ where: { soNumber: so.soNumber }, select: { soNumber: true, status: true } }),
    prisma.stockBalance.findMany({ where: { partCode: "C001-C002-000", isDeleted: false }, select: { warehouseCode: true, rackCode: true, lotNumber: true, qtyOnHand: true, qtyReserved: true, qtyAvailable: true, qtyQC: true } }),
    prisma.deliverySchedule.findMany({ where: { soNumber: so.soNumber, isDeleted: false }, select: { scheduleNumber: true, status: true, details: { select: { qty: true } } } }),
  ]);
  console.log(JSON.stringify({ schedules, so: finalSo, deliveries, fgStock }, null, 2));
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
