UPDATE "tbl_numbering_rules"
SET "pattern" = '{CUSTOMER}-C{SEQ}-{BRANCH}-{PROCESS}',
    "notes" = 'Child component. BRANCH memakai separator -, conditional untuk sibling non-FG satu level; PROCESS = urutan proses.',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "rule_key" = 'PART_CHILD_COMPONENT'
  AND "pattern" = '{CUSTOMER}-C{SEQ}{BRANCH}-{PROCESS}';

UPDATE "tbl_numbering_rules"
SET "pattern" = '{CUSTOMER}-{SEQ}-{BRANCH}-{PROCESS}',
    "notes" = 'Child non-component/material. BRANCH memakai separator -, conditional untuk sibling non-FG satu level; PROCESS = urutan proses.',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "rule_key" = 'PART_CHILD_NON_COMPONENT'
  AND "pattern" = '{CUSTOMER}-{SEQ}{BRANCH}-{PROCESS}';
