CREATE TABLE "tbl_main_business" (
  "id" TEXT NOT NULL,
  "main_business_code" TEXT NOT NULL,
  "main_business_name" TEXT,
  "notes" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "tbl_main_business_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tbl_vendor_main_business" (
  "id" TEXT NOT NULL,
  "vendor_id" TEXT NOT NULL,
  "main_business_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tbl_vendor_main_business_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tbl_supplier_main_business" (
  "id" TEXT NOT NULL,
  "supplier_id" TEXT NOT NULL,
  "main_business_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tbl_supplier_main_business_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tbl_main_business_main_business_code_key" ON "tbl_main_business"("main_business_code");
CREATE INDEX "tbl_main_business_main_business_code_idx" ON "tbl_main_business"("main_business_code");
CREATE INDEX "tbl_main_business_main_business_name_idx" ON "tbl_main_business"("main_business_name");
CREATE INDEX "tbl_main_business_is_deleted_idx" ON "tbl_main_business"("is_deleted");

CREATE UNIQUE INDEX "tbl_vendor_main_business_vendor_id_main_business_id_key"
ON "tbl_vendor_main_business"("vendor_id", "main_business_id");
CREATE INDEX "tbl_vendor_main_business_vendor_id_idx" ON "tbl_vendor_main_business"("vendor_id");
CREATE INDEX "tbl_vendor_main_business_main_business_id_idx" ON "tbl_vendor_main_business"("main_business_id");

CREATE UNIQUE INDEX "tbl_supplier_main_business_supplier_id_main_business_id_key"
ON "tbl_supplier_main_business"("supplier_id", "main_business_id");
CREATE INDEX "tbl_supplier_main_business_supplier_id_idx" ON "tbl_supplier_main_business"("supplier_id");
CREATE INDEX "tbl_supplier_main_business_main_business_id_idx" ON "tbl_supplier_main_business"("main_business_id");

ALTER TABLE "tbl_vendor_main_business"
ADD CONSTRAINT "tbl_vendor_main_business_vendor_id_fkey"
FOREIGN KEY ("vendor_id") REFERENCES "tbl_vendor"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_vendor_main_business"
ADD CONSTRAINT "tbl_vendor_main_business_main_business_id_fkey"
FOREIGN KEY ("main_business_id") REFERENCES "tbl_main_business"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_supplier_main_business"
ADD CONSTRAINT "tbl_supplier_main_business_supplier_id_fkey"
FOREIGN KEY ("supplier_id") REFERENCES "tbl_supplier"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_supplier_main_business"
ADD CONSTRAINT "tbl_supplier_main_business_main_business_id_fkey"
FOREIGN KEY ("main_business_id") REFERENCES "tbl_main_business"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "tbl_main_business" (
  "id",
  "main_business_code",
  "main_business_name",
  "notes",
  "is_deleted",
  "created_at",
  "updated_at"
)
SELECT
  md5(vp."id" || ':main_business'),
  vp."vendor_process_code",
  vp."vendor_process_name",
  vp."notes",
  vp."is_deleted",
  NOW(),
  NOW()
FROM "tbl_vendor_process" vp
WHERE EXISTS (
  SELECT 1
  FROM "tbl_entity_vendorprocess" evp
  WHERE evp."vendor_process_id" = vp."id"
    AND evp."entity_type" IN ('vendor', 'supplier')
)
ON CONFLICT ("main_business_code") DO NOTHING;

INSERT INTO "tbl_vendor_main_business" (
  "id",
  "vendor_id",
  "main_business_id",
  "created_at"
)
SELECT DISTINCT
  md5(evp."id" || ':vendor_main_business'),
  evp."vendor_id",
  mb."id",
  NOW()
FROM "tbl_entity_vendorprocess" evp
JOIN "tbl_vendor_process" vp ON vp."id" = evp."vendor_process_id"
JOIN "tbl_main_business" mb ON mb."main_business_code" = vp."vendor_process_code"
WHERE evp."entity_type" = 'vendor'
  AND evp."vendor_id" IS NOT NULL
ON CONFLICT ("vendor_id", "main_business_id") DO NOTHING;

INSERT INTO "tbl_supplier_main_business" (
  "id",
  "supplier_id",
  "main_business_id",
  "created_at"
)
SELECT DISTINCT
  md5(evp."id" || ':supplier_main_business'),
  evp."supplier_id",
  mb."id",
  NOW()
FROM "tbl_entity_vendorprocess" evp
JOIN "tbl_vendor_process" vp ON vp."id" = evp."vendor_process_id"
JOIN "tbl_main_business" mb ON mb."main_business_code" = vp."vendor_process_code"
WHERE evp."entity_type" = 'supplier'
  AND evp."supplier_id" IS NOT NULL
ON CONFLICT ("supplier_id", "main_business_id") DO NOTHING;
