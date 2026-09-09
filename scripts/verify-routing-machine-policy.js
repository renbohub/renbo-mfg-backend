"use strict";
const assert = require("node:assert/strict");
const { resolveRoutingMachinePolicy: resolve } = require("../src/prisma/services/planning/routingMachinePolicy");
const machines = [1, 2, 3, 4].map((n) => ({ id: `P${n}`, machineName: `P-${n}`, status: "Active", machineSpecificationCode: "PRESS", tonnage: 110 }));
const dies = [1, 2].map((n) => ({ id: `D${n}`, diesCode: `D-${n}`, status: "Active", tonnage: 100, diesParts: [{ partId: "child", isActive: true }] }));
const route = { id: "route", machineId: "P1", machineSpecificationCode: "PRESS", cycleTime: 60, mbomDetail: { partId: "child" } };
assert.deepEqual(resolve(route, machines).automaticMachineIds, [], "Legacy representative must not become approved primary");
const single = { ...route, machinePlanningPolicy: { primaryMachineId: "P2", mode: "SINGLE", resources: [{ machineId: "P1", diesId: "D1" }, { machineId: "P2", cycleTimeSeconds: 120, diesId: "D1" }] } };
assert.deepEqual(resolve(single, machines, dies).automaticMachineIds, ["P2"], "Qualified backups must not be used automatically");
assert.ok(resolve(single, machines.filter((m) => m.id !== "P2"), dies).errors.length, "Offline primary cannot silently fall back");
const parallel = { ...route, machinePlanningPolicy: { primaryMachineId: "P1", mode: "PARALLEL", maxParallelMachines: 2, approvalReference: "TRIAL-01", resources: [{ machineId: "P1", diesId: "D1", cycleTimeSeconds: 60, setupMinutes: 10 }, { machineId: "P2", diesId: "D2", cycleTimeSeconds: 120, setupMinutes: 20 }] } };
assert.deepEqual(resolve(parallel, machines, dies).automaticMachineIds, ["P1", "P2"]);
const shared = structuredClone(parallel); shared.machinePlanningPolicy.resources[1].diesId = "D1";
assert.ok(resolve(shared, machines, dies).errors.some((e) => e.includes("berbeda")));
assert.ok(resolve(parallel, machines, dies.slice(0, 1)).errors.length);
const exceeded = structuredClone(parallel); exceeded.machinePlanningPolicy.resources.push({ machineId: "P3", diesId: "D3" });
assert.ok(resolve(exceeded, machines, dies).errors.some((e) => e.includes("batas")));
const noCycle = { ...route, cycleTime: 0 }; assert.ok(resolve(noCycle, machines.slice(0, 1)).errors.length);
const { adaptCapacitySnapshot } = require("../src/prisma/services/planning/monthlyPlanRecommendationService");
const { automaticCandidates, effectiveCycleMinutes, buildMachineDiesOptions } = require("../src/prisma/services/planning/capacityRecommendationService");
const resolved = resolve(single, machines, dies);
const resolvedRoute = { ...single, resolvedMachinePolicy: resolved };
assert.deepEqual(automaticCandidates(resolvedRoute, machines).map((m) => m.id), ["P2"]);
assert.equal(effectiveCycleMinutes(resolvedRoute, machines[1], 100), 2.4, "MRP allocator uses primary-specific cycle and runtime allowance");
const mappedTools = buildMachineDiesOptions(resolvedRoute, [machines[1]], () => dies);
assert.deepEqual(mappedTools.diesCandidatesByMachine.get("P2").map((d) => d.id), ["D1"]);
const input = adaptCapacitySnapshot({ plan: { planNumber: "TEST", periodStart: "2026-09-01", periodEnd: "2026-09-30" }, snapshot: {
  machines: machines.map((m) => ({ ...m, cells: {} })), catalogs: { dies },
  manualAllocationCatalog: [{ planNumber: "TEST", lineNumber: 1, mbomProcessId: "route", processCode: "PRG", partCode: "child", remainingQty: 100, allowedMachineIds: ["P1", "P2", "P3", "P4"], cycleMinutesByMachine: { P1: 1, P2: 2.4 }, machinePlanningPolicy: resolved }],
} });
assert.deepEqual(input.jobs[0].routes[0].resources.map((m) => m.machineId), ["P2"]);
assert.equal(input.jobs[0].routes[0].minutesPerUnit, 2.4, "Recommendation must not use the fastest alternative's cycle");

(async () => {
  const { solveFiniteSchedule } = await import("../src/prisma/services/planning/solver/planningCpSatSolver.mjs");
  const tasks = [1, 2, 3, 4].map((i) => ({ id: `line-${i}`, assignmentGroupId: "child:route", eligibleResourceIds: machines.map((m) => m.id), durationMinutes: 100, required: true, dueMinute: 840, backwardWeight: 10 }));
  const grouped = await solveFiniteSchedule({ horizonMinutes: 840, tasks, scheduleDirection: "BACKWARD" });
  assert.ok(grouped.feasible); assert.equal(new Set(grouped.tasks.map((t) => t.resourceId)).size, 1, "Delivery lines share one campaign machine");
  const overload = await solveFiniteSchedule({ horizonMinutes: 200, tasks });
  assert.equal(overload.feasible, false, "Overload must not unlock parallelism");
  const conflictingCandidates = await solveFiniteSchedule({ horizonMinutes: 840, tasks: tasks.slice(0, 2).map((t, i) => ({ ...t, eligibleResourceIds: [machines[i].id] })) });
  assert.equal(conflictingCandidates.feasible, false, "Disjoint candidates cannot bypass campaign lock");
  const toolTasks = [1, 2].map((i) => ({ id: `tool-${i}`, eligibleResourceIds: [`P${i}`], durationMinutes: 100, requiredResourcesByResourceId: { [`P${i}`]: ["D1"] }, required: true }));
  const sharedTool = await solveFiniteSchedule({ horizonMinutes: 100, tasks: toolTasks });
  assert.equal(sharedTool.feasible, false, "Physical tool is exclusive across machines");
  toolTasks[1].requiredResourcesByResourceId.P2 = ["D2"];
  assert.ok((await solveFiniteSchedule({ horizonMinutes: 100, tasks: toolTasks })).feasible, "Two tools allow two machines concurrently");
  const timing = await solveFiniteSchedule({ horizonMinutes: 200, tasks: [{ id: "different-cycle", eligibleResourceIds: ["P2"], durationMinutes: 1, durationMinutesByResourceId: { P1: 30, P2: 170 }, required: true }] });
  assert.equal(timing.tasks[0].durationMinutes, 170, "Use selected-machine duration including setup");
  console.log("Routing machine policy: primary, backups, parallel approval, tooling, campaign and selected-machine timing passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => require("../src/prisma").disconnectDatabase());
