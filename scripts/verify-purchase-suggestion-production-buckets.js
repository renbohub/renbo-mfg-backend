const assert = require("node:assert/strict");
const {
  productionScheduleQty,
  routingMetricKey,
  routingMetricsForRequests,
} = require("../src/prisma/controllers/purchasing/PurchaseSuggestionController");

assert.equal(productionScheduleQty([], [{ id: "phase-1", qtyPlanned: 300 }]), 300);
assert.equal(productionScheduleQty([], [{ id: "phase-2", qtyPlanned: 450 }]), 450);

const tx = {
  mBOMHeader: {
    findMany: async () => [{
      id: "mbom-1",
      noReg: "MBOM-TEST",
      details: [{
        id: "detail-1",
        parentDetailId: null,
        levelComponent: 1,
        qty: 1,
        category: "Production",
        leadTime: 0,
        leadTimeUnit: "HOUR",
        part: { partCode: "FG-TEST", partName: "Test FG" },
        mbomProcesses: [{
          sequence: 10,
          routingMode: "INHOUSE",
          cycleTime: 10,
          process: { processCode: "PRESS", processName: "Press" },
          vendor: null,
          routingOperation: { sequence: 10, setupMinutes: 0, cycleSeconds: 10, runMinutes: 0, isSubcontract: false },
        }],
      }],
    }],
  },
};

(async () => {
  const metrics = await routingMetricsForRequests(tx, [
    { headerId: "mbom-1", scheduleQty: 300 },
    { headerId: "mbom-1", scheduleQty: 450 },
  ]);
  const qty300 = metrics.get(routingMetricKey("mbom-1", 300));
  const qty450 = metrics.get(routingMetricKey("mbom-1", 450));
  assert.equal(qty300.scheduleQty, 300);
  assert.equal(qty300.processPath[0].qty, 300);
  assert.equal(qty300.cycleLoadHours, 0.833333);
  assert.equal(qty450.scheduleQty, 450);
  assert.equal(qty450.processPath[0].qty, 450);
  assert.equal(qty450.cycleLoadHours, 1.25);
  assert.notEqual(qty300.productionLeadTimeHours, qty450.productionLeadTimeHours);
  console.log("Purchase Suggestion production bucket contracts PASS (8/8)");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
