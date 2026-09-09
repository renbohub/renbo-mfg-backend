"use strict";
const assert = require("node:assert/strict");
const { prisma } = require("../src/prisma");
const { __test } = require("../src/prisma/controllers/planning/MonthlyProductionPlanController");
const { buildMrpSourceSnapshot } = require("../src/prisma/services/planning/mrpLifecycleService");
const original = prisma.mRPRun.findMany;
(async () => {
  const mps = { mpsNumber: "MPS-TEST", revision: 2, periodStart: new Date("2026-09-01"), deliveryFeasibilityFingerprint: "current" };
  const valid = { runNumber: "MRP-VALID", mpsNumber: mps.mpsNumber, scenarioAssumptions: buildMrpSourceSnapshot([mps]) };
  let calls = 0;
  prisma.mRPRun.findMany = async ({ where }) => {
    calls++;
    assert.equal(where.isCurrentPlan, true);
    assert.equal(where.status, "Completed");
    assert.equal(where.scenarioStatus, "APPROVED");
    return [{ ...valid, runNumber: "MRP-STALE", scenarioAssumptions: buildMrpSourceSnapshot([{ ...mps, revision: 1 }]) }, valid];
  };
  assert.equal((await __test.currentCompletedMrpForMps(mps)).runNumber, "MRP-VALID");
  assert.equal(await __test.currentCompletedMrpForMps({ ...mps, replanRequired: true }), null);
  assert.equal(calls, 1);
  prisma.mRPRun.findMany = async () => [{ ...valid, scenarioAssumptions: {} }];
  assert.equal(await __test.currentCompletedMrpForMps(mps), null, "missing snapshot cannot generate MPP");
  console.log("MPP source: Approved/current query, revision/fingerprint and replan guards PASS");
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { prisma.mRPRun.findMany = original; await prisma.$disconnect(); });
