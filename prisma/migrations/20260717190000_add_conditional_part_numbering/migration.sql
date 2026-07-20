ALTER TABLE "tbl_numbering_rules"
  ADD COLUMN IF NOT EXISTS "process_step" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS "insertion_start" INTEGER NOT NULL DEFAULT 11,
  ADD COLUMN IF NOT EXISTS "sibling_alpha_mode" TEXT NOT NULL DEFAULT 'SAME_PROCESS',
  ADD COLUMN IF NOT EXISTS "inherit_branch_alpha" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "tbl_part"
  ADD COLUMN IF NOT EXISTS "process_sequence" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "branch_code" TEXT;

UPDATE "tbl_numbering_rules"
SET "pattern" = '{CUSTOMER}-C{SEQ}{BRANCH}-{PROCESS}',
    "notes" = 'Child component. BRANCH = pembeda sibling dan diwariskan; PROCESS = urutan proses.',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "rule_key" = 'PART_CHILD_COMPONENT'
  AND "pattern" IN ('{CUSTOMER}-C{SEQ}-{LEVEL}', '{CUSTOMER}-C{SEQ}-000');

UPDATE "tbl_numbering_rules"
SET "pattern" = '{CUSTOMER}-{SEQ}{BRANCH}-{PROCESS}',
    "notes" = 'Child non-component/material. BRANCH = pembeda sibling dan diwariskan; PROCESS = urutan proses.',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "rule_key" = 'PART_CHILD_NON_COMPONENT'
  AND "pattern" IN ('{CUSTOMER}-{SEQ}-{LEVEL}', '{CUSTOMER}-{SEQ}-000');

CREATE INDEX IF NOT EXISTS "tbl_part_process_sequence_idx" ON "tbl_part"("process_sequence");
CREATE INDEX IF NOT EXISTS "tbl_part_branch_code_idx" ON "tbl_part"("branch_code");
