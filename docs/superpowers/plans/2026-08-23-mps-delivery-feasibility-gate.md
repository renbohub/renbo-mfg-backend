# MPS Delivery Feasibility Gate Implementation Plan

> **For Codex:** Follow the test-first steps in order and preserve the existing dirty worktree.

**Goal:** Keep MPS/MRP simulation usable for infeasible deliveries while preventing unresolved delivery commitments from becoming official plans.

**Architecture:** Reuse `DueDateRecoveryPlan` for disposition decisions, persist immutable per-revision MPS delivery snapshots, summarize the gate on the MPS header, and enforce the gate in both MPS approval and official MRP. Surface the same server-derived gate in Rolling MPS.

**Tech Stack:** Node.js, Express, Prisma/PostgreSQL, EJS, browser JavaScript, CSS.

---

### Task 1: Establish the gate contract

**Files:**
- Create: `scripts/verify-mps-delivery-feasibility-gate.js`
- Modify: `package.json`

1. Add pure-state cases for feasible, unresolved infeasible, approved recovery, approved Accept Late, stale, and legacy missing snapshots.
2. Add source-contract assertions for the MPS approval, MRP official, MRP simulation, and UI integration points.
3. Run the test and confirm it fails because the gate service does not exist.

### Task 2: Persist auditable feasibility snapshots

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260823120000_mps_delivery_feasibility_gate/migration.sql`
- Create: `src/prisma/services/planning/mpsDeliveryFeasibilityService.js`

1. Add MPS header summary fields and the per-revision snapshot model.
2. Add dedicated Accept Late audit fields to `DueDateRecoveryPlan`.
3. Implement pure gate derivation and source-fingerprint helpers.
4. Implement snapshot refresh and current-gate lookup.
5. Run the gate contract test.

### Task 3: Refresh and invalidate the gate with MPS data

**Files:**
- Modify: `src/prisma/services/planning/monthlyPlanningService.js`
- Modify: `src/prisma/controllers/planning/DemandPlanningController.js`
- Modify: `src/prisma/controllers/planning/MPSController.js`

1. Refresh delivery snapshots after monthly MPS synchronization.
2. Save and validate dedicated Accept Late fields through the recovery workflow.
3. Invalidate the gate whenever MPS adjustment/source changes invalidate RCCP or require replan.
4. Return gate details from MPS readiness/workbench APIs.
5. Run the gate contract and existing planning-cycle tests.

### Task 4: Enforce promotion boundaries

**Files:**
- Modify: `src/prisma/controllers/planning/MPSController.js`
- Modify: `src/prisma/controllers/planning/MRPController.js`

1. Block MPS approval when the delivery gate is unresolved.
2. Record approved-with-exception state when every blocker has an approved Accept Late decision.
3. Allow simulation MRP to use calculated documents while preserving blocker details in assumptions.
4. Require a passing current delivery gate for official MRP across the full planning cycle.
5. Run the gate and MRP planning-cycle tests.

### Task 5: Surface the gate in Rolling MPS

**Files:**
- Modify: `src/prisma/services/planning/mpsWorkbenchService.js`
- Modify: `views/ppic/mps-workbench.ejs`
- Modify: `public/js/ppic-mps-workbench.js`
- Modify: `public/css/ppic-mps-workbench.css`
- Modify: `src/routes/modules.js`

1. Render feasibility/disposition/official-gate badges and blocker count.
2. Add a responsive blocker drawer with Forecast/SO delivery and recovery links.
3. Disable official approval/MRP according to the server gate and keep simulation available.
4. Update cache-busting version.
5. Run frontend syntax/build checks.

### Task 6: Verify the integrated flow

1. Generate Prisma client and validate the schema.
2. Run the new gate test plus affected RCCP/MRP/demand tests.
3. Run frontend checks.
4. Exercise the local MPS page and verify calculated, blocked, exception, and feasible states.
