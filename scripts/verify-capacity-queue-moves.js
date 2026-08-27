"use strict";

const assert = require("assert");
const { dependencyWindow, rankCapacityAlternatives } = require("../src/prisma/services/planning/capacityQueueService");

assert.deepStrictEqual(dependencyWindow({ predecessorFinishDates: ["2026-09-03"], successorStartDates: ["2026-09-08"], fgRequiredDate: "2026-09-10" }), { earliestStartDate: "2026-09-03", latestFinishDate: "2026-09-08" });
const ranked = rankCapacityAlternatives({
  qty: 100,
  earliestStartDate: "2026-09-03",
  latestFinishDate: "2026-09-08",
  alternatives: [
    { machineId: "m1", date: "2026-09-09", availableMinutes: 200, requiredMinutes: 100 },
    { machineId: "m2", date: "2026-09-05", availableMinutes: 120, requiredMinutes: 100 },
    { machineId: "m3", date: "2026-09-04", availableMinutes: 80, requiredMinutes: 100 },
  ],
});
assert.strictEqual(ranked[0].machineId, "m2", "slot feasible dalam dependency window harus menjadi rekomendasi pertama");
assert.strictEqual(ranked[0].requiresForce, false);
assert.strictEqual(ranked[2].requiresForce, true);

console.log("Capacity queue recommendation contract passed.");
