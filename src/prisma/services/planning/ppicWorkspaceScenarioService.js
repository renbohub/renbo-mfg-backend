"use strict";
const { randomUUID } = require("node:crypto");
const d = require("./ppicWorkspaceDomain");
const engine = require("../../../../../library/ppic-planning/engine.js");
const canonicalSource = month => `MONTH:${month}`;
const sourceFingerprint = (tx, month) => require("./integratedPlanService").sourceFingerprint(tx, canonicalSource(month), ["Vendor", "Supplier", "Process", "Customer"]);
const defaultDependencies = { sourceFingerprint, seed: (prisma, input, options) => require("./ppicSandboxCachedSeed").seed(prisma, input, options), calculate: engine.calculate };
const idValue = id => { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(String(id || ""))) throw d.fail("Identitas skenario tidak valid."); return id; };
const publicRow = (row, includePayload = false) => ({ id: row.id, name: row.name, month: row.month, revision: row.revision, status: row.status, sourceIdentifier: row.source_identifier, sourceFingerprint: row.source_fingerprint, createdBy: row.created_by, updatedBy: row.updated_by, createdAt: d.iso(row.created_at_utc || row.created_at), updatedAt: d.iso(row.updated_at_utc || row.updated_at), ...(includePayload ? { payload: row.payload } : {}) });

async function seed(prisma, input, user, dependencies = defaultDependencies) {
  d.assertAccess(user, input); const month = d.monthKey(input.month);
  const result = await dependencies.seed(prisma, { mpsNumber: canonicalSource(month), user }, { force: input.force === true });
  if (result.month !== month) throw d.fail("Periode snapshot tidak cocok dengan permintaan.", "SNAPSHOT_MONTH_MISMATCH", 409);
  return result;
}
async function list(prisma, query, user) {
  d.assertAccess(user, query); const month = d.monthKey(query.month);
  const rows = await prisma.$queryRaw`SELECT id,name,month,revision,status,source_identifier,source_fingerprint,created_by,updated_by,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_utc FROM tbl_ppic_workspace_scenario WHERE month=${month} ORDER BY updated_at DESC, id ASC LIMIT 200`;
  return { items: rows.map(row => publicRow(row)), limit: 200 };
}
async function get(prisma, id, query, user, dependencies = defaultDependencies) {
  d.assertAccess(user, query); idValue(id);
  const rows = await prisma.$queryRaw`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_utc FROM tbl_ppic_workspace_scenario WHERE id=${id}`;
  if (!rows[0]) throw d.fail("Skenario tidak ditemukan.", "SCENARIO_NOT_FOUND", 404);
  const row = rows[0];
  const [current, history] = await Promise.all([
    prisma.$transaction(tx => dependencies.sourceFingerprint(tx, row.month), { isolationLevel: "RepeatableRead", timeout: 45000 }),
    prisma.$queryRaw`SELECT revision,action,actor,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc FROM tbl_ppic_workspace_scenario_operation WHERE scenario_id=${id} ORDER BY revision DESC LIMIT 100`,
  ]);
  return { ...publicRow(row, true), stale: current !== row.source_data_fingerprint, history: history.map(item => ({ revision: item.revision, action: item.action, actor: item.actor, createdAt: d.iso(item.created_at_utc) })) };
}
async function replay(tx, operationId, requestHash) {
  const rows = await tx.$queryRaw`SELECT o.request_hash,o.result,to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc,to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_utc FROM tbl_ppic_workspace_scenario_operation o JOIN tbl_ppic_workspace_scenario s ON s.id=o.scenario_id WHERE o.operation_id=${operationId}`;
  if (!rows[0]) return null;
  if (rows[0].request_hash !== requestHash) throw d.fail("Identitas operasi telah dipakai untuk permintaan berbeda.", "OPERATION_ID_CONFLICT", 409);
  return { ...rows[0].result, createdAt: d.iso(rows[0].created_at_utc) || rows[0].result.createdAt, updatedAt: d.iso(rows[0].updated_at_utc) || rows[0].result.updatedAt, replayed: true };
}
async function save(prisma, input, user, id = null, dependencies = defaultDependencies) {
  d.assertAccess(user, input, id ? "update" : "create"); if (id) idValue(id);
  const normalized = d.normalizeScenario(input, Boolean(id));
  const actor = user.username || user.email || user.id, actorId = user.id;
  const requestHash = d.hash({ actorId, id, ...normalized });
  const previous = await replay(prisma, normalized.operationId, requestHash); if (previous) return previous;
  const before = await prisma.$transaction(tx => dependencies.sourceFingerprint(tx, normalized.month), { isolationLevel: "RepeatableRead", timeout: 45000 });
  const currentSeed = await seed(prisma, { month: normalized.month, plant: input.plant }, user, dependencies);
  if (![canonicalSource(normalized.month), currentSeed.mpsNumber].includes(normalized.sourceIdentifier) || currentSeed.fingerprint !== normalized.sourceFingerprint) throw d.fail("Sumber Gantt berubah. Muat snapshot terbaru dan tinjau adjustment sebelum menyimpan.", "SCENARIO_SOURCE_CHANGED", 409);
  const overrides = d.validateOverrides(currentSeed, normalized.overrides);
  try { dependencies.calculate(currentSeed, overrides); } catch (error) { throw d.fail(error.message, "INVALID_SCENARIO_CALCULATION"); }
  const payload = { version: 1, seed: currentSeed, overrides }, payloadJson = JSON.stringify(payload);
  if (Buffer.byteLength(payloadJson) > 25 * 1024 * 1024) throw d.fail("Snapshot terlalu besar untuk disimpan dalam satu skenario.", "SNAPSHOT_TOO_LARGE", 413);
  try {
    return await prisma.$transaction(async tx => {
      const prior = await replay(tx, normalized.operationId, requestHash); if (prior) return prior;
      if (await dependencies.sourceFingerprint(tx, normalized.month) !== before) throw d.fail("Data sumber berubah saat snapshot disimpan. Muat ulang data awal.", "SCENARIO_SOURCE_CHANGED", 409);
      let rows;
      if (id) {
        rows = await tx.$queryRaw`UPDATE tbl_ppic_workspace_scenario SET name=${normalized.name},revision=revision+1,source_identifier=${canonicalSource(normalized.month)},source_fingerprint=${currentSeed.fingerprint},source_data_fingerprint=${before},payload=${payloadJson}::jsonb,updated_by=${actor},updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND month=${normalized.month} AND revision=${normalized.expectedRevision} AND status='DRAFT' RETURNING *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_utc`;
        if (!rows[0]) throw d.fail("Skenario berubah di sesi lain atau tidak dapat diedit. Buka kembali; adjustment Anda belum ditimpa.", "SCENARIO_REVISION_CONFLICT", 409);
      } else {
        const newId = randomUUID();
        rows = await tx.$queryRaw`INSERT INTO tbl_ppic_workspace_scenario (id,name,month,source_identifier,source_fingerprint,source_data_fingerprint,payload,created_by,updated_by) VALUES (${newId},${normalized.name},${normalized.month},${canonicalSource(normalized.month)},${currentSeed.fingerprint},${before},${payloadJson}::jsonb,${actor},${actor}) RETURNING *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_utc`;
      }
      const result = { ...publicRow(rows[0], true), stale: false, replayed: false };
      const resultJson = JSON.stringify(result), action = id ? "UPDATE" : "CREATE";
      await tx.$executeRaw`INSERT INTO tbl_ppic_workspace_scenario_operation (operation_id,scenario_id,request_hash,revision,action,actor_id,actor,result) VALUES (${normalized.operationId},${rows[0].id},${requestHash},${rows[0].revision},${action},${actorId},${actor},${resultJson}::jsonb)`;
      return result;
    }, { isolationLevel: "Serializable", timeout: 120000 });
  } catch (error) {
    if (error.code === "P2034" || error.code === "40001" || error.code === "P2002" || error.meta?.code === "23505" || error.meta?.code === "40001") {
      const prior = await replay(prisma, normalized.operationId, requestHash); if (prior) return prior;
      throw d.fail("Data berubah saat penyimpanan. Muat ulang skenario sebelum mencoba kembali.", "SCENARIO_REVISION_CONFLICT", 409);
    }
    throw error;
  }
}
module.exports = { seed, list, get, save, replay, publicRow, sourceFingerprint, defaultDependencies };
