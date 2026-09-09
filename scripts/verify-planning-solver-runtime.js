"use strict";
const assert = require("node:assert/strict");
const watchdog = setTimeout(() => { console.error("CP-SAT runtime timeout"); process.exit(1); }, 30000);
(async () => {
  const { solveBackwardChain, solveFiniteSchedule } = await import("../src/prisma/services/planning/solver/planningCpSatSolver.mjs");
  const finiteInput = {
    horizonMinutes: 1000,
    tasks: Array.from({ length: 20 }, (_, index) => ({ id: `T${index}`, durationMinutes: 10 + index, eligibleResourceIds: ["M1", "M2"], dueMinute: 900, minimizeCompletion: true })),
    options: { maxTimeInSeconds: 1 },
  };
  const runs = await Promise.all(Array.from({ length: 8 }, (_, index) => index % 2
    ? solveFiniteSchedule(finiteInput)
    : solveBackwardChain({ horizonMinutes: 1000, tasks: [{ id: `B${index}`, durationMinutes: 60 }], options: { maxTimeInSeconds: 1 } })));
  for (const run of runs) assert.equal(run.feasible, true);
  for (const run of runs.filter((_, index) => index % 2)) {
    assert.equal(run.tasks.length, 20);
    for (const resourceId of ["M1", "M2"]) {
      const assigned = run.tasks.filter((task) => task.resourceId === resourceId).sort((a, b) => a.startMinute - b.startMinute);
      for (let index = 1; index < assigned.length; index++) assert.ok(assigned[index].startMinute >= assigned[index - 1].endMinute);
    }
  }
  console.log("Concurrent backward/finite CP-SAT runtime requests PASS");
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
