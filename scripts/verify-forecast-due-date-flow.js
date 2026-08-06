const fs = require("fs");
const path = require("path");
const controller = require("../src/prisma/controllers/planning/MRPController");
const { DEFAULT_FORMULAS, evaluateFormula } = require("../src/prisma/services/masterFormulaService");

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
const materialAliasA = { itemType: "RAW", rawType: "MATERIAL", materialId: "material-1", material: { materialCode: "SPHC" } };
const materialAliasB = { ...materialAliasA };
check("Raw part aliases share one planning stock key", controller.__test.planningStockKey("RAW-A", materialAliasA) === controller.__test.planningStockKey("RAW-B", materialAliasB));
check(
  "MPS gross buffer does not net FG stock before MRP",
  evaluateFormula(DEFAULT_FORMULAS.MPS_BUFFER_QTY, { bufferBaseQty: 300, bufferPercent: 50, stockAvailableQty: 20 }) === 150,
);

const mrpSource = fs.readFileSync(path.resolve(__dirname, "../src/prisma/controllers/planning/MRPController.js"), "utf8");
const explodeStart = mrpSource.indexOf("async function explodeMBOM");
const explodeSource = mrpSource.slice(explodeStart, explodeStart + 18000);
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
check("Monthly MPS uses next forecast month as buffer look-ahead", monthlySource.includes("forecastLookahead") && monthlySource.includes("nextForecastKey"));
check("Monthly MPS keeps unprocessed forecast periods Partial Product", monthlySource.includes("partialForecasts") && monthlySource.includes('data: { status: "Partial Product" }'));
check("Purchase Suggestion matches the exact delivery phase date", suggestionSource.includes("matchingDeliveryPlans.length"));

for (const result of checks) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}`);
if (checks.some((result) => !result.ok)) process.exitCode = 1;
