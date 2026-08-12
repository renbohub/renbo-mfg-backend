"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  normalizeMpsRunSelection,
  targetIncludedInMpsSelection,
} = require("../src/prisma/services/planning/monthlyPlanningService");

const normalized = normalizeMpsRunSelection({
  months: ["2026-10", "2026-09", "2026-09"],
  selectedDeliveryTargetIds: ["forecast-1", "so-1", "forecast-1"],
  selectionRequired: true,
});
assert.deepStrictEqual(normalized.months, ["2026-09", "2026-10"], "Bulan harus unik dan terurut");
assert.deepStrictEqual(normalized.selectedDeliveryTargetIds, ["forecast-1", "so-1"], "Target pilihan harus unik");

assert.throws(
  () => normalizeMpsRunSelection({ months: ["2026-08", "2026-09", "2026-10", "2026-11"] }),
  /maksimal mencakup 3 bulan/i,
  "Backend wajib menolak run lebih dari tiga bulan",
);
assert.throws(
  () => normalizeMpsRunSelection({ months: ["2026-09"], selectedDeliveryTargetIds: [], selectionRequired: true }),
  /Pilih minimal satu delivery target/i,
  "Explicit selection tidak boleh kosong",
);

const selected = new Set(["forecast-1", "so-direct"]);
assert.strictEqual(targetIncludedInMpsSelection({ id: "forecast-1" }, selected), true, "Forecast target terpilih harus masuk");
assert.strictEqual(targetIncludedInMpsSelection({ id: "so-linked", consumesForecastTargetId: "forecast-1" }, selected), true, "SO yang consume forecast terpilih harus ikut");
assert.strictEqual(targetIncludedInMpsSelection({ id: "so-direct" }, selected), true, "SO tanpa forecast dapat dipilih langsung");
assert.strictEqual(targetIncludedInMpsSelection({ id: "forecast-2" }, selected), false, "Delivery target yang di-uncheck tidak boleh masuk");

const controller = fs.readFileSync(path.resolve(__dirname, "../src/prisma/controllers/planning/MPSController.js"), "utf8");
const service = fs.readFileSync(path.resolve(__dirname, "../src/prisma/services/planning/monthlyPlanningService.js"), "utf8");
assert(controller.includes("selectedDeliveryTargetIds: normalizedSelection.selectedDeliveryTargetIds"), "Controller harus meneruskan pilihan ke service");
assert(service.includes("complete next-month Forecast horizon") || service.includes("complete next-month"), "Buffer harus tetap memakai look-ahead lengkap walau bulan berikutnya di-uncheck");

console.log("MPS delivery-target selection contracts passed: 10/10 cases");
