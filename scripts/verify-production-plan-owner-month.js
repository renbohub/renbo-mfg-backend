const assert = require("assert");
const { __test } = require("../src/prisma/controllers/planning/MonthlyProductionPlanController");

const details = [{
  partCode: "C002-C004-020",
  startDate: new Date("2026-08-20T00:00:00.000Z"),
  endDate: new Date("2026-09-03T00:00:00.000Z"),
  customerTargetDate: new Date("2026-09-03T00:00:00.000Z"),
  fgRequiredDate: new Date("2026-09-03T00:00:00.000Z"),
}];
const ownerMonth = new Date("2026-09-01T00:00:00.000Z");
const horizon = __test.productionPlanHorizon(details, ownerMonth);
const ownerWindow = __test.productionPlanOwnerWindow(horizon);
const grouped = __test.groupDetailsIntoProductionHorizon(details, ownerMonth);

assert.strictEqual(horizon.horizonStart.toISOString().slice(0, 10), "2026-08-20", "predecessor process M-1 harus tetap pada tanggal aktualnya");
assert.strictEqual(horizon.horizonEnd.toISOString().slice(0, 10), "2026-09-03", "horizon harus berakhir pada delivery/FG required");
assert.strictEqual(horizon.ownerKey, "2026-09", "owner Production Plan harus mengikuti bulan MPS/delivery, bukan earliest process start");
assert.strictEqual(horizon.crossMonth, true);
assert.strictEqual(ownerWindow.startDate.toISOString().slice(0, 10), "2026-09-01", "eksekusi dan blocker harus mulai dari awal owner month");
assert.strictEqual(ownerWindow.endDate.toISOString().slice(0, 10), "2026-09-30", "eksekusi harus dibatasi sampai akhir owner month");
assert.deepStrictEqual([...grouped.grouped.keys()], ["2026-09"]);

console.log("Production Plan owner-month contract passed.");
