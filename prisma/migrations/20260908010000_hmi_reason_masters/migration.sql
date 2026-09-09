-- Legacy HMI IDs and descriptions are preserved. These tables are also read by
-- Node-RED; additions are intentionally backward compatible.
BEGIN;
CREATE TABLE IF NOT EXISTS hmi_list_area (area_id integer PRIMARY KEY, area_code varchar(50), area_name varchar(50), area_desc varchar(50));
CREATE TABLE IF NOT EXISTS hmi_list_rejection (rejection_id integer PRIMARY KEY, rejection_desc varchar(255) NOT NULL, area_id integer NOT NULL);
CREATE TABLE IF NOT EXISTS hmi_list_rejection_sub (rejection_sub_id integer PRIMARY KEY, rejection_sub_desc varchar(255) NOT NULL, rejection_id integer NOT NULL);
CREATE TABLE IF NOT EXISTS hmi_list_downtime (downtime_id integer PRIMARY KEY, downtime_desc varchar(255) NOT NULL, area_id integer NOT NULL);
CREATE TABLE IF NOT EXISTS hmi_list_downtime_sub (downtime_sub_id integer PRIMARY KEY, downtime_sub_desc varchar(255) NOT NULL, downtime_id integer NOT NULL);

DO $$
DECLARE item record; sequence_name text; next_id bigint;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('hmi_list_area','area_id'), ('hmi_list_rejection','rejection_id'),
    ('hmi_list_rejection_sub','rejection_sub_id'), ('hmi_list_downtime','downtime_id'),
    ('hmi_list_downtime_sub','downtime_sub_id')
  ) AS t(table_name, id_column) LOOP
    EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', item.table_name);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS notes text,
      ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()', item.table_name);
    sequence_name := pg_get_serial_sequence(item.table_name, item.id_column);
    IF sequence_name IS NULL THEN
      sequence_name := item.table_name || '_erp_id_seq';
      EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I', sequence_name);
      EXECUTE format('ALTER SEQUENCE %I OWNED BY %I.%I', sequence_name, item.table_name, item.id_column);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET DEFAULT nextval(%L)', item.table_name, item.id_column, sequence_name);
    END IF;
    EXECUTE format('SELECT GREATEST(COALESCE(MAX(%I),0)+1, (SELECT last_value+1 FROM %s)) FROM %I', item.id_column, sequence_name::regclass, item.table_name) INTO next_id;
    PERFORM setval(sequence_name::regclass, next_id, false);
  END LOOP;
END $$;

ALTER TABLE hmi_list_downtime ADD COLUMN IF NOT EXISTS stop_class varchar(16) NOT NULL DEFAULT 'UNPLANNED';
ALTER TABLE hmi_list_downtime ADD COLUMN IF NOT EXISTS counts_as_loss boolean NOT NULL DEFAULT true;

-- Soft-deleted labels remain reserved: reactivation uses the same legacy ID.
-- Do not silently merge duplicates imported from a legacy installation.
CREATE UNIQUE INDEX IF NOT EXISTS hmi_area_code_unique ON hmi_list_area (lower(btrim(area_code)));
CREATE UNIQUE INDEX IF NOT EXISTS hmi_ng_area_description_unique ON hmi_list_rejection (area_id, lower(btrim(rejection_desc)));
CREATE UNIQUE INDEX IF NOT EXISTS hmi_ng_sub_description_unique ON hmi_list_rejection_sub (rejection_id, lower(btrim(rejection_sub_desc)));
CREATE UNIQUE INDEX IF NOT EXISTS hmi_dt_area_description_unique ON hmi_list_downtime (area_id, lower(btrim(downtime_desc)));
CREATE UNIQUE INDEX IF NOT EXISTS hmi_dt_sub_description_unique ON hmi_list_downtime_sub (downtime_id, lower(btrim(downtime_sub_desc)));

CREATE TABLE IF NOT EXISTS tbl_hmi_reason_audit (
  id bigserial PRIMARY KEY, entity_kind varchar(24) NOT NULL, record_id integer NOT NULL,
  action varchar(16) NOT NULL, actor_id text, before_data jsonb, after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hmi_reason_audit_record ON tbl_hmi_reason_audit(entity_kind, record_id, created_at);
COMMIT;
