-- Vendor selection does not mean the physical WIP is ready to leave the plant.
-- Existing unsent orders are moved to the guarded queue; API readiness promotes
-- them to Ready to Send only after predecessor DPP and input WIP are sufficient.
UPDATE "tbl_vendor_process_order"
SET
  "status" = 'Waiting Material',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "is_deleted" = FALSE
  AND "vendor_code" IS NOT NULL
  AND COALESCE("qty_sent", 0) <= 0
  AND "status" IN ('Planned', 'Ready to Send');
