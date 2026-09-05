"use strict";

const assert = require("assert");
const { solveBackwardMilestones, solveFiniteSchedule } = require("../src/prisma/services/planning/solver/planningSolverService");
const { validateBomGraphStructure } = require("../src/prisma/services/planning/solver/bomGraphValidationService");
const { scheduleDailyReleaseAllocations } = require("../src/prisma/services/planning/dailyReleaseSchedulingService");
const { optimizeRecommendationWithCpSat } = require("../src/prisma/services/planning/monthlyPlanRecommendationService");

(async () => {
  const backward = await solveBackwardMilestones({
    targetDate: "2026-09-30T08:00:00.000Z",
    tasks: [
      { id: "PR", duration: 1, unit: "DAY" },
      { id: "SUPPLIER", duration: 5, unit: "DAY" },
      { id: "QC", duration: 1, unit: "DAY" },
    ],
  });
  assert.equal(backward.engine, "OR_TOOLS_WASM_CP_SAT");
  assert.equal(backward.status, "OPTIMAL");
  assert(backward.tasks[0].startDate < backward.tasks[1].startDate);
  assert(backward.tasks[1].endDate <= backward.tasks[2].startDate);
  assert(backward.tasks[2].endDate <= new Date("2026-09-30T08:00:00.000Z"));

  const finite = await solveFiniteSchedule({
    horizonStart: "2026-09-01",
    horizonEnd: "2026-09-04",
    calendar: { "2026-09-01": "WORKING", "2026-09-02": "WORKING", "2026-09-03": "WORKING", "2026-09-04": "WORKING" },
    dailyWindows: [{ startMinute: 420, endMinute: 1020 }],
    tasks: [
      { id: "A", durationMinutes: 120, eligibleResourceIds: ["M1"], dueDate: "2026-09-04", required: true },
      { id: "B", durationMinutes: 60, eligibleResourceIds: ["M1"], predecessorIds: ["A"], predecessorGapMinutes: 120, dueDate: "2026-09-04", required: true },
    ],
  });
  const a = finite.tasks.find((task) => task.id === "A");
  const b = finite.tasks.find((task) => task.id === "B");
  assert(finite.feasible && a.endDate <= b.startDate);
  assert(b.startMinute >= a.endMinute + 120);

  const invalidBom = validateBomGraphStructure({ details: [
    { id: "A", parentDetailId: "B", partId: "P1", part: { id: "P1", partCode: "P1" }, qty: 1, uomCode: "PCS", mbomProcesses: [] },
    { id: "B", parentDetailId: "A", partId: "P2", part: { id: "P2", partCode: "P2" }, qty: 1, uomCode: "PCS", mbomProcesses: [] },
  ] });
  assert.equal(invalidBom.valid, false);
  assert(invalidBom.errors.some((issue) => issue.code === "BOM_CYCLE"));

  const daily = await scheduleDailyReleaseAllocations([
    { id: "D1", scheduleDate: "2026-09-01", partCode: "P1", machineId: "M1", eligibleMachineIds: ["M1"], plannedStartTime: "07:00", plannedEndTime: "08:00", predecessorAllocationIds: [] },
    { id: "D2", scheduleDate: "2026-09-01", partCode: "P2", machineId: "M1", eligibleMachineIds: ["M1"], plannedStartTime: "07:00", plannedEndTime: "08:00", predecessorAllocationIds: ["D1"] },
  ]);
  assert.equal(daily.solver.engine, "OR_TOOLS_WASM_CP_SAT");
  assert(daily.items[1].plannedStartTime >= "10:00");

  const monthly = await optimizeRecommendationWithCpSat({
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    jobs: [{ lineNumber: 1, routes: [{ lineNumber: 1, sequence: 10, mbomProcessId: "R1", processCode: "PRESS", outputPartCode: "FG1", routingMode: "INHOUSE", minutesPerUnit: 1, fgRequiredDate: "2026-09-20", resources: [{ id: "M1", machineId: "M1", workCenterId: "WC1", matrixRowKey: "MACHINE:M1", matrixChildKey: "PART:FG1", availableMinutesByDate: { "2026-09-18": 840, "2026-09-19": 840 } }] }] }],
  }, { summary: { overloadCellCount: 1 }, items: [{ itemType: "NEW_ALLOCATION", changeType: "ALLOCATE_REMAINING", lineNumber: 1, mbomProcessId: "R1", partCode: "FG1", processCode: "PRESS", proposedValue: { qty: 60, targetDate: "2026-09-18", targetMachineId: "M1", batchDurationMinutes: 60 }, trace: { fgRequiredDate: "2026-09-20" }, applyStatus: "PENDING" }] });
  assert.equal(monthly.solver.engine, "OR_TOOLS_WASM_CP_SAT");
  assert.equal(monthly.summary.overloadCellCount, 0);
  assert.equal(monthly.items[0].proposedValue.targetMachineId, "M1");

  console.log("Planning solver contracts passed: backward, finite capacity, BOM graph, monthly, daily.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
