#!/usr/bin/env node

const { prisma } = require("../src/prisma");

const TABLE_FILTERS = [
  "%mbom%", "%stock%", "%manufacturing_order%", "%work_order%", "%lot%",
  "%mrp%", "%mps%", "%planned_order%", "%material_issue%", "%production_log%",
  "%quality_inspection%", "%wip%", "%daily_production%", "%bom_relation%", "%item_level%",
  "%sto%",
];

async function main() {
  const filters = TABLE_FILTERS.map((_value, index) => `table_name LIKE $${index + 1}`).join(" OR ");
  const tables = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND (${filters}) ORDER BY table_name`,
    ...TABLE_FILTERS,
  );
  const counts = [];
  for (const { table_name: tableName } of tables) {
    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) throw new Error(`Nama tabel tidak aman: ${tableName}`);
    const result = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM "${tableName}"`);
    counts.push({ table: tableName, count: result[0]?.count || 0 });
  }

  const foreignKeys = await prisma.$queryRawUnsafe(`
    SELECT
      tc.table_name AS source_table,
      kcu.column_name AS source_column,
      ccu.table_name AS target_table,
      ccu.column_name AS target_column,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND (
        ccu.table_name LIKE 'tbl_mbom%'
        OR ccu.table_name LIKE 'tbl_mrp%'
        OR ccu.table_name LIKE 'tbl_mps%'
        OR ccu.table_name IN (
          'tbl_manufacturing_order', 'tbl_work_order', 'tbl_stock_balance',
          'tbl_stock_movement', 'tbl_stock_reservation', 'tbl_lot_master',
          'tbl_planned_order', 'tbl_sto_details'
        )
      )
    ORDER BY ccu.table_name, tc.table_name, kcu.column_name
  `);

  const countedTables = new Set(counts.map((item) => item.table));
  const dependentCounts = [];
  for (const tableName of [...new Set(foreignKeys.map((item) => item.source_table))].filter((name) => !countedTables.has(name))) {
    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) throw new Error(`Nama tabel tidak aman: ${tableName}`);
    const result = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM "${tableName}"`);
    dependentCounts.push({ table: tableName, count: result[0]?.count || 0 });
  }

  process.stdout.write(`${JSON.stringify({ counts, dependentCounts, foreignKeys }, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
