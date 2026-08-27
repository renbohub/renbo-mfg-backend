CREATE TABLE "tbl_scrap_price_master" (
    "id" TEXT NOT NULL,
    "scrap_code" TEXT NOT NULL,
    "scrap_name" TEXT NOT NULL,
    "material_type" TEXT,
    "part_code" TEXT,
    "price_per_kg" DOUBLE PRECISION NOT NULL,
    "currency_code" TEXT NOT NULL DEFAULT 'IDR',
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_until" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_by" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_scrap_price_master_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tbl_scrap_price_master_scrap_code_key" ON "tbl_scrap_price_master"("scrap_code");
CREATE INDEX "tbl_scrap_price_master_part_code_effective_from_effective_until_idx" ON "tbl_scrap_price_master"("part_code", "effective_from", "effective_until");
CREATE INDEX "tbl_scrap_price_master_material_type_effective_from_effective_until_idx" ON "tbl_scrap_price_master"("material_type", "effective_from", "effective_until");
CREATE INDEX "tbl_scrap_price_master_is_active_idx" ON "tbl_scrap_price_master"("is_active");
CREATE INDEX "tbl_scrap_price_master_is_deleted_idx" ON "tbl_scrap_price_master"("is_deleted");
