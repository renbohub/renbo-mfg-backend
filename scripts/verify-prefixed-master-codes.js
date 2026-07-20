const path = require('path')
require('dotenv').config({
  path: path.resolve(__dirname, '../.env'),
  override: true,
})

const { prisma, disconnectDatabase } = require('../src/prisma')

const NUMERIC_ONLY = '^[0-9]+$'

const checks = [
  {
    label: 'Customers (master)',
    table: 'tbl_customer',
    column: 'customer_code',
    sampleOrder: 'customer_code',
  },
  {
    label: 'Suppliers (master)',
    table: 'tbl_supplier',
    column: 'supplier_code',
    sampleOrder: 'supplier_code',
  },
  {
    label: 'Vendors (master)',
    table: 'tbl_vendor',
    column: 'vendor_code',
    sampleOrder: 'vendor_code',
  },
  {
    label: 'Parts.customer_code',
    table: 'tbl_part',
    column: 'customer_code',
    sampleOrder: 'part_code',
  },
  {
    label: 'Parts.customer_codes[]',
    table: 'tbl_part',
    column: 'customer_codes',
    isArray: true,
    sampleOrder: 'part_code',
  },
  {
    label: 'Dies.customer_code',
    table: 'tbl_dies',
    column: 'customer_code',
    sampleOrder: 'dies_code',
  },
  {
    label: 'Forecast.customer_code',
    table: 'tbl_forecast',
    column: 'customer_code',
    sampleOrder: 'forecast_number',
  },
  {
    label: 'MPS Detail.customer_code',
    table: 'tbl_mps_detail',
    column: 'customer_code',
    sampleOrder: 'mps_number, line_number',
  },
  {
    label: 'Planned Order.supplier_code',
    table: 'tbl_planned_order',
    column: 'supplier_code',
    sampleOrder: 'order_number',
  },
  {
    label: 'Planned Order.vendor_code',
    table: 'tbl_planned_order',
    column: 'vendor_code',
    sampleOrder: 'order_number',
  },
  {
    label: 'PR Detail.preferred_supplier',
    table: 'tbl_purchase_requisition_detail',
    column: 'preferred_supplier',
    sampleOrder: 'pr_number, line_number',
  },
  {
    label: 'PR Detail.preferred_vendor',
    table: 'tbl_purchase_requisition_detail',
    column: 'preferred_vendor',
    sampleOrder: 'pr_number, line_number',
  },
  {
    label: 'Dies Maintenance.vendor_code',
    table: 'tbl_dies_maintenance',
    column: 'vendor_code',
    sampleOrder: 'maintenance_number',
  },
  {
    label: 'Vendor Process Order.vendor_code',
    table: 'tbl_vendor_process_order',
    column: 'vendor_code',
    sampleOrder: 'order_number',
  },
]

async function countMaster(prefix, table, column) {
  const result = await prisma.$queryRawUnsafe(
    `
      SELECT
        COUNT(*) FILTER (WHERE ${column} ~ $1)::integer AS prefixed_count,
        COUNT(*) FILTER (WHERE ${column} ~ $2)::integer AS numeric_count,
        COUNT(*)::integer AS total_count
      FROM ${table}
    `,
    `^${prefix}[0-9]+$`,
    NUMERIC_ONLY,
  )

  return result[0]
}

async function runCheck(check) {
  if (check.isArray) {
    const rows = await prisma.$queryRawUnsafe(
      `
        SELECT
          COUNT(DISTINCT p.part_code)::integer AS remaining_count,
          ARRAY(
            SELECT DISTINCT p.part_code
            FROM ${check.table} p
            CROSS JOIN LATERAL unnest(p.${check.column}) AS code
            WHERE code ~ $1
            ORDER BY p.part_code
            LIMIT 10
          ) AS samples
        FROM ${check.table} p
        CROSS JOIN LATERAL unnest(p.${check.column}) AS code
        WHERE code ~ $1
      `,
      NUMERIC_ONLY,
    )

    return {
      label: check.label,
      remainingCount: rows[0]?.remaining_count || 0,
      samples: rows[0]?.samples || [],
    }
  }

  const rows = await prisma.$queryRawUnsafe(
    `
      SELECT
        COUNT(*)::integer AS remaining_count,
        ARRAY(
          SELECT ${check.sampleOrder.split(',')[0].trim()}
          FROM ${check.table}
          WHERE ${check.column} ~ $1
          ORDER BY ${check.sampleOrder}
          LIMIT 10
        ) AS samples
      FROM ${check.table}
      WHERE ${check.column} ~ $1
    `,
    NUMERIC_ONLY,
  )

  return {
    label: check.label,
    remainingCount: rows[0]?.remaining_count || 0,
    samples: rows[0]?.samples || [],
  }
}

async function main() {
  const [customerMaster, supplierMaster, vendorMaster, checkResults] = await Promise.all([
    countMaster('C', 'tbl_customer', 'customer_code'),
    countMaster('S', 'tbl_supplier', 'supplier_code'),
    countMaster('V', 'tbl_vendor', 'vendor_code'),
    Promise.all(checks.map(runCheck)),
  ])

  console.log('Master code prefix verification')
  console.log('')
  console.log(
    `Customers: total=${customerMaster.total_count}, prefixed=${customerMaster.prefixed_count}, numeric_left=${customerMaster.numeric_count}`,
  )
  console.log(
    `Suppliers: total=${supplierMaster.total_count}, prefixed=${supplierMaster.prefixed_count}, numeric_left=${supplierMaster.numeric_count}`,
  )
  console.log(
    `Vendors: total=${vendorMaster.total_count}, prefixed=${vendorMaster.prefixed_count}, numeric_left=${vendorMaster.numeric_count}`,
  )
  console.log('')

  const unresolved = checkResults.filter(result => result.remainingCount > 0)

  if (unresolved.length === 0) {
    console.log('No remaining numeric legacy codes found in checked tables.')
    return
  }

  console.log('Remaining numeric legacy codes:')
  unresolved.forEach((result) => {
    const sampleText = result.samples.length > 0
      ? ` | samples: ${result.samples.join(', ')}`
      : ''
    console.log(`- ${result.label}: ${result.remainingCount}${sampleText}`)
  })
}

main()
  .catch((error) => {
    console.error('Verification failed:')
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await disconnectDatabase()
  })
