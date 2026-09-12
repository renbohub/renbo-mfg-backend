"use strict";
// Development-only integration probe. Scenario fixtures exist exclusively inside
// an outer transaction that is intentionally rolled back. No official writes.
const assert = require("node:assert/strict"), { randomUUID } = require("node:crypto");
require("dotenv").config({ quiet: true });
const url = new URL(process.env.DATABASE_URL);
if (process.env.NODE_ENV !== "development" || !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error("Verified local development database required.");
// Keep this test process quiet after verifying the deployment classification.
process.env.NODE_ENV = "test";
const { prisma } = require("../src/prisma/index");
const service = require("../src/prisma/services/planning/ppicWorkspaceScenarioService");
const workspace = require("../src/prisma/services/planning/ppicWorkspaceService");
const clock = require("../src/prisma/utils/businessClock");
const actor = { id: "PPIC-WORKSPACE-TEST", username: "PPIC-WORKSPACE-TEST", isSuperAdmin: true };
const rollback = new Error("EXPECTED_TEST_ROLLBACK");
async function main() {
  const before = await prisma.$queryRaw`SELECT count(*)::int AS total FROM tbl_ppic_workspace_scenario`;
  let checks = 0;
  try {
    await prisma.$transaction(async tx => {
      const db = { $queryRaw: tx.$queryRaw.bind(tx), $executeRaw: tx.$executeRaw.bind(tx), $transaction: fn => fn(tx) };
      let fingerprint = "data-before", captures = 0;
      const seed = { version: 1, month: "2026-09", mpsNumber: "MPS-FIXTURE", fingerprint: "a".repeat(64), horizonStart: "2026-08-01", horizonEnd: "2026-11-01", nodes: [{ id: "fg", kind: "fg", qty: 100 }], vendors: [] };
      const deps = { seed: async () => { captures++; return structuredClone(seed); }, sourceFingerprint: async () => fingerprint, calculate: (_seed, overrides) => { assert.equal(overrides.fg.qty >= 0, true); } };
      const body = { name: "TRANSACTION-ONLY-FIXTURE", month: "2026-09", sourceIdentifier: "MPS-FIXTURE", sourceFingerprint: seed.fingerprint, operationId: randomUUID(), payload: { version: 1, overrides: { fg: { qty: 123 } } } };
      const created = await service.save(db, body, actor, null, deps); assert.equal(created.revision, 1); assert.equal(created.payload.seed.nodes[0].qty, 100); assert.equal(created.payload.overrides.fg.qty, 123); checks++;
      const duplicate = await service.save(db, body, actor, null, deps); assert.equal(duplicate.id, created.id); assert.equal(duplicate.replayed, true); assert.equal(captures, 1); checks++;
      await assert.rejects(() => service.save(db, { ...body, name: "Conflicting replay" }, actor, null, deps), { code: "OPERATION_ID_CONFLICT" }); checks++;
      await assert.rejects(() => service.save(db, { ...body, operationId: randomUUID(), sourceFingerprint: "b".repeat(64) }, actor, null, deps), { code: "SCENARIO_SOURCE_CHANGED" }); checks++;
      const updated = await service.save(db, { ...body, operationId: randomUUID(), expectedRevision: 1, payload: { version: 1, overrides: { fg: { qty: 1123 } } } }, actor, created.id, deps); assert.equal(updated.revision, 2); checks++;
      await assert.rejects(() => service.save(db, { ...body, operationId: randomUUID(), expectedRevision: 1 }, actor, created.id, deps), { code: "SCENARIO_REVISION_CONFLICT" }); checks++;
      const loaded = await service.get(db, created.id, {}, actor, deps); assert.equal(loaded.stale, false); assert.equal(loaded.payload.overrides.fg.qty, 1123); assert.deepEqual(loaded.history.map(row => row.revision), [2, 1]); checks++;
      fingerprint = "data-after"; const stale = await service.get(db, created.id, {}, actor, deps); assert.equal(stale.stale, true); assert.equal(stale.payload.overrides.fg.qty, 1123); checks++;
      const entries = await service.list(db, { month: "2026-09" }, actor); assert.ok(entries.items.some(row => row.id === created.id)); assert.equal(entries.items.find(row => row.id === created.id).payload, undefined); checks++;
      throw rollback;
    }, { timeout: 30000 });
  } catch (error) { if (error !== rollback) throw error; }
  const after = await prisma.$queryRaw`SELECT count(*)::int AS total FROM tbl_ppic_workspace_scenario`; assert.equal(after[0].total, before[0].total); checks++;
  console.log(JSON.stringify({ scenarioIntegrationChecks: checks, rolledBack: true, persistedFixtureCount: 0 }));
  const businessDate = await clock.readDemoDate(prisma);
  await clock.withBusinessDate(businessDate, async () => {
    const result = await workspace.snapshot(prisma, { month: "2026-09", plant: "ALL" }, actor);
    assert.equal(result.schemaVersion, 1); assert.equal(result.month, "2026-09"); assert.equal(result.home.deliveryCount, result.demand.items.length); assert.equal(result.capabilities.release, false);
    console.log(JSON.stringify({ snapshot: { month: result.month, businessDate: result.businessDate, deliveryCount: result.home.deliveryCount, fgCount: result.home.fgCount, totals: result.demand.totalsByUom, readiness: result.readiness.map(row => ({ id: row.id, status: row.status })), resources: result.filters.resources.length, sourceFingerprintPresent: /^[a-f0-9]{64}$/.test(result.source.fingerprint) } }));
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
