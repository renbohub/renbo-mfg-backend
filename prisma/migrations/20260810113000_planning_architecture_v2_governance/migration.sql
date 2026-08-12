-- Additive DPP displacement governance and explicit capacity-late marker.
ALTER TABLE "tbl_production_plan_allocation"
  ADD COLUMN IF NOT EXISTS "capacity_late" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "tbl_dpp_displacement_proposal" (
  "id" TEXT NOT NULL,
  "delivery_target_id" TEXT NOT NULL,
  "proposed_completion" TIMESTAMP(3) NOT NULL,
  "affected_schedules" JSONB NOT NULL,
  "requires_approval" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  "reason" TEXT NOT NULL,
  "requested_by" TEXT,
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approved_by" TEXT,
  "approved_at" TIMESTAMP(3),
  "approval_reason" TEXT,
  "committed_by" TEXT,
  "committed_at" TIMESTAMP(3),
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_dpp_displacement_proposal_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "tbl_dpp_displacement_proposal_delivery_target_id_status_idx" ON "tbl_dpp_displacement_proposal"("delivery_target_id", "status");
CREATE INDEX IF NOT EXISTS "tbl_dpp_displacement_proposal_requested_at_idx" ON "tbl_dpp_displacement_proposal"("requested_at");
CREATE INDEX IF NOT EXISTS "tbl_dpp_displacement_proposal_is_deleted_idx" ON "tbl_dpp_displacement_proposal"("is_deleted");
