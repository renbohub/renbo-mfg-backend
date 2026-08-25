# Offline AI Assistant Platform Design

**Date:** 2026-08-25  
**Status:** Approved design, pending implementation plan  
**Runtime:** `node-llama-cpp` with a replaceable GGUF model profile  
**Initial model:** Qwen3-4B Q4_K_M, CPU-only profile

## 1. Context

The ERP already contains deterministic business services for planning, inventory, purchasing, production, sales, BOM/routing, master data, authorization, and audit. Monthly Production Plan recommendation also has a rule-based engine, material ledger, D+1 availability rule, capacity validation, vendor/MOQ handling, and a transactional Capacity Editor.

The new requirement is a fully offline AI Assistant that can serve several ERP modules. It must preserve the current UI and official workflows, provide contextual explanations and draft recommendations, and never bypass existing permissions, validators, approvals, or release controls.

This design intentionally does not use CP-SAT. Qwen proposes structured actions directly. Existing ERP services remain authoritative for facts, calculations, validation, persistence, and official state transitions.

## 2. Goals

- Run an AI Assistant locally without an internet dependency.
- Reuse one model across PPIC, Inventory, Purchasing, and Production in the first release.
- Keep the existing Monthly Production Plan recommendation workflow and add an honest AI status tag.
- Let the assistant read authorized data and create reviewable drafts.
- Require an explicit user confirmation through the official module workflow for every final mutation.
- Make every model, prompt, tool call, validation result, draft, and confirmation auditable.
- Allow a larger or different GGUF model to replace the initial model after a hardware upgrade without changing module code.
- Keep the ERP usable when the model is loading, busy, timed out, crashed, or disabled.

## 3. Non-goals

- The model will not receive database credentials, a Prisma client, arbitrary SQL, shell access, or unrestricted HTTP access.
- The model will not directly post, approve, release, close, override, adjust inventory, or alter master data.
- The model will not replace ERP calculations for stock, netting, quantity, dates, routing sequence, capacity, vendor lead time, or MOQ.
- The first release will not train or fine-tune a model.
- The first release will not provide unrestricted autonomous agents.
- The first release will not attempt multi-model routing or parallel inference.

## 4. Accepted Decisions

1. Use `node-llama-cpp`, not Ollama.
2. Do not introduce CP-SAT.
3. Use Qwen3-4B GGUF Q4_K_M as the initial CPU-only model.
4. Use an isolated Node worker process and a single inference queue.
5. Use a Capability Gateway for all ERP data access.
6. Permit read operations and draft creation only; final actions always require confirmation.
7. Use a global assistant drawer plus contextual AI actions on relevant pages.
8. Include PPIC, Capacity Planning, Inventory, Purchasing, and Production in phase one.
9. Add a Model Registry with test, activation, and rollback support.
10. Retain ordinary conversations for 30 days by default; retain business-action audit according to ERP audit policy.

## 5. High-level Architecture

```text
Browser UI
  |-- Global AI Assistant drawer
  `-- Contextual AI action
          |
          v
AI Orchestrator (authenticated ERP request)
  |-- Page Context Builder
  |-- Conversation Manager
  |-- Prompt Registry
  |-- Capability Gateway
  |     |-- authorization
  |     |-- schema validation
  |     |-- field filtering
  |     `-- audit
  |-- Draft Coordinator
  `-- Runtime Supervisor
          |
          v IPC
node-llama-cpp Worker
  |-- active GGUF model
  |-- constrained JSON grammar
  `-- no database/API credentials
          |
          v
ERP Validator and Existing Domain Services
          |
          v
Answer or AI-generated Draft
          |
          v
User Review -> Official ERP Service -> Confirmed Mutation
```

The model worker only receives sanitized messages or compact snapshots through IPC and returns text or schema-constrained JSON. It does not import Prisma or module services. Tool requests are interpreted by the AI Orchestrator, checked by the Capability Gateway, and executed by existing ERP services.

## 6. Runtime and Resource Profile

### 6.1 Initial CPU-only profile

- Model family: Qwen3-4B.
- Format: GGUF.
- Quantization: Q4_K_M.
- GPU: disabled for the initial profile.
- Context size: 4,096 tokens.
- Chat output limit: 600-800 tokens.
- Recommendation output limit: 1,200 tokens.
- Concurrent sequences: one.
- Initial batch size: 128; 256 is permitted only after a passing benchmark.
- CPU threads: available logical processors minus two, with a minimum safe value configured by deployment.
- Worker memory ceiling: approximately 5 GB as a monitored soft ceiling. The supervisor stops the worker and degrades to fallback if measured process memory remains above the configured limit; this is not presented as an operating-system hard limit.
- Lazy loading: load on first request.
- Idle unload: unload after approximately 15 minutes with an empty queue.
- Chat and explanations use non-thinking mode.
- Complex recommendations use a bounded reasoning budget.

The profile targets a machine with approximately 8 GB free RAM. Actual latency and memory use must be benchmarked on the deployment CPU before activation.

### 6.2 Model Registry

An administrator can define multiple model profiles with:

- profile code and display name;
- GGUF path and checksum;
- model family and quantization;
- context and output limits;
- CPU thread, batch, and GPU/offload settings;
- memory ceiling and timeout;
- thinking policy;
- prompt compatibility version;
- lifecycle status: `DRAFT`, `TESTING`, `ACTIVE`, `INACTIVE`, or `FAILED`;
- benchmark and evaluation result;
- activated by/at and rollback profile.

Only one profile is active. Activation is allowed only after model load, schema, golden-case, permission, memory, and latency checks pass. A failed activation keeps the previous profile active. Model files are deployment artifacts and are not stored in Git. The admin UI can select only files discovered inside an allowlisted server-side model directory; it cannot submit an arbitrary filesystem path or upload an executable artifact.

## 7. Capability Gateway

Every capability has a stable code, description, input JSON Schema, output JSON Schema, required ERP permission, operation class, maximum result size, field allowlist, and service adapter.

Example capability codes:

- `inventory.get_stock_summary`
- `inventory.trace_stock_usage`
- `purchasing.find_late_po`
- `purchasing.get_material_shortage`
- `production.get_daily_progress`
- `production.analyze_ng_and_downtime`
- `ppic.explain_mrp_netting`
- `ppic.get_delivery_blockers`
- `ppic.get_capacity_risk`
- `ppic.compare_capacity_presets`
- `ppic.create_monthly_plan_recommendation_draft`
- `ppic.create_capacity_simulation_draft`

The gateway enforces these rules for every call:

1. Resolve the authenticated user and current role from the ERP session.
2. Check the capability permission against the same authorization policy used by the module route.
3. Validate and normalize parameters.
4. Reject arbitrary query expressions, SQL, URLs, file paths, and unknown fields.
5. Execute an existing ERP service adapter.
6. Filter output fields and cap row counts before returning data to the model.
7. Record a sanitized audit event.

The worker cannot invoke a capability by itself. It emits a structured request, and only the orchestrator can submit it to the gateway.

## 8. Read and Draft Authority

Capabilities are classified as:

- `READ`: retrieves authorized and filtered data.
- `ANALYZE`: asks the model to explain already authorized facts.
- `DRAFT`: creates a non-official artifact with `AI_GENERATED · WAITING_CONFIRMATION`.
- `FINAL_MUTATION`: prohibited for AI invocation.

Draft creation uses the existing module service and transaction boundary. A draft must contain source record references, AI session/reference, proposed changes, impact, validation result, and the user who requested it.

Posting, approving, releasing, adopting Current Use, overriding shortage, generating/revising DPP, adjusting stock, changing master capacity, and similar official transitions can only be initiated from the official module UI by a user who has the required permission.

## 9. Assistant User Experience

### 9.1 Global assistant

- A global `AI Assistant` control appears in the ERP header for authorized users.
- Desktop uses a right-side drawer; narrow screens use a full-height bottom sheet.
- The assistant receives a sanitized page context: module, route, record identifier, active period, filters, and selected rows.
- Conversation state is isolated per user and per session.
- Changing role or logging out invalidates the active context.
- The drawer displays model/runtime state and queue position.

### 9.2 Contextual actions

Relevant pages may expose specific actions such as:

- `Generate AI Recommendation`
- `Explain Netting`
- `Analyze Stock Risk`
- `Find Late PO Risk`
- `Analyze Output & NG`
- `Explain Capacity Blocker`

Contextual actions call predefined capabilities rather than sending an unrestricted prompt. Results can include explanation cards, source links, risk summaries, and a `Review Draft` action. The final confirm button remains in the official module form or editor.

### 9.3 Honest status labels

- `AI Recommendation · Offline`: a model-generated proposal exists.
- `AI Validated`: ERP validators accepted the proposal.
- `AI Corrected · 1 Retry`: the first proposal failed and a repaired proposal passed.
- `Rule-based Fallback`: the local model did not produce a usable result.
- `AI Offline`: no inference runtime is available.

## 10. Monthly Production Plan AI Recommendation

The current UI and workflow remain unchanged:

```text
Generate Recommendation
  -> preview
  -> select items or work center
  -> Apply to Capacity Editor draft
  -> Save or Cancel/Undo
```

The Context Builder sends compact data grouped by FG/routing chain:

- FG required date and priority;
- route/process sequence;
- remaining quantity and UOM;
- warehouse/WIP opening stock;
- official consumption and scheduled receipt available D+1;
- eligible machines and daily available capacity;
- current allocations;
- vendor, lead time, return constraints, and MOQ;
- allowed dates and action types.

The model output is restricted to `ALLOCATE`, `MOVE`, `SPLIT`, and `QUEUE`. It cannot invent a part, machine, vendor, date, quantity, or identifier outside the supplied enumerations and numeric bounds.

ERP validators then recalculate stock, WIP reservations, D+1 availability, routing order, quantity, capacity, vendor dates, MOQ, and FG due feasibility. One repair attempt is allowed on the CPU-only profile. If it remains invalid or exceeds 90 seconds, the existing rule-based recommendation becomes the fallback.

Cancel and Undo restore the scenario and editor state that existed before the draft was applied. No official plan changes until the PPIC user saves the Capacity Editor draft.

## 11. Capacity Planning Capability

The phase-one PPIC assistant includes `/modules/planning-ppic/capacity-planning`.

Read and analysis capabilities cover:

- overload, high load, empty capacity, and unscheduled operations by machine/date;
- root-cause trace to FG, delivery phase, part, routing, and quantity;
- predecessor/WIP availability;
- missing machine, cycle time, calendar, or routing readiness;
- vendor send/return lateness;
- allocation after latest FG finish;
- comparison of Normal, Maximum, and Custom presets;
- impact of downtime or unavailable machines;
- potential machine alternatives and estimated overtime requirement.

Permitted drafts include:

- move or split allocation;
- alternative machine assignment;
- plan-specific overtime or shift change;
- vendor send/return adjustment;
- a new capacity simulation preset.

The assistant cannot adopt a simulation as Current Use, override shortage, generate/revise DPP, update the global calendar, update master capacity, or persist official production allocation.

## 12. Phase-one Module Capabilities

### PPIC

- Monthly Plan recommendation.
- Capacity Planning analysis and simulation drafts.
- MPS/MRP netting explanation.
- Delivery, material, routing, and capacity blocker analysis.

### Inventory

- Current, free, reserved, warehouse, and WIP stock lookup.
- Stock source and usage trace.
- Shortage and stock-risk explanation.

### Purchasing

- Material shortage and required-date explanation.
- Late PO/supplier risk.
- Draft recovery suggestion with source MRP/production requirements.

### Production

- Daily plan versus actual.
- Output, NG, downtime, and target risk.
- Trace impact to downstream WIP and FG.

Later phases can add BOM/routing consistency, Sales forecast/delivery risk, supplier/vendor performance, master-data draft changes, cross-module management briefings, and role-based daily exception summaries.

## 13. Validation and Repair

Model output passes through three boundaries:

1. JSON grammar/schema validation.
2. Reference and numeric-bound validation against the supplied snapshot.
3. Authoritative ERP domain validation.

An invalid result is never partially applied. For a recommendation, the orchestrator can send a compact list of validation errors back to the model once. The repair prompt contains only the original allowed action space and validation failures. If repair fails, the request returns a rule-based fallback or a clear no-result state.

Ordinary chat answers must link important claims to ERP records returned by capabilities. The UI distinguishes a sourced fact, model inference, and suggested action.

## 14. Queue, Timeout, and Failure Handling

Runtime states are:

- `OFFLINE`
- `LOADING_MODEL`
- `READY`
- `BUSY`
- `DEGRADED`

Queue rules:

- one running inference;
- at most two pending requests per user;
- a configurable global pending limit, default 20; additional requests receive a busy response instead of growing memory without bound;
- short interactive requests are prioritized over heavy recommendations that have not started;
- a running inference is not preempted;
- the UI shows queue position and allows a pending request to be cancelled.

Timeouts:

- ordinary chat: approximately 45 seconds;
- recommendation: approximately 90 seconds.

The supervisor restarts a crashed worker once. A second failure marks the runtime degraded and leaves normal ERP functionality available. Partial output cannot create a draft. A new model is loaded only when the queue is empty; failure preserves the previous active profile.

## 15. Security and Prompt-injection Controls

- No database/API credential is present in the worker environment. The supervisor launches it with a sanitized environment and a dedicated working directory rather than inheriting the full ERP process environment.
- No Prisma, shell, filesystem, or unrestricted network tool is registered for the model.
- Tool and capability selection is schema constrained.
- Part names, supplier names, notes, and imported text are explicitly marked as untrusted data.
- Untrusted text cannot introduce a new tool, permission, URL, or instruction.
- Capability output is field-filtered and row-limited.
- Sensitive fields and credentials are removed before prompting and auditing.
- User permissions are checked on every capability invocation.
- A model response is never treated as proof of authorization.

## 16. Audit and Retention

Audit records include:

- user, role, timestamp, and source page;
- conversation/session identifier;
- model profile, checksum, prompt version, seed, context size, and inference duration;
- sanitized question, response, capability, and parameters;
- business records read;
- draft created and validator outcome;
- retries, fallback reason, timeout, or worker failure;
- user who accepted, changed, rejected, or confirmed the draft.

Retention policy:

- ordinary conversation: 30 days by default, configurable;
- recommendation prompt/output: same lifetime as its planning scenario;
- draft and confirmation audit: ERP audit policy and unaffected by conversation cleanup;
- credentials and secrets: never persisted in prompt/audit.

## 17. Testing and Go-live Gates

Required test layers:

- unit and contract tests for the orchestrator, schemas, tools, and capability adapters;
- role/permission matrix tests for every capability;
- golden-case tests for PPIC, stock, PO, production actual, NG, BOM, and capacity;
- validator tests for quantity, UOM, date, material D+1, stock reservation, sequence, capacity, vendor, and MOQ;
- prompt-injection and malicious-data tests;
- tests proving no direct mutation path exists;
- malformed JSON, invalid reference, timeout, worker crash, queue, cancellation, and model rollback tests;
- memory and latency tests on the 8 GB free-RAM deployment profile;
- browser tests for drawer, page context, source links, review draft, confirmation boundary, queue, and fallback.

Go-live requires:

- no unauthorized data exposure in the permission suite;
- no direct write path from the model worker;
- every draft has source, validation, audit, and confirmation state;
- every invalid output is rejected, repaired, or safely falls back;
- the ERP remains responsive during model load and inference;
- the selected model profile passes the deployment benchmark and golden cases.

## 18. Rollout Boundary

The implementation must be split into independently testable increments:

1. Runtime supervisor and Model Registry.
2. Capability Gateway, permission enforcement, and audit.
3. Global assistant drawer and page-context protocol.
4. Read-only phase-one capabilities.
5. PPIC recommendation and Capacity Planning drafts.
6. Inventory, Purchasing, and Production drafts.
7. Operational benchmark, security evaluation, and controlled activation.

Each increment must leave the existing non-AI ERP path operational. AI activation is feature-flagged by environment, model profile, module, capability, and role.
