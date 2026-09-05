"use strict";

const assert = require("node:assert/strict");
const {
  dateKey,
  addWorkingDays,
  backwardOffsetPhase,
  weekStart,
  weeklyBuckets,
  allocateWeeklyLoad,
  capacityOffsetStatus,
  findEarlierFeasibleStart,
} = require("../src/prisma/services/planning/rccpOffsetService");
const {
  profileMatchesProcess,
  resourceRequirementForPhase,
} = require("../src/prisma/services/planning/rccpService");
const { buildLedger, demandPhases } = require("../src/prisma/services/planning/mpsWorkbenchService");

let passed = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("working-day subtraction skips weekend", () => {
  assert.equal(dateKey(addWorkingDays("2026-09-03", -5)), "2026-08-27");
});

test("same-month offset stays SAME_MONTH", () => {
  assert.equal(dateKey(addWorkingDays("2026-09-25", -5)), "2026-09-18");
  assert.equal(capacityOffsetStatus(false, ["FEASIBLE"]), "SAME_MONTH");
});

test("previous-month requirement is explicit before a capacity result", () => {
  assert.equal(capacityOffsetStatus(true, []), "PREVIOUS_MONTH_REQUIRED");
});

test("previous-month feasible and warning use separate offset statuses", () => {
  assert.equal(capacityOffsetStatus(true, ["FEASIBLE"]), "PREVIOUS_MONTH_FEASIBLE");
  assert.equal(capacityOffsetStatus(true, ["FEASIBLE", "WARNING"]), "PREVIOUS_MONTH_WARNING");
});

test("vendor timeline crosses month boundary using working days", async () => {
  const timeline = await backwardOffsetPhase({
    requiredDate: "2026-09-03",
    profiles: [
      { sequence: 10, resourceCode: "STAMPING", resourceType: "INTERNAL", leadTimeValue: 1 },
      { sequence: 20, resourceCode: "WELDING", resourceType: "INTERNAL", leadTimeValue: 1 },
      { sequence: 30, resourceCode: "VENDOR", resourceType: "OUTSOURCE", leadTimeValue: 5 },
      { sequence: 40, resourceCode: "PACKING", resourceType: "INTERNAL", leadTimeValue: 1 },
    ],
  });
  assert.ok(timeline.earliestStartDate < new Date("2026-09-01T00:00:00.000Z"));
  assert.equal(dateKey(timeline.details.find((row) => row.resourceCode === "VENDOR").calculatedFinishDate), "2026-09-01");
  assert.equal(timeline.details.length, 4);
});

test("short final packing lets vendor finish on the same working day", async () => {
  const timeline = await backwardOffsetPhase({
    requiredDate: "2026-09-05",
    profiles: [
      { sequence: 30, resourceCode: "VENDOR", resourceType: "OUTSOURCE", leadTimeValue: 5 },
      { sequence: 40, resourceCode: "PACKING", resourceType: "INTERNAL", leadTimeValue: 1, allowUpstreamSameDay: true },
    ],
  });
  const vendor = timeline.details.find((row) => row.resourceCode === "VENDOR");
  assert(vendor.calculatedStartDate < vendor.calculatedFinishDate);
  assert.equal(timeline.solver.engine, "OR_TOOLS_WASM_CP_SAT");
});

test("weekly horizon includes impacted August and September buckets", () => {
  const buckets = weeklyBuckets("2026-08-26", "2026-09-25");
  assert.equal(dateKey(buckets[0].start), dateKey(weekStart("2026-08-26")));
  assert.ok(buckets.some((row) => dateKey(row.start).startsWith("2026-09")));
});

test("vendor load crossing a week is distributed by working day", () => {
  const allocations = allocateWeeklyLoad({
    startDate: "2026-08-28",
    finishDate: "2026-09-03",
    totalHours: 1.21,
    calendar: { calendarMode: "WEEKDAY", useWorkingCalendar: true },
  });
  assert.deepEqual(allocations.map((row) => ({
    bucketStart: dateKey(row.bucketStart),
    workingDays: row.workingDays,
    hours: row.hours,
  })), [
    { bucketStart: "2026-08-24", workingDays: 1, hours: 0.242 },
    { bucketStart: "2026-08-31", workingDays: 4, hours: 0.968 },
  ]);
  assert.equal(allocations.reduce((sum, row) => sum + row.hours, 0), 1.21);
});

test("earlier feasible search returns 24 August", async () => {
  const loads = new Map([["2026-08-25", 104], ["2026-08-24", 88]]);
  const result = await findEarlierFeasibleStart({
    originalStartDate: "2026-08-26", searchWindowDays: 10, currentRequirement: 88,
    overloadThreshold: 100,
    capacityAt: (candidate) => ({ availableCapacity: 100, existingLoad: (loads.get(dateKey(candidate)) || 1000) - 88 }),
  });
  assert.equal(dateKey(result.recommendedStartDate), "2026-08-24");
  assert.equal(result.recommendedLoadPercentage, 88);
});

test("no feasible candidate keeps previous-month overload", async () => {
  const result = await findEarlierFeasibleStart({
    originalStartDate: "2026-08-26", searchWindowDays: 10, currentRequirement: 20,
    overloadThreshold: 100, capacityAt: () => ({ availableCapacity: 100, existingLoad: 90 }),
  });
  assert.equal(result, null);
  assert.equal(capacityOffsetStatus(true, ["OVERLOAD"]), "PREVIOUS_MONTH_OVERLOAD");
});

test("RCCP resource aliases match actual MBOM processes", () => {
  assert.equal(profileMatchesProcess({ resourceCode: "PACKING" }, { processCode: "INSP-PACK" }), true);
  assert.equal(profileMatchesProcess({ resourceCode: "VENDOR_PAINT" }, { processCode: "PAINT" }), true);
  assert.equal(profileMatchesProcess({ resourceCode: "WELDING_LINE_2" }, { processCode: "WELD" }), true);
  assert.equal(profileMatchesProcess({ resourceCode: "STAMPING_MEDIUM" }, { processCode: "PRG" }), true);
  assert.equal(profileMatchesProcess({ resourceCode: "STAMPING_MEDIUM" }, { processCode: "BE" }), false);
});

test("3 September only loads packing when paint stock stops the WIP cascade", () => {
  const phase = { id: "SEP-03", qty: 49, sourceType: "FORECAST" };
  const workbenchItem = {
    components: [
      { partCode: "C002-C004-010", level: 1, qtyPerFg: 1, processes: [{ processCode: "INSP-PACK" }], phaseNetting: [{ phaseId: "SEP-03", grossRequirementQty: 49, stockUsedQty: 0, netRequirementQty: 49, plannedOrderQty: 49, leadTime: { totalHours: 2, parentHours: 0 } }] },
      { partCode: "C002-C004-020", level: 2, qtyPerFg: 1, processes: [{ processCode: "PAINT" }], phaseNetting: [{ phaseId: "SEP-03", grossRequirementQty: 49, stockUsedQty: 49, netRequirementQty: 0, plannedOrderQty: 0 }] },
      { partCode: "C002-C004-040", level: 4, qtyPerFg: 1, processes: [{ processCode: "WELD" }], phaseNetting: [{ phaseId: "SEP-03", grossRequirementQty: 0, stockUsedQty: 0, netRequirementQty: 0, plannedOrderQty: 0 }] },
      { partCode: "C002-C004-070", level: 7, qtyPerFg: 1, processes: [{ processCode: "PRG" }], phaseNetting: [{ phaseId: "SEP-03", grossRequirementQty: 0, stockUsedQty: 0, netRequirementQty: 0, plannedOrderQty: 0 }] },
    ],
  };
  assert.equal(resourceRequirementForPhase({ resourceCode: "PACKING" }, workbenchItem, phase).qty, 49);
  assert.equal(resourceRequirementForPhase({ resourceCode: "PACKING" }, workbenchItem, phase).processLeadTimeHours, 2);
  assert.equal(resourceRequirementForPhase({ resourceCode: "VENDOR_PAINT" }, workbenchItem, phase).qty, 0);
  assert.equal(resourceRequirementForPhase({ resourceCode: "WELDING_LINE_2" }, workbenchItem, phase).qty, 0);
  assert.equal(resourceRequirementForPhase({ resourceCode: "STAMPING_MEDIUM" }, workbenchItem, phase).qty, 0);
});

test("M-1 shortage becomes an early carryover phase and fully dates MPS production", () => {
  const detail = {
    id: "MPS-OCT-L1",
    mpsNumber: "MPS-202610",
    customerCode: "C002",
    startDate: "2026-10-01",
    endDate: "2026-10-31",
    openingAvailableQty: 112,
    targetEndingStockQty: 360,
    projectedEndingStockQty: 360,
    firmScheduledReceiptQty: 0,
    qtyPlanned: 813,
    calculationTrace: { previousEfd: { month: "2026-09", shortageQty: 342 } },
    demandSources: [
      { id: "FCT-OCT-1", sourceType: "FORECAST", sourceNumber: "FCT-2026-001", customerCode: "C002", qty: 93, effectiveRequiredDate: "2026-10-10" },
      { id: "FCT-OCT-2", sourceType: "FORECAST", sourceNumber: "FCT-2026-001", customerCode: "C002", qty: 130, effectiveRequiredDate: "2026-10-20" },
    ],
  };
  const phases = demandPhases(detail);
  assert.equal(phases[0].sourceType, "CARRYOVER");
  assert.equal(phases[0].qty, 342);
  assert.equal(dateKey(phases[0].fgRequiredDate), "2026-10-01");
  const ledger = buildLedger({ detail, stockLines: [], reservations: [], receipts: [], comparePhysicalOpening: false });
  assert.equal(ledger.metrics.plannedProductionUsedQty, 813);
  assert.equal(ledger.ledger.some((row) => row.eventType === "PLANNED_BALANCE"), false);
});

(async () => {
  for (const entry of tests) { await entry.fn(); passed += 1; console.log(`✓ ${entry.name}`); }
  console.log(`\n${passed} RCCP offset-month tests passed.`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
