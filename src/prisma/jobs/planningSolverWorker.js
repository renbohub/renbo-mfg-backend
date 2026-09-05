"use strict";

require("dotenv").config();
const { prisma, connectDatabase } = require("../index");
const { solveFiniteSchedule, solveBackwardMilestones } = require("../services/planning/solver/planningSolverService");
const { completeSolverRun, failSolverRun } = require("../services/planning/solver/planningSolverRunService");

const POLL_MS = Math.max(Number(process.env.PLANNING_SOLVER_POLL_MS || 2000), 250);
let stopping = false;

async function claimNext() {
  return prisma.$transaction(async (tx) => {
    const queued = await tx.planningSolverRun.findFirst({ where: { status: "QUEUED" }, orderBy: { requestedAt: "asc" } });
    if (!queued) return null;
    const claimed = await tx.planningSolverRun.updateMany({ where: { id: queued.id, status: "QUEUED" }, data: { status: "RUNNING", startedAt: new Date() } });
    return claimed.count ? queued : null;
  });
}

async function execute(run) {
  try {
    const input = run.inputSnapshot || {};
    const result = run.scope === "BACKWARD_MILESTONE"
      ? await solveBackwardMilestones(input)
      : await solveFiniteSchedule(input);
    await completeSolverRun(prisma, run.id, result);
  } catch (error) {
    await failSolverRun(prisma, run.id, error);
    console.error(`[planning-solver] ${run.runNumber} failed:`, error.message);
  }
}

async function main() {
  await connectDatabase({ seed: false });
  console.log(`[planning-solver] ready; poll=${POLL_MS}ms`);
  while (!stopping) {
    const run = await claimNext();
    if (run) await execute(run);
    else await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function shutdown() {
  stopping = true;
  await prisma.$disconnect();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
main().catch((error) => { console.error("[planning-solver] fatal:", error); process.exit(1); });
