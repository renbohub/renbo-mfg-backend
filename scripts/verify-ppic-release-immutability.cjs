"use strict";
const assert = require("node:assert/strict"), { randomUUID } = require("node:crypto"), { Client } = require("pg");
require("dotenv").config({ quiet: true });
const url = new URL(process.env.DATABASE_URL);
if (process.env.NODE_ENV !== "development" || !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error("Verified local development database required.");
const db = new Client({ connectionString: process.env.DATABASE_URL });
async function main() {
  await db.connect(); const scenarioId = randomUUID(), requestId = randomUUID(), baselineId = randomUUID(), actor = "PPIC-SQL-ROLLBACK-FIXTURE";
  let assertions = 0;
  await db.query("BEGIN");
  try {
    const used = new Set((await db.query("SELECT month FROM tbl_ppic_released_baseline")).rows.map(row => row.month));
    const month = Array.from({ length: 100 }, (_, index) => `${2100 + index}-12`).find(month => !used.has(month));
    assert.ok(month);
    await db.query("INSERT INTO tbl_ppic_workspace_scenario (id,name,month,source_identifier,source_fingerprint,source_data_fingerprint,payload,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$5,$6,$2,$2)", [scenarioId, actor, month, `MONTH:${month}`, "a".repeat(64), { version: 1, testFixture: true }]);
    await db.query("INSERT INTO tbl_ppic_release_request (id,scenario_id,scenario_revision,month,source_fingerprint,bundle_hash,review,submitted_actor_id,submitted_by,note) VALUES ($1,$2,1,$3,$4,$4,$5,$6,$6,$6)", [requestId, scenarioId, month, "a".repeat(64), { testFixture: true, checks: [] }, actor]);
    await db.query("INSERT INTO tbl_ppic_released_baseline (id,request_id,month,scenario_id,scenario_revision,bundle_hash,bundle,published_by) VALUES ($1,$2,$3,$4,1,$5,$6,$7)", [baselineId, requestId, month, scenarioId, "a".repeat(64), { testFixture: true }, actor]); assertions++;
    async function rejectsMutation(sql, values, expectedMessage) {
      await db.query("SAVEPOINT immutable_probe");
      let rejected = false;
      try { await db.query(sql, values); }
      catch (error) { rejected = true; assert.equal(error.code, "P0001"); assert.match(error.message, expectedMessage); }
      await db.query("ROLLBACK TO SAVEPOINT immutable_probe"); assert.equal(rejected, true); assertions++;
    }
    await rejectsMutation("UPDATE tbl_ppic_released_baseline SET bundle=$1 WHERE id=$2", [{ altered: true }, baselineId], /baseline is immutable/);
    await rejectsMutation("DELETE FROM tbl_ppic_released_baseline WHERE id=$1", [baselineId], /baseline is immutable/);
    await rejectsMutation("UPDATE tbl_ppic_release_request SET review=$1 WHERE id=$2", [{ altered: true }, requestId], /review snapshot is immutable/);
    await rejectsMutation("UPDATE tbl_ppic_release_request SET source_fingerprint=$1 WHERE id=$2", ["b".repeat(64), requestId], /review snapshot is immutable/);
    await rejectsMutation("UPDATE tbl_ppic_release_request SET submitted_actor_id=$1 WHERE id=$2", ["forged", requestId], /review snapshot is immutable/);
    await db.query("UPDATE tbl_ppic_release_request SET status='APPROVED',revision=revision+1,note=$1 WHERE id=$2", ["Fixture state transition only", requestId]);
    const request = (await db.query("SELECT status,revision,review FROM tbl_ppic_release_request WHERE id=$1", [requestId])).rows[0];
    assert.equal(request.status, "APPROVED"); assert.equal(request.revision, 2); assert.equal(request.review.testFixture, true); assertions++;
  } finally { await db.query("ROLLBACK"); }
  const remaining = await db.query("SELECT (SELECT count(*) FROM tbl_ppic_workspace_scenario WHERE id=$1)::int AS scenarios,(SELECT count(*) FROM tbl_ppic_release_request WHERE id=$2)::int AS requests,(SELECT count(*) FROM tbl_ppic_released_baseline WHERE id=$3)::int AS baselines", [scenarioId, requestId, baselineId]);
  assert.deepEqual(remaining.rows[0], { scenarios: 0, requests: 0, baselines: 0 }); assertions++;
  console.log(JSON.stringify({ immutableReleaseSqlChecks: assertions, rolledBack: true, persistedFixtures: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.end());
