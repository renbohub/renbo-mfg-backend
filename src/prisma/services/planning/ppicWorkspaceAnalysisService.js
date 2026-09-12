"use strict";
const { Prisma } = require("@prisma/client");
const d = require("./ppicWorkspaceDomain");
const scenarios = require("./ppicWorkspaceScenarioService");
const analysis = require("../../../../../library/ppic-workspace/scenario-analysis");
function ids(input, compare) {
  const values = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : [];
  if (values.length < (compare ? 2 : 1) || values.length > (compare ? 3 : 1) || new Set(values).size !== values.length || values.some(id => !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id))) throw d.fail(compare ? "Pilih dua atau tiga skenario tersimpan yang berbeda." : "Identitas skenario tidak valid.", "INVALID_SCENARIO_SELECTION");
  return values;
}
async function records(prisma, selected, query, user) {
  d.assertAccess(user, query);
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const rows = await tx.$queryRaw`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_utc FROM tbl_ppic_workspace_scenario WHERE id IN (${Prisma.join(selected)})`;
    if (rows.length !== selected.length) throw d.fail("Sebagian skenario tidak ditemukan. Muat ulang daftar.", "SCENARIO_NOT_FOUND", 404);
    const fingerprints = new Map();
    for (const month of [...new Set(rows.map(row => row.month))]) fingerprints.set(month, await scenarios.sourceFingerprint(tx, month));
    return selected.map(id => rows.find(row => row.id === id)).map(row => ({ ...scenarios.publicRow(row, true), stale: row.source_data_fingerprint !== fingerprints.get(row.month) }));
  }, { isolationLevel: "RepeatableRead", timeout: 120000 });
}
async function get(prisma, id, query, user) {
  d.assertAccess(user, query);
  const [record] = await records(prisma, ids([id], false), query, user);
  return { ...analysis.analyzeScenario(record.payload.seed, record.payload.overrides, { stale: record.stale }), scenario: { id: record.id, name: record.name, month: record.month, revision: record.revision, status: record.status, sourceIdentifier: record.sourceIdentifier, sourceFingerprint: record.sourceFingerprint, updatedAt: record.updatedAt }, stale: record.stale, generatedAt: new Date().toISOString() };
}
async function compare(prisma, input, user) {
  d.assertAccess(user, input);
  const selected = await records(prisma, ids(input.ids, true), input, user);
  return { schemaVersion: 1, ...analysis.compareScenarios(selected), generatedAt: new Date().toISOString(), timezone: "Asia/Jakarta" };
}
module.exports = { get, compare, records, ids };
