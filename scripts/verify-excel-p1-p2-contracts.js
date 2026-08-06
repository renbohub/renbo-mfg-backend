const assert = require("assert");
const dashboard = require("../src/prisma/controllers/dashboard/ExecutiveDashboardController");
const { disconnectDatabase } = require("../src/prisma");

function invoke(module, query = {}) {
  return new Promise((resolve, reject) => {
    const req = { params: { module }, query: { year: "2026", actualBasis: "BOOKED", ...query } };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) {
        if (this.statusCode >= 400) reject(Object.assign(new Error(body?.message), { body, statusCode: this.statusCode }));
        else resolve(body);
      },
    };
    Promise.resolve(dashboard.get(req, res, reject)).catch(reject);
  });
}

(async () => {
  const [system, sales, production, planning, purchasing, incoming, outgoing, inventory] = await Promise.all([
    invoke("system"), invoke("sales"), invoke("production"), invoke("planning-ppic"),
    invoke("purchasing"), invoke("incoming"), invoke("outgoing"), invoke("inventory"),
  ]);

  assert.ok(sales.comparison.modes.PLAN_QTY && sales.comparison.modes.PLAN_VALUE, "Sales must compare Forecast plan and selected actual basis");
  assert.strictEqual(sales.detailTables[0].rows.length, 12, "Sales monthly reconciliation must expose 12 months");
  assert.ok(sales.definitions.some((item) => item.label === "Forecast Accuracy"), "Sales must explain Forecast Accuracy");

  assert.ok(production.comparison.modes.QUALITY, "Production must expose Good vs Reject mode");
  assert.ok(production.detailTables.length > 0 && Array.isArray(production.exceptions), "Production must expose plan-actual detail and exceptions");
  assert.ok(planning.detailTables.length > 0 && Array.isArray(planning.exceptions), "PPIC must expose MPP reconciliation and exceptions");

  for (const payload of [purchasing, incoming]) {
    assert.ok(payload.comparison.modes.MATERIAL_KG, "Purchasing/Incoming must expose Material KG reconciliation");
    assert.ok(payload.detailTables.some((item) => item.title === "Supplier Receipt Control"), "Supplier performance table is required");
    assert.ok(Array.isArray(payload.exceptions), "Purchasing/Incoming exception queue is required");
  }

  assert.ok(outgoing.comparison.modes.CUMULATIVE, "Outgoing must expose accumulated delivery plan and actual");
  assert.ok(outgoing.detailTables.length > 0 && Array.isArray(outgoing.exceptions), "Outgoing detail and overdue queue are required");
  assert.ok(inventory.comparison.modes.VARIANCE, "Inventory must expose stock-opname variance mode");
  assert.ok(inventory.detailTables.some((item) => item.title === "Stock Opname Reconciliation"), "Inventory opname reconciliation table is required");

  assert.ok(system.detailTables.some((item) => item.title === "Plan vs Actual Lintas Modul"), "System dashboard must consolidate operational plan vs actual");
  assert.ok(Array.isArray(system.exceptions), "System dashboard must consolidate exception queues");

  console.log("PASS P1 Sales Forecast vs Actual reconciliation and exception queue");
  console.log("PASS P1 Material Demand vs PO vs Incoming and supplier control");
  console.log("PASS P1 Production quality, stock opname, and accumulated delivery control");
  console.log("PASS P2 forecast accuracy, cross-module drilldown, and export-ready detail contracts");
})().finally(disconnectDatabase);
