-- Hapus qty_rejected dari detail GR karena rejected diproses di incoming inspection.
-- Tambah lampiran surat jalan per detail GR (JSON array file metadata).
ALTER TABLE "tbl_goods_receipt_detail"
  DROP COLUMN IF EXISTS "qty_rejected",
  ADD COLUMN "delivery_note_files" JSONB;
