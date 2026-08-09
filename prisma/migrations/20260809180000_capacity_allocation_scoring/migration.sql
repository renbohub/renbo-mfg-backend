ALTER TABLE "tbl_production_plan_allocation"
  ADD COLUMN "recommendation_score" DOUBLE PRECISION,
  ADD COLUMN "recommendation_score_breakdown" JSONB;
