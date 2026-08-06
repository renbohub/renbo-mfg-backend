const assert = require("assert");
const { predecessorQuantityStatus } = require("../src/prisma/services/planning/capacityPlanningService");
const { generatedBatchQuantity } = require("../src/prisma/services/planning/capacityRecommendationService");

const equalBomCoverage = predecessorQuantityStatus(57.333, 172, 78.667, 236);
assert.strictEqual(equalBomCoverage.mode, "COVERAGE");
assert.strictEqual(equalBomCoverage.short, false, "Rasio BOM berbeda dengan coverage batch sama tidak boleh menjadi blocker");

const realCoverageShortage = predecessorQuantityStatus(43, 172, 78.667, 236);
assert.strictEqual(realCoverageShortage.short, true, "Coverage predecessor 25% harus memblokir successor 33,33%");

const rawFallbackShortage = predecessorQuantityStatus(5, 0, 6, 0);
assert.strictEqual(rawFallbackShortage.mode, "RAW_QTY");
assert.strictEqual(rawFallbackShortage.short, true, "Tanpa target MPP, validator harus memakai fallback qty mentah");

const paintPhase1 = generatedBatchQuantity(100, 0, 280 / 300, "pcs");
const paintPhase2 = generatedBatchQuantity(200, 100, 280 / 300, "pcs");
assert.deepStrictEqual([paintPhase1, paintPhase2, paintPhase1 + paintPhase2], [93, 187, 280], "PCS harus bulat dan sisa pembulatan masuk ke phase berikutnya");

const roundedEqualCoverage = predecessorQuantityStatus(57, 172, 79, 236, "pcs", "pcs");
assert.strictEqual(roundedEqualCoverage.short, false, "Selisih coverage akibat pembulatan maksimal setengah PCS per line tidak boleh menjadi blocker");

const roundedRealShortage = predecessorQuantityStatus(55, 172, 79, 236, "pcs", "pcs");
assert.strictEqual(roundedRealShortage.short, true, "Kekurangan riil di luar toleransi pembulatan PCS harus tetap menjadi blocker");

console.log("Capacity predecessor and discrete allocation checks passed: 6/6 cases");
