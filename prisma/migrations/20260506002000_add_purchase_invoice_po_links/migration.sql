-- Allow one purchase invoice to reference multiple purchase orders.
CREATE TABLE "tbl_purchase_invoice_po" (
    "id" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "po_number" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tbl_purchase_invoice_po_pkey" PRIMARY KEY ("id")
);

INSERT INTO "tbl_purchase_invoice_po" ("id", "invoice_number", "po_number", "created_at")
SELECT md5(random()::TEXT || clock_timestamp()::TEXT), "invoice_number", "po_number", CURRENT_TIMESTAMP
FROM "tbl_purchase_invoice"
WHERE "po_number" IS NOT NULL;

CREATE UNIQUE INDEX "tbl_purchase_invoice_po_invoice_number_po_number_key"
ON "tbl_purchase_invoice_po"("invoice_number", "po_number");

CREATE INDEX "tbl_purchase_invoice_po_invoice_number_idx"
ON "tbl_purchase_invoice_po"("invoice_number");

CREATE INDEX "tbl_purchase_invoice_po_po_number_idx"
ON "tbl_purchase_invoice_po"("po_number");

ALTER TABLE "tbl_purchase_invoice_po"
ADD CONSTRAINT "tbl_purchase_invoice_po_invoice_number_fkey"
FOREIGN KEY ("invoice_number") REFERENCES "tbl_purchase_invoice"("invoice_number")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_purchase_invoice_po"
ADD CONSTRAINT "tbl_purchase_invoice_po_po_number_fkey"
FOREIGN KEY ("po_number") REFERENCES "tbl_purchase_order"("po_number")
ON DELETE RESTRICT ON UPDATE CASCADE;
