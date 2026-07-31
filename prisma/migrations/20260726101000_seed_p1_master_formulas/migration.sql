INSERT INTO "tbl_master_formulas" (
  "id", "formula_code", "formula_name", "module_code", "formula_key",
  "expression", "variables", "description", "version",
  "is_active", "is_deleted", "created_at", "updated_at"
)
VALUES
  (
    gen_random_uuid()::text, 'CAPACITY-BASE-MINUTES', 'Capacity Base Minutes',
    'capacity', 'CAPACITY_BASE_MINUTES',
    '(shiftHours * shiftsPerDay * 60 + overtimeMinutes) * efficiencyPercent / 100',
    '{"shiftHours":"number","shiftsPerDay":"number","overtimeMinutes":"number","efficiencyPercent":"number"}'::jsonb,
    'Kapasitas dasar mesin per tanggal berdasarkan shift, lembur, dan efisiensi.', 1,
    true, false, NOW(), NOW()
  ),
  (
    gen_random_uuid()::text, 'CAPACITY-AVAILABLE-MINUTES', 'Capacity Available Minutes',
    'capacity', 'CAPACITY_AVAILABLE_MINUTES',
    'max(baseAvailableMinutes - downtimeMinutes, 0)',
    '{"baseAvailableMinutes":"number","downtimeMinutes":"number"}'::jsonb,
    'Kapasitas bersih setelah downtime.', 1,
    true, false, NOW(), NOW()
  ),
  (
    gen_random_uuid()::text, 'CAPACITY-UTILIZATION-PERCENT', 'Capacity Utilization Percent',
    'capacity', 'CAPACITY_UTILIZATION_PERCENT',
    'loadMinutes / max(availableMinutes, 0.000001) * 100',
    '{"loadMinutes":"number","availableMinutes":"number"}'::jsonb,
    'Persentase utilisasi mesin.', 1,
    true, false, NOW(), NOW()
  ),
  (
    gen_random_uuid()::text, 'PURCHASING-PR-LINE-TOTAL', 'PR Line Total',
    'purchasing', 'PR_LINE_TOTAL',
    'qty * estimatedPrice',
    '{"qty":"number","estimatedPrice":"number"}'::jsonb,
    'Estimasi nilai per baris Purchase Requisition.', 1,
    true, false, NOW(), NOW()
  ),
  (
    gen_random_uuid()::text, 'INVENTORY-AVAILABLE-QTY', 'Inventory Available Qty',
    'inventory', 'INVENTORY_AVAILABLE_QTY',
    'max(qtyOnHand - qtyReserved - qtyQC, 0)',
    '{"qtyOnHand":"number","qtyReserved":"number","qtyQC":"number"}'::jsonb,
    'Saldo tersedia setelah reservation dan quality hold.', 1,
    true, false, NOW(), NOW()
  ),
  (
    gen_random_uuid()::text, 'PRODUCTION-ALLOCATED-QTY', 'Production Allocated Qty',
    'production', 'PRODUCTION_ALLOCATED_QTY',
    'qtyGood + qtyReject',
    '{"qtyGood":"number","qtyReject":"number"}'::jsonb,
    'Total hasil produksi yang dialokasikan ke good dan reject.', 1,
    true, false, NOW(), NOW()
  )
ON CONFLICT ("formula_code") DO NOTHING;
