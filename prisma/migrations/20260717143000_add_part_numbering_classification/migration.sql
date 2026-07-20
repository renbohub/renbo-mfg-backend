ALTER TABLE "tbl_part"
  ADD COLUMN IF NOT EXISTS "has_drawing" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "component_level" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "tbl_part_has_drawing_idx" ON "tbl_part"("has_drawing");
CREATE INDEX IF NOT EXISTS "tbl_part_component_level_idx" ON "tbl_part"("component_level");

INSERT INTO "tbl_numbering_rules"
  ("id", "rule_key", "rule_name", "prefix", "pattern", "sequence_length", "next_number", "increment_by", "reset_policy", "is_active", "is_deleted", "created_at", "updated_at")
VALUES
  (gen_random_uuid(), 'PART_FG_COMPONENT', 'Part FG Component', '', '{CUSTOMER}-C{SEQ}-000', 3, 1, 1, 'NONE', true, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'PART_FG_NON_COMPONENT', 'Part FG Non Component', '', '{CUSTOMER}-{SEQ}-000', 4, 1, 1, 'NONE', true, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'PART_CHILD_COMPONENT', 'Child Part Component', '', '{CUSTOMER}-C{SEQ}-{LEVEL}', 3, 1, 1, 'NONE', true, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'PART_CHILD_NON_COMPONENT', 'Child Part Non Component', '', '{CUSTOMER}-{SEQ}-{LEVEL}', 4, 1, 1, 'NONE', true, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("rule_key") DO NOTHING;
