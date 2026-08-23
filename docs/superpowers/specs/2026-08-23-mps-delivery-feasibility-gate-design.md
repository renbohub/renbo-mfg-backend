# MPS Delivery Feasibility Gate Design

## Objective

MPS calculation must remain available when a customer delivery date is infeasible, but an infeasible or stale delivery commitment must not be promoted into an official MPS/MRP plan without an approved and auditable disposition.

## Existing Context

- Demand Planning already assesses delivery feasibility and stores versioned `DueDateRecoveryPlan` records.
- MPS demand sources already preserve `deliveryTargetId`, source document, target date, FG required date, and quantity.
- MPS approval currently checks master/routing readiness and RCCP capacity only.
- Official and simulation MRP already have separate scenario semantics, but both currently require Confirmed/Released MPS documents.

## State Model

The workflow keeps independent state axes instead of overloading the document lifecycle:

- MPS lifecycle: existing Draft/Calculated/Capacity Checked/Approved/Released flow.
- Delivery feasibility: `UNKNOWN`, `FEASIBLE`, `INFEASIBLE`, `STALE`.
- Delivery disposition: `NONE`, `RECOVERY_PENDING`, `RECOVERY_APPROVED`, `ACCEPT_LATE_PENDING`, `ACCEPT_LATE_APPROVED`.
- Derived official gate: `BLOCKED`, `READY_TO_RELEASE`, `APPROVED_WITH_EXCEPTION`, `OFFICIAL`.

## Persistence

The MPS header stores the current delivery-feasibility summary, assessment timestamp, and source fingerprint for fast gate checks.

Each exact MPS revision stores one feasibility snapshot per delivery target. The snapshot records:

- MPS ID and revision.
- Delivery target, forecast/SO source, part, original target date, effective commitment date, and quantity.
- Feasibility and disposition state.
- Referenced recovery-plan ID and revision.
- Source timestamps/fingerprint and an explainable JSON detail.

`DueDateRecoveryPlan` remains the single workflow for recovery and Accept Late. Dedicated Accept Late fields preserve the original commitment, approved replacement date, reason, approver, and timestamp rather than relying on generic checklist text.

## Assessment Rules

1. MPS calculation/synchronization always completes and refreshes delivery snapshots.
2. A delivery is feasible only when its current Demand Planning assessment is feasible and the source has not changed since assessment.
3. An approved recovery plan does not by itself make the delivery feasible. Its actions must be applied and the delivery reassessed successfully.
4. An approved Accept Late decision may clear the operational gate as an exception only when its approved new date and audit fields are complete and the underlying delivery/recovery revision is current.
5. Any delivery target, demand decision, recovery revision, MPS quantity, or source date change invalidates the relevant snapshot and makes the MPS gate stale until recalculation.
6. Missing snapshots on legacy approved MPS documents are treated as stale, never silently feasible.

## Approval and MRP Gates

- MPS calculation: always allowed.
- RCCP calculation: always allowed.
- MPS approval: blocked for unknown, stale, or unresolved infeasible delivery snapshots.
- MPS approved entirely feasible: `APPROVED · FEASIBLE`.
- MPS approved through Accept Late: `APPROVED WITH EXCEPTION`.
- MRP simulation: may use calculated/infeasible MPS and carries the blocker snapshot in scenario assumptions.
- MRP official: every authoritative MPS in the cycle must be approved, current, and pass the delivery gate.
- Existing MRP revisions remain visible. A source MPS invalidation prevents new downstream official promotion and causes the next official revision to supersede the old plan through the existing revision mechanism.

## UI

Rolling MPS adds delivery-feasibility state alongside RCCP:

- Red: delivery infeasible and unresolved.
- Orange: Accept Late pending/approved exception.
- Yellow: stale/unknown and requires recalculation.
- Green: feasible.

The next-action panel and approval modal show blocker counts and affected delivery phases. Each blocker links to its Forecast/SO delivery phase and to the existing recovery workflow. Official MRP is disabled while blocked, while simulation remains available.

## Authorization

The existing `mps:approve` permission remains the approval authority for recovery and Accept Late decisions. This keeps the current authorization contract while allowing the role assignment to be changed administratively.

## Verification

Contract tests cover:

- infeasible delivery does not block MPS calculation;
- unresolved delivery blocks MPS approval;
- approved recovery without successful reassessment remains blocked;
- approved Accept Late with complete audit data clears the exception gate;
- simulation MRP remains allowed;
- official MRP is blocked for infeasible/stale MPS;
- legacy MPS without snapshots is stale;
- frontend exposes the gate, blocker details, and correct enabled/disabled actions.
