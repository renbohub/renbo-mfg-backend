const assert = require("node:assert/strict");
const {
  buildBaselineRows,
  fingerprintBaselineRows,
  lockBaselineForMps,
} = require("../src/prisma/services/planning/planningBaselineLockService");

function documents() {
  return [{
    id: "mps-id",
    mpsNumber: "MPS-202609-B001",
    periodStart: new Date("2026-09-01T00:00:00.000Z"),
    details: [{
      id: "detail-1",
      partCode: "FG-001",
      notes: "[FG-RECEIPT] Monthly demand",
      forecastQty: 100,
      actualSalesOrderQty: 120,
      effectiveDemandQty: 125,
      calculationTrace: { efd: { qty: 120 } },
      part: { salesUomCode: "PCS", baseUomCode: "PCS" },
      demandSources: [
        { sourceType: "FORECAST", sourceNumber: "FCT-1", sourceLineId: "f1", customerCode: "C001", qty: 60, uomCode: "PCS", deliveryTargetId: "ft-1" },
        { sourceType: "FORECAST", sourceNumber: "FCT-2", sourceLineId: "f2", customerCode: "C002", qty: 40, uomCode: "PCS", deliveryTargetId: "ft-2" },
        { sourceType: "SALES_ORDER", sourceNumber: "SO-1", sourceLineId: "s1", customerCode: "C001", qty: 90, uomCode: "PCS", deliveryTargetId: "so-1" },
        { sourceType: "SALES_ORDER", sourceNumber: "SO-2", sourceLineId: "s2", customerCode: "C002", qty: 30, uomCode: "PCS", deliveryTargetId: "so-2" },
      ],
    }, {
      id: "detail-generated-1",
      partCode: "CHILD-001",
      customerCode: "C001",
      notes: "[MRP-PRODUCTION] Generated from MRP-202609-R001; source FG-001",
      forecastQty: 100,
      actualSalesOrderQty: 120,
      effectiveDemandQty: 120,
      part: { salesUomCode: "PCS", baseUomCode: "PCS" },
      demandSources: [],
    }, {
      id: "detail-generated-2",
      partCode: "CHILD-001",
      customerCode: "C001",
      notes: "[MRP-PRODUCTION] Generated from MRP-202609-R001; source FG-001",
      forecastQty: 100,
      actualSalesOrderQty: 120,
      effectiveDemandQty: 120,
      part: { salesUomCode: "PCS", baseUomCode: "PCS" },
      demandSources: [],
    }],
  }];
}

function fakeTransaction(existingRows = []) {
  const stored = existingRows.map((row) => ({ ...row }));
  const mpsUpdates = [];
  return {
    stored,
    mpsUpdates,
    mPS: {
      findMany: async () => documents(),
      updateMany: async (args) => { mpsUpdates.push(args); return { count: 1 }; },
    },
    planningBaselineLock: {
      findMany: async () => stored,
      create: async ({ data }) => {
        const created = { id: `lock-${stored.length + 1}`, ...data };
        stored.push(created);
        return created;
      },
      updateMany: async () => ({ count: 1 }),
    },
  };
}

async function run() {
  const rows = buildBaselineRows(documents());
  assert.equal(rows.length, 2, "MRP-generated child/process rows are not treated as baseline demand");
  assert.equal(rows.reduce((sum, row) => sum + row.efdQtyLocked, 0), 120, "allocated customer EFD preserves the exact MPS EFD total");
  assert.equal(rows.reduce((sum, row) => sum + row.forecastQtyLocked, 0), 100, "forecast lock total matches the MPS snapshot");
  assert.equal(rows.reduce((sum, row) => sum + row.poQtyLocked, 0), 120, "PO lock total matches the MPS snapshot");
  assert.deepEqual(rows.map((row) => row.customerCode), ["C001", "C002"], "customer allocation is deterministic");

  const fingerprint = fingerprintBaselineRows(rows);
  assert.equal(fingerprint, fingerprintBaselineRows([...rows].reverse()), "source fingerprint is independent of query order");

  const tx = fakeTransaction();
  const first = await lockBaselineForMps(tx, {
    mpsNumbers: ["MPS-202609-B001"],
    actor: "ppic.user",
    expectedFingerprint: fingerprint,
  });
  assert.equal(first.createdCount, 2, "first lock persists every customer scope");
  assert.equal(tx.mpsUpdates.length, 1, "baseline MPS is marked locked in the same workflow");

  const original = tx.stored.map((row) => ({ ...row }));
  const second = await lockBaselineForMps(tx, {
    mpsNumbers: ["MPS-202609-B001"],
    actor: "other.user",
    expectedFingerprint: fingerprint,
  });
  assert.equal(second.createdCount, 0, "same baseline lock request is idempotent");
  assert.deepEqual(tx.stored, original, "idempotent lock never overwrites actor, quantity, or source snapshot");

  await assert.rejects(
    () => lockBaselineForMps(fakeTransaction(), {
      mpsNumbers: ["MPS-202609-B001"],
      actor: "ppic.user",
      expectedFingerprint: "stale-preview-fingerprint",
    }),
    (error) => error.code === "BASELINE_SOURCE_CHANGED" && error.statusCode === 409,
    "stale preview fingerprint is rejected",
  );

  console.log("PASS verify-planning-baseline-lock: immutable lock behavior verified");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
