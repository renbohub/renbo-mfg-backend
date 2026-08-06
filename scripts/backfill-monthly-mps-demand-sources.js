const { prisma, disconnectDatabase } = require("../src/prisma");
const { syncMonthlyMps } = require("../src/prisma/services/planning/monthlyPlanningService");
const { planningMonthKey } = require("../src/prisma/utils/planningMonth");

(async () => {
  const documents = await prisma.mPS.findMany({
    where: { isDeleted: false, sourceKey: { startsWith: "MONTH:" }, status: { not: "Superseded" } },
    select: { periodStart: true },
  });
  const months = [...new Set(documents.map((row) => planningMonthKey(row.periodStart)).filter(Boolean))];
  if (!months.length) {
    console.log("No canonical monthly MPS found; nothing to backfill.");
    return;
  }
  const result = await prisma.$transaction((tx) => syncMonthlyMps(tx, { months, runBy: "p0-backfill" }), { timeout: 120000 });
  const sourceCount = await prisma.mPSDemandSource.count({ where: { mpsDetail: { mps: { sourceKey: { startsWith: "MONTH:" } } } } });
  console.log(JSON.stringify({ months: result.months, mpsNumbers: result.changedMpsNumbers, sourceCount }, null, 2));
})().finally(disconnectDatabase);
