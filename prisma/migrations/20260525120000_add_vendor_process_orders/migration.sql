CREATE TABLE "tbl_vendor_process_order" (
  "id" TEXT NOT NULL,
  "order_number" TEXT NOT NULL,
  "order_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "mo_id" TEXT NOT NULL,
  "mo_number" TEXT NOT NULL,
  "mbom_header_id" TEXT,
  "mbom_no_reg" TEXT,
  "mbom_detail_id" TEXT,
  "mbom_process_id" TEXT,
  "process_id" TEXT,
  "process_code" TEXT,
  "process_name" TEXT,
  "sequence" INTEGER NOT NULL DEFAULT 0,
  "vendor_code" TEXT,
  "vendor_name" TEXT,
  "input_part_id" TEXT,
  "input_part_code" TEXT,
  "input_part_number" TEXT,
  "input_part_name" TEXT,
  "output_part_id" TEXT,
  "output_part_code" TEXT,
  "output_part_number" TEXT,
  "output_part_name" TEXT,
  "spec" TEXT,
  "thickness" DOUBLE PRECISION,
  "width" DOUBLE PRECISION,
  "CSP" TEXT,
  "stock_type" TEXT NOT NULL DEFAULT 'WIP',
  "qty_planned" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "qty_sent" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "qty_received" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "qty_accepted" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "qty_reject" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "qty_rework" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "qty_scrap" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "uom_code" TEXT,
  "source_warehouse_code" TEXT,
  "source_rack_code" TEXT,
  "source_lot_number" TEXT,
  "vendor_warehouse_code" TEXT,
  "vendor_rack_code" TEXT,
  "vendor_lot_number" TEXT,
  "receive_warehouse_code" TEXT,
  "receive_rack_code" TEXT,
  "receive_lot_number" TEXT,
  "due_date" TIMESTAMP(3),
  "sent_at" TIMESTAMP(3),
  "received_at" TIMESTAMP(3),
  "closed_at" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'Planned',
  "notes" TEXT,
  "created_by" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "tbl_vendor_process_order_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tbl_vendor_process_order_order_number_key"
ON "tbl_vendor_process_order"("order_number");

CREATE INDEX "tbl_vendor_process_order_order_number_idx" ON "tbl_vendor_process_order"("order_number");
CREATE INDEX "tbl_vendor_process_order_mo_id_idx" ON "tbl_vendor_process_order"("mo_id");
CREATE INDEX "tbl_vendor_process_order_mo_number_idx" ON "tbl_vendor_process_order"("mo_number");
CREATE INDEX "tbl_vendor_process_order_mbom_header_id_idx" ON "tbl_vendor_process_order"("mbom_header_id");
CREATE INDEX "tbl_vendor_process_order_mbom_no_reg_idx" ON "tbl_vendor_process_order"("mbom_no_reg");
CREATE INDEX "tbl_vendor_process_order_mbom_detail_id_idx" ON "tbl_vendor_process_order"("mbom_detail_id");
CREATE INDEX "tbl_vendor_process_order_mbom_process_id_idx" ON "tbl_vendor_process_order"("mbom_process_id");
CREATE INDEX "tbl_vendor_process_order_process_id_idx" ON "tbl_vendor_process_order"("process_id");
CREATE INDEX "tbl_vendor_process_order_sequence_idx" ON "tbl_vendor_process_order"("sequence");
CREATE INDEX "tbl_vendor_process_order_vendor_code_idx" ON "tbl_vendor_process_order"("vendor_code");
CREATE INDEX "tbl_vendor_process_order_output_part_code_idx" ON "tbl_vendor_process_order"("output_part_code");
CREATE INDEX "tbl_vendor_process_order_stock_type_idx" ON "tbl_vendor_process_order"("stock_type");
CREATE INDEX "tbl_vendor_process_order_status_idx" ON "tbl_vendor_process_order"("status");
CREATE INDEX "tbl_vendor_process_order_due_date_idx" ON "tbl_vendor_process_order"("due_date");
CREATE INDEX "tbl_vendor_process_order_is_deleted_idx" ON "tbl_vendor_process_order"("is_deleted");

ALTER TABLE "tbl_quality_inspection"
ADD COLUMN "vendor_process_order_id" TEXT;

CREATE INDEX "tbl_quality_inspection_vendor_process_order_id_idx"
ON "tbl_quality_inspection"("vendor_process_order_id");

ALTER TABLE "tbl_quality_inspection"
ADD CONSTRAINT "tbl_quality_inspection_vendor_process_order_id_fkey"
FOREIGN KEY ("vendor_process_order_id") REFERENCES "tbl_vendor_process_order"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
