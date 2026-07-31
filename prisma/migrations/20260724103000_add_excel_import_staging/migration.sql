CREATE TABLE IF NOT EXISTS "tbl_excel_import_batch" (
  "id" TEXT NOT NULL,
  "batch_number" TEXT NOT NULL,
  "file_name" TEXT NOT NULL,
  "file_type" TEXT NOT NULL,
  "source_checksum" TEXT,
  "source_period" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PREVIEW',
  "row_count" INTEGER NOT NULL DEFAULT 0,
  "error_count" INTEGER NOT NULL DEFAULT 0,
  "metadata" JSONB,
  "notes" TEXT,
  "created_by" TEXT,
  "approved_by" TEXT,
  "approved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_excel_import_batch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "tbl_excel_import_batch_batch_number_key" ON "tbl_excel_import_batch"("batch_number");
CREATE INDEX IF NOT EXISTS "tbl_excel_import_batch_file_type_idx" ON "tbl_excel_import_batch"("file_type");
CREATE INDEX IF NOT EXISTS "tbl_excel_import_batch_source_period_idx" ON "tbl_excel_import_batch"("source_period");
CREATE INDEX IF NOT EXISTS "tbl_excel_import_batch_status_idx" ON "tbl_excel_import_batch"("status");
CREATE INDEX IF NOT EXISTS "tbl_excel_import_batch_created_at_idx" ON "tbl_excel_import_batch"("created_at");

CREATE TABLE IF NOT EXISTS "tbl_excel_import_row" (
  "id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "sheet_name" TEXT NOT NULL,
  "row_number" INTEGER NOT NULL,
  "source_json" JSONB NOT NULL,
  "mapped_json" JSONB,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "error_code" TEXT,
  "error_message" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_excel_import_row_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_excel_import_row_batch_fk" FOREIGN KEY ("batch_id") REFERENCES "tbl_excel_import_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "tbl_excel_import_row_batch_sheet_row_key" ON "tbl_excel_import_row"("batch_id", "sheet_name", "row_number");
CREATE INDEX IF NOT EXISTS "tbl_excel_import_row_batch_id_idx" ON "tbl_excel_import_row"("batch_id");
CREATE INDEX IF NOT EXISTS "tbl_excel_import_row_status_idx" ON "tbl_excel_import_row"("status");
CREATE INDEX IF NOT EXISTS "tbl_excel_import_row_sheet_name_idx" ON "tbl_excel_import_row"("sheet_name");
