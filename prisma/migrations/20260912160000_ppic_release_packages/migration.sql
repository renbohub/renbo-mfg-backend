CREATE TABLE tbl_ppic_release_request (
 id TEXT PRIMARY KEY, scenario_id TEXT NOT NULL REFERENCES tbl_ppic_workspace_scenario(id),
 scenario_revision INTEGER NOT NULL CHECK(scenario_revision>0), month TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK(status IN ('SUBMITTED','RETURNED','APPROVED','RELEASED')),
 source_fingerprint TEXT NOT NULL, bundle_hash TEXT NOT NULL, review JSONB NOT NULL,
 submitted_actor_id TEXT NOT NULL, submitted_by TEXT NOT NULL, approved_by TEXT, note TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ppic_release_request_month_idx ON tbl_ppic_release_request(month,updated_at);
CREATE TABLE tbl_ppic_release_operation (
 operation_id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES tbl_ppic_release_request(id), request_hash TEXT NOT NULL,
 action TEXT NOT NULL, actor_id TEXT NOT NULL, actor TEXT NOT NULL, note TEXT NOT NULL, result JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ppic_release_operation_request_idx ON tbl_ppic_release_operation(request_id,created_at);
CREATE TABLE tbl_ppic_released_baseline (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES tbl_ppic_release_request(id), month TEXT NOT NULL UNIQUE,
 scenario_id TEXT NOT NULL REFERENCES tbl_ppic_workspace_scenario(id), scenario_revision INTEGER NOT NULL,
 bundle_hash TEXT NOT NULL, bundle JSONB NOT NULL, published_by TEXT NOT NULL, published_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION ppic_deny_baseline_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Released PPIC baseline is immutable'; END;
$$;
CREATE TRIGGER ppic_baseline_immutable BEFORE UPDATE OR DELETE ON tbl_ppic_released_baseline FOR EACH ROW EXECUTE FUNCTION ppic_deny_baseline_mutation();
CREATE FUNCTION ppic_protect_release_review() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.review IS DISTINCT FROM OLD.review OR NEW.scenario_id IS DISTINCT FROM OLD.scenario_id OR NEW.scenario_revision IS DISTINCT FROM OLD.scenario_revision OR NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint OR NEW.bundle_hash IS DISTINCT FROM OLD.bundle_hash OR NEW.month IS DISTINCT FROM OLD.month OR NEW.submitted_actor_id IS DISTINCT FROM OLD.submitted_actor_id OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by THEN
  RAISE EXCEPTION 'Submitted PPIC review snapshot is immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER ppic_review_snapshot_immutable BEFORE UPDATE ON tbl_ppic_release_request FOR EACH ROW EXECUTE FUNCTION ppic_protect_release_review();
