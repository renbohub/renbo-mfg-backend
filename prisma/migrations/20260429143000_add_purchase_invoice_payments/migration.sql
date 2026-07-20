-- Add payment plan/history rows for purchase invoices.
CREATE TABLE "tbl_purchase_invoice_payment" (
    "id" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "line_number" INTEGER NOT NULL,
    "payment_plan" TEXT,
    "planned_payment_date" TIMESTAMP(3),
    "actual_payment_date" TIMESTAMP(3),
    "amount_payment" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "outstanding_payment" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_purchase_invoice_payment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tbl_purchase_invoice_payment_invoice_number_idx" ON "tbl_purchase_invoice_payment"("invoice_number");
CREATE INDEX "tbl_purchase_invoice_payment_actual_payment_date_idx" ON "tbl_purchase_invoice_payment"("actual_payment_date");
CREATE INDEX "tbl_purchase_invoice_payment_planned_payment_date_idx" ON "tbl_purchase_invoice_payment"("planned_payment_date");

ALTER TABLE "tbl_purchase_invoice_payment" ADD CONSTRAINT "tbl_purchase_invoice_payment_invoice_number_fkey" FOREIGN KEY ("invoice_number") REFERENCES "tbl_purchase_invoice"("invoice_number") ON DELETE CASCADE ON UPDATE CASCADE;
