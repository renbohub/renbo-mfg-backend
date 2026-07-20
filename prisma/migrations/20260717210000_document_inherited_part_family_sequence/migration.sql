UPDATE "tbl_numbering_rules"
SET "notes" = 'SEQ mengikuti family Produk Utama. BRANCH memakai separator - dan conditional untuk sibling non-FG satu level; PROCESS = urutan proses.',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "rule_key" = 'PART_CHILD_COMPONENT';

UPDATE "tbl_numbering_rules"
SET "notes" = 'SEQ mengikuti family FG non-component pada jalur parent. BRANCH memakai separator - dan conditional untuk sibling non-FG satu level; PROCESS = urutan proses.',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "rule_key" = 'PART_CHILD_NON_COMPONENT';
