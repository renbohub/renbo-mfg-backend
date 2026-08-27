# Additional Customer PO Coverage on Locked EFD, MPS, and MRP

Date: 27 August 2026  
Status: Approved design, awaiting final written-spec review  
Scope: Demand Planning, MPS, MRP, and production-cut visibility

## 1. Purpose

This feature makes customer PO/Sales Order changes visible and coverable after an official MPS and MRP have already been generated. It introduces additive baseline, delta, and cut records without replacing the existing planning algorithms or changing previously generated documents.

In this specification, `PO` on Demand Planning means a customer PO represented by a Sales Order. It does not mean a supplier Purchase Order.

## 2. Goals

- Lock EFD when an official baseline MPS is generated.
- Preserve generated baseline MPS and MRP as immutable planning references.
- Show customer PO added after the lock as `ADD`.
- Generate separate Delta MPS and Delta MRP documents only for uncovered additional demand.
- Show how additional demand is covered by stock, firm receipts, and delta production.
- Allow authorized users to cut unproduced excess when current SO is below locked EFD.
- Never reduce or cancel purchased parts/materials already committed on a supplier PO.
- Preserve complete source traceability from SO through planning and procurement.

## 3. Non-goals and Compatibility Boundary

This feature must not replace or redefine:

- the existing EFD calculation before lock;
- the existing MPS generation calculation;
- the existing MRP explosion and stock-netting calculation;
- existing MRP weekly-bucket rules;
- existing MPS, MRP, MO, PR, or supplier PO documents;
- existing stock allocation rules;
- existing production logs and WIP calculations.

The feature is an additive coverage and visibility layer. Consolidated views may combine baseline, delta, and cut values for presentation, but stored source documents remain separate.

## 4. Terminology

- **EFD Locked**: Snapshot of effective demand when the official baseline MPS is generated.
- **Current SO**: Current cumulative active customer Sales Order quantity for the same customer, part, and demand period.
- **ADD**: Cumulative customer SO quantity above EFD Locked.
- **Pending Delta**: ADD that has not yet been represented by a generated Delta MPS.
- **Baseline MPS/MRP**: First official generated documents for the locked demand scope.
- **Delta MPS/MRP**: Separate additive documents generated after the baseline.
- **Production Cut**: Separate approved negative execution adjustment for unproduced excess. It does not rewrite the baseline.
- **Reduction Exception**: Controlled workflow raised when SO decreases after locked planning documents exist.

## 5. Lock and Document Lifecycle

The MPS generation flow provides two modes:

1. `Preview`: simulate without persisting a lock or official document.
2. `Generate Baseline`: generate the official MPS and lock the source EFD.

After `Generate Baseline` succeeds:

- EFD becomes locked for the baseline scope;
- Baseline MPS becomes immutable;
- later Sales Orders affect ADD and Current only;
- baseline quantity is never silently recalculated.

Generating the baseline MRP locks that MRP as the material reference for the baseline MPS. Every later Delta MPS produces a separate Delta MRP.

Example identities:

```text
MPS-202609-B001     Baseline MPS
MPS-202609-D001     First additional-demand delta
MPS-202609-D002     Second additional-demand delta
MPS-202609-C001     Approved production cut

MRP-202609-B001     Baseline MRP
MRP-202609-D001     MRP for MPS delta D001
MRP-202609-D002     MRP for MPS delta D002
```

## 6. Demand Formulas

```text
ADD = max(Current SO - EFD Locked, 0)

Pending Delta = max(
  ADD
  - allocated Free FG Stock coverage
  - allocated Firm FG Receipt coverage
  - sum(demand quantity represented by generated Delta MPS documents),
  0
)
```

Example:

| Event | EFD Locked | Current SO | ADD | Generated Delta | Pending Delta |
|---|---:|---:|---:|---:|---:|
| Baseline | 10,000 | 7,500 | 0 | 0 | 0 |
| SO increases | 10,000 | 12,000 | 2,000 | 0 | 2,000 |
| D001 generated | 10,000 | 12,000 | 2,000 | 2,000 | 0 |
| SO increases again | 10,000 | 13,500 | 3,500 | 2,000 | 1,500 |
| D002 generated | 10,000 | 13,500 | 3,500 | 3,500 | 0 |

## 7. Additional PO Coverage

ADD is evaluated through the following coverage waterfall. Only its final uncovered balance becomes Pending Delta:

1. unallocated free FG stock;
2. unallocated firm FG receipt available by the customer delivery date;
3. generated Delta MPS supply;
4. uncovered quantity requiring PPIC action.

```text
Uncovered Qty = Pending Delta
```

Pending Delta and Uncovered Qty therefore represent the same actionable balance after all committed coverage sources have been deducted. Preview may show candidate stock or receipt coverage, but only persisted allocations are deducted from the official balance.

The same physical stock or receipt may not cover more than one baseline, delta, reservation, or order. Every coverage line stores a source identity and allocation quantity.

Coverage statuses:

- `NO_ADDITIONAL_DEMAND`
- `FULLY_COVERED`
- `PARTIALLY_COVERED`
- `UNCOVERED`
- `AT_RISK`
- `REDUCTION_EXCEPTION`

`AT_RISK` means quantity exists but is available after the customer delivery date.

## 8. Demand Planning UI

Monthly header:

```text
SEP 2026  [lock icon] EFD LOCKED
Baseline: MPS-202609-B001
Locked: 27 Aug 2026 10:30 by Super Administrator
```

Columns:

```text
FCT | PO | EFD [lock icon] | ADD | CURRENT
```

- `FCT`: forecast information.
- `PO`: cumulative customer SO at baseline lock time.
- `EFD Locked`: immutable baseline effective demand.
- `ADD`: cumulative positive excess of Current SO over EFD Locked.
- `CURRENT`: current cumulative active SO quantity.

Clicking the lock icon shows the baseline MPS, lock actor/time, FCT/PO/EFD values at lock, baseline SO sources, delta history, and reduction exceptions.

Clicking ADD opens a coverage drawer with SO delivery phases, free FG stock, firm receipts, Delta MPS coverage, uncovered quantity, due-date risk, and source links.

## 9. MPS UI

The consolidated MPS matrix adds the following groups without replacing the current planning body:

```text
Demand                              Production Plan
M-1 EFD | M EFD | M+1 EFD          Stock | Baseline MPS [lock] | Delta MPS | Production Cut | Total Plan
```

```text
Total Plan = Baseline MPS + sum(Delta MPS) - sum(approved Production Cut)
```

Available actions depend on state:

- Preview Baseline
- Generate Baseline
- Preview Delta
- Generate Delta
- Open Baseline
- Open Delta
- Preview Cut
- Review Reduction
- View Coverage Sources

Generate Delta is disabled when Pending Delta is zero.

## 10. Delta MRP

Each generated Delta MPS can produce one or more versioned Delta MRP documents. A Delta MRP explodes only the demand carried by its source Delta MPS while using the existing MRP calculation and current nettable supply.

```text
Exception Requirement = BOM requirement produced by the source Delta MPS

Available for Delta
= Free Stock
 + unallocated Firm Receipt
 - Baseline Allocation
 - Previous Delta Allocation

Net Requirement = max(Exception Requirement - Available for Delta, 0)
```

Supplier POs already created remain firm. The Delta MRP must not create a negative requirement intended to cancel a supplier PO.

## 11. Weekly MRP Matrix

The matrix reuses the current MRP weekly rule exactly:

- week runs Saturday through Friday;
- W1 starts on the first Saturday of each month;
- week numbering resets for each month;
- a bucket belongs to the month containing its Saturday start date.

For September 2026 this includes:

```text
M-1 August: W5 29 Aug-4 Sep
M September: W1 5-11 Sep, W2 12-18 Sep, W3 19-25 Sep, W4 26 Sep-2 Oct
M+1 October: W1 3-9 Oct, ...
```

Fixed columns:

```text
FG | Material / Part | Source | Status | Stock
```

Time columns are one column per existing weekly bucket. Values are stacked inside each weekly cell:

- M-1: Firm Requirement and Firm Receipt;
- M: Gross Requirement, ADD/Exception Requirement, and Net Requirement;
- M+1: Forecast.

Final columns:

```text
Total | Action
```

Clicking a weekly cell shows the source path:

```text
Sales Order -> ADD -> Delta MPS -> Delta MRP -> BOM requirement -> supply/PR
```

Views above the matrix:

```text
Baseline B001 [lock] | Delta D001 [lock] | Delta D002 Preview | Consolidated View
```

Consolidated View combines presentation only; it does not merge stored documents.

## 12. SO Decrease and Production Cut

When Current SO is below EFD Locked, the system raises a Reduction Exception and calculates:

```text
Potential Excess = max(EFD Locked - Current SO, 0)

Cuttable Qty = min(
  Potential Excess,
  Planned or Released Qty
  - quantity already produced
  - quantity currently represented by WIP
)
```

Production in Draft, Planned, Released, or In Progress may be reduced only for the remaining quantity that has not been produced and is not WIP. Good, NG, Rework, completed output, and active WIP quantities are protected.

An approved cut creates a separate `MPS-...-C...` adjustment. It does not rewrite Baseline MPS or Baseline MRP.

```text
Current Production Plan
= Baseline MPS
 + sum(Delta MPS)
 - sum(approved Production Cut)
```

Purchased parts/materials already on a supplier PO are never reduced or cancelled by this workflow. Received material remains stock. Material already issued for cancelled production must be returned through the existing Material Return process.

Every cut requires a reason, affected-MO preview, user approval, and audit trail.

## 13. Traceability and Audit

The system must retain links among:

- locked EFD snapshot;
- baseline MPS and MRP;
- new or revised Sales Order delivery phases;
- coverage allocation sources;
- Delta MPS and Delta MRP documents;
- planned orders, PRs, supplier POs, and MOs created from a delta;
- Production Cut and affected MOs;
- actor, timestamp, reason, and approval for every lock, delta, allocation, and cut.

Historical baseline values remain readable after current SO, stock, receipts, or production state changes.

## 14. Validation and Failure Handling

- Reject official generation if another baseline already exists for the same locked scope.
- Reject a Delta MPS quantity greater than current uncovered additional demand.
- Recalculate coverage immediately before generating a delta to prevent stale stock allocation.
- Reject duplicate allocation of the same stock or receipt quantity.
- Reject Production Cut greater than Cuttable Qty.
- Reject Production Cut that would reduce planned quantity below produced plus WIP quantity.
- Never silently update a locked document when validation fails.
- Show an actionable conflict message and require refresh when source SO, stock, receipt, WIP, or production changed after preview.

## 15. Acceptance Criteria

1. Preview never locks EFD and never creates official planning documents.
2. Generate Baseline locks EFD and stores the baseline source values.
3. Current SO below or equal to EFD Locked produces ADD = 0.
4. Current SO above EFD Locked produces ADD equal to the positive difference.
5. Repeated SO additions create only the remaining Pending Delta.
6. Baseline MPS/MRP values remain unchanged after additional SO arrives.
7. Additional demand shows stock, receipt, Delta MPS, and uncovered coverage separately.
8. Coverage cannot reuse already allocated physical supply.
9. Delta MPS and Delta MRP are separate documents linked to their baseline.
10. Weekly MRP presentation matches the existing Saturday-Friday bucket rule.
11. SO reduction creates a Reduction Exception, not an automatic negative delta.
12. Released production can be reduced only for quantity not produced and not WIP.
13. Supplier PO quantities are not reduced by Production Cut.
14. Consolidated View equals baseline plus deltas minus approved cuts.
15. Every displayed number can be traced to its source document.

## 16. Page References

- Demand Planning: `http://localhost:3100/modules/planning-ppic/demand-planning`
- MPS Workbench: `http://localhost:3100/modules/planning-ppic/mps/workbench`
- MRP: `http://localhost:3100/modules/planning-ppic/mrp`
- Monthly Production Plans: `http://localhost:3100/modules/planning-ppic/monthly-production-plans`
- Sales Orders: `http://localhost:3100/modules/sales/sales-orders`

