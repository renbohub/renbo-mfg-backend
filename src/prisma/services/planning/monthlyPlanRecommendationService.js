"use strict";

const {
  buildCapacitySnapshot,
} = require("./capacityPlanningService");
const {
  buildMonthlyPlanRecommendation,
  dateKey,
} = require("./monthlyPlanRecommendationDomain");
const {
  openPersistentSession,
  stageRecommendationChanges,
} = require("./capacityEditSessionService");
const { aiRuntimeSupervisor } = require("../ai/aiRuntimeSupervisor");
const { resolveModelFile, validateRuntimeConfig } = require("../ai/aiModelProfileService");

const RULE_VERSION = "MPP-BACKWARD-FG-DUE-V6-TWO-SHIFT-BATCH";
const ACTIVE_SCENARIO_STATUSES = [
  "READY",
  "READY_WITH_OVERLOAD",
  "MATERIAL_QUEUE",
  "PARTIALLY_APPLIED",
];
const recommendationApplyLocks = new Map();

async function withRecommendationApplyLock(planId, operation) {
  const lockKey = String(planId || "unknown-plan");
  const previous = recommendationApplyLocks.get(lockKey) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  recommendationApplyLocks.set(lockKey, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (recommendationApplyLocks.get(lockKey) === current) recommendationApplyLocks.delete(lockKey);
  }
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode, status: statusCode });
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function jsonSafe(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) =>
      item instanceof Date ? item.toISOString() : item,
    ),
  );
}

function recommendationBatchPolicy(snapshot = {}, input = {}) {
  const shiftHours = Math.max(number(input.shiftHours ?? snapshot.parameters?.shiftHours), 0);
  const shiftsPerDay = Math.max(number(input.shiftsPerDay ?? snapshot.parameters?.shiftsPerDay), 0);
  const configuredTwoShiftMinutes = shiftHours > 0 && shiftsPerDay > 0
    ? shiftHours * Math.min(shiftsPerDay, 2) * 60
    : 14 * 60;
  return {
    minimumBatchMinutes: Math.max(number(input.minimumBatchMinutes) || 60, 1),
    maximumBatchMinutes: Math.max(number(input.maximumBatchMinutes) || configuredTwoShiftMinutes, 60),
    batchPolicy: "MINIMUM_ONE_HOUR_MAXIMUM_TWO_SHIFTS_SOURCE_LIMITED",
  };
}

async function clearSupersededRecommendationChanges(prisma, { sessionId, scenarioId }) {
  const staged = await prisma.capacityEditChange.findMany({
    where: { sessionId },
    select: { id: true, afterValue: true },
  });
  const supersededIds = staged
    .filter((change) => change.afterValue?.recommendationSource === true
      && change.afterValue?.recommendationScenarioId
      && change.afterValue.recommendationScenarioId !== scenarioId)
    .map((change) => change.id);
  if (!supersededIds.length) return 0;
  const removed = await prisma.capacityEditChange.deleteMany({
    where: { id: { in: supersededIds } },
  });
  return Number(removed.count || 0);
}

function scenarioStatus(summary = {}) {
  if (number(summary.materialQueueQty) > 0) return "MATERIAL_QUEUE";
  if (number(summary.overloadCellCount) > 0) return "READY_WITH_OVERLOAD";
  return "READY";
}

function selectItems(items = [], selection = { mode: "ALL" }) {
  const pending = (items || []).filter(
    (item) => item.changeType && item.applyStatus === "PENDING",
  );
  if (selection.mode === "ALL") return pending;
  if (selection.mode === "EXISTING_TASKS") {
    return pending.filter((item) => Boolean(item.sourceAllocationId));
  }
  if (selection.mode === "WORK_CENTER") {
    const workCenterIds = new Set(selection.workCenterIds || []);
    return pending.filter((item) => workCenterIds.has(item.workCenterId));
  }
  if (selection.mode === "ITEMS") {
    const itemIds = new Set(selection.itemIds || []);
    return pending.filter((item) => itemIds.has(item.id));
  }
  throw httpError(400, "Mode pemilihan recommendation tidak valid.");
}

function buildApplyReadiness(scenario, selectedItems = [], scope = "ALL") {
  const selectedIds = new Set((selectedItems || []).map((item) => item.id));
  const excludedNewQty = (scenario?.items || [])
    .filter((item) => item.changeType === "ALLOCATE_REMAINING"
      && String(item.applyStatus || "PENDING") === "PENDING"
      && !selectedIds.has(item.id))
    .reduce((sum, item) => sum + number(item.proposedValue?.qty), 0);
  const remainingAllocationQty = Math.max(
    number(scenario?.summary?.remainingAllocationQty) + excludedNewQty,
    0,
  );
  const fgCovered = Boolean(scenario?.summary?.fgCoverageReady) && excludedNewQty <= 0.000001;
  return {
    scope: String(scope || "ALL").toUpperCase(),
    fgCovered,
    remainingAllocationQty,
    ready: fgCovered && remainingAllocationQty <= 0.000001,
  };
}

function assertRecommendationSourceLimits(selectedItems = [], sourceAllocations = []) {
  const sourceById = new Map(
    (sourceAllocations || []).map((row) => [String(row.id), row]),
  );
  const requestedBySource = new Map();
  for (const item of selectedItems || []) {
    if (!item.sourceAllocationId) continue;
    const sourceId = String(item.sourceAllocationId);
    requestedBySource.set(
      sourceId,
      number(requestedBySource.get(sourceId)) + Math.max(number(item.proposedValue?.qty), 0),
    );
  }
  for (const [sourceId, requestedQty] of requestedBySource) {
    const source = sourceById.get(sourceId);
    if (!source) {
      throw httpError(
        409,
        `Source allocation ${sourceId} sudah tidak tersedia. Generate ulang recommendation.`,
      );
    }
    const sourceQty = Math.max(number(source.plannedQty), 0);
    if (requestedQty > sourceQty + 0.000001) {
      throw httpError(
        409,
        `Qty recommendation ${requestedQty} melebihi source allocation ${sourceQty}. Generate ulang recommendation.`,
      );
    }
  }
  return true;
}

function recommendationItemToEditorChange(item, scenario) {
  const value = item.proposedValue || {};
  const vendorMode = Boolean(value.vendorId);
  const common = {
    qty: number(value.qty),
    targetDate: value.targetDate,
    targetRowKey: value.targetRowKey || null,
    targetChildKey: value.targetChildKey || null,
    routingMode: vendorMode ? "VENDOR" : "INHOUSE",
    targetMachineId: value.targetMachineId || null,
    vendorId: value.vendorId || null,
    targetVendorId: value.vendorId || null,
    vendorReturnDate: value.vendorReturnDate || null,
    reason: item.reasonCode,
    recommendationScenarioId: scenario.id,
    recommendationItemId: item.id,
  };
  if (item.changeType === "ALLOCATE_REMAINING") {
    return {
      type: "ALLOCATE_REMAINING",
      planNumber: scenario.plan?.planNumber || null,
      lineNumber: item.lineNumber,
      mbomProcessId: item.mbomProcessId,
      partCode: item.partCode,
      processCode: item.processCode,
      ...common,
    };
  }
  return {
    type:
      item.changeType === "SPLIT_ALLOCATION"
        ? "SPLIT_ALLOCATION"
        : "MOVE_ALLOCATION",
    allocationId: item.sourceAllocationId,
    lineNumber: item.lineNumber,
    mbomProcessId: item.mbomProcessId,
    partCode: item.partCode,
    processCode: item.processCode,
    ...common,
  };
}

function machineResources(snapshot, catalog) {
  const allowed = new Set(catalog.allowedMachineIds || []);
  return (snapshot.machines || [])
    .filter((machine) => !allowed.size || allowed.has(machine.id))
    .map((machine) => ({
      id: machine.id,
      machineId: machine.id,
      machineCode: machine.machineCode,
      workCenterId: machine.workCenterId || machine.lineCode || null,
      matrixRowKey: machine.matrixRowKey || `MACHINE:${machine.id}`,
      matrixChildKey:
        catalog.matrixChildKey ||
        `PART:${catalog.partCode}`,
      availableMinutes: number(machine.defaultAvailableMinutes),
      projectedLoadMinutes: 0,
      availableMinutesByDate: Object.fromEntries(
        Object.entries(machine.cells || {}).map(([key, cell]) => [
          dateKey(key),
          Math.max(
            number(cell.availableMinutes) -
              number(cell.downtimeMinutes) -
              number(cell.firmMinutes),
            0,
          ),
        ]),
      ),
    }))
    .sort(
      (left, right) =>
        String(left.machineCode || "").localeCompare(
          String(right.machineCode || ""),
        ) || String(left.id).localeCompare(String(right.id)),
    );
}

function vendorResources(snapshot, catalog) {
  const vendor = (snapshot.catalogs?.vendors || []).find(
    (candidate) => candidate.id === catalog.vendorId,
  );
  if (!vendor && !catalog.vendorId) return [];
  const vendorId = vendor?.id || catalog.vendorId;
  return [
    {
      id: vendorId,
      vendorId,
      vendorCode: vendor?.vendorCode || catalog.vendorCode || vendorId,
      workCenterId: catalog.workCenterId || `VENDOR:${vendorId}`,
      matrixRowKey: catalog.matrixRowKey || `VENDOR:${vendorId}`,
      matrixChildKey:
        catalog.matrixChildKey ||
        `PART:${catalog.partCode}:${catalog.processCode || "VENDOR"}`,
      availableMinutes: Number.MAX_SAFE_INTEGER,
      projectedLoadMinutes: 0,
      vendorReturnDate:
        catalog.recommendedReturnDate || catalog.requiredDate || null,
    },
  ];
}

function extractOfficialAllocations(snapshot) {
  const allocations = [];
  const seen = new Set();
  for (const machine of snapshot.machines || []) {
    for (const [scheduleDate, cell] of Object.entries(machine.cells || {})) {
      for (const item of cell.items || []) {
        if (!item.allocationId || seen.has(item.allocationId)) continue;
        if (!["MANUAL", "RECOMMENDED"].includes(String(item.source || "").toUpperCase())) {
          continue;
        }
        seen.add(item.allocationId);
        allocations.push({
          id: item.allocationId,
          lineNumber: item.lineNumber,
          mbomProcessId: item.mbomProcessId,
          scheduleDate: dateKey(item.scheduleDate || scheduleDate),
          plannedQty: number(item.qty),
          machineId: item.machineId || machine.id || null,
          vendorId: item.vendorId || null,
          routingMode: item.routingMode || "INHOUSE",
        });
      }
    }
  }
  for (const assignment of snapshot.vendorAssignments || []) {
    if (!assignment.allocationId || seen.has(assignment.allocationId)) continue;
    seen.add(assignment.allocationId);
    allocations.push({
      id: assignment.allocationId,
      lineNumber: assignment.lineNumber,
      mbomProcessId: assignment.mbomProcessId,
      scheduleDate: dateKey(
        assignment.sendDate || assignment.scheduleDate || assignment.returnDate,
      ),
      plannedQty: number(assignment.qty),
      machineId: null,
      vendorId: assignment.vendorId || null,
      routingMode: "VENDOR",
    });
  }
  return allocations;
}

function adaptCapacitySnapshot({ plan, snapshot }) {
  if (snapshot?.recommendationInput) {
    const input = jsonSafe(snapshot.recommendationInput);
    return {
      ...input,
      ...recommendationBatchPolicy(snapshot, input),
      periodStart: dateKey(input.periodStart || plan.periodStart),
      periodEnd: dateKey(input.periodEnd || plan.periodEnd),
      auditSnapshot: jsonSafe(
        input.auditSnapshot || {
          planNumber: plan.planNumber,
          planUpdatedAt: plan.updatedAt,
          capacityParameters: snapshot.parameters || null,
        },
      ),
    };
  }

  const catalogs = (snapshot.manualAllocationCatalog || []).filter(
    (item) => !item.planNumber || item.planNumber === plan.planNumber,
  );
  const officialAllocations = extractOfficialAllocations(snapshot);
  const existingQtyByRoute = new Map();
  for (const allocation of officialAllocations) {
    const key = `${Number(allocation.lineNumber || 0)}|${String(allocation.mbomProcessId || "")}`;
    existingQtyByRoute.set(key, number(existingQtyByRoute.get(key)) + number(allocation.plannedQty));
  }
  const byLine = new Map();
  for (const catalog of catalogs) {
    const key = String(catalog.lineNumber);
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(catalog);
  }
  const jobs = [...byLine.entries()]
    .map(([lineNumber, routes]) => {
      const ordered = [...routes].sort(
        (left, right) =>
          number(left.sequence) - number(right.sequence) ||
          String(left.mbomProcessId || "").localeCompare(
            String(right.mbomProcessId || ""),
          ),
      );
      const first = ordered[0] || {};
      const fgRequiredDate = dateKey(
        first.fgRequiredDate || first.requiredDate || plan.periodEnd,
      );
      return {
        lineNumber: number(lineNumber),
        qty: Math.max(...ordered.map((route) => {
          const routeKey = `${Number(route.lineNumber || 0)}|${String(route.mbomProcessId || "")}`;
          return number(route.remainingQty) + number(existingQtyByRoute.get(routeKey));
        }), 0),
        priorityScore: number(first.priorityScore),
        fgRequiredDate,
        routes: ordered.map((catalog) => {
          const vendor = String(catalog.routingMode || "INHOUSE").toUpperCase() === "VENDOR";
          return {
            lineNumber: number(catalog.lineNumber),
            sequence: number(catalog.sequence),
            occurrenceCode: catalog.routingNumber || null,
            mbomProcessId: catalog.mbomProcessId,
            processCode: catalog.processCode,
            outputPartCode: catalog.outputPartCode || catalog.partCode,
            inputPartCode: catalog.inputPartCode || null,
            inputQtyPerOutput: number(catalog.inputQtyPerOutput) || 1,
            minutesPerUnit: vendor
              ? 0
              : Math.min(
                  ...Object.values(catalog.cycleMinutesByMachine || {})
                    .map(number)
                    .filter((value) => value > 0),
                  Number.MAX_SAFE_INTEGER,
                ) || 0,
            leadDays: Math.max(
              vendor ? number(catalog.vendorLeadTimeDays) : number(catalog.leadDays),
              1,
            ),
            routingMode: vendor ? "VENDOR" : "INHOUSE",
            minimumOrderQty: number(catalog.minimumOrderQty),
            orderMultipleQty: number(catalog.orderMultipleQty),
            fgRequiredDate,
            resources: vendor
              ? vendorResources(snapshot, catalog)
              : machineResources(snapshot, catalog),
          };
        }),
      };
    })
    .filter((job) => job.qty > 0 && job.routes.length > 0);

  return {
    periodStart: dateKey(plan.periodStart),
    periodEnd: dateKey(plan.periodEnd),
    ...recommendationBatchPolicy(snapshot),
    openingStock: jsonSafe(snapshot.recommendationMaterial?.openingStock || {}),
    receipts: jsonSafe(snapshot.recommendationMaterial?.receipts || []),
    consumptions: jsonSafe(snapshot.recommendationMaterial?.consumptions || []),
    existingAllocations: officialAllocations,
    jobs,
    auditSnapshot: jsonSafe({
      planNumber: plan.planNumber,
      planUpdatedAt: plan.updatedAt,
      capacityParameters: snapshot.parameters || null,
      materialGate: snapshot.materialGate
        ? {
            mrpRunNumber: snapshot.materialGate.mrpRunNumber || null,
            suggestionNumber: snapshot.materialGate.suggestionNumber || null,
            source: snapshot.materialGate.source || null,
            readyDate: snapshot.materialGate.readyDate || null,
          }
        : null,
      sourceCounts: {
        jobs: jobs.length,
        routes: catalogs.length,
        officialAllocations: officialAllocations.length,
      },
    }),
  };
}

function createRecommendationService(dependencies = {}) {
  const env = dependencies.env || process.env;
  const buildSnapshot = dependencies.buildSnapshot || buildCapacitySnapshot;
  const buildRecommendation =
    dependencies.buildRecommendation || buildMonthlyPlanRecommendation;
  const generateAiActions = dependencies.generateAiActions || (async ({ profile, context, outputSchema, repairErrors }) => {
    const messages = [{
      role: "system",
      content: [
        "Anda adalah decision layer scheduling PPIC.",
        "Pilih hanya candidate action ERP yang tersedia; jangan membuat tanggal, mesin, vendor, proses, atau qty baru.",
        "Prioritas utama adalah FG selesai tepat waktu. Overload boleh direkomendasikan dan akan direcovery manual oleh PPIC.",
        "Hormati material availability, urutan predecessor/successor, vendor return date, dan FG required date dari candidate.",
        "Jangan menghitung ulang qty, capacity, stock, WIP, atau lead time karena seluruh angka sudah dihitung engine ERP.",
        "/no_think",
      ].join("\n"),
    }, { role: "user", content: JSON.stringify({ context, repairErrors }) }];
    const result = await aiRuntimeSupervisor.enqueue({ id: `mpp:${Date.now()}`, userId: "mpp-recommendation", priority: 40, profile: { ...profile, resolvedModelPath: resolveModelFile(profile, process.env.AI_MODEL_DIR), runtimeConfig: validateRuntimeConfig(profile.runtimeConfig) }, messages, outputSchema, maxTokens: 800, thinkingMode: "bounded", timeoutMs: profile.runtimeConfig?.recommendationTimeoutMs || 90000, seed: 42 });
    return result.json;
  });

  async function getRecommendationScenario(prisma, scenarioId) {
    const scenario = await prisma.monthlyPlanRecommendationScenario.findUnique({
      where: { id: scenarioId },
      include: {
        items: { orderBy: { sequence: "asc" } },
        plan: {
          select: {
            id: true,
            planNumber: true,
            periodStart: true,
            periodEnd: true,
            updatedAt: true,
          },
        },
      },
    });
    if (!scenario) throw httpError(404, "Scenario recommendation tidak ditemukan.");
    return scenario;
  }

  async function getActiveRecommendationScenario(prisma, planNumber) {
    const plan = await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber, isDeleted: false },
      select: { id: true, updatedAt: true },
    });
    if (!plan) throw httpError(404, "Monthly Production Plan tidak ditemukan.");
    return prisma.monthlyPlanRecommendationScenario.findFirst({
      where: {
        planId: plan.id,
        basePlanUpdatedAt: plan.updatedAt,
        ruleVersion: RULE_VERSION,
        status: { in: ACTIVE_SCENARIO_STATUSES },
      },
      include: { items: { orderBy: { sequence: "asc" } } },
      orderBy: { createdAt: "desc" },
    });
  }

  async function generateRecommendationScenario(prisma, { planNumber, actor }) {
    const plan = await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber, isDeleted: false },
    });
    if (!plan) throw httpError(404, "Monthly Production Plan tidak ditemukan.");
    const reusable = await prisma.monthlyPlanRecommendationScenario.findFirst({
      where: {
        planId: plan.id,
        basePlanUpdatedAt: plan.updatedAt,
        ruleVersion: RULE_VERSION,
        status: { in: ACTIVE_SCENARIO_STATUSES },
      },
      include: { items: { orderBy: { sequence: "asc" } } },
      orderBy: { createdAt: "desc" },
    });
    if (reusable) return reusable;

    const snapshot = await buildSnapshot(prisma, {
      planNumber: plan.planNumber,
      startDate: plan.periodStart,
      endDate: plan.periodEnd,
      planningMode: "PRODUCTION",
      manualAllocation: true,
    });
    const input = adaptCapacitySnapshot({ plan, snapshot });
    const scenario = await prisma.monthlyPlanRecommendationScenario.create({
      data: {
        planId: plan.id,
        basePlanUpdatedAt: plan.updatedAt,
        ruleVersion: RULE_VERSION,
        status: "CALCULATING",
        inputSnapshot: jsonSafe(input.auditSnapshot),
        createdBy: actor || "system",
      },
    });
    try {
      const result = buildRecommendation(input);
      const data = result.items.map((item) =>
        jsonSafe({ ...item, scenarioId: scenario.id }),
      );
      const operations = [];
      if (data.length) {
        operations.push(
          prisma.monthlyPlanRecommendationItem.createMany({ data }),
        );
      }
      operations.push(
        prisma.monthlyPlanRecommendationScenario.update({
          where: { id: scenario.id },
          data: {
            status: scenarioStatus(result.summary),
            summary: jsonSafe(result.summary),
            errorMessage: null,
          },
        }),
      );
      await prisma.$transaction(operations);
      return getRecommendationScenario(prisma, scenario.id);
    } catch (error) {
      await prisma.monthlyPlanRecommendationScenario.update({
        where: { id: scenario.id },
        data: { status: "FAILED", errorMessage: String(error.message || error) },
      });
      throw error;
    }
  }

  const generateRuleBasedRecommendationScenario = generateRecommendationScenario;

  async function generateAiRecommendationScenario(prisma, { planNumber, actor, user, pageContext } = {}) {
    const scenario = await generateRuleBasedRecommendationScenario(prisma, { planNumber, actor });
    if (scenario.generationSource && !["RULE_BASED", "RULE_BASED_FALLBACK"].includes(scenario.generationSource)) return scenario;
    if (String(env.AI_ASSISTANT_ENABLED || "false").toLowerCase() !== "true") {
      await prisma.monthlyPlanRecommendationScenario.update({
        where: { id: scenario.id },
        data: {
          generationSource: "RULE_BASED_FALLBACK",
          aiValidationSummary: { fallbackReason: "FEATURE_DISABLED" },
        },
      });
      return getRecommendationScenario(prisma, scenario.id);
    }
    const profile = await prisma.aiModelProfile?.findFirst?.({ where: { status: "ACTIVE" } });
    const candidates = (scenario.items || []).filter((item) => item.changeType).map((item) => ({
      action: item.changeType === "ALLOCATE_REMAINING" ? "ALLOCATE" : item.changeType === "SPLIT_ALLOCATION" ? "SPLIT" : item.changeType === "MATERIAL_QUEUE" ? "QUEUE" : "MOVE",
      lineNumber: item.lineNumber, mbomProcessId: item.mbomProcessId, sourceAllocationId: item.sourceAllocationId || null,
      targetMachineId: item.proposedValue?.targetMachineId || null, targetVendorId: item.proposedValue?.vendorId || null,
      targetDate: item.proposedValue?.targetDate || null, qty: number(item.proposedValue?.qty), reasonCode: item.reasonCode,
    }));
    const allowedMachineIds = [...new Set(candidates.map((row) => row.targetMachineId).filter(Boolean))];
    const allowedDates = [...new Set(candidates.map((row) => row.targetDate).filter(Boolean))];
    const allowedProcessIds = [...new Set(candidates.map((row) => row.mbomProcessId).filter(Boolean))];
    if (!profile || !candidates.length) {
      await prisma.monthlyPlanRecommendationScenario.update({ where: { id: scenario.id }, data: { generationSource: "RULE_BASED_FALLBACK", aiValidationSummary: { fallbackReason: profile ? "NO_CANDIDATE" : "NO_ACTIVE_MODEL", allowedMachineIds, allowedDates } } });
      return getRecommendationScenario(prisma, scenario.id);
    }
    const outputSchema = { type: "object", additionalProperties: false, required: ["actions", "summary"], properties: { actions: { type: "array", maxItems: candidates.length, items: { type: "object", additionalProperties: false, required: ["action", "lineNumber", "mbomProcessId", "sourceAllocationId", "targetMachineId", "targetVendorId", "targetDate", "qty", "reasonCode"], properties: { action: { enum: ["ALLOCATE", "MOVE", "SPLIT", "QUEUE"] }, lineNumber: { type: ["integer", "null"] }, mbomProcessId: { type: ["string", "null"] }, sourceAllocationId: { type: ["string", "null"] }, targetMachineId: { type: ["string", "null"] }, targetVendorId: { type: ["string", "null"] }, targetDate: { type: ["string", "null"] }, qty: { type: "number" }, reasonCode: { type: "string" } } } }, summary: { type: "object", additionalProperties: false, required: ["rationale", "fgOnTimeCount", "fgLateCount"], properties: { rationale: { type: "string" }, fgOnTimeCount: { type: "integer" }, fgLateCount: { type: "integer" } } } } };
    let errors = [];
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const output = await generateAiActions({ profile, user, pageContext, outputSchema, repairErrors: errors, context: { planNumber, allowedMachineIds, allowedDates, allowedProcessIds, candidates } });
        errors = (output?.actions || []).flatMap((action) => {
          const match = candidates.some((candidate) => candidate.action === action.action && candidate.lineNumber === action.lineNumber && candidate.mbomProcessId === action.mbomProcessId && candidate.sourceAllocationId === action.sourceAllocationId && candidate.targetMachineId === action.targetMachineId && candidate.targetVendorId === action.targetVendorId && candidate.targetDate === action.targetDate);
          return match ? [] : [{ code: "UNKNOWN_REFERENCE", message: "Action harus sama dengan candidate ERP." }];
        });
        if (output?.actions?.length && !errors.length) {
          await prisma.monthlyPlanRecommendationScenario.update({ where: { id: scenario.id }, data: { generationSource: attempt ? "AI_CORRECTED" : "AI", modelProfileCode: profile.profileCode, promptVersion: profile.promptCompatibilityVersion, aiValidationSummary: { valid: true, attempts: attempt + 1, rationale: output.summary?.rationale, allowedMachineIds, allowedDates } } });
          return getRecommendationScenario(prisma, scenario.id);
        }
      }
      throw Object.assign(new Error("Hasil AI tidak cocok dengan candidate ERP."), { code: "AI_CANDIDATE_INVALID" });
    } catch (error) {
      await prisma.monthlyPlanRecommendationScenario.update({ where: { id: scenario.id }, data: { generationSource: "RULE_BASED_FALLBACK", modelProfileCode: profile.profileCode, promptVersion: profile.promptCompatibilityVersion, aiValidationSummary: { valid: false, fallbackReason: error.code || "AI_RUNTIME_FAILED", errors } } });
      return getRecommendationScenario(prisma, scenario.id);
    }
  }

  async function applyRecommendationScenario(
    prisma,
    { scenarioId, actor, selection = { mode: "ALL" } },
  ) {
    const lockScenario = await getRecommendationScenario(prisma, scenarioId);
    return withRecommendationApplyLock(lockScenario.planId || scenarioId, () => prisma.$transaction(async (tx) => {
      const scenario = await getRecommendationScenario(tx, scenarioId);
      if (["DISCARDED", "APPLIED", "FAILED"].includes(scenario.status)) {
        throw httpError(
          409,
          `Scenario berstatus ${scenario.status} tidak dapat diterapkan.`,
        );
      }
      const plan =
        scenario.plan ||
        (await tx.monthlyProductionPlan.findFirst({
          where: { id: scenario.planId, isDeleted: false },
        }));
      if (!plan) throw httpError(404, "Monthly Production Plan tidak ditemukan.");
      if (
        new Date(plan.updatedAt).getTime() !==
        new Date(scenario.basePlanUpdatedAt).getTime()
      ) {
        throw httpError(
          409,
          "Monthly Plan sudah berubah. Generate ulang recommendation sebelum apply.",
        );
      }
      const selected = selectItems(scenario.items, selection);
      if (!selected.length) {
        throw httpError(400, "Tidak ada proposal aktif pada pemilihan tersebut.");
      }
      const sourceAllocationIds = [
        ...new Set(selected.map((item) => item.sourceAllocationId).filter(Boolean)),
      ];
      if (sourceAllocationIds.length) {
        const sourceAllocations = await tx.productionPlanAllocation.findMany({
          where: { id: { in: sourceAllocationIds }, isDeleted: false },
          select: { id: true, plannedQty: true },
        });
        assertRecommendationSourceLimits(selected, sourceAllocations);
      }
      const session = await openPersistentSession(tx, {
        planNumber: plan.planNumber,
        actor: actor || "system",
        scope: "PLAN",
      });
      await clearSupersededRecommendationChanges(tx, {
        sessionId: session.id,
        scenarioId: scenario.id,
      });
      const changes = selected.map((item) =>
        recommendationItemToEditorChange(item, scenario),
      );
      const stagedChanges = await stageRecommendationChanges(tx, {
        sessionId: session.id,
        changes,
        actor: actor || "system",
      });
      const projectedReadiness = buildApplyReadiness(scenario, selected, selection.mode);
      await tx.monthlyPlanRecommendationItem.updateMany({
        where: { scenarioId: scenario.id, id: { in: selected.map((item) => item.id) } },
        data: { applyStatus: "APPLIED" },
      });
      const remaining = await tx.monthlyPlanRecommendationItem.count({
        where: {
          scenarioId: scenario.id,
          changeType: { not: null },
          applyStatus: "PENDING",
        },
      });
      await tx.monthlyPlanRecommendationScenario.update({
        where: { id: scenario.id },
        data:
          remaining > 0
            ? { status: "PARTIALLY_APPLIED" }
            : {
                status: "APPLIED",
                appliedBy: actor || "system",
                appliedAt: new Date(),
              },
      });
      return {
        scenario: await getRecommendationScenario(tx, scenario.id),
        session,
        stagedChanges,
        projectedReadiness,
      };
    }));
  }

  async function discardRecommendationScenario(prisma, { scenarioId, actor }) {
    const scenario = await getRecommendationScenario(prisma, scenarioId);
    if (scenario.status === "APPLIED") {
      throw httpError(
        409,
        "Scenario yang sudah diterapkan tidak dapat di-discard.",
      );
    }
    if (scenario.status === "DISCARDED") return scenario;
    return prisma.monthlyPlanRecommendationScenario.update({
      where: { id: scenario.id },
      data: {
        status: "DISCARDED",
        discardedBy: actor || "system",
        discardedAt: new Date(),
      },
    });
  }

  return {
    adaptCapacitySnapshot,
    applyRecommendationScenario,
    discardRecommendationScenario,
    generateRecommendationScenario,
    generateAiRecommendationScenario,
    generateRuleBasedRecommendationScenario,
    getActiveRecommendationScenario,
    getRecommendationScenario,
    recommendationItemToEditorChange,
    assertRecommendationSourceLimits,
    buildApplyReadiness,
    scenarioStatus,
    selectItems,
  };
}

const defaultService = createRecommendationService();

module.exports = {
  ACTIVE_SCENARIO_STATUSES,
  RULE_VERSION,
  adaptCapacitySnapshot,
  createRecommendationService,
  httpError,
  recommendationItemToEditorChange,
  assertRecommendationSourceLimits,
  buildApplyReadiness,
  scenarioStatus,
  selectItems,
  withRecommendationApplyLock,
  ...defaultService,
};
