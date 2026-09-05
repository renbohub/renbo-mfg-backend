CREATE TABLE "tbl_planning_solver_run" (
    "id" TEXT NOT NULL,
    "run_number" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "reference_type" TEXT,
    "reference_number" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "engine" TEXT NOT NULL DEFAULT 'OR_TOOLS_WASM_CP_SAT',
    "engine_version" TEXT NOT NULL DEFAULT '0.9.1',
    "model_version" TEXT,
    "input_hash" TEXT NOT NULL,
    "input_snapshot" JSONB NOT NULL,
    "result_snapshot" JSONB,
    "blockers" JSONB DEFAULT '[]',
    "objective_value" DOUBLE PRECISION,
    "best_objective_bound" DOUBLE PRECISION,
    "wall_time_seconds" DOUBLE PRECISION,
    "error_code" TEXT,
    "error_message" TEXT,
    "requested_by" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tbl_planning_solver_run_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tbl_planning_solver_run_run_number_key" ON "tbl_planning_solver_run"("run_number");
CREATE INDEX "tbl_planning_solver_run_status_requested_at_idx" ON "tbl_planning_solver_run"("status", "requested_at");
CREATE INDEX "tbl_planning_solver_run_scope_reference_number_idx" ON "tbl_planning_solver_run"("scope", "reference_number");
CREATE INDEX "tbl_planning_solver_run_input_hash_idx" ON "tbl_planning_solver_run"("input_hash");
