INSERT INTO "tbl_working_hour_profile" ("id", "profile_code", "profile_name", "profile_type", "priority", "is_active", "notes", "updated_at") VALUES
  ('system-profile-regular-2shift', 'REGULAR-2SHIFT', 'Regular 2 Shift', 'REGULAR', 10, true, 'Template Senin-Sabtu; sesuaikan jam kerja per kebijakan perusahaan.', CURRENT_TIMESTAMP),
  ('system-profile-ramadan-2shift', 'RAMADAN-2SHIFT', 'Ramadan 2 Shift', 'RAMADAN', 100, true, 'Template khusus Ramadan. Isi effective date tahunan sebelum assignment.', CURRENT_TIMESTAMP)
ON CONFLICT ("profile_code") DO NOTHING;

-- Regular: 2 x 7 effective hours Monday-Friday, one shift Saturday.
INSERT INTO "tbl_working_hour_rule" ("id", "profile_id", "shift_id", "day_of_week", "start_time", "end_time", "break_minutes", "updated_at")
SELECT 'regular-s1-' || day_no, 'system-profile-regular-2shift', 'system-shift-1', day_no, '07:00', '15:00', 60, CURRENT_TIMESTAMP FROM generate_series(1, 5) AS day_no
ON CONFLICT ("profile_id", "shift_id", "day_of_week") DO NOTHING;
INSERT INTO "tbl_working_hour_rule" ("id", "profile_id", "shift_id", "day_of_week", "start_time", "end_time", "break_minutes", "updated_at")
SELECT 'regular-s2-' || day_no, 'system-profile-regular-2shift', 'system-shift-2', day_no, '15:00', '23:00', 60, CURRENT_TIMESTAMP FROM generate_series(1, 5) AS day_no
ON CONFLICT ("profile_id", "shift_id", "day_of_week") DO NOTHING;
INSERT INTO "tbl_working_hour_rule" ("id", "profile_id", "shift_id", "day_of_week", "start_time", "end_time", "break_minutes", "updated_at") VALUES
  ('regular-s1-6', 'system-profile-regular-2shift', 'system-shift-1', 6, '07:00', '12:00', 0, CURRENT_TIMESTAMP)
ON CONFLICT ("profile_id", "shift_id", "day_of_week") DO NOTHING;

-- Ramadan is a reusable template and is not assigned automatically.
INSERT INTO "tbl_working_hour_rule" ("id", "profile_id", "shift_id", "day_of_week", "start_time", "end_time", "break_minutes", "updated_at")
SELECT 'ramadan-s1-' || day_no, 'system-profile-ramadan-2shift', 'system-shift-1', day_no, '07:00', '13:30', 30, CURRENT_TIMESTAMP FROM generate_series(1, 5) AS day_no
ON CONFLICT ("profile_id", "shift_id", "day_of_week") DO NOTHING;
INSERT INTO "tbl_working_hour_rule" ("id", "profile_id", "shift_id", "day_of_week", "start_time", "end_time", "break_minutes", "updated_at")
SELECT 'ramadan-s2-' || day_no, 'system-profile-ramadan-2shift', 'system-shift-2', day_no, '13:30', '20:00', 30, CURRENT_TIMESTAMP FROM generate_series(1, 5) AS day_no
ON CONFLICT ("profile_id", "shift_id", "day_of_week") DO NOTHING;
