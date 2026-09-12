process.env.NODE_ENV = "test";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { prisma } = require("../src/prisma/index");
const service = require("../src/prisma/services/planning/integratedPlanService");
(async () => {
  const doc = await prisma.mPS.findFirst({ where: { isDeleted: false, sourceKey: { startsWith: "MONTH:" }, status: { in: ["Draft", "Confirmed"] } }, orderBy: { periodStart: "desc" } });
  assert(doc, "Existing MPS is required for this rollback preview check");
  const before = await service.sourceFingerprint(prisma, doc.mpsNumber);
  const counts = await Promise.all([prisma.mRPRun.count(), prisma.monthlyProductionPlan.count(), prisma.productionPlanAllocation.count(), prisma.systemSetting.count()]);
  let error, result;
  try { result = await service.review(prisma, { mpsNumber: doc.mpsNumber, user: { username: "ppic-r3-verification" } }); }
  catch (failure) { error = failure; }
  assert.equal(await service.sourceFingerprint(prisma, doc.mpsNumber), before, "Preview must not change any source data");
  assert.deepEqual(await Promise.all([prisma.mRPRun.count(), prisma.monthlyProductionPlan.count(), prisma.productionPlanAllocation.count(), prisma.systemSetting.count()]), counts, "Preview must not persist runs, plans, allocations or settings");
  console.log("Rollback and source identity verified.");
  if (error) throw error;
  fs.mkdirSync("../output/ppic-r3", { recursive: true });
  fs.writeFileSync("../output/ppic-r3/live-preview.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ mpsNumber: result.mpsNumber, parts: result.workbench.items.length, materials: result.materials.length, lots: result.lots.length, plans: result.plans.length }));
})().then(() => process.exit(0)).catch(error => { console.error(error.stack); process.exit(1); });
