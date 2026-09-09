-- Match the pre-existing legacy defaults on fresh installations as well.
-- API writes always require an explicit, validated description and parent.
BEGIN;
ALTER TABLE hmi_list_rejection ALTER COLUMN rejection_desc SET DEFAULT '0', ALTER COLUMN area_id SET DEFAULT 1;
ALTER TABLE hmi_list_rejection_sub ALTER COLUMN rejection_sub_desc SET DEFAULT '0', ALTER COLUMN rejection_id SET DEFAULT 1;
ALTER TABLE hmi_list_downtime ALTER COLUMN downtime_desc SET DEFAULT '0', ALTER COLUMN area_id SET DEFAULT 1;
ALTER TABLE hmi_list_downtime_sub ALTER COLUMN downtime_sub_desc SET DEFAULT '0', ALTER COLUMN downtime_id SET DEFAULT 1;
COMMIT;
