"use strict";

const assert = require("assert");
const {
  buildMonthlyPlanRecommendation,
  createTemporalMaterialLedger,
  deriveBackwardTargets,
  nextAvailabilityDate,
} = require("../src/prisma/services/planning/monthlyPlanRecommendationDomain");

assert.strictEqual(
  nextAvailabilityDate("2026-09-03"),
  "2026-09-04",
  "a predecessor completed on D must become available on D+1",
);

const ledger = createTemporalMaterialLedger(
  { "WIP-PAINT": 60 },
  [
    {
      partCode: "WIP-PAINT",
      date: "2026-09-04",
      qty: 191,
      sourceId: "paint-1",
    },
  ],
  [],
);

assert.deepStrictEqual(
  ledger.consume("WIP-PAINT", "2026-09-01", 60),
  { allocatedQty: 60, queuedQty: 0 },
  "opening WIP must cover the first dated requirement",
);
assert.strictEqual(
  ledger.available("WIP-PAINT", "2026-09-03"),
  0,
  "consumed opening WIP cannot be reused before the scheduled receipt",
);
assert.strictEqual(
  ledger.available("WIP-PAINT", "2026-09-04"),
  191,
  "scheduled WIP becomes available on its dated receipt",
);
assert.deepStrictEqual(
  ledger.consume("WIP-PAINT", "2026-09-04", 200),
  { allocatedQty: 191, queuedQty: 9 },
  "the ledger must split a requirement without double-consuming stock",
);
assert.strictEqual(
  ledger.available("WIP-PAINT", "2026-09-04"),
  0,
  "the scheduled receipt cannot be consumed twice",
);

const preConsumedLedger = createTemporalMaterialLedger(
  { "WIP-SPOT": 100 },
  [],
  [{ partCode: "WIP-SPOT", date: "2026-09-01", qty: 40, sourceId: "official-insp" }],
);
assert.deepStrictEqual(
  preConsumedLedger.consumeDetailed("WIP-SPOT", "2026-09-02", 80).allocatedQty,
  60,
  "official dated consumption must reduce stock before recommendation allocation",
);

const backwardTargets = deriveBackwardTargets({
  fgRequiredDate: "2026-09-10",
  qty: 40,
  routes: [
    { sequence: 1, mbomProcessId: "paint", leadDays: 1 },
    { sequence: 2, mbomProcessId: "inspection", leadDays: 1 },
  ],
});
assert.deepStrictEqual(
  backwardTargets.map((row) => [row.route.mbomProcessId, row.targetDate]),
  [
    ["paint", "2026-09-09"],
    ["inspection", "2026-09-10"],
  ],
  "the predecessor must finish one day before its successor target",
);

function recommendationFixture(resources) {
  return {
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    openingStock: { "WIP-PAINT": 60 },
    receipts: [
      {
        partCode: "WIP-PAINT",
        date: "2026-09-08",
        qty: 191,
        sourceId: "paint-return-1",
      },
      {
        partCode: "WIP-PAINT",
        date: "2026-10-01",
        qty: 23,
        sourceId: "paint-return-2",
      },
    ],
    consumptions: [],
    existingAllocations: [
      {
        id: "allocation-preserved",
        lineNumber: 2,
        mbomProcessId: "inspection-preserved",
        scheduleDate: "2026-09-05",
        plannedQty: 10,
        machineId: "machine-070",
      },
    ],
    jobs: [
      {
        lineNumber: 1,
        qty: 274,
        priorityScore: 100,
        fgRequiredDate: "2026-09-10",
        routes: [
          {
            lineNumber: 1,
            sequence: 1,
            mbomProcessId: "inspection-bracket",
            processCode: "INSP-PACK",
            outputPartCode: "FG-BRACKET",
            inputPartCode: "WIP-PAINT",
            inputQtyPerOutput: 1,
            minutesPerUnit: 1,
            leadDays: 1,
            routingMode: "INHOUSE",
            fgRequiredDate: "2026-09-10",
            resources,
          },
        ],
      },
      {
        lineNumber: 2,
        qty: 10,
        priorityScore: 50,
        fgRequiredDate: "2026-09-05",
        routes: [
          {
            lineNumber: 2,
            sequence: 1,
            mbomProcessId: "inspection-preserved",
            processCode: "INSP-PACK",
            outputPartCode: "FG-PRESERVED",
            inputPartCode: null,
            minutesPerUnit: 1,
            leadDays: 1,
            routingMode: "INHOUSE",
            fgRequiredDate: "2026-09-05",
            resources,
          },
        ],
      },
      {
        lineNumber: 3,
        qty: 15,
        priorityScore: 10,
        fgRequiredDate: "2026-09-12",
        routes: [
          {
            lineNumber: 3,
            sequence: 1,
            mbomProcessId: "vendor-paint",
            processCode: "PAINT",
            outputPartCode: "WIP-VENDOR",
            inputPartCode: null,
            minutesPerUnit: 0,
            leadDays: 2,
            routingMode: "VENDOR",
            minimumOrderQty: 20,
            orderMultipleQty: 10,
            fgRequiredDate: "2026-09-12",
            resources: [
              {
                id: "vendor-a",
                vendorId: "vendor-a",
                vendorCode: "V-A",
                workCenterId: "wc-vendor",
                matrixRowKey: "vendor:paint",
                matrixChildKey: "vendor:paint:line-3",
                availableMinutes: 9999,
                projectedLoadMinutes: 0,
              },
            ],
          },
        ],
      },
    ],
  };
}

const resources = [
  {
    id: "machine-071",
    machineId: "machine-071",
    machineCode: "M-071",
    workCenterId: "wc-inspection",
    matrixRowKey: "wc:inspection",
    matrixChildKey: "wc:inspection:line-1",
    availableMinutesByDate: { "2026-09-08": 100, "2026-09-10": 100 },
    availableMinutes: 100,
    projectedLoadMinutes: 0,
  },
  {
    id: "machine-070",
    machineId: "machine-070",
    machineCode: "M-070",
    workCenterId: "wc-inspection",
    matrixRowKey: "wc:inspection",
    matrixChildKey: "wc:inspection:line-1",
    availableMinutesByDate: { "2026-09-05": 100, "2026-09-08": 100, "2026-09-10": 100 },
    availableMinutes: 100,
    projectedLoadMinutes: 0,
  },
];

const result = buildMonthlyPlanRecommendation(recommendationFixture(resources));
const bracketAllocations = result.items
  .filter((item) => item.partCode === "FG-BRACKET" && item.changeType)
  .map((item) => [item.itemType, item.proposedValue.targetDate, item.proposedValue.qty]);
assert.deepStrictEqual(
  bracketAllocations,
  [
    ["NEW_ALLOCATION", "2026-09-10", 251],
  ],
  "material yang sudah tersedia sebelum target harus dikonsolidasikan sampai batas dua shift, bukan dihentikan per receipt atau satu jam",
);
const carryOver = result.items.find(
  (item) => item.itemType === "CARRY_OVER" && item.partCode === "FG-BRACKET",
);
assert.deepStrictEqual(
  [carryOver.proposedValue.earliestAvailableDate, carryOver.proposedValue.qty],
  ["2026-10-01", 23],
  "material outside the plan month must stay visible as carry-over",
);
assert.strictEqual(result.summary.overloadCellCount, 1);
assert.strictEqual(result.summary.fgOnTimeCount, 2);
assert.strictEqual(result.summary.fgLateCount, 1);
assert.strictEqual(
  result.items.find((item) => item.reasonCode === "PRESERVE_ON_TIME_ALLOCATION")
    .changeType,
  null,
  "an existing on-time allocation must remain unchanged",
);
assert.strictEqual(
  result.items.some(
    (item) =>
      item.reasonCode === "VENDOR_MOQ_BLOCKED" && item.changeType === null,
  ),
  true,
  "a vendor batch below MOQ must be reported, not auto-applied",
);
assert.strictEqual(
  bracketAllocations.every((row) => row && row.length === 3),
  true,
);
assert.strictEqual(
  result.items
    .filter((item) => item.changeType && item.partCode === "FG-BRACKET")
    .every((item) => item.proposedValue.targetMachineId === "machine-070"),
  true,
  "equal-load resources must be selected deterministically by machine code",
);

const permuted = buildMonthlyPlanRecommendation(
  recommendationFixture([...resources].reverse()),
);
assert.deepStrictEqual(
  permuted,
  result,
  "permuting eligible machine input order must not change the recommendation",
);

const minimumBatchResult = buildMonthlyPlanRecommendation({
  periodStart: "2026-09-01",
  periodEnd: "2026-09-30",
  openingStock: { "WIP-MIN-BATCH": 30 },
  receipts: [
    { partCode: "WIP-MIN-BATCH", date: "2026-09-08", qty: 30, sourceId: "receipt-30" },
    { partCode: "WIP-MIN-BATCH", date: "2026-09-08", qty: 90, sourceId: "receipt-90" },
  ],
  consumptions: [],
  existingAllocations: [],
  jobs: [
    {
      lineNumber: 10,
      qty: 150,
      fgRequiredDate: "2026-09-10",
      routes: [
        {
          lineNumber: 10,
          sequence: 1,
          mbomProcessId: "route-minimum-hour",
          processCode: "WELD-1",
          outputPartCode: "WIP-WELD",
          inputPartCode: "WIP-MIN-BATCH",
          inputQtyPerOutput: 1,
          minutesPerUnit: 1,
          leadDays: 1,
          routingMode: "INHOUSE",
          fgRequiredDate: "2026-09-10",
          resources,
        },
      ],
    },
  ],
});
const minimumHourAllocations = minimumBatchResult.items
  .filter((item) => item.partCode === "WIP-WELD" && item.changeType)
  .map((item) => Number(item.proposedValue.qty));
assert.deepStrictEqual(
  minimumHourAllocations,
  [150],
  "a 2.5-hour recommendation must continue beyond its one-hour minimum while it remains below the two-shift cap",
);

const deferredMaterialResult = buildMonthlyPlanRecommendation({
  periodStart: "2026-09-01",
  periodEnd: "2026-09-30",
  openingStock: {},
  receipts: [
    { partCode: "RAW-DEFERRED", date: "2026-09-22", qty: 9, sourceId: "receipt-raw-9" },
  ],
  consumptions: [],
  existingAllocations: [],
  jobs: [
    {
      lineNumber: 11,
      qty: 9,
      fgRequiredDate: "2026-09-10",
      routes: [
        {
          lineNumber: 11,
          sequence: 1,
          mbomProcessId: "route-deferred-weld",
          processCode: "WELD-1",
          outputPartCode: "WIP-DEFERRED",
          inputPartCode: "RAW-DEFERRED",
          inputQtyPerOutput: 1,
          minutesPerUnit: 1,
          leadDays: 1,
          routingMode: "INHOUSE",
          fgRequiredDate: "2026-09-10",
          resources,
        },
        {
          lineNumber: 11,
          sequence: 2,
          mbomProcessId: "route-deferred-inspection",
          processCode: "INSP-PACK",
          outputPartCode: "FG-DEFERRED",
          inputPartCode: "WIP-DEFERRED",
          inputQtyPerOutput: 1,
          minutesPerUnit: 1,
          leadDays: 1,
          routingMode: "INHOUSE",
          fgRequiredDate: "2026-09-10",
          resources,
        },
      ],
    },
  ],
});
assert.deepStrictEqual(
  deferredMaterialResult.items
    .filter((item) => ["WIP-DEFERRED", "FG-DEFERRED"].includes(item.partCode) && item.changeType)
    .map((item) => [item.partCode, item.proposedValue.targetDate, item.proposedValue.qty]),
  [
    ["WIP-DEFERRED", "2026-09-22", 9],
    ["FG-DEFERRED", "2026-09-23", 9],
  ],
  "material arriving inside the plan horizon must be auto-scheduled at its availability and flow D+1 to the successor",
);
assert.strictEqual(
  deferredMaterialResult.items.some((item) =>
    ["MATERIAL_QUEUE", "CARRY_OVER"].includes(item.itemType)),
  false,
  "an in-month material receipt must not remain stranded in Material Queue",
);
assert.deepStrictEqual(
  {
    fgCoverageReady: deferredMaterialResult.summary.fgCoverageReady,
    remainingAllocationQty: deferredMaterialResult.summary.remainingAllocationQty,
  },
  { fgCoverageReady: true, remainingAllocationQty: 0 },
  "late-but-scheduled material must clear the allocation gate while remaining visible as FG late",
);

const deferredMinimumHourResult = buildMonthlyPlanRecommendation({
  periodStart: "2026-09-01",
  periodEnd: "2026-09-30",
  openingStock: { "RAW-MIXED": 30 },
  receipts: [
    { partCode: "RAW-MIXED", date: "2026-09-22", qty: 30, sourceId: "receipt-mixed-30" },
  ],
  consumptions: [],
  existingAllocations: [],
  jobs: [
    {
      lineNumber: 13,
      qty: 60,
      fgRequiredDate: "2026-09-10",
      routes: [
        {
          lineNumber: 13,
          sequence: 1,
          mbomProcessId: "route-deferred-minimum-hour",
          processCode: "WELD-1",
          outputPartCode: "WIP-MIXED",
          inputPartCode: "RAW-MIXED",
          inputQtyPerOutput: 1,
          minutesPerUnit: 1,
          leadDays: 1,
          routingMode: "INHOUSE",
          fgRequiredDate: "2026-09-10",
          resources,
        },
      ],
    },
  ],
});
assert.deepStrictEqual(
  deferredMinimumHourResult.items
    .filter((item) => item.partCode === "WIP-MIXED" && item.changeType)
    .map((item) => [item.proposedValue.targetDate, item.proposedValue.qty]),
  [["2026-09-22", 60]],
  "current and deferred material must be consolidated so auto allocation does not create sub-hour batches",
);
assert.strictEqual(
  minimumHourAllocations.every((qty) => qty >= 60),
  true,
  "each recommended in-house batch must be at least 60 minutes when total remaining work exceeds one hour",
);

const shortNeedResult = buildMonthlyPlanRecommendation({
  periodStart: "2026-09-01",
  periodEnd: "2026-09-30",
  openingStock: { "WIP-SHORT": 30 },
  receipts: [],
  consumptions: [],
  existingAllocations: [],
  jobs: [
    {
      lineNumber: 11,
      qty: 30,
      fgRequiredDate: "2026-09-10",
      routes: [
        {
          lineNumber: 11,
          sequence: 1,
          mbomProcessId: "route-short-need",
          processCode: "INSP-1",
          outputPartCode: "FG-SHORT",
          inputPartCode: "WIP-SHORT",
          inputQtyPerOutput: 1,
          minutesPerUnit: 1,
          leadDays: 1,
          routingMode: "INHOUSE",
          fgRequiredDate: "2026-09-10",
          resources,
        },
      ],
    },
  ],
});
assert.deepStrictEqual(
  shortNeedResult.items
    .filter((item) => item.partCode === "FG-SHORT" && item.changeType)
    .map((item) => Number(item.proposedValue.qty)),
  [30],
  "the complete remaining need is allowed below one hour when no larger batch exists",
);

const sourceLimitedResult = buildMonthlyPlanRecommendation({
  periodStart: "2026-09-01",
  periodEnd: "2026-09-30",
  openingStock: {},
  receipts: [],
  consumptions: [],
  existingAllocations: [
    {
      id: "existing-weld-40",
      lineNumber: 12,
      mbomProcessId: "route-source-limited",
      scheduleDate: "2026-09-01",
      plannedQty: 40,
      machineId: "machine-070",
    },
  ],
  jobs: [
    {
      lineNumber: 12,
      qty: 100,
      fgRequiredDate: "2026-09-10",
      routes: [
        {
          lineNumber: 12,
          sequence: 1,
          mbomProcessId: "route-source-limited",
          processCode: "WELD-1",
          outputPartCode: "WIP-SOURCE-LIMITED",
          inputPartCode: null,
          minutesPerUnit: 1,
          leadDays: 1,
          routingMode: "INHOUSE",
          fgRequiredDate: "2026-09-10",
          resources,
        },
      ],
    },
  ],
});
const sourceLimitedAllocations = sourceLimitedResult.items.filter(
  (item) =>
    item.partCode === "WIP-SOURCE-LIMITED" &&
    ["NEW_ALLOCATION", "MOVE_ALLOCATION", "SPLIT_ALLOCATION", "PRESERVED_ALLOCATION"].includes(
      item.itemType,
    ),
);
assert.strictEqual(
  sourceLimitedAllocations
    .filter((item) => item.sourceAllocationId === "existing-weld-40")
    .reduce((sum, item) => sum + Number(item.proposedValue.qty || 0), 0),
  40,
  "recommendation moves/splits must never consume more than the existing source allocation",
);
assert.strictEqual(
  sourceLimitedAllocations
    .filter((item) => !item.sourceAllocationId)
    .reduce((sum, item) => sum + Number(item.proposedValue.qty || 0), 0),
  60,
  "demand above the existing source must become a new remaining allocation instead of inflating the source move",
);
assert.deepStrictEqual(
  {
    fgCoverageReady: sourceLimitedResult.summary.fgCoverageReady,
    fgUncoveredCount: sourceLimitedResult.summary.fgUncoveredCount,
    remainingAllocationQty: sourceLimitedResult.summary.remainingAllocationQty,
  },
  { fgCoverageReady: true, fgUncoveredCount: 0, remainingAllocationQty: 0 },
  "a complete recommendation must expose both FG coverage and zero remaining allocation gates",
);

function singleRouteBatchFixture({ qty, sourceQty, minutesPerUnit, outputPartCode, maximumBatchMinutes = 840 }) {
  return {
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    minimumBatchMinutes: 60,
    maximumBatchMinutes,
    openingStock: { "WIP-BE": sourceQty },
    receipts: [],
    consumptions: [],
    existingAllocations: [],
    jobs: [{
      lineNumber: 20,
      // MRP passes its authoritative net requirement here: EFD requirement
      // minus actual stock at the target WIP level.
      qty,
      fgRequiredDate: "2026-09-20",
      routes: [{
        lineNumber: 20,
        sequence: 1,
        mbomProcessId: `route-${outputPartCode}`,
        processCode: "WELD-1",
        outputPartCode,
        inputPartCode: "WIP-BE",
        inputQtyPerOutput: 1,
        minutesPerUnit,
        leadDays: 1,
        routingMode: "INHOUSE",
        fgRequiredDate: "2026-09-20",
        resources,
      }],
    }],
  };
}

const fullTwoShiftResult = buildMonthlyPlanRecommendation(singleRouteBatchFixture({
  qty: 800,
  sourceQty: 800,
  minutesPerUnit: 1.05,
  outputPartCode: "WIP-WELD-800",
}));
assert.deepStrictEqual(
  fullTwoShiftResult.items
    .filter((item) => item.partCode === "WIP-WELD-800" && item.changeType)
    .map((item) => [item.proposedValue.qty, item.proposedValue.batchDurationMinutes]),
  [[800, 840]],
  "800 PCS BE yang tepat mengisi dua shift harus menjadi satu batch 800 PCS/840 menit, bukan berhenti setelah satu jam",
);

const netTargetResult = buildMonthlyPlanRecommendation(singleRouteBatchFixture({
  qty: 700,
  sourceQty: 800,
  minutesPerUnit: 1,
  outputPartCode: "WIP-WELD-NET",
}));
assert.deepStrictEqual(
  netTargetResult.items
    .filter((item) => item.partCode === "WIP-WELD-NET" && item.changeType)
    .map((item) => item.proposedValue.qty),
  [700],
  "auto plan may not exceed the MRP net target (EFD requirement minus actual target-WIP stock)",
);

const sourceShortResult = buildMonthlyPlanRecommendation(singleRouteBatchFixture({
  qty: 500,
  sourceQty: 40,
  minutesPerUnit: 3,
  outputPartCode: "WIP-WELD-SOURCE-SHORT",
}));
assert.deepStrictEqual(
  sourceShortResult.items
    .filter((item) => item.partCode === "WIP-WELD-SOURCE-SHORT" && item.changeType)
    .map((item) => [item.proposedValue.qty, item.proposedValue.batchDurationMinutes]),
  [[40, 120]],
  "jika source BE hanya 40 PCS/2 jam, rekomendasi harus berhenti di 40 dan menunggu receipt source berikutnya",
);
assert.strictEqual(
  sourceShortResult.items.find((item) => item.itemType === "MATERIAL_QUEUE")?.proposedValue.qty,
  460,
  "sisa kebutuhan yang belum mempunyai source harus tetap terlihat di Material Queue",
);

const crossDayResult = buildMonthlyPlanRecommendation(singleRouteBatchFixture({
  qty: 900,
  sourceQty: 900,
  minutesPerUnit: 1,
  outputPartCode: "WIP-WELD-CROSS-DAY",
}));
assert.deepStrictEqual(
  crossDayResult.items
    .filter((item) => item.partCode === "WIP-WELD-CROSS-DAY" && item.changeType)
    .map((item) => [item.proposedValue.targetDate, item.proposedValue.qty, item.proposedValue.batchDurationMinutes]),
  [
    ["2026-09-19", 840, 840],
    ["2026-09-20", 60, 60],
  ],
  "kebutuhan di atas dua shift harus diteruskan ke hari lain sampai net target tercukupi",
);

console.log("Monthly plan recommendation domain contract passed.");
