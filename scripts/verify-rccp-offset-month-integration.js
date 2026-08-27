"use strict";

const assert = require("node:assert/strict");
const { prisma, disconnectDatabase } = require("../src/prisma");

const monthKey = (value) => new Date(value).toISOString().slice(0, 7);

(async () => {
  const mps = await prisma.mPS.findFirst({
    where: { mpsNumber: "MPS-202609", isDeleted: false },
    include: {
      rccpRuns: {
        where: { invalidatedAt: null }, orderBy: { createdAt: "desc" }, take: 1,
        include: { timeBuckets: true, offsetDetails: true, recommendations: true },
      },
    },
  });
  assert.ok(mps, "MPS-202609 must exist for the Step 02A integration fixture");
  const run = mps.rccpRuns[0];
  assert.ok(run, "a current RCCP run must exist");
  assert.equal(monthKey(mps.periodStart), "2026-09", "MPS period must remain September");
  assert.equal(monthKey(run.planningPeriod), "2026-09", "RCCP must not move the MPS month");
  assert.equal(run.hasPreviousMonthLoad, true, "September MPS must load previous-month capacity");
  assert.equal(monthKey(run.earliestStartDate), "2026-08", "earliest production must start in August");
  assert.ok(run.offsetStatus.startsWith("PREVIOUS_MONTH_"), "offset status must describe previous-month feasibility");
  const loadedBuckets = run.timeBuckets.filter((row) => Number(row.currentMpsLoad) > 0);
  assert.ok(loadedBuckets.some((row) => monthKey(row.bucketStart) === "2026-08"), "August weekly capacity bucket must be loaded");
  assert.ok(loadedBuckets.some((row) => monthKey(row.bucketStart) === "2026-09"), "September weekly capacity bucket must be loaded");
  const paintAugust24 = run.timeBuckets.find((row) => row.resourceCode === "VENDOR_PAINT"
    && new Date(row.bucketStart).toISOString().slice(0, 10) === "2026-08-24");
  const paintAugust31 = run.timeBuckets.find((row) => row.resourceCode === "VENDOR_PAINT"
    && new Date(row.bucketStart).toISOString().slice(0, 10) === "2026-08-31");
  assert.equal(Number(paintAugust24?.currentMpsLoad || 0), 0, "24 August painting must be empty when short packing shares the vendor handoff date");
  assert.ok(Math.abs(Number(paintAugust31?.currentMpsLoad) - 1.39) < 0.00001, "31 August painting must include the 5/6 September vendor loads and the 10 September overlap");
  const phaseQty = (Array.isArray(run.phaseSummary) ? run.phaseSummary : []).reduce((sum, row) => sum + Number(row.qty || 0), 0);
  assert.ok(Math.abs(phaseQty - Number(run.mpsQtySnapshot)) < 0.00001, "SUM phase qty must equal MPS qty");
  const september3 = (Array.isArray(run.phaseSummary) ? run.phaseSummary : [])
    .find((row) => new Date(row.requiredDate).toISOString().slice(0, 10) === "2026-09-03");
  assert.ok(september3, "3 September delivery phase must be present");
  assert.equal(Number(september3.qty), 49, "3 September must use stock-netted FG production qty");
  const september3Offsets = run.offsetDetails.filter((row) => row.mpsPhaseId === september3.phaseId);
  assert.deepEqual(september3Offsets.map((row) => row.resourceCode), ["PACKING"], "3 September must only load INSP-PACK/PACKING");
  assert.equal(Number(september3Offsets[0].phaseQty), 49, "packing resource qty must be 49");
  const vendor = run.offsetDetails.find((row) => row.resourceType === "OUTSOURCE" && Number(row.leadTimeValue) === 5);
  assert.ok(vendor, "vendor 5-working-day timing must be present");
  assert.ok(new Date(vendor.calculatedStartDate) < new Date(vendor.calculatedFinishDate), "vendor timing must have a start/finish range");
  const earlySeptemberVendor = run.offsetDetails.filter((row) => row.resourceCode === "VENDOR_PAINT"
    && ["2026-09-05", "2026-09-06"].includes(new Date(row.requiredDate).toISOString().slice(0, 10)));
  assert.deepEqual(earlySeptemberVendor.map((row) => ({
    start: new Date(row.calculatedStartDate).toISOString().slice(0, 10),
    finish: new Date(row.calculatedFinishDate).toISOString().slice(0, 10),
  })), [
    { start: "2026-08-31", finish: "2026-09-04" },
    { start: "2026-08-31", finish: "2026-09-04" },
  ], "5/6 September vendor paint must run 31 August through 4 September");
  const [mrpAfterRccp, moAfterRccp] = await Promise.all([
    prisma.mRPRun.count({ where: { createdAt: { gt: run.createdAt } } }),
    prisma.manufacturingOrder.count({ where: { createdAt: { gt: run.createdAt } } }),
  ]);
  assert.equal(mrpAfterRccp, 0, "RCCP must not create an MRP run");
  assert.equal(moAfterRccp, 0, "RCCP must not create a Manufacturing Order");
  console.log(`RCCP offset-month integration passed: ${mps.mpsNumber}, ${run.offsetStatus}, ${run.timeBuckets.length} weekly buckets.`);
  await disconnectDatabase();
})().catch(async (error) => {
  console.error(error);
  await disconnectDatabase();
  process.exit(1);
});
