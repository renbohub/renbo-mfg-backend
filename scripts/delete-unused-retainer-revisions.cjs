"use strict";
const { prisma } = require("../src/prisma");
const { Prisma } = require("@prisma/client");
const { audit, KEEP_ID } = require("./audit-retainer-bom-revisions.cjs");
const { queueDirtyPartCodes } = require("../src/prisma/utils/mrpDirtyQueue");
// Exact obsolete, unreferenced revisions authorized for permanent deletion.
const REMOVE_IDS = ["7b043f77-bfec-4a43-94ee-ab2c35df9b89", "eaac273b-d6a0-4310-ab44-40598532fa60"];
async function run() {
  if (!process.argv.includes("--execute")) return audit();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
    await tx.$queryRaw`SELECT id FROM tbl_mbomheader WHERE id IN (${Prisma.join([...REMOVE_IDS, KEEP_ID])}) FOR UPDATE`;
    const before = await audit(tx);
    const selected = before.revisions.filter((row) => REMOVE_IDS.includes(row.id));
    if (selected.length !== 2 || selected.some((row) => row.refs.length || ![3, 4].includes(row.revision))) throw new Error("Deletion stopped: expected unreferenced revisions 3 and 4 only");
    const numbers = selected.map((row) => row.noReg);
    const details = await tx.mBOMDetail.findMany({ where: { noReg: { in: numbers } }, select: { id: true, part: { select: { partCode: true } } } });
    const detailIds = details.map((row) => row.id);
    if (detailIds.length) {
      await tx.$queryRaw`SELECT id FROM tbl_mbomdetail WHERE id IN (${Prisma.join(detailIds)}) FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM tbl_mbomprocess WHERE bom_detail_id IN (${Prisma.join(detailIds)}) FOR UPDATE`;
    }
    const rechecked = await audit(tx);
    if (rechecked.revisions.filter((row) => REMOVE_IDS.includes(row.id)).some((row) => row.refs.length)) throw new Error("New document references found; deletion cancelled");
    const headers = await tx.mBOMHeader.findMany({ where: { OR: [{ id: { in: REMOVE_IDS } }, { revisionOfMbomId: { in: REMOVE_IDS } }] } });
    const byId = new Map(headers.map((row) => [row.id, row]));
    const lineageUpdates = [];
    for (const row of headers.filter((header) => !REMOVE_IDS.includes(header.id))) {
      let ancestor = row.revisionOfMbomId;
      const seen = new Set();
      while (REMOVE_IDS.includes(ancestor)) {
        if (seen.has(ancestor)) throw new Error("Revision lineage cycle; deletion cancelled");
        seen.add(ancestor);
        ancestor = byId.get(ancestor)?.revisionOfMbomId || null;
      }
      await tx.mBOMHeader.update({ where: { id: row.id }, data: { revisionOfMbomId: ancestor, revisionNote: `${row.revisionNote || ""}\n[Cleanup] Revisi 3 dan 4 dihapus permanen atas permintaan pengguna; nomor revisi dan struktur BOM ini tetap.`.trim() } });
      lineageUpdates.push({ noReg: row.noReg, revisionOfMbomId: ancestor });
    }
    const costs = await tx.mBOMCostHeader.deleteMany({ where: { mbomId: { in: REMOVE_IDS } } });
    const processes = await tx.mBOMProcess.deleteMany({ where: { mbomDetailId: { in: detailIds } } });
    const components = await tx.mBOMDetail.deleteMany({ where: { id: { in: detailIds } } });
    const removed = await tx.mBOMHeader.deleteMany({ where: { id: { in: REMOVE_IDS }, revision: { in: [3, 4] } } });
    if (removed.count !== 2) throw new Error("Unexpected deleted header count");
    await queueDirtyPartCodes(tx, ["C003-0010-000", ...details.map((row) => row.part?.partCode)], { reason: "BOM", sourceNumber: numbers.join(", "), notes: "Penghapusan permanen revisi Retainer 3–4 yang tidak direferensikan dokumen; revisi 7 dipertahankan. Tidak mengubah qty atau approval dokumen." });
    const after = await audit(tx);
    if (after.revisions.some((row) => REMOVE_IDS.includes(row.id))) throw new Error("Deleted revisions remain");
    for (const row of after.revisions) {
      if (JSON.stringify(row.refs) !== JSON.stringify(before.revisions.find((old) => old.id === row.id).refs)) throw new Error("Unexpected change to protected references");
    }
    return { deleted: selected.map(({ noReg, revision }) => ({ noReg, revision })), counts: { headers: removed.count, details: components.count, processes: processes.count, costs: costs.count }, lineageUpdates, kept: after };
  }, { isolationLevel: "Serializable", timeout: 30000 });
}
run().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); process.exit(process.exitCode || 0); });
