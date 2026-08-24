# Monthly Production Plan Recommendation — Design

Date: 2026-08-24  
Scope: Monthly Production Plan, capacity allocation, vendor process, and material queue

## Objective

Add a deterministic recommendation system that helps PPIC complete FG on time. The engine may allocate unallocated requirements and move or split existing allocations, but it must never modify the official plan until PPIC explicitly applies and saves the recommendation.

The primary optimization objective is on-time FG completion. Capacity leveling is secondary. Capacity overload is permitted and surfaced for manual recovery; material availability and routing dependencies remain hard constraints.

## Non-goals

- The engine does not automatically approve, release, or publish a Monthly Production Plan.
- The engine does not automatically resolve overload through overtime, alternate vendor commitments, or Force Move.
- The engine does not consume unavailable warehouse or WIP stock.
- The engine does not move blockers automatically to the next month.
- The first version is deterministic; it does not use a stochastic or machine-learning optimizer.

## Business Rules

### Priority

Recommendations are ordered by:

1. Earliest FG required date.
2. Production priority within the same due date.
3. Routing dependency.
4. Preservation of an existing allocation when it still supports on-time FG.
5. Earliest eligible machine availability.
6. Lowest machine load as a tie-breaker.

Existing allocations may be moved or split only when doing so improves FG timeliness or releases a blocked dependency.

### Material availability

Material is evaluated as a dated running balance for each part and process level:

```text
Available(t)
= Opening warehouse/WIP stock
+ cumulative predecessor output available by t
- cumulative successor consumption through t
```

Stock may not be used twice. For a predecessor completed on date `D`, including a vendor batch returned on `D`, its output is available to the successor starting on `D+1`.

When predecessor output is supplied in multiple batches, the successor may be split according to cumulative available quantity. When no material is available, the successor is placed in Material Queue. If a predecessor is already scheduled, the queue receives `earliestAvailableDate = predecessor completion/return date + 1 day`. If that date is outside the owner month, the quantity becomes a carry-over material queue item.

### Capacity

Capacity is a soft constraint for recommendation placement. The engine places the operation on its required date even when utilization exceeds 100%, then marks the cell `OVERLOAD`. PPIC performs recovery manually.

Material dependency, routing order, machine eligibility, vendor MOQ/order multiple, and plan ownership are hard constraints. A recommendation that violates vendor MOQ is surfaced as an exception and cannot be applied automatically.

## Recommendation Algorithm

Use deterministic backward scheduling:

1. Build demand batches from FG required, buffer, and prior-month shortage.
2. Sort batches by FG due date and priority.
3. Expand the canonical routing from final process to first process.
4. For each route, derive latest finish from the successor start requirement.
5. Query temporal stock and predecessor receipts.
6. Allocate only the quantity supported by cumulative material availability.
7. Place unsupported quantity in Material Queue with the earliest known availability date.
8. Select an eligible machine or vendor resource.
9. Preserve an existing allocation when feasible; otherwise create a proposed move or split.
10. Permit capacity above 100% and record an overload exception.
11. Recalculate all downstream material balances after every proposed allocation.
12. Produce a recommendation scenario and an auditable reason for every change.

The same input snapshot and rules must produce the same scenario.

## Architecture

### Recommendation engine

A backend service owns the scheduling algorithm. It consumes an immutable snapshot containing:

- Monthly Production Plan details and current allocations.
- FG required dates, buffer, and shortage.
- Canonical BOM/routing and process order.
- Warehouse and WIP balances.
- Machine eligibility and calendar capacity.
- Vendor assignment, return dates, MOQ, and order multiple.

The engine returns proposed allocations, proposed moves/splits, material queue items, capacity exceptions, and trace records. It does not write official allocations while calculating.

### Scenario persistence

A recommendation scenario stores:

- Plan ID and base plan version.
- Status and calculation timestamps.
- Input snapshot/revision references.
- Proposed allocation changes.
- Material queue and carry-over items.
- Overload and rule exceptions.
- Per-change reason code and calculation trace.
- Applied selections and actor audit.

Recommended statuses:

- `CALCULATING`
- `READY`
- `READY_WITH_OVERLOAD`
- `MATERIAL_QUEUE`
- `PARTIALLY_APPLIED`
- `APPLIED`
- `DISCARDED`
- `FAILED`

Applying a stale scenario is rejected when the Monthly Production Plan version no longer matches the scenario base version.

### Apply flow

Applying a scenario copies selected proposed changes into the existing Capacity Editor session. It does not immediately persist official allocation changes. PPIC retains the existing `Undo`, `Cancel`, and `Save Changes` controls. Only `Save Changes` commits the plan.

## API Contract

Proposed endpoints:

- `POST /monthly-plan/:planNumber/recommendations` — generate a scenario.
- `GET /monthly-plan/:planNumber/recommendations/active` — fetch the active scenario.
- `GET /monthly-plan/recommendations/:scenarioId` — fetch scenario detail and trace.
- `POST /monthly-plan/recommendations/:scenarioId/apply` — apply all or selected changes to a Capacity Editor session.
- `POST /monthly-plan/recommendations/:scenarioId/discard` — discard an unapplied scenario.

Generation requests are idempotent by plan version and rule revision. A new plan version creates a new scenario rather than mutating an older one.

## User Interface

Add `Generate Recommendation` to the Monthly Production Plan toolbar. After calculation, the matrix enters Recommendation Preview:

- New or moved cells display `RECOMMENDED`.
- Moved allocations show origin and destination.
- Overloaded cells remain populated, turn red, and show utilization.
- Material Queue lists waiting quantity, source WIP/part, available quantity, earliest availability, affected FG, and due date.
- Carry-over items are separated from the current-month queue.

The sticky footer summarizes:

- FG on-time and late counts.
- New allocations.
- Moved/split allocations.
- Overloaded cells.
- Material Queue quantity.
- Carry-over quantity.

PPIC can `Apply All`, apply by Work Center, apply selected allocations, or `Discard Scenario`.

## Error Handling and Safety

- Recommendation calculation failure leaves the official plan unchanged.
- Apply uses optimistic locking against the scenario base plan version.
- Material balance and routing constraints are revalidated when applying and again when saving.
- Partial apply records which proposals were accepted and preserves the remainder in the scenario.
- Every force, exception, move, and split has an actor, timestamp, reason code, and trace.
- Closed, released, or published execution history is not overwritten; residual replan rules continue to apply.

## Testing

### Unit tests

- Backward scheduling order and deterministic tie-breaking.
- `D+1` predecessor availability for in-house and vendor processes.
- Cumulative WIP receipts and consumption without double use.
- Partial material availability and split allocation.
- Existing allocation preservation, move, and split decisions.
- Capacity overload placement without material-constraint bypass.
- Vendor MOQ and order-multiple exceptions.

### Integration tests

- Generate scenario from a real Monthly Production Plan snapshot.
- Reject stale scenario apply.
- Apply all, by Work Center, and selected recommendations into Capacity Editor.
- Undo, Cancel, and Save Changes behavior after apply.
- Carry-over queue generation at the month boundary.
- Official plan remains unchanged after calculation failure or discard.

### UI contract tests

- Preview cell markers and moved-allocation trace.
- Sticky summary counts.
- Material Queue earliest availability.
- Overload rendering above 100%.
- Partial apply selection and scenario status changes.

## Acceptance Criteria

1. The engine allocates both remaining requirements and eligible existing allocations using deterministic backward scheduling.
2. FG on-time is the primary objective.
3. Capacity overload is allocated and visibly flagged rather than automatically recovered.
4. Material never becomes available before predecessor completion/return date plus one day.
5. Unsupported material quantity enters a dated Material Queue, including WIP-derived material.
6. Calculation and preview do not mutate the official plan.
7. PPIC can apply all, by Work Center, or selected recommendations into Capacity Editor.
8. Undo, Cancel, optimistic locking, and audit history remain effective.
