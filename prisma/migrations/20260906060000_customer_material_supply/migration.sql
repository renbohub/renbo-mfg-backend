CREATE TABLE "tbl_customer_supply_request" (
 "id" TEXT PRIMARY KEY, "request_number" TEXT NOT NULL UNIQUE, "source_key" TEXT UNIQUE,
 "source_run_number" TEXT, "source_requirement_ids" JSONB NOT NULL DEFAULT '[]',
 "customer_code" TEXT NOT NULL, "part_code" TEXT NOT NULL, "material_code" TEXT, "uom_code" TEXT NOT NULL,
 "qty_requested" DOUBLE PRECISION NOT NULL CHECK ("qty_requested" > 0), "required_date" TIMESTAMP(3) NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'REQUESTED', "notes" TEXT, "created_by" TEXT NOT NULL,
 "history" JSONB NOT NULL DEFAULT '[]', "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "tbl_customer_supply_request_customer_code_part_code_required_idx" ON "tbl_customer_supply_request"("customer_code", "part_code", "required_date");
CREATE TABLE "tbl_customer_supply_shipment" (
 "id" TEXT PRIMARY KEY, "request_id" TEXT NOT NULL REFERENCES "tbl_customer_supply_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "qty" DOUBLE PRECISION NOT NULL CHECK ("qty" > 0), "eta" TIMESTAMP(3) NOT NULL, "ready_date" TIMESTAMP(3) NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'PLANNED', "confirmation_reference" TEXT, "confirmed_by" TEXT, "confirmed_at" TIMESTAMP(3),
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
 CHECK ("ready_date" >= "eta")
);
CREATE INDEX "tbl_customer_supply_shipment_request_id_status_ready_date_idx" ON "tbl_customer_supply_shipment"("request_id", "status", "ready_date");
CREATE TABLE "tbl_customer_supply_receipt" (
 "id" TEXT PRIMARY KEY, "receipt_number" TEXT NOT NULL UNIQUE,
 "shipment_id" TEXT NOT NULL REFERENCES "tbl_customer_supply_shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "idempotency_key" TEXT NOT NULL UNIQUE, "received_qty" DOUBLE PRECISION NOT NULL CHECK ("received_qty" > 0),
 "received_date" TIMESTAMP(3) NOT NULL, "warehouse_code" TEXT NOT NULL, "lot_number" TEXT NOT NULL,
 "delivery_note_number" TEXT NOT NULL, "accepted_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
 "rejected_qty" DOUBLE PRECISION NOT NULL DEFAULT 0, "issued_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
 "qc_status" TEXT NOT NULL DEFAULT 'PENDING', "qc_reference" TEXT, "released_at" TIMESTAMP(3),
 "received_by" TEXT NOT NULL, "inspected_by" TEXT,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
 CHECK ("accepted_qty" >= 0 AND "rejected_qty" >= 0 AND "issued_qty" >= 0 AND "issued_qty" <= "accepted_qty" AND "accepted_qty" + "rejected_qty" <= "received_qty")
);
CREATE INDEX "tbl_customer_supply_receipt_shipment_id_qc_status_idx" ON "tbl_customer_supply_receipt"("shipment_id", "qc_status");
CREATE TABLE "tbl_customer_supply_issue" (
 "id" TEXT PRIMARY KEY, "receipt_id" TEXT NOT NULL REFERENCES "tbl_customer_supply_receipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "idempotency_key" TEXT NOT NULL UNIQUE, "qty" DOUBLE PRECISION NOT NULL CHECK ("qty" > 0),
 "reference" TEXT NOT NULL, "performed_by" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "tbl_customer_supply_issue_receipt_id_idx" ON "tbl_customer_supply_issue"("receipt_id");
