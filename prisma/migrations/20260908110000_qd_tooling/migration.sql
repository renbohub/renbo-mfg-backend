CREATE TABLE "tbl_qd_type" (
  "id" TEXT PRIMARY KEY, "type_code" TEXT NOT NULL, "type_name" TEXT NOT NULL,
  "dimension_a" DOUBLE PRECISION NOT NULL, "dimension_b" DOUBLE PRECISION NOT NULL,
  "dimension_unit" TEXT NOT NULL DEFAULT 'mm', "preferred_class" TEXT, "notes" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true, "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "qd_dimensions_positive" CHECK ("dimension_a" > 0 AND "dimension_b" > 0)
);
CREATE UNIQUE INDEX "tbl_qd_type_type_code_key" ON "tbl_qd_type"("type_code");
CREATE TABLE "tbl_qd_unit" (
  "id" TEXT PRIMARY KEY, "qd_code" TEXT NOT NULL, "qd_name" TEXT NOT NULL, "qd_number" TEXT,
  "qd_type_id" TEXT NOT NULL, "status" "DiesStatus" NOT NULL DEFAULT 'Active', "location" TEXT, "notes" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_qd_unit_qd_type_id_fkey" FOREIGN KEY ("qd_type_id") REFERENCES "tbl_qd_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "tbl_qd_unit_qd_code_key" ON "tbl_qd_unit"("qd_code");
CREATE INDEX "tbl_qd_unit_qd_type_id_idx" ON "tbl_qd_unit"("qd_type_id");
CREATE TABLE "tbl_qd_unit_dies" (
  "id" TEXT PRIMARY KEY, "qd_unit_id" TEXT NOT NULL, "dies_id" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_qd_unit_dies_qd_unit_id_fkey" FOREIGN KEY ("qd_unit_id") REFERENCES "tbl_qd_unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tbl_qd_unit_dies_dies_id_fkey" FOREIGN KEY ("dies_id") REFERENCES "tbl_dies"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "tbl_qd_unit_dies_qd_unit_id_dies_id_key" ON "tbl_qd_unit_dies"("qd_unit_id", "dies_id");
CREATE INDEX "tbl_qd_unit_dies_dies_id_idx" ON "tbl_qd_unit_dies"("dies_id");
ALTER TABLE "tbl_dies" ADD COLUMN "size_class" TEXT;

-- Ukuran dari pengguna. Tidak mengasumsikan jumlah unit fisik atau isi dies.
INSERT INTO "tbl_qd_type" ("id", "type_code", "type_name", "dimension_a", "dimension_b", "preferred_class", "notes", "updated_at") VALUES
  ('aa4ddf79-1a7c-447e-9432-0c1993d26101','QD_SMALL','Small',210,210,'SMALL','Ukuran Mitindo; satuan mm diasumsikan. Kelas ukuran adalah rekomendasi. Dies digunakan bergantian.',CURRENT_TIMESTAMP),
  ('aa4ddf79-1a7c-447e-9432-0c1993d26102','QD_MEDIUM','Besar Kecil',300,400,'MEDIUM','Ukuran Mitindo; satuan mm diasumsikan. Kelas ukuran adalah rekomendasi. Dies digunakan bergantian.',CURRENT_TIMESTAMP),
  ('aa4ddf79-1a7c-447e-9432-0c1993d26103','QD_LARGE','Besar',300,600,'LARGE','Ukuran Mitindo; satuan mm diasumsikan. Kelas ukuran adalah rekomendasi. Dies digunakan bergantian.',CURRENT_TIMESTAMP);
