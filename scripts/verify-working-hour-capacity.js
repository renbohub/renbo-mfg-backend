"use strict";

const assert = require("assert");
const {
  calculateShiftMinutes,
  resolveCapacityFromProfiles,
  classifyCapacity,
} = require("../src/prisma/services/planning/workingHourCalendarService");
const { resolveDailyCapacity } = require("../src/prisma/services/planning/capacityPlanningService");

assert.strictEqual(calculateShiftMinutes("22:00", "06:00", 60), 420,
  "shift lintas tengah malam harus dikurangi break");

const profiles = {
  fallback: { code: "DEFAULT", rules: [{ dayOfWeek: 1, startTime: "08:00", endTime: "15:00", breakMinutes: 0 }] },
  workCenter: { code: "WC", rules: [{ dayOfWeek: 1, startTime: "07:00", endTime: "15:00", breakMinutes: 60 }] },
  machine: { code: "RAMADAN", effectiveFrom: "2026-02-18", effectiveUntil: "2026-03-19", rules: [{ dayOfWeek: 1, startTime: "07:00", endTime: "14:00", breakMinutes: 30 }] },
};

const ramadan = resolveCapacityFromProfiles({ date: "2026-03-02", profiles });
assert.strictEqual(ramadan.source, "MACHINE_PROFILE");
assert.strictEqual(ramadan.availableMinutes, 390);

const normal = resolveCapacityFromProfiles({ date: "2026-04-06", profiles });
assert.strictEqual(normal.source, "WORK_CENTER_PROFILE", "profile Ramadan tidak boleh bocor setelah effectiveUntil");
assert.strictEqual(normal.availableMinutes, 420);

const planOverride = resolveCapacityFromProfiles({
  date: "2026-04-06",
  profiles,
  planOverride: { dayStatus: "WORKING", shiftOverrides: [{ startTime: "08:00", endTime: "16:00", breakMinutes: 60, overtimeMinutes: 90 }] },
});
assert.strictEqual(planOverride.source, "PLAN_OVERRIDE");
assert.strictEqual(planOverride.availableMinutes, 510);

assert.strictEqual(classifyCapacity(0, 0), "NO_LOAD");
assert.strictEqual(classifyCapacity(10, 0), "NO_CALENDAR");
assert.strictEqual(classifyCapacity(85, 100), "OK");
assert.strictEqual(classifyCapacity(86, 100), "WARNING");
assert.strictEqual(classifyCapacity(101, 100), "OVERLOAD");

const machineDay = resolveDailyCapacity({
  key: "2026-09-07",
  override: {
    dayStatus: "WORKING",
    shiftsPerDay: 2,
    shiftOverrides: [
      { startTime: "07:00", endTime: "14:00", breakMinutes: 0, overtimeMinutes: 0 },
      { startTime: "14:00", endTime: "21:00", breakMinutes: 0, overtimeMinutes: 0 },
    ],
    overtimeStart: "21:00",
    overtimeEnd: "23:00",
  },
  shiftHours: 8,
  defaultShiftsPerDay: 2,
  defaultOvertimeHours: 0,
  efficiencyPercent: 100,
  includeSaturday: false,
  includeSunday: false,
  formulas: [],
});
assert.strictEqual(machineDay.availableMinutes, 960,
  "jam shift plan-specific dan overtime harian harus menjadi capacity efektif");

console.log("Working hour capacity contract passed.");
