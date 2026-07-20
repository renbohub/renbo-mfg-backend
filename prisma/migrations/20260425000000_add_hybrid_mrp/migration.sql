-- CreateTable
CREATE TABLE "tbl_mrp_dirty_item" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source_number" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "processed_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_mrp_dirty_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_bom_relation" (
    "id" TEXT NOT NULL,
    "parent_item_id" TEXT NOT NULL,
    "child_item_id" TEXT NOT NULL,
    "mbom_header_id" TEXT,
    "level_component" INTEGER NOT NULL DEFAULT 0,
    "effective_date" TIMESTAMP(3),
    "expiry_date" TIMESTAMP(3),
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_bom_relation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_item_level" (
    "id" TEXT NOT NULL,
    "root_item_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 0,
    "path" TEXT,
    "source_type" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_item_level_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_mrp_pegging" (
    "id" TEXT NOT NULL,
    "demand_type" TEXT NOT NULL,
    "demand_number" TEXT NOT NULL,
    "demand_line_number" INTEGER,
    "supply_type" TEXT NOT NULL,
    "supply_number" TEXT NOT NULL,
    "supply_line_number" INTEGER,
    "item_id" TEXT NOT NULL,
    "qty_pegged" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_mrp_pegging_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_mrp_partial_snapshot" (
    "id" TEXT NOT NULL,
    "snapshot_number" TEXT NOT NULL,
    "snapshot_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "run_scope" TEXT NOT NULL DEFAULT 'Partial',
    "cutoff_date" TIMESTAMP(3),
    "dirty_count" INTEGER NOT NULL DEFAULT 0,
    "impacted_count" INTEGER NOT NULL DEFAULT 0,
    "mps_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'Completed',
    "snapshot_json" JSONB NOT NULL,
    "results_json" JSONB,
    "notes" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_mrp_partial_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tbl_mrp_dirty_item_item_id_idx" ON "tbl_mrp_dirty_item"("item_id");
CREATE INDEX "tbl_mrp_dirty_item_reason_idx" ON "tbl_mrp_dirty_item"("reason");
CREATE INDEX "tbl_mrp_dirty_item_status_idx" ON "tbl_mrp_dirty_item"("status");
CREATE INDEX "tbl_mrp_dirty_item_source_number_idx" ON "tbl_mrp_dirty_item"("source_number");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_bom_relation_parent_item_id_child_item_id_mbom_header_id_key" ON "tbl_bom_relation"("parent_item_id", "child_item_id", "mbom_header_id");
CREATE INDEX "tbl_bom_relation_parent_item_id_idx" ON "tbl_bom_relation"("parent_item_id");
CREATE INDEX "tbl_bom_relation_child_item_id_idx" ON "tbl_bom_relation"("child_item_id");
CREATE INDEX "tbl_bom_relation_mbom_header_id_idx" ON "tbl_bom_relation"("mbom_header_id");
CREATE INDEX "tbl_bom_relation_level_component_idx" ON "tbl_bom_relation"("level_component");
CREATE INDEX "tbl_bom_relation_is_deleted_idx" ON "tbl_bom_relation"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_item_level_root_item_id_item_id_key" ON "tbl_item_level"("root_item_id", "item_id");
CREATE INDEX "tbl_item_level_root_item_id_idx" ON "tbl_item_level"("root_item_id");
CREATE INDEX "tbl_item_level_item_id_idx" ON "tbl_item_level"("item_id");
CREATE INDEX "tbl_item_level_level_idx" ON "tbl_item_level"("level");
CREATE INDEX "tbl_item_level_is_active_idx" ON "tbl_item_level"("is_active");

-- CreateIndex
CREATE INDEX "tbl_mrp_pegging_demand_type_idx" ON "tbl_mrp_pegging"("demand_type");
CREATE INDEX "tbl_mrp_pegging_demand_number_idx" ON "tbl_mrp_pegging"("demand_number");
CREATE INDEX "tbl_mrp_pegging_supply_type_idx" ON "tbl_mrp_pegging"("supply_type");
CREATE INDEX "tbl_mrp_pegging_supply_number_idx" ON "tbl_mrp_pegging"("supply_number");
CREATE INDEX "tbl_mrp_pegging_item_id_idx" ON "tbl_mrp_pegging"("item_id");
CREATE INDEX "tbl_mrp_pegging_status_idx" ON "tbl_mrp_pegging"("status");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_mrp_partial_snapshot_snapshot_number_key" ON "tbl_mrp_partial_snapshot"("snapshot_number");
CREATE INDEX "tbl_mrp_partial_snapshot_snapshot_date_idx" ON "tbl_mrp_partial_snapshot"("snapshot_date");
CREATE INDEX "tbl_mrp_partial_snapshot_run_scope_idx" ON "tbl_mrp_partial_snapshot"("run_scope");
CREATE INDEX "tbl_mrp_partial_snapshot_status_idx" ON "tbl_mrp_partial_snapshot"("status");

-- AddForeignKey
ALTER TABLE "tbl_mrp_dirty_item" ADD CONSTRAINT "tbl_mrp_dirty_item_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "tbl_part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_bom_relation" ADD CONSTRAINT "tbl_bom_relation_parent_item_id_fkey" FOREIGN KEY ("parent_item_id") REFERENCES "tbl_part"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tbl_bom_relation" ADD CONSTRAINT "tbl_bom_relation_child_item_id_fkey" FOREIGN KEY ("child_item_id") REFERENCES "tbl_part"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tbl_bom_relation" ADD CONSTRAINT "tbl_bom_relation_mbom_header_id_fkey" FOREIGN KEY ("mbom_header_id") REFERENCES "tbl_mbomheader"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tbl_item_level" ADD CONSTRAINT "tbl_item_level_root_item_id_fkey" FOREIGN KEY ("root_item_id") REFERENCES "tbl_part"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tbl_item_level" ADD CONSTRAINT "tbl_item_level_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "tbl_part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_mrp_pegging" ADD CONSTRAINT "tbl_mrp_pegging_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "tbl_part"("id") ON DELETE CASCADE ON UPDATE CASCADE;
