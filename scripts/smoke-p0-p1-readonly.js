const { prisma } = require("../src/prisma");
const {
  buildMaterialReadinessSnapshot,
} = require("../src/prisma/services/planning/materialReadinessService");
const {
  canonicalizeRoutingOperations,
} = require("../src/prisma/utils/routingSequence");

async function main() {
  const plan = await prisma.monthlyProductionPlan.findFirst({
    where: { isDeleted: false },
    orderBy: { createdAt: "desc" },
    select: { planNumber: true },
  });
  if (plan) {
    const readiness = await buildMaterialReadinessSnapshot(prisma, plan.planNumber);
    console.log("PASS material readiness", {
      planNumber: readiness.planNumber,
      mrpRunNumber: readiness.mrpRunNumber,
      ready: readiness.ready,
      summary: readiness.summary,
    });
  } else {
    console.log("SKIP material readiness: belum ada MPP.");
  }

  const routes = await prisma.mBOMProcess.findMany({
    where: { isDeleted: false },
    take: 20,
    select: {
      id: true,
      noReg: true,
      routingNumber: true,
      sequence: true,
      mbomDetail: { select: { levelComponent: true } },
    },
  });
  const canonical = canonicalizeRoutingOperations(routes);
  if (canonical.some((route, index) => route.sequence !== (index + 1) * 10)) {
    throw new Error("Canonical routing sequence tidak deterministik.");
  }
  console.log("PASS canonical routing", {
    routeCount: canonical.length,
    first: canonical[0]?.routingNumber || null,
    last: canonical.at(-1)?.routingNumber || null,
  });

  const [partialOrders, pendingDirtyItems] = await Promise.all([
    prisma.plannedOrder.count({
      where: { isDeleted: false, status: "Partially Released" },
    }),
    prisma.mRPDirtyItem.count({
      where: { status: { in: ["Pending", "Processing"] } },
    }),
  ]);
  console.log("PASS P1 schema/runtime", { partialOrders, pendingDirtyItems });
}

main()
  .catch((error) => {
    console.error("FAIL P0/P1 smoke:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
