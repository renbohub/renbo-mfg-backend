const assert = require("assert");
const capacity = require("../src/prisma/services/planning/capacityPlanningService");

assert.strictEqual(
  typeof capacity.capacityOperationCode,
  "function",
  "capacity service harus menyediakan label occurrence routing",
);
assert.strictEqual(
  typeof capacity.capacityPlanRouteKey,
  "function",
  "capacity service harus menghitung coverage per MBOM route",
);
assert.strictEqual(
  typeof capacity.findRouteWorkOrder,
  "function",
  "daily conversion harus memilih WO berdasarkan MBOM route",
);

const weld1 = { id: "route-weld-1", occurrenceCode: "WELD-1", processId: "process-weld", sequence: 10, process: { processCode: "WELD" } };
const weld2 = { id: "route-weld-2", occurrenceCode: "WELD-2", processId: "process-weld", sequence: 20, process: { processCode: "WELD" } };

assert.strictEqual(capacity.capacityOperationCode(weld2), "WELD-2");
assert.notStrictEqual(
  capacity.capacityPlanRouteKey("MPP-001", 1, weld1.id, weld1.processId),
  capacity.capacityPlanRouteKey("MPP-001", 1, weld2.id, weld2.processId),
  "dua occurrence dari master process yang sama tidak boleh saling menutup qty",
);
assert.strictEqual(
  capacity.findRouteWorkOrder([
    { id: "wo-1", mbomProcessId: weld1.id, processId: weld1.processId, sequence: 10 },
    { id: "wo-2", mbomProcessId: weld2.id, processId: weld2.processId, sequence: 20 },
  ], weld2)?.id,
  "wo-2",
  "Daily Plan harus memakai WO milik occurrence WELD-2",
);

console.log("Capacity operation identity contract passed.");
