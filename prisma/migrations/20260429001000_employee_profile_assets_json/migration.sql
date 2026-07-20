-- Convert employee profile assets from plain URL text into JSON records.
-- Existing text values are preserved as { "fileUrl": "<old value>" }.
ALTER TABLE "tbl_employee"
  ALTER COLUMN "profile_photo" TYPE JSONB
  USING CASE
    WHEN "profile_photo" IS NULL OR "profile_photo" = '' THEN NULL
    ELSE jsonb_build_object('fileUrl', "profile_photo")
  END;

ALTER TABLE "tbl_employee"
  ALTER COLUMN "signature" TYPE JSONB
  USING CASE
    WHEN "signature" IS NULL OR "signature" = '' THEN NULL
    ELSE jsonb_build_object('fileUrl', "signature")
  END;
