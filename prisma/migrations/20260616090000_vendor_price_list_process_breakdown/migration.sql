CREATE TABLE "tbl_vendor_pricelist_detail" (
  "id" TEXT NOT NULL,
  "vendor_price_list_id" TEXT NOT NULL,
  "vendor_process_id" TEXT NOT NULL,
  "sequence" INTEGER,
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

  CONSTRAINT "tbl_vendor_pricelist_detail_pkey" PRIMARY KEY ("id")
);

INSERT INTO "tbl_vendor_pricelist_detail" (
  "id",
  "vendor_price_list_id",
  "vendor_process_id",
  "sequence",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "notes",
  "is_deleted",
  "created_at",
  "updated_at"
)
SELECT
  md5(vpl."id" || ':' || evp."vendor_process_id"),
  vpl."id",
  evp."vendor_process_id",
  ROW_NUMBER() OVER (PARTITION BY vpl."id" ORDER BY evp."created_at", evp."id"),
  vpl."january",
  vpl."february",
  vpl."march",
  vpl."april",
  vpl."may",
  vpl."june",
  vpl."july",
  vpl."august",
  vpl."september",
  vpl."october",
  vpl."november",
  vpl."december",
  vpl."notes",
  vpl."is_deleted",
  NOW(),
  NOW()
FROM "tbl_vendor_pricelist" vpl
JOIN "tbl_entity_vendorprocess" evp ON evp."price_list_id" = vpl."id"
WHERE evp."entity_type" = 'vendorPriceList';

CREATE UNIQUE INDEX "tbl_vendor_pricelist_detail_vendor_price_list_id_vendor_process_id_key"
ON "tbl_vendor_pricelist_detail"("vendor_price_list_id", "vendor_process_id");
CREATE INDEX "tbl_vendor_pricelist_detail_vendor_price_list_id_idx"
ON "tbl_vendor_pricelist_detail"("vendor_price_list_id");
CREATE INDEX "tbl_vendor_pricelist_detail_vendor_process_id_idx"
ON "tbl_vendor_pricelist_detail"("vendor_process_id");
CREATE INDEX "tbl_vendor_pricelist_detail_is_deleted_idx"
ON "tbl_vendor_pricelist_detail"("is_deleted");

ALTER TABLE "tbl_vendor_pricelist_detail"
ADD CONSTRAINT "tbl_vendor_pricelist_detail_vendor_price_list_id_fkey"
FOREIGN KEY ("vendor_price_list_id") REFERENCES "tbl_vendor_pricelist"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_vendor_pricelist_detail"
ADD CONSTRAINT "tbl_vendor_pricelist_detail_vendor_process_id_fkey"
FOREIGN KEY ("vendor_process_id") REFERENCES "tbl_vendor_process"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tbl_purchase_order_detail"
ADD COLUMN "vendor_price_list_id" TEXT,
ADD COLUMN "vendor_price_breakdown" JSONB;

CREATE INDEX "tbl_purchase_order_detail_vendor_price_list_id_idx"
ON "tbl_purchase_order_detail"("vendor_price_list_id");

ALTER TABLE "tbl_purchase_order_detail"
ADD CONSTRAINT "tbl_purchase_order_detail_vendor_price_list_id_fkey"
FOREIGN KEY ("vendor_price_list_id") REFERENCES "tbl_vendor_pricelist"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tbl_vendor_pricelist"
DROP COLUMN "january",
DROP COLUMN "february",
DROP COLUMN "march",
DROP COLUMN "april",
DROP COLUMN "may",
DROP COLUMN "june",
DROP COLUMN "july",
DROP COLUMN "august",
DROP COLUMN "september",
DROP COLUMN "october",
DROP COLUMN "november",
DROP COLUMN "december";
