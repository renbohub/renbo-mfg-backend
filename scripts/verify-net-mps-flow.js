"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { netMpsBucket, buildMpsCalculationTrace } = require("../src/prisma/services/planning/mpsNettingService");
const { consumeDeliveryTargets } = require("../src/prisma/services/planning/demandConsumptionService");

const september = netMpsBucket({
  openingAvailableQty: 11,
  firmScheduledReceiptQty: 0,
  grossDemandQty: 342,
  targetEndingStockQty: 112,
  productionPercent: 100,
  actualSalesOrderQty: 0,
});
assert.equal(september.plannedProductionQty, 443);
assert.equal(september.projectedEndingStockQty, 112);

const october = netMpsBucket({
  openingAvailableQty: september.projectedEndingStockQty,
  firmScheduledReceiptQty: 0,
  grossDemandQty: 223,
  targetEndingStockQty: 360,
  productionPercent: 100,
  actualSalesOrderQty: 0,
});
assert.equal(october.plannedProductionQty, 471);
assert.equal(october.projectedEndingStockQty, 360);

const withFirmMo = netMpsBucket({
  openingAvailableQty: 11,
  firmScheduledReceiptQty: 40,
  grossDemandQty: 342,
  targetEndingStockQty: 112,
});
assert.equal(withFirmMo.plannedProductionQty, 403);

const consumed = consumeDeliveryTargets({
  policy: "MTO",
  forecastTargets: [{ id: "F1", targetDate: new Date("2026-09-15"), qty: 100 }],
  salesOrderTargets: [{ id: "S1", targetDate: new Date("2026-09-10"), qty: 20 }],
});
assert.equal(consumed.reduce((sum, row) => sum + row.qty, 0), 100);
assert.equal(consumed.find((row) => row.sourceType === "SALES_ORDER").qty, 20);
assert.equal(consumed.find((row) => row.sourceType === "FORECAST").qty, 80);

const trace = buildMpsCalculationTrace({
  month: "2026-09", partCode: "FG-01", policy: "MTO",
  forecastQty: 100, actualSalesOrderQty: 20, bufferBaseQty: 40, bufferPercent: 50,
  netting: netMpsBucket({ openingAvailableQty: 10, grossDemandQty: 100, targetEndingStockQty: 20 }),
  sourceRows: [],
});
assert.equal(trace.version, 2);
assert.deepEqual(trace.steps.map((step) => step.key), [
  "FORECAST", "SALES_ORDER", "GROSS_DEMAND", "OPENING_AVAILABLE",
  "FIRM_RECEIPT", "BUFFER_TARGET", "NET_PRODUCTION", "PROJECTED_ENDING",
]);

const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");
const schema = read("../prisma/schema.prisma");
const monthly = read("../src/prisma/services/planning/monthlyPlanningService.js");
const mrp = read("../src/prisma/controllers/planning/MRPController.js");
const suggestion = read("../src/prisma/controllers/purchasing/PurchaseSuggestionController.js");
const capacity = read("../src/prisma/services/planning/capacityRecommendationService.js");

assert(schema.includes("calculationTrace"));
assert(monthly.includes("firmReceiptByPartMonth"));
assert(monthly.includes("projectedFgByPart.set"));
assert(mrp.includes("mpsUsesNetProduction"));
assert(suggestion.includes("SYSTEM_DEFAULT_RAW_200_KG"));
assert(suggestion.includes("SYSTEM_DEFAULT_PART_1000_PCS"));
assert(suggestion.includes("lotSizing:"));
assert(capacity.includes('category || "").toUpperCase() === "VENDOR"'));

console.log("Net MPS end-to-end contracts PASS");
