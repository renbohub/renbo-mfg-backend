/* Destructive cleanup requested by the operator.
 * Removes Sales Orders and their direct scheduling/reservation records only.
 * Master data, quotations, inventory balances/movements and production remain.
 */
const { prisma } = require("../src/prisma");

async function counts(db) {
  return {
    salesOrderHeader: await db.salesOrderHeader.count({ where: { isDeleted: false } }),
    salesOrderDetail: await db.salesOrderDetail.count({ where: { isDeleted: false } }),
    salesOrderAttachment: await db.salesOrderAttachment.count({ where: { isDeleted: false } }),
    deliverySchedule: await db.deliverySchedule.count({ where: { isDeleted: false } }),
    deliveryScheduleDetail: await db.deliveryScheduleDetail.count(),
    soReservation: await db.stockReservation.count({ where: { referenceType: "SO", isDeleted: false } }),
  };
}

async function main() {
  const before = await counts(prisma);
  const removed = {};
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(2026072803)`;
    removed.soReservation = (await tx.stockReservation.deleteMany({ where: { referenceType: "SO" } })).count;
    removed.deliveryScheduleDetail = (await tx.deliveryScheduleDetail.deleteMany({})).count;
    removed.deliverySchedule = (await tx.deliverySchedule.deleteMany({})).count;
    removed.salesOrderAttachment = (await tx.salesOrderAttachment.deleteMany({})).count;
    removed.salesOrderDetail = (await tx.salesOrderDetail.deleteMany({})).count;
    removed.salesOrderHeader = (await tx.salesOrderHeader.deleteMany({})).count;
  }, { maxWait: 30000, timeout: 120000 });
  const after = await counts(prisma);
  console.log(JSON.stringify({ status: "COMPLETED", before, removed, after }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
