/* Destructive cleanup requested by the operator.
 * Keeps master data, users, BOM, sales, purchasing, inventory and production.
 * Removes only Forecast, MPS and MRP planning records in FK-safe order.
 */
const { prisma } = require("../src/prisma");

const delegates = [
  "mRPPegging",
  "mRPDirtyItem",
  "mRPPartialSnapshot",
  "plannedOrder",
  "mRPRequirement",
  "mRPRun",
  "mPSDetail",
  "mPS",
  "forecastDetail",
  "forecast",
];

async function counts(db) {
  const result = {};
  for (const delegate of delegates) result[delegate] = await db[delegate].count();
  return result;
}

async function main() {
  const before = await counts(prisma);
  const removed = {};
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(2026072802)`;
    for (const delegate of delegates) removed[delegate] = (await tx[delegate].deleteMany({})).count;
  }, { maxWait: 30000, timeout: 120000 });
  const after = await counts(prisma);
  console.log(JSON.stringify({ status: "COMPLETED", before, removed, after }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
