CREATE TABLE "tbl_mps_recovery_request" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "mpsNumber" TEXT NOT NULL,
  "mpsRevision" INTEGER NOT NULL,
  "lineId" TEXT NOT NULL,
  "checkpointCode" TEXT NOT NULL,
  "planningMonth" TEXT NOT NULL,
  "partCode" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "departmentId" TEXT NOT NULL,
  "departmentName" TEXT NOT NULL,
  "recipientIds" JSONB NOT NULL,
  "sourceSnapshot" JSONB NOT NULL,
  "feedbackStatus" TEXT NOT NULL DEFAULT 'OPEN',
  "notes" TEXT NOT NULL,
  "targetDate" TIMESTAMP(3),
  "feedbackNotes" TEXT,
  "evidenceReference" TEXT,
  "requestedBy" TEXT NOT NULL,
  "updatedBy" TEXT,
  "history" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mps_recovery_feedback_status" CHECK ("feedbackStatus" IN ('OPEN', 'IN_PROGRESS', 'WAITING', 'DONE'))
);
CREATE UNIQUE INDEX "tbl_mps_recovery_request_mpsNumber_mpsRevision_lineId_checkpoi_key"
  ON "tbl_mps_recovery_request" ("mpsNumber", "mpsRevision", "lineId", "checkpointCode");
CREATE INDEX "tbl_mps_recovery_request_planningMonth_departmentId_feedback_idx"
  ON "tbl_mps_recovery_request" ("planningMonth", "departmentId", "feedbackStatus");
