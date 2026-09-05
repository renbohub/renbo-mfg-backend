const fs = require("fs");
const path = require("path");
const controller = require("../src/prisma/controllers/planning/MRPController");
const { DEFAULT_FORMULAS, evaluateFormula } = require("../src/prisma/services/masterFormulaService");
const { procurementSchedule } = require("../src/prisma/services/planning/procurementSchedulingService");
const { resolveBufferBaseQty, customerDeliveryTargets } = require("../src/prisma/services/planning/monthlyPlanningService");
const { buildLedger, isCustomerDeliveryPhase } = require("../src/prisma/services/planning/mpsWorkbenchService");
const mrpControllerSource = fs.readFileSync(path.resolve(__dirname, "../src/prisma/controllers/planning/MRPController.js"), "utf8");

(async () => {

const checks = [];
function check(name, condition) {
  checks.push({ name, ok: Boolean(condition) });
}

const detail = {
  id: "mps-detail-1",
  lineNumber: 1,
  startDate: new Date("2026-08-01T00:00:00.000Z"),
  endDate: new Date("2026-08-31T00:00:00.000Z"),
  forecastQty: 300,
  actualSalesOrderQty: 0,
  bufferBaseQty: 0,
  bufferQty: 0,
  effectiveDemandQty: 300,
  qtyPlanned: 300,
};
const phases = [
  { id: "phase-1", mpsDetailId: detail.id, phaseNumber: 1, plannedDate: new Date("2026-08-15T00:00:00.000Z"), qtyPlanned: 100, sourceType: "FORECAST" },
  { id: "phase-2", mpsDetailId: detail.id, phaseNumber: 2, plannedDate: new Date("2026-08-25T00:00:00.000Z"), qtyPlanned: 200, sourceType: "FORECAST" },
];
const expanded = controller.__test.expandMpsDetailsByDeliveryPhases([detail], phases);
check("MRP creates one bucket per forecast delivery phase", expanded.length === 2);
check("MRP preserves first phase due date and quantity", expanded[0].endDate.toISOString().slice(0, 10) === "2026-08-15" && expanded[0].forecastQty === 100);
check("MRP preserves second phase due date and quantity", expanded[1].endDate.toISOString().slice(0, 10) === "2026-08-25" && expanded[1].forecastQty === 200);
check("MRP phase split preserves total demand", expanded.reduce((sum, row) => sum + row.forecastQty, 0) === detail.forecastQty);
const bufferedDetail = { ...detail, forecastQty: 300, bufferBaseQty: 400, bufferQty: 120, effectiveDemandQty: 420, qtyPlanned: 420 };
const bufferedExpanded = controller.__test.expandMpsDetailsByDeliveryPhases([bufferedDetail], phases);
check("MRP keeps exact customer phases and creates one internal buffer bucket", bufferedExpanded.length === 3 && bufferedExpanded[0].qtyPlanned === 100 && bufferedExpanded[1].qtyPlanned === 200 && bufferedExpanded[2].qtyPlanned === 120 && bufferedExpanded[2]._isBufferPhase === true);
check("MRP buffer no longer inflates forecast delivery phases", bufferedExpanded[0].forecastQty === 100 && bufferedExpanded[1].forecastQty === 200 && bufferedExpanded[2].forecastQty === 0 && bufferedExpanded.reduce((sum, row) => sum + row.qtyPlanned, 0) === bufferedDetail.qtyPlanned);
const stockNettedDetail = { ...bufferedDetail, qtyPlanned: 320 };
const stockNettedPhases = phases.map((phase, index) => ({ ...phase, sourceDeliveryTargetId: `target-${index + 1}` }));
const stockNettedExpanded = controller.__test.expandMpsDetailsByDeliveryPhases(stockNettedDetail ? [stockNettedDetail] : [], stockNettedPhases, new Map([
  ["target-1", { demandQty: 100, stockUsedQty: 100, plannedProductionQty: 0, uncoveredQty: 0 }],
  ["target-2", { demandQty: 200, stockUsedQty: 0, plannedProductionQty: 200, uncoveredQty: 0 }],
]));
check("MRP phase expansion uses official FIFO stock netting", stockNettedExpanded.length === 3 && stockNettedExpanded[0].qtyPlanned === 0 && stockNettedExpanded[0]._deliveryDemandQty === 100 && stockNettedExpanded[1].qtyPlanned === 200 && stockNettedExpanded[2].qtyPlanned === 120);
const multiPhaseSoDemand = { "FG-TEST": [{ dueDate: new Date("2026-08-31T00:00:00.000Z"), remainingQty: 300, sourceNumber: "SO-TEST#1" }] };
const soPhaseDetail = { ...detail, partCode: "FG-TEST", _deliveryPhaseId: "so-phase-1", _deliveryPhaseSourceType: "SALES_ORDER", qtyPlanned: 100, demandSources: [{ sourceType: "SALES_ORDER", sourceNumber: "SO-TEST" }] };
const firstSoPhase = controller.__test.consumeSalesOrdersAlreadyRepresentedByMps(multiPhaseSoDemand, soPhaseDetail, null);
const secondSoPhase = controller.__test.consumeSalesOrdersAlreadyRepresentedByMps(multiPhaseSoDemand, { ...soPhaseDetail, _deliveryPhaseId: "so-phase-2", qtyPlanned: 200 }, null);
check("MRP consumes multi-phase SO quantity per phase instead of all at phase one", firstSoPhase.consumedQty === 100 && secondSoPhase.consumedQty === 200 && multiPhaseSoDemand["FG-TEST"][0].remainingQty === 0);
const stockCoveredSoDemand = { "FG-TEST": [{ dueDate: new Date("2026-08-31T00:00:00.000Z"), remainingQty: 100, sourceNumber: "SO-TEST#1" }] };
const stockCoveredSo = controller.__test.consumeSalesOrdersAlreadyRepresentedByMps(stockCoveredSoDemand, { ...soPhaseDetail, qtyPlanned: 0, _deliveryDemandQty: 100 }, null);
check("stock-covered MPS phase still consumes represented SO demand", stockCoveredSo.consumedQty === 100 && stockCoveredSoDemand["FG-TEST"][0].remainingQty === 0);
const pegging = controller.__test.demandPeggingForPhase({
  qtyPlanned: "25.50",
  partCode: "FG-TEST",
  deliveryPhaseId: "target-1",
  demandSources: [{
    sourceType: "FORECAST",
    sourceNumber: "FCT-TEST",
    sourcePegging: [{ deliveryTargetId: "target-1", qty: "25.50" }],
  }],
});
check("MRP delivery-phase pegging safely converts numeric quantities", pegging.length === 1 && pegging[0].qty === 25.5);
const phasedPurchaseDates = await procurementSchedule({ materialRequiredDate: "2026-09-15T00:00:00.000Z", supplierLeadTimeDays: 7, asOf: "2026-08-11T00:00:00.000Z" });
check("Procurement schedule is solved by CP-SAT with ordered milestones", phasedPurchaseDates.solver?.engine === "OR_TOOLS_WASM_CP_SAT" && phasedPurchaseDates.solver?.milestones?.length === 6 && phasedPurchaseDates.latestPrDate < phasedPurchaseDates.latestPoDate && phasedPurchaseDates.latestPoDate < phasedPurchaseDates.supplierRequiredArrivalDate);
check("dependent production schedule uses the OR-Tools backward calendar", /productionSchedule\s*=\s*orderType\s*===\s*"Production"[\s\S]*resolveProductionRequirementDates[\s\S]*scheduleSource:\s*orderType\s*===\s*"Production"/.test(mrpControllerSource));
const materialAliasA = { itemType: "RAW", rawType: "MATERIAL", materialId: "material-1", material: { materialCode: "SPHC" } };
const materialAliasB = { ...materialAliasA };
check("Raw part aliases share one planning stock key", controller.__test.planningStockKey("RAW-A", materialAliasA) === controller.__test.planningStockKey("RAW-B", materialAliasB));
check(
  "MPS gross buffer does not net FG stock before MRP",
  evaluateFormula(DEFAULT_FORMULAS.MPS_BUFFER_QTY, { bufferBaseQty: 300, bufferPercent: 50, stockAvailableQty: 20 }) === 150,
);
check(
  "MPS buffer uses the displayed yearly EFD when M+1 is still Submitted",
  resolveBufferBaseQty({ nextEfd: undefined, yearlyEfdLookahead: 15000, forecastLookaheadQty: 0 }) === 15000,
);
const mixedDeliveryTargets = [
  { id: "forecast-target", sourceType: "FORECAST", qty: 300 },
  { id: "so-target", sourceType: "SALES_ORDER", qty: 120 },
];
const soCustomerDeliveryTargets = customerDeliveryTargets({
  targets: mixedDeliveryTargets,
  actualSalesOrderQty: 120,
  efdSource: "PO",
});
check(
  "MPS Batch Delivery follows Sales Order targets as soon as PO exists",
  soCustomerDeliveryTargets.length === 1 && soCustomerDeliveryTargets[0].id === "so-target",
);
const forecastOverrideMixedTargets = customerDeliveryTargets({
  targets: mixedDeliveryTargets,
  actualSalesOrderQty: 120,
  efdSource: "FORECAST",
});
check(
  "Forecast EFD keeps firm SO and unconsumed Forecast residual delivery targets",
  forecastOverrideMixedTargets.length === 2
    && forecastOverrideMixedTargets.some((target) => target.id === "so-target")
    && forecastOverrideMixedTargets.some((target) => target.id === "forecast-target"),
);
const forecastCustomerDeliveryTargets = customerDeliveryTargets({
  targets: mixedDeliveryTargets.filter((target) => target.sourceType === "FORECAST"),
  actualSalesOrderQty: 0,
  efdSource: "FORECAST_FALLBACK",
});
check(
  "MPS Batch Delivery falls back to Forecast when PO is zero and EFD selects Forecast",
  forecastCustomerDeliveryTargets.length === 1 && forecastCustomerDeliveryTargets[0].id === "forecast-target",
);
check(
  "Workbench shows Forecast batch while PO is zero",
  isCustomerDeliveryPhase({ actualSalesOrderQty: 0, calculationTrace: { efd: { source: "FORECAST" } } }, { sourceType: "FORECAST" }),
);
check(
  "Workbench keeps Forecast residual after an SO exists when EFD selects Forecast",
  isCustomerDeliveryPhase({ actualSalesOrderQty: 1, calculationTrace: { efd: { source: "FORECAST" } } }, { sourceType: "FORECAST" })
    && isCustomerDeliveryPhase({ actualSalesOrderQty: 1 }, { sourceType: "SALES_ORDER" }),
);
const bufferLedger = buildLedger({
  detail: {
    id: "mps-buffer-test",
    mpsNumber: "MPS-202609",
    startDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-30T00:00:00.000Z"),
    actualSalesOrderQty: 8000,
    openingAvailableQty: 0,
    targetEndingStockQty: 7500,
    projectedEndingStockQty: 7500,
    qtyPlanned: 15500,
    calculationTrace: { efd: { source: "PO" } },
    demandSources: [
      { id: "so-source", sourceType: "SALES_ORDER", sourceNumber: "SO-001", qty: 8000, effectiveRequiredDate: "2026-09-15" },
      { id: "forecast-source", sourceType: "FORECAST", sourceNumber: "FCT-001", qty: 12000, effectiveRequiredDate: "2026-09-20" },
    ],
  },
  stockLines: [],
  reservations: [],
  receipts: [],
});
const bufferEvent = bufferLedger.ledger.find((row) => row.eventType === "BUFFER_TARGET");
check(
  "SO-backed netting no longer consumes Forecast remainder before ending buffer",
  bufferLedger.metrics.grossDemandQty === 8000 && bufferEvent?.plannedProductionQty === 7500,
);

const mrpSource = fs.readFileSync(path.resolve(__dirname, "../src/prisma/controllers/planning/MRPController.js"), "utf8");
const explodeStart = mrpSource.indexOf("async function explodeMBOM");
const explodeSource = mrpSource.slice(explodeStart, explodeStart + 30000);
const hybridSource = fs.readFileSync(path.resolve(__dirname, "../src/prisma/services/planning/hybridMrpService.js"), "utf8");
const monthlySource = fs.readFileSync(path.resolve(__dirname, "../src/prisma/services/planning/monthlyPlanningService.js"), "utf8");
const mpsSource = fs.readFileSync(path.resolve(__dirname, "../src/prisma/controllers/planning/MPSController.js"), "utf8");
const ppicDetailSource = fs.readFileSync(path.resolve(__dirname, "../../frontend/public/js/ppic-detail.js"), "utf8");
const suggestionSource = fs.readFileSync(path.resolve(__dirname, "../src/prisma/controllers/purchasing/PurchaseSuggestionController.js"), "utf8");
check("MBOM explosion no longer references out-of-scope MPS precheck", !explodeSource.includes("mpsPrecheck"));
check("Raw material follows the parent net production driver", explodeSource.includes("const parentOutputMap = netOutputQtyByMbomDetailId") && !explodeSource.includes("relatedSourceCodes.has(sourceCode)"));
check("Shared material stock is pooled once across part aliases", mrpSource.includes("function planningStockKey") && explodeSource.includes("_planningStockKey: stockKey") && mrpSource.includes("rowsBySupply"));
check("Failed net-change leaves dirty item in Failed status", hybridSource.includes('status: failedCount > 0 ? "Failed" : "Done"'));
check("Monthly MPS sync invalidates previous downstream plans", monthlySource.includes("invalidateDownstreamPlans(tx, changedMpsNumbers"));
check("Monthly MPS removes stale MRP-generated child rows", monthlySource.includes('notes: { startsWith: "[MRP-PRODUCTION]" }') && monthlySource.includes("data: { isDeleted: true }"));
check("MPS exposes persisted BOM hierarchy for generated child rows", mpsSource.includes("treePath: true") && mpsSource.includes("bomHierarchy:"));
check("MPS detail renders a fixed BOM tree instead of alphabetical part groups", ppicDetailSource.includes('fixedGrouping: true') && ppicDetailSource.includes('data-bom-level='));
check("Monthly MPS uses next EFD month as buffer look-ahead", monthlySource.includes("yearlyEfdLookahead") && monthlySource.includes("nextForecastKey"));
check("Monthly MPS persists delivery plans from the selected customer targets", monthlySource.includes("data: deliveryTargets.flatMap") && monthlySource.includes("customerDeliveryTargets({"));
check("Monthly MPS keeps unprocessed forecast periods Partial Product", monthlySource.includes("partialForecasts") && monthlySource.includes('data: { status: "Partial Product" }'));
check(
  "Purchase Suggestion matches delivery phase by target lineage, not material due date",
  suggestionSource.includes("deliveryTargetIds.has(plan.sourceDeliveryTargetId)")
    && !suggestionSource.includes("requirementDays.has(day(plan.plannedDate))"),
);
check(
  "Purchase Suggestion routing quantity includes MPS buffer production",
  suggestionSource.indexOf("const mpsQty") < suggestionSource.indexOf("const uniquePlans"),
);

for (const result of checks) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}`);
if (checks.some((result) => !result.ok)) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
