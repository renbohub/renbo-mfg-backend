"use strict";

const assert = require("assert");
const { effectiveDemandQty, consumeDeliveryTargets } = require("../src/prisma/services/planning/demandConsumptionService");
const { netTimePhasedDemand } = require("../src/prisma/services/planning/timePhasedNettingService");
const { procurementSchedule } = require("../src/prisma/services/planning/procurementSchedulingService");

assert.strictEqual(effectiveDemandQty({ forecastQty: 100, salesOrderQty: 60, policy: "MTO" }), 60, "MTO harus mengganti forecast dengan SO aktual");
assert.strictEqual(effectiveDemandQty({ forecastQty: 100, salesOrderQty: 60, policy: "MTS" }), 100, "MTS harus mempertahankan forecast yang lebih besar");
assert.strictEqual(effectiveDemandQty({ forecastQty: 100, salesOrderQty: 140, policy: "MTS" }), 140, "SO harus menjadi floor MTS");

const mtoTargets = consumeDeliveryTargets({
  policy: "MTO",
  forecastTargets: [{ id: "fc-1", targetDate: "2026-09-30", qty: 100 }],
  salesOrderTargets: [{ id: "so-1", targetDate: "2026-09-10", qty: 60 }],
});
assert.deepStrictEqual(mtoTargets.map((row) => [row.sourceType, row.qty]), [["SALES_ORDER", 60]], "MTO dengan SO tidak boleh menyisakan forecast provisional");

const phased = netTimePhasedDemand({
  openingQty: 100,
  supplyEvents: [{ sourceType: "PO", sourceNumber: "PO-1", availableDate: "2026-09-25", qty: 100, confidence: "FIRM" }],
  demandEvents: [
    { id: "early", requiredDate: "2026-09-10", qty: 120 },
    { id: "late", requiredDate: "2026-09-30", qty: 80 },
  ],
});
assert.strictEqual(phased[0].netRequirement, 20, "PO tanggal 25 tidak boleh menutup shortage tanggal 10");
assert.strictEqual(phased[1].netRequirement, 0, "PO tanggal 25 harus tersedia untuk demand tanggal 30");
assert.strictEqual(phased[1].projectedAvailableAfter, 20, "Sisa receipt harus dibawa ke bucket berikutnya");

const risk = netTimePhasedDemand({
  openingQty: 0,
  supplyEvents: [{ sourceType: "PR", sourceNumber: "PR-1", availableDate: "2026-09-05", qty: 50, confidence: "PLANNED" }],
  demandEvents: [{ id: "demand", requiredDate: "2026-09-10", qty: 50 }],
})[0];
assert.strictEqual(risk.netRequirement, 0, "Open PR mencegah duplicate planned order");
assert.strictEqual(risk.firmNetRequirement, 50, "Open PR belum boleh dianggap firm receipt");
assert.strictEqual(risk.atRiskSupplyQty, 50, "Coverage non-firm harus tampil sebagai supply at risk");

const firstHalf = procurementSchedule({
  materialRequiredDate: "2026-09-12T00:00:00.000Z",
  supplierLeadTimeDays: 5,
  asOf: "2026-08-01T00:00:00.000Z",
});
assert.strictEqual(firstHalf.procurementWindow, "DELIVERY_1_15", "Need bulan depan tanggal 1-15 harus masuk first-half window");

const expedite = procurementSchedule({
  materialRequiredDate: "2026-08-05T00:00:00.000Z",
  supplierLeadTimeDays: 10,
  asOf: "2026-08-01T00:00:00.000Z",
});
assert.strictEqual(expedite.procurementWindow, "EXPEDITE", "Latest PR date yang lewat harus menjadi expedite");

console.log("Combined Forecast/SO, time-phased MRP, procurement window checks passed: 12/12 cases");
