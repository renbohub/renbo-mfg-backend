"use strict";

const numeric = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

module.exports = Object.freeze({
  rulesVersion: "SCHEDULE_FEASIBILITY_V1",
  plantTimezone: process.env.PLANT_TIMEZONE || process.env.TZ || "Asia/Jakarta",
  capacityWarningThresholdPct: numeric(process.env.MPS_CAPACITY_WARNING_THRESHOLD_PCT, 90),
  scheduleWarningSlackMinutes: numeric(process.env.MPS_SCHEDULE_WARNING_SLACK_MINUTES, 1440),
  minPredecessorSuccessorGapMinutes: numeric(process.env.MPS_MIN_OPERATION_GAP_MINUTES, 0),
});
