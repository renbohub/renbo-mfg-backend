"use strict";
const assert = require("node:assert/strict"), { randomUUID } = require("node:crypto");
require("dotenv").config({ quiet: true }); const url = new URL(process.env.DATABASE_URL);
if (process.env.NODE_ENV !== "development" || !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error("Verified local development database required.");
process.env.NODE_ENV = "test";
const { prisma } = require("../src/prisma/index"), service = require("../src/prisma/services/planning/ppicImprovementService"), clock = require("../src/prisma/utils/businessClock");
const rollback = new Error("EXPECTED_ROLLBACK");
async function main() {
  let fixtureId, checks = 0;
  await clock.withBusinessDate("2026-08-31", async () => {
    try { await prisma.$transaction(async tx => {
      const owner = await tx.user.findFirst({ where: { isDeleted: false }, select: { id: true } }); assert.ok(owner);
      const person = { id: owner.id, username: "Rollback maker", isSuperAdmin: true }, reviewer = { id: "PPIC-ROLLBACK-INDEPENDENT-REVIEWER", username: "Rollback reviewer", isSuperAdmin: true };
      const db = { $queryRaw: tx.$queryRaw.bind(tx), $executeRaw: tx.$executeRaw.bind(tx), $transaction: fn => fn(tx), user: tx.user };
      const body = { title: "TRANSACTION-ONLY improvement fixture", issue: "Setup too long", cause: "Tool staging hypothesis", proposedAction: "Prepare tooling before shift", ownerId: owner.id, dueDate: "2026-09-10", metric: { name: "Median setup", unit: "minute", direction: "LOWER", target: 30, aggregation: "MEDIAN" }, baseline: { value: 38, sampleSize: 12, windowStart: "2026-08-01", windowEnd: "2026-08-07", evidence: ["SETUP-BEFORE"] }, observation: { value: 29, sampleSize: 12, windowStart: "2026-08-12", windowEnd: "2026-08-19", evidence: ["SETUP-AFTER"] }, operationId: randomUUID() };
      let result = await service.save(db, body, person); fixtureId = result.id; assert.equal(result.revision, 1); assert.equal(result.payload.provenance, "USER_RECORDED"); assert.equal(result.outcome.delta, -9); checks++;
      const duplicate = await service.save(db, body, person); assert.equal(duplicate.id, fixtureId); assert.equal(duplicate.replayed, true); checks++;
      await assert.rejects(() => service.save(db, { ...body, title: "Changed replay" }, person), { code: "OPERATION_ID_CONFLICT" }); checks++;
      const step = async (action, user = person, note = "Evidence reviewed; effect attribution requires context") => { result = await service.transition(db, fixtureId, { action, operationId: randomUUID(), expectedRevision: result.revision, note }, user); return result; };
      await step("START"); await step("SUBMIT"); assert.equal(result.status, "PENDING_VERIFICATION"); assert.equal(result.baselineLocked, true); checks++;
      await assert.rejects(() => step("VERIFY"), { code: "INDEPENDENT_REVIEW_REQUIRED" }); checks++;
      await step("RETURN", reviewer); assert.equal(result.status, "IN_PROGRESS");
      await assert.rejects(() => service.save(db, { ...body, baseline: { ...body.baseline, value: 20 }, operationId: randomUUID(), expectedRevision: result.revision }, person, fixtureId), { code: "MEASUREMENT_CONTRACT_CHANGED" }); checks++;
      result = await service.save(db, { ...body, observation: { ...body.observation, value: 31 }, operationId: randomUUID(), expectedRevision: result.revision }, person, fixtureId); assert.equal(result.outcome.targetMet, false); checks++;
      await assert.rejects(() => service.save(db, { ...body, operationId: randomUUID(), expectedRevision: 1 }, person, fixtureId), { code: "IMPROVEMENT_REVISION_CONFLICT" }); checks++;
      await step("SUBMIT"); await step("VERIFY", reviewer); assert.equal(result.status, "VERIFIED"); assert.equal(result.verifiedActorId, reviewer.id); checks++;
      await step("CLOSE"); assert.equal(result.status, "CLOSED"); assert.equal(result.revision, 8); checks++;
      await assert.rejects(() => service.save(db, { ...body, operationId: randomUUID(), expectedRevision: 8 }, person, fixtureId), { code: "IMPROVEMENT_STATE_CONFLICT" }); checks++;
      const loaded = await service.get(db, fixtureId, {}, person); assert.equal(loaded.history.length, 8); assert.equal(loaded.payload.baseline.value, 38); assert.equal(loaded.payload.observation.value, 31); assert.equal(loaded.verifiedBy, reviewer.username); assert.equal(loaded.createdAt, result.createdAt); checks++;
      const list = await service.list(db, { month: "2026-09", q: "TRANSACTION-ONLY improvement fixture" }, person); assert.ok(list.items.some(row => row.id === fixtureId)); assert.equal(list.items.find(row => row.id === fixtureId).status, "CLOSED"); checks++;
      throw rollback;
    }, { timeout: 45000 }); } catch (error) { if (error !== rollback) throw error; }
  });
  const rows = await prisma.$queryRaw`SELECT id FROM tbl_ppic_improvement_action WHERE id=${fixtureId}`;
  assert.equal(rows.length, 0); checks++;
  console.log(JSON.stringify({ improvementIntegrationChecks: checks, lifecycleRevisions: 8, rolledBack: true, persistedFixtureCount: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
