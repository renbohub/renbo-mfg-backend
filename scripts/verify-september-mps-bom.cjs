"use strict";
const assert = require("node:assert/strict");
const { prisma } = require("../src/prisma");
const { explodeMBOM } = require("../src/prisma/controllers/planning/MRPController").__test;
async function run() {
  // Exercise the actual material explosion, with database writes prohibited.
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const row = await tx.mPSDetail.findUnique({ where: { id: "c072c896-6ee9-4309-9d7d-374afce8a57c" }, include: { mps: true } });
    assert.equal(row.mbomHeaderId, "4735fd08-f680-4351-ba57-12436cccf497");
    assert.equal(row.mbomRevisionSnapshot, 7);
    assert.equal(row.mps.status, "Draft");
    assert.equal(row.mps.approvedDate, null);
    assert.equal(row.qtyPlanned, 138203);
    const phases = row.calculationTrace?.productionChecksheet?.phases || {};
    assert(Object.keys(phases).length > 0, "Production checksheet must have been reevaluated");
    assert(Object.values(phases).every((phase) => !phase.error), "No BOM evaluation errors may remain");
    const results = [];
    for (const date of ["2026-08-20", "2026-09-01", "2026-09-30"]) {
      const exploded = await explodeMBOM(tx, "VERIFY-ONLY", row.mbomHeaderId, row.qtyPlanned, new Date(date), 1,
        new Set([row.mbomHeaderId]), {}, {}, {}, {}, {}, {
          initialAvailableMap: {}, initialActualAvailableMap: {}, initialAllocatedMap: {},
          mpsDetailId: row.id, excludeSourceMpsNumbers: [row.mpsNumber],
        });
      assert(exploded.requirements.length > 0, "Material explosion must not silently return empty");
      results.push({ date, requirements: exploded.requirements.length, parts: [...new Set(exploded.requirements.map((r) => r.partCode))] });
    }
    return { result: "PASS read-only MRP explosion", mps: row.mpsNumber, revision: row.mps.revision, bom: row.mbomNoRegSnapshot, checksheetPhasesWithoutError: Object.keys(phases).length, results };
  }, { timeout: 60000 });
}
run().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); process.exit(process.exitCode || 0); });
