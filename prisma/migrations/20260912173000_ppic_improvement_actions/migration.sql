CREATE TABLE tbl_ppic_improvement_action (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, month TEXT NOT NULL, owner_id TEXT NOT NULL,
 due_date TEXT NOT NULL CHECK(due_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','IN_PROGRESS','PENDING_VERIFICATION','VERIFIED','CLOSED')),
 payload JSONB NOT NULL, measurement_contract_hash TEXT,
 submitted_actor_id TEXT, verified_actor_id TEXT, verified_by TEXT, verification_note TEXT,
 created_actor_id TEXT NOT NULL, created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ppic_improvement_month_due_idx ON tbl_ppic_improvement_action(month,due_date);
CREATE INDEX ppic_improvement_owner_status_idx ON tbl_ppic_improvement_action(owner_id,status);
CREATE TABLE tbl_ppic_improvement_operation (
 operation_id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES tbl_ppic_improvement_action(id) ON DELETE RESTRICT,
 revision INTEGER NOT NULL, request_hash TEXT NOT NULL, action TEXT NOT NULL,
 actor_id TEXT NOT NULL, actor TEXT NOT NULL, note TEXT NOT NULL, result JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT ppic_improvement_operation_revision_unique UNIQUE(action_id,revision)
);
CREATE INDEX ppic_improvement_operation_action_idx ON tbl_ppic_improvement_operation(action_id,created_at);
