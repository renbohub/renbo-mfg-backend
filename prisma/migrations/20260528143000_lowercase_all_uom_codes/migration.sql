DO $$
DECLARE
  duplicate_codes text;
  target record;
BEGIN
  SELECT string_agg(lower_code, ', ' ORDER BY lower_code)
  INTO duplicate_codes
  FROM (
    SELECT lower("uom_code") AS lower_code
    FROM "tbl_uom"
    WHERE "uom_code" IS NOT NULL
    GROUP BY lower("uom_code")
    HAVING count(*) > 1
  ) duplicates;

  IF duplicate_codes IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot lowercase UOM codes because duplicate lowercase keys exist: %', duplicate_codes;
  END IF;

  UPDATE "tbl_uom"
  SET "uom_code" = lower("uom_code")
  WHERE "uom_code" IS NOT NULL
    AND "uom_code" <> lower("uom_code");

  FOR target IN
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND column_name = 'uom_code'
      AND table_name <> 'tbl_uom'
    ORDER BY table_name
  LOOP
    EXECUTE format(
      'UPDATE %I SET "uom_code" = lower("uom_code") WHERE "uom_code" IS NOT NULL AND "uom_code" <> lower("uom_code")',
      target.table_name
    );
  END LOOP;
END $$;
