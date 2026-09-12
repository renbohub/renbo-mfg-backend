"use strict";
const { prisma } = require("../src/prisma");
const { Prisma } = require("@prisma/client");
const KEEP_ID = "4735fd08-f680-4351-ba57-12436cccf497";
const TARGET_IDS = ["8e220865-83ee-4a51-96e1-1bf2e6d9ff92", "193e0055-ad35-4ca0-84eb-99014d6399db", "7b043f77-bfec-4a43-94ee-ab2c35df9b89", "eaac273b-d6a0-4310-ab44-40598532fa60", "fd39d1aa-873d-4bb6-beee-4109946e01fd", "534d6b28-07fc-47d6-a2d2-bd7f27feae47"];
const CORE = ["tbl_mbomheader", "tbl_mbomdetail", "tbl_mbomprocess", "tbl_mbomcost_header", "tbl_mbomcost_detail"];
const ident = (value) => Prisma.raw('"' + String(value).replace(/"/g, '""') + '"');
async function audit(db = prisma, { targetIds = TARGET_IDS, keepId = KEEP_ID, keepRevision = 7 } = {}) {
  const headers = await db.mBOMHeader.findMany({ where: { id: { in: [...targetIds, keepId] } }, orderBy: { revision: "asc" } });
  const keep = headers.find((row) => row.id === keepId);
  if (!keep || keep.isDeleted || keep.revision !== keepRevision) throw new Error("Expected retained BOM revision is missing");
  if (headers.some((row) => row.partId !== keep.partId)) throw new Error("Cross-part revision target rejected");
  const edges = await db.$queryRaw`
    SELECT s.relname AS "sourceTable", sa.attname AS "sourceColumn", t.relname AS "targetTable", ta.attname AS "targetColumn", c.confdeltype::text AS "deleteAction"
    FROM pg_constraint c JOIN pg_class s ON s.oid=c.conrelid JOIN pg_class t ON t.oid=c.confrelid
    JOIN pg_namespace ns ON ns.oid=s.relnamespace
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY sc(attnum, n) ON true
    JOIN LATERAL unnest(c.confkey) WITH ORDINALITY tc(attnum, n) ON tc.n=sc.n
    JOIN pg_attribute sa ON sa.attrelid=s.oid AND sa.attnum=sc.attnum
    JOIN pg_attribute ta ON ta.attrelid=t.oid AND ta.attnum=tc.attnum
    WHERE c.contype='f' AND ns.nspname=current_schema() AND t.relname IN (${Prisma.join(CORE)})`;
  // Also inspect planning references that have no database foreign key.
  const loose = await db.$queryRaw`SELECT table_name AS "sourceTable", column_name AS "sourceColumn"
    FROM information_schema.columns WHERE table_schema=current_schema()
    AND column_name IN ('mbom_header_id','mbom_id','mbom_detail_id','mbom_process_id','bom_detail_id','bom_process_id','approved_no_reg')`;
  for (const field of loose) {
    if (edges.some((edge) => edge.sourceTable === field.sourceTable && edge.sourceColumn === field.sourceColumn)) continue;
    const targetTable = field.sourceColumn.includes("detail") ? "tbl_mbomdetail" : field.sourceColumn.includes("process") ? "tbl_mbomprocess" : "tbl_mbomheader";
    edges.push({ ...field, targetTable, targetColumn: field.sourceColumn === "approved_no_reg" ? "no_reg" : "id", deleteAction: "NO_FK" });
  }
  const report = [];
  for (const header of headers.filter((row) => row.id !== keepId)) {
    const details = await db.mBOMDetail.findMany({ where: { noReg: header.noReg } });
    const processes = details.length ? await db.mBOMProcess.findMany({ where: { mbomDetailId: { in: details.map((row) => row.id) } } }) : [];
    const costs = await db.mBOMCostHeader.findMany({ where: { mbomId: header.id } });
    const costDetails = costs.length ? await db.mBOMCostDetail.findMany({ where: { mbomCostHeaderId: { in: costs.map((row) => row.id) } } }) : [];
    const own = { tbl_mbomheader: [header], tbl_mbomdetail: details, tbl_mbomprocess: processes, tbl_mbomcost_header: costs, tbl_mbomcost_detail: costDetails };
    const refs = [];
    for (const edge of edges) {
      const field = edge.targetColumn === "no_reg" ? "noReg" : edge.targetColumn;
      const values = [...new Set((own[edge.targetTable] || []).map((row) => row[field]).filter(Boolean))];
      if (!values.length) continue;
      const ownIds = (own[edge.sourceTable] || []).map((row) => row.id);
      const count = await db.$queryRaw(Prisma.sql`SELECT count(*)::int AS count FROM ${ident(edge.sourceTable)} WHERE ${ident(edge.sourceColumn)} IN (${Prisma.join(values)}) ${ownIds.length ? Prisma.sql`AND id NOT IN (${Prisma.join(ownIds)})` : Prisma.empty}`);
      if (count[0].count) refs.push({ ...edge, count: count[0].count });
    }
    report.push({ id: header.id, noReg: header.noReg, revision: header.revision, deleted: header.isDeleted, details: details.length, processes: processes.length, costs: costs.length, refs });
  }
  return { keep: { id: keep.id, noReg: keep.noReg, revision: keep.revision }, revisions: report };
}
module.exports = { audit, TARGET_IDS, KEEP_ID };
if (require.main === module) audit().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); process.exit(process.exitCode || 0); });
