-- CreateEnum
CREATE TYPE "Status" AS ENUM ('Draft', 'Pending', 'Approved', 'Rejected', 'Active', 'Inactive', 'Obsolete');

-- CreateEnum
CREATE TYPE "Category" AS ENUM ('inHouse', 'Purchase', 'Vendor');

-- CreateEnum
CREATE TYPE "BomCostType" AS ENUM ('Material', 'Process', 'Overhead');

-- CreateEnum
CREATE TYPE "DiesStatus" AS ENUM ('Active', 'Maintenance', 'Retired', 'Scrapped', 'Reserved');

-- CreateEnum
CREATE TYPE "DiesOwnerType" AS ENUM ('Mitsutoyo', 'Customer');

-- CreateTable
CREATE TABLE "tbl_users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT,
    "is_super_admin" BOOLEAN NOT NULL DEFAULT false,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "list_menu" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_logs" (
    "id" TEXT NOT NULL,
    "name_route" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response_time" INTEGER,
    "user_id" TEXT,
    "username" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "entity_id" TEXT,
    "request_params" JSONB,
    "changes" JSONB,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tbl_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_uom" (
    "id" TEXT NOT NULL,
    "uom_code" TEXT NOT NULL,
    "uom_name" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_uom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_currency" (
    "id" TEXT NOT NULL,
    "currency_code" TEXT NOT NULL,
    "currency_name" TEXT,
    "symbol" TEXT,
    "exchange_rate" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_currency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_customer" (
    "id" TEXT NOT NULL,
    "customer_code" TEXT NOT NULL,
    "customer_name" TEXT,
    "contact" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "billing_address" TEXT,
    "shipping_address" TEXT,
    "currency_code" TEXT,
    "payment_terms" TEXT,
    "tax_id" TEXT,
    "notes" TEXT,
    "status" TEXT,
    "customer_classification" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_supplier" (
    "id" TEXT NOT NULL,
    "supplier_code" TEXT NOT NULL,
    "supplier_name" TEXT,
    "contact" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "billing_address" TEXT,
    "shipping_address" TEXT,
    "lead_time_days" INTEGER,
    "tax_id" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "users" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_vendor" (
    "id" TEXT NOT NULL,
    "vendor_code" TEXT NOT NULL,
    "vendor_name" TEXT,
    "contact" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "billing_address" TEXT,
    "shipping_address" TEXT,
    "lead_time_days" INTEGER,
    "tax_id" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "users" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_vendor_process" (
    "id" TEXT NOT NULL,
    "vendor_process_code" TEXT NOT NULL,
    "vendor_process_name" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_vendor_process_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_entity_vendorprocess" (
    "id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "vendor_id" TEXT,
    "supplier_id" TEXT,
    "price_list_id" TEXT,
    "vendor_process_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tbl_entity_vendorprocess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_part" (
    "id" TEXT NOT NULL,
    "part_code" TEXT NOT NULL,
    "part_no" TEXT,
    "part_name" TEXT,
    "customer_code" TEXT,
    "customer_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "category" TEXT,
    "status" TEXT DEFAULT 'Active',
    "status_service" TEXT,
    "material_id" TEXT,
    "supplier_id" TEXT,
    "photos" JSONB,
    "no_php" TEXT,
    "status_php" TEXT,
    "pcs_per_box" DOUBLE PRECISION,
    "kg_per_box" DOUBLE PRECISION,
    "packing_plastic" TEXT,
    "pcs_per_plastic" DOUBLE PRECISION,
    "kg_per_plastic" DOUBLE PRECISION,
    "qty_plastic_per_box" DOUBLE PRECISION,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_part_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_dies" (
    "id" TEXT NOT NULL,
    "dies_code" TEXT NOT NULL,
    "dies_number" TEXT,
    "dies_name" TEXT,
    "owner_type" "DiesOwnerType" NOT NULL DEFAULT 'Mitsutoyo',
    "customer_code" TEXT,
    "category" TEXT,
    "status" "DiesStatus" NOT NULL DEFAULT 'Active',
    "location" TEXT,
    "warehouse_code" TEXT,
    "shot_counter" INTEGER NOT NULL DEFAULT 0,
    "max_shot_lifetime" INTEGER,
    "purchase_date" TIMESTAMP(3),
    "purchase_cost" DOUBLE PRECISION,
    "currency_code" TEXT DEFAULT 'IDR',
    "depreciation_rate" DOUBLE PRECISION,
    "last_maintenance_date" TIMESTAMP(3),
    "next_maintenance_date" TIMESTAMP(3),
    "maintenance_interval" INTEGER,
    "cavity" INTEGER,
    "tonnage" DOUBLE PRECISION,
    "cycle_time" DOUBLE PRECISION,
    "photos" JSONB,
    "drawings" JSONB,
    "specs" JSONB,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_dies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_dies_part" (
    "id" TEXT NOT NULL,
    "dies_id" TEXT NOT NULL,
    "part_id" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "effective_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiry_date" TIMESTAMP(3),
    "expected_output" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_dies_part_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_dies_maintenance" (
    "id" TEXT NOT NULL,
    "dies_id" TEXT NOT NULL,
    "maintenance_number" TEXT NOT NULL,
    "maintenance_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "maintenance_type" TEXT NOT NULL,
    "shot_counter_before" INTEGER,
    "status_before" TEXT,
    "work_description" TEXT,
    "parts_replaced" TEXT,
    "shot_counter_reset" BOOLEAN NOT NULL DEFAULT false,
    "status_after" TEXT,
    "performed_by" TEXT,
    "vendor_code" TEXT,
    "cost" DOUBLE PRECISION DEFAULT 0,
    "currency_code" TEXT DEFAULT 'IDR',
    "start_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "downtime" DOUBLE PRECISION,
    "next_maintenance_date" TIMESTAMP(3),
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_dies_maintenance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_dies_usage" (
    "id" TEXT NOT NULL,
    "dies_id" TEXT NOT NULL,
    "part_id" TEXT,
    "usage_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reference_type" TEXT,
    "reference_number" TEXT,
    "shot_count" INTEGER NOT NULL DEFAULT 0,
    "qty_produced" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_good" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_reject" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "machine_code" TEXT,
    "operator_name" TEXT,
    "shift" TEXT,
    "start_time" TIMESTAMP(3),
    "end_time" TIMESTAMP(3),
    "running_minutes" DOUBLE PRECISION,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_dies_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_machine" (
    "id" TEXT NOT NULL,
    "machine_code" TEXT NOT NULL,
    "machine_name" TEXT,
    "machine_type" TEXT,
    "brand" TEXT,
    "model_number" TEXT,
    "serial_number" TEXT,
    "capacity" DOUBLE PRECISION,
    "capacity_unit" TEXT,
    "tonnage" DOUBLE PRECISION,
    "power_kw" DOUBLE PRECISION,
    "voltage" DOUBLE PRECISION,
    "cycle_time" DOUBLE PRECISION,
    "location" TEXT,
    "warehouse_code" TEXT,
    "line_code" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "purchase_date" TIMESTAMP(3),
    "purchase_cost" DOUBLE PRECISION,
    "currency_code" TEXT DEFAULT 'IDR',
    "depreciation_rate" DOUBLE PRECISION,
    "last_maintenance_date" TIMESTAMP(3),
    "next_maintenance_date" TIMESTAMP(3),
    "maintenance_interval" INTEGER,
    "photos" JSONB,
    "drawings" JSONB,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_machine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_part_base" (
    "id" TEXT NOT NULL,
    "part_id" TEXT NOT NULL,
    "base_on" TEXT NOT NULL,
    "CSP" TEXT,
    "thickness" DOUBLE PRECISION,
    "width" DOUBLE PRECISION,
    "length" DOUBLE PRECISION,
    "cavity" INTEGER,
    "net_weight" DOUBLE PRECISION,
    "scrap_weight" DOUBLE PRECISION,
    "gross_weight" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_part_base_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_part_attachment" (
    "id" TEXT NOT NULL,
    "part_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "files" JSONB NOT NULL,
    "description" TEXT,
    "uploaded_by" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_part_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_material" (
    "id" TEXT NOT NULL,
    "material_code" TEXT NOT NULL,
    "material_type" TEXT,
    "spec" TEXT,
    "density" DOUBLE PRECISION,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_process" (
    "id" TEXT NOT NULL,
    "process_code" TEXT NOT NULL,
    "process_name" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_process_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_subprocess" (
    "id" TEXT NOT NULL,
    "sub_process_code" TEXT NOT NULL,
    "sub_process_name" TEXT,
    "process_id" TEXT NOT NULL,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_subprocess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_paymentterm" (
    "id" TEXT NOT NULL,
    "term_code" TEXT NOT NULL,
    "description" TEXT,
    "days" INTEGER NOT NULL DEFAULT 0,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_paymentterm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_vendor_pricelist" (
    "id" TEXT NOT NULL,
    "vendor_id" TEXT,
    "part_id" TEXT,
    "customer_id" TEXT,
    "category" TEXT NOT NULL,
    "quotation_files" JSONB,
    "currency_code" TEXT NOT NULL DEFAULT 'IDR',
    "pricing_year" INTEGER,
    "january" DOUBLE PRECISION,
    "february" DOUBLE PRECISION,
    "march" DOUBLE PRECISION,
    "april" DOUBLE PRECISION,
    "may" DOUBLE PRECISION,
    "june" DOUBLE PRECISION,
    "july" DOUBLE PRECISION,
    "august" DOUBLE PRECISION,
    "september" DOUBLE PRECISION,
    "october" DOUBLE PRECISION,
    "november" DOUBLE PRECISION,
    "december" DOUBLE PRECISION,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_vendor_pricelist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_part_pricelist" (
    "id" TEXT NOT NULL,
    "part_id" TEXT,
    "currency_code" TEXT NOT NULL DEFAULT 'IDR',
    "pricing_year" INTEGER,
    "january" DOUBLE PRECISION,
    "february" DOUBLE PRECISION,
    "march" DOUBLE PRECISION,
    "april" DOUBLE PRECISION,
    "may" DOUBLE PRECISION,
    "june" DOUBLE PRECISION,
    "july" DOUBLE PRECISION,
    "august" DOUBLE PRECISION,
    "september" DOUBLE PRECISION,
    "october" DOUBLE PRECISION,
    "november" DOUBLE PRECISION,
    "december" DOUBLE PRECISION,
    "status_service" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_part_pricelist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_material_pricelist" (
    "id" TEXT NOT NULL,
    "material_id" TEXT,
    "supplier_id" TEXT,
    "currency_code" TEXT NOT NULL DEFAULT 'IDR',
    "pricing_year" INTEGER,
    "january" DOUBLE PRECISION,
    "february" DOUBLE PRECISION,
    "march" DOUBLE PRECISION,
    "april" DOUBLE PRECISION,
    "may" DOUBLE PRECISION,
    "june" DOUBLE PRECISION,
    "july" DOUBLE PRECISION,
    "august" DOUBLE PRECISION,
    "september" DOUBLE PRECISION,
    "october" DOUBLE PRECISION,
    "november" DOUBLE PRECISION,
    "december" DOUBLE PRECISION,
    "CSP" TEXT,
    "thickness" DOUBLE PRECISION,
    "part_number_cp" TEXT,
    "part_name_cp" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_material_pricelist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_department" (
    "id" TEXT NOT NULL,
    "department_code" TEXT NOT NULL,
    "department_name" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_division" (
    "id" TEXT NOT NULL,
    "division_code" TEXT NOT NULL,
    "division_name" TEXT,
    "department_id" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_division_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_employee" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "full_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "position" TEXT,
    "department_id" TEXT,
    "division_id" TEXT,
    "hire_date" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'Active',
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_product" (
    "id" TEXT NOT NULL,
    "product_code" TEXT NOT NULL,
    "product_name" TEXT,
    "description" TEXT,
    "uom_code" TEXT,
    "category" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_product_pricelist" (
    "id" TEXT NOT NULL,
    "product_id" TEXT,
    "supplier_id" TEXT,
    "currency_code" TEXT NOT NULL DEFAULT 'IDR',
    "pricing_year" INTEGER,
    "january" DOUBLE PRECISION,
    "february" DOUBLE PRECISION,
    "march" DOUBLE PRECISION,
    "april" DOUBLE PRECISION,
    "may" DOUBLE PRECISION,
    "june" DOUBLE PRECISION,
    "july" DOUBLE PRECISION,
    "august" DOUBLE PRECISION,
    "september" DOUBLE PRECISION,
    "october" DOUBLE PRECISION,
    "november" DOUBLE PRECISION,
    "december" DOUBLE PRECISION,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_product_pricelist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_ebomheader" (
    "id" TEXT NOT NULL,
    "no_reg" TEXT NOT NULL,
    "part_id" TEXT,
    "uom_code" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "ecn_number" TEXT,
    "status" "Status" NOT NULL DEFAULT 'Draft',
    "effective_date" TIMESTAMP(3),
    "expiry_date" TIMESTAMP(3),
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_by" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_ebomheader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_ebomdetail" (
    "id" TEXT NOT NULL,
    "no_reg" TEXT NOT NULL,
    "level_component" INTEGER NOT NULL DEFAULT 0,
    "part_id" TEXT,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "uom_code" TEXT,
    "category" "Category" NOT NULL DEFAULT 'Purchase',
    "scrap_factor" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "find_number" TEXT,
    "reference_designator" TEXT,
    "created_by" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_ebomdetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_ebomprocess" (
    "id" TEXT NOT NULL,
    "no_reg" TEXT NOT NULL,
    "ebom_detail_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "process_id" TEXT,
    "sub_process_id" TEXT,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "cycle_time" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "machine" TEXT,
    "work_center" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_ebomprocess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_ebomcost_header" (
    "id" TEXT NOT NULL,
    "ebom_id" TEXT NOT NULL,
    "cost_version" INTEGER NOT NULL DEFAULT 1,
    "qty_base" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "currency_code" TEXT NOT NULL,
    "cost_model" TEXT,
    "material_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "process_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "overhead_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cost_per_unit" DOUBLE PRECISION,
    "status" "Status" NOT NULL DEFAULT 'Draft',
    "is_standard" BOOLEAN NOT NULL DEFAULT false,
    "valid_from" TIMESTAMP(3),
    "valid_to" TIMESTAMP(3),
    "notes" TEXT,
    "created_by" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_ebomcost_header_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_ebomcost_detail" (
    "id" TEXT NOT NULL,
    "ebom_cost_header_id" TEXT NOT NULL,
    "type" "BomCostType" NOT NULL DEFAULT 'Material',
    "ebom_detail_id" TEXT,
    "ebom_process_id" TEXT,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_ebomcost_detail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_mbomheader" (
    "id" TEXT NOT NULL,
    "no_reg" TEXT NOT NULL,
    "part_id" TEXT,
    "uom_code" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "effective_date" TIMESTAMP(3),
    "expiry_date" TIMESTAMP(3),
    "created_by" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_mbomheader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_mbomdetail" (
    "id" TEXT NOT NULL,
    "no_reg" TEXT NOT NULL,
    "level_component" INTEGER NOT NULL DEFAULT 0,
    "part_id" TEXT,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "uom_code" TEXT,
    "category" "Category" NOT NULL DEFAULT 'Purchase',
    "scrap_factor" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lead_time" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_mbomdetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_mbomprocess" (
    "id" TEXT NOT NULL,
    "no_reg" TEXT NOT NULL,
    "bom_detail_id" TEXT NOT NULL,
    "process_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "cycle_time" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "machine" TEXT,
    "work_center" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_mbomprocess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_mbomcost_header" (
    "id" TEXT NOT NULL,
    "mbom_id" TEXT NOT NULL,
    "cost_version" INTEGER NOT NULL DEFAULT 1,
    "qty_base" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "currency_code" TEXT NOT NULL,
    "cost_model" TEXT,
    "material_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "process_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "overhead_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cost_per_unit" DOUBLE PRECISION,
    "status" "Status" NOT NULL DEFAULT 'Draft',
    "is_standard" BOOLEAN NOT NULL DEFAULT false,
    "valid_from" TIMESTAMP(3),
    "valid_to" TIMESTAMP(3),
    "notes" TEXT,
    "created_by" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_mbomcost_header_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_mbomcost_detail" (
    "id" TEXT NOT NULL,
    "mbom_cost_header_id" TEXT NOT NULL,
    "type" "BomCostType" NOT NULL DEFAULT 'Material',
    "mbom_detail_id" TEXT,
    "mbom_process_id" TEXT,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_mbomcost_detail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_quotationheader" (
    "id" TEXT NOT NULL,
    "quotation_number" TEXT NOT NULL,
    "quotation_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customer_code" TEXT,
    "customer_name" TEXT,
    "contact" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "billing_address" TEXT,
    "shipping_address" TEXT,
    "payment_terms" TEXT,
    "tax_id" TEXT,
    "currency_code" TEXT NOT NULL DEFAULT 'IDR',
    "valid_until" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "total_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "converted_to_so" TEXT,
    "notes" TEXT,
    "created_by" TEXT,
    "approved_by" TEXT,
    "approved_date" TIMESTAMP(3),
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_quotationheader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_quotationdetail" (
    "id" TEXT NOT NULL,
    "quotation_number" TEXT NOT NULL,
    "line_number" INTEGER NOT NULL,
    "part_code" TEXT,
    "part_number" TEXT,
    "part_name" TEXT,
    "uom_code" TEXT,
    "mbom_header_id" TEXT,
    "qty" DOUBLE PRECISION NOT NULL,
    "unit_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discount_type" TEXT NOT NULL DEFAULT 'percent',
    "tax" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "delivery_date" TIMESTAMP(3),
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_quotationdetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_salesorderheader" (
    "id" TEXT NOT NULL,
    "so_number" TEXT NOT NULL,
    "so_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quotation_number" TEXT,
    "customer_code" TEXT,
    "customer_name" TEXT,
    "contact" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "billing_address" TEXT,
    "shipping_address" TEXT,
    "payment_terms" TEXT,
    "tax_id" TEXT,
    "currency_code" TEXT NOT NULL DEFAULT 'IDR',
    "delivery_date" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "total_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_by" TEXT,
    "approved_by" TEXT,
    "approved_date" TIMESTAMP(3),
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_salesorderheader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_salesorderdetail" (
    "id" TEXT NOT NULL,
    "so_number" TEXT NOT NULL,
    "line_number" INTEGER NOT NULL,
    "part_code" TEXT,
    "part_number" TEXT,
    "part_name" TEXT,
    "uom_code" TEXT,
    "mbom_header_id" TEXT,
    "qty" DOUBLE PRECISION NOT NULL,
    "unit_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discount_type" TEXT NOT NULL DEFAULT 'percent',
    "tax" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_produced" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_delivered" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "delivery_date" TIMESTAMP(3),
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_salesorderdetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_salesorder_attachment" (
    "id" TEXT NOT NULL,
    "so_number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "files" JSONB NOT NULL,
    "description" TEXT,
    "uploaded_by" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_salesorder_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_delivery_schedule" (
    "id" TEXT NOT NULL,
    "schedule_number" TEXT NOT NULL,
    "so_number" TEXT NOT NULL,
    "planned_date" TIMESTAMP(3) NOT NULL,
    "actual_date" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'Scheduled',
    "delivery_address" TEXT,
    "shipping_method" TEXT,
    "tracking_number" TEXT,
    "notes" TEXT,
    "delivered_by" TEXT,
    "received_by" TEXT,
    "received_signature" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_delivery_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_delivery_schedule_detail" (
    "id" TEXT NOT NULL,
    "schedule_number" TEXT NOT NULL,
    "so_detail_id" TEXT NOT NULL,
    "line_number" INTEGER NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "qty_delivered" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_delivery_schedule_detail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_warehouse" (
    "id" TEXT NOT NULL,
    "warehouse_code" TEXT NOT NULL,
    "warehouse_name" TEXT NOT NULL,
    "location" TEXT,
    "type" TEXT NOT NULL DEFAULT 'Main',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "capacity" DOUBLE PRECISION,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_stock_balance" (
    "id" TEXT NOT NULL,
    "warehouse_code" TEXT NOT NULL,
    "part_code" TEXT,
    "part_number" TEXT,
    "part_name" TEXT,
    "product_id" TEXT,
    "description" TEXT,
    "stock_type" TEXT,
    "qty_on_hand" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_reserved" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_available" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "min_stock" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "max_stock" DOUBLE PRECISION,
    "reorder_point" DOUBLE PRECISION,
    "last_movement" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_stock_balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_stock_movement" (
    "id" TEXT NOT NULL,
    "movement_number" TEXT NOT NULL,
    "movement_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "movement_type" TEXT NOT NULL,
    "direction" TEXT,
    "transaction_type" TEXT,
    "warehouse_code" TEXT NOT NULL,
    "destination_warehouse_code" TEXT,
    "part_code" TEXT,
    "part_number" TEXT,
    "part_name" TEXT,
    "product_id" TEXT,
    "description" TEXT,
    "stock_type" TEXT,
    "qty" DOUBLE PRECISION NOT NULL,
    "delta_qty" DOUBLE PRECISION,
    "qty_before" DOUBLE PRECISION,
    "qty_after" DOUBLE PRECISION,
    "adjustment_type" TEXT,
    "transfer_group_id" TEXT,
    "uom_code" TEXT,
    "reference_type" TEXT,
    "reference_number" TEXT,
    "notes" TEXT,
    "performed_by" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_stock_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_stock_reservation" (
    "id" TEXT NOT NULL,
    "reservation_number" TEXT NOT NULL,
    "reservation_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "warehouse_code" TEXT NOT NULL,
    "part_code" TEXT,
    "product_id" TEXT,
    "description" TEXT,
    "qty_reserved" DOUBLE PRECISION NOT NULL,
    "qty_released" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reference_type" TEXT NOT NULL,
    "reference_number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "expiry_date" TIMESTAMP(3),
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_stock_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_forecast" (
    "id" TEXT NOT NULL,
    "forecast_number" TEXT NOT NULL,
    "forecast_name" TEXT,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "customer_code" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "notes" TEXT,
    "created_by" TEXT,
    "approved_by" TEXT,
    "approved_date" TIMESTAMP(3),
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_forecast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_forecast_detail" (
    "id" TEXT NOT NULL,
    "forecast_number" TEXT NOT NULL,
    "line_number" INTEGER NOT NULL,
    "part_code" TEXT NOT NULL,
    "part_id" TEXT,
    "uom_code" TEXT DEFAULT 'pcs',
    "m1_forecast" TIMESTAMP(3),
    "m1_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "m1_fixed_po" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "m2_forecast" TIMESTAMP(3),
    "m2_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "m2_fixed_po" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "m3_forecast" TIMESTAMP(3),
    "m3_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "m3_fixed_po" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_forecast_detail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_mps" (
    "id" TEXT NOT NULL,
    "mps_number" TEXT NOT NULL,
    "mps_name" TEXT,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "forecast_number" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "notes" TEXT,
    "created_by" TEXT,
    "approved_by" TEXT,
    "approved_date" TIMESTAMP(3),
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_mps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_mps_detail" (
    "id" TEXT NOT NULL,
    "mps_number" TEXT NOT NULL,
    "line_number" INTEGER NOT NULL,
    "part_code" TEXT NOT NULL,
    "part_id" TEXT,
    "mbom_header_id" TEXT,
    "qty_planned" DOUBLE PRECISION NOT NULL,
    "qty_produced" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'Planned',
    "so_number" TEXT,
    "customer_code" TEXT,
    "forecast_detail_id" TEXT,
    "forecast_period_offset" INTEGER,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_mps_detail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_mrp_run" (
    "id" TEXT NOT NULL,
    "run_number" TEXT NOT NULL,
    "run_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mps_number" TEXT,
    "plan_horizon" INTEGER NOT NULL DEFAULT 90,
    "cutoff_date" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Running',
    "total_requirements" INTEGER NOT NULL DEFAULT 0,
    "total_planned_orders" INTEGER NOT NULL DEFAULT 0,
    "execution_time" INTEGER,
    "error_message" TEXT,
    "notes" TEXT,
    "run_by" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_mrp_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_mrp_requirement" (
    "id" TEXT NOT NULL,
    "run_number" TEXT NOT NULL,
    "level_mbom" INTEGER NOT NULL DEFAULT 0,
    "part_code" TEXT NOT NULL,
    "part_id" TEXT,
    "requirement_type" TEXT NOT NULL,
    "source_type" TEXT,
    "source_number" TEXT,
    "mps_detail_id" TEXT,
    "required_date" TIMESTAMP(3) NOT NULL,
    "gross_requirement" DOUBLE PRECISION NOT NULL,
    "on_hand_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "allocated_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "net_requirement" DOUBLE PRECISION NOT NULL,
    "planned_order_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "order_type" TEXT,
    "lead_time" INTEGER NOT NULL DEFAULT 0,
    "order_date" TIMESTAMP(3),
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_mrp_requirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_planned_order" (
    "id" TEXT NOT NULL,
    "order_number" TEXT NOT NULL,
    "run_number" TEXT NOT NULL,
    "order_type" TEXT NOT NULL,
    "part_code" TEXT NOT NULL,
    "part_id" TEXT,
    "qty" DOUBLE PRECISION NOT NULL,
    "uom_code" TEXT,
    "required_date" TIMESTAMP(3) NOT NULL,
    "order_date" TIMESTAMP(3) NOT NULL,
    "supplier_code" TEXT,
    "vendor_code" TEXT,
    "mbom_header_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Planned',
    "converted_to" TEXT,
    "converted_date" TIMESTAMP(3),
    "priority" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_planned_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_purchase_requisition" (
    "id" TEXT NOT NULL,
    "pr_number" TEXT NOT NULL,
    "pr_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requested_by" TEXT,
    "department_id" TEXT,
    "required_date" TIMESTAMP(3) NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'Normal',
    "po_type" TEXT NOT NULL DEFAULT 'Other',
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "total_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "approved_by" TEXT,
    "approved_date" TIMESTAMP(3),
    "rejected_by" TEXT,
    "rejected_date" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "converted_to_po" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_purchase_requisition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_purchase_requisition_detail" (
    "id" TEXT NOT NULL,
    "pr_number" TEXT NOT NULL,
    "line_number" INTEGER NOT NULL,
    "part_code" TEXT,
    "part_number" TEXT,
    "part_name" TEXT,
    "product_id" TEXT,
    "description" TEXT,
    "spec" TEXT,
    "thickness" DOUBLE PRECISION,
    "width" DOUBLE PRECISION,
    "CSP" TEXT,
    "qty" DOUBLE PRECISION NOT NULL,
    "ordered_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "uom_code" TEXT,
    "estimated_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "preferred_supplier" TEXT,
    "planned_order_number" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_purchase_requisition_detail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_purchase_order" (
    "id" TEXT NOT NULL,
    "po_number" TEXT NOT NULL,
    "po_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supplier_code" TEXT,
    "supplier_name" TEXT,
    "vendor_code" TEXT,
    "vendor_name" TEXT,
    "contact" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "billing_address" TEXT,
    "shipping_address" TEXT,
    "delivery_date" TIMESTAMP(3) NOT NULL,
    "payment_terms" TEXT,
    "po_type" TEXT NOT NULL DEFAULT 'Other',
    "currency_code" TEXT NOT NULL DEFAULT 'IDR',
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "total_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_by" TEXT,
    "approved_by" TEXT,
    "approved_date" TIMESTAMP(3),
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_purchase_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_purchase_order_pr" (
    "id" TEXT NOT NULL,
    "po_number" TEXT NOT NULL,
    "pr_number" TEXT NOT NULL,

    CONSTRAINT "tbl_purchase_order_pr_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_purchase_order_detail" (
    "id" TEXT NOT NULL,
    "po_number" TEXT NOT NULL,
    "line_number" INTEGER NOT NULL,
    "pr_detail_id" TEXT,
    "product_id" TEXT,
    "description" TEXT,
    "part_code" TEXT,
    "part_number" TEXT,
    "part_name" TEXT,
    "spec" TEXT,
    "thickness" DOUBLE PRECISION,
    "width" DOUBLE PRECISION,
    "CSP" TEXT,
    "qty" DOUBLE PRECISION NOT NULL,
    "uom_code" TEXT,
    "unit_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discount_type" TEXT NOT NULL DEFAULT 'percent',
    "tax" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_received" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "delivery_date" TIMESTAMP(3),
    "category" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_purchase_order_detail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_goods_receipt" (
    "id" TEXT NOT NULL,
    "gr_number" TEXT NOT NULL,
    "gr_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "po_number" TEXT NOT NULL,
    "po_type" TEXT,
    "stock_type" TEXT,
    "warehouse_code" TEXT NOT NULL,
    "received_by" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_goods_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_goods_receipt_detail" (
    "id" TEXT NOT NULL,
    "gr_number" TEXT NOT NULL,
    "line_number" INTEGER NOT NULL,
    "po_detail_id" TEXT NOT NULL,
    "qty_ordered" DOUBLE PRECISION NOT NULL,
    "qty_received" DOUBLE PRECISION NOT NULL,
    "qty_rejected" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "uom_code" TEXT,
    "unit_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_goods_receipt_detail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_manufacturing_order" (
    "id" TEXT NOT NULL,
    "mo_number" TEXT NOT NULL,
    "mo_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reference_type" TEXT,
    "so_number" TEXT,
    "mps_detail_id" TEXT,
    "mrp_requirement_id" TEXT,
    "part_id" TEXT,
    "qty_planned" DOUBLE PRECISION NOT NULL,
    "qty_produced" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_good" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_reject" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "planned_start_date" TIMESTAMP(3),
    "planned_end_date" TIMESTAMP(3),
    "actual_start_date" TIMESTAMP(3),
    "actual_end_date" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "notes" TEXT,
    "created_by" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_manufacturing_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_work_order" (
    "id" TEXT NOT NULL,
    "wo_number" TEXT NOT NULL,
    "wo_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mo_id" TEXT NOT NULL,
    "dies_id" TEXT,
    "machine_code" TEXT,
    "operator_name" TEXT,
    "shift" TEXT,
    "planned_date" TIMESTAMP(3) NOT NULL,
    "planned_qty" DOUBLE PRECISION NOT NULL,
    "shot_count" INTEGER NOT NULL DEFAULT 0,
    "qty_produced" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_good" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_reject" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "start_time" TIMESTAMP(3),
    "end_time" TIMESTAMP(3),
    "running_minutes" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "dies_usage_id" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_work_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_notifications" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "entity_id" TEXT,
    "entity_url" TEXT,
    "user_id" TEXT,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "metadata" JSONB DEFAULT '{}',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tbl_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tbl_users_username_key" ON "tbl_users"("username");

-- CreateIndex
CREATE INDEX "tbl_users_username_idx" ON "tbl_users"("username");

-- CreateIndex
CREATE INDEX "tbl_users_is_deleted_idx" ON "tbl_users"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_logs_name_route_idx" ON "tbl_logs"("name_route");

-- CreateIndex
CREATE INDEX "tbl_logs_action_idx" ON "tbl_logs"("action");

-- CreateIndex
CREATE INDEX "tbl_logs_entity_id_idx" ON "tbl_logs"("entity_id");

-- CreateIndex
CREATE INDEX "tbl_logs_user_id_idx" ON "tbl_logs"("user_id");

-- CreateIndex
CREATE INDEX "tbl_logs_username_idx" ON "tbl_logs"("username");

-- CreateIndex
CREATE INDEX "tbl_logs_status_code_idx" ON "tbl_logs"("status_code");

-- CreateIndex
CREATE INDEX "tbl_logs_created_at_idx" ON "tbl_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_uom_uom_code_key" ON "tbl_uom"("uom_code");

-- CreateIndex
CREATE INDEX "tbl_uom_uom_code_idx" ON "tbl_uom"("uom_code");

-- CreateIndex
CREATE INDEX "tbl_uom_uom_name_idx" ON "tbl_uom"("uom_name");

-- CreateIndex
CREATE INDEX "tbl_uom_is_deleted_idx" ON "tbl_uom"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_currency_currency_code_key" ON "tbl_currency"("currency_code");

-- CreateIndex
CREATE INDEX "tbl_currency_currency_code_idx" ON "tbl_currency"("currency_code");

-- CreateIndex
CREATE INDEX "tbl_currency_is_deleted_idx" ON "tbl_currency"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_customer_customer_code_key" ON "tbl_customer"("customer_code");

-- CreateIndex
CREATE INDEX "tbl_customer_customer_code_idx" ON "tbl_customer"("customer_code");

-- CreateIndex
CREATE INDEX "tbl_customer_customer_name_idx" ON "tbl_customer"("customer_name");

-- CreateIndex
CREATE INDEX "tbl_customer_contact_idx" ON "tbl_customer"("contact");

-- CreateIndex
CREATE INDEX "tbl_customer_phone_idx" ON "tbl_customer"("phone");

-- CreateIndex
CREATE INDEX "tbl_customer_email_idx" ON "tbl_customer"("email");

-- CreateIndex
CREATE INDEX "tbl_customer_currency_code_idx" ON "tbl_customer"("currency_code");

-- CreateIndex
CREATE INDEX "tbl_customer_is_deleted_idx" ON "tbl_customer"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_supplier_supplier_code_key" ON "tbl_supplier"("supplier_code");

-- CreateIndex
CREATE INDEX "tbl_supplier_supplier_code_idx" ON "tbl_supplier"("supplier_code");

-- CreateIndex
CREATE INDEX "tbl_supplier_supplier_name_idx" ON "tbl_supplier"("supplier_name");

-- CreateIndex
CREATE INDEX "tbl_supplier_contact_idx" ON "tbl_supplier"("contact");

-- CreateIndex
CREATE INDEX "tbl_supplier_phone_idx" ON "tbl_supplier"("phone");

-- CreateIndex
CREATE INDEX "tbl_supplier_email_idx" ON "tbl_supplier"("email");

-- CreateIndex
CREATE INDEX "tbl_supplier_is_deleted_idx" ON "tbl_supplier"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_vendor_vendor_code_key" ON "tbl_vendor"("vendor_code");

-- CreateIndex
CREATE INDEX "tbl_vendor_vendor_code_idx" ON "tbl_vendor"("vendor_code");

-- CreateIndex
CREATE INDEX "tbl_vendor_vendor_name_idx" ON "tbl_vendor"("vendor_name");

-- CreateIndex
CREATE INDEX "tbl_vendor_contact_idx" ON "tbl_vendor"("contact");

-- CreateIndex
CREATE INDEX "tbl_vendor_phone_idx" ON "tbl_vendor"("phone");

-- CreateIndex
CREATE INDEX "tbl_vendor_email_idx" ON "tbl_vendor"("email");

-- CreateIndex
CREATE INDEX "tbl_vendor_is_deleted_idx" ON "tbl_vendor"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_vendor_process_vendor_process_code_key" ON "tbl_vendor_process"("vendor_process_code");

-- CreateIndex
CREATE INDEX "tbl_vendor_process_vendor_process_code_idx" ON "tbl_vendor_process"("vendor_process_code");

-- CreateIndex
CREATE INDEX "tbl_vendor_process_vendor_process_name_idx" ON "tbl_vendor_process"("vendor_process_name");

-- CreateIndex
CREATE INDEX "tbl_vendor_process_is_deleted_idx" ON "tbl_vendor_process"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_entity_vendorprocess_entity_type_idx" ON "tbl_entity_vendorprocess"("entity_type");

-- CreateIndex
CREATE INDEX "tbl_entity_vendorprocess_vendor_id_idx" ON "tbl_entity_vendorprocess"("vendor_id");

-- CreateIndex
CREATE INDEX "tbl_entity_vendorprocess_supplier_id_idx" ON "tbl_entity_vendorprocess"("supplier_id");

-- CreateIndex
CREATE INDEX "tbl_entity_vendorprocess_price_list_id_idx" ON "tbl_entity_vendorprocess"("price_list_id");

-- CreateIndex
CREATE INDEX "tbl_entity_vendorprocess_vendor_process_id_idx" ON "tbl_entity_vendorprocess"("vendor_process_id");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_entity_vendorprocess_entity_type_vendor_id_supplier_id__key" ON "tbl_entity_vendorprocess"("entity_type", "vendor_id", "supplier_id", "price_list_id", "vendor_process_id");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_part_part_code_key" ON "tbl_part"("part_code");

-- CreateIndex
CREATE INDEX "tbl_part_part_code_idx" ON "tbl_part"("part_code");

-- CreateIndex
CREATE INDEX "tbl_part_part_no_idx" ON "tbl_part"("part_no");

-- CreateIndex
CREATE INDEX "tbl_part_part_name_idx" ON "tbl_part"("part_name");

-- CreateIndex
CREATE INDEX "tbl_part_customer_code_idx" ON "tbl_part"("customer_code");

-- CreateIndex
CREATE INDEX "tbl_part_category_idx" ON "tbl_part"("category");

-- CreateIndex
CREATE INDEX "tbl_part_status_idx" ON "tbl_part"("status");

-- CreateIndex
CREATE INDEX "tbl_part_supplier_id_idx" ON "tbl_part"("supplier_id");

-- CreateIndex
CREATE INDEX "tbl_part_is_deleted_idx" ON "tbl_part"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_dies_dies_code_key" ON "tbl_dies"("dies_code");

-- CreateIndex
CREATE INDEX "tbl_dies_dies_code_idx" ON "tbl_dies"("dies_code");

-- CreateIndex
CREATE INDEX "tbl_dies_dies_number_idx" ON "tbl_dies"("dies_number");

-- CreateIndex
CREATE INDEX "tbl_dies_dies_name_idx" ON "tbl_dies"("dies_name");

-- CreateIndex
CREATE INDEX "tbl_dies_owner_type_idx" ON "tbl_dies"("owner_type");

-- CreateIndex
CREATE INDEX "tbl_dies_customer_code_idx" ON "tbl_dies"("customer_code");

-- CreateIndex
CREATE INDEX "tbl_dies_category_idx" ON "tbl_dies"("category");

-- CreateIndex
CREATE INDEX "tbl_dies_status_idx" ON "tbl_dies"("status");

-- CreateIndex
CREATE INDEX "tbl_dies_location_idx" ON "tbl_dies"("location");

-- CreateIndex
CREATE INDEX "tbl_dies_warehouse_code_idx" ON "tbl_dies"("warehouse_code");

-- CreateIndex
CREATE INDEX "tbl_dies_shot_counter_idx" ON "tbl_dies"("shot_counter");

-- CreateIndex
CREATE INDEX "tbl_dies_next_maintenance_date_idx" ON "tbl_dies"("next_maintenance_date");

-- CreateIndex
CREATE INDEX "tbl_dies_is_deleted_idx" ON "tbl_dies"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_dies_part_dies_id_idx" ON "tbl_dies_part"("dies_id");

-- CreateIndex
CREATE INDEX "tbl_dies_part_part_id_idx" ON "tbl_dies_part"("part_id");

-- CreateIndex
CREATE INDEX "tbl_dies_part_dies_id_part_id_is_active_idx" ON "tbl_dies_part"("dies_id", "part_id", "is_active");

-- CreateIndex
CREATE INDEX "tbl_dies_part_is_primary_idx" ON "tbl_dies_part"("is_primary");

-- CreateIndex
CREATE INDEX "tbl_dies_part_is_active_idx" ON "tbl_dies_part"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_dies_maintenance_maintenance_number_key" ON "tbl_dies_maintenance"("maintenance_number");

-- CreateIndex
CREATE INDEX "tbl_dies_maintenance_dies_id_idx" ON "tbl_dies_maintenance"("dies_id");

-- CreateIndex
CREATE INDEX "tbl_dies_maintenance_maintenance_number_idx" ON "tbl_dies_maintenance"("maintenance_number");

-- CreateIndex
CREATE INDEX "tbl_dies_maintenance_maintenance_date_idx" ON "tbl_dies_maintenance"("maintenance_date");

-- CreateIndex
CREATE INDEX "tbl_dies_maintenance_maintenance_type_idx" ON "tbl_dies_maintenance"("maintenance_type");

-- CreateIndex
CREATE INDEX "tbl_dies_maintenance_vendor_code_idx" ON "tbl_dies_maintenance"("vendor_code");

-- CreateIndex
CREATE INDEX "tbl_dies_maintenance_is_deleted_idx" ON "tbl_dies_maintenance"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_dies_usage_dies_id_idx" ON "tbl_dies_usage"("dies_id");

-- CreateIndex
CREATE INDEX "tbl_dies_usage_usage_date_idx" ON "tbl_dies_usage"("usage_date");

-- CreateIndex
CREATE INDEX "tbl_dies_usage_part_id_idx" ON "tbl_dies_usage"("part_id");

-- CreateIndex
CREATE INDEX "tbl_dies_usage_reference_type_idx" ON "tbl_dies_usage"("reference_type");

-- CreateIndex
CREATE INDEX "tbl_dies_usage_reference_number_idx" ON "tbl_dies_usage"("reference_number");

-- CreateIndex
CREATE INDEX "tbl_dies_usage_machine_code_idx" ON "tbl_dies_usage"("machine_code");

-- CreateIndex
CREATE INDEX "tbl_dies_usage_is_deleted_idx" ON "tbl_dies_usage"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_machine_machine_code_key" ON "tbl_machine"("machine_code");

-- CreateIndex
CREATE INDEX "tbl_machine_machine_code_idx" ON "tbl_machine"("machine_code");

-- CreateIndex
CREATE INDEX "tbl_machine_machine_name_idx" ON "tbl_machine"("machine_name");

-- CreateIndex
CREATE INDEX "tbl_machine_machine_type_idx" ON "tbl_machine"("machine_type");

-- CreateIndex
CREATE INDEX "tbl_machine_brand_idx" ON "tbl_machine"("brand");

-- CreateIndex
CREATE INDEX "tbl_machine_status_idx" ON "tbl_machine"("status");

-- CreateIndex
CREATE INDEX "tbl_machine_location_idx" ON "tbl_machine"("location");

-- CreateIndex
CREATE INDEX "tbl_machine_warehouse_code_idx" ON "tbl_machine"("warehouse_code");

-- CreateIndex
CREATE INDEX "tbl_machine_line_code_idx" ON "tbl_machine"("line_code");

-- CreateIndex
CREATE INDEX "tbl_machine_next_maintenance_date_idx" ON "tbl_machine"("next_maintenance_date");

-- CreateIndex
CREATE INDEX "tbl_machine_is_deleted_idx" ON "tbl_machine"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_part_attachment_part_id_idx" ON "tbl_part_attachment"("part_id");

-- CreateIndex
CREATE INDEX "tbl_part_attachment_title_idx" ON "tbl_part_attachment"("title");

-- CreateIndex
CREATE INDEX "tbl_part_attachment_is_deleted_idx" ON "tbl_part_attachment"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_material_material_code_key" ON "tbl_material"("material_code");

-- CreateIndex
CREATE INDEX "tbl_material_material_code_idx" ON "tbl_material"("material_code");

-- CreateIndex
CREATE INDEX "tbl_material_material_type_idx" ON "tbl_material"("material_type");

-- CreateIndex
CREATE INDEX "tbl_material_spec_idx" ON "tbl_material"("spec");

-- CreateIndex
CREATE INDEX "tbl_material_is_deleted_idx" ON "tbl_material"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_process_process_code_key" ON "tbl_process"("process_code");

-- CreateIndex
CREATE INDEX "tbl_process_process_code_idx" ON "tbl_process"("process_code");

-- CreateIndex
CREATE INDEX "tbl_process_process_name_idx" ON "tbl_process"("process_name");

-- CreateIndex
CREATE INDEX "tbl_process_is_deleted_idx" ON "tbl_process"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_subprocess_sub_process_code_key" ON "tbl_subprocess"("sub_process_code");

-- CreateIndex
CREATE INDEX "tbl_subprocess_sub_process_code_idx" ON "tbl_subprocess"("sub_process_code");

-- CreateIndex
CREATE INDEX "tbl_subprocess_sub_process_name_idx" ON "tbl_subprocess"("sub_process_name");

-- CreateIndex
CREATE INDEX "tbl_subprocess_process_id_idx" ON "tbl_subprocess"("process_id");

-- CreateIndex
CREATE INDEX "tbl_subprocess_is_deleted_idx" ON "tbl_subprocess"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_paymentterm_term_code_key" ON "tbl_paymentterm"("term_code");

-- CreateIndex
CREATE INDEX "tbl_paymentterm_term_code_idx" ON "tbl_paymentterm"("term_code");

-- CreateIndex
CREATE INDEX "tbl_paymentterm_description_idx" ON "tbl_paymentterm"("description");

-- CreateIndex
CREATE INDEX "tbl_paymentterm_is_deleted_idx" ON "tbl_paymentterm"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_vendor_pricelist_currency_code_idx" ON "tbl_vendor_pricelist"("currency_code");

-- CreateIndex
CREATE INDEX "tbl_vendor_pricelist_vendor_id_idx" ON "tbl_vendor_pricelist"("vendor_id");

-- CreateIndex
CREATE INDEX "tbl_vendor_pricelist_part_id_idx" ON "tbl_vendor_pricelist"("part_id");

-- CreateIndex
CREATE INDEX "tbl_vendor_pricelist_customer_id_idx" ON "tbl_vendor_pricelist"("customer_id");

-- CreateIndex
CREATE INDEX "tbl_vendor_pricelist_category_idx" ON "tbl_vendor_pricelist"("category");

-- CreateIndex
CREATE INDEX "tbl_vendor_pricelist_pricing_year_idx" ON "tbl_vendor_pricelist"("pricing_year");

-- CreateIndex
CREATE INDEX "tbl_vendor_pricelist_is_deleted_idx" ON "tbl_vendor_pricelist"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_part_pricelist_currency_code_idx" ON "tbl_part_pricelist"("currency_code");

-- CreateIndex
CREATE INDEX "tbl_part_pricelist_part_id_idx" ON "tbl_part_pricelist"("part_id");

-- CreateIndex
CREATE INDEX "tbl_part_pricelist_is_deleted_idx" ON "tbl_part_pricelist"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_material_pricelist_currency_code_idx" ON "tbl_material_pricelist"("currency_code");

-- CreateIndex
CREATE INDEX "tbl_material_pricelist_material_id_idx" ON "tbl_material_pricelist"("material_id");

-- CreateIndex
CREATE INDEX "tbl_material_pricelist_supplier_id_idx" ON "tbl_material_pricelist"("supplier_id");

-- CreateIndex
CREATE INDEX "tbl_material_pricelist_CSP_idx" ON "tbl_material_pricelist"("CSP");

-- CreateIndex
CREATE INDEX "tbl_material_pricelist_part_number_cp_idx" ON "tbl_material_pricelist"("part_number_cp");

-- CreateIndex
CREATE INDEX "tbl_material_pricelist_part_name_cp_idx" ON "tbl_material_pricelist"("part_name_cp");

-- CreateIndex
CREATE INDEX "tbl_material_pricelist_pricing_year_idx" ON "tbl_material_pricelist"("pricing_year");

-- CreateIndex
CREATE INDEX "tbl_material_pricelist_is_deleted_idx" ON "tbl_material_pricelist"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_department_department_code_key" ON "tbl_department"("department_code");

-- CreateIndex
CREATE INDEX "tbl_department_department_code_idx" ON "tbl_department"("department_code");

-- CreateIndex
CREATE INDEX "tbl_department_department_name_idx" ON "tbl_department"("department_name");

-- CreateIndex
CREATE INDEX "tbl_department_is_deleted_idx" ON "tbl_department"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_division_division_code_key" ON "tbl_division"("division_code");

-- CreateIndex
CREATE INDEX "tbl_division_division_code_idx" ON "tbl_division"("division_code");

-- CreateIndex
CREATE INDEX "tbl_division_division_name_idx" ON "tbl_division"("division_name");

-- CreateIndex
CREATE INDEX "tbl_division_department_id_idx" ON "tbl_division"("department_id");

-- CreateIndex
CREATE INDEX "tbl_division_is_deleted_idx" ON "tbl_division"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_employee_employee_id_key" ON "tbl_employee"("employee_id");

-- CreateIndex
CREATE INDEX "tbl_employee_employee_id_idx" ON "tbl_employee"("employee_id");

-- CreateIndex
CREATE INDEX "tbl_employee_full_name_idx" ON "tbl_employee"("full_name");

-- CreateIndex
CREATE INDEX "tbl_employee_department_id_idx" ON "tbl_employee"("department_id");

-- CreateIndex
CREATE INDEX "tbl_employee_division_id_idx" ON "tbl_employee"("division_id");

-- CreateIndex
CREATE INDEX "tbl_employee_status_idx" ON "tbl_employee"("status");

-- CreateIndex
CREATE INDEX "tbl_employee_is_deleted_idx" ON "tbl_employee"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_product_product_code_key" ON "tbl_product"("product_code");

-- CreateIndex
CREATE INDEX "tbl_product_product_code_idx" ON "tbl_product"("product_code");

-- CreateIndex
CREATE INDEX "tbl_product_product_name_idx" ON "tbl_product"("product_name");

-- CreateIndex
CREATE INDEX "tbl_product_uom_code_idx" ON "tbl_product"("uom_code");

-- CreateIndex
CREATE INDEX "tbl_product_is_deleted_idx" ON "tbl_product"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_product_pricelist_currency_code_idx" ON "tbl_product_pricelist"("currency_code");

-- CreateIndex
CREATE INDEX "tbl_product_pricelist_product_id_idx" ON "tbl_product_pricelist"("product_id");

-- CreateIndex
CREATE INDEX "tbl_product_pricelist_supplier_id_idx" ON "tbl_product_pricelist"("supplier_id");

-- CreateIndex
CREATE INDEX "tbl_product_pricelist_pricing_year_idx" ON "tbl_product_pricelist"("pricing_year");

-- CreateIndex
CREATE INDEX "tbl_product_pricelist_is_deleted_idx" ON "tbl_product_pricelist"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_ebomheader_no_reg_key" ON "tbl_ebomheader"("no_reg");

-- CreateIndex
CREATE INDEX "tbl_ebomheader_no_reg_idx" ON "tbl_ebomheader"("no_reg");

-- CreateIndex
CREATE INDEX "tbl_ebomheader_part_id_idx" ON "tbl_ebomheader"("part_id");

-- CreateIndex
CREATE INDEX "tbl_ebomheader_uom_code_idx" ON "tbl_ebomheader"("uom_code");

-- CreateIndex
CREATE INDEX "tbl_ebomheader_status_idx" ON "tbl_ebomheader"("status");

-- CreateIndex
CREATE INDEX "tbl_ebomheader_ecn_number_idx" ON "tbl_ebomheader"("ecn_number");

-- CreateIndex
CREATE INDEX "tbl_ebomheader_is_deleted_idx" ON "tbl_ebomheader"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_ebomdetail_no_reg_idx" ON "tbl_ebomdetail"("no_reg");

-- CreateIndex
CREATE INDEX "tbl_ebomdetail_part_id_idx" ON "tbl_ebomdetail"("part_id");

-- CreateIndex
CREATE INDEX "tbl_ebomdetail_uom_code_idx" ON "tbl_ebomdetail"("uom_code");

-- CreateIndex
CREATE INDEX "tbl_ebomdetail_category_idx" ON "tbl_ebomdetail"("category");

-- CreateIndex
CREATE INDEX "tbl_ebomdetail_is_deleted_idx" ON "tbl_ebomdetail"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_ebomprocess_no_reg_idx" ON "tbl_ebomprocess"("no_reg");

-- CreateIndex
CREATE INDEX "tbl_ebomprocess_ebom_detail_id_idx" ON "tbl_ebomprocess"("ebom_detail_id");

-- CreateIndex
CREATE INDEX "tbl_ebomprocess_parent_id_idx" ON "tbl_ebomprocess"("parent_id");

-- CreateIndex
CREATE INDEX "tbl_ebomprocess_process_id_idx" ON "tbl_ebomprocess"("process_id");

-- CreateIndex
CREATE INDEX "tbl_ebomprocess_sub_process_id_idx" ON "tbl_ebomprocess"("sub_process_id");

-- CreateIndex
CREATE INDEX "tbl_ebomprocess_sequence_idx" ON "tbl_ebomprocess"("sequence");

-- CreateIndex
CREATE INDEX "tbl_ebomprocess_is_deleted_idx" ON "tbl_ebomprocess"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_ebomcost_header_ebom_id_idx" ON "tbl_ebomcost_header"("ebom_id");

-- CreateIndex
CREATE INDEX "tbl_ebomcost_header_currency_code_idx" ON "tbl_ebomcost_header"("currency_code");

-- CreateIndex
CREATE INDEX "tbl_ebomcost_header_status_idx" ON "tbl_ebomcost_header"("status");

-- CreateIndex
CREATE INDEX "tbl_ebomcost_header_is_standard_idx" ON "tbl_ebomcost_header"("is_standard");

-- CreateIndex
CREATE INDEX "tbl_ebomcost_header_is_deleted_idx" ON "tbl_ebomcost_header"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_ebomcost_detail_ebom_cost_header_id_idx" ON "tbl_ebomcost_detail"("ebom_cost_header_id");

-- CreateIndex
CREATE INDEX "tbl_ebomcost_detail_type_idx" ON "tbl_ebomcost_detail"("type");

-- CreateIndex
CREATE INDEX "tbl_ebomcost_detail_ebom_detail_id_idx" ON "tbl_ebomcost_detail"("ebom_detail_id");

-- CreateIndex
CREATE INDEX "tbl_ebomcost_detail_ebom_process_id_idx" ON "tbl_ebomcost_detail"("ebom_process_id");

-- CreateIndex
CREATE INDEX "tbl_ebomcost_detail_is_deleted_idx" ON "tbl_ebomcost_detail"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_mbomheader_no_reg_key" ON "tbl_mbomheader"("no_reg");

-- CreateIndex
CREATE INDEX "tbl_mbomheader_no_reg_idx" ON "tbl_mbomheader"("no_reg");

-- CreateIndex
CREATE INDEX "tbl_mbomheader_part_id_idx" ON "tbl_mbomheader"("part_id");

-- CreateIndex
CREATE INDEX "tbl_mbomheader_uom_code_idx" ON "tbl_mbomheader"("uom_code");

-- CreateIndex
CREATE INDEX "tbl_mbomheader_is_deleted_idx" ON "tbl_mbomheader"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_mbomdetail_no_reg_idx" ON "tbl_mbomdetail"("no_reg");

-- CreateIndex
CREATE INDEX "tbl_mbomdetail_part_id_idx" ON "tbl_mbomdetail"("part_id");

-- CreateIndex
CREATE INDEX "tbl_mbomdetail_uom_code_idx" ON "tbl_mbomdetail"("uom_code");

-- CreateIndex
CREATE INDEX "tbl_mbomdetail_category_idx" ON "tbl_mbomdetail"("category");

-- CreateIndex
CREATE INDEX "tbl_mbomdetail_is_deleted_idx" ON "tbl_mbomdetail"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_mbomprocess_no_reg_idx" ON "tbl_mbomprocess"("no_reg");

-- CreateIndex
CREATE INDEX "tbl_mbomprocess_bom_detail_id_idx" ON "tbl_mbomprocess"("bom_detail_id");

-- CreateIndex
CREATE INDEX "tbl_mbomprocess_process_id_idx" ON "tbl_mbomprocess"("process_id");

-- CreateIndex
CREATE INDEX "tbl_mbomprocess_sequence_idx" ON "tbl_mbomprocess"("sequence");

-- CreateIndex
CREATE INDEX "tbl_mbomprocess_is_deleted_idx" ON "tbl_mbomprocess"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_mbomcost_header_mbom_id_idx" ON "tbl_mbomcost_header"("mbom_id");

-- CreateIndex
CREATE INDEX "tbl_mbomcost_header_currency_code_idx" ON "tbl_mbomcost_header"("currency_code");

-- CreateIndex
CREATE INDEX "tbl_mbomcost_header_status_idx" ON "tbl_mbomcost_header"("status");

-- CreateIndex
CREATE INDEX "tbl_mbomcost_header_is_standard_idx" ON "tbl_mbomcost_header"("is_standard");

-- CreateIndex
CREATE INDEX "tbl_mbomcost_header_is_deleted_idx" ON "tbl_mbomcost_header"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_mbomcost_detail_mbom_cost_header_id_idx" ON "tbl_mbomcost_detail"("mbom_cost_header_id");

-- CreateIndex
CREATE INDEX "tbl_mbomcost_detail_type_idx" ON "tbl_mbomcost_detail"("type");

-- CreateIndex
CREATE INDEX "tbl_mbomcost_detail_mbom_detail_id_idx" ON "tbl_mbomcost_detail"("mbom_detail_id");

-- CreateIndex
CREATE INDEX "tbl_mbomcost_detail_mbom_process_id_idx" ON "tbl_mbomcost_detail"("mbom_process_id");

-- CreateIndex
CREATE INDEX "tbl_mbomcost_detail_is_deleted_idx" ON "tbl_mbomcost_detail"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_quotationheader_quotation_number_key" ON "tbl_quotationheader"("quotation_number");

-- CreateIndex
CREATE INDEX "tbl_quotationheader_quotation_number_idx" ON "tbl_quotationheader"("quotation_number");

-- CreateIndex
CREATE INDEX "tbl_quotationheader_customer_code_idx" ON "tbl_quotationheader"("customer_code");

-- CreateIndex
CREATE INDEX "tbl_quotationheader_quotation_date_idx" ON "tbl_quotationheader"("quotation_date");

-- CreateIndex
CREATE INDEX "tbl_quotationheader_valid_until_idx" ON "tbl_quotationheader"("valid_until");

-- CreateIndex
CREATE INDEX "tbl_quotationheader_status_idx" ON "tbl_quotationheader"("status");

-- CreateIndex
CREATE INDEX "tbl_quotationheader_is_deleted_idx" ON "tbl_quotationheader"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_quotationdetail_quotation_number_idx" ON "tbl_quotationdetail"("quotation_number");

-- CreateIndex
CREATE INDEX "tbl_quotationdetail_part_code_idx" ON "tbl_quotationdetail"("part_code");

-- CreateIndex
CREATE INDEX "tbl_quotationdetail_uom_code_idx" ON "tbl_quotationdetail"("uom_code");

-- CreateIndex
CREATE INDEX "tbl_quotationdetail_mbom_header_id_idx" ON "tbl_quotationdetail"("mbom_header_id");

-- CreateIndex
CREATE INDEX "tbl_quotationdetail_is_deleted_idx" ON "tbl_quotationdetail"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_salesorderheader_so_number_key" ON "tbl_salesorderheader"("so_number");

-- CreateIndex
CREATE INDEX "tbl_salesorderheader_so_number_idx" ON "tbl_salesorderheader"("so_number");

-- CreateIndex
CREATE INDEX "tbl_salesorderheader_customer_code_idx" ON "tbl_salesorderheader"("customer_code");

-- CreateIndex
CREATE INDEX "tbl_salesorderheader_so_date_idx" ON "tbl_salesorderheader"("so_date");

-- CreateIndex
CREATE INDEX "tbl_salesorderheader_delivery_date_idx" ON "tbl_salesorderheader"("delivery_date");

-- CreateIndex
CREATE INDEX "tbl_salesorderheader_status_idx" ON "tbl_salesorderheader"("status");

-- CreateIndex
CREATE INDEX "tbl_salesorderheader_is_deleted_idx" ON "tbl_salesorderheader"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_salesorderdetail_so_number_idx" ON "tbl_salesorderdetail"("so_number");

-- CreateIndex
CREATE INDEX "tbl_salesorderdetail_part_code_idx" ON "tbl_salesorderdetail"("part_code");

-- CreateIndex
CREATE INDEX "tbl_salesorderdetail_uom_code_idx" ON "tbl_salesorderdetail"("uom_code");

-- CreateIndex
CREATE INDEX "tbl_salesorderdetail_mbom_header_id_idx" ON "tbl_salesorderdetail"("mbom_header_id");

-- CreateIndex
CREATE INDEX "tbl_salesorderdetail_status_idx" ON "tbl_salesorderdetail"("status");

-- CreateIndex
CREATE INDEX "tbl_salesorderdetail_is_deleted_idx" ON "tbl_salesorderdetail"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_salesorder_attachment_so_number_idx" ON "tbl_salesorder_attachment"("so_number");

-- CreateIndex
CREATE INDEX "tbl_salesorder_attachment_is_deleted_idx" ON "tbl_salesorder_attachment"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_delivery_schedule_schedule_number_key" ON "tbl_delivery_schedule"("schedule_number");

-- CreateIndex
CREATE INDEX "tbl_delivery_schedule_schedule_number_idx" ON "tbl_delivery_schedule"("schedule_number");

-- CreateIndex
CREATE INDEX "tbl_delivery_schedule_so_number_idx" ON "tbl_delivery_schedule"("so_number");

-- CreateIndex
CREATE INDEX "tbl_delivery_schedule_planned_date_idx" ON "tbl_delivery_schedule"("planned_date");

-- CreateIndex
CREATE INDEX "tbl_delivery_schedule_status_idx" ON "tbl_delivery_schedule"("status");

-- CreateIndex
CREATE INDEX "tbl_delivery_schedule_is_deleted_idx" ON "tbl_delivery_schedule"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_delivery_schedule_detail_schedule_number_idx" ON "tbl_delivery_schedule_detail"("schedule_number");

-- CreateIndex
CREATE INDEX "tbl_delivery_schedule_detail_so_detail_id_idx" ON "tbl_delivery_schedule_detail"("so_detail_id");

-- CreateIndex
CREATE INDEX "tbl_delivery_schedule_detail_is_deleted_idx" ON "tbl_delivery_schedule_detail"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_warehouse_warehouse_code_key" ON "tbl_warehouse"("warehouse_code");

-- CreateIndex
CREATE INDEX "tbl_warehouse_warehouse_code_idx" ON "tbl_warehouse"("warehouse_code");

-- CreateIndex
CREATE INDEX "tbl_warehouse_warehouse_name_idx" ON "tbl_warehouse"("warehouse_name");

-- CreateIndex
CREATE INDEX "tbl_warehouse_type_idx" ON "tbl_warehouse"("type");

-- CreateIndex
CREATE INDEX "tbl_warehouse_is_active_idx" ON "tbl_warehouse"("is_active");

-- CreateIndex
CREATE INDEX "tbl_warehouse_is_deleted_idx" ON "tbl_warehouse"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_stock_balance_warehouse_code_idx" ON "tbl_stock_balance"("warehouse_code");

-- CreateIndex
CREATE INDEX "tbl_stock_balance_part_code_idx" ON "tbl_stock_balance"("part_code");

-- CreateIndex
CREATE INDEX "tbl_stock_balance_part_number_idx" ON "tbl_stock_balance"("part_number");

-- CreateIndex
CREATE INDEX "tbl_stock_balance_part_name_idx" ON "tbl_stock_balance"("part_name");

-- CreateIndex
CREATE INDEX "tbl_stock_balance_product_id_idx" ON "tbl_stock_balance"("product_id");

-- CreateIndex
CREATE INDEX "tbl_stock_balance_stock_type_idx" ON "tbl_stock_balance"("stock_type");

-- CreateIndex
CREATE INDEX "tbl_stock_balance_qty_on_hand_idx" ON "tbl_stock_balance"("qty_on_hand");

-- CreateIndex
CREATE INDEX "tbl_stock_balance_qty_available_idx" ON "tbl_stock_balance"("qty_available");

-- CreateIndex
CREATE INDEX "tbl_stock_balance_is_deleted_idx" ON "tbl_stock_balance"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_stock_balance_warehouse_code_part_code_product_id_descr_key" ON "tbl_stock_balance"("warehouse_code", "part_code", "product_id", "description");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_stock_movement_movement_number_key" ON "tbl_stock_movement"("movement_number");

-- CreateIndex
CREATE INDEX "tbl_stock_movement_movement_number_idx" ON "tbl_stock_movement"("movement_number");

-- CreateIndex
CREATE INDEX "tbl_stock_movement_movement_date_idx" ON "tbl_stock_movement"("movement_date");

-- CreateIndex
CREATE INDEX "tbl_stock_movement_movement_type_idx" ON "tbl_stock_movement"("movement_type");

-- CreateIndex
CREATE INDEX "tbl_stock_movement_direction_idx" ON "tbl_stock_movement"("direction");

-- CreateIndex
CREATE INDEX "tbl_stock_movement_transaction_type_idx" ON "tbl_stock_movement"("transaction_type");

-- CreateIndex
CREATE INDEX "tbl_stock_movement_warehouse_code_idx" ON "tbl_stock_movement"("warehouse_code");

-- CreateIndex
CREATE INDEX "tbl_stock_movement_destination_warehouse_code_idx" ON "tbl_stock_movement"("destination_warehouse_code");

-- CreateIndex
CREATE INDEX "tbl_stock_movement_transfer_group_id_idx" ON "tbl_stock_movement"("transfer_group_id");

-- CreateIndex
CREATE INDEX "tbl_stock_movement_part_code_idx" ON "tbl_stock_movement"("part_code");

-- CreateIndex
CREATE INDEX "tbl_stock_movement_part_number_idx" ON "tbl_stock_movement"("part_number");

-- CreateIndex
CREATE INDEX "tbl_stock_movement_part_name_idx" ON "tbl_stock_movement"("part_name");

-- CreateIndex
CREATE INDEX "tbl_stock_movement_product_id_idx" ON "tbl_stock_movement"("product_id");

-- CreateIndex
CREATE INDEX "tbl_stock_movement_stock_type_idx" ON "tbl_stock_movement"("stock_type");

-- CreateIndex
CREATE INDEX "tbl_stock_movement_reference_type_idx" ON "tbl_stock_movement"("reference_type");

-- CreateIndex
CREATE INDEX "tbl_stock_movement_reference_number_idx" ON "tbl_stock_movement"("reference_number");

-- CreateIndex
CREATE INDEX "tbl_stock_movement_is_deleted_idx" ON "tbl_stock_movement"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_stock_reservation_reservation_number_key" ON "tbl_stock_reservation"("reservation_number");

-- CreateIndex
CREATE INDEX "tbl_stock_reservation_reservation_number_idx" ON "tbl_stock_reservation"("reservation_number");

-- CreateIndex
CREATE INDEX "tbl_stock_reservation_warehouse_code_idx" ON "tbl_stock_reservation"("warehouse_code");

-- CreateIndex
CREATE INDEX "tbl_stock_reservation_part_code_idx" ON "tbl_stock_reservation"("part_code");

-- CreateIndex
CREATE INDEX "tbl_stock_reservation_product_id_idx" ON "tbl_stock_reservation"("product_id");

-- CreateIndex
CREATE INDEX "tbl_stock_reservation_description_idx" ON "tbl_stock_reservation"("description");

-- CreateIndex
CREATE INDEX "tbl_stock_reservation_reference_type_idx" ON "tbl_stock_reservation"("reference_type");

-- CreateIndex
CREATE INDEX "tbl_stock_reservation_reference_number_idx" ON "tbl_stock_reservation"("reference_number");

-- CreateIndex
CREATE INDEX "tbl_stock_reservation_status_idx" ON "tbl_stock_reservation"("status");

-- CreateIndex
CREATE INDEX "tbl_stock_reservation_is_deleted_idx" ON "tbl_stock_reservation"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_forecast_forecast_number_key" ON "tbl_forecast"("forecast_number");

-- CreateIndex
CREATE INDEX "tbl_forecast_forecast_number_idx" ON "tbl_forecast"("forecast_number");

-- CreateIndex
CREATE INDEX "tbl_forecast_period_start_idx" ON "tbl_forecast"("period_start");

-- CreateIndex
CREATE INDEX "tbl_forecast_period_end_idx" ON "tbl_forecast"("period_end");

-- CreateIndex
CREATE INDEX "tbl_forecast_customer_code_idx" ON "tbl_forecast"("customer_code");

-- CreateIndex
CREATE INDEX "tbl_forecast_status_idx" ON "tbl_forecast"("status");

-- CreateIndex
CREATE INDEX "tbl_forecast_is_deleted_idx" ON "tbl_forecast"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_forecast_detail_forecast_number_idx" ON "tbl_forecast_detail"("forecast_number");

-- CreateIndex
CREATE INDEX "tbl_forecast_detail_part_code_idx" ON "tbl_forecast_detail"("part_code");

-- CreateIndex
CREATE INDEX "tbl_forecast_detail_part_id_idx" ON "tbl_forecast_detail"("part_id");

-- CreateIndex
CREATE INDEX "tbl_forecast_detail_uom_code_idx" ON "tbl_forecast_detail"("uom_code");

-- CreateIndex
CREATE INDEX "tbl_forecast_detail_is_deleted_idx" ON "tbl_forecast_detail"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_mps_mps_number_key" ON "tbl_mps"("mps_number");

-- CreateIndex
CREATE INDEX "tbl_mps_mps_number_idx" ON "tbl_mps"("mps_number");

-- CreateIndex
CREATE INDEX "tbl_mps_period_start_idx" ON "tbl_mps"("period_start");

-- CreateIndex
CREATE INDEX "tbl_mps_period_end_idx" ON "tbl_mps"("period_end");

-- CreateIndex
CREATE INDEX "tbl_mps_forecast_number_idx" ON "tbl_mps"("forecast_number");

-- CreateIndex
CREATE INDEX "tbl_mps_status_idx" ON "tbl_mps"("status");

-- CreateIndex
CREATE INDEX "tbl_mps_is_deleted_idx" ON "tbl_mps"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_mps_detail_mps_number_idx" ON "tbl_mps_detail"("mps_number");

-- CreateIndex
CREATE INDEX "tbl_mps_detail_part_code_idx" ON "tbl_mps_detail"("part_code");

-- CreateIndex
CREATE INDEX "tbl_mps_detail_part_id_idx" ON "tbl_mps_detail"("part_id");

-- CreateIndex
CREATE INDEX "tbl_mps_detail_mbom_header_id_idx" ON "tbl_mps_detail"("mbom_header_id");

-- CreateIndex
CREATE INDEX "tbl_mps_detail_start_date_idx" ON "tbl_mps_detail"("start_date");

-- CreateIndex
CREATE INDEX "tbl_mps_detail_end_date_idx" ON "tbl_mps_detail"("end_date");

-- CreateIndex
CREATE INDEX "tbl_mps_detail_priority_idx" ON "tbl_mps_detail"("priority");

-- CreateIndex
CREATE INDEX "tbl_mps_detail_status_idx" ON "tbl_mps_detail"("status");

-- CreateIndex
CREATE INDEX "tbl_mps_detail_so_number_idx" ON "tbl_mps_detail"("so_number");

-- CreateIndex
CREATE INDEX "tbl_mps_detail_customer_code_idx" ON "tbl_mps_detail"("customer_code");

-- CreateIndex
CREATE INDEX "tbl_mps_detail_forecast_detail_id_idx" ON "tbl_mps_detail"("forecast_detail_id");

-- CreateIndex
CREATE INDEX "tbl_mps_detail_is_deleted_idx" ON "tbl_mps_detail"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_mrp_run_run_number_key" ON "tbl_mrp_run"("run_number");

-- CreateIndex
CREATE INDEX "tbl_mrp_run_run_number_idx" ON "tbl_mrp_run"("run_number");

-- CreateIndex
CREATE INDEX "tbl_mrp_run_run_date_idx" ON "tbl_mrp_run"("run_date");

-- CreateIndex
CREATE INDEX "tbl_mrp_run_mps_number_idx" ON "tbl_mrp_run"("mps_number");

-- CreateIndex
CREATE INDEX "tbl_mrp_run_status_idx" ON "tbl_mrp_run"("status");

-- CreateIndex
CREATE INDEX "tbl_mrp_run_is_deleted_idx" ON "tbl_mrp_run"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_mrp_requirement_run_number_idx" ON "tbl_mrp_requirement"("run_number");

-- CreateIndex
CREATE INDEX "tbl_mrp_requirement_level_mbom_idx" ON "tbl_mrp_requirement"("level_mbom");

-- CreateIndex
CREATE INDEX "tbl_mrp_requirement_part_code_idx" ON "tbl_mrp_requirement"("part_code");

-- CreateIndex
CREATE INDEX "tbl_mrp_requirement_part_id_idx" ON "tbl_mrp_requirement"("part_id");

-- CreateIndex
CREATE INDEX "tbl_mrp_requirement_requirement_type_idx" ON "tbl_mrp_requirement"("requirement_type");

-- CreateIndex
CREATE INDEX "tbl_mrp_requirement_source_type_idx" ON "tbl_mrp_requirement"("source_type");

-- CreateIndex
CREATE INDEX "tbl_mrp_requirement_source_number_idx" ON "tbl_mrp_requirement"("source_number");

-- CreateIndex
CREATE INDEX "tbl_mrp_requirement_mps_detail_id_idx" ON "tbl_mrp_requirement"("mps_detail_id");

-- CreateIndex
CREATE INDEX "tbl_mrp_requirement_required_date_idx" ON "tbl_mrp_requirement"("required_date");

-- CreateIndex
CREATE INDEX "tbl_mrp_requirement_order_type_idx" ON "tbl_mrp_requirement"("order_type");

-- CreateIndex
CREATE INDEX "tbl_mrp_requirement_is_deleted_idx" ON "tbl_mrp_requirement"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_planned_order_order_number_key" ON "tbl_planned_order"("order_number");

-- CreateIndex
CREATE INDEX "tbl_planned_order_order_number_idx" ON "tbl_planned_order"("order_number");

-- CreateIndex
CREATE INDEX "tbl_planned_order_run_number_idx" ON "tbl_planned_order"("run_number");

-- CreateIndex
CREATE INDEX "tbl_planned_order_order_type_idx" ON "tbl_planned_order"("order_type");

-- CreateIndex
CREATE INDEX "tbl_planned_order_part_code_idx" ON "tbl_planned_order"("part_code");

-- CreateIndex
CREATE INDEX "tbl_planned_order_part_id_idx" ON "tbl_planned_order"("part_id");

-- CreateIndex
CREATE INDEX "tbl_planned_order_required_date_idx" ON "tbl_planned_order"("required_date");

-- CreateIndex
CREATE INDEX "tbl_planned_order_order_date_idx" ON "tbl_planned_order"("order_date");

-- CreateIndex
CREATE INDEX "tbl_planned_order_supplier_code_idx" ON "tbl_planned_order"("supplier_code");

-- CreateIndex
CREATE INDEX "tbl_planned_order_vendor_code_idx" ON "tbl_planned_order"("vendor_code");

-- CreateIndex
CREATE INDEX "tbl_planned_order_mbom_header_id_idx" ON "tbl_planned_order"("mbom_header_id");

-- CreateIndex
CREATE INDEX "tbl_planned_order_status_idx" ON "tbl_planned_order"("status");

-- CreateIndex
CREATE INDEX "tbl_planned_order_is_deleted_idx" ON "tbl_planned_order"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_purchase_requisition_pr_number_key" ON "tbl_purchase_requisition"("pr_number");

-- CreateIndex
CREATE INDEX "tbl_purchase_requisition_pr_number_idx" ON "tbl_purchase_requisition"("pr_number");

-- CreateIndex
CREATE INDEX "tbl_purchase_requisition_pr_date_idx" ON "tbl_purchase_requisition"("pr_date");

-- CreateIndex
CREATE INDEX "tbl_purchase_requisition_requested_by_idx" ON "tbl_purchase_requisition"("requested_by");

-- CreateIndex
CREATE INDEX "tbl_purchase_requisition_department_id_idx" ON "tbl_purchase_requisition"("department_id");

-- CreateIndex
CREATE INDEX "tbl_purchase_requisition_priority_idx" ON "tbl_purchase_requisition"("priority");

-- CreateIndex
CREATE INDEX "tbl_purchase_requisition_po_type_idx" ON "tbl_purchase_requisition"("po_type");

-- CreateIndex
CREATE INDEX "tbl_purchase_requisition_status_idx" ON "tbl_purchase_requisition"("status");

-- CreateIndex
CREATE INDEX "tbl_purchase_requisition_required_date_idx" ON "tbl_purchase_requisition"("required_date");

-- CreateIndex
CREATE INDEX "tbl_purchase_requisition_is_deleted_idx" ON "tbl_purchase_requisition"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_purchase_requisition_detail_pr_number_idx" ON "tbl_purchase_requisition_detail"("pr_number");

-- CreateIndex
CREATE INDEX "tbl_purchase_requisition_detail_part_code_idx" ON "tbl_purchase_requisition_detail"("part_code");

-- CreateIndex
CREATE INDEX "tbl_purchase_requisition_detail_product_id_idx" ON "tbl_purchase_requisition_detail"("product_id");

-- CreateIndex
CREATE INDEX "tbl_purchase_requisition_detail_preferred_supplier_idx" ON "tbl_purchase_requisition_detail"("preferred_supplier");

-- CreateIndex
CREATE INDEX "tbl_purchase_requisition_detail_planned_order_number_idx" ON "tbl_purchase_requisition_detail"("planned_order_number");

-- CreateIndex
CREATE INDEX "tbl_purchase_requisition_detail_is_deleted_idx" ON "tbl_purchase_requisition_detail"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_purchase_order_po_number_key" ON "tbl_purchase_order"("po_number");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_po_number_idx" ON "tbl_purchase_order"("po_number");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_po_date_idx" ON "tbl_purchase_order"("po_date");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_supplier_code_idx" ON "tbl_purchase_order"("supplier_code");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_delivery_date_idx" ON "tbl_purchase_order"("delivery_date");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_status_idx" ON "tbl_purchase_order"("status");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_po_type_idx" ON "tbl_purchase_order"("po_type");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_currency_code_idx" ON "tbl_purchase_order"("currency_code");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_is_deleted_idx" ON "tbl_purchase_order"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_pr_po_number_idx" ON "tbl_purchase_order_pr"("po_number");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_pr_pr_number_idx" ON "tbl_purchase_order_pr"("pr_number");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_purchase_order_pr_po_number_pr_number_key" ON "tbl_purchase_order_pr"("po_number", "pr_number");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_detail_po_number_idx" ON "tbl_purchase_order_detail"("po_number");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_detail_pr_detail_id_idx" ON "tbl_purchase_order_detail"("pr_detail_id");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_detail_part_code_idx" ON "tbl_purchase_order_detail"("part_code");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_detail_product_id_idx" ON "tbl_purchase_order_detail"("product_id");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_detail_uom_code_idx" ON "tbl_purchase_order_detail"("uom_code");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_detail_category_idx" ON "tbl_purchase_order_detail"("category");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_detail_is_deleted_idx" ON "tbl_purchase_order_detail"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_goods_receipt_gr_number_key" ON "tbl_goods_receipt"("gr_number");

-- CreateIndex
CREATE INDEX "tbl_goods_receipt_gr_number_idx" ON "tbl_goods_receipt"("gr_number");

-- CreateIndex
CREATE INDEX "tbl_goods_receipt_gr_date_idx" ON "tbl_goods_receipt"("gr_date");

-- CreateIndex
CREATE INDEX "tbl_goods_receipt_po_number_idx" ON "tbl_goods_receipt"("po_number");

-- CreateIndex
CREATE INDEX "tbl_goods_receipt_po_type_idx" ON "tbl_goods_receipt"("po_type");

-- CreateIndex
CREATE INDEX "tbl_goods_receipt_warehouse_code_idx" ON "tbl_goods_receipt"("warehouse_code");

-- CreateIndex
CREATE INDEX "tbl_goods_receipt_status_idx" ON "tbl_goods_receipt"("status");

-- CreateIndex
CREATE INDEX "tbl_goods_receipt_is_deleted_idx" ON "tbl_goods_receipt"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_goods_receipt_detail_gr_number_idx" ON "tbl_goods_receipt_detail"("gr_number");

-- CreateIndex
CREATE INDEX "tbl_goods_receipt_detail_po_detail_id_idx" ON "tbl_goods_receipt_detail"("po_detail_id");

-- CreateIndex
CREATE INDEX "tbl_goods_receipt_detail_is_deleted_idx" ON "tbl_goods_receipt_detail"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_manufacturing_order_mo_number_key" ON "tbl_manufacturing_order"("mo_number");

-- CreateIndex
CREATE INDEX "tbl_manufacturing_order_mo_number_idx" ON "tbl_manufacturing_order"("mo_number");

-- CreateIndex
CREATE INDEX "tbl_manufacturing_order_reference_type_idx" ON "tbl_manufacturing_order"("reference_type");

-- CreateIndex
CREATE INDEX "tbl_manufacturing_order_so_number_idx" ON "tbl_manufacturing_order"("so_number");

-- CreateIndex
CREATE INDEX "tbl_manufacturing_order_mps_detail_id_idx" ON "tbl_manufacturing_order"("mps_detail_id");

-- CreateIndex
CREATE INDEX "tbl_manufacturing_order_mrp_requirement_id_idx" ON "tbl_manufacturing_order"("mrp_requirement_id");

-- CreateIndex
CREATE INDEX "tbl_manufacturing_order_part_id_idx" ON "tbl_manufacturing_order"("part_id");

-- CreateIndex
CREATE INDEX "tbl_manufacturing_order_status_idx" ON "tbl_manufacturing_order"("status");

-- CreateIndex
CREATE INDEX "tbl_manufacturing_order_planned_start_date_idx" ON "tbl_manufacturing_order"("planned_start_date");

-- CreateIndex
CREATE INDEX "tbl_manufacturing_order_planned_end_date_idx" ON "tbl_manufacturing_order"("planned_end_date");

-- CreateIndex
CREATE INDEX "tbl_manufacturing_order_is_deleted_idx" ON "tbl_manufacturing_order"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_work_order_wo_number_key" ON "tbl_work_order"("wo_number");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_work_order_dies_usage_id_key" ON "tbl_work_order"("dies_usage_id");

-- CreateIndex
CREATE INDEX "tbl_work_order_wo_number_idx" ON "tbl_work_order"("wo_number");

-- CreateIndex
CREATE INDEX "tbl_work_order_mo_id_idx" ON "tbl_work_order"("mo_id");

-- CreateIndex
CREATE INDEX "tbl_work_order_dies_id_idx" ON "tbl_work_order"("dies_id");

-- CreateIndex
CREATE INDEX "tbl_work_order_machine_code_idx" ON "tbl_work_order"("machine_code");

-- CreateIndex
CREATE INDEX "tbl_work_order_shift_idx" ON "tbl_work_order"("shift");

-- CreateIndex
CREATE INDEX "tbl_work_order_planned_date_idx" ON "tbl_work_order"("planned_date");

-- CreateIndex
CREATE INDEX "tbl_work_order_status_idx" ON "tbl_work_order"("status");

-- CreateIndex
CREATE INDEX "tbl_work_order_is_deleted_idx" ON "tbl_work_order"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_notifications_user_id_idx" ON "tbl_notifications"("user_id");

-- CreateIndex
CREATE INDEX "tbl_notifications_type_idx" ON "tbl_notifications"("type");

-- CreateIndex
CREATE INDEX "tbl_notifications_is_read_idx" ON "tbl_notifications"("is_read");

-- CreateIndex
CREATE INDEX "tbl_notifications_created_at_idx" ON "tbl_notifications"("created_at");

-- AddForeignKey
ALTER TABLE "tbl_customer" ADD CONSTRAINT "tbl_customer_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "tbl_currency"("currency_code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_entity_vendorprocess" ADD CONSTRAINT "tbl_entity_vendorprocess_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "tbl_vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_entity_vendorprocess" ADD CONSTRAINT "tbl_entity_vendorprocess_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "tbl_supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_entity_vendorprocess" ADD CONSTRAINT "tbl_entity_vendorprocess_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "tbl_vendor_pricelist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_entity_vendorprocess" ADD CONSTRAINT "tbl_entity_vendorprocess_vendor_process_id_fkey" FOREIGN KEY ("vendor_process_id") REFERENCES "tbl_vendor_process"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_part" ADD CONSTRAINT "tbl_part_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "tbl_material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_part" ADD CONSTRAINT "tbl_part_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "tbl_supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_dies_part" ADD CONSTRAINT "tbl_dies_part_dies_id_fkey" FOREIGN KEY ("dies_id") REFERENCES "tbl_dies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_dies_part" ADD CONSTRAINT "tbl_dies_part_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "tbl_part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_dies_maintenance" ADD CONSTRAINT "tbl_dies_maintenance_dies_id_fkey" FOREIGN KEY ("dies_id") REFERENCES "tbl_dies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_dies_usage" ADD CONSTRAINT "tbl_dies_usage_dies_id_fkey" FOREIGN KEY ("dies_id") REFERENCES "tbl_dies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_dies_usage" ADD CONSTRAINT "tbl_dies_usage_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "tbl_part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_part_base" ADD CONSTRAINT "tbl_part_base_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "tbl_part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_part_attachment" ADD CONSTRAINT "tbl_part_attachment_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "tbl_part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_subprocess" ADD CONSTRAINT "tbl_subprocess_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "tbl_process"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_vendor_pricelist" ADD CONSTRAINT "tbl_vendor_pricelist_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "tbl_currency"("currency_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_vendor_pricelist" ADD CONSTRAINT "tbl_vendor_pricelist_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "tbl_vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_vendor_pricelist" ADD CONSTRAINT "tbl_vendor_pricelist_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "tbl_part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_vendor_pricelist" ADD CONSTRAINT "tbl_vendor_pricelist_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "tbl_customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_part_pricelist" ADD CONSTRAINT "tbl_part_pricelist_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "tbl_currency"("currency_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_part_pricelist" ADD CONSTRAINT "tbl_part_pricelist_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "tbl_part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_material_pricelist" ADD CONSTRAINT "tbl_material_pricelist_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "tbl_currency"("currency_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_material_pricelist" ADD CONSTRAINT "tbl_material_pricelist_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "tbl_material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_material_pricelist" ADD CONSTRAINT "tbl_material_pricelist_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "tbl_supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_division" ADD CONSTRAINT "tbl_division_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "tbl_department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_employee" ADD CONSTRAINT "tbl_employee_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "tbl_department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_employee" ADD CONSTRAINT "tbl_employee_division_id_fkey" FOREIGN KEY ("division_id") REFERENCES "tbl_division"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_product" ADD CONSTRAINT "tbl_product_uom_code_fkey" FOREIGN KEY ("uom_code") REFERENCES "tbl_uom"("uom_code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_product_pricelist" ADD CONSTRAINT "tbl_product_pricelist_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "tbl_currency"("currency_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_product_pricelist" ADD CONSTRAINT "tbl_product_pricelist_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "tbl_product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_product_pricelist" ADD CONSTRAINT "tbl_product_pricelist_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "tbl_supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_ebomheader" ADD CONSTRAINT "tbl_ebomheader_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "tbl_part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_ebomheader" ADD CONSTRAINT "tbl_ebomheader_uom_code_fkey" FOREIGN KEY ("uom_code") REFERENCES "tbl_uom"("uom_code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_ebomdetail" ADD CONSTRAINT "tbl_ebomdetail_no_reg_fkey" FOREIGN KEY ("no_reg") REFERENCES "tbl_ebomheader"("no_reg") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_ebomdetail" ADD CONSTRAINT "tbl_ebomdetail_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "tbl_part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_ebomdetail" ADD CONSTRAINT "tbl_ebomdetail_uom_code_fkey" FOREIGN KEY ("uom_code") REFERENCES "tbl_uom"("uom_code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_ebomprocess" ADD CONSTRAINT "tbl_ebomprocess_ebom_detail_id_fkey" FOREIGN KEY ("ebom_detail_id") REFERENCES "tbl_ebomdetail"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_ebomprocess" ADD CONSTRAINT "tbl_ebomprocess_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "tbl_process"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_ebomprocess" ADD CONSTRAINT "tbl_ebomprocess_sub_process_id_fkey" FOREIGN KEY ("sub_process_id") REFERENCES "tbl_subprocess"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_ebomprocess" ADD CONSTRAINT "tbl_ebomprocess_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "tbl_ebomprocess"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_ebomcost_header" ADD CONSTRAINT "tbl_ebomcost_header_ebom_id_fkey" FOREIGN KEY ("ebom_id") REFERENCES "tbl_ebomheader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_ebomcost_header" ADD CONSTRAINT "tbl_ebomcost_header_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "tbl_currency"("currency_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_ebomcost_detail" ADD CONSTRAINT "tbl_ebomcost_detail_ebom_cost_header_id_fkey" FOREIGN KEY ("ebom_cost_header_id") REFERENCES "tbl_ebomcost_header"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_ebomcost_detail" ADD CONSTRAINT "tbl_ebomcost_detail_ebom_detail_id_fkey" FOREIGN KEY ("ebom_detail_id") REFERENCES "tbl_ebomdetail"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_ebomcost_detail" ADD CONSTRAINT "tbl_ebomcost_detail_ebom_process_id_fkey" FOREIGN KEY ("ebom_process_id") REFERENCES "tbl_ebomprocess"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mbomheader" ADD CONSTRAINT "tbl_mbomheader_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "tbl_part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mbomheader" ADD CONSTRAINT "tbl_mbomheader_uom_code_fkey" FOREIGN KEY ("uom_code") REFERENCES "tbl_uom"("uom_code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mbomdetail" ADD CONSTRAINT "tbl_mbomdetail_no_reg_fkey" FOREIGN KEY ("no_reg") REFERENCES "tbl_mbomheader"("no_reg") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mbomdetail" ADD CONSTRAINT "tbl_mbomdetail_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "tbl_part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mbomdetail" ADD CONSTRAINT "tbl_mbomdetail_uom_code_fkey" FOREIGN KEY ("uom_code") REFERENCES "tbl_uom"("uom_code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mbomprocess" ADD CONSTRAINT "tbl_mbomprocess_bom_detail_id_fkey" FOREIGN KEY ("bom_detail_id") REFERENCES "tbl_mbomdetail"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mbomprocess" ADD CONSTRAINT "tbl_mbomprocess_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "tbl_process"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mbomcost_header" ADD CONSTRAINT "tbl_mbomcost_header_mbom_id_fkey" FOREIGN KEY ("mbom_id") REFERENCES "tbl_mbomheader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mbomcost_header" ADD CONSTRAINT "tbl_mbomcost_header_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "tbl_currency"("currency_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mbomcost_detail" ADD CONSTRAINT "tbl_mbomcost_detail_mbom_cost_header_id_fkey" FOREIGN KEY ("mbom_cost_header_id") REFERENCES "tbl_mbomcost_header"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mbomcost_detail" ADD CONSTRAINT "tbl_mbomcost_detail_mbom_detail_id_fkey" FOREIGN KEY ("mbom_detail_id") REFERENCES "tbl_mbomdetail"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mbomcost_detail" ADD CONSTRAINT "tbl_mbomcost_detail_mbom_process_id_fkey" FOREIGN KEY ("mbom_process_id") REFERENCES "tbl_mbomprocess"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_quotationheader" ADD CONSTRAINT "tbl_quotationheader_customer_code_fkey" FOREIGN KEY ("customer_code") REFERENCES "tbl_customer"("customer_code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_quotationheader" ADD CONSTRAINT "tbl_quotationheader_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "tbl_currency"("currency_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_quotationdetail" ADD CONSTRAINT "tbl_quotationdetail_quotation_number_fkey" FOREIGN KEY ("quotation_number") REFERENCES "tbl_quotationheader"("quotation_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_quotationdetail" ADD CONSTRAINT "tbl_quotationdetail_part_code_fkey" FOREIGN KEY ("part_code") REFERENCES "tbl_part"("part_code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_quotationdetail" ADD CONSTRAINT "tbl_quotationdetail_uom_code_fkey" FOREIGN KEY ("uom_code") REFERENCES "tbl_uom"("uom_code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_quotationdetail" ADD CONSTRAINT "tbl_quotationdetail_mbom_header_id_fkey" FOREIGN KEY ("mbom_header_id") REFERENCES "tbl_mbomheader"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_salesorderheader" ADD CONSTRAINT "tbl_salesorderheader_customer_code_fkey" FOREIGN KEY ("customer_code") REFERENCES "tbl_customer"("customer_code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_salesorderheader" ADD CONSTRAINT "tbl_salesorderheader_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "tbl_currency"("currency_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_salesorderheader" ADD CONSTRAINT "tbl_salesorderheader_quotation_number_fkey" FOREIGN KEY ("quotation_number") REFERENCES "tbl_quotationheader"("quotation_number") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_salesorderdetail" ADD CONSTRAINT "tbl_salesorderdetail_so_number_fkey" FOREIGN KEY ("so_number") REFERENCES "tbl_salesorderheader"("so_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_salesorderdetail" ADD CONSTRAINT "tbl_salesorderdetail_part_code_fkey" FOREIGN KEY ("part_code") REFERENCES "tbl_part"("part_code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_salesorderdetail" ADD CONSTRAINT "tbl_salesorderdetail_uom_code_fkey" FOREIGN KEY ("uom_code") REFERENCES "tbl_uom"("uom_code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_salesorderdetail" ADD CONSTRAINT "tbl_salesorderdetail_mbom_header_id_fkey" FOREIGN KEY ("mbom_header_id") REFERENCES "tbl_mbomheader"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_salesorder_attachment" ADD CONSTRAINT "tbl_salesorder_attachment_so_number_fkey" FOREIGN KEY ("so_number") REFERENCES "tbl_salesorderheader"("so_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_delivery_schedule" ADD CONSTRAINT "tbl_delivery_schedule_so_number_fkey" FOREIGN KEY ("so_number") REFERENCES "tbl_salesorderheader"("so_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_delivery_schedule_detail" ADD CONSTRAINT "tbl_delivery_schedule_detail_schedule_number_fkey" FOREIGN KEY ("schedule_number") REFERENCES "tbl_delivery_schedule"("schedule_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_delivery_schedule_detail" ADD CONSTRAINT "tbl_delivery_schedule_detail_so_detail_id_fkey" FOREIGN KEY ("so_detail_id") REFERENCES "tbl_salesorderdetail"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_stock_balance" ADD CONSTRAINT "tbl_stock_balance_warehouse_code_fkey" FOREIGN KEY ("warehouse_code") REFERENCES "tbl_warehouse"("warehouse_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_stock_balance" ADD CONSTRAINT "tbl_stock_balance_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "tbl_product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_stock_movement" ADD CONSTRAINT "tbl_stock_movement_warehouse_code_fkey" FOREIGN KEY ("warehouse_code") REFERENCES "tbl_warehouse"("warehouse_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_stock_movement" ADD CONSTRAINT "tbl_stock_movement_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "tbl_product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_stock_reservation" ADD CONSTRAINT "tbl_stock_reservation_warehouse_code_fkey" FOREIGN KEY ("warehouse_code") REFERENCES "tbl_warehouse"("warehouse_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_stock_reservation" ADD CONSTRAINT "tbl_stock_reservation_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "tbl_product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_forecast_detail" ADD CONSTRAINT "tbl_forecast_detail_forecast_number_fkey" FOREIGN KEY ("forecast_number") REFERENCES "tbl_forecast"("forecast_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_forecast_detail" ADD CONSTRAINT "tbl_forecast_detail_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "tbl_part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mps_detail" ADD CONSTRAINT "tbl_mps_detail_mps_number_fkey" FOREIGN KEY ("mps_number") REFERENCES "tbl_mps"("mps_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mps_detail" ADD CONSTRAINT "tbl_mps_detail_mbom_header_id_fkey" FOREIGN KEY ("mbom_header_id") REFERENCES "tbl_mbomheader"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mps_detail" ADD CONSTRAINT "tbl_mps_detail_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "tbl_part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mps_detail" ADD CONSTRAINT "tbl_mps_detail_forecast_detail_id_fkey" FOREIGN KEY ("forecast_detail_id") REFERENCES "tbl_forecast_detail"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mrp_run" ADD CONSTRAINT "tbl_mrp_run_mps_number_fkey" FOREIGN KEY ("mps_number") REFERENCES "tbl_mps"("mps_number") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mrp_requirement" ADD CONSTRAINT "tbl_mrp_requirement_run_number_fkey" FOREIGN KEY ("run_number") REFERENCES "tbl_mrp_run"("run_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mrp_requirement" ADD CONSTRAINT "tbl_mrp_requirement_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "tbl_part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mrp_requirement" ADD CONSTRAINT "tbl_mrp_requirement_mps_detail_id_fkey" FOREIGN KEY ("mps_detail_id") REFERENCES "tbl_mps_detail"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_planned_order" ADD CONSTRAINT "tbl_planned_order_run_number_fkey" FOREIGN KEY ("run_number") REFERENCES "tbl_mrp_run"("run_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_planned_order" ADD CONSTRAINT "tbl_planned_order_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "tbl_part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_purchase_requisition" ADD CONSTRAINT "tbl_purchase_requisition_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "tbl_department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_purchase_requisition_detail" ADD CONSTRAINT "tbl_purchase_requisition_detail_pr_number_fkey" FOREIGN KEY ("pr_number") REFERENCES "tbl_purchase_requisition"("pr_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_purchase_requisition_detail" ADD CONSTRAINT "tbl_purchase_requisition_detail_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "tbl_product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_purchase_order" ADD CONSTRAINT "tbl_purchase_order_supplier_code_fkey" FOREIGN KEY ("supplier_code") REFERENCES "tbl_supplier"("supplier_code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_purchase_order" ADD CONSTRAINT "tbl_purchase_order_vendor_code_fkey" FOREIGN KEY ("vendor_code") REFERENCES "tbl_vendor"("vendor_code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_purchase_order_pr" ADD CONSTRAINT "tbl_purchase_order_pr_po_number_fkey" FOREIGN KEY ("po_number") REFERENCES "tbl_purchase_order"("po_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_purchase_order_pr" ADD CONSTRAINT "tbl_purchase_order_pr_pr_number_fkey" FOREIGN KEY ("pr_number") REFERENCES "tbl_purchase_requisition"("pr_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_purchase_order_detail" ADD CONSTRAINT "tbl_purchase_order_detail_po_number_fkey" FOREIGN KEY ("po_number") REFERENCES "tbl_purchase_order"("po_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_purchase_order_detail" ADD CONSTRAINT "tbl_purchase_order_detail_pr_detail_id_fkey" FOREIGN KEY ("pr_detail_id") REFERENCES "tbl_purchase_requisition_detail"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_purchase_order_detail" ADD CONSTRAINT "tbl_purchase_order_detail_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "tbl_product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_goods_receipt" ADD CONSTRAINT "tbl_goods_receipt_po_number_fkey" FOREIGN KEY ("po_number") REFERENCES "tbl_purchase_order"("po_number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_goods_receipt" ADD CONSTRAINT "tbl_goods_receipt_warehouse_code_fkey" FOREIGN KEY ("warehouse_code") REFERENCES "tbl_warehouse"("warehouse_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_goods_receipt_detail" ADD CONSTRAINT "tbl_goods_receipt_detail_gr_number_fkey" FOREIGN KEY ("gr_number") REFERENCES "tbl_goods_receipt"("gr_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_goods_receipt_detail" ADD CONSTRAINT "tbl_goods_receipt_detail_po_detail_id_fkey" FOREIGN KEY ("po_detail_id") REFERENCES "tbl_purchase_order_detail"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_manufacturing_order" ADD CONSTRAINT "tbl_manufacturing_order_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "tbl_part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_manufacturing_order" ADD CONSTRAINT "tbl_manufacturing_order_so_number_fkey" FOREIGN KEY ("so_number") REFERENCES "tbl_salesorderheader"("so_number") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_work_order" ADD CONSTRAINT "tbl_work_order_mo_id_fkey" FOREIGN KEY ("mo_id") REFERENCES "tbl_manufacturing_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_work_order" ADD CONSTRAINT "tbl_work_order_dies_id_fkey" FOREIGN KEY ("dies_id") REFERENCES "tbl_dies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_work_order" ADD CONSTRAINT "tbl_work_order_dies_usage_id_fkey" FOREIGN KEY ("dies_usage_id") REFERENCES "tbl_dies_usage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
