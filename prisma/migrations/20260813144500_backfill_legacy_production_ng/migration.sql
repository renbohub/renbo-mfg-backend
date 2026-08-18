INSERT INTO "tbl_production_log_ng_reason" (
  "id",
  "production_log_id",
  "coil_phase_id",
  "phase_number",
  "reason",
  "qty_ng",
  "status",
  "is_deleted",
  "created_at",
  "updated_at"
)
SELECT
  'legacy-ng-' || phase."id",
  phase."production_log_id",
  phase."id",
  phase."phase_number",
  COALESCE(NULLIF(TRIM(log."reject_reason"), ''), 'NG legacy - reason belum diklasifikasikan'),
  phase."qty_reject",
  'PENDING_QC',
  FALSE,
  COALESCE(phase."created_at", CURRENT_TIMESTAMP),
  CURRENT_TIMESTAMP
FROM "tbl_production_log_coil_phase" phase
JOIN "tbl_production_log" log ON log."id" = phase."production_log_id"
WHERE phase."is_deleted" = FALSE
  AND log."is_deleted" = FALSE
  AND phase."qty_reject" > 0
  AND NOT EXISTS (
    SELECT 1
    FROM "tbl_production_log_ng_reason" reason
    WHERE reason."coil_phase_id" = phase."id"
      AND reason."is_deleted" = FALSE
  );
