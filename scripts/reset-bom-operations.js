#!/usr/bin/env node

const { prisma } = require("../src/prisma");

const CONFIRMATION = "RESET_BOM_PRODUCTION_STOCK";
const targetTables = [
  "tbl_quality_inspection_detail", "tbl_quality_inspection", "tbl_material_issue_detail",
  "tbl_material_issue", "tbl_production_log", "tbl_downtime_log", "tbl_wip_entry",
  "tbl_daily_production_schedule", "tbl_manufacturing_order_source_wip", "tbl_work_order",
  "tbl_manufacturing_order", "tbl_mrp_pegging", "tbl_mrp_partial_snapshot",
  "tbl_mrp_dirty_item", "tbl_mrp_requirement", "tbl_planned_order", "tbl_mrp_run",
  "tbl_mps_detail", "tbl_mps", "tbl_bom_relation", "tbl_item_level",
  "tbl_mbomcost_detail", "tbl_mbomcost_header", "tbl_mbomprocess", "tbl_mbomdetail",
  "tbl_mbomheader", "tbl_stock_reservation", "tbl_sto_details", "tbl_sto_headers",
  "tbl_stock_movement", "tbl_stock_balance", "tbl_lot_master",
];

const numberingRules = [
  "MBOM", "MANUFACTURING_ORDER", "WORK_ORDER", "LOT", "STOCK_MOVEMENT",
  "MATERIAL_ISSUE", "PRODUCTION_LOG", "QUALITY_INSPECTION", "WIP",
  "DAILY_PRODUCTION_SCHEDULE", "PLANNED_ORDER",
];

function assertSafeIdentifier(value) {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) throw new Error(`Identifier tidak aman: ${value}`);
}

async function getCounts(db) {
  const result = {};
  for (const table of targetTables) {
    assertSafeIdentifier(table);
    const rows = await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM "${table}"`);
    result[table] = rows[0]?.count || 0;
  }
  return result;
}

async function main() {
  if (process.argv[2] !== "--confirm" || process.argv[3] !== CONFIRMATION) {
    const counts = await getCounts(prisma);
    process.stdout.write(`${JSON.stringify({ dryRun: true, requiredCommand: `node scripts/reset-bom-operations.js --confirm ${CONFIRMATION}`, counts }, null, 2)}\n`);
    return;
  }

  const before = await getCounts(prisma);
  const result = await prisma.$transaction(async (tx) => {
    const detachedSalesOrders = await tx.$executeRawUnsafe('UPDATE "tbl_salesorderdetail" SET "mbom_header_id" = NULL WHERE "mbom_header_id" IS NOT NULL');
    const detachedQuotations = await tx.$executeRawUnsafe('UPDATE "tbl_quotationdetail" SET "mbom_header_id" = NULL WHERE "mbom_header_id" IS NOT NULL');

    for (const table of targetTables) {
      assertSafeIdentifier(table);
      await tx.$executeRawUnsafe(`DELETE FROM "${table}"`);
    }

    const resetRules = await tx.$executeRawUnsafe(
      'UPDATE "tbl_numbering_rules" SET "next_number" = 1, "last_reset_key" = NULL, "updated_at" = CURRENT_TIMESTAMP WHERE "rule_key" = ANY($1::text[])',
      numberingRules,
    );
    return { detachedSalesOrders, detachedQuotations, resetRules };
  }, { isolationLevel: "Serializable", timeout: 120000 });

  const after = await getCounts(prisma);
  process.stdout.write(`${JSON.stringify({ ok: true, confirmation: CONFIRMATION, before, after, ...result }, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
