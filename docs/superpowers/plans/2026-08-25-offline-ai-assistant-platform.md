# Offline AI Assistant Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a replaceable, fully offline Qwen assistant that can read authorized ERP data and create validated drafts for PPIC, Inventory, Purchasing, and Production without bypassing official workflows.

**Architecture:** The Express backend owns authentication, page context, capability execution, validation, drafts, audit, and persistence. A supervised `node-llama-cpp` child process receives sanitized IPC requests and returns schema-constrained output; it never imports Prisma or receives ERP credentials. The EJS frontend adds one global assistant drawer plus contextual actions, while existing module services remain authoritative.

**Tech Stack:** Node.js 22.14, Express 5, CommonJS services, one ESM AI worker, Prisma 7/PostgreSQL, `node-llama-cpp` 3.19.1, Ajv 8.17.1, EJS, Bootstrap 5, vanilla JavaScript.

**Spec:** `backend/docs/superpowers/specs/2026-08-25-offline-ai-assistant-platform-design.md`

## Global Constraints

- Do not introduce CP-SAT, Ollama, cloud inference, or a direct model-to-database path.
- The initial model profile is Qwen3-4B GGUF Q4_K_M, CPU-only, context 4,096, chat output at most 800 tokens, recommendation output at most 1,200 tokens.
- Run one inference at a time, permit at most two pending requests per user and 20 globally, and use 45-second chat and 90-second recommendation timeouts.
- Keep `AI_ASSISTANT_ENABLED=false` by default; normal ERP startup and every non-AI workflow must work without a model file or native AI runtime.
- Resolve model files only inside `AI_MODEL_DIR`; never accept an arbitrary path, URL, automatic model download, SQL, shell, Prisma client, or unrestricted HTTP client from model output.
- AI operation classes are `READ`, `ANALYZE`, and `DRAFT`; `FINAL_MUTATION` is always rejected.
- Every capability call must reuse the same role/page/resource/action permission semantics as `backend/src/prisma/middleware/auth.js`.
- Every draft is `AI_GENERATED · WAITING_CONFIRMATION`; posting, approval, release, capacity adoption, shortage override, DPP generation, stock mutation, and master-data mutation remain official user actions.
- Ordinary conversation expires after 30 days; business-action audit follows ERP retention and is not removed with conversation cleanup.
- Model GGUF files are deployment artifacts and must never be added to Git.
- Preserve the existing dirty backend and frontend worktrees; stage and commit only files named in the current task.

---

## File and Interface Map

### Backend persistence

- `backend/prisma/schema.prisma`: six AI persistence models and optional AI provenance on Monthly Plan recommendation scenarios.
- `backend/prisma/migrations/20260825100000_add_offline_ai_assistant_core/migration.sql`: tables, indexes, and foreign keys.

### Backend runtime

- `backend/src/prisma/ai/aiContracts.js`: IPC envelopes, runtime states, operation classes, and JSON schemas.
- `backend/src/prisma/ai/worker.mjs`: the only file that imports `node-llama-cpp`.
- `backend/src/prisma/services/ai/aiModelProfileService.js`: allowlisted model resolution, checksum, lifecycle, benchmark, activation, rollback.
- `backend/src/prisma/services/ai/aiRequestQueue.js`: one-running queue with user/global bounds and cancellation.
- `backend/src/prisma/services/ai/aiRuntimeSupervisor.js`: worker lifecycle, sanitized environment, timeouts, memory monitoring, and status.
- `backend/src/prisma/services/ai/permissionEvaluator.js`: reusable authorization predicate shared with route middleware.
- `backend/src/prisma/services/ai/capabilityRegistry.js`: stable capability definitions.
- `backend/src/prisma/services/ai/capabilityGateway.js`: permission/schema enforcement and audited adapter execution.
- `backend/src/prisma/services/ai/promptRegistry.js`: versioned system prompts and output schemas.
- `backend/src/prisma/services/ai/aiConversationService.js`: conversations, messages, requests, polling, cancellation, and retention.
- `backend/src/prisma/services/ai/aiDraftService.js`: draft ownership, review, rejection, expiry, and confirmation provenance invoked only by official module services.
- `backend/src/prisma/services/ai/aiOrchestrator.js`: bounded tool loop and structured workflow generation.
- `backend/src/prisma/controllers/ai/AiAssistantController.js`: assistant endpoints.
- `backend/src/prisma/controllers/ai/AiModelProfileController.js`: super-admin profile endpoints.
- `backend/src/prisma/routes/ai.js`: authenticated assistant and admin routes.

### Capability adapters

- `backend/src/prisma/services/ai/capabilities/inventoryCapabilities.js`
- `backend/src/prisma/services/ai/capabilities/purchasingCapabilities.js`
- `backend/src/prisma/services/ai/capabilities/productionCapabilities.js`
- `backend/src/prisma/services/ai/capabilities/ppicCapabilities.js`
- `backend/src/prisma/services/ai/capabilities/capacityCapabilities.js`

Each module exports `register<Module>Capabilities(registry, dependencies)` and registers adapters with this interface:

```js
{
  code: "inventory.get_stock_summary",
  operationClass: "READ",
  permission: { moduleCode: "inventory", pageCode: "stock-balances", resourceCode: "stockBalance", action: "read" },
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  outputSchema: { type: "object", additionalProperties: false, properties: {} },
  maxRows: 100,
  execute: async ({ prisma, input, user, pageContext }) => ({ data, sources })
}
```

### Frontend

- `frontend/src/routes/ai.js`: proxy with 15-second status and 100-second operation limits.
- `frontend/views/partials/ai-assistant.ejs`: global drawer.
- `frontend/public/js/ai-assistant-model.js`: pure state/projection helpers.
- `frontend/public/js/ai-assistant.js`: drawer, context, queue polling, citations, and draft cards.
- `frontend/public/css/ai-assistant.css`: responsive enterprise drawer/bottom sheet.
- `frontend/views/master-data/ai-model-profiles.ejs`: super-admin model registry.
- `frontend/public/js/ai-model-profiles.js`: profile health check, benchmark, activation, rollback.
- Existing PPIC/Inventory/Purchasing/Production pages: contextual action hooks only; assistant rendering stays shared.

---

### Task 1: Add AI Persistence and Provenance

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20260825100000_add_offline_ai_assistant_core/migration.sql`
- Create: `backend/scripts/verify-ai-assistant-schema.js`
- Modify: `backend/package.json`

**Interfaces:**
- Produces Prisma delegates: `aiModelProfile`, `aiConversation`, `aiMessage`, `aiRequest`, `aiCapabilityCall`, and `aiDraft`.
- Adds nullable `generationSource`, `aiRequestId`, `modelProfileCode`, `promptVersion`, and `aiValidationSummary` fields to `MonthlyPlanRecommendationScenario`.

- [ ] **Step 1: Write the failing schema contract**

```js
// backend/scripts/verify-ai-assistant-schema.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
const migration = fs.readFileSync(path.join(root, "prisma/migrations/20260825100000_add_offline_ai_assistant_core/migration.sql"), "utf8");
for (const model of ["AiModelProfile", "AiConversation", "AiMessage", "AiRequest", "AiCapabilityCall", "AiDraft"]) {
  assert.match(schema, new RegExp(`model ${model} \\{`));
}
for (const table of ["tbl_ai_model_profile", "tbl_ai_conversation", "tbl_ai_message", "tbl_ai_request", "tbl_ai_capability_call", "tbl_ai_draft"]) {
  assert.match(migration, new RegExp(table));
}
assert.match(schema, /generationSource\s+String\?/);
assert.match(schema, /aiValidationSummary\s+Json\?/);
assert.match(schema, /rollbackProfileId\s+String\?/);
assert.match(schema, /generationSource\s+String\s+@default\("AI_GENERATED"\)/);
assert.match(schema, /AiCapabilityCall[\s\S]*conversation[\s\S]*onDelete: Restrict/);
console.log("AI assistant schema contract passed.");
```

- [ ] **Step 2: Run the contract and verify it fails**

Run: `cd backend && node scripts/verify-ai-assistant-schema.js`  
Expected: FAIL because the migration file or models do not exist.

- [ ] **Step 3: Add the Prisma models**

Add these model shapes, keeping string statuses so lifecycle values can evolve without a PostgreSQL enum migration:

```prisma
model AiModelProfile {
  id                         String   @id @default(uuid())
  profileCode                String   @unique @map("profile_code")
  displayName                String   @map("display_name")
  modelFamily                String   @map("model_family")
  ggufFileName               String   @map("gguf_file_name")
  sha256                     String?
  quantization               String
  promptCompatibilityVersion String   @map("prompt_compatibility_version")
  runtimeConfig              Json     @map("runtime_config")
  status                     String   @default("DRAFT")
  benchmarkResult            Json?    @map("benchmark_result")
  rollbackProfileId          String?  @map("rollback_profile_id")
  activatedBy                String?  @map("activated_by")
  activatedAt                DateTime? @map("activated_at")
  createdBy                  String?  @map("created_by")
  createdAt                  DateTime @default(now()) @map("created_at")
  updatedAt                  DateTime @updatedAt @map("updated_at")
  messages                   AiMessage[]
  requests                   AiRequest[]
  rollbackProfile            AiModelProfile? @relation("AiModelRollback", fields: [rollbackProfileId], references: [id], onDelete: SetNull)
  rollbackTargets            AiModelProfile[] @relation("AiModelRollback")
  @@index([status])
  @@map("tbl_ai_model_profile")
}

model AiConversation {
  id            String   @id @default(uuid())
  userId        String   @map("user_id")
  moduleCode    String   @map("module_code")
  pageCode      String   @map("page_code")
  recordKey     String?  @map("record_key")
  title         String?
  status        String   @default("ACTIVE")
  expiresAt     DateTime @map("expires_at")
  lastMessageAt DateTime @default(now()) @map("last_message_at")
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")
  messages      AiMessage[]
  requests      AiRequest[]
  capabilityCalls AiCapabilityCall[]
  drafts        AiDraft[]
  @@index([userId, status, lastMessageAt])
  @@index([expiresAt])
  @@map("tbl_ai_conversation")
}

model AiMessage {
  id             String   @id @default(uuid())
  conversationId String   @map("conversation_id")
  role           String
  content        String
  citations      Json?
  modelProfileId String?  @map("model_profile_id")
  promptVersion  String?  @map("prompt_version")
  runtimeMetrics Json?    @map("runtime_metrics")
  createdAt      DateTime @default(now()) @map("created_at")
  conversation   AiConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  modelProfile   AiModelProfile? @relation(fields: [modelProfileId], references: [id], onDelete: SetNull)
  userRequests   AiRequest[] @relation("AiRequestUserMessage")
  assistantRequests AiRequest[] @relation("AiRequestAssistantMessage")
  @@index([conversationId, createdAt])
  @@map("tbl_ai_message")
}

model AiRequest {
  id                 String   @id @default(uuid())
  conversationId     String   @map("conversation_id")
  userMessageId      String   @map("user_message_id")
  assistantMessageId String?  @map("assistant_message_id")
  modelProfileId     String?  @map("model_profile_id")
  requestType        String   @map("request_type")
  status             String   @default("QUEUED")
  priority           Int      @default(100)
  payload             Json
  errorCode           String?  @map("error_code")
  errorMessage        String?  @map("error_message")
  startedAt           DateTime? @map("started_at")
  finishedAt          DateTime? @map("finished_at")
  createdAt           DateTime @default(now()) @map("created_at")
  updatedAt           DateTime @updatedAt @map("updated_at")
  conversation        AiConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  userMessage         AiMessage @relation("AiRequestUserMessage", fields: [userMessageId], references: [id], onDelete: Restrict)
  assistantMessage    AiMessage? @relation("AiRequestAssistantMessage", fields: [assistantMessageId], references: [id], onDelete: SetNull)
  modelProfile        AiModelProfile? @relation(fields: [modelProfileId], references: [id], onDelete: SetNull)
  capabilityCalls     AiCapabilityCall[]
  drafts              AiDraft[]
  @@index([status, priority, createdAt])
  @@index([conversationId, createdAt])
  @@map("tbl_ai_request")
}

model AiCapabilityCall {
  id                String   @id @default(uuid())
  conversationId    String   @map("conversation_id")
  requestId         String   @map("request_id")
  capabilityCode    String   @map("capability_code")
  operationClass    String   @map("operation_class")
  status            String
  requestData       Json     @map("request_data")
  responseData      Json?    @map("response_data")
  permissionContext Json     @map("permission_context")
  sourceRefs        Json?    @map("source_refs")
  errorCode         String?  @map("error_code")
  durationMs        Int?     @map("duration_ms")
  createdAt         DateTime @default(now()) @map("created_at")
  conversation      AiConversation @relation(fields: [conversationId], references: [id], onDelete: Restrict)
  request           AiRequest @relation(fields: [requestId], references: [id], onDelete: Restrict)
  drafts            AiDraft[]
  @@index([requestId, createdAt])
  @@index([capabilityCode, createdAt])
  @@map("tbl_ai_capability_call")
}

model AiDraft {
  id                 String   @id @default(uuid())
  conversationId     String   @map("conversation_id")
  requestId          String   @map("request_id")
  capabilityCallId   String?  @map("capability_call_id")
  userId             String   @map("user_id")
  moduleCode         String   @map("module_code")
  pageCode           String   @map("page_code")
  draftType          String   @map("draft_type")
  generationSource   String   @default("AI_GENERATED") @map("generation_source")
  status             String   @default("WAITING_CONFIRMATION")
  payload             Json
  sourceRefs          Json?    @map("source_refs")
  validationSummary  Json     @map("validation_summary")
  expiresAt           DateTime @map("expires_at")
  confirmedBy         String?  @map("confirmed_by")
  confirmedAt         DateTime? @map("confirmed_at")
  rejectedBy          String?  @map("rejected_by")
  rejectedAt          DateTime? @map("rejected_at")
  officialEntityType String?   @map("official_entity_type")
  officialEntityId   String?   @map("official_entity_id")
  createdAt           DateTime @default(now()) @map("created_at")
  updatedAt           DateTime @updatedAt @map("updated_at")
  conversation        AiConversation @relation(fields: [conversationId], references: [id], onDelete: Restrict)
  request             AiRequest @relation(fields: [requestId], references: [id], onDelete: Restrict)
  capabilityCall      AiCapabilityCall? @relation(fields: [capabilityCallId], references: [id], onDelete: SetNull)
  @@index([userId, status, createdAt])
  @@index([moduleCode, pageCode, status])
  @@index([expiresAt])
  @@map("tbl_ai_draft")
}
```

- [ ] **Step 4: Add SQL migration and scenario provenance**

Create SQL matching the Prisma names and foreign-key delete behavior. Capability-call and draft foreign keys to conversations/requests must use `RESTRICT` so cleanup cannot erase business audit accidentally. Extend `MonthlyPlanRecommendationScenario` with:

```prisma
generationSource    String? @map("generation_source")
aiRequestId         String? @map("ai_request_id")
modelProfileCode    String? @map("model_profile_code")
promptVersion       String? @map("prompt_version")
aiValidationSummary Json?   @map("ai_validation_summary")
```

The SQL must add nullable columns to `tbl_monthly_plan_recommendation_scenario` and indexes on `ai_request_id` and `generation_source`. Add the self-referencing `rollback_profile_id` foreign key with `ON DELETE SET NULL` so the last successful active profile is explicit and auditable.

- [ ] **Step 5: Run schema verification**

Run: `cd backend && node scripts/verify-ai-assistant-schema.js && npx prisma validate`  
Expected: contract passes and Prisma reports a valid schema.

- [ ] **Step 6: Register the test command and commit**

Add `"test:ai-schema": "node scripts/verify-ai-assistant-schema.js"` to backend scripts.

```bash
git -C backend add package.json prisma/schema.prisma prisma/migrations/20260825100000_add_offline_ai_assistant_core scripts/verify-ai-assistant-schema.js
git -C backend commit -m "feat(ai): add assistant persistence schema"
```

---

### Task 2: Build Model Profile Validation, Activation, and Rollback

**Files:**
- Create: `backend/src/prisma/services/ai/aiModelProfileService.js`
- Create: `backend/src/prisma/controllers/ai/AiModelProfileController.js`
- Create: `backend/scripts/verify-ai-model-profiles.js`
- Modify: `backend/package.json`

**Interfaces:**
- Produces `createModelProfile(prisma, input, actor)`, `listModelProfiles(prisma)`, `listAllowlistedModelFiles(modelDir)`, `resolveModelFile(profile, modelDir)`, `recordProfileTest(prisma, id, result, actor)`, `activateModelProfile(prisma, id, runtime, actor)`, and `rollbackModelProfile(prisma, activeId, runtime, actor)`.
- `activateModelProfile` calls `runtime.probe(profile)` before a transaction marks the previous profile `INACTIVE`, activates the candidate, and stores the previous ID as `rollbackProfileId`.

- [ ] **Step 1: Write failing path and rollback tests**

```js
// backend/scripts/verify-ai-model-profiles.js
"use strict";
const assert = require("assert");
const path = require("path");
const { resolveModelFile, validateRuntimeConfig, createModelProfileService } = require("../src/prisma/services/ai/aiModelProfileService");
assert.throws(() => resolveModelFile({ ggufFileName: "../secret.gguf" }, "C:/erp/models"), /allowlist/i);
assert.strictEqual(resolveModelFile({ ggufFileName: "qwen3-4b-q4_k_m.gguf" }, "C:/erp/models"), path.resolve("C:/erp/models/qwen3-4b-q4_k_m.gguf"));
assert.deepStrictEqual(validateRuntimeConfig({ contextSize: 4096, maxTokens: 800, cpuThreads: 6, batchSize: 128 }), { contextSize: 4096, maxTokens: 800, cpuThreads: 6, batchSize: 128, gpuMode: "cpu", gpuLayers: 0, maxMemoryMb: 5120 });
const service = createModelProfileService({ fs: { readdirSync: () => ["qwen3-4b-q4_k_m.gguf", "notes.txt", "../secret.gguf"] }, modelDir: "C:/erp/models", runtime: { probe: async () => ({}) } });
assert.deepStrictEqual(service.listAllowlistedModelFiles(), ["qwen3-4b-q4_k_m.gguf"]);
// Use a fake Prisma transaction and runtime.probe that rejects; assert ACTIVE profile remains unchanged.
// Assert successful activation stores the previous profile as rollback target and rollback re-probes it before switching.
console.log("AI model profile contract passed.");
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd backend && node scripts/verify-ai-model-profiles.js`  
Expected: FAIL because `aiModelProfileService` does not exist.

- [ ] **Step 3: Implement allowlisted model resolution and bounded config**

```js
// backend/src/prisma/services/ai/aiModelProfileService.js
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
function httpError(statusCode, code, message) { return Object.assign(new Error(message), { statusCode, code }); }
function resolveModelFile(profile, modelDir) {
  const root = path.resolve(modelDir || "");
  const name = String(profile?.ggufFileName || "").trim();
  if (!root || !/^[A-Za-z0-9._-]+\.gguf$/i.test(name)) throw httpError(400, "AI_MODEL_PATH_DENIED", "Model harus berasal dari allowlist GGUF.");
  const resolved = path.resolve(root, name);
  if (path.dirname(resolved) !== root) throw httpError(400, "AI_MODEL_PATH_DENIED", "Model berada di luar allowlist.");
  return resolved;
}
function listAllowlistedModelFiles(modelDir, fsImpl = fs) {
  return fsImpl.readdirSync(path.resolve(modelDir || ""), { withFileTypes: false })
    .filter((name) => /^[A-Za-z0-9._-]+\.gguf$/i.test(name))
    .sort((left, right) => left.localeCompare(right));
}
function validateRuntimeConfig(value = {}) {
  const bounded = (number, min, max, fallback) => Math.min(Math.max(Number(number) || fallback, min), max);
  const gpuMode = ["cpu", "auto", "cuda", "vulkan"].includes(value.gpuMode) ? value.gpuMode : "cpu";
  return { contextSize: bounded(value.contextSize, 1024, 8192, 4096), maxTokens: bounded(value.maxTokens, 128, 1200, 800), cpuThreads: bounded(value.cpuThreads, 1, 64, 4), batchSize: bounded(value.batchSize, 32, 256, 128), gpuMode, gpuLayers: gpuMode === "cpu" ? 0 : bounded(value.gpuLayers, 0, 999, 0), maxMemoryMb: bounded(value.maxMemoryMb, 2048, 6144, 5120) };
}
async function sha256(file) { const hash = crypto.createHash("sha256"); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest("hex"); }
module.exports = { resolveModelFile, listAllowlistedModelFiles, validateRuntimeConfig, sha256, createModelProfileService };
```

Implement the service factory with dependency-injected `fs`, `modelDir`, and runtime so tests never need a real GGUF. `listAllowlistedModelFiles` returns basenames matching the same GGUF allowlist only; it never returns paths. The seeded Qwen profile remains `gpuMode: "cpu"`; CUDA/Vulkan/auto profiles are allowed only as future replacement profiles and still require benchmark/test success before activation.

- [ ] **Step 4: Implement controller handlers**

Use `createHandlers(service, prisma)` so list/create/test/activate/rollback handlers can be unit tested without the real database. Reject activation or rollback unless model load, schema, golden, permission, memory, and latency gates are all passing. A failed probe leaves the current `ACTIVE` profile unchanged.

- [ ] **Step 5: Run tests**

Run: `cd backend && node scripts/verify-ai-model-profiles.js`  
Expected: PASS, including traversal rejection and failed-probe rollback.

- [ ] **Step 6: Register command and commit**

Add `"test:ai-model-profiles": "node scripts/verify-ai-model-profiles.js"`.

```bash
git -C backend add package.json src/prisma/services/ai/aiModelProfileService.js src/prisma/controllers/ai/AiModelProfileController.js scripts/verify-ai-model-profiles.js
git -C backend commit -m "feat(ai): add replaceable model profiles"
```

---

### Task 3: Add the Isolated Worker, Queue, and Runtime Supervisor

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/package-lock.json`
- Create: `backend/src/prisma/ai/aiContracts.js`
- Create: `backend/src/prisma/ai/worker.mjs`
- Create: `backend/src/prisma/services/ai/aiRequestQueue.js`
- Create: `backend/src/prisma/services/ai/aiRuntimeSupervisor.js`
- Create: `backend/scripts/fixtures/fake-ai-worker.js`
- Create: `backend/scripts/verify-ai-runtime.js`
- Modify: `backend/server.js`

**Interfaces:**
- Produces singleton `aiRuntimeSupervisor` with `status()`, `probe(profile)`, `enqueue(job)`, `cancel(requestId, userId)`, `shutdown()`, and event `status`.
- `enqueue` resolves `{ text, json, metrics }` or rejects with typed `AI_TIMEOUT`, `AI_WORKER_CRASHED`, `AI_QUEUE_FULL`, or `AI_CANCELLED`.

- [ ] **Step 1: Install pinned dependencies**

Run: `cd backend && npm install --save-exact node-llama-cpp@3.19.1 ajv@8.17.1`  
Expected: package and lockfile contain exact versions; no model is downloaded by application startup.

- [ ] **Step 2: Write failing queue/supervisor tests**

```js
// backend/scripts/verify-ai-runtime.js
"use strict";
const assert = require("assert");
const { createAiRequestQueue } = require("../src/prisma/services/ai/aiRequestQueue");
const queue = createAiRequestQueue({ maxGlobalPending: 2, maxUserPending: 1 });
const first = queue.enqueue({ id: "r1", userId: "u1", priority: 100 });
assert.throws(() => queue.enqueue({ id: "r2", userId: "u1", priority: 100 }), (error) => error.code === "AI_USER_QUEUE_FULL");
queue.enqueue({ id: "r3", userId: "u2", priority: 10 });
assert.strictEqual(queue.takeNext().id, "r3");
assert.strictEqual(queue.cancel("r1", "u1"), true);
// Spawn fake worker: assert sanitized env omits DATABASE_URL/JWT_SECRET, timeout kills request, crash restarts once, and shutdown leaves OFFLINE.
void first;
console.log("AI runtime contract passed.");
```

- [ ] **Step 3: Run the runtime test and verify it fails**

Run: `cd backend && node scripts/verify-ai-runtime.js`  
Expected: FAIL because queue and supervisor modules do not exist.

- [ ] **Step 4: Implement IPC contracts and bounded queue**

```js
// backend/src/prisma/ai/aiContracts.js
"use strict";
const RUNTIME_STATE = Object.freeze({ OFFLINE: "OFFLINE", LOADING: "LOADING_MODEL", READY: "READY", BUSY: "BUSY", DEGRADED: "DEGRADED" });
const OPERATION_CLASS = Object.freeze({ READ: "READ", ANALYZE: "ANALYZE", DRAFT: "DRAFT", FINAL_MUTATION: "FINAL_MUTATION" });
function generateEnvelope(job) { return { type: "GENERATE", requestId: job.id, profile: job.profile, messages: job.messages, outputSchema: job.outputSchema, maxTokens: job.maxTokens, thinkingMode: job.thinkingMode, seed: job.seed }; }
module.exports = { RUNTIME_STATE, OPERATION_CLASS, generateEnvelope };
```

The queue keeps pending jobs in memory, orders by lower numeric priority then creation sequence, exposes position, rejects a third global pending request at the configured limit, and never preempts the running job.

- [ ] **Step 5: Implement `worker.mjs`**

The worker must be the only module importing `node-llama-cpp`:

```js
import { getLlama, LlamaChatSession } from "node-llama-cpp";
let loaded = null;
async function ensureModel(profile) {
  if (loaded?.profileCode === profile.profileCode) return loaded;
  if (loaded) await loaded.model.dispose();
  const gpu = profile.runtimeConfig.gpuMode === "cpu" ? false : profile.runtimeConfig.gpuMode;
  const llama = await getLlama({ gpu, maxThreads: profile.runtimeConfig.cpuThreads });
  const model = await llama.loadModel({ modelPath: profile.resolvedModelPath, gpuLayers: profile.runtimeConfig.gpuLayers });
  loaded = { profileCode: profile.profileCode, llama, model };
  return loaded;
}
process.on("message", async (message) => {
  if (message.type === "SHUTDOWN") { if (loaded) await loaded.model.dispose(); process.exit(0); }
  if (message.type !== "GENERATE") return;
  let context;
  try {
    const runtime = await ensureModel(message.profile);
    context = await runtime.model.createContext({ contextSize: message.profile.runtimeConfig.contextSize, sequences: 1, batchSize: message.profile.runtimeConfig.batchSize });
    const grammar = await runtime.llama.createGrammarForJsonSchema(message.outputSchema);
    const session = new LlamaChatSession({ contextSequence: context.getSequence() });
    session.setChatHistory(toNodeLlamaChatHistory(message.messages.slice(0, -1)));
    const text = await session.prompt(message.messages.at(-1).content, { grammar, maxTokens: message.maxTokens, temperature: message.thinkingMode === "bounded" ? 0.6 : 0.1, seed: message.seed });
    process.send({ type: "RESULT", requestId: message.requestId, text, json: grammar.parse(text) });
  } catch (error) {
    process.send({ type: "ERROR", requestId: message.requestId, code: "AI_GENERATION_FAILED", message: error.message });
  } finally {
    if (context) await context.dispose();
  }
});
```

Implement `toNodeLlamaChatHistory` as a strict mapper for only `system`, `user`, `assistant`, and sanitized `tool` messages, with length/token bounds and tool data represented as untrusted user-visible context. Use the documented public `session.setChatHistory(...)`, `llama.createGrammarForJsonSchema(schema)`, and `grammar.parse(text)` APIs. Keep the model resident, but create and dispose a fresh context for every request so prompts/history can never leak between users or conversations.

- [ ] **Step 6: Implement the supervisor**

Launch the child with an explicit sanitized environment containing only `PATH`, `SystemRoot`, `TEMP`, `TMP`, `NODE_ENV`, and AI-specific non-secret settings. Monitor RSS from worker heartbeat messages, terminate above profile `maxMemoryMb` after two consecutive samples, use one restart after crash, unload after 15 idle minutes, and leave startup lazy.

- [ ] **Step 7: Add graceful shutdown without making AI a startup dependency**

In `server.js`, import the singleton only after database/license startup, register `SIGINT` and `SIGTERM` handlers that call `aiRuntimeSupervisor.shutdown()`, and do not load a model during `startServer()`.

- [ ] **Step 8: Run runtime and syntax tests**

Run: `cd backend && node scripts/verify-ai-runtime.js && node --check server.js && node --check src/prisma/services/ai/aiRuntimeSupervisor.js`  
Expected: PASS without a real model.

- [ ] **Step 9: Commit**

```bash
git -C backend add package.json package-lock.json server.js src/prisma/ai src/prisma/services/ai/aiRequestQueue.js src/prisma/services/ai/aiRuntimeSupervisor.js scripts/fixtures/fake-ai-worker.js scripts/verify-ai-runtime.js
git -C backend commit -m "feat(ai): add isolated local inference runtime"
```

---

### Task 4: Extract Shared Permission Evaluation and Build Capability Gateway

**Files:**
- Create: `backend/src/prisma/services/ai/permissionEvaluator.js`
- Create: `backend/src/prisma/services/ai/capabilityRegistry.js`
- Create: `backend/src/prisma/services/ai/capabilityGateway.js`
- Modify: `backend/src/prisma/middleware/auth.js`
- Create: `backend/scripts/verify-ai-capability-gateway.js`
- Modify: `backend/package.json`

**Interfaces:**
- Produces `userHasPermission(user, requirement, pageContext) -> boolean` used by both `authorize()` and the gateway.
- Produces `createCapabilityRegistry()` and `createCapabilityGateway({ prisma, registry, auditStore })`.

- [ ] **Step 1: Write failing permission parity and gateway tests**

```js
// backend/scripts/verify-ai-capability-gateway.js
"use strict";
const assert = require("assert");
const { userHasPermission } = require("../src/prisma/services/ai/permissionEvaluator");
const { createCapabilityRegistry } = require("../src/prisma/services/ai/capabilityRegistry");
const { createCapabilityGateway } = require("../src/prisma/services/ai/capabilityGateway");
const user = { id: "u1", isSuperAdmin: false, roleAssignments: [{ isActive: true, role: { isActive: true, isDeleted: false, permissions: [{ moduleCode: "inventory", pageCode: "stock-balances", resourceCode: "stockBalance", actions: ["read"], isActive: true, isDeleted: false }] } }] };
assert.strictEqual(userHasPermission(user, { moduleCode: "inventory", pageCode: "stock-balances", resourceCode: "stockBalance", action: "read" }, { moduleCode: "inventory", pageCode: "stock-balances" }), true);
assert.strictEqual(userHasPermission(user, { moduleCode: "purchasing", pageCode: "purchase-order", resourceCode: "purchaseOrder", action: "read" }, { moduleCode: "purchasing", pageCode: "purchase-order" }), false);
// Register one READ adapter, assert valid execution is audited, invalid input is 400, unauthorized is 403, FINAL_MUTATION registration is rejected, and output is capped.
console.log("AI capability gateway contract passed.");
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd backend && node scripts/verify-ai-capability-gateway.js`  
Expected: FAIL because the evaluator and gateway do not exist.

- [ ] **Step 3: Extract permission logic without behavior change**

Move the normalization and role/listMenu checks from `authorize` into:

```js
function userHasPermission(user, requirement, pageContext = {}) {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  // Preserve current RolePermission matching, wildcard, read-implies-higher-action, and legacy listMenu behavior exactly.
}
```

Change `authorize(resource, action)` to call this predicate with `resolvePageContext(req)` and keep the same 401/403 responses.

- [ ] **Step 4: Implement registry and Ajv gateway**

```js
function register(definition) {
  if (["FINAL_MUTATION"].includes(definition.operationClass)) throw Object.assign(new Error("AI final mutation dilarang."), { code: "AI_FINAL_MUTATION_DENIED" });
  if (definitions.has(definition.code)) throw new Error(`Capability duplicate: ${definition.code}`);
  definitions.set(definition.code, Object.freeze({ ...definition }));
}
```

The gateway validates `input`, checks permission, executes the adapter, caps arrays recursively at `maxRows`, validates output, and writes an `AiCapabilityCall` record with sanitized parameters and sources. Never pass the `user` object to the model response.

- [ ] **Step 5: Run tests**

Run: `cd backend && node scripts/verify-ai-capability-gateway.js && node scripts/verify-page-context.js`  
Expected: new gateway contract and existing page-context/auth-related contract pass.

- [ ] **Step 6: Register command and commit**

Add `"test:ai-capabilities": "node scripts/verify-ai-capability-gateway.js"`.

```bash
git -C backend add package.json src/prisma/middleware/auth.js src/prisma/services/ai/permissionEvaluator.js src/prisma/services/ai/capabilityRegistry.js src/prisma/services/ai/capabilityGateway.js scripts/verify-ai-capability-gateway.js
git -C backend commit -m "feat(ai): add permission-bound capability gateway"
```

---

### Task 5: Add Conversation, Prompt, Request, and Orchestrator APIs

**Files:**
- Create: `backend/src/prisma/services/ai/promptRegistry.js`
- Create: `backend/src/prisma/services/ai/aiConversationService.js`
- Create: `backend/src/prisma/services/ai/aiDraftService.js`
- Create: `backend/src/prisma/services/ai/aiOrchestrator.js`
- Create: `backend/src/prisma/controllers/ai/AiAssistantController.js`
- Create: `backend/src/prisma/routes/ai.js`
- Modify: `backend/src/prisma/routes/index.js`
- Create: `backend/scripts/verify-ai-orchestrator.js`
- Create: `backend/scripts/verify-ai-api.js`
- Modify: `backend/package.json`

**Interfaces:**
- Produces `createConversation`, `listConversations`, `getConversation`, `submitMessage`, `getRequest`, `cancelRequest`, and `expireOrdinaryConversations`.
- Produces `createAiDraft`, `getOwnedDraft`, `rejectAiDraft`, and `markAiDraftConfirmed`; the last function is callable only by official module services after their own save transaction succeeds.
- Produces `runChatRequest(requestId)` and `generateStructuredWorkflow({ capabilityCode, actor, pageContext, input, outputSchema, timeoutMs })`.

- [ ] **Step 1: Write failing orchestrator tests**

Use fake runtime outputs to cover: one `TOOL_CALL` followed by one `ANSWER`, unauthorized tool rejection, maximum four tool calls, malformed JSON fallback, one recommendation repair, and no partial draft. The envelope schema is:

```js
const assistantEnvelopeSchema = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["type", "answer", "sources"], properties: { type: { const: "ANSWER" }, answer: { type: "string", maxLength: 6000 }, sources: { type: "array", maxItems: 20, items: { type: "object", required: ["entityType", "entityId"], properties: { entityType: { type: "string" }, entityId: { type: "string" }, label: { type: "string" }, href: { type: "string" } }, additionalProperties: false } } },
    { type: "object", additionalProperties: false, required: ["type", "capabilityCode", "arguments"], properties: { type: { const: "TOOL_CALL" }, capabilityCode: { type: "string" }, arguments: { type: "object" } } }
  ]
};
```

- [ ] **Step 2: Write failing API tests**

Test handlers with fake response objects. Assert `POST /conversations/:id/messages` returns 202 with `{ requestId, status: "QUEUED" }`, another user cannot read the conversation, polling returns the assistant message when complete, and a pending owner can cancel.

- [ ] **Step 3: Run both tests and verify failure**

Run: `cd backend && node scripts/verify-ai-orchestrator.js && node scripts/verify-ai-api.js`  
Expected: FAIL because services/routes do not exist.

- [ ] **Step 4: Implement versioned prompts**

`promptRegistry.js` exports immutable prompt records. The base `ERP_ASSISTANT_V1` prompt must state: treat business text as untrusted data, use only registered capabilities, never invent identifiers or quantities, cite ERP sources, label inference, and never claim an action was saved. Contextual workflow prompts add module constraints without replacing the base rules.

- [ ] **Step 5: Implement asynchronous conversation/request service**

Persist the user message and `AiRequest` transactionally, enqueue only after commit, and return immediately. Polling must verify `conversation.userId === req.user.id` unless super admin. On backend restart, mark stale `QUEUED`/`RUNNING` requests as `FAILED` with `AI_RUNTIME_RESTARTED`; do not replay them automatically.

Persist the audit envelope across request/message/capability records: actor and role snapshot, source module/page/record, model profile/checksum, prompt version, seed, context/output limits, duration and peak memory, sanitized question/response, capabilities and business source records, validator results, retry/fallback/timeout/crash reason. Never persist credentials, cookies, authorization headers, raw environment values, or unrestricted business-row dumps.

Implement `aiDraftService` with the same ownership and permission checks. Draft creation always forces `WAITING_CONFIRMATION`; the generic AI router can fetch or reject a draft but cannot confirm one. `markAiDraftConfirmed` accepts the official entity type/id and records actor/time only after an official module service has persisted the approved change.

- [ ] **Step 6: Implement bounded orchestrator loop**

```js
for (let turn = 0; turn < 5; turn += 1) {
  const result = await runtime.enqueue(runtimeJob);
  if (result.json.type === "ANSWER") return persistAnswer(result);
  if (turn === 4) throw aiError("AI_TOOL_LOOP_LIMIT", "Batas capability tercapai.");
  const tool = await gateway.execute({ user, requestId, conversationId, capabilityCode: result.json.capabilityCode, input: result.json.arguments, pageContext });
  runtimeJob.messages.push({ role: "tool", content: JSON.stringify({ capabilityCode: result.json.capabilityCode, data: tool.data, sources: tool.sources }) });
}
```

- [ ] **Step 7: Add authenticated routes**

Mount `api.use("/ai", auth, aiRouter)` and expose:

```text
GET    /api/ai/status
GET    /api/ai/capabilities
GET    /api/ai/admin/model-files
GET    /api/ai/conversations
POST   /api/ai/conversations
GET    /api/ai/conversations/:conversationId
POST   /api/ai/conversations/:conversationId/messages
GET    /api/ai/requests/:requestId
DELETE /api/ai/requests/:requestId
GET    /api/ai/drafts/:draftId
POST   /api/ai/drafts/:draftId/reject
GET    /api/ai/admin/model-profiles
POST   /api/ai/admin/model-profiles
POST   /api/ai/admin/model-profiles/:id/test
POST   /api/ai/admin/model-profiles/:id/activate
POST   /api/ai/admin/model-profiles/:id/rollback
```

Admin routes must call `requireSuperAdmin` inside the AI router. `/admin/model-files` returns only allowlisted GGUF basenames from `AI_MODEL_DIR`; it never exposes an absolute path. Deliberately do not create `POST /api/ai/drafts/:id/confirm`.

- [ ] **Step 8: Run tests and commit**

Run: `cd backend && node scripts/verify-ai-orchestrator.js && node scripts/verify-ai-api.js && node --check src/prisma/routes/index.js`  
Expected: PASS.

```bash
git -C backend add package.json src/prisma/routes/index.js src/prisma/routes/ai.js src/prisma/controllers/ai src/prisma/services/ai/promptRegistry.js src/prisma/services/ai/aiConversationService.js src/prisma/services/ai/aiDraftService.js src/prisma/services/ai/aiOrchestrator.js scripts/verify-ai-orchestrator.js scripts/verify-ai-api.js
git -C backend commit -m "feat(ai): add audited assistant orchestration API"
```

---

### Task 6: Build the Global Assistant Drawer and Async Proxy

**Files:**
- Create: `frontend/src/routes/ai.js`
- Modify: `frontend/server.js`
- Create: `frontend/views/partials/ai-assistant.ejs`
- Modify: `frontend/views/partials/head.ejs`
- Create: `frontend/public/js/ai-assistant-model.js`
- Create: `frontend/public/js/ai-assistant.js`
- Create: `frontend/public/css/ai-assistant.css`
- Create: `frontend/scripts/verify-ai-assistant-ui.js`
- Modify: `frontend/package.json`

**Interfaces:**
- Produces `window.ERP_AI_ASSISTANT.open({ capabilityCode?, prompt?, context? })` and `.refreshContext()`.
- Uses existing `window.ERP_PAGE_CONTEXT` and same-origin fetch headers.

- [ ] **Step 1: Write failing pure-state and page contracts**

```js
// frontend/scripts/verify-ai-assistant-ui.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const { normalizeRequestState, nextPollDelay, renderSourceLabel } = require("../public/js/ai-assistant-model");
assert.strictEqual(normalizeRequestState({ status: "RUNNING" }).busy, true);
assert.strictEqual(normalizeRequestState({ status: "COMPLETED" }).terminal, true);
assert.strictEqual(nextPollDelay(0), 700);
assert.strictEqual(nextPollDelay(8), 2500);
assert.strictEqual(renderSourceLabel({ entityType: "MRP", entityId: "MRP-1" }), "MRP · MRP-1");
const head = fs.readFileSync("views/partials/head.ejs", "utf8");
assert.match(head, /partials\/ai-assistant/);
assert.match(head, /ai-assistant\.css/);
assert.match(head, /ai-assistant\.js/);
console.log("AI assistant UI contract passed.");
```

- [ ] **Step 2: Run the contract and verify failure**

Run: `cd frontend && node scripts/verify-ai-assistant-ui.js`  
Expected: FAIL because model/partial/assets do not exist.

- [ ] **Step 3: Implement the frontend proxy**

Mount `app.use("/ai/api", aiRoutes)`. Forward authorization and page-context headers. GET requests use 15-second timeout; message submission/status polling uses 100 seconds only for transport safety even though backend submission is asynchronous. Include `/ai/api/` in JSON error handling.

- [ ] **Step 4: Implement immutable UI state helpers**

Export helpers for CommonJS tests and attach them to `window` in browser:

```js
function normalizeRequestState(row = {}) { const status = String(row.status || "").toUpperCase(); return { ...row, status, busy: ["QUEUED", "RUNNING"].includes(status), terminal: ["COMPLETED", "FAILED", "CANCELLED"].includes(status) }; }
function nextPollDelay(attempt) { return attempt < 3 ? 700 : attempt < 8 ? 1400 : 2500; }
```

- [ ] **Step 5: Build responsive drawer**

The partial contains a header status pill, context chip, conversation list, messages, source links, draft cards, queue state, prompt textarea, cancel button, and send button. The CSS uses a right drawer on desktop and full-height bottom sheet below 700px. It must not overlap Bootstrap page-context offcanvas IDs.

- [ ] **Step 6: Implement polling and contextual API**

On submit: create/reuse a conversation for the current page context, submit message, poll request until terminal, render sources as safe same-origin links, and render `Review Draft` without a confirm mutation. Expose the global API for page scripts.

Key the active conversation by authenticated user, role/permission version, module, page, and record context. Clear local assistant context on logout or role/permission change; the backend still rechecks ownership and current permission for every poll and capability call.

- [ ] **Step 7: Run tests and build**

Run: `cd frontend && node scripts/verify-ai-assistant-ui.js && node --check public/js/ai-assistant.js && npm run check`  
Expected: PASS.

- [ ] **Step 8: Register command and commit**

Add `"test:ai-assistant-ui": "node scripts/verify-ai-assistant-ui.js"` and include it in `build` before `check`.

```bash
git -C frontend add package.json server.js src/routes/ai.js views/partials/head.ejs views/partials/ai-assistant.ejs public/js/ai-assistant-model.js public/js/ai-assistant.js public/css/ai-assistant.css scripts/verify-ai-assistant-ui.js
git -C frontend commit -m "feat(ai): add global offline assistant drawer"
```

---

### Task 7: Add Enterprise Model Registry Administration

**Files:**
- Modify: `frontend/src/masterDataRegistry.js`
- Modify: `frontend/src/routes/masterData.js`
- Create: `frontend/views/master-data/ai-model-profiles.ejs`
- Create: `frontend/public/js/ai-model-profiles.js`
- Create: `frontend/public/css/ai-model-profiles.css`
- Create: `frontend/scripts/verify-ai-model-profile-page.js`
- Modify: `frontend/views/partials/head.ejs`
- Modify: `frontend/package.json`

**Interfaces:**
- Adds `/master-data/ai-model-profiles` for super administrators.
- UI calls only `/ai/api/admin/model-profiles`; it never accepts arbitrary paths, only a GGUF filename returned by backend discovery.

- [ ] **Step 1: Write failing page contract**

Assert registry entry, list table, `DRAFT/TESTING/ACTIVE/INACTIVE/FAILED` states, checksum, resource config, `Test Profile`, `Activate`, and `Rollback` are present. Assert no `<input type="file">` and no free-form filesystem path input exists.

- [ ] **Step 2: Run test and verify failure**

Run: `cd frontend && node scripts/verify-ai-model-profile-page.js`  
Expected: FAIL because the page does not exist.

- [ ] **Step 3: Implement registry route and page**

Follow existing Master Data table style. Show active model, runtime health, model file, quantization, context, CPU threads, memory ceiling, last benchmark, activation actor/time, and rollback profile. Create/edit uses a modal with backend-discovered filenames and bounded numeric inputs.

- [ ] **Step 4: Implement test/activation workflow**

Disable activation until the latest backend test reports `schemaPass`, `goldenPass`, and `resourcePass`. After activation, refresh both profile list and global assistant status. A failed activation shows that the previous profile remains active.

- [ ] **Step 5: Verify and commit**

Run: `cd frontend && node scripts/verify-ai-model-profile-page.js && node --check public/js/ai-model-profiles.js`  
Expected: PASS.

```bash
git -C frontend add package.json src/masterDataRegistry.js src/routes/masterData.js views/master-data/ai-model-profiles.ejs views/partials/head.ejs public/js/ai-model-profiles.js public/css/ai-model-profiles.css scripts/verify-ai-model-profile-page.js
git -C frontend commit -m "feat(ai): add model profile administration"
```

---

### Task 8: Add Inventory Read Capabilities

**Files:**
- Create: `backend/src/prisma/services/ai/capabilities/inventoryCapabilities.js`
- Create: `backend/scripts/verify-ai-inventory-capabilities.js`
- Modify: `backend/src/prisma/services/ai/capabilityRegistry.js`
- Modify: `backend/package.json`

**Interfaces:**
- Registers `inventory.get_stock_summary`, `inventory.trace_stock_usage`, and `inventory.get_stock_risk` as `READ`/`ANALYZE`.

- [ ] **Step 1: Write failing capability tests**

Use fake Prisma rows containing warehouse, WIP, free, and reserved stock. Assert output keeps the fields separate, aggregates at two decimals for non-PCS, rounds PCS to integer, returns source record links, caps results at 100, and never returns cost/credential fields.

- [ ] **Step 2: Run and verify failure**

Run: `cd backend && node scripts/verify-ai-inventory-capabilities.js`  
Expected: FAIL because adapters do not exist.

- [ ] **Step 3: Implement adapters using existing inventory semantics**

Return this stable stock shape:

```js
{
  partCode, partName, uomCode,
  warehouseQty, wipQty, reservedQty,
  freeQty: Math.max(warehouseQty + wipQty - reservedQty, 0),
  locations: [{ warehouseCode, rackCode, lotNumber, qty }],
  sources: [{ entityType: "STOCK_BALANCE", entityId, label, href }]
}
```

Use the same stock-balance/reservation filters as the Inventory and MRP services; do not duplicate a second netting formula.

- [ ] **Step 4: Verify and commit**

Run: `cd backend && node scripts/verify-ai-inventory-capabilities.js && node scripts/verify-inventory-mrp-management-matrix.js`  
Expected: PASS.

```bash
git -C backend add package.json src/prisma/services/ai/capabilities/inventoryCapabilities.js src/prisma/services/ai/capabilityRegistry.js scripts/verify-ai-inventory-capabilities.js
git -C backend commit -m "feat(ai): add inventory assistant capabilities"
```

---

### Task 9: Add Purchasing Risk Capabilities

**Files:**
- Create: `backend/src/prisma/services/ai/capabilities/purchasingCapabilities.js`
- Create: `backend/scripts/verify-ai-purchasing-capabilities.js`
- Modify: `backend/src/prisma/services/ai/capabilityRegistry.js`

**Interfaces:**
- Registers `purchasing.get_material_shortage`, `purchasing.find_late_po`, and `purchasing.create_recovery_draft`.
- Recovery output is an `AiDraft`; it does not create PR/PO or change supplier commitment.

- [ ] **Step 1: Write failing tests**

Fixture must include on-time supply, late supply, MOQ, supplier lead time, MRP source, and production-required date. Assert risk is based on required arrival date, source links include MRP/PO/FG phase, and draft status is `WAITING_CONFIRMATION`.

- [ ] **Step 2: Run and verify failure**

Run: `cd backend && node scripts/verify-ai-purchasing-capabilities.js`  
Expected: FAIL.

- [ ] **Step 3: Implement adapters**

Reuse Purchase Suggestion/MRP service data and return:

```js
{
  partCode, requiredQty, requiredDate,
  coveredQty, shortageQty, lateSupplyQty,
  supplierCode, supplierLeadTimeDays, moq,
  latestReleaseDate, status,
  deliveryPhases, sources
}
```

The recovery draft payload permits only owner, proposed supplier commitment date, expedite note, and source references. It cannot write a PO status, date, or quantity.

- [ ] **Step 4: Verify and commit**

Run: `cd backend && node scripts/verify-ai-purchasing-capabilities.js && node scripts/verify-purchase-suggestion-master-defaults.js`  
Expected: PASS.

```bash
git -C backend add src/prisma/services/ai/capabilities/purchasingCapabilities.js src/prisma/services/ai/capabilityRegistry.js scripts/verify-ai-purchasing-capabilities.js
git -C backend commit -m "feat(ai): add purchasing risk capabilities"
```

---

### Task 10: Add Production Progress and NG Capabilities

**Files:**
- Create: `backend/src/prisma/services/ai/capabilities/productionCapabilities.js`
- Create: `backend/scripts/verify-ai-production-capabilities.js`
- Modify: `backend/src/prisma/services/ai/capabilityRegistry.js`

**Interfaces:**
- Registers `production.get_daily_progress`, `production.analyze_ng_and_downtime`, and `production.create_recovery_draft`.

- [ ] **Step 1: Write failing tests**

Fixture includes planned qty, good output, NG, open disposition, downtime, remaining qty, downstream WIP, and FG due. Assert the adapter does not treat NG as good output and traces the impact to downstream process/FG.

- [ ] **Step 2: Run and verify failure**

Run: `cd backend && node scripts/verify-ai-production-capabilities.js`  
Expected: FAIL.

- [ ] **Step 3: Implement adapters**

Use Daily Production Schedule, Production Log, downtime, NG disposition, and WIP services. Return:

```js
{
  scheduleDate, machineCode, workOrderNumber, partCode, processCode,
  plannedQty, goodQty, ngQty, remainingQty,
  downtimeMinutes, projectedFinishAt, fgRequiredDate,
  riskStatus, downstreamImpact, sources
}
```

Recovery draft may propose only a plan revision note, target machine/shift/date from supplied choices, and owner; release remains in Daily Production Planning.

- [ ] **Step 4: Verify and commit**

Run: `cd backend && node scripts/verify-ai-production-capabilities.js && npm run test:daily-plan-revision`  
Expected: PASS.

```bash
git -C backend add src/prisma/services/ai/capabilities/productionCapabilities.js src/prisma/services/ai/capabilityRegistry.js scripts/verify-ai-production-capabilities.js
git -C backend commit -m "feat(ai): add production execution capabilities"
```

---

### Task 11: Replace Monthly Plan Generation with Validated AI and Rule-based Fallback

**Files:**
- Create: `backend/src/prisma/services/ai/capabilities/ppicCapabilities.js`
- Modify: `backend/src/prisma/services/planning/monthlyPlanRecommendationService.js`
- Modify: `backend/src/prisma/controllers/planning/MonthlyPlanRecommendationController.js`
- Modify: `backend/src/prisma/routes/planning/monthly-production-plans.js`
- Modify: `frontend/public/js/ppic-monthly-recommendation.js`
- Modify: `frontend/public/js/ppic-monthly-production-plan.js`
- Modify: `frontend/public/css/ppic-monthly-production-plan.css`
- Create: `backend/scripts/verify-ai-mpp-recommendation.js`
- Modify: `frontend/scripts/verify-mpp-recommendation.js`

**Interfaces:**
- Produces `generateAiRecommendationScenario(prisma, { planNumber, actor, user, pageContext })`.
- Keeps existing `generateRecommendationScenario` as `generateRuleBasedRecommendationScenario` fallback.
- Registers `ppic.explain_mps`, `ppic.explain_mrp_netting`, and `ppic.get_delivery_blockers` as sourced `READ`/`ANALYZE` capabilities; these explain official calculations and never run a second planning formula.

- [ ] **Step 1: Write failing backend tests**

Test Qwen structured output containing only supplied IDs and `ALLOCATE/MOVE/SPLIT/QUEUE`. Assert: ERP validator recalculates all quantities/dates; one repair receives validation errors; a second invalid result falls back; scenario provenance records `AI`, `AI_CORRECTED`, or `RULE_BASED_FALLBACK`; no official allocation changes during generation. Add PPIC explanation fixtures proving MPS delivery feasibility/blockers and MRP warehouse/WIP/free/reserved stock, netting history, delivery phase, and forecast links come from authoritative MPS/MRP services instead of model arithmetic.

- [ ] **Step 2: Write failing frontend tag tests**

Extend existing test to assert:

```js
assert.strictEqual(renderScenarioSource({ generationSource: "AI", modelProfileCode: "QWEN3-4B-CPU" }), "AI RECOMMENDATION · QWEN3-4B · OFFLINE");
assert.strictEqual(renderScenarioSource({ generationSource: "RULE_BASED_FALLBACK" }), "RULE-BASED FALLBACK");
```

- [ ] **Step 3: Run both and verify failure**

Run: `cd backend && node scripts/verify-ai-mpp-recommendation.js`  
Run: `cd frontend && node scripts/verify-mpp-recommendation.js`  
Expected: FAIL.

- [ ] **Step 4: Implement compact context and strict action schema**

Build from `buildCapacitySnapshot` and include only FG due, route chain, remaining qty/UOM, stock/WIP, official consumption, D+1 receipt, machines/dates/capacity, current allocation, vendor lead/return, MOQ, and enumerated IDs. The output schema requires:

```js
{ actions: [{ action: "ALLOCATE|MOVE|SPLIT|QUEUE", lineNumber, mbomProcessId, sourceAllocationId, targetMachineId, targetVendorId, targetDate, qty, reasonCode }], summary: { rationale, fgOnTimeCount, fgLateCount } }
```

Use enum arrays generated from the snapshot for identifiers and date bounds. Convert actions to the existing recommendation item shape, then run existing material/capacity/sequence validation before persistence.

Register the three PPIC explanation adapters in the same file. Their outputs include official document/revision/status, calculation history rows, delivery phase/FG required date, stock buckets, feasibility/blocker status, and same-origin source links. They may label an inference but must not recompute MPS quantity, MRP net requirement, or delivery feasibility.

- [ ] **Step 5: Add one repair and fallback**

Repair prompt includes only allowed input plus normalized validator codes/messages. Do not include stack traces or SQL. On timeout, worker error, malformed JSON, unknown reference, or second invalid result, call the current rule engine and store the fallback reason in `aiValidationSummary`.

- [ ] **Step 6: Update UI without changing workflow**

Add source tag and model/validation tooltip to existing recommendation bar. Keep preview, selection, Material Queue, Apply to Capacity Editor, Save, Cancel, and Undo behavior unchanged.

- [ ] **Step 7: Verify and commit in both repositories**

Run: `cd backend && node scripts/verify-ai-mpp-recommendation.js && npm run test:mpp-recommendation && npm run test:mpp-capacity-editor`  
Run: `cd frontend && npm run test:mpp-recommendation && npm run test:mpp-capacity-editor`  
Expected: PASS.

```bash
git -C backend add src/prisma/services/ai/capabilities/ppicCapabilities.js src/prisma/services/planning/monthlyPlanRecommendationService.js src/prisma/controllers/planning/MonthlyPlanRecommendationController.js src/prisma/routes/planning/monthly-production-plans.js scripts/verify-ai-mpp-recommendation.js
git -C backend commit -m "feat(ai): generate validated monthly plan recommendations"
git -C frontend add public/js/ppic-monthly-recommendation.js public/js/ppic-monthly-production-plan.js public/css/ppic-monthly-production-plan.css scripts/verify-mpp-recommendation.js
git -C frontend commit -m "feat(ai): label monthly plan AI recommendations"
```

---

### Task 12: Add Capacity Planning Analysis and Simulation Drafts

**Files:**
- Create: `backend/src/prisma/services/ai/capabilities/capacityCapabilities.js`
- Modify: `backend/src/prisma/services/ai/capabilityRegistry.js`
- Create: `backend/scripts/verify-ai-capacity-capabilities.js`
- Modify: `frontend/views/ppic/capacity.ejs`
- Modify: `frontend/public/js/ppic-capacity.js`
- Modify: `frontend/public/css/ppic-capacity.css`
- Create: `frontend/scripts/verify-ai-capacity-actions.js`

**Interfaces:**
- Registers `ppic.get_capacity_risk`, `ppic.compare_capacity_presets`, `ppic.explain_capacity_blocker`, and `ppic.create_capacity_simulation_draft`.
- Frontend can call `ERP_AI_ASSISTANT.open({ capabilityCode, context })` from risk cards and toolbar.

- [ ] **Step 1: Write failing backend contracts**

Fixture includes overload, high load, empty cell, unscheduled route, predecessor shortage, missing cycle time, vendor late return, and late FG. Assert every risk traces machine/date -> route/part -> FG/delivery and the simulation draft contains only allowed preset/override fields.

- [ ] **Step 2: Write failing frontend contract**

Assert Capacity Planning contains `AI Capacity Analysis`, blocker-level action hooks, and draft review prefill, but no code path calling `adopt Current Use`, `override shortage`, or `sync DPP` from assistant results.

- [ ] **Step 3: Run tests and verify failure**

Run: `cd backend && node scripts/verify-ai-capacity-capabilities.js`  
Run: `cd frontend && node scripts/verify-ai-capacity-actions.js`  
Expected: FAIL.

- [ ] **Step 4: Implement analysis adapters**

Reuse `buildCapacitySnapshot` and current preset store. Return risk objects with `riskCode`, severity, machine/work center, date, utilization, overload minutes, source allocation, process, part, FG required date, delivery phase, root cause, allowed alternatives, and source links.

- [ ] **Step 5: Implement simulation draft only**

Store an `AiDraft` payload containing `month`, `name`, `basePresetId`, `dailyOverrides`, `allocationChanges`, `vendorDateChanges`, and explanation. Validate past-day locks and permitted machine/vendor/date choices. `Review Draft` opens/prefills the existing simulation/editor UI; the user must press its normal Save button.

- [ ] **Step 6: Add contextual actions**

Add one toolbar action and one action on each attention item. Pass current month, planning mode, preset ID, plan number, machine/date, and risk code through the global assistant context—not free-form DOM HTML.

- [ ] **Step 7: Verify and commit**

Run: `cd backend && node scripts/verify-ai-capacity-capabilities.js && npm run test:capacity-authoritative-validation`  
Run: `cd frontend && node scripts/verify-ai-capacity-actions.js && node --check public/js/ppic-capacity.js`  
Expected: PASS.

```bash
git -C backend add src/prisma/services/ai/capabilities/capacityCapabilities.js src/prisma/services/ai/capabilityRegistry.js scripts/verify-ai-capacity-capabilities.js
git -C backend commit -m "feat(ai): add capacity planning assistant capabilities"
git -C frontend add views/ppic/capacity.ejs public/js/ppic-capacity.js public/css/ppic-capacity.css scripts/verify-ai-capacity-actions.js
git -C frontend commit -m "feat(ai): add contextual capacity assistant actions"
```

---

### Task 13: Add Contextual Actions and Draft Review Across Phase-one Modules

**Files:**
- Modify: `backend/src/prisma/controllers/planning/CapacityPlanningController.js`
- Modify: `backend/src/prisma/controllers/purchasing/PurchaseSuggestionController.js`
- Modify: `backend/src/prisma/controllers/planning/DailyPlanRevisionController.js`
- Modify: `backend/src/prisma/services/planning/dailyPlanRevisionService.js`
- Create: `backend/scripts/verify-ai-draft-confirmation.js`
- Modify: `frontend/views/modules/report.ejs`
- Modify: `frontend/views/operations/dashboard.ejs`
- Modify: `frontend/views/production/execution-matrix.ejs`
- Modify: `frontend/public/js/module-report.js`
- Modify: `frontend/public/js/operations-dashboard.js`
- Modify: `frontend/public/js/production-execution-matrix.js`
- Create: `frontend/public/js/ai-context-actions.js`
- Create: `frontend/scripts/verify-ai-context-actions.js`
- Modify: `frontend/package.json`

**Interfaces:**
- Adds data attributes `data-ai-capability`, `data-ai-context`, and `data-ai-prompt` to safe predefined actions.
- `ai-context-actions.js` delegates clicks to `window.ERP_AI_ASSISTANT.open`.
- Official save endpoints accept an optional `aiDraftId` and call `markAiDraftConfirmed({ draftId, userId, officialEntityType, officialEntityId })` only after the authoritative module operation succeeds.

- [ ] **Step 1: Write failing page contracts**

Assert Inventory Report exposes stock risk, Purchasing dashboard exposes late PO/material shortage, and Production matrix exposes actual/NG/downtime analysis. Assert context JSON contains IDs/filter values only and does not serialize table HTML.

Write `verify-ai-draft-confirmation.js` with fake transactions/services. Assert there is no generic AI confirm endpoint, cross-user/expired/rejected drafts fail, a failed official save leaves the draft `WAITING_CONFIRMATION`, and successful Capacity preset, Purchase Suggestion recovery, and Daily Plan revision saves attach exactly one official entity and confirmation actor/time.

- [ ] **Step 2: Run and verify failure**

Run: `cd backend && node scripts/verify-ai-draft-confirmation.js`  
Run: `cd frontend && node scripts/verify-ai-context-actions.js`  
Expected: FAIL.

- [ ] **Step 3: Implement delegated contextual actions**

```js
document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-ai-capability]");
  if (!trigger || !window.ERP_AI_ASSISTANT) return;
  const context = JSON.parse(trigger.dataset.aiContext || "{}");
  window.ERP_AI_ASSISTANT.open({ capabilityCode: trigger.dataset.aiCapability, prompt: trigger.dataset.aiPrompt || "", context });
});
```

Validate capability codes against a frontend allowlist before opening.

- [ ] **Step 4: Add draft review routing**

Inventory read capabilities have no draft button. Purchasing recovery drafts open the relevant Purchase Suggestion/PO review page with `aiDraftId`; Production recovery drafts open Daily Plan revision with `aiDraftId`; the destination page fetches the draft and pre-fills but does not auto-submit.

- [ ] **Step 5: Bind confirmation to official module saves**

Pass `aiDraftId` from Capacity simulation review, Purchasing recovery review, and Production revision review into the existing official form payload. Validate ownership, type, module/page, status, and expiry before save. After the authoritative save succeeds, call `markAiDraftConfirmed` with its persisted preset/suggestion/revision identifier; never mark confirmation on validation error, rollback, Cancel, preview, or failed transaction. Preserve idempotency if the browser retries the same successful request.

- [ ] **Step 6: Verify and commit**

Run: `cd backend && node scripts/verify-ai-draft-confirmation.js && npm run test:daily-plan-revision`  
Run: `cd frontend && node scripts/verify-ai-context-actions.js && npm run test:shared-ui && npm run check`  
Expected: PASS.

```bash
git -C backend add src/prisma/controllers/planning/CapacityPlanningController.js src/prisma/controllers/purchasing/PurchaseSuggestionController.js src/prisma/controllers/planning/DailyPlanRevisionController.js src/prisma/services/planning/dailyPlanRevisionService.js scripts/verify-ai-draft-confirmation.js
git -C backend commit -m "feat(ai): bind drafts to official confirmations"
git -C frontend add package.json views/modules/report.ejs views/operations/dashboard.ejs views/production/execution-matrix.ejs public/js/module-report.js public/js/operations-dashboard.js public/js/production-execution-matrix.js public/js/ai-context-actions.js scripts/verify-ai-context-actions.js
git -C frontend commit -m "feat(ai): add contextual assistant actions"
```

---

### Task 14: Add Retention, Security Evaluation, Feature Flags, and End-to-end Verification

**Files:**
- Create: `backend/src/prisma/services/ai/aiRetentionService.js`
- Create: `backend/src/prisma/services/ai/aiFeaturePolicy.js`
- Create: `backend/scripts/verify-ai-security.js`
- Create: `backend/scripts/verify-ai-retention.js`
- Create: `backend/scripts/verify-ai-golden-cases.js`
- Create: `backend/scripts/benchmark-ai-runtime.js`
- Modify: `backend/server.js`
- Modify: `backend/package.json`
- Modify: `frontend/package.json`
- Create: `backend/docs/operations/offline-ai-assistant.md`

**Interfaces:**
- Produces `isAiEnabled({ moduleCode, capabilityCode, user })`, daily `cleanupExpiredAiData(prisma, now)`, and a deployment benchmark result compatible with `AiModelProfile.benchmarkResult`.

- [ ] **Step 1: Write failing security and retention tests**

Security cases must include instruction text in part name, supplier name, notes, and user prompt; unknown tool, SQL, URL, file path, direct mutation request, cross-user conversation, cross-role capability, unknown identifier, excessive qty, expired draft, and malformed JSON. Retention fixtures must prove: (a) a 31-day conversation with no business action is deleted; (b) a conversation linked to a capability call or draft keeps audit metadata while message/prompt content is redacted; (c) confirmed/rejected draft provenance remains; and (d) expired waiting drafts become `EXPIRED`.

- [ ] **Step 2: Run and verify failure**

Run: `cd backend && node scripts/verify-ai-security.js && node scripts/verify-ai-retention.js`  
Expected: FAIL.

- [ ] **Step 3: Implement layered feature policy**

Enablement requires all of: `AI_ASSISTANT_ENABLED=true`, active profile, allowed module, allowed capability, authorized user, and healthy runtime for inference. A disabled/degraded assistant returns status without breaking module pages. Rule-based MPP fallback remains available when AI is disabled.

- [ ] **Step 4: Implement retention cron**

At the existing 02:00 cleanup, process expired conversations transactionally:

- If a conversation has no capability call and no draft, delete it with its ordinary messages/requests.
- If it has business audit, keep conversation/request/capability/draft metadata, set conversation status `ARCHIVED`, replace message content with `[REDACTED_BY_RETENTION]`, clear message citations/runtime details, and scrub request prompt/response payload fields without deleting source references or validator/confirmation provenance.
- Mark expired `WAITING_CONFIRMATION` drafts `EXPIRED`; never change confirmed/rejected official references.
- Keep MPP recommendation prompt/output provenance for the same retention lifetime as its recommendation scenario; scenario deletion follows the existing planning audit policy rather than the 30-day conversation rule.

The `RESTRICT` foreign keys from Task 1 must make accidental audit deletion fail. Log only record counts and IDs safe for operations, never prompt or business-text content.

- [ ] **Step 5: Add golden cases and benchmark**

Golden fixtures cover MPP routing/material/capacity, Capacity Planning overload, Inventory stock separation, Purchasing required-date risk, and Production NG/downtime. The benchmark records model checksum, valid-schema rate, golden pass rate, permission pass, peak RSS, p50/p95 latency, and resource pass. It never activates a profile automatically.

- [ ] **Step 6: Write deployment runbook**

Document `AI_MODEL_DIR`, manual GGUF provisioning/checksum, feature flags, CPU thread sizing, profile test/activation/rollback, log locations, backup/retention, degraded/fallback behavior, and safe removal. Explicitly state that model artifacts are not downloaded by ERP startup and not committed.

- [ ] **Step 7: Run backend verification**

Run:

```bash
cd backend
npm run test:ai-schema
npm run test:ai-model-profiles
npm run test:ai-capabilities
node scripts/verify-ai-runtime.js
node scripts/verify-ai-orchestrator.js
node scripts/verify-ai-api.js
node scripts/verify-ai-inventory-capabilities.js
node scripts/verify-ai-purchasing-capabilities.js
node scripts/verify-ai-production-capabilities.js
node scripts/verify-ai-mpp-recommendation.js
node scripts/verify-ai-capacity-capabilities.js
node scripts/verify-ai-draft-confirmation.js
node scripts/verify-ai-security.js
node scripts/verify-ai-retention.js
node scripts/verify-ai-golden-cases.js
npm run test:mpp-recommendation
npm run test:mpp-capacity-editor
npm run test:daily-plan-revision
npx prisma validate
npx prisma migrate status
```

Expected: all contracts pass, Prisma is valid, and migration status is current after migration deployment in the test environment.

- [ ] **Step 8: Run frontend verification**

Run:

```bash
cd frontend
npm run test:ai-assistant-ui
node scripts/verify-ai-model-profile-page.js
node scripts/verify-ai-capacity-actions.js
node scripts/verify-ai-context-actions.js
npm run test:mpp-recommendation
npm run test:mpp-capacity-editor
npm run build
```

Expected: all page contracts, syntax checks, and the complete existing frontend build pass.

- [ ] **Step 9: Run manual browser acceptance with AI disabled first**

At `http://localhost:3100`, verify all ordinary ERP pages load with no GGUF and assistant status `AI OFFLINE`. Then activate a tested profile and verify drawer, page context, queue, source links, read capabilities, MPP AI/fallback tags, Capacity draft prefill, Cancel/Undo, role denial, timeout, and worker restart. Do not confirm an official business mutation during QA.

- [ ] **Step 10: Commit hardening and operations docs**

```bash
git -C backend add package.json server.js src/prisma/services/ai/aiRetentionService.js src/prisma/services/ai/aiFeaturePolicy.js scripts/verify-ai-security.js scripts/verify-ai-retention.js scripts/verify-ai-golden-cases.js scripts/benchmark-ai-runtime.js docs/operations/offline-ai-assistant.md
git -C backend commit -m "test(ai): harden and verify offline assistant"
git -C frontend add package.json
git -C frontend commit -m "test(ai): include assistant in frontend build"
```

---

## Completion Criteria

- The ERP starts and operates normally with AI disabled and no model installed.
- A super administrator can test, activate, replace, and roll back an allowlisted GGUF profile.
- The worker has no ERP credentials, database client, shell, arbitrary file, or unrestricted network interface.
- Users can see and invoke only capabilities allowed by their existing ERP roles.
- The global drawer works on desktop and mobile and preserves page/record context without leaking another user's conversation.
- PPIC Monthly Plan returns AI-validated output or an explicit rule-based fallback and retains current preview/editor/Save/Cancel semantics.
- Capacity Planning explains risks and creates reviewable simulation drafts without adopting Current Use, overriding shortage, or generating DPP.
- Inventory, Purchasing, and Production capabilities return sourced facts and create only allowed drafts.
- Every model call, capability, validator result, draft, confirmation/rejection, timeout, and fallback is auditable.
- All backend contracts, Prisma checks, frontend contracts, and the existing full frontend build pass.
