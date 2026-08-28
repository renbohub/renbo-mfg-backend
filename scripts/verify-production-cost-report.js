const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  durationSeconds,
  machineRatePerSecond,
  normalizeSourceType,
  reportRange,
} = require("../src/prisma/services/productionCostReportService");

assert.strictEqual(machineRatePerSecond(3600, "PER_HOUR"), 1);
assert.strictEqual(machineRatePerSecond(120, "PER_MINUTE"), 2);
assert.strictEqual(machineRatePerSecond(3, "PER_SECOND"), 3);
assert.strictEqual(durationSeconds({ runningMinutes: 2.5 }), 150);
assert.strictEqual(durationSeconds({ startTime: "2026-09-01T01:00:00.000Z", endTime: "2026-09-01T01:02:30.000Z" }), 150);
assert.strictEqual(normalizeSourceType("SO"), "SALES_ORDER");
assert.strictEqual(normalizeSourceType("forecast"), "FORECAST");
const range = reportRange({ month: "2026-09" });
assert.strictEqual(range.start.getFullYear(), 2026);
assert.strictEqual(range.start.getMonth(), 8);
assert.strictEqual(range.end.getDate(), 30);

const controller = fs.readFileSync(path.join(__dirname, "../src/prisma/controllers/production/ProductionReportController.js"), "utf8");
const routes = fs.readFileSync(path.join(__dirname, "../src/prisma/routes/production/production-reports.js"), "utf8");
const costing = fs.readFileSync(path.join(__dirname, "../src/prisma/services/mbomLiveCostingService.js"), "utf8");
assert.match(controller, /buildProductionCostReport/);
assert.match(routes, /cost-actual/);
assert.match(costing, /rawMaterialCost/);
assert.match(costing, /purchasePartCost/);
console.log("Production cost report contracts: OK");
