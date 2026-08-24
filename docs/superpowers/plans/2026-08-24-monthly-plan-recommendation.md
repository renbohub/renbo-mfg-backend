# Monthly Production Plan Recommendation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic backward-scheduling recommendation scenario for Monthly Production Plan that prioritizes on-time FG, respects dated material availability, permits visible capacity overload, and applies selected proposals through Capacity Editor without mutating the official plan prematurely.

**Architecture:** A pure recommendation domain converts an immutable capacity snapshot into proposed changes, dated material queues, and overload traces. A persistence service stores versioned scenarios and applies selected proposals into the existing transactional Capacity Editor. The Monthly Production Plan UI projects an active scenario over the official matrix and exposes all, Work Center, or selected apply flows.

**Tech Stack:** Node.js CommonJS, Express 5, Prisma 7/PostgreSQL, EJS, browser JavaScript with UMD test helpers, CSS, Node `assert` contract tests.

**Spec:** `docs/superpowers/specs/2026-08-24-monthly-plan-recommendation-design.md`

## Global Constraints

- Primary objective: FG required must finish on time; capacity leveling is secondary.
- Capacity above 100% is allowed and must be marked `OVERLOAD`; recovery remains manual.
- Material availability and routing sequence are hard constraints.
- Any predecessor completed or vendor-returned on date `D` becomes available to its successor on `D+1`.
- Warehouse and WIP stock cannot be consumed twice.
- Material unavailable for a dated successor becomes `MATERIAL_QUEUE`; outside-month availability becomes carry-over.
- Recommendation calculation and preview cannot mutate official `ProductionPlanAllocation` rows.
- Apply stages changes into Capacity Editor; only its existing `Save Changes` commits them.
- Released/published execution history remains immutable and uses residual-replan behavior.
- No new optimization or machine-learning dependency is introduced.

---

## File Structure

### Backend

- Create `prisma/migrations/20260824180000_add_mpp_recommendation_scenario/migration.sql` — scenario and proposal persistence.
- Modify `prisma/schema.prisma` — Prisma models and Monthly Production Plan relation.
- Create `src/prisma/services/planning/monthlyPlanRecommendationDomain.js` — pure deterministic scheduler, temporal material ledger, resource selection, and proposal generation.
- Create `src/prisma/services/planning/monthlyPlanRecommendationService.js` — snapshot adapter, scenario lifecycle, apply/discard, and optimistic locking.
- Modify `src/prisma/services/planning/capacityEditSessionService.js` — batch staging entry point for recommendation proposals.
- Create `src/prisma/controllers/planning/MonthlyPlanRecommendationController.js` — thin injectable HTTP handlers.
- Modify `src/prisma/routes/planning/monthly-production-plans.js` — scenario endpoints.
- Create `scripts/verify-monthly-plan-recommendation-schema.js` — generated Prisma model contract.
- Create `scripts/verify-monthly-plan-recommendation-domain.js` — deterministic scheduler contracts.
- Create `scripts/verify-monthly-plan-recommendation-service.js` — lifecycle/apply contracts.
- Create `scripts/verify-monthly-plan-recommendation-api.js` — handler status and payload contracts.
- Modify `package.json` — recommendation test command and MPP suite integration.

### Frontend

- Create `public/js/ppic-monthly-recommendation.js` — pure scenario normalization, selection, summary, and matrix projection.
- Modify `public/js/ppic-monthly-production-plan.js` — API orchestration and scenario/editor state transitions.
- Modify `public/js/ppic-monthly-capacity-editor.js` — projection support for move/split proposals after apply.
- Modify `views/ppic/monthly-production-plan.ejs` — recommendation button, preview toolbar, queue drawer, and script loading.
- Modify `public/css/ppic-monthly-production-plan.css` — recommended, moved, overload, queue, and sticky-preview states.
- Create `scripts/verify-mpp-recommendation.js` — browser-model and UI behavior contracts.
- Modify `scripts/verify-mpp-capacity-editor.js` — applied recommendation projection and Undo/Cancel regression.
- Modify `src/routes/modules.js` — asset cache versions.
- Modify `package.json` — frontend recommendation test and build integration.

---

### Task 1: Persist Recommendation Scenarios and Items

**Files:**
- Create: `backend/scripts/verify-monthly-plan-recommendation-schema.js`
- Modify: `backend/prisma/schema.prisma:4762-5030`
- Create: `backend/prisma/migrations/20260824180000_add_mpp_recommendation_scenario/migration.sql`
- Modify: `backend/package.json`

**Interfaces:**
- Produces: Prisma delegates `monthlyPlanRecommendationScenario` and `monthlyPlanRecommendationItem`.
- Produces: relation `MonthlyProductionPlan.recommendationScenarios`.

- [ ] **Step 1: Write the failing generated-client contract**

```js
"use strict";
const assert = require("assert");
const { Prisma } = require("@prisma/client");
const modelNames = new Set(Prisma.dmmf.datamodel.models.map((model) => model.name));
assert(modelNames.has("MonthlyPlanRecommendationScenario"));
assert(modelNames.has("MonthlyPlanRecommendationItem"));
const scenario = Prisma.dmmf.datamodel.models.find((model) => model.name === "MonthlyPlanRecommendationScenario");
assert(scenario.fields.some((field) => field.name === "basePlanUpdatedAt"));
assert(scenario.fields.some((field) => field.name === "items" && field.isList));
console.log("Monthly plan recommendation schema contract passed.");
```

- [ ] **Step 2: Run the contract and verify RED**

Run: `node scripts/verify-monthly-plan-recommendation-schema.js`  
Expected: FAIL because `MonthlyPlanRecommendationScenario` is absent.

- [ ] **Step 3: Add focused Prisma models**

```prisma
model MonthlyPlanRecommendationScenario {
  id                String    @id @default(uuid())
  planId            String    @map("plan_id")
  basePlanUpdatedAt DateTime  @map("base_plan_updated_at")
  ruleVersion       String    @map("rule_version")
  status            String    @default("CALCULATING")
  inputSnapshot     Json      @map("input_snapshot")
  summary           Json?
  errorMessage      String?   @map("error_message")
  createdBy         String?   @map("created_by")
  appliedBy         String?   @map("applied_by")
  appliedAt         DateTime? @map("applied_at")
  discardedBy       String?   @map("discarded_by")
  discardedAt       DateTime? @map("discarded_at")
  createdAt         DateTime  @default(now()) @map("created_at")
  updatedAt         DateTime  @updatedAt @map("updated_at")
  plan              MonthlyProductionPlan @relation(fields: [planId], references: [id], onDelete: Cascade)
  items             MonthlyPlanRecommendationItem[]

  @@index([planId, status])
  @@index([basePlanUpdatedAt])
  @@map("tbl_monthly_plan_recommendation_scenario")
}

model MonthlyPlanRecommendationItem {
  id                 String   @id @default(uuid())
  scenarioId         String   @map("scenario_id")
  sequence           Int
  itemType           String   @map("item_type")
  changeType         String?  @map("change_type")
  workCenterId       String?  @map("work_center_id")
  sourceAllocationId String?  @map("source_allocation_id")
  lineNumber         Int?     @map("line_number")
  mbomProcessId      String?  @map("mbom_process_id")
  partCode           String?  @map("part_code")
  processCode        String?  @map("process_code")
  proposedValue      Json     @map("proposed_value")
  reasonCode         String   @map("reason_code")
  trace              Json
  applyStatus        String   @default("PENDING") @map("apply_status")
  createdAt          DateTime @default(now()) @map("created_at")
  scenario           MonthlyPlanRecommendationScenario @relation(fields: [scenarioId], references: [id], onDelete: Cascade)

  @@unique([scenarioId, sequence])
  @@index([scenarioId, itemType])
  @@index([scenarioId, applyStatus])
  @@index([workCenterId])
  @@map("tbl_monthly_plan_recommendation_item")
}
```

Add `recommendationScenarios MonthlyPlanRecommendationScenario[]` to `MonthlyProductionPlan` and create matching SQL tables, foreign keys, unique key, and indexes using the mapped names above.

- [ ] **Step 4: Generate and validate Prisma artifacts**

Run: `npx prisma format && npx prisma validate && npx prisma generate`  
Expected: all commands exit 0.

- [ ] **Step 5: Run the schema contract and verify GREEN**

Run: `node scripts/verify-monthly-plan-recommendation-schema.js`  
Expected: `Monthly plan recommendation schema contract passed.`

- [ ] **Step 6: Register the backend test command**

```json
"test:mpp-recommendation": "node scripts/verify-monthly-plan-recommendation-schema.js && node scripts/verify-monthly-plan-recommendation-domain.js && node scripts/verify-monthly-plan-recommendation-service.js && node scripts/verify-monthly-plan-recommendation-api.js"
```

- [ ] **Step 7: Commit the persistence contract**

```bash
git add prisma/schema.prisma prisma/migrations/20260824180000_add_mpp_recommendation_scenario/migration.sql scripts/verify-monthly-plan-recommendation-schema.js package.json
git commit -m "feat: persist monthly plan recommendation scenarios"
```

---

### Task 2: Implement the Deterministic Backward Scheduler

**Files:**
- Create: `backend/src/prisma/services/planning/monthlyPlanRecommendationDomain.js`
- Create: `backend/scripts/verify-monthly-plan-recommendation-domain.js`

**Interfaces:**
- Consumes: an immutable `RecommendationInput` object assembled by Task 3.
- Produces: `buildMonthlyPlanRecommendation(input) -> { summary, items }`.
- Produces: `createTemporalMaterialLedger(openingStock, receipts, consumptions)`.
- Produces: `nextAvailabilityDate(value) -> YYYY-MM-DD` using `D+1`.
- Produces: `deriveBackwardTargets(job) -> Array<{ route, targetDate }>`.
- Produces: `allocateForwardWithMaterial(targets, ledger, input) -> RecommendationItem[]`.
- Produces: `finalizeRecommendation(items, periodEnd) -> { summary, items }`.

- [ ] **Step 1: Write RED tests for D+1 and non-duplicated WIP**

```js
const assert = require("assert");
const {
  createTemporalMaterialLedger,
  nextAvailabilityDate,
} = require("../src/prisma/services/planning/monthlyPlanRecommendationDomain");

assert.strictEqual(nextAvailabilityDate("2026-09-03"), "2026-09-04");
const ledger = createTemporalMaterialLedger(
  { "WIP-PAINT": 60 },
  [{ partCode: "WIP-PAINT", date: "2026-09-04", qty: 191, sourceId: "paint-1" }],
  [],
);
assert.strictEqual(ledger.consume("WIP-PAINT", "2026-09-01", 60).allocatedQty, 60);
assert.strictEqual(ledger.available("WIP-PAINT", "2026-09-03"), 0);
assert.strictEqual(ledger.available("WIP-PAINT", "2026-09-04"), 191);
assert.strictEqual(ledger.consume("WIP-PAINT", "2026-09-04", 200).allocatedQty, 191);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node scripts/verify-monthly-plan-recommendation-domain.js`  
Expected: FAIL because the domain module does not exist.

- [ ] **Step 3: Implement UTC date and material-ledger primitives**

```js
const dateKey = (value) => (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
const addDays = (value, days) => {
  const date = new Date(`${dateKey(value)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const nextAvailabilityDate = (value) => addDays(value, 1);

function createTemporalMaterialLedger(openingStock = {}, receipts = [], consumptions = []) {
  const events = [...receipts.map((row) => ({ ...row, delta: Number(row.qty) })),
    ...consumptions.map((row) => ({ ...row, delta: -Number(row.qty) }))];
  const committed = [];
  const available = (partCode, date) => Math.max(Number(openingStock[partCode] || 0)
    + [...events, ...committed].filter((row) => row.partCode === partCode && row.date <= date)
      .reduce((sum, row) => sum + Number(row.delta), 0), 0);
  return {
    available,
    receipt(partCode, date, qty, sourceId) {
      events.push({ partCode, date, delta: Number(qty), sourceId });
    },
    consume(partCode, date, requestedQty) {
      const allocatedQty = Math.min(available(partCode, date), Number(requestedQty));
      if (allocatedQty > 0) committed.push({ partCode, date, delta: -allocatedQty });
      return { allocatedQty, queuedQty: Math.max(Number(requestedQty) - allocatedQty, 0) };
    },
  };
}
```

- [ ] **Step 4: Verify the material-ledger tests GREEN**

Run: `node scripts/verify-monthly-plan-recommendation-domain.js`  
Expected: all D+1 and balance assertions pass.

- [ ] **Step 5: Add RED fixtures for backward scheduling, split queue, overload, and allocation preservation**

Use one literal fixture with FG due `2026-09-10`, PAINT return `2026-09-07`, INSPECTION material availability `2026-09-08`, 60 PCS opening stock, and 191 PCS scheduled receipt. Assert literal results:

```js
const result = buildMonthlyPlanRecommendation(fixture);
assert.deepStrictEqual(result.items.map((item) => [item.itemType, item.partCode, item.proposedValue.targetDate || item.proposedValue.earliestAvailableDate, item.proposedValue.qty]), [
  ["NEW_ALLOCATION", "FG-BRACKET", "2026-09-10", 60],
  ["NEW_ALLOCATION", "FG-BRACKET", "2026-09-08", 191],
  ["CARRY_OVER", "FG-BRACKET", "2026-10-01", 23],
]);
assert.strictEqual(result.summary.overloadCellCount, 1);
assert.strictEqual(result.summary.fgOnTimeCount, 1);
assert.strictEqual(result.items.find((item) => item.reasonCode === "PRESERVE_ON_TIME_ALLOCATION").changeType, null);
```

The fixture must also assert that permuting machine input order produces an identical result, proving deterministic tie-breaking.

- [ ] **Step 6: Run the scheduler test and verify RED**

Run: `node scripts/verify-monthly-plan-recommendation-domain.js`  
Expected: FAIL because `buildMonthlyPlanRecommendation` is absent.

- [ ] **Step 7: Implement backward scheduling and explicit reason codes**

```js
const REASON = Object.freeze({
  NEW_EARLIEST_DUE: "NEW_EARLIEST_DUE",
  MOVE_PROTECT_FG_DUE: "MOVE_PROTECT_FG_DUE",
  SPLIT_MATERIAL_BATCH: "SPLIT_MATERIAL_BATCH",
  PRESERVE_ON_TIME_ALLOCATION: "PRESERVE_ON_TIME_ALLOCATION",
  MATERIAL_NOT_AVAILABLE: "MATERIAL_NOT_AVAILABLE",
  CARRY_OVER_MATERIAL: "CARRY_OVER_MATERIAL",
  CAPACITY_OVERLOAD: "CAPACITY_OVERLOAD",
  VENDOR_MOQ_BLOCKED: "VENDOR_MOQ_BLOCKED",
});

function buildMonthlyPlanRecommendation(input) {
  const jobs = [...input.jobs].sort((a, b) => a.fgRequiredDate.localeCompare(b.fgRequiredDate)
    || Number(b.priorityScore || 0) - Number(a.priorityScore || 0)
    || a.lineNumber - b.lineNumber);
  const ledger = createTemporalMaterialLedger(input.openingStock, input.receipts, input.consumptions);
  const items = [];
  for (const job of jobs) {
    const targets = deriveBackwardTargets(job);
    items.push(...allocateForwardWithMaterial(targets, ledger, input));
  }
  return finalizeRecommendation(items, input.periodEnd);
}
```

Use these exact helper rules:

```js
const routeCompare = (a, b) => Number(a.sequence) - Number(b.sequence)
  || String(a.occurrenceCode || "").localeCompare(String(b.occurrenceCode || ""))
  || String(a.mbomProcessId).localeCompare(String(b.mbomProcessId));
const resourceCompare = (a, b) => a.targetDate.localeCompare(b.targetDate)
  || Number(a.projectedLoadMinutes) - Number(b.projectedLoadMinutes)
  || String(a.machineCode || a.vendorCode).localeCompare(String(b.machineCode || b.vendorCode))
  || String(a.id).localeCompare(String(b.id));

function deriveBackwardTargets(job) {
  let successorDate = job.fgRequiredDate;
  return [...job.routes].sort(routeCompare).reverse().map((route) => {
    const targetDate = successorDate;
    successorDate = addDays(targetDate, -Math.max(Number(route.leadDays || 1), 1));
    return { route, targetDate, requestedQty: Number(job.qty) };
  }).reverse();
}

function allocateForwardWithMaterial(targets, ledger, input) {
  const items = [];
  for (const target of targets) {
    const route = target.route;
    const material = route.inputPartCode
      ? ledger.consume(route.inputPartCode, target.targetDate, target.requestedQty * Number(route.inputQtyPerOutput || 1))
      : { allocatedQty: target.requestedQty, queuedQty: 0 };
    const outputQty = material.allocatedQty / Math.max(Number(route.inputQtyPerOutput || 1), 1);
    const existing = input.existingAllocations.find((row) => row.lineNumber === route.lineNumber && row.mbomProcessId === route.mbomProcessId);
    const resource = [...route.resources].map((row) => ({ ...row, targetDate: target.targetDate })).sort(resourceCompare)[0];
    if (outputQty > 0 && resource) {
      const preserved = existing && existing.scheduleDate <= target.targetDate && Number(existing.plannedQty) === outputQty;
      const changeType = preserved ? null : existing ? (outputQty < Number(existing.plannedQty) ? "SPLIT_ALLOCATION" : "MOVE_ALLOCATION") : "ALLOCATE_REMAINING";
      const proposal = makeProposal({ target, resource, existing, outputQty, changeType,
        reasonCode: preserved ? REASON.PRESERVE_ON_TIME_ALLOCATION : existing ? REASON.MOVE_PROTECT_FG_DUE : REASON.NEW_EARLIEST_DUE });
      items.push(proposal);
      const completionDate = route.routingMode === "VENDOR" ? proposal.proposedValue.vendorReturnDate : target.targetDate;
      ledger.receipt(route.outputPartCode, nextAvailabilityDate(completionDate), outputQty, proposal.id);
      resource.projectedLoadMinutes += Number(route.minutesPerUnit || 0) * outputQty;
      if (resource.projectedLoadMinutes > Number(resource.availableMinutes || 0)) items.push(makeOverloadException(proposal, resource));
    }
    const queuedOutputQty = material.queuedQty / Math.max(Number(route.inputQtyPerOutput || 1), 1);
    if (queuedOutputQty > 0) {
      const futureReceipt = input.receipts.filter((row) => row.partCode === route.inputPartCode && row.date > target.targetDate)
        .sort((a, b) => a.date.localeCompare(b.date) || String(a.sourceId).localeCompare(String(b.sourceId)))[0];
      const earliestAvailableDate = futureReceipt?.date || null;
      items.push(makeMaterialQueue({ target, queuedOutputQty, earliestAvailableDate,
        itemType: earliestAvailableDate && earliestAvailableDate > input.periodEnd ? "CARRY_OVER" : "MATERIAL_QUEUE" }));
    }
  }
  return items;
}
```

Use these proposal payload fields so backend apply and frontend projection share one contract:

```js
function makeProposal({ target, resource, existing, outputQty, changeType, reasonCode }) {
  return {
    itemType: existing ? (changeType === "SPLIT_ALLOCATION" ? "SPLIT_ALLOCATION" : "MOVE_ALLOCATION") : "NEW_ALLOCATION",
    changeType,
    workCenterId: resource.workCenterId || null,
    sourceAllocationId: existing?.id || null,
    lineNumber: target.route.lineNumber,
    mbomProcessId: target.route.mbomProcessId,
    partCode: target.route.outputPartCode,
    processCode: target.route.processCode,
    proposedValue: {
      qty: outputQty,
      targetDate: target.targetDate,
      targetMachineId: resource.machineId || null,
      vendorId: resource.vendorId || null,
      vendorReturnDate: resource.vendorReturnDate || null,
      targetRowKey: resource.matrixRowKey,
      targetChildKey: resource.matrixChildKey,
      overload: Number(resource.projectedLoadMinutes) + Number(target.route.minutesPerUnit || 0) * outputQty > Number(resource.availableMinutes || 0),
    },
    reasonCode,
    trace: { fgRequiredDate: target.route.fgRequiredDate, routeSequence: target.route.sequence,
      materialAvailableDate: target.route.materialAvailableDate || null },
    applyStatus: "PENDING",
  };
}
```

`makeOverloadException` returns `itemType: "OVERLOAD_EXCEPTION"`, `changeType: null`, and the same target/resource trace. `makeMaterialQueue` returns `itemType: "MATERIAL_QUEUE"` or `"CARRY_OVER"`, `changeType: null`, `proposedValue: { qty, earliestAvailableDate }`, and reason `MATERIAL_NOT_AVAILABLE` or `CARRY_OVER_MATERIAL`. `finalizeRecommendation` assigns stable sequences after sorting by FG due date, route sequence, item type, and source identity; it derives literal summary counters without changing proposal quantities. Vendor routes failing MOQ/order multiple emit `VENDOR_MOQ_BLOCKED` with `changeType: null` instead of calling `makeProposal`.

- [ ] **Step 8: Run the full domain contract GREEN**

Run: `node scripts/verify-monthly-plan-recommendation-domain.js`  
Expected: deterministic schedule, split, queue, carry-over, overload, and preservation assertions pass.

- [ ] **Step 9: Commit the pure engine**

```bash
git add src/prisma/services/planning/monthlyPlanRecommendationDomain.js scripts/verify-monthly-plan-recommendation-domain.js
git commit -m "feat: add deterministic monthly plan recommendation engine"
```

---

### Task 3: Generate and Persist an Immutable Scenario

**Files:**
- Create: `backend/src/prisma/services/planning/monthlyPlanRecommendationService.js`
- Create: `backend/scripts/verify-monthly-plan-recommendation-service.js`
- Modify: `backend/src/prisma/services/planning/capacityPlanningService.js:2180-2195` only if a snapshot field required by the adapter is not currently exported.

**Interfaces:**
- Consumes: `buildCapacitySnapshot(prisma, { planNumber, startDate, endDate, planningMode: "PRODUCTION" })`.
- Consumes: `buildMonthlyPlanRecommendation(input)` from Task 2.
- Produces: `generateRecommendationScenario(prisma, { planNumber, actor })`.
- Produces: `getActiveRecommendationScenario(prisma, planNumber)` and `getRecommendationScenario(prisma, scenarioId)`.
- Produces: `adaptCapacitySnapshot({ plan, snapshot }) -> RecommendationInput`.
- Produces: `scenarioStatus(summary) -> scenario status string`.
- Produces: constant `RULE_VERSION = "MPP-BACKWARD-FG-DUE-V1"`.

- [ ] **Step 1: Write a RED service lifecycle test with a stateful fake Prisma client**

```js
const scenario = await generateRecommendationScenario(fakePrisma, { planNumber: "MPP-202609-001", actor: "ppic" });
assert.strictEqual(scenario.status, "READY_WITH_OVERLOAD");
assert.strictEqual(scenario.ruleVersion, "MPP-BACKWARD-FG-DUE-V1");
assert.strictEqual(fakePrisma.productionPlanAllocation.create.calls.length, 0,
  "generation must not mutate official allocations");
const repeated = await generateRecommendationScenario(fakePrisma, { planNumber: "MPP-202609-001", actor: "ppic" });
assert.strictEqual(repeated.id, scenario.id, "same plan version must reuse active scenario");
```

The fake must implement scenario/item `findFirst`, `create`, `update`, `createMany`, plan lookup, and `$transaction` while recording calls.

- [ ] **Step 2: Run the service contract and verify RED**

Run: `node scripts/verify-monthly-plan-recommendation-service.js`  
Expected: FAIL because the scenario service is absent.

- [ ] **Step 3: Implement snapshot adaptation and status derivation**

```js
const RULE_VERSION = "MPP-BACKWARD-FG-DUE-V1";
const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const scenarioStatus = (summary) => summary.materialQueueQty > 0
  ? "MATERIAL_QUEUE"
  : summary.overloadCellCount > 0 ? "READY_WITH_OVERLOAD" : "READY";

async function buildRecommendationInput(prisma, plan) {
  const snapshot = await buildCapacitySnapshot(prisma, {
    planNumber: plan.planNumber,
    startDate: plan.periodStart,
    endDate: plan.periodEnd,
    planningMode: "PRODUCTION",
  });
  return adaptCapacitySnapshot({ plan, snapshot });
}
```

The adapter must include official allocations, unallocated route catalog, FG dates, canonical route IDs, input-part ratios, stock balances, vendor return dates, machine eligibility, calendar capacity, and vendor MOQ/order multiple. Store only source revision identifiers and normalized scheduling inputs in `inputSnapshot`; do not serialize Prisma objects with cycles.

- [ ] **Step 4: Implement idempotent scenario generation**

```js
async function generateRecommendationScenario(prisma, { planNumber, actor }) {
  const plan = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber, isDeleted: false } });
  if (!plan) throw httpError(404, "Monthly Production Plan tidak ditemukan.");
  const reusable = await prisma.monthlyPlanRecommendationScenario.findFirst({
    where: { planId: plan.id, basePlanUpdatedAt: plan.updatedAt, ruleVersion: RULE_VERSION,
      status: { in: ["READY", "READY_WITH_OVERLOAD", "MATERIAL_QUEUE", "PARTIALLY_APPLIED"] } },
    include: { items: { orderBy: { sequence: "asc" } } },
  });
  if (reusable) return reusable;
  const input = await buildRecommendationInput(prisma, plan);
  const scenario = await prisma.monthlyPlanRecommendationScenario.create({
    data: { planId: plan.id, basePlanUpdatedAt: plan.updatedAt, ruleVersion: RULE_VERSION,
      status: "CALCULATING", inputSnapshot: input.auditSnapshot, createdBy: actor },
  });
  try {
    const result = buildMonthlyPlanRecommendation(input);
    await prisma.$transaction([
      prisma.monthlyPlanRecommendationItem.createMany({
        data: result.items.map((item) => ({ ...item, scenarioId: scenario.id })),
      }),
      prisma.monthlyPlanRecommendationScenario.update({
        where: { id: scenario.id }, data: { status: scenarioStatus(result.summary), summary: result.summary },
      }),
    ]);
    return getRecommendationScenario(prisma, scenario.id);
  } catch (error) {
    await prisma.monthlyPlanRecommendationScenario.update({
      where: { id: scenario.id }, data: { status: "FAILED", errorMessage: error.message },
    });
    throw error;
  }
}
```

- [ ] **Step 5: Run service tests and verify GREEN**

Run: `node scripts/verify-monthly-plan-recommendation-service.js`  
Expected: lifecycle, idempotency, failure isolation, and official-allocation non-mutation assertions pass.

- [ ] **Step 6: Commit generation service**

```bash
git add src/prisma/services/planning/monthlyPlanRecommendationService.js src/prisma/services/planning/capacityPlanningService.js scripts/verify-monthly-plan-recommendation-service.js
git commit -m "feat: generate versioned monthly plan recommendations"
```

---

### Task 4: Apply Selected Proposals Through Capacity Editor

**Files:**
- Modify: `backend/src/prisma/services/planning/capacityEditSessionService.js`
- Modify: `backend/src/prisma/services/planning/monthlyPlanRecommendationService.js`
- Modify: `backend/scripts/verify-capacity-edit-session.js`
- Modify: `backend/scripts/verify-monthly-plan-recommendation-service.js`

**Interfaces:**
- Produces: `stageRecommendationChanges(client, { sessionId, changes, actor })`.
- Produces: `applyRecommendationScenario(prisma, { scenarioId, actor, selection })`.
- Produces: `discardRecommendationScenario(prisma, { scenarioId, actor })`.
- `selection` shape: `{ mode: "ALL"|"WORK_CENTER"|"ITEMS", workCenterIds?: string[], itemIds?: string[] }`.

- [ ] **Step 1: Write RED contracts for all, Work Center, and selected apply**

```js
const applied = await applyRecommendationScenario(fakePrisma, {
  scenarioId: "scenario-1",
  actor: "ppic",
  selection: { mode: "WORK_CENTER", workCenterIds: ["wc-weld"] },
});
assert.strictEqual(applied.session.status, "OPEN");
assert.deepStrictEqual(applied.stagedChanges.map((row) => row.type), ["MOVE_ALLOCATION", "ALLOCATE_REMAINING"]);
assert.strictEqual(applied.scenario.status, "PARTIALLY_APPLIED");
assert.strictEqual(fakePrisma.productionPlanAllocation.update.calls.length, 0);
```

Also assert stale `basePlanUpdatedAt` returns status code 409 and that `DISCARDED`/`APPLIED` scenarios cannot be applied again.
In the same stateful fixture, generate → partial apply → cancel editor → apply all → commit editor and assert official allocation counts remain `1` until the final editor commit, then become `3`. Assert `D+1`, carry-over, vendor MOQ block, and overload proposal preservation in that flow.

- [ ] **Step 2: Run the apply contract and verify RED**

Run: `node scripts/verify-monthly-plan-recommendation-service.js`  
Expected: FAIL because apply/discard methods are absent.

- [ ] **Step 3: Add atomic batch staging to Capacity Editor**

```js
async function stageRecommendationChanges(client, { sessionId, changes, actor }) {
  const staged = [];
  for (const change of changes) {
    validateChangeForScope("PLAN", change);
    staged.push(await stagePersistentChange(client, {
      sessionId,
      change: { ...change, recommendationSource: true },
      actor,
    }));
  }
  return staged;
}
```

Use the existing session plan-version validation on every stage. Recommendation items map as follows: `NEW_ALLOCATION -> ALLOCATE_REMAINING`, `MOVE_ALLOCATION -> MOVE_ALLOCATION`, and `SPLIT_ALLOCATION -> SPLIT_ALLOCATION`. Queue and exception items are not staged as allocation changes.

- [ ] **Step 4: Implement selection, optimistic locking, apply status, and discard**

```js
const selectItems = (items, selection) => {
  if (selection.mode === "ALL") return items.filter((item) => item.changeType && item.applyStatus === "PENDING");
  if (selection.mode === "WORK_CENTER") return items.filter((item) => item.changeType && selection.workCenterIds.includes(item.workCenterId) && item.applyStatus === "PENDING");
  return items.filter((item) => item.changeType && selection.itemIds.includes(item.id) && item.applyStatus === "PENDING");
};
```

Open/reuse a PLAN Capacity Editor session with `openPersistentSession`, stage selected proposals, set selected item statuses to `APPLIED`, and derive `APPLIED` versus `PARTIALLY_APPLIED` from remaining `PENDING` change items. Discard is allowed only before full apply and records actor/time without deleting history.

- [ ] **Step 5: Verify Capacity Editor Undo/Cancel remains authoritative**

Run: `node scripts/verify-capacity-edit-session.js && node scripts/verify-monthly-plan-recommendation-service.js`  
Expected: recommendation stages appear in preview, Undo removes the last stage, Cancel restores the original allocation snapshot, and no official allocation is updated before commit.

- [ ] **Step 6: Commit the apply flow**

```bash
git add src/prisma/services/planning/capacityEditSessionService.js src/prisma/services/planning/monthlyPlanRecommendationService.js scripts/verify-capacity-edit-session.js scripts/verify-monthly-plan-recommendation-service.js
git commit -m "feat: apply recommendations through capacity editor"
```

---

### Task 5: Expose Recommendation Lifecycle APIs

**Files:**
- Create: `backend/src/prisma/controllers/planning/MonthlyPlanRecommendationController.js`
- Modify: `backend/src/prisma/routes/planning/monthly-production-plans.js:1-40`
- Create: `backend/scripts/verify-monthly-plan-recommendation-api.js`

**Interfaces:**
- Consumes: Task 3 and Task 4 service methods.
- Produces the five endpoints defined by the approved spec.
- Produces: `createHandlers(service)` and `validateSelection(value)`.

- [ ] **Step 1: Write RED tests against injectable HTTP handlers**

```js
const assert = require("assert");
const { createHandlers } = require("../src/prisma/controllers/planning/MonthlyPlanRecommendationController");
const fakeResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(value) { this.body = value; return this; },
});
const failNext = (error) => { throw error; };
const handlers = createHandlers({
  generateRecommendationScenario: async () => ({ id: "s1", status: "READY" }),
  getActiveRecommendationScenario: async () => ({ id: "s1" }),
  getRecommendationScenario: async () => ({ id: "s1", items: [] }),
  applyRecommendationScenario: async () => ({ scenario: { status: "APPLIED" }, session: { id: "e1" } }),
  discardRecommendationScenario: async () => ({ id: "s1", status: "DISCARDED" }),
});
const response = fakeResponse();
await handlers.generate({ params: { planNumber: "MPP-1" }, user: { username: "ppic" } }, response, failNext);
assert.strictEqual(response.statusCode, 201);
assert.strictEqual(response.body.status, "READY");
```

Add literal 400 assertions for invalid selection mode and empty Work Center/item selection.

- [ ] **Step 2: Run the API contract and verify RED**

Run: `node scripts/verify-monthly-plan-recommendation-api.js`  
Expected: FAIL because the controller module is absent.

- [ ] **Step 3: Implement thin handlers with explicit request validation**

```js
const { prisma } = require("../../index");
const recommendationService = require("../../services/planning/monthlyPlanRecommendationService");

function createHandlers(service) {
  const actor = (req) => req.user?.username || req.user?.email || req.user?.id || "system";
  return {
    generate: async (req, res, next) => {
      try { res.status(201).json(await service.generateRecommendationScenario(prisma, { planNumber: req.params.planNumber, actor: actor(req) })); }
      catch (error) { next(error); }
    },
    apply: async (req, res, next) => {
      try {
        const selection = validateSelection(req.body?.selection);
        res.json(await service.applyRecommendationScenario(prisma, { scenarioId: req.params.scenarioId, actor: actor(req), selection }));
      } catch (error) { next(error); }
    },
    active: async (req, res, next) => {
      try {
        const scenario = await service.getActiveRecommendationScenario(prisma, req.params.planNumber);
        if (!scenario) return res.status(404).json({ message: "Scenario recommendation aktif tidak ditemukan." });
        return res.json(scenario);
      } catch (error) { return next(error); }
    },
    detail: async (req, res, next) => {
      try { return res.json(await service.getRecommendationScenario(prisma, req.params.scenarioId)); }
      catch (error) { return next(error); }
    },
    discard: async (req, res, next) => {
      try { return res.json(await service.discardRecommendationScenario(prisma, { scenarioId: req.params.scenarioId, actor: actor(req) })); }
      catch (error) { return next(error); }
    },
  };
}

module.exports = { ...createHandlers(recommendationService), createHandlers, validateSelection };
```

`validateSelection` accepts only `ALL`, non-empty `WORK_CENTER`, or non-empty `ITEMS`; it throws an error carrying `statusCode = 400` for every other payload.

- [ ] **Step 4: Register routes before the final `/:planNumber` route**

```js
router.post("/:planNumber/recommendations", authorize("monthlyProductionPlan", "update"), guardPlan, logger("monthlyProductionPlan", "recommendation-generate"), recommendation.generate);
router.get("/:planNumber/recommendations/active", authorize("monthlyProductionPlan", "read"), recommendation.active);
router.get("/recommendations/:scenarioId", authorize("monthlyProductionPlan", "read"), recommendation.detail);
router.post("/recommendations/:scenarioId/apply", authorize("monthlyProductionPlan", "update"), logger("monthlyProductionPlan", "recommendation-apply"), recommendation.apply);
router.post("/recommendations/:scenarioId/discard", authorize("monthlyProductionPlan", "update"), logger("monthlyProductionPlan", "recommendation-discard"), recommendation.discard);
```

- [ ] **Step 5: Run API and syntax verification GREEN**

Run: `node scripts/verify-monthly-plan-recommendation-api.js && node --check src/prisma/controllers/planning/MonthlyPlanRecommendationController.js && node --check src/prisma/routes/planning/monthly-production-plans.js`  
Expected: all commands exit 0.

- [ ] **Step 6: Commit API layer**

```bash
git add src/prisma/controllers/planning/MonthlyPlanRecommendationController.js src/prisma/routes/planning/monthly-production-plans.js scripts/verify-monthly-plan-recommendation-api.js
git commit -m "feat: expose monthly plan recommendation API"
```

---

### Task 6: Build the Frontend Scenario Model and Matrix Projection

**Files:**
- Create: `frontend/public/js/ppic-monthly-recommendation.js`
- Create: `frontend/scripts/verify-mpp-recommendation.js`
- Modify: `frontend/public/js/ppic-monthly-capacity-editor.js`
- Modify: `frontend/scripts/verify-mpp-capacity-editor.js`

**Interfaces:**
- Produces global/CommonJS `MppRecommendation`.
- Produces `normalizeScenario(payload)`, `getScenarioSummary(scenario)`, `selectRecommendationItems(scenario, selection)`, `projectRecommendationRows(rows, scenario)`, `renderScenarioBadge(scenario)`, and `renderMaterialQueue(items)`.
- Produces internal `applyProposalToRows(rows, item)` using allocation ID before part/process fallback.
- Extends `MppCapacityEditor.projectStagedMatrix` to display `MOVE_ALLOCATION` and `SPLIT_ALLOCATION` after apply.

- [ ] **Step 1: Write RED projection and selection tests**

```js
const { projectRecommendationRows, selectRecommendationItems } = require("../public/js/ppic-monthly-recommendation");
const projected = projectRecommendationRows(matrixRows, scenarioFixture);
assert.strictEqual(projected[0].children[0].days["2026-09-08"].recommended, true);
assert.strictEqual(projected[0].children[0].days["2026-09-08"].qty, 191);
assert.strictEqual(projected[0].children[0].days["2026-09-01"].qty, 0,
  "moved allocation must be removed from origin in preview");
assert.strictEqual(matrixRows[0].children[0].days["2026-09-01"].qty, 191,
  "preview must not mutate official matrix rows");
assert.deepStrictEqual(selectRecommendationItems(scenarioFixture, { mode: "WORK_CENTER", workCenterIds: ["wc-insp"] }).map((row) => row.id), ["item-insp"]);
```

- [ ] **Step 2: Run frontend model test and verify RED**

Run: `node scripts/verify-mpp-recommendation.js`  
Expected: FAIL because the browser model does not exist.

- [ ] **Step 3: Implement immutable projection and summary helpers**

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MppRecommendation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const copy = (value) => JSON.parse(JSON.stringify(value));
function projectRecommendationRows(rows, scenario) {
    const projected = copy(rows || []);
    for (const item of scenario?.items || []) applyProposalToRows(projected, item);
    return projected;
  }

  function findAllocationCell(rows, allocationId) {
    for (const row of rows) for (const child of row.children || []) for (const [date, day] of Object.entries(child.days || {})) {
      const allocation = (day.allocations || []).find((entry) => entry.allocationId === allocationId);
      if (allocation) return { row, child, date, day, allocation };
    }
    return null;
  }

  function applyProposalToRows(rows, item) {
    if (!item.changeType) return;
    const source = item.sourceAllocationId ? findAllocationCell(rows, item.sourceAllocationId) : null;
    const movedQty = Number(item.proposedValue.qty || 0);
    if (source && ["MOVE_ALLOCATION", "SPLIT_ALLOCATION"].includes(item.changeType)) {
      source.day.qty = Math.max(Number(source.day.qty || 0) - movedQty, 0);
      source.day.recommendationMoved = true;
    }
    const targetRow = rows.find((row) => row.key === item.proposedValue.targetRowKey);
    const targetChild = targetRow?.children?.find((child) => child.key === item.proposedValue.targetChildKey);
    if (!targetRow || !targetChild) return;
    const targetDay = targetChild.days[item.proposedValue.targetDate] ||= { qty: 0, minutes: 0, allocations: [], uomCodes: [] };
    targetDay.qty = Number(targetDay.qty || 0) + movedQty;
    targetDay.recommended = true;
    targetDay.recommendationOverload = Boolean(item.proposedValue.overload);
  }
  return { normalizeScenario, getScenarioSummary, selectRecommendationItems, projectRecommendationRows, renderScenarioBadge, renderMaterialQueue };
});
```

Projection must support new, move, and split items; mark destination cells `recommended`, origin cells `recommendationMoved`, and overload cells `recommendationOverload`. Queue items never create dated cell quantity.

- [ ] **Step 4: Extend staged editor projection for applied move/split**

Add literal tests proving `projectStagedMatrix` subtracts moved quantity from its source allocation, adds it to the target date/resource, and leaves the official snapshot unchanged. Use allocation ID lookup rather than part-code-only matching.

- [ ] **Step 5: Run both frontend model suites GREEN**

Run: `node scripts/verify-mpp-recommendation.js && node scripts/verify-mpp-capacity-editor.js`  
Expected: all projection, selection, and immutability assertions pass.

- [ ] **Step 6: Register the frontend test command**

```json
"test:mpp-recommendation": "node scripts/verify-mpp-recommendation.js"
```

- [ ] **Step 7: Commit frontend domain model**

```bash
git add public/js/ppic-monthly-recommendation.js public/js/ppic-monthly-capacity-editor.js scripts/verify-mpp-recommendation.js scripts/verify-mpp-capacity-editor.js package.json
git commit -m "feat: project monthly plan recommendation scenarios"
```

---

### Task 7: Add Recommendation Preview and Apply Controls to Monthly Plan

**Files:**
- Modify: `frontend/views/ppic/monthly-production-plan.ejs:10-55`
- Modify: `frontend/public/js/ppic-monthly-production-plan.js`
- Modify: `frontend/public/css/ppic-monthly-production-plan.css`
- Modify: `frontend/scripts/verify-monthly-production-plan-page.js`
- Modify: `frontend/scripts/verify-mpp-recommendation.js`
- Modify: `frontend/src/routes/modules.js:583`

**Interfaces:**
- Consumes: recommendation API from Task 5 and `MppRecommendation` from Task 6.
- Produces: scenario preview, queue drawer, all/Work Center/selected apply, and discard interactions.
- Produces: page-level `setRecommendationBusy(busy)` while rendering labels through `MppRecommendation.renderScenarioBadge` and `MppRecommendation.renderMaterialQueue`.

- [ ] **Step 1: Add RED page behavior assertions**

Assert these user-visible contracts from rendered helpers and DOM fixtures:

```js
const { renderScenarioBadge, renderMaterialQueue } = require("../public/js/ppic-monthly-recommendation");
assert.strictEqual(renderScenarioBadge({ status: "READY_WITH_OVERLOAD" }), "READY · OVERLOAD");
assert.strictEqual(renderMaterialQueue([{ qty: 23, uomCode: "PCS", earliestAvailableDate: "2026-10-01" }]).includes("23 PCS"), true);
assert.strictEqual(renderMaterialQueue([{ qty: 23, uomCode: "PCS", earliestAvailableDate: "2026-10-01" }]).includes("01 Okt 2026"), true);
```

Add page structure assertions for IDs `mpp-recommendation-generate`, `mpp-recommendation-bar`, `mpp-recommendation-apply-all`, `mpp-recommendation-apply-selected`, `mpp-recommendation-discard`, and `mpp-material-queue-dialog`.

- [ ] **Step 2: Run UI contracts and verify RED**

Run: `node scripts/verify-mpp-recommendation.js && node scripts/verify-monthly-production-plan-page.js`  
Expected: FAIL because controls and renderers are absent.

- [ ] **Step 3: Add recommendation markup before the existing editor footer**

```html
<button id="mpp-recommendation-generate" class="mpp-outline-button" type="button">✦ Generate Recommendation</button>
<aside id="mpp-recommendation-bar" class="mpp-recommendation-bar" hidden aria-live="polite">
  <div class="mpp-recommendation-summary" id="mpp-recommendation-summary"></div>
  <div class="mpp-recommendation-actions">
    <button id="mpp-recommendation-queue" class="mpp-outline-button" type="button">Material Queue</button>
    <button id="mpp-recommendation-discard" class="mpp-outline-button danger" type="button">Discard Scenario</button>
    <button id="mpp-recommendation-apply-selected" class="mpp-outline-button" type="button">Apply Selected</button>
    <button id="mpp-recommendation-apply-all" class="mpp-primary-button" type="button">Apply All</button>
  </div>
</aside>
```

Load `/js/ppic-monthly-recommendation.js` before the page script.

- [ ] **Step 4: Add explicit recommendation state and API orchestration**

```js
const state = { data: null, collapsed: new Set(), search: "", type: "", editor: null,
  stagedChanges: [], recommendation: null, selectedRecommendationIds: new Set() };

async function generateRecommendation() {
  const plan = selectedEditorPlan();
  setRecommendationBusy(true);
  try {
    state.recommendation = window.MppRecommendation.normalizeScenario(await api(
      `/modules/api/planning-ppic/monthly-plan/${encodeURIComponent(plan.planNumber)}/recommendations`,
      { method: "POST", body: {} },
    ));
    render();
  } finally { setRecommendationBusy(false); }
}
```

On load, fetch the active scenario for the selected plan; treat 404 as no active scenario. `visibleRows()` must project recommendation rows before filters. Apply sends the selected mode, receives the open editor session plus staged changes, clears recommendation preview, and switches to the existing Editor Draft footer. Discard asks for confirmation, calls the discard endpoint, and restores the official matrix.

- [ ] **Step 5: Render reason, moved trace, overload, queue, and sticky summary**

Add these exact state styles; keep existing matrix sizing and responsive scroll behavior unchanged:

```css
.mpp-recommended-cell{background:#eef4ff!important;box-shadow:inset 0 -3px #2f58c7}
.mpp-recommendation-moved{background:#fff7ed!important;box-shadow:inset 0 -3px #f59e0b}
.mpp-recommendation-overload{background:#fee2e2!important;box-shadow:inset 0 -3px #dc2626}
.mpp-material-queue-item{display:grid;grid-template-columns:minmax(180px,1fr) repeat(3,minmax(90px,auto));gap:10px;padding:10px;border-bottom:1px solid #d8e0ec}
```

The sticky summary renders literal counts for FG on-time/late, new, moved/split, overload, Material Queue, and carry-over. Selection checkboxes are disabled for `MATERIAL_QUEUE`, `CARRY_OVER`, and exception items.

- [ ] **Step 6: Run UI tests GREEN and syntax checks**

Run: `node scripts/verify-mpp-recommendation.js && node scripts/verify-monthly-production-plan-page.js && node --check public/js/ppic-monthly-production-plan.js`  
Expected: all commands exit 0.

- [ ] **Step 7: Update cache versions and commit UI**

Set both recommendation/model script versions to `v=20260824-mpp-recommendation-1` in the EJS view and `src/routes/modules.js`.

```bash
git add views/ppic/monthly-production-plan.ejs public/js/ppic-monthly-production-plan.js public/css/ppic-monthly-production-plan.css scripts/verify-mpp-recommendation.js scripts/verify-monthly-production-plan-page.js src/routes/modules.js
git commit -m "feat: add monthly plan recommendation preview"
```

---

### Task 8: Run Release-Readiness Verification

**Files:**
- Verify: `backend/scripts/verify-monthly-plan-recommendation-service.js`
- Verify: `backend/package.json`
- Verify: `frontend/package.json`

**Interfaces:**
- Verifies the complete generate → preview → partial apply → Undo/Cancel → apply all → Save boundary.

- [ ] **Step 1: Confirm the end-to-end state-transition assertions created in Task 4**

The Task 4 fixture must contain these literal assertions before release verification begins:

```js
assert.strictEqual(generated.officialAllocationCount, 1);
assert.strictEqual(partial.scenario.status, "PARTIALLY_APPLIED");
assert.strictEqual(partial.session.changes.length, 1);
assert.strictEqual(cancelled.session.status, "CANCELLED");
assert.strictEqual(cancelled.officialAllocationCount, 1);
assert.strictEqual(applied.scenario.status, "APPLIED");
assert.strictEqual(beforeEditorCommit.officialAllocationCount, 1);
assert.strictEqual(afterEditorCommit.officialAllocationCount, 3);
```

The same fixture must assert `D+1`, carry-over, vendor MOQ block, stale plan rejection, and capacity-overload proposal preservation.

- [ ] **Step 2: Run full backend recommendation and MPP regressions**

Run: `npm run test:mpp-recommendation && npm run test:mpp-capacity-editor && npm run test:production-plan-owner-month` from `backend`.  
Expected: all suites exit 0.

- [ ] **Step 3: Run the complete frontend build**

Add `npm run test:mpp-recommendation` to the frontend `build` chain immediately before `test:mpp-capacity-editor`, then run: `npm run build`.  
Expected: encoding, shared UI, PPIC pages, recommendation, editor, syntax, and remaining build checks all exit 0.

- [ ] **Step 4: Validate Prisma migration without changing production data**

Run: `npx prisma validate && npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code`.  
Expected: schema validates and migration history represents the final schema without an unplanned diff.

- [ ] **Step 5: Record clean verification evidence**

Capture the exit codes and final pass lines from Steps 2–4 in the implementation handoff. If any command fails, return to the task that owns the failed contract; do not add automatic recovery, overtime, or capacity-based rejection while repairing it.
