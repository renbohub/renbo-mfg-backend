-- Standard operating roles for the ERP. Permissions are module-scoped so a
-- role can be broad within its business area without becoming a global admin.
WITH roles("role_code", "role_name", "description", "is_system") AS (
  VALUES
    ('SUPER_ADMIN', 'Super Admin', 'Akses penuh dan pengelola seluruh konfigurasi ERP.', true),
    ('MANAGEMENT', 'Management', 'Monitoring lintas modul, approval, dan laporan manajemen.', false),
    ('MASTER_DATA_ADMIN', 'Master Data Admin', 'Mengelola seluruh master data ERP.', false),
    ('SALES_ADMIN', 'Sales Admin', 'Administrasi customer, quotation, sales order, dan forecast.', false),
    ('PPIC_PLANNER', 'PPIC Planner', 'Perencanaan demand, MPS, MRP, dan production plan.', false),
    ('PPIC_SUPERVISOR', 'PPIC Supervisor', 'Supervisi dan approval proses PPIC.', false),
    ('PURCHASING_STAFF', 'Purchasing Staff', 'Administrasi PR, supplier, dan dokumen pembelian.', false),
    ('PURCHASING_MANAGER', 'Purchasing Manager', 'Supervisi, approval, dan kontrol pembelian.', false),
    ('PRODUCTION_ADMIN', 'Production Admin', 'Administrasi dokumen produksi dan referensi eksekusi.', false),
    ('PRODUCTION_SUPERVISOR', 'Production Supervisor', 'Supervisi dan approval eksekusi produksi.', false),
    ('PRODUCTION_OPERATOR', 'Production Operator', 'Input dan pembaruan aktivitas shop-floor.', false),
    ('QUALITY_INSPECTOR', 'Quality Inspector', 'Input dan penyelesaian pemeriksaan kualitas.', false),
    ('QUALITY_SUPERVISOR', 'Quality Supervisor', 'Supervisi dan approval pemeriksaan kualitas.', false),
    ('WAREHOUSE_ADMIN', 'Warehouse Admin', 'Administrasi gudang, stok, receipt, dan stock opname.', false),
    ('WAREHOUSE_OPERATOR', 'Warehouse Operator', 'Transaksi operasional gudang dan counting.', false),
    ('WAREHOUSE_SUPERVISOR', 'Warehouse Supervisor', 'Supervisi dan approval transaksi gudang.', false),
    ('DELIVERY_ADMIN', 'Delivery Admin', 'Administrasi jadwal, picking, packing, dan shipment.', false),
    ('ENGINEERING', 'Engineering', 'Engineering master, mBOM, routing, dan mesin.', false),
    ('MAINTENANCE', 'Maintenance', 'Pemeliharaan dies, mesin, dan aktivitas maintenance.', false),
    ('FINANCE', 'Finance', 'Kontrol invoice, payment, currency, dan laporan keuangan.', false),
    ('AUDITOR', 'Auditor', 'Akses baca dan export untuk audit lintas modul.', false)
)
INSERT INTO "tbl_roles" (
  "id", "role_code", "role_name", "description", "is_system", "is_active", "is_deleted",
  "created_by", "updated_by", "created_at", "updated_at"
)
SELECT gen_random_uuid()::text, role_code, role_name, description, is_system, true, false,
       'migration', 'migration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM roles
ON CONFLICT ("role_code") DO UPDATE SET
  "role_name" = EXCLUDED."role_name",
  "description" = EXCLUDED."description",
  "is_system" = EXCLUDED."is_system",
  "is_active" = true,
  "is_deleted" = false,
  "updated_by" = 'migration',
  "updated_at" = CURRENT_TIMESTAMP;

WITH permissions("role_code", "module_code", "page_code", "resource_code", "actions") AS (
  VALUES
    ('SUPER_ADMIN', '*', '*', '*', '["*"]'::jsonb),
    ('MANAGEMENT', '*', '*', '*', '["read","approve","submit","release","export"]'::jsonb),
    ('AUDITOR', '*', '*', '*', '["read","export"]'::jsonb),
    ('MASTER_DATA_ADMIN', 'master-data', '*', '*', '["read","create","update","delete","export"]'::jsonb),
    ('SALES_ADMIN', 'sales', '*', '*', '["read","create","update","delete","approve","submit","export"]'::jsonb),
    ('PPIC_PLANNER', 'planning-ppic', '*', '*', '["read","create","update","submit","export"]'::jsonb),
    ('PPIC_PLANNER', 'production', 'manufacturing-orders', 'manufacturingOrders', '["read"]'::jsonb),
    ('PPIC_PLANNER', 'purchasing', 'purchase-requisitions', 'purchaseRequisitions', '["read","create","update"]'::jsonb),
    ('PPIC_SUPERVISOR', 'planning-ppic', '*', '*', '["read","create","update","delete","approve","submit","release","export"]'::jsonb),
    ('PPIC_SUPERVISOR', 'production', '*', '*', '["read","approve","release","export"]'::jsonb),
    ('PURCHASING_STAFF', 'purchasing', '*', '*', '["read","create","update","submit","export"]'::jsonb),
    ('PURCHASING_MANAGER', 'purchasing', '*', '*', '["read","create","update","delete","approve","submit","release","export"]'::jsonb),
    ('PRODUCTION_ADMIN', 'production', '*', '*', '["read","create","update","delete","submit","export"]'::jsonb),
    ('PRODUCTION_SUPERVISOR', 'production', '*', '*', '["read","create","update","delete","approve","submit","release","export"]'::jsonb),
    ('PRODUCTION_OPERATOR', 'production', '*', '*', '["read","create","update","submit"]'::jsonb),
    ('QUALITY_INSPECTOR', 'production', 'quality-inspections', 'qualityInspections', '["read","create","update","submit"]'::jsonb),
    ('QUALITY_SUPERVISOR', 'production', 'quality-inspections', 'qualityInspections', '["read","create","update","delete","approve","submit","export"]'::jsonb),
    ('WAREHOUSE_ADMIN', 'inventory', '*', '*', '["read","create","update","delete","approve","submit","export"]'::jsonb),
    ('WAREHOUSE_ADMIN', 'incoming', '*', '*', '["read","create","update","delete","approve","submit","export"]'::jsonb),
    ('WAREHOUSE_OPERATOR', 'inventory', '*', '*', '["read","create","update","submit"]'::jsonb),
    ('WAREHOUSE_OPERATOR', 'incoming', '*', '*', '["read","create","update","submit"]'::jsonb),
    ('WAREHOUSE_SUPERVISOR', 'inventory', '*', '*', '["read","create","update","delete","approve","submit","export"]'::jsonb),
    ('WAREHOUSE_SUPERVISOR', 'incoming', '*', '*', '["read","create","update","delete","approve","submit","export"]'::jsonb),
    ('DELIVERY_ADMIN', 'outgoing', '*', '*', '["read","create","update","delete","submit","export"]'::jsonb),
    ('ENGINEERING', 'manufacturing-bom', '*', '*', '["read","create","update","delete","approve","submit","export"]'::jsonb),
    ('ENGINEERING', 'master-data', '*', '*', '["read","create","update","delete","export"]'::jsonb),
    ('MAINTENANCE', 'master-data', 'dies-maintenance', 'dies-maintenance', '["read","create","update","delete","submit","export"]'::jsonb),
    ('MAINTENANCE', 'master-data', 'dies-usage', 'dies-usage', '["read","create","update","delete","submit","export"]'::jsonb),
    ('MAINTENANCE', 'master-data', 'machines', 'machines', '["read","create","update","delete","export"]'::jsonb),
    ('FINANCE', 'purchasing', 'purchase-invoices', 'purchaseInvoices', '["read","create","update","delete","approve","submit","export"]'::jsonb),
    ('FINANCE', 'master-data', 'currencies', 'currencies', '["read","create","update","delete","export"]'::jsonb),
    ('FINANCE', 'master-data', 'payment-terms', 'paymentTerm', '["read","create","update","delete","export"]'::jsonb),
    ('FINANCE', 'system', 'approvals', 'approvals', '["read","approve","export"]'::jsonb)
)
INSERT INTO "tbl_role_permissions" (
  "id", "role_id", "module_code", "page_code", "resource_code", "actions",
  "is_active", "is_deleted", "created_by", "updated_by", "created_at", "updated_at"
)
SELECT gen_random_uuid()::text, role."id", p.module_code, p.page_code, p.resource_code, p.actions,
       true, false, 'migration', 'migration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM permissions p
JOIN "tbl_roles" role ON role."role_code" = p.role_code
ON CONFLICT ("role_id", "module_code", "page_code") DO UPDATE SET
  "resource_code" = EXCLUDED."resource_code",
  "actions" = EXCLUDED."actions",
  "is_active" = true,
  "is_deleted" = false,
  "updated_by" = 'migration',
  "updated_at" = CURRENT_TIMESTAMP;
