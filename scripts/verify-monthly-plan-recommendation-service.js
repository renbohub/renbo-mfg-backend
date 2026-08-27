"use strict";

const assert = require("assert");
const {
  RULE_VERSION,
  adaptCapacitySnapshot,
  createRecommendationService,
  scenarioStatus,
  withRecommendationApplyLock,
} = require("../src/prisma/services/planning/monthlyPlanRecommendationService");

const mappedInput = adaptCapacitySnapshot({
  plan: {
    planNumber: "MPP-202609-001",
    periodStart: new Date("2026-09-01T00:00:00.000Z"),
    periodEnd: new Date("2026-09-30T00:00:00.000Z"),
    updatedAt: new Date("2026-08-24T10:00:00.000Z"),
  },
  snapshot: {
    parameters: { shiftHours: 7, shiftsPerDay: 2 },
    machines: [{ id: "machine-1", machineCode: "M-070", workCenterId: "wc-insp", matrixRowKey: "WC:wc-insp", cells: {} }],
    catalogs: { vendors: [{ id: "vendor-paint", vendorCode: "PAINT" }] },
    manualAllocationCatalog: [
      { planNumber: "MPP-202609-001", lineNumber: 1, sequence: 1, mbomProcessId: "route-insp", processCode: "INSP-PACK", partCode: "C002-C004-010", remainingQty: 10, requiredDate: "2026-09-05", allowedMachineIds: ["machine-1"], cycleMinutesByMachine: { "machine-1": 1 } },
      { planNumber: "MPP-202609-001", lineNumber: 2, sequence: 1, mbomProcessId: "route-paint", processCode: "PAINT", partCode: "C002-C004-020", remainingQty: 10, requiredDate: "2026-09-05", routingMode: "VENDOR", vendorId: "vendor-paint" },
    ],
  },
});
assert.strictEqual(mappedInput.jobs[0].routes[0].resources[0].matrixRowKey, "WC:wc-insp");
assert.strictEqual(mappedInput.jobs[0].routes[0].resources[0].matrixChildKey, "PART:C002-C004-010");
assert.strictEqual(mappedInput.jobs[1].routes[0].resources[0].matrixRowKey, "VENDOR:vendor-paint");
assert.strictEqual(mappedInput.jobs[1].routes[0].resources[0].matrixChildKey, "PART:C002-C004-020:PAINT");
assert.deepStrictEqual(
  [mappedInput.minimumBatchMinutes, mappedInput.maximumBatchMinutes, mappedInput.batchPolicy],
  [60, 840, "MINIMUM_ONE_HOUR_MAXIMUM_TWO_SHIFTS_SOURCE_LIMITED"],
  "snapshot dua shift x tujuh jam harus menjadi batas batch harian 840 menit",
);

const mappedInputWithExistingAllocation = adaptCapacitySnapshot({
  plan: {
    planNumber: "MPP-202609-001",
    periodStart: new Date("2026-09-01T00:00:00.000Z"),
    periodEnd: new Date("2026-09-30T00:00:00.000Z"),
    updatedAt: new Date("2026-08-24T10:00:00.000Z"),
  },
  snapshot: {
    machines: [],
    catalogs: { vendors: [{ id: "vendor-paint", vendorCode: "PAINT" }] },
    manualAllocationCatalog: [
      { planNumber: "MPP-202609-001", lineNumber: 122, sequence: 1, mbomProcessId: "route-paint", processCode: "PAINT", partCode: "C002-C004-020", remainingQty: 31, requiredDate: "2026-09-08", routingMode: "VENDOR", vendorId: "vendor-paint" },
    ],
    vendorAssignments: [
      { allocationId: "existing-paint-9", lineNumber: 122, mbomProcessId: "route-paint", partCode: "C002-C004-020", processCode: "PAINT", sendDate: "2026-09-01", returnDate: "2026-09-03", qty: 9, vendorId: "vendor-paint" },
    ],
  },
});
assert.strictEqual(mappedInputWithExistingAllocation.jobs[0].qty, 40,
  "gross recommendation requirement harus mengembalikan existing allocation ke remaining agar allocation 9 tidak dikurangkan dua kali");
assert.strictEqual(mappedInputWithExistingAllocation.existingAllocations[0].plannedQty, 9,
  "existing allocation tetap dikirim terpisah untuk dipertahankan oleh recommendation engine");

function recorder(implementation) {
  const fn = async (...args) => {
    fn.calls.push(args);
    return implementation(...args);
  };
  fn.calls = [];
  return fn;
}

function createFakePrisma() {
  const plan = {
    id: "plan-1",
    planNumber: "MPP-202609-001",
    periodStart: new Date("2026-09-01T00:00:00.000Z"),
    periodEnd: new Date("2026-09-30T00:00:00.000Z"),
    updatedAt: new Date("2026-08-24T10:00:00.000Z"),
    isDeleted: false,
  };
  const scenarios = [];
  const items = [];
  const editorSessions = [];
  const editorChanges = [];
  const officialAllocations = [
    {
      id: "official-1",
      planId: plan.id,
      lineNumber: 99,
      mbomProcessId: "existing-route",
      plannedQty: 10,
      scheduleDate: new Date("2026-09-01T00:00:00.000Z"),
      status: "Draft",
      isDeleted: false,
    },
  ];
  let scenarioSequence = 1;
  const includeItems = (scenario) =>
    scenario
      ? {
          ...scenario,
          plan: { ...plan },
          items: items
            .filter((item) => item.scenarioId === scenario.id)
            .sort((left, right) => left.sequence - right.sequence),
        }
      : null;
  const matchesStatus = (scenario, status) =>
    !status || !status.in || status.in.includes(scenario.status);
  const prisma = {
    monthlyProductionPlan: {
      findFirst: recorder(async ({ where }) =>
        ((where.planNumber && where.planNumber === plan.planNumber) ||
          (where.id && where.id === plan.id)) &&
        !plan.isDeleted
          ? { ...plan }
          : null,
      ),
    },
    monthlyPlanRecommendationScenario: {
      findFirst: recorder(async ({ where }) => {
        const found = scenarios.find(
          (scenario) =>
            scenario.planId === where.planId &&
            new Date(scenario.basePlanUpdatedAt).getTime() ===
              new Date(where.basePlanUpdatedAt).getTime() &&
            scenario.ruleVersion === where.ruleVersion &&
            matchesStatus(scenario, where.status),
        );
        return includeItems(found);
      }),
      findUnique: recorder(async ({ where }) =>
        includeItems(scenarios.find((scenario) => scenario.id === where.id)),
      ),
      create: recorder(async ({ data }) => {
        const scenario = {
          id: `scenario-${scenarioSequence++}`,
          ...data,
          summary: null,
          errorMessage: null,
          createdAt: new Date("2026-08-24T10:05:00.000Z"),
          updatedAt: new Date("2026-08-24T10:05:00.000Z"),
        };
        scenarios.push(scenario);
        return { ...scenario };
      }),
      update: recorder(async ({ where, data }) => {
        const scenario = scenarios.find((candidate) => candidate.id === where.id);
        Object.assign(scenario, data, {
          updatedAt: new Date("2026-08-24T10:06:00.000Z"),
        });
        return { ...scenario };
      }),
    },
    monthlyPlanRecommendationItem: {
      createMany: recorder(async ({ data }) => {
        data.forEach((row) =>
          items.push({ id: `item-${items.length + 1}`, ...row }),
        );
        return { count: data.length };
      }),
      updateMany: recorder(async ({ where, data }) => {
        const ids = new Set(where.id?.in || []);
        let count = 0;
        items.forEach((item) => {
          if (
            (!where.scenarioId || item.scenarioId === where.scenarioId) &&
            (!ids.size || ids.has(item.id))
          ) {
            Object.assign(item, data);
            count += 1;
          }
        });
        return { count };
      }),
      count: recorder(async ({ where }) =>
        items.filter(
          (item) =>
            item.scenarioId === where.scenarioId &&
            (!where.applyStatus || item.applyStatus === where.applyStatus) &&
            (where.changeType?.not !== null || item.changeType != null),
        ).length,
      ),
    },
    productionPlanAllocation: {
      create: recorder(async () => {
        throw new Error("official allocation must not be created during generation");
      }),
      update: recorder(async () => {
        throw new Error("official allocation must not be updated during generation");
      }),
      findMany: recorder(async () => officialAllocations.map((row) => ({ ...row }))),
    },
    capacityEditSession: {
      findFirst: recorder(async ({ where }) => {
        const session = editorSessions.find((candidate) =>
          where.id
            ? candidate.id === where.id && candidate.status === where.status
            : candidate.planId === where.planId &&
              candidate.scope === where.scope &&
              candidate.status === where.status &&
              candidate.createdBy === where.createdBy,
        );
        return session ? { ...session, plan: { ...plan } } : null;
      }),
      create: recorder(async ({ data }) => {
        const session = { id: `editor-${editorSessions.length + 1}`, ...data };
        editorSessions.push(session);
        return { ...session };
      }),
      update: recorder(async ({ where, data }) => {
        const session = editorSessions.find((candidate) => candidate.id === where.id);
        Object.assign(session, data);
        return { ...session };
      }),
    },
    capacityEditChange: {
      count: recorder(async ({ where }) =>
        editorChanges.filter((change) => change.sessionId === where.sessionId).length,
      ),
      findFirst: recorder(async ({ where }) => editorChanges
        .filter((change) => change.sessionId === where.sessionId)
        .sort((left, right) => right.sequence - left.sequence)[0] || null),
      findMany: recorder(async ({ where }) =>
        editorChanges.filter((change) => change.sessionId === where.sessionId).map((change) => ({ ...change })),
      ),
      create: recorder(async ({ data }) => {
        const change = { id: `editor-change-${editorChanges.length + 1}`, ...data };
        editorChanges.push(change);
        return { ...change };
      }),
      deleteMany: recorder(async ({ where }) => {
        const ids = new Set(where.id?.in || []);
        let deleted = 0;
        for (let index = editorChanges.length - 1; index >= 0; index -= 1) {
          if (!ids.has(editorChanges[index].id)) continue;
          editorChanges.splice(index, 1);
          deleted += 1;
        }
        return { count: deleted };
      }),
    },
    $transaction: async (operations) =>
      typeof operations === "function"
        ? operations(prisma)
        : Promise.all(operations),
    _state: {
      plan,
      scenarios,
      items,
      editorSessions,
      editorChanges,
      officialAllocations,
    },
  };
  return prisma;
}

const normalizedInput = {
  periodStart: "2026-09-01",
  periodEnd: "2026-09-30",
  openingStock: {},
  receipts: [],
  consumptions: [],
  existingAllocations: [],
  jobs: [
    {
      lineNumber: 1,
      qty: 120,
      priorityScore: 100,
      fgRequiredDate: "2026-09-05",
      routes: [
        {
          lineNumber: 1,
          sequence: 1,
          mbomProcessId: "route-insp",
          processCode: "INSP-PACK",
          outputPartCode: "FG-A",
          inputPartCode: null,
          minutesPerUnit: 1,
          leadDays: 1,
          routingMode: "INHOUSE",
          resources: [
            {
              id: "machine-1",
              machineId: "machine-1",
              machineCode: "M-070",
              workCenterId: "wc-insp",
              matrixRowKey: "wc:insp",
              matrixChildKey: "wc:insp:route-insp",
              availableMinutes: 60,
            },
          ],
        },
      ],
    },
    {
      lineNumber: 2,
      qty: 40,
      priorityScore: 90,
      fgRequiredDate: "2026-09-06",
      routes: [
        {
          lineNumber: 2,
          sequence: 1,
          mbomProcessId: "route-weld",
          processCode: "WELD-1",
          outputPartCode: "WIP-WELD",
          inputPartCode: null,
          minutesPerUnit: 0.5,
          leadDays: 1,
          routingMode: "INHOUSE",
          resources: [
            {
              id: "machine-2",
              machineId: "machine-2",
              machineCode: "M-050",
              workCenterId: "wc-weld",
              matrixRowKey: "wc:weld",
              matrixChildKey: "wc:weld:route-weld",
              availableMinutes: 60,
            },
          ],
        },
      ],
    },
  ],
  auditSnapshot: {
    planNumber: "MPP-202609-001",
    sourceRevision: "capacity-snapshot-1",
  },
};

(async () => {
  const lockOrder = [];
  await Promise.all([
    withRecommendationApplyLock("plan-lock-test", async () => {
      lockOrder.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 15));
      lockOrder.push("first-end");
    }),
    withRecommendationApplyLock("plan-lock-test", async () => {
      lockOrder.push("second-start");
      lockOrder.push("second-end");
    }),
  ]);
  assert.deepStrictEqual(lockOrder, ["first-start", "first-end", "second-start", "second-end"],
    "dua Apply recommendation pada plan yang sama harus diserialkan");

  assert.strictEqual(scenarioStatus({ materialQueueQty: 1, overloadCellCount: 2 }), "MATERIAL_QUEUE");
  assert.strictEqual(scenarioStatus({ materialQueueQty: 0, overloadCellCount: 2 }), "READY_WITH_OVERLOAD");
  assert.strictEqual(scenarioStatus({ materialQueueQty: 0, overloadCellCount: 0 }), "READY");

  const prisma = createFakePrisma();
  const service = createRecommendationService({
    buildSnapshot: async () => ({ recommendationInput: normalizedInput }),
  });
  const scenario = await service.generateRecommendationScenario(prisma, {
    planNumber: "MPP-202609-001",
    actor: "ppic",
  });
  assert.strictEqual(scenario.status, "READY_WITH_OVERLOAD");
  assert.strictEqual(scenario.ruleVersion, RULE_VERSION);
  assert.deepStrictEqual(scenario.inputSnapshot, normalizedInput.auditSnapshot);
  assert.strictEqual(
    scenario.items.length,
    3,
    "two allocations and their overload trace must be persisted",
  );
  assert.strictEqual(
    prisma.productionPlanAllocation.create.calls.length,
    0,
    "generation must not create official allocations",
  );
  assert.strictEqual(
    prisma.productionPlanAllocation.update.calls.length,
    0,
    "generation must not edit official allocations",
  );

  const repeated = await service.generateRecommendationScenario(prisma, {
    planNumber: "MPP-202609-001",
    actor: "ppic",
  });
  assert.strictEqual(
    repeated.id,
    scenario.id,
    "the same plan version must reuse its active scenario",
  );
  assert.strictEqual(prisma.monthlyPlanRecommendationScenario.create.calls.length, 1);

  const disabledAiPrisma = createFakePrisma();
  disabledAiPrisma.aiModelProfile = {
    findFirst: recorder(async () => ({
      profileCode: "QWEN3-1.7B-Q4",
      promptCompatibilityVersion: "1",
      runtimeConfig: { recommendationTimeoutMs: 90000 },
    })),
  };
  let disabledAiCalls = 0;
  const disabledAiService = createRecommendationService({
    env: { AI_ASSISTANT_ENABLED: "false" },
    buildSnapshot: async () => ({ recommendationInput: normalizedInput }),
    generateAiActions: async () => {
      disabledAiCalls += 1;
      throw new Error("runtime AI tidak boleh dinyalakan");
    },
  });
  const disabledAiScenario = await disabledAiService.generateAiRecommendationScenario(disabledAiPrisma, {
    planNumber: "MPP-202609-001",
    actor: "ppic",
  });
  assert.strictEqual(disabledAiCalls, 0,
    "Auto Allocation tidak boleh menyalakan Qwen ketika AI_ASSISTANT_ENABLED=false");
  assert.strictEqual(disabledAiScenario.generationSource, "RULE_BASED_FALLBACK");
  assert.strictEqual(disabledAiScenario.aiValidationSummary.fallbackReason, "FEATURE_DISABLED");

  const changeItems = scenario.items.filter((item) => item.changeType);
  assert.deepStrictEqual(
    service.selectItems(scenario.items, {
      mode: "WORK_CENTER",
      workCenterIds: ["wc-weld"],
    }).map((item) => item.id),
    [changeItems.find((item) => item.workCenterId === "wc-weld").id],
    "Work Center apply must not stage proposals from another center",
  );
  const existingScopeFixture = [
    { id: "move-existing", changeType: "MOVE_ALLOCATION", sourceAllocationId: "allocation-1", applyStatus: "PENDING", proposedValue: { qty: 40 } },
    { id: "allocate-new", changeType: "ALLOCATE_REMAINING", sourceAllocationId: null, applyStatus: "PENDING", proposedValue: { qty: 20 } },
  ];
  assert.deepStrictEqual(
    service.selectItems(existingScopeFixture, { mode: "EXISTING_TASKS" }).map((item) => item.id),
    ["move-existing"],
    "existing-task scope must never stage a new remaining allocation",
  );
  assert.deepStrictEqual(
    service.buildApplyReadiness(
      {
        summary: { fgCoverageReady: true, remainingAllocationQty: 10 },
        items: existingScopeFixture,
      },
      [existingScopeFixture[0]],
      "EXISTING_TASKS",
    ),
    {
      scope: "EXISTING_TASKS",
      fgCovered: false,
      remainingAllocationQty: 30,
      ready: false,
    },
    "backend apply result must keep FG/remain gates blocked when new tasks were excluded",
  );
  assert.doesNotThrow(
    () => service.assertRecommendationSourceLimits(existingScopeFixture, [
      { id: "allocation-1", plannedQty: 40 },
    ]),
    "a recommendation may consume its source exactly once up to the available quantity",
  );
  assert.throws(
    () => service.assertRecommendationSourceLimits([
      { ...existingScopeFixture[0], proposedValue: { qty: 40.01 } },
    ], [{ id: "allocation-1", plannedQty: 40 }]),
    /melebihi source allocation/i,
    "the apply boundary must reject a recommendation that exceeds its source allocation",
  );

  const partial = await service.applyRecommendationScenario(prisma, {
    scenarioId: scenario.id,
    actor: "ppic",
    selection: { mode: "ITEMS", itemIds: [changeItems[0].id] },
  });
  assert.strictEqual(partial.session.status, "OPEN");
  assert.strictEqual(partial.stagedChanges.length, 1);
  assert.strictEqual(partial.scenario.status, "PARTIALLY_APPLIED");
  assert.strictEqual(
    partial.stagedChanges[0].afterValue.targetRowKey,
    changeItems[0].proposedValue.targetRowKey,
    "Capacity Editor draft must retain the recommendation target Work Center row",
  );
  assert.strictEqual(
    partial.stagedChanges[0].afterValue.targetChildKey,
    changeItems[0].proposedValue.targetChildKey,
    "Capacity Editor draft must retain the recommendation target route row",
  );
  assert.strictEqual(prisma.productionPlanAllocation.update.calls.length, 0);
  assert.strictEqual(
    prisma._state.officialAllocations.length,
    1,
    "partial apply must only stage into Capacity Editor",
  );

  const applied = await service.applyRecommendationScenario(prisma, {
    scenarioId: scenario.id,
    actor: "ppic",
    selection: { mode: "ALL" },
  });
  assert.strictEqual(applied.scenario.status, "APPLIED");
  assert.strictEqual(applied.stagedChanges.length, 1);
  assert.deepStrictEqual(
    prisma._state.editorChanges.map((change) => change.changeType).sort(),
    ["ALLOCATE_REMAINING", "ALLOCATE_REMAINING"],
  );
  assert.strictEqual(
    prisma._state.officialAllocations.length,
    1,
    "full recommendation apply still waits for Capacity Editor Save Changes",
  );

  const replacementScenario = await service.generateRecommendationScenario(prisma, {
    planNumber: "MPP-202609-001",
    actor: "ppic",
  });
  await service.applyRecommendationScenario(prisma, {
    scenarioId: replacementScenario.id,
    actor: "ppic",
    selection: { mode: "ALL" },
  });
  assert.ok(prisma._state.editorChanges.length > 0,
    "replacement recommendation harus tetap mempunyai staged change");
  assert.ok(prisma._state.editorChanges.every((change) => change.afterValue.recommendationScenarioId === replacementScenario.id),
    "recommendation baru harus mengganti staged recommendation scenario lama agar commit tidak menggandakan allocation");

  const stalePrisma = createFakePrisma();
  const staleService = createRecommendationService({
    buildSnapshot: async () => ({ recommendationInput: normalizedInput }),
  });
  const staleScenario = await staleService.generateRecommendationScenario(stalePrisma, {
    planNumber: "MPP-202609-001",
    actor: "ppic",
  });
  stalePrisma._state.plan.updatedAt = new Date("2026-08-24T11:00:00.000Z");
  await assert.rejects(
    () =>
      staleService.applyRecommendationScenario(stalePrisma, {
        scenarioId: staleScenario.id,
        actor: "ppic",
        selection: { mode: "ALL" },
      }),
    (error) => error.statusCode === 409 && /berubah/i.test(error.message),
    "a scenario calculated from a stale plan version must be rejected",
  );

  const discardPrisma = createFakePrisma();
  const discardService = createRecommendationService({
    buildSnapshot: async () => ({ recommendationInput: normalizedInput }),
  });
  const discardScenario = await discardService.generateRecommendationScenario(
    discardPrisma,
    { planNumber: "MPP-202609-001", actor: "ppic" },
  );
  const discarded = await discardService.discardRecommendationScenario(
    discardPrisma,
    { scenarioId: discardScenario.id, actor: "ppic" },
  );
  assert.strictEqual(discarded.status, "DISCARDED");
  assert.strictEqual(discarded.discardedBy, "ppic");

  const failingPrisma = createFakePrisma();
  const failingService = createRecommendationService({
    buildSnapshot: async () => {
      throw new Error("snapshot unavailable");
    },
  });
  await assert.rejects(
    () =>
      failingService.generateRecommendationScenario(failingPrisma, {
        planNumber: "MPP-202609-001",
        actor: "ppic",
      }),
    /snapshot unavailable/,
  );
  assert.strictEqual(
    failingPrisma._state.scenarios.length,
    0,
    "snapshot failure must not leave a misleading CALCULATING scenario",
  );

  console.log("Monthly plan recommendation service contract passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
