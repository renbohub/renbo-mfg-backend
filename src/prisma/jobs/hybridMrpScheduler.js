const cron = require("node-cron");
const { prisma } = require("../index");
const hybridMrpService = require("../services/planning/hybridMrpService");

let started = false;
let fullJob = null;
let partialJob = null;

function startHybridMrpScheduler() {
  if (started) return { started: true };

  fullJob = cron.schedule("0 0 * * *", async () => {
    console.log("🌙 [CRON] Starting nightly full MRP...");
    try {
      const result = await hybridMrpService.runFullNightlyMrp(prisma, {
        runBy: "cron",
        runDate: new Date(),
      });
      console.log("✅ [CRON] Full MRP completed:", {
        totalMps: result.totalMps,
        successCount: result.successCount,
        failedCount: result.failedCount,
      });
    } catch (error) {
      console.error("❌ [CRON] Full MRP failed:", error.message);
    }
  });

  partialJob = cron.schedule("*/15 * * * *", async () => {
    console.log("☀️ [CRON] Checking partial MRP dirty queue...");
    try {
      const result = await hybridMrpService.runPartialNetChangeMrp(prisma, {
        runBy: "cron",
        limit: 200,
      });
      if (result.dirtyCount > 0) {
        console.log("✅ [CRON] Partial MRP completed:", {
          dirtyCount: result.dirtyCount,
          impactedCount: result.impactedCount,
          mpsCount: result.mpsCount,
        });
      }
    } catch (error) {
      console.error("❌ [CRON] Partial MRP failed:", error.message);
    }
  });

  started = true;
  console.log("🕒 Hybrid MRP scheduler started: full nightly + partial every 15 minutes");
  return { started: true };
}

function stopHybridMrpScheduler() {
  if (fullJob) fullJob.stop();
  if (partialJob) partialJob.stop();
  started = false;
  return { started: false };
}

module.exports = {
  startHybridMrpScheduler,
  stopHybridMrpScheduler,
};