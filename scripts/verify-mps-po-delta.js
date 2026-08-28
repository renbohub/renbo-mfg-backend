"use strict";

const assert = require("node:assert/strict");
const { aggregateCoverageByPartMonth } = require("../src/prisma/services/planning/additionalDemandCoverageService");
const { refreshBaselineLocksForMps } = require("../src/prisma/services/planning/planningBaselineLockService");

async function run() {
  const coverage = aggregateCoverageByPartMonth([
    { month: "2026-09", customerCode: "C001", partCode: "FG-001", poQtyLocked: 90, currentSoQty: 130, poDeltaQty: 40, lock: { id: "lock-1" } },
    { month: "2026-09", customerCode: "C002", partCode: "FG-001", poQtyLocked: 40, currentSoQty: 30, poDeltaQty: -10, lock: { id: "lock-2" } },
  ]).get("2026-09|FG-001");
  assert.equal(coverage.poDeltaQty, 30, "PO+ must preserve positive and negative changes");

  const updates = [];
  const tx = {
    mPS: {
      findMany: async () => [{
        id: "mps-1",
        mpsNumber: "MPS-202609-001",
        periodStart: new Date("2026-09-01T00:00:00.000Z"),
        details: [{
          id: "detail-1",
          isDeleted: false,
          notes: null,
          partCode: "FG-001",
          customerCode: "C001",
          forecastQty: 100,
          actualSalesOrderQty: 120,
          effectiveDemandQty: 120,
          calculationTrace: { efd: { qty: 120, source: "PO" } },
          part: { salesUomCode: "PCS", baseUomCode: "PCS" },
          demandSources: [{ customerCode: "C001", sourceType: "SALES_ORDER", sourceNumber: "SO-NEW", qty: 120 }],
        }],
      }],
    },
    planningBaselineLock: {
      findMany: async () => [{
        id: "lock-1",
        periodMonth: new Date("2026-09-01T00:00:00.000Z"),
        customerCode: "C001",
        partCode: "FG-001",
        baselineMpsNumber: "MPS-202609-001",
        status: "ACTIVE",
      }],
      update: async ({ where, data }) => { updates.push({ where, data }); return { id: where.id, ...data }; },
      create: async ({ data }) => ({ id: "created", ...data }),
    },
  };
  const refreshed = await refreshBaselineLocksForMps(tx, { mpsNumbers: ["MPS-202609-001"], actor: "ppic.user" });
  assert.equal(refreshed.updatedCount, 1);
  assert.equal(updates[0].data.poQtyLocked, 120, "successful recalculation advances the PO baseline");
  assert.equal(updates[0].data.efdQtyLocked, 120);

  console.log("PASS verify-mps-po-delta: signed PO+ and baseline refresh verified");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
