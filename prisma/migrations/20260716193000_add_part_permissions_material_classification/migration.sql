-- Part transaction permissions from the Figma Part Detail screen.
ALTER TABLE "tbl_part"
ADD COLUMN IF NOT EXISTS "can_purchase" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "can_manufacture" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "can_sell" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "can_store" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "can_use_in_bom" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "can_subcontract" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "can_track_lot" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "can_track_serial" BOOLEAN NOT NULL DEFAULT true;

-- Material classification used by the Material form/detail screens.
ALTER TABLE "tbl_material"
ADD COLUMN IF NOT EXISTS "material_name" TEXT,
ADD COLUMN IF NOT EXISTS "item_category" TEXT,
ADD COLUMN IF NOT EXISTS "material_family" TEXT,
ADD COLUMN IF NOT EXISTS "material_form" TEXT,
ADD COLUMN IF NOT EXISTS "material_grade" TEXT,
ADD COLUMN IF NOT EXISTS "attribute_set" TEXT,
ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'Draft',
ADD COLUMN IF NOT EXISTS "can_track_lot" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "tbl_material_material_family_idx" ON "tbl_material"("material_family");
CREATE INDEX IF NOT EXISTS "tbl_material_material_form_idx" ON "tbl_material"("material_form");
