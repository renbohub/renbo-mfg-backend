"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  calculateLeadTimeFeasibility,
  classifyFeasibility,
  explodeDemandBom,
  purchaseSuggestionRoutingMetric,
  normalizeLeadTimeControls,
  resolveSupplierItem,
  addWorkingHours,
  subtractWorkingHours,
  applyVendorProcessAdjustments,
  applyVendorAdjustmentsToProcessSteps,
  vendorProcessKey,
} = require("../src/prisma/services/planning/demandFeasibilityService");
const { procurementSchedule } = require("../src/prisma/services/planning/procurementSchedulingService");
const { resolveProcurementMasterIdentity, resolvePurchaseScheduleForRequirement } = require("../src/prisma/services/planning/mrpPresentationService");
const { allocatePurchaseQtyToSources, applyConfirmedMoqPullForward, applyMoqCarryForward, buildMoqAllocationCandidates } = require("../src/prisma/services/purchasing/purchaseSuggestionAllocationService");
const {
  calculatePriority,
  consolidateRequirements,
  mergeForecastWithActualSalesOrders,
  attachDraftSalesOrders,
  capacityHorizonMonths,
  normalizeFgFinishSplits,
  procurementWindow,
  planningAnchorMonth,
  mpsWindowMonths,
} = require("../src/prisma/services/planning/demandPlanningService");
const { groupTargetsByDeliveryMonth, alignExplicitForecastConsumptionAcrossBuckets, resolveActiveCanonicalMpsStatus, resolveActiveCanonicalMpsLifecycle } = require("../src/prisma/services/planning/monthlyPlanningService");
const {
  monthlyMrpIdentity,
} = require("../src/prisma/services/planning/mrpPlanningIdentityService");
const {
  resolveActiveSalesPrice,
  calculateMarginPreview,
} = require("../src/prisma/services/sales/salesPricingService");
const {
  evaluateDisplacement,
} = require("../src/prisma/services/planning/dppDisplacementService");
const {
  effectiveDemandQty,
  effectiveDemandWithBuffer,
  consumeDeliveryTargets,
} = require("../src/prisma/services/planning/demandConsumptionService");
const {
  buildDueDateRecoveryChecklist,
  validateRecoveryChecklist,
} = require("../src/prisma/services/planning/dueDateRecoveryService");
const { supplierLeadTimeChanged, updateSupplierAndInheritedItemLeadTime } = require("../src/prisma/controllers/master-data/SupplierController");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const day = (value) => new Date(`${value}T00:00:00.000Z`);

test("production lead time remains mandatory while PPIC may waive supplier QC and safety assumptions", () => {
  assert.deepEqual(normalizeLeadTimeControls({ productionProcess: false, supplierLeadTime: false, receivingQc: false, safety: false }), {
    productionProcess: true,
    supplierLeadTime: false,
    receivingQc: false,
    safety: false,
  });
});

test("fastest supplier resolver uses active option lead time with deterministic tie break", () => {
  const items = [
    { id: "SI-SLOW", leadTimeDays: 12, isPreferred: true, priority: 1, supplier: { supplierCode: "S001", supplierName: "Preferred" } },
    { id: "SI-FAST-B", leadTimeDays: 4, isPreferred: false, priority: 2, supplier: { supplierCode: "S003", supplierName: "Fast B" } },
    { id: "SI-FAST-A", leadTimeDays: 4, isPreferred: false, priority: 1, supplier: { supplierCode: "S002", supplierName: "Fast A" } },
  ];
  const fastest = resolveSupplierItem(items, "MAT-1", { supplierStrategy: "FASTEST" });
  assert.equal(fastest.item.id, "SI-FAST-A");
  assert.equal(fastest.selectionSource, "FASTEST");
  const explicit = resolveSupplierItem(items, "MAT-1", { supplierStrategy: "FASTEST", supplierSelections: { "MAT-1": "SI-SLOW" } });
  assert.equal(explicit.item.id, "SI-SLOW", "explicit PPIC supplier selection overrides global fastest strategy");
  assert.equal(explicit.selectionSource, "EXPLICIT");
});

test("supplier master lead-time update cascades only inherited Supplier Item values", async () => {
  assert.equal(supplierLeadTimeChanged(7, 5), true);
  assert.equal(supplierLeadTimeChanged(5, 5), false);
  let itemUpdate = null;
  const db = { $transaction: async (run) => run({
    supplierItem: { updateMany: async (args) => { itemUpdate = args; return { count: 14 }; } },
    supplier: { update: async ({ data }) => ({ id: "S1", ...data, mainBusinesses: [] }) },
  }) };
  const result = await updateSupplierAndInheritedItemLeadTime(db, "S1", { leadTimeDays: 7 }, { leadTimeDays: 5 });
  assert.equal(result.synchronizedSupplierItemCount, 14);
  assert.deepEqual(itemUpdate.where.OR, [{ leadTimeDays: null }, { leadTimeDays: 7 }]);
  assert.equal(itemUpdate.data.leadTimeDays, 5);
});

test("FG risk preserves production precision in working hours across weekends", () => {
  assert.equal(addWorkingHours(day("2026-08-14"), 20, { hoursPerDay: 16 }).toISOString(), "2026-08-17T04:00:00.000Z");
  assert.equal(subtractWorkingHours(day("2026-08-17"), 6, { hoursPerDay: 16 }).toISOString(), "2026-08-14T10:00:00.000Z");
  const result = calculateLeadTimeFeasibility({
    requestedDeliveryDate: day("2026-08-28"), today: day("2026-08-11"), dispatchDays: 0,
    sourceType: "FORECAST", capacityShiftsPerDay: 2, capacityHoursPerShift: 8,
    productionLeadTimeBreakdown: { productionLeadTimeDays: 1, exactProductionLeadTimeDays: 0.5, capacityAdjusted: true, capacityShiftsPerDay: 2 },
    supplierLeadTimeDays: 0, prApprovalDays: 0, poProcessingDays: 0, receivingQcDays: 0, safetyLeadTimeDays: 0,
  });
  assert.equal(result.scheduledProductionLeadTimeHours, 8);
  assert.equal(result.productionLatestStartDate.toISOString(), "2026-08-27T08:00:00.000Z");
});

test("forecast 10,000 keeps three delivery phases", () => {
  const result = consumeDeliveryTargets({
    policy: "MTS",
    forecastTargets: [
      { id: "F1", targetDate: day("2026-08-05"), qty: 3000 },
      { id: "F2", targetDate: day("2026-08-15"), qty: 3000 },
      { id: "F3", targetDate: day("2026-08-25"), qty: 4000 },
    ],
  });
  assert.equal(result.length, 3);
  assert.equal(result.reduce((sum, row) => sum + row.qty, 0), 10000);
});

test("SO consumes forecast without duplicate demand", () => {
  const rows = consumeDeliveryTargets({
    policy: "MTS",
    forecastTargets: [{ id: "F1", targetDate: day("2026-08-20"), qty: 10000 }],
    salesOrderTargets: [{ id: "S1", targetDate: day("2026-08-10"), qty: 6000 }],
  });
  assert.equal(rows.reduce((sum, row) => sum + row.qty, 0), 10000);
  assert.equal(rows.filter((row) => row.sourceType === "SALES_ORDER")[0].qty, 6000);
});

test("SO explicitly pulls the selected September Forecast target into August", () => {
  const rows = consumeDeliveryTargets({
    policy: "MTS",
    forecastTargets: [
      { id: "F-AUG", targetDate: day("2026-08-20"), qty: 100 },
      { id: "F-SEP", targetDate: day("2026-09-12"), qty: 100 },
    ],
    salesOrderTargets: [{ id: "S-AUG", targetDate: day("2026-08-30"), qty: 60, consumesForecastTargetId: "F-SEP" }],
  });
  const actual = rows.find((row) => row.sourceType === "SALES_ORDER");
  assert.equal(actual.matchedForecastTargetId, "F-SEP");
  assert.equal(actual.targetDate.toISOString(), day("2026-08-30").toISOString());
  assert.equal(rows.find((row) => row.id === "F-SEP").qty, 40);
  assert.equal(rows.reduce((sum, row) => sum + row.qty, 0), 200);
});

test("cross-month MPS buckets remove only the quantity explicitly consumed by SO", () => {
  const buckets = new Map([
    ["2026-08|FG01", { month: "2026-08", part: { planningPolicy: "MTS" }, forecastQty: 0, actualSalesOrderQty: 60, forecastTargets: [], soTargets: [{ id: "S-AUG", sourceType: "SALES_ORDER", sourceNumber: "SO-1", sourceLineId: "SO-L1", customerCode: "C01", partCode: "FG01", targetDate: day("2026-08-30"), qty: 60, consumesForecastTargetId: "F-SEP" }], sourceRows: [{ sourceType: "SALES_ORDER", sourceNumber: "SO-1", sourceLineId: "SO-L1", qty: 60 }] }],
    ["2026-09|FG01", { month: "2026-09", part: { planningPolicy: "MTS" }, forecastQty: 100, actualSalesOrderQty: 0, forecastTargets: [{ id: "F-SEP", sourceType: "FORECAST", sourceNumber: "FC-1", sourceLineId: "FC-L1", customerCode: "C01", partCode: "FG01", targetDate: day("2026-09-12"), qty: 100 }], soTargets: [], sourceRows: [{ sourceType: "FORECAST", sourceNumber: "FC-1", sourceLineId: "FC-L1", qty: 100 }] }],
  ]);
  alignExplicitForecastConsumptionAcrossBuckets(buckets);
  assert.equal(buckets.get("2026-09|FG01").forecastQty, 40);
  assert.equal(buckets.get("2026-09|FG01").forecastTargets[0].qty, 40);
  assert.equal(buckets.get("2026-08|FG01").soTargets[0].matchedForecastTargetId, "F-SEP");
  assert.equal([...buckets.values()].reduce((sum, bucket) => sum + bucket.forecastQty + bucket.actualSalesOrderQty, 0), 100);
});

test("Demand Planning presents SO as actual inside Forecast delivery target", () => {
  const rows = mergeForecastWithActualSalesOrders({
    forecastTargets: [
      { id: "F1", customerCode: "C01", partCode: "FG01", targetDate: day("2026-08-15"), qty: 100 },
      { id: "F2", customerCode: "C01", partCode: "FG01", targetDate: day("2026-09-15"), qty: 100 },
    ],
    salesOrderTargets: [{ id: "S1", sourceNumber: "SO-1", customerCode: "C01", partCode: "FG01", targetDate: day("2026-08-10"), qty: 60 }],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].forecastQty, 100);
  assert.equal(rows[0].actualSalesOrderQty, 60);
  assert.equal(rows[0].actualSalesOrders[0].sourceNumber, "SO-1");
  assert.equal(rows.reduce((sum, row) => sum + row.effectiveDemandQty, 0), 200);
});

test("Draft SO is visible as provisional but does not consume Forecast before confirmation", () => {
  const forecastRows = mergeForecastWithActualSalesOrders({
    forecastTargets: [{ id: "F-SEP", sourceNumber: "FC-1", customerCode: "C01", partCode: "FG01", targetDate: day("2026-09-12"), qty: 300 }],
    salesOrderTargets: [],
    planningPolicyByPart: new Map([["FG01", "MTO"]]),
  });
  const rows = attachDraftSalesOrders(forecastRows, [{ id: "SO-T1", sourceNumber: "SO-DRAFT-1", sourceLineId: "SO-L1", customerCode: "C01", partCode: "FG01", targetDate: day("2026-08-31"), qty: 300, consumesForecastTargetId: "F-SEP", soStatus: "Draft" }]);
  assert.equal(rows[0].draftSalesOrderQty, 300);
  assert.equal(rows[0].draftSalesOrders[0].sourceNumber, "SO-DRAFT-1");
  assert.equal(rows[0].actualSalesOrderQty, 0, "Draft is not firm Actual SO");
  assert.equal(rows[0].effectiveDemandQty, 300, "Forecast remains the planning demand until SO confirmation");
  assert.equal(rows[0].effectiveTargetDate.toISOString(), day("2026-09-12").toISOString(), "Draft must not pull due date forward before confirmation");
});

test("Demand Planning keeps Forecast history and exposes pulled-forward effective delivery", () => {
  const rows = mergeForecastWithActualSalesOrders({
    forecastTargets: [{ id: "F-SEP", sourceNumber: "FC-1", customerCode: "C01", partCode: "FG01", targetDate: day("2026-09-12"), qty: 100 }],
    salesOrderTargets: [{ id: "S-AUG", sourceNumber: "SO-1", customerCode: "C01", partCode: "FG01", targetDate: day("2026-08-30"), qty: 60, consumesForecastTargetId: "F-SEP" }],
    planningPolicyByPart: new Map([["FG01", "MTS"]]),
  });
  const row = rows.find((item) => item.id === "F-SEP");
  assert.equal(row.forecastTargetDate.toISOString(), day("2026-09-12").toISOString());
  assert.equal(row.effectiveTargetDate.toISOString(), day("2026-08-30").toISOString());
  assert.equal(row.pullForwardDays, 13);
  assert.deepEqual(row.effectiveDeliverySplits.map((split) => [split.targetDate.toISOString().slice(0, 10), split.qty]), [["2026-08-30", 60], ["2026-09-12", 40]]);
});

test("Demand Planning keeps unmatched SO visible without duplicating Forecast", () => {
  const rows = mergeForecastWithActualSalesOrders({
    forecastTargets: [{ id: "F1", customerCode: "C01", partCode: "FG01", targetDate: day("2026-08-15"), qty: 50 }],
    salesOrderTargets: [{ id: "S1", sourceNumber: "SO-1", customerCode: "C01", partCode: "FG01", targetDate: day("2026-08-10"), qty: 80 }],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.demandType === "FORECAST").actualSalesOrderQty, 50);
  assert.equal(rows.find((row) => row.demandType === "UNPLANNED_SO").actualSalesOrderQty, 30);
});

test("capacity horizon starts one month before earliest Forecast target", () => {
  assert.deepEqual(capacityHorizonMonths([day("2026-08-10"), day("2026-10-20")]), ["2026-07", "2026-08", "2026-09", "2026-10"]);
});

test("FG finish target can be split without changing customer delivery", () => {
  const splits = normalizeFgFinishSplits([
    { targetFinishDate: "2026-08-20", qty: 40 },
    { targetFinishDate: "2026-08-25", qty: 60 },
  ], { demandQty: 100, fallbackDate: day("2026-08-25"), deliveryDate: day("2026-08-31") });
  assert.equal(splits.length, 2);
  assert.equal(splits.reduce((sum, row) => sum + row.qty, 0), 100);
  assert.equal(splits[1].targetFinishDate.toISOString(), day("2026-08-25").toISOString());
});

test("FG finish split total must equal effective demand", () => {
  assert.throws(() => normalizeFgFinishSplits([{ targetFinishDate: "2026-08-20", qty: 90 }], { demandQty: 100, fallbackDate: day("2026-08-20"), deliveryDate: day("2026-08-31") }), /harus sama/);
});

test("FG finish splits propagate through MPS, MRP, and capacity", () => {
  const monthly = fs.readFileSync(path.join(__dirname, "../src/prisma/services/planning/monthlyPlanningService.js"), "utf8");
  const mrp = fs.readFileSync(path.join(__dirname, "../src/prisma/controllers/planning/MRPController.js"), "utf8");
  const capacity = fs.readFileSync(path.join(__dirname, "../src/prisma/services/planning/capacityRecommendationService.js"), "utf8");
  assert(monthly.includes("fgFinishSplitNumber: split.phaseNumber"));
  assert(monthly.includes("fgRequiredDate: split.targetFinishDate"));
  assert(mrp.includes("phase.fgRequiredDate || phase.plannedDate"));
  assert(mrp.includes("_customerTargetDate: phase.plannedDate"));
  assert(capacity.includes("phase.fgRequiredDate || receipt.fgRequiredDate"));
});

test("MTO partial SO consumes only the matched provisional forecast quantity", () => {
  assert.equal(effectiveDemandQty({ forecastQty: 10000, salesOrderQty: 6000, policy: "MTO" }), 10000);
});

test("MPS keeps ending buffer after MTO replaces provisional Forecast with SO", () => {
  assert.equal(effectiveDemandWithBuffer({ forecastQty: 0, salesOrderQty: 300, bufferQty: 150, policy: "MTO" }), 450);
  assert.equal(effectiveDemandWithBuffer({ forecastQty: 300, salesOrderQty: 200, bufferQty: 150, policy: "MTS" }), 450);
});

test("MTS uses max forecast or SO", () => {
  assert.equal(effectiveDemandQty({ forecastQty: 10000, salesOrderQty: 12000, policy: "MTS" }), 12000);
});

test("overdue SO preserves due date and becomes P0/P1", () => {
  const result = calculatePriority({ sourceType: "SALES_ORDER", targetDeliveryDate: day("2026-08-01"), today: day("2026-08-09") });
  assert(result.score >= 75);
  assert(["P0", "P1"].includes(result.priorityClass));
  assert.equal(result.targetDeliveryDate.toISOString(), day("2026-08-01").toISOString());
});

test("supplier lead time can make delivery not feasible", () => {
  const timeline = calculateLeadTimeFeasibility({
    requestedDeliveryDate: day("2026-08-12"),
    today: day("2026-08-09"),
    dispatchDays: 1,
    processSteps: [{ sequence: 1, durationDays: 1 }],
    supplierLeadTimeDays: 10,
    prApprovalDays: 1,
  });
  assert.equal(classifyFeasibility({ timeline }).status, "NOT_FEASIBLE");
});

test("Forecast feasibility calculates an earlier delivery using two-shift capacity", () => {
  const common = {
    requestedDeliveryDate: day("2026-08-31"), today: day("2026-08-10"), dispatchDays: 1,
    supplierLeadTimeDays: 0, prApprovalDays: 0, poProcessingDays: 0, transitDays: 0, receivingQcDays: 0, safetyLeadTimeDays: 0,
    productionLeadTimeBreakdown: {
      productionLeadTimeDays: 4, exactProductionLeadTimeDays: 4, inhouseProcessHours: 32, vendorScheduledDays: 0,
      processPath: [{ mode: "INHOUSE", elapsedDays: 4, rawElapsedDays: 4 }],
    },
  };
  const oneShift = calculateLeadTimeFeasibility({ ...common, sourceType: "SALES_ORDER", capacityShiftsPerDay: 1 });
  const twoShift = calculateLeadTimeFeasibility({ ...common, sourceType: "FORECAST" });
  assert.equal(twoShift.capacityAssumption.shiftsPerDay, 2);
  assert.equal(twoShift.productionLeadTimeBreakdown.baselineProductionLeadTimeDays, 4);
  assert.equal(twoShift.productionLeadTimeBreakdown.productionLeadTimeDays, 2);
  assert(twoShift.earliestFeasibleDeliveryDate < oneShift.earliestFeasibleDeliveryDate);
  assert.equal(twoShift.earliestFeasibleDeliveryDate.toISOString().slice(0, 10), "2026-08-12", "hourly calculation must not round 32 production hours into extra calendar days");
  assert.equal(oneShift.earliestFeasibleDeliveryDate.toISOString().slice(0, 10), "2026-08-14");
});

test("due-date recovery turns supplier risk into an approvable checklist", () => {
  const recommendation = buildDueDateRecoveryChecklist({
    status: "NOT_FEASIBLE", criticalConstraint: "SUPPLIER_LEAD_TIME", materialStatus: "SHORTAGE", capacityStatus: "NOT_SIMULATED",
    requestedDeliveryDate: day("2026-08-28"), fgRequiredDate: day("2026-08-27"), earliestFeasibleFgDate: day("2026-08-30"), earliestFeasibleDeliveryDate: day("2026-08-31"), latestPrDate: day("2026-08-10"), materialRequiredDate: day("2026-08-20"),
    constraintDetails: { earliestFgCalculation: { procurementLeadTimeBreakdown: { prApprovalDays: 1, poProcessingDays: 1, supplierLeadTimeDays: 7 } }, materialCoverage: [{ partCode: "MAT-1", shortageQty: 100, supplierCode: "S-1" }] },
  }, { today: day("2026-08-10") });
  assert.equal(recommendation.requestedDeliveryDate, "2026-08-28", "recovery must not move customer due date");
  assert.equal(recommendation.recoveryGapDays, 3);
  assert(recommendation.actions.some((item) => item.id === "RELEASE_PR_PO"));
  assert(recommendation.actions.some((item) => item.id === "SUPPLIER_COMMITMENT"));
  assert(recommendation.actions.some((item) => item.id === "RUN_CAPACITY_SIMULATION"));
});

test("PPIC recovery approval requires every required action owner and date", () => {
  const incomplete = [{ id: "A", title: "Release PR", required: true, selected: true, owner: "", targetDate: "2026-08-12" }];
  assert(validateRecoveryChecklist(incomplete, "2026-08-28").some((error) => error.includes("PIC wajib")));
  const complete = [{ ...incomplete[0], owner: "Purchasing" }];
  assert.deepEqual(validateRecoveryChecklist(complete, "2026-08-28"), []);
});

test("Forecast warning traces multi-level exploded BOM without losing quantities", async () => {
  const supplierItem = { leadTimeDays: 7, moq: 10, orderMultiple: 5, purchaseUomCode: "PCS", supplier: { supplierCode: "S001", supplierName: "Supplier 1", leadTimeDays: 7 } };
  const headers = {
    FG: { id: "BOM-FG", noReg: "MBOM-FG", details: [
      { id: "D-WIP", parentDetailId: null, levelComponent: 0, partId: "WIP", category: "inHouse", qty: 2, grossWeight: 0, uomCode: "PCS", part: { id: "WIP", partCode: "WIP-1", partName: "WIP", supplierItems: [] }, mbomProcesses: [{ sequence: 10, cycleTime: 2880, routingMode: "INHOUSE", process: { processCode: "PRESS" }, vendor: null }] },
      { id: "D-MAT1", parentDetailId: null, levelComponent: 0, partId: "MAT1", category: "Purchase", qty: 0, grossWeight: 3, uomCode: "KG", part: { id: "MAT1", partCode: "MAT-1", partName: "Material 1", supplierItems: [supplierItem] }, mbomProcesses: [] },
    ] },
    WIP: { id: "BOM-WIP", noReg: "MBOM-WIP", details: [
      { id: "D-MAT2", parentDetailId: null, levelComponent: 0, partId: "MAT2", category: "Purchase", qty: 4, grossWeight: 0, uomCode: "PCS", part: { id: "MAT2", partCode: "MAT-2", partName: "Material 2", supplierItems: [supplierItem] }, mbomProcesses: [] },
    ] },
  };
  const prisma = { mBOMHeader: { findFirst: async ({ where }) => headers[where.partId] || null } };
  const result = await explodeDemandBom(prisma, { partId: "FG", partCode: "FG-1", quantity: 5 });
  assert.equal(result.trace.length, 3);
  assert.equal(result.componentRequirements.find((row) => row.partCode === "MAT-1").qty, 15);
  assert.equal(result.componentRequirements.find((row) => row.partCode === "MAT-2").qty, 40);
  assert.deepEqual(result.componentRequirements.find((row) => row.partCode === "MAT-2").paths[0], ["FG-1", "WIP-1", "MAT-2"]);
  assert.equal(result.trace.find((row) => row.partCode === "WIP-1").processLeadTimeDays, 1);
  assert.equal(result.trace.find((row) => row.partCode === "MAT-2").cumulativeLeadTimeDays, 8);
});

test("Forecast feasibility reuses Purchase Suggestion critical path and procurement due date", async () => {
  const prisma = { mBOMHeader: { findMany: async () => [{ id: "BOM-1", noReg: "MBOM-1", details: [{
    id: "D1", parentDetailId: null, levelComponent: 0, qty: 1, category: "inHouse", leadTime: 0, leadTimeUnit: "HOUR",
    part: { partCode: "WIP-1", partName: "WIP" },
    mbomProcesses: [{ sequence: 10, routingMode: "INHOUSE", cycleTime: 3.6, process: { processCode: "PRESS", processName: "Press" }, vendor: null, routingOperation: null }],
  }] }] } };
  const metric = await purchaseSuggestionRoutingMetric(prisma, "BOM-1", 1000);
  assert.equal(metric.calculationMethod, "BOM_CRITICAL_PATH_ROUND_EACH_PROCESS_V4");
  assert.equal(metric.exactProductionLeadTimeDays, 0.125);
  assert.equal(metric.productionLeadTimeDays, 1, "each process must round upward like Purchase Suggestion");
  const timeline = calculateLeadTimeFeasibility({ requestedDeliveryDate: day("2026-08-28"), today: day("2026-08-10"), supplierLeadTimeDays: 7, productionLeadTimeBreakdown: metric });
  const purchaseDue = procurementSchedule({ materialRequiredDate: timeline.materialRequiredDate, supplierLeadTimeDays: 7, asOf: day("2026-08-10") });
  assert.equal(timeline.latestPrDate.toISOString(), purchaseDue.latestPrDate.toISOString());
  assert.equal(timeline.purchasingSchedule.totalLeadTimeDays, 11, "PR + PO + Supplier + QC + Safety must match Purchase Suggestion");
});

test("vendor process moves production latest start backward", () => {
  const withoutVendor = calculateLeadTimeFeasibility({ requestedDeliveryDate: day("2026-08-30"), today: day("2026-08-01"), processSteps: [{ sequence: 1, durationDays: 2 }] });
  const withVendor = calculateLeadTimeFeasibility({ requestedDeliveryDate: day("2026-08-30"), today: day("2026-08-01"), processSteps: [{ sequence: 1, durationDays: 2 }, { sequence: 2, durationDays: 4, routingMode: "VENDOR" }] });
  assert(withVendor.productionLatestStartDate < withoutVendor.productionLatestStartDate);
  assert(withVendor.vendorSendDate && withVendor.vendorReturnDate);
});

test("PPIC vendor duration overlay changes planning hours without mutating master baseline", () => {
  const vendorStep = { detailCode: "WIP-20", level: 2, sequence: 10, processCode: "PAINT", mode: "VENDOR", vendorCode: "V001", vendorName: "Vendor Paint", vendorLeadTimeDays: 5, elapsedHours: 40, elapsedDays: 5 };
  const breakdown = { productionLeadTimeDays: 7, exactProductionLeadTimeDays: 7, inhouseProcessHours: 16, vendorScheduledDays: 5, processPath: [vendorStep] };
  const policy = { hoursPerShift: 8, shiftsPerDay: 2 };
  const key = vendorProcessKey(vendorStep, 0);
  const result = applyVendorProcessAdjustments(breakdown, [{ key, adjustedDurationHours: 16, reason: "Vendor confirm slot express" }], policy);
  assert.equal(result.breakdown.processPath[0].masterDurationHours, 40);
  assert.equal(result.breakdown.processPath[0].elapsedHours, 16);
  assert.equal(result.breakdown.exactProductionLeadTimeDays, 2, "16 in-house + 16 vendor hours at 16 capacity hours/day");
  assert.equal(result.adjustments.length, 1);
  assert.equal(result.shortened.length, 1);
  assert.equal(vendorStep.elapsedHours, 40, "routing metric input remains immutable");
});

test("vendor process overlay cannot remove dependency and needs adjustment reason", () => {
  const vendorStep = { detailCode: "WIP-20", sequence: 10, processCode: "PAINT", mode: "VENDOR", vendorCode: "V001", elapsedHours: 40, elapsedDays: 5 };
  const breakdown = { inhouseProcessHours: 8, vendorScheduledDays: 5, processPath: [vendorStep] };
  const key = vendorProcessKey(vendorStep, 0);
  assert.throws(() => applyVendorProcessAdjustments(breakdown, [{ key, adjustedDurationHours: 0, reason: "hapus" }], { hoursPerShift: 8, shiftsPerDay: 1 }), /minimal 0,25 jam/);
  assert.throws(() => applyVendorProcessAdjustments(breakdown, [{ key, adjustedDurationHours: 16, reason: "" }], { hoursPerShift: 8, shiftsPerDay: 1 }), /Alasan adjustment vendor/);
});

test("vendor timeline send and return use the reviewed planning duration", () => {
  const vendorProcesses = [{ key: "K1", processCode: "PAINT", vendorCode: "V001", sequence: 10, masterDurationHours: 40, adjustedDurationHours: 16, reason: "Express slot" }];
  const processSteps = applyVendorAdjustmentsToProcessSteps([{ sequence: 10, processCode: "PAINT", routingMode: "VENDOR", vendorCode: "V001", durationDays: 5 }], vendorProcesses, { hoursPerShift: 8, shiftsPerDay: 1 });
  assert.equal(processSteps[0].durationDays, 2);
  const timeline = calculateLeadTimeFeasibility({ requestedDeliveryDate: day("2026-08-31"), today: day("2026-08-01"), dispatchDays: 1, processSteps });
  const baseline = calculateLeadTimeFeasibility({ requestedDeliveryDate: day("2026-08-31"), today: day("2026-08-01"), dispatchDays: 1, processSteps: [{ ...processSteps[0], durationDays: 5 }] });
  assert(timeline.vendorSendDate > baseline.vendorSendDate, "shorter reviewed duration must move vendor send date closer to return");
  assert.equal(timeline.processTimeline[0].durationHours, 16);
});

test("MRP consolidates common material while preserving customer pegging", () => {
  const grouped = consolidateRequirements([
    { partCode: "SPHC", requiredDate: day("2026-08-15"), qty: 5000, customerCode: "A", onHandQty: 6000 },
    { partCode: "SPHC", requiredDate: day("2026-08-15"), qty: 4000, customerCode: "B", onHandQty: 6000 },
  ]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].qty, 9000);
  assert.equal(grouped[0].coveredQty, 6000, "shared opening stock must only be counted once");
  assert.equal(grouped[0].shortageQty, 3000);
  assert.deepEqual(grouped[0].pegging.map((row) => row.customerCode), ["A", "B"]);
});

test("same month MRP shares plan number and increments revision", () => {
  assert.deepEqual(monthlyMrpIdentity("2026-08", 3), { planNumber: "MRP-202608", runNumber: "MRP-202608-R003", planRevision: 3 });
});

test("next month gets a new MRP plan number", () => {
  assert.notEqual(monthlyMrpIdentity("2026-08", 1).planNumber, monthlyMrpIdentity("2026-09", 1).planNumber);
});

test("superseded MRP revisions preserve historical rows", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/prisma/controllers/planning/MRPController.js"), "utf8");
  const block = source.slice(source.indexOf("async function supersedePreviousMrpArtifacts"), source.indexOf("function buildMpsPlanNumber"));
  assert(block.includes('status: "SUPERSEDED"'));
  assert(block.includes("isCurrentPlan: false"));
  assert(!block.includes("mRPRequirement.updateMany"), "completed requirements must not be soft-deleted");
});

test("late open supply cannot cover an earlier shortage", () => {
  const grouped = consolidateRequirements([{ partCode: "MAT", requiredDate: day("2026-08-10"), qty: 10, openSupply: [{ qty: 10, arrivalDate: day("2026-08-11") }] }]);
  assert.equal(grouped[0].coveredQty, 0);
  assert.equal(grouped[0].shortageQty, 10);
});

test("urgent demand can displace Draft DPP", () => {
  assert.equal(evaluateDisplacement({ status: "Draft", withinFreezeFence: true }).decision, "AUTO_RESCHEDULE_ALLOWED");
});

test("Released DPP inside freeze fence needs override", () => {
  assert.equal(evaluateDisplacement({ status: "Released", withinFreezeFence: true }).decision, "OVERRIDE_APPROVAL_REQUIRED");
});

test("In Progress and Completed DPP are immutable", () => {
  assert.equal(evaluateDisplacement({ status: "In Progress" }).decision, "IMMUTABLE");
  assert.equal(evaluateDisplacement({ status: "Completed" }).decision, "IMMUTABLE");
});

test("SO resolves active customer master price", () => {
  const price = resolveActiveSalesPrice({ customerCode: "C01", partCode: "FG01", currencyCode: "IDR", effectiveDate: day("2026-08-09"), prices: [{ customerCode: "C01", partCode: "FG01", currencyCode: "IDR", unitPrice: 25000, effectiveFrom: day("2026-01-01"), effectiveUntil: day("2026-12-31"), isActive: true }] });
  assert.equal(price.unitPrice, 25000);
  assert.equal(price.code, "MASTER_PRICE");
});

test("price override preserves reason and original price", () => {
  const price = resolveActiveSalesPrice({ customerCode: "C01", partCode: "FG01", currencyCode: "IDR", effectiveDate: day("2026-08-09"), requestedPrice: 23000, overrideReason: "Kontrak khusus", canOverride: true, prices: [{ customerCode: "C01", partCode: "FG01", currencyCode: "IDR", unitPrice: 25000, effectiveFrom: day("2026-01-01"), isActive: true }] });
  assert.equal(price.originalMasterPrice, 25000);
  assert.equal(price.overrideReason, "Kontrak khusus");
});

test("SO margin preview uses BOM cost", () => {
  const result = calculateMarginPreview({ qty: 100, unitPrice: 25000, materialCost: 12000, processCost: 3000, overheadCost: 1000 });
  assert.equal(result.estimatedBomCostPerUnit, 16000);
  assert.equal(result.estimatedGrossContribution, 900000);
  assert.equal(result.estimatedMarginPercent, 36);
});

test("DPP traceability contract contains source through allocation", () => {
  const trace = { demandSourceType: "SALES_ORDER", demandSourceNumber: "SO-1", deliveryPhaseId: "DP-1", mpsNumber: "MPS-202608", mrpRunNumber: "MRP-202608-R001", mppNumber: "MPP-202608-001", capacityAllocationId: "ALLOC-1" };
  ["demandSourceType", "demandSourceNumber", "deliveryPhaseId", "mpsNumber", "mrpRunNumber", "mppNumber", "capacityAllocationId"].forEach((key) => assert(trace[key]));
});

test("MPS delivery window shifts at day 20", () => {
  assert.equal(planningAnchorMonth(day("2026-08-19")), "2026-07");
  assert.equal(planningAnchorMonth(day("2026-08-20")), "2026-08");
  assert.deepEqual(mpsWindowMonths(day("2026-08-19")), ["2026-07", "2026-08", "2026-09"]);
  assert.deepEqual(mpsWindowMonths(day("2026-08-20")), ["2026-08", "2026-09", "2026-10"]);
});

test("MPS groups Forecast and SO phases by target delivery month", () => {
  const groups = groupTargetsByDeliveryMonth([
    { id: "AUG", targetDate: day("2026-08-28"), qty: 40, forecastMonth: day("2026-07-01") },
    { id: "SEP", targetDate: day("2026-09-10"), qty: 60, forecastMonth: day("2026-07-01") },
  ], "2026-08");
  assert.deepEqual([...groups.keys()], ["2026-08", "2026-09"]);
  assert.equal(groups.get("2026-08")[0].id, "AUG");
  assert.equal(groups.get("2026-09")[0].id, "SEP");
});

test("rolling MPS retires an empty stale delivery-month bucket", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/prisma/services/planning/monthlyPlanningService.js"), "utf8");
  assert(source.includes("const emptyMonths = [...requestedMonths].filter"));
  assert(source.includes('status: "Superseded"'));
  assert(source.includes('lifecycleStatus: "REPLAN_REQUIRED"'), "Released/Completed history must be preserved for review");
});

test("rolling MPS revives a canonical month when active demand returns", () => {
  assert.equal(resolveActiveCanonicalMpsStatus("Superseded", true), "Draft");
  assert.equal(resolveActiveCanonicalMpsStatus("Cancelled", true), "Draft");
  assert.equal(resolveActiveCanonicalMpsStatus("Released", true), "Released", "released history remains protected for replan review");
  assert.equal(resolveActiveCanonicalMpsStatus("Confirmed", true), "Draft");
  assert.equal(resolveActiveCanonicalMpsLifecycle("Confirmed", false), "REVIEWED", "confirmed MPS must not regress to DRAFT during an unchanged sync");
  assert.equal(resolveActiveCanonicalMpsLifecycle("Released", true), "REPLAN_REQUIRED");
});

test("released MPS keeps baseline and stores proposed source delta", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/prisma/services/planning/monthlyPlanningService.js"), "utf8");
  assert(source.includes('protectReleasedBaseline = doc.status === "Released"'));
  assert(source.includes("proposedDelta.push"));
  assert(source.includes("REVIEW_REQUIRED"));
});

test("procurement windows retain exact date", () => {
  assert.equal(procurementWindow(day("2026-08-09"), day("2026-08-05")), "EXPEDITE");
  assert.equal(procurementWindow(day("2026-08-09"), day("2026-09-10")), "NEXT_MONTH_01_15");
  assert.equal(procurementWindow(day("2026-08-09"), day("2026-09-20")), "NEXT_MONTH_16_EOM");
});

test("MRP planner resolves RAW part to Material Master and preferred Supplier Item", () => {
  const identity = resolveProcurementMasterIdentity({
    row: { partCode: "C002-C006-030", leadTime: 7 },
    order: { supplierCode: null },
    purchaseSchedule: null,
    partMaster: {
      itemType: "RAW", rawType: "MATERIAL",
      material: { materialCode: "SPHC-PO-2-145", spec: "SPHC-PO" },
      supplierItems: [{ leadTimeDays: 7, supplier: { supplierCode: "S001", supplierName: "PT Papajaya" } }],
    },
  });
  assert.equal(identity.materialCode, "SPHC-PO-2-145");
  assert.equal(identity.isRawMaterial, true);
  assert.equal(identity.supplierCode, "S001");
  assert.equal(identity.supplierName, "PT Papajaya");
  assert.equal(identity.supplierSource, "SUPPLIER_ITEM_PREFERRED");
  assert.equal(identity.supplierLeadTimeDays, 7);
});

test("MRP planner maps consolidated Purchase Suggestion back through source requirement", () => {
  const schedule = { partCode: "C002-C005-030", materialCode: "SPHC-PO-2-145", materialRequiredDate: day("2026-09-15") };
  const result = resolvePurchaseScheduleForRequirement({
    row: { partCode: "C002-C006-030", requiredDate: day("2026-09-29") },
    suggestionByPartDelivery: new Map([["C002-C005-030|2026-09-29", schedule]]),
    requirementsByPartDate: new Map([["C002-C006-030|2026-09-29", [{ id: "REQ-C006" }]]]),
    suggestionByRequirementId: new Map([["REQ-C006", schedule]]),
  });
  assert.equal(result, schedule);
});

test("MOQ excess pulls nearest future demand and preserves split allocation", () => {
  const items = applyMoqCarryForward([
    { plannedOrderNumber: "PLO-1", materialCode: "MAT-1", suggestedSupplierCode: "SUP-1", warehouseCode: "WH", uomCode: "KG", moq: 100, orderMultiple: 0, materialRequiredDate: day("2026-08-25"), customerDeliveryDate: day("2026-08-30"), netRequirement: 60, grossRequirement: 60, availableStock: 0, openPoQty: 0, sourceRequirements: [{ id: "R1", partCode: "P1", qty: 60, grossQty: 60, requiredDate: day("2026-08-25") }] },
    { plannedOrderNumber: "PLO-2", materialCode: "MAT-1", suggestedSupplierCode: "SUP-1", warehouseCode: "WH", uomCode: "KG", moq: 50, orderMultiple: 0, materialRequiredDate: day("2026-09-05"), customerDeliveryDate: day("2026-09-10"), netRequirement: 30, grossRequirement: 30, availableStock: 0, openPoQty: 0, sourceRequirements: [{ id: "R2", partCode: "P2", qty: 30, grossQty: 30, requiredDate: day("2026-09-05") }] },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].netRequirement, 90);
  assert.equal(items[0].recommendedPurchaseQty, 100);
  assert.equal(items[0].excessQty, 10);
  assert.equal(items[0].sourceRequirements.find((source) => source.id === "R2").allocationType, "MOQ_PULL_FORWARD");
  assert.equal(items[0].productionLeadTimeBreakdown.moqAllocation.pulledFutureDemandQty, 30);
});

test("PR allocation separates covered demand from residual MOQ buffer", () => {
  const allocation = allocatePurchaseQtyToSources([{ id: "R1", qty: 60 }, { id: "R2", qty: 30 }], 100);
  assert.equal(allocation.demandCoveredQty, 90);
  assert.equal(allocation.moqBufferQty, 10);
  assert.equal(allocation.allocations.reduce((sum, source) => sum + source.allocatedPrQty, 0), 90);
});

test("MOQ confirmation offers future demand and transfers it without duplicate requirement", () => {
  const rows = [
    { id: "I1", materialCode: "MAT-1", suggestedSupplierCode: "SUP-1", warehouseCode: "WH", uomCode: "KG", materialRequiredDate: day("2026-08-25"), netRequirement: 60, grossRequirement: 60, availableStock: 0, openPoQty: 0, moq: 0, orderMultiple: 0, sourceRequirements: [{ id: "R1", partCode: "P1", qty: 60, grossQty: 60 }] },
    { id: "I2", materialCode: "MAT-1", suggestedSupplierCode: "SUP-1", warehouseCode: "WH", uomCode: "KG", materialRequiredDate: day("2026-09-05"), customerDeliveryDate: day("2026-09-10"), netRequirement: 50, grossRequirement: 50, availableStock: 0, openPoQty: 0, moq: 0, orderMultiple: 0, status: "Draft", sourceRequirements: [{ id: "R2", partCode: "P2", customerCode: "C2", qty: 50, grossQty: 50 }] },
  ];
  const candidates = buildMoqAllocationCandidates(rows, "I1");
  assert.equal(candidates.filter((candidate) => candidate.isCurrentDemand).length, 1);
  assert.equal(candidates.find((candidate) => !candidate.isCurrentDemand).availableQty, 50);
  const result = applyConfirmedMoqPullForward({ items: rows, currentItemId: "I1", confirmedPurchaseQty: 100, selections: [{ sourceItemId: "I2", sourceRequirementId: "R2", qty: 40 }] });
  assert.equal(result.current.netRequirement, 100);
  assert.equal(result.current.excessQty, 0);
  assert.equal(result.current.sourceRequirements.find((source) => source.id === "R2").allocationType, "MOQ_PULL_FORWARD");
  const future = result.changed.find((item) => item.id === "I2");
  assert.equal(future.netRequirement, 10);
  assert.equal(future.sourceRequirements[0].qty, 10);
  assert.equal(result.current.netRequirement + future.netRequirement, 110, "total demand remains unchanged after moving allocation");
});

test("existing MOQ delivery allocation remains visible and editable", () => {
  const rows = [{
    id: "I1", materialCode: "MAT-1", suggestedSupplierCode: "SUP-1", warehouseCode: "WH", uomCode: "KG",
    materialRequiredDate: day("2026-08-25"), netRequirement: 90, grossRequirement: 90, availableStock: 0, openPoQty: 0,
    sourceRequirements: [
      { id: "R1", partCode: "P1", partNumber: "PN-001", qty: 60, grossQty: 60, allocationType: "DIRECT_DEMAND" },
      { id: "R2", partCode: "P2", partNumber: "PN-002", deliveryTargetId: "DEL-SEP", targetDeliveryDate: day("2026-09-10"), qty: 30, grossQty: 30, originalDemandQty: 50, allocationType: "MOQ_PULL_FORWARD", pulledFromRequiredDate: day("2026-09-05") },
    ],
  }];
  const before = buildMoqAllocationCandidates(rows, "I1");
  const beforeFuture = before.find((candidate) => !candidate.isCurrentDemand);
  assert.equal(beforeFuture.partNumber, "PN-002");
  assert.equal(beforeFuture.deliveryTargetId, "DEL-SEP");
  assert.equal(beforeFuture.allocatedQty, 30);
  assert.equal(beforeFuture.availableQty, 50);
  const edited = applyConfirmedMoqPullForward({ items: rows, currentItemId: "I1", confirmedPurchaseQty: 100, selections: [{ sourceItemId: "I1", sourceRequirementId: "R2", qty: 20 }] });
  assert.equal(edited.current.netRequirement, 80);
  assert.equal(edited.current.excessQty, 20);
  const reopened = buildMoqAllocationCandidates([edited.current], "I1");
  const reopenedFuture = reopened.find((candidate) => !candidate.isCurrentDemand);
  assert.equal(reopenedFuture.allocatedQty, 20);
  assert.equal(reopenedFuture.availableQty, 50, "full delivery request remains available after editing allocation");
});

test("current material demand sources are visible and accept custom reserve per part", () => {
  const rows = [{
    id: "I1", materialCode: "SPHC-145", suggestedSupplierCode: "SUP-1", warehouseCode: "WH", uomCode: "KG",
    materialRequiredDate: day("2026-08-25"), netRequirement: 4, grossRequirement: 4, availableStock: 0, openPoQty: 0,
    sourceRequirements: [
      { id: "PART-A", partCode: "C002-C005-030", partNumber: "11058-1287", qty: 2, grossQty: 2, allocationType: "DIRECT_DEMAND" },
      { id: "PART-B", partCode: "C002-C006-030", partNumber: "11058-1288", qty: 2, grossQty: 2, allocationType: "DIRECT_DEMAND" },
    ],
  }];
  const before = buildMoqAllocationCandidates(rows, "I1").filter((candidate) => candidate.isCurrentDemand);
  assert.deepEqual(before.map((candidate) => candidate.partCode), ["C002-C005-030", "C002-C006-030"]);
  const result = applyConfirmedMoqPullForward({
    items: rows,
    currentItemId: "I1",
    confirmedPurchaseQty: 20,
    selections: [
      { sourceItemId: "I1", sourceRequirementId: "PART-A", demandCoveredQty: 0, reservedAllocationQty: 10 },
      { sourceItemId: "I1", sourceRequirementId: "PART-B", demandCoveredQty: 0, reservedAllocationQty: 3 },
    ],
  });
  assert.equal(result.current.netRequirement, 4, "custom reserve does not inflate demand");
  assert.equal(result.current.sourceRequirements.find((source) => source.id === "PART-A").reservedAllocationQty, 10);
  assert.equal(result.current.sourceRequirements.find((source) => source.id === "PART-B").reservedAllocationQty, 3);
  assert.equal(result.residualBufferQty, 3);
  const reopened = buildMoqAllocationCandidates([result.current], "I1").filter((candidate) => candidate.isCurrentDemand);
  assert.deepEqual(reopened.map((candidate) => candidate.reservedAllocationQty), [10, 3]);
});

test("custom reserve allocation may exceed forecast demand without inflating MRP demand", () => {
  const rows = [
    { id: "I1", materialCode: "SPHC-A", suggestedSupplierCode: "SUP-1", warehouseCode: "WH", uomCode: "KG", materialRequiredDate: day("2026-08-25"), netRequirement: 5, grossRequirement: 5, availableStock: 0, openPoQty: 0, sourceRequirements: [{ id: "CURRENT", qty: 5, grossQty: 5, allocationType: "DIRECT_DEMAND" }] },
    { id: "I2", materialCode: "SPHC-A", suggestedSupplierCode: "SUP-1", warehouseCode: "WH", uomCode: "KG", materialRequiredDate: day("2026-09-05"), customerDeliveryDate: day("2026-09-10"), netRequirement: 2, grossRequirement: 2, availableStock: 0, openPoQty: 0, moq: 0, orderMultiple: 0, status: "Draft", sourceRequirements: [{ id: "FORECAST-1", partCode: "PART-A", qty: 2, grossQty: 2 }] },
  ];
  const result = applyConfirmedMoqPullForward({
    items: rows,
    currentItemId: "I1",
    confirmedPurchaseQty: 20,
    selections: [{ sourceItemId: "I2", sourceRequirementId: "FORECAST-1", demandCoveredQty: 2, reservedAllocationQty: 8, qty: 10 }],
  });
  const allocation = result.current.sourceRequirements.find((source) => source.id === "FORECAST-1");
  assert.equal(allocation.qty, 10, "actual allocation is custom and may exceed demand");
  assert.equal(allocation.demandCoveredQty, 2);
  assert.equal(allocation.reservedAllocationQty, 8);
  assert.equal(result.current.netRequirement, 7, "net demand remains current 5 + actual future demand 2");
  assert.equal(result.reservedAllocationQty, 8);
  assert.equal(result.residualBufferQty, 5, "purchase 20 - current demand 5 - custom allocation 10");
  assert.equal(result.changed.find((item) => item.id === "I2").netRequirement, 0);
});

test("explicit coverage cannot exceed demand and must use custom reserve", () => {
  const rows = [
    { id: "I1", materialCode: "SPHC-A", suggestedSupplierCode: "SUP-1", warehouseCode: "WH", uomCode: "KG", materialRequiredDate: day("2026-08-25"), netRequirement: 5, grossRequirement: 5, availableStock: 0, openPoQty: 0, sourceRequirements: [{ id: "CURRENT", qty: 5, grossQty: 5 }] },
    { id: "I2", materialCode: "SPHC-A", suggestedSupplierCode: "SUP-1", warehouseCode: "WH", uomCode: "KG", materialRequiredDate: day("2026-09-05"), netRequirement: 2, grossRequirement: 2, availableStock: 0, openPoQty: 0, status: "Draft", sourceRequirements: [{ id: "FORECAST-1", qty: 2, grossQty: 2 }] },
  ];
  assert.throws(() => applyConfirmedMoqPullForward({
    items: rows,
    currentItemId: "I1",
    confirmedPurchaseQty: 20,
    selections: [{ sourceItemId: "I2", sourceRequirementId: "FORECAST-1", demandCoveredQty: 10, reservedAllocationQty: 0 }],
  }), /Coverage Demand tidak boleh melebihi demand asli/);
});

(async () => {
  let passed = 0;
  for (const item of tests) {
    await item.fn();
    passed += 1;
  }
  console.log(`Planning Architecture V2 contracts PASS (${passed}/${tests.length})`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
