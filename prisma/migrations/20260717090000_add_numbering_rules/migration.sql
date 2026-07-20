CREATE TABLE "tbl_numbering_rules" (
  "id" TEXT NOT NULL,
  "rule_key" TEXT NOT NULL,
  "rule_name" TEXT NOT NULL,
  "prefix" TEXT NOT NULL DEFAULT '',
  "pattern" TEXT NOT NULL DEFAULT '{PREFIX}-{SEQ}',
  "sequence_length" INTEGER NOT NULL DEFAULT 4,
  "next_number" INTEGER NOT NULL DEFAULT 1,
  "increment_by" INTEGER NOT NULL DEFAULT 1,
  "reset_policy" TEXT NOT NULL DEFAULT 'NONE',
  "last_reset_key" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "notes" TEXT,
  "updated_by" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_numbering_rules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tbl_numbering_rules_rule_key_key" ON "tbl_numbering_rules"("rule_key");
CREATE INDEX "tbl_numbering_rules_rule_key_idx" ON "tbl_numbering_rules"("rule_key");
CREATE INDEX "tbl_numbering_rules_is_active_idx" ON "tbl_numbering_rules"("is_active");
CREATE INDEX "tbl_numbering_rules_is_deleted_idx" ON "tbl_numbering_rules"("is_deleted");

INSERT INTO "tbl_numbering_rules" ("id","rule_key","rule_name","prefix","pattern","sequence_length","next_number","increment_by","reset_policy","notes","updated_at") VALUES
('f1000000-0000-4000-8000-000000000001','PART_STANDARD','Part Standard','','{CUSTOMER}-{SEQ}-000',4,1,1,'NONE','Token: CUSTOMER, SEQ',CURRENT_TIMESTAMP),
('f1000000-0000-4000-8000-000000000002','PART_COMPONENT','Child/Component Part','','{CUSTOMER}-C{SEQ}-000',3,1,1,'NONE','Token: CUSTOMER, SEQ',CURRENT_TIMESTAMP),
('f1000000-0000-4000-8000-000000000003','PART_RAW','Raw Material / Purchase Part','','{SEQ}-{REV}',3,1,1,'NONE','Token: SEQ, REV',CURRENT_TIMESTAMP),
('f1000000-0000-4000-8000-000000000004','MBOM','Manufacturing BOM','MBOM','{PREFIX}-{YYYY}{MM}{DD}-{SEQ}',3,1,1,'DAILY','Token tanggal dan sequence',CURRENT_TIMESTAMP),
('f1000000-0000-4000-8000-000000000005','PURCHASE_ORDER','Purchase Order','PO','{PREFIX}/{CODE}/{MM}/{YYYY}/{SEQ}',2,1,1,'MONTHLY','Purchase document',CURRENT_TIMESTAMP),
('f1000000-0000-4000-8000-000000000006','MANUFACTURING_ORDER','Manufacturing Order','MO','{PREFIX}-{YYYY}{MM}{DD}-{SEQ}',4,1,1,'DAILY','Production document',CURRENT_TIMESTAMP),
('f1000000-0000-4000-8000-000000000007','WORK_ORDER','Work Order','WO','{PREFIX}-{YYYY}{MM}{DD}-{SEQ}',4,1,1,'DAILY','Production document',CURRENT_TIMESTAMP),
('f1000000-0000-4000-8000-000000000008','LOT','Lot Number','LOT','{PREFIX}-{YYYY}{MM}{DD}-{SEQ}',4,1,1,'DAILY','Inventory document',CURRENT_TIMESTAMP),
('f1000000-0000-4000-8000-000000000009','STOCK_MOVEMENT','Stock Movement','MV','{PREFIX}-{YYYY}{MM}{DD}-{SEQ}',4,1,1,'DAILY','Inventory document',CURRENT_TIMESTAMP),
('f1000000-0000-4000-8000-000000000010','GENERIC_DOCUMENT','Dokumen Umum','','{PREFIX}-{YYYY}{MM}{DD}-{SEQ}',4,1,1,'DAILY','Fallback untuk dokumen otomatis lain',CURRENT_TIMESTAMP);
