"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  datesForEvent,
  markerFor,
  normalizeEventInput,
  parseMarker,
  shiftsForDate,
} = require("../src/prisma/services/planning/yearlyWorkingCalendarService");
const { availableCapacityHoursForPeriod } = require("../src/prisma/services/planning/rccpService");

const holiday = normalizeEventInput({ eventName: "Libur Nasional", eventType: "NATIONAL_HOLIDAY", dateFrom: "2026-08-17", dateTo: "2026-08-17" });
assert.equal(holiday.dayStatus, "HOLIDAY");
assert.equal(holiday.workingHourProfileId, null);

const ramadan = normalizeEventInput({ eventName: "Shift Ramadan", eventType: "RAMADAN_SHIFT", dateFrom: "2026-02-18", dateTo: "2026-02-20", dayStatus: "WORKING", workingHourProfileId: "profile-1", applicableDays: [1, 2, 3, 4, 5] });
assert.equal(ramadan.dayStatus, "WORKING");
assert.deepEqual(ramadan.applicableDays, [1, 2, 3, 4, 5]);

const weekdays = datesForEvent(new Date("2026-09-01T00:00:00Z"), new Date("2026-09-07T00:00:00Z"), [1, 2, 3, 4, 5]);
assert.equal(weekdays.length, 5);

const marker = markerFor("event-1", "RAMADAN_SHIFT", "RAMADAN-2S", "Shift Ramadan");
assert.deepEqual(parseMarker(marker), { eventId: "event-1", eventType: "RAMADAN_SHIFT", profileCode: "RAMADAN-2S", eventName: "Shift Ramadan" });

const shifts = shiftsForDate({ rules: [{ dayOfWeek: 2, isEnabled: true, startTime: "07:00", endTime: "15:00", breakMinutes: 60, overtimeMinutes: 0, shift: { shiftCode: "S1", shiftName: "Shift 1" } }] }, new Date("2026-09-01T00:00:00Z"));
assert.equal(shifts.length, 1);
assert.equal(shifts[0].shiftCode, "S1");

const capacityProfile = { calendarMode: "WEEKDAY", shiftsPerDay: 2, effectiveHoursPerShift: 7, resourceCount: 1, efficiencyPercent: 100, plannedDowntimeHours: 0 };
const adjustedCapacity = availableCapacityHoursForPeriod(capacityProfile, new Date("2026-08-10T00:00:00Z"), new Date("2026-08-16T00:00:00Z"), [
  { scheduleDate: "2026-08-11", dayStatus: "WORKING", shiftsPerDay: 1, shiftOverrides: [{ startTime: "07:00", endTime: "14:00", breakMinutes: 60, overtimeMinutes: 0 }] },
  { scheduleDate: "2026-08-12", dayStatus: "HOLIDAY", shiftsPerDay: 0, shiftOverrides: [] },
]);
assert.equal(adjustedCapacity, 48, "RCCP must use special shift duration and zero capacity for a holiday");

const root = path.resolve(__dirname, "..");
const controller = fs.readFileSync(path.join(root, "src/prisma/controllers/master-data/YearlyWorkingCalendarController.js"), "utf8");
const rccp = fs.readFileSync(path.join(root, "src/prisma/services/planning/rccpService.js"), "utf8");
assert.match(controller, /capacityCalendarOverride/);
assert.match(controller, /invalidateRccpByMachineCalendarRange/);
assert.match(controller, /tidak memiliki Shift Master aktif/);
assert.match(rccp, /RCCP_INVALID_CAPACITY_CHANGED/);

console.log("Yearly working calendar domain and RCCP integration: OK");
