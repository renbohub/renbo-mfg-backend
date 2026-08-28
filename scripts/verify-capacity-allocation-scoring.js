const assert = require("assert");
const {
  SCORING_MODEL,
  SCORING_WEIGHTS,
  VERSION,
  buildRecommendationValidationScope,
  buildMachineDiesOptions,
  candidateMachinesForLane,
  comparePlacementCandidates,
  cycleCapableMachines,
  effectiveCycleMinutes,
  findFeasibleSlotStarts,
  findPlacement,
  machineLaneKey,
  normalizeLineageIndexes,
  retainRankedCandidate,
  scorePlacementCandidate,
  shouldPinMachineLane,
  summarizeAllocationScoring,
  criticalRouteDurationMinutes,
  deliveryJitExecutionFloor,
  shouldScheduleLateVisibility,
  buildNextCampaignStartByPhase,
  shiftCapacityTransferQuantity,
} = require("../src/prisma/services/planning/capacityRecommendationService");

assert.strictEqual(
  Object.values(SCORING_WEIGHTS).reduce((sum, weight) => sum + weight, 0),
  100,
  "Weighted allocation score must remain normalized to 100",
);
const nextCampaignGate = buildNextCampaignStartByPhase(new Date("2026-08-01T00:00:00.000Z"), [
  { id: "later", deliveryPhaseId: "phase-7", scheduleDate: new Date("2026-09-02T00:00:00.000Z"), plannedStartTime: "08:00", plan: { planNumber: "MPP-202609-001", planMonth: new Date("2026-09-01T00:00:00.000Z") } },
  { id: "earlier", deliveryPhaseId: "phase-7", scheduleDate: new Date("2026-08-25T00:00:00.000Z"), plannedStartTime: "08:00", plan: { planNumber: "MPP-202608-002", planMonth: new Date("2026-08-01T00:00:00.000Z") } },
], new Date("2026-08-01T00:00:00.000Z"));
assert.strictEqual(nextCampaignGate.get("PHASE:phase-7").planNumber, "MPP-202609-001", "A later MPP must cap the JIT deadline of its predecessor campaign");
assert.match(VERSION, /V11-FG-REQUIRED-LATE-VISIBILITY/, "Algorithm version must identify visible late FG Required scheduling");
assert.strictEqual(shouldScheduleLateVisibility("VENDOR_LEAD_TIME_LATE"), true, "Vendor late harus tetap menghasilkan allocation untuk recovery PPIC");
assert.strictEqual(shouldScheduleLateVisibility("CAPACITY_BEFORE_DUE_UNAVAILABLE"), true, "Capacity late harus tetap terlihat sebagai allocation");
assert.strictEqual(shouldScheduleLateVisibility("MATERIAL_READY_AFTER_FG_DUE"), true, "Material late harus tetap terlihat sebagai allocation");
assert.strictEqual(shouldScheduleLateVisibility("ROUTING_MISSING"), false, "Routing missing tidak dapat dibuat menjadi allocation semu");
assert.strictEqual(effectiveCycleMinutes({ cycleTime: 121 }, {}, 100), 2.42, "Monthly runtime harus memakai CT x 1,2 walaupun efficiency master 100%");
assert.strictEqual(Number((effectiveCycleMinutes({ cycleTime: 121 }, {}, 100) * 192).toFixed(2)), 464.64, "Campaign WELD-1 192 PCS harus mempunyai load CT x qty x 1,2");
assert.strictEqual(Number(effectiveCycleMinutes({ cycleTime: 121 }, {}, 85).toFixed(6)), 2.847059,
  "Scheduler harus menggabungkan runtime allowance dan efficiency agar tidak menghasilkan overload tersembunyi");
assert.strictEqual(
  shiftCapacityTransferQuantity(
    17500,
    { ordered: [{ route: { routingMode: "INHOUSE", machineSpecificationCode: "ARC" }, detail: { qtyPlanned: 12000 } }] },
    17500,
    new Map([["ARC", [{ cycleTime: 20 }]]]),
    { shifts: [{ start: "08:00", end: "16:00" }], shiftCount: 1, efficiency: 85 },
  ),
  1020,
  "Transfer batch common/WIP harus memakai faktor FIFO 1:1 dan effective efficiency agar runtime aktual tetap muat di satu shift",
);

const jitGraph = {
  ordered: [{ route: { id: "paint" } }, { route: { id: "inspect" } }],
  predecessors: new Map([["paint", new Set()], ["inspect", new Set(["paint"])]]),
};
assert.strictEqual(
  criticalRouteDurationMinutes(jitGraph, (task) => task.route.id === "paint" ? 5 * 1440 : 120),
  7440,
  "Critical route duration must include the mandatory 120-minute successor gap",
);
assert.strictEqual(
  deliveryJitExecutionFloor({ due: 20 * 1440, executionFloor: 0, criticalDurationMinutes: 5 * 1440, safetyDays: 2 }),
  13 * 1440,
  "Vendor and downstream production must be pulled backward from delivery with an explicit safety buffer",
);

const baseCandidate = scorePlacementCandidate({
  candidate: { start: 400, end: 500, shift: "1", overtime: false },
  machineIntervals: [],
  window: { start: 0, end: 1000 },
  earliest: 0,
  due: 1000,
  cycleMinutes: 1,
  bestCycleMinutes: 1,
  partCode: "FG-001",
  processCode: "PRESS",
});
const scaledHorizonCandidate = scorePlacementCandidate({
  candidate: { start: 800, end: 1000, shift: "1", overtime: false },
  machineIntervals: [],
  window: { start: 0, end: 2000 },
  earliest: 0,
  due: 2000,
  cycleMinutes: 1,
  bestCycleMinutes: 1,
  partCode: "FG-001",
  processCode: "PRESS",
});
assert.strictEqual(baseCandidate.model, SCORING_MODEL);
assert.strictEqual(
  baseCandidate.breakdown.dueProtection,
  scaledHorizonCandidate.breakdown.dueProtection,
  "Due risk must use the available scheduling horizon instead of a fixed number of minutes",
);
assert.strictEqual(baseCandidate.score, scaledHorizonCandidate.score, "Proportionally equivalent candidates should have equivalent scores");
assert(Object.values(baseCandidate.breakdown).every(Number.isFinite), "UI-compatible breakdown must remain a numeric map");
assert(Math.abs(Object.values(baseCandidate.breakdown).reduce((sum, points) => sum + points, 0) - baseCandidate.score) < 0.1);

const constrainedDiesCandidate = scorePlacementCandidate({
  candidate: { start: 300, end: 360, shift: "2", overtime: false },
  machineIntervals: [],
  diesIntervals: [{ start: 0, end: 300 }],
  diesAssigned: true,
  window: { start: 0, end: 480 },
  earliest: 0,
  due: 480,
  cycleMinutes: 1.2,
  bestCycleMinutes: 1,
  partCode: "FG-001",
  processCode: "PRESS",
  routeMachineCount: 1,
  routeAlreadyOnMachine: false,
});
assert.strictEqual(constrainedDiesCandidate.context.diesLoadPercentAfterPlacement, 75);
assert.strictEqual(constrainedDiesCandidate.context.limitingResourceLoadPercent, 75);
assert.strictEqual(constrainedDiesCandidate.context.introducesAdditionalLane, true);
assert(constrainedDiesCandidate.factors.dependencySync.ratio < 1, "Dependency lag must be visible in the scoring evidence");

assert.deepStrictEqual(
  findFeasibleSlotStarts([{ start: 20, end: 40 }, { start: 60, end: 80 }], 0, 120, 20),
  [0, 40, 80],
  "Every feasible free gap in a resource window must become a scored candidate",
);

const periodStart = new Date("2026-08-10T00:00:00.000Z");
const periodEnd = new Date("2026-08-10T00:00:00.000Z");
const machines = [
  { id: "machine-b", machineCode: "MC-B", shift1Start: "00:00", shift1End: "08:00", tonnage: 100 },
  { id: "machine-a", machineCode: "MC-A", shift1Start: "00:00", shift1End: "08:00", tonnage: 100 },
];
const usage = new Map([
  ["machine-a", [{ start: 0, end: 60, partCode: "FG-001", processCode: "PRESS" }]],
  ["machine-b", []],
]);
const placementInput = {
  usage,
  earliest: 60,
  due: 480,
  duration: () => 60,
  mode: "NORMAL",
  periodStart,
  periodEnd,
  preset: { shiftCount: 1, includeSaturday: true, includeSunday: true },
  scoringContext: {
    bestCycleMinutes: 1,
    cycleByMachine: () => 1,
    partCode: "FG-001",
    processCode: "PRESS",
  },
};
const orderedPlacement = findPlacement({ ...placementInput, machines });
const reversedPlacement = findPlacement({ ...placementInput, machines: [...machines].reverse() });
assert.strictEqual(orderedPlacement.machine.id, "machine-a", "Setup continuity and lane stability should avoid an unnecessary new lane");
assert.strictEqual(reversedPlacement.machine.id, orderedPlacement.machine.id, "Candidate ranking must not depend on master-data input order");
assert(orderedPlacement.recommendationScoreBreakdown.audit.candidatesEvaluated >= 2);
assert.strictEqual(orderedPlacement.recommendationScoreBreakdown.audit.eligibleMachineCount, 2);
assert.deepStrictEqual(orderedPlacement.recommendationScoreBreakdown.audit.deterministicTieBreak.slice(0, 3), ["score_desc", "end_asc", "start_asc"]);

const diesPlacement = findPlacement({
  ...placementInput,
  machines: [machines[0]],
  usage: new Map([["machine-b", []]]),
  earliest: 0,
  diesCandidates: [
    { id: "dies-busy", diesCode: "D-BUSY", tonnage: 50 },
    { id: "dies-free", diesCode: "D-FREE", tonnage: 50 },
  ],
  diesUsage: new Map([
    ["dies-busy", [{ start: 0, end: 120 }]],
    ["dies-free", []],
  ]),
});
assert.strictEqual(diesPlacement.dies.id, "dies-free", "A free compatible die should outrank a queued die");
assert.strictEqual(diesPlacement.recommendationScoreBreakdown.audit.eligibleDiesCount, 2);
assert(diesPlacement.recommendationScoreBreakdown.audit.candidatesEvaluated >= 2);
assert.strictEqual(diesPlacement.recommendationScoreBreakdown.audit.candidateRetentionLimit, 4);
assert(diesPlacement.recommendationScoreBreakdown.audit.alternatives.length <= 3);

const tieCandidates = [
  { recommendationScore: 80, start: 0, end: 60, shift: "1", machine: { id: "b", machineCode: "MC-B" }, dies: null },
  { recommendationScore: 80, start: 0, end: 60, shift: "1", machine: { id: "a", machineCode: "MC-A" }, dies: null },
];
tieCandidates.sort(comparePlacementCandidates);
assert.strictEqual(tieCandidates[0].machine.id, "a", "Equal scores must resolve through a stable resource key");

const cycleByMachine = (machine) => machine.id === "machine-no-cycle" ? 0 : 2;
const mixedCycleMachines = [
  { id: "machine-no-cycle", machineCode: "MC-00", shift1Start: "00:00", shift1End: "08:00" },
  { id: "machine-valid-cycle", machineCode: "MC-10", shift1Start: "00:00", shift1End: "08:00" },
];
assert.deepStrictEqual(
  cycleCapableMachines(mixedCycleMachines, cycleByMachine).map((machine) => machine.id),
  ["machine-valid-cycle"],
  "A machine with missing cycle time must be removed before generic/FULL placement",
);
const noFallbackPlacement = findPlacement({
  ...placementInput,
  machines: mixedCycleMachines,
  usage: new Map(),
  earliest: 0,
  duration: (machine) => machine.id === "machine-no-cycle" ? 0 : 60,
  scoringContext: { ...placementInput.scoringContext, cycleByMachine },
});
assert.strictEqual(noFallbackPlacement.machine.id, "machine-valid-cycle", "Zero duration must not be coerced into a false one-minute operation");

assert.strictEqual(shouldPinMachineLane("NORMAL", { algorithm: { allowParallel: true } }), true);
assert.strictEqual(shouldPinMachineLane("PARALLEL", { algorithm: { allowParallel: true } }), false);
assert.strictEqual(shouldPinMachineLane("THREE_SHIFT", { algorithm: { allowParallel: false } }), true);
assert.deepStrictEqual(
  candidateMachinesForLane(machines, () => 1, "machine-b", true).map((machine) => machine.id),
  ["machine-b"],
  "A pinned non-parallel lane must stay on the selected machine across later batches/routes",
);

const routeA = { id: "route-a", machineSpecificationCode: "SPEC-SHARED" };
const routeB = { id: "route-b", machineSpecificationCode: "SPEC-SHARED" };
assert.notStrictEqual(machineLaneKey(routeA), machineLaneKey(routeB), "Distinct logical operations sharing a specification must not share a hard lane pin");
assert.strictEqual(machineLaneKey(routeA), machineLaneKey({ ...routeA }), "Every split chunk/batch of the same logical route must resolve the same lane key");

const mixedResourceRoute = { id: "route-mixed", process: { processCode: "GENERIC", processName: "Generic operation" } };
const mixedResourceMachines = [
  { id: "press-machine", machineCode: "MC-PRESS", machineType: "PRESS", tonnage: 100, shift1Start: "00:00", shift1End: "08:00" },
  { id: "nonpress-machine", machineCode: "MC-LASER", machineType: "LASER", tonnage: 0, shift1Start: "00:00", shift1End: "08:00" },
];
const noDiesResources = buildMachineDiesOptions(mixedResourceRoute, mixedResourceMachines, () => [], { blockingEnabled: true });
assert.deepStrictEqual(noDiesResources.machines.map((machine) => machine.id), ["nonpress-machine"], "Missing Dies must exclude only the Press candidate, not a non-Press machine sharing its specification");
assert.deepStrictEqual(noDiesResources.diesCandidatesByMachine.get("nonpress-machine"), [null]);
assert.deepStrictEqual(noDiesResources.excludedPressMachineIds, ["press-machine"]);

const compatibleDies = { id: "dies-compatible", diesCode: "D-100", tonnage: 80 };
const mixedDiesResources = buildMachineDiesOptions(mixedResourceRoute, [...mixedResourceMachines].reverse(), () => [compatibleDies], { blockingEnabled: true });
assert.deepStrictEqual(new Set(mixedDiesResources.machines.map((machine) => machine.id)), new Set(["press-machine", "nonpress-machine"]));
assert.deepStrictEqual(mixedDiesResources.diesCandidatesByMachine.get("press-machine"), [compatibleDies]);
assert.deepStrictEqual(mixedDiesResources.diesCandidatesByMachine.get("nonpress-machine"), [null], "Non-Press candidates must remain Dies-free even when another candidate requires Dies");

const incompatibleDiesResources = buildMachineDiesOptions(mixedResourceRoute, mixedResourceMachines, () => [{ id: "dies-too-heavy", tonnage: 150 }], { blockingEnabled: true });
assert.deepStrictEqual(incompatibleDiesResources.machines.map((machine) => machine.id), ["nonpress-machine"], "Press candidates must have a tonnage-compatible active Dies when blocking is enabled");

const mixedDiesPlacement = findPlacement({
  ...placementInput,
  machines: mixedDiesResources.machines,
  usage: new Map(mixedResourceMachines.map((machine) => [machine.id, []])),
  diesCandidatesByMachine: mixedDiesResources.diesCandidatesByMachine,
  diesUsage: new Map([[compatibleDies.id, [{ start: 0, end: 300 }]]]),
  earliest: 0,
});
assert.strictEqual(mixedDiesPlacement.machine.id, "nonpress-machine");
assert.strictEqual(mixedDiesPlacement.dies, null, "Per-machine resource options must allow a non-Press winner without assigning a Dies");
assert.strictEqual(mixedDiesPlacement.recommendationScoreBreakdown.audit.eligibleDiesCount, 1);

const cachedPlacement = findPlacement({ ...placementInput, machines });
const uncachedPlacement = findPlacement({
  ...placementInput,
  machines,
  scoringContext: { ...placementInput.scoringContext, disableIntervalEvidenceCache: true },
});
assert.deepStrictEqual(
  {
    machineId: cachedPlacement.machine.id,
    diesId: cachedPlacement.dies?.id || null,
    start: cachedPlacement.start,
    end: cachedPlacement.end,
    score: cachedPlacement.recommendationScore,
    scoreAudit: cachedPlacement.recommendationScoreBreakdown,
  },
  {
    machineId: uncachedPlacement.machine.id,
    diesId: uncachedPlacement.dies?.id || null,
    start: uncachedPlacement.start,
    end: uncachedPlacement.end,
    score: uncachedPlacement.recommendationScore,
    scoreAudit: uncachedPlacement.recommendationScoreBreakdown,
  },
  "Pre-sorted interval indexes and binary previous/next lookup must preserve the exact winner and audit evidence",
);

const allRankedCandidates = Array.from({ length: 20 }, (_, index) => ({
  recommendationScore: 60 + (index % 7),
  start: index * 5,
  end: index * 5 + 30,
  shift: "1",
  machine: { id: `machine-${String(index).padStart(2, "0")}`, machineCode: `MC-${String(index).padStart(2, "0")}` },
  dies: null,
}));
const expectedTopCandidates = [...allRankedCandidates].sort(comparePlacementCandidates).slice(0, 4).map((candidate) => candidate.machine.id);
const retainedCandidates = [];
for (const candidate of [...allRankedCandidates].reverse()) retainRankedCandidate(retainedCandidates, candidate, 4);
assert.deepStrictEqual(
  retainedCandidates.map((candidate) => candidate.machine.id),
  expectedTopCandidates,
  "Bounded streaming ranking must retain the exact same winner and top alternatives as a full sort",
);

assert.throws(
  () => findPlacement({
    ...placementInput,
    machines: [machines[0]],
    usage: new Map([["machine-b", [{ start: 20, end: 40 }, { start: 60, end: 80 }]]]),
    earliest: 0,
    due: 120,
    duration: () => 20,
    preset: { ...placementInput.preset, algorithm: { candidateBudget: 2 } },
  }),
  (error) => error.code === "CAPACITY_CANDIDATE_BUDGET_EXCEEDED"
    && error.statusCode === 409
    && error.details.candidatesEvaluated === 3
    && error.details.guardMode === "FAIL_EXPLICITLY_NO_PARTIAL_RANKING",
  "Candidate budget overflow must fail explicitly instead of returning a partially ranked recommendation",
);

assert.deepStrictEqual(
  normalizeLineageIndexes([3, 1, 3, null, -1, 2, 8], 5),
  [1, 2, 3],
  "Split-batch predecessor lineage must be unique, ordered, and limited to already known drafts",
);

const scoringSummary = summarizeAllocationScoring([
  { recommendationScore: 92, recommendationScoreBreakdown: { audit: { candidatesEvaluated: 4, resourceWindowsEvaluated: 8 } } },
  { recommendationScore: 70, recommendationScoreBreakdown: { audit: { candidatesEvaluated: 3, resourceWindowsEvaluated: 6 } } },
  { recommendationScore: null },
]);
assert.deepStrictEqual(
  { scored: scoringSummary.scoredAllocationCount, rules: scoringSummary.ruleBasedAllocationCount, candidates: scoringSummary.candidatesEvaluated },
  { scored: 2, rules: 1, candidates: 7 },
);
assert.deepStrictEqual(
  buildRecommendationValidationScope({ planNumber: "MPP-1", planningMode: "SIMULATION", scenarioKey: "scenario-a", presetId: "preset-a", persisted: true }),
  { planNumber: "MPP-1", planningMode: "SIMULATION", scenarioKey: "scenario-a", presetId: "preset-a", allocationSource: "AUTO_RECOMMENDATION", recommendationVersion: VERSION, persisted: true },
  "Controller must receive an explicit scope for post-persist authoritative readiness validation",
);

console.log("Advanced capacity allocation scoring checks passed: 43/43 cases");
