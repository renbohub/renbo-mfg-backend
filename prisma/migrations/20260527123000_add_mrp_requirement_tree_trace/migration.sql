-- Add pegging/tree trace fields for MRP requirements.
ALTER TABLE "tbl_mrp_requirement"
  ADD COLUMN "parent_requirement_id" TEXT,
  ADD COLUMN "root_requirement_id" TEXT,
  ADD COLUMN "tree_path" TEXT,
  ADD COLUMN "mbom_level_component" INTEGER,
  ADD COLUMN "mbom_detail_id" TEXT;

ALTER TABLE "tbl_mrp_requirement"
  ADD CONSTRAINT "tbl_mrp_requirement_parent_requirement_id_fkey"
  FOREIGN KEY ("parent_requirement_id")
  REFERENCES "tbl_mrp_requirement"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

ALTER TABLE "tbl_mrp_requirement"
  ADD CONSTRAINT "tbl_mrp_requirement_mbom_detail_id_fkey"
  FOREIGN KEY ("mbom_detail_id")
  REFERENCES "tbl_mbomdetail"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

CREATE INDEX "tbl_mrp_requirement_parent_requirement_id_idx"
  ON "tbl_mrp_requirement"("parent_requirement_id");

CREATE INDEX "tbl_mrp_requirement_root_requirement_id_idx"
  ON "tbl_mrp_requirement"("root_requirement_id");

CREATE INDEX "tbl_mrp_requirement_tree_path_idx"
  ON "tbl_mrp_requirement"("tree_path");

CREATE INDEX "tbl_mrp_requirement_mbom_level_component_idx"
  ON "tbl_mrp_requirement"("mbom_level_component");

CREATE INDEX "tbl_mrp_requirement_mbom_detail_id_idx"
  ON "tbl_mrp_requirement"("mbom_detail_id");
