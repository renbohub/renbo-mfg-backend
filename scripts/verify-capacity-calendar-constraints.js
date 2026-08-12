const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  AUTO_CAPACITY_OVERRIDE_PREFIX,
  buildDerivedCapacityDays,
  buildCapacityRuleIndex,
  capacityRuleForMachineDate,
  freeCapacitySegments,
  isAutoCapacityOverride,
  reserveDowntimeCapacity,
  shiftWindows,
  withCapacityRuleIndex,
} = require("../src/prisma/services/planning/capacityRecommendationService");

const periodStart = new Date("2026-08-10T00:00:00.000Z"); // Monday
const periodEnd = new Date("2026-08-16T00:00:00.000Z");
const machine = {
  id: "machine-1",
  machineCode: "MC-01",
  shift1Start: "08:00",
  shift1End: "16:00",
  shift2Start: "16:00",
  shift2End: "00:00",
  shift3Start: "00:00",
  shift3End: "08:00",
};

const globalOverrides = [
  { machineId: machine.id, scheduleDate: "2026-08-11", dayStatus: "HOLIDAY", shiftsPerDay: 2, reason: "Plant shutdown" },
  { machineId: machine.id, scheduleDate: "2026-08-16", dayStatus: "WORKING", shiftsPerDay: 1, reason: "Sunday recovery" },
  { machineId: machine.id, scheduleDate: "2026-08-15", dayStatus: "WORKING", shiftsPerDay: 3, overtimeStart: "08:00", overtimeEnd: "10:00" },
];
const planOverrides = [
  { machineId: machine.id, scheduleDate: "2026-08-11", dayStatus: "WORKING", shiftsPerDay: 1, reason: "Approved recovery" },
  { machineId: machine.id, scheduleDate: "2026-08-12", dayStatus: "WORKING", shiftsPerDay: 1 },
  { machineId: machine.id, scheduleDate: "2026-08-14", dayStatus: "WORKING", shiftsPerDay: 1, reason: `${AUTO_CAPACITY_OVERRIDE_PREFIX} stale result` },
];
const configuredPreset = {
  shiftCount: 2,
  shifts: [
    { start: "08:00", end: "16:00" },
    { start: "16:00", end: "00:00" },
    { start: "00:00", end: "08:00" },
  ],
  includeSaturday: false,
  includeSunday: false,
  overtimeStart: "00:00",
  overtimeEnd: "02:00",
  dailyOverrides: {
    "2026-08-13": { dayStatus: "HOLIDAY", shiftCount: 0, shifts: [], reason: "Simulation stop" },
    "2026-08-14": { dayStatus: "WORKING", shiftCount: 2, shifts: [{ start: "07:00", end: "15:00" }, { start: "15:00", end: "23:00" }] },
  },
};
const ruleIndex = buildCapacityRuleIndex({ globalOverrides, planOverrides });
const preset = withCapacityRuleIndex(configuredPreset, ruleIndex);

assert.strictEqual(capacityRuleForMachineDate(machine, "2026-08-11", preset).source, "PLAN_OVERRIDE", "Plan rule must win over global calendar");
assert.strictEqual(capacityRuleForMachineDate(machine, "2026-08-13", preset).source, "SIMULATION_PRESET", "Explicit preset day must be selected when no plan override exists");
assert.strictEqual(capacityRuleForMachineDate(machine, "2026-08-15", preset).source, "GLOBAL_CALENDAR", "Global calendar is the final explicit-rule fallback");
assert.strictEqual(ruleIndex.ignoredDerivedPlanOverrideCount, 1, "A derived override from an older recommendation must not become a hard input on re-run");
assert.strictEqual(capacityRuleForMachineDate(machine, "2026-08-14", preset).source, "SIMULATION_PRESET", "Preset must remain effective after a stale derived override is ignored");
assert.strictEqual(isAutoCapacityOverride(planOverrides[2]), true);
assert.strictEqual(isAutoCapacityOverride(planOverrides[0]), false);

const planCapped = shiftWindows(machine, 2, "THREE_SHIFT", preset, periodStart);
assert.strictEqual(planCapped.length, 1, "Plan shiftsPerDay=1 must remain a hard cap during THREE_SHIFT escalation");
assert.deepStrictEqual(planCapped.map((window) => window.shift), ["1"]);

const planNoOvertime = shiftWindows(machine, 2, "OVERTIME", preset, periodStart);
assert.strictEqual(planNoOvertime.length, 1, "Empty overtime on an explicit plan rule must suppress preset overtime");
assert.strictEqual(planNoOvertime.some((window) => window.overtime), false);

assert.deepStrictEqual(shiftWindows(machine, 3, "THREE_SHIFT", preset, periodStart), [], "Preset HOLIDAY must expose no windows");
const presetFriday = shiftWindows(machine, 4, "THREE_SHIFT", preset, periodStart);
assert.strictEqual(presetFriday.length, 2, "Explicit preset shiftCount must be a hard cap");
assert.strictEqual(presetFriday[0].start % 1440, 7 * 60, "Preset-specific shift clock must be honored");

const globalOvertime = shiftWindows(machine, 5, "OVERTIME", preset, periodStart);
assert.strictEqual(globalOvertime.filter((window) => !window.overtime).length, 3, "Global shiftsPerDay must be honored even on a disabled preset weekend");
assert.deepStrictEqual(globalOvertime.filter((window) => window.overtime).map((window) => [window.start % 1440, window.end % 1440]), [[480, 600]], "Explicit global overtime interval must be used");

const sunday = shiftWindows(machine, 6, "NORMAL", preset, periodStart);
assert.strictEqual(sunday.length, 1, "An explicit WORKING calendar rule must open a normally-disabled Sunday");

const noSundayRulePreset = withCapacityRuleIndex(configuredPreset, buildCapacityRuleIndex());
assert.deepStrictEqual(shiftWindows(machine, 6, "NORMAL", noSundayRulePreset, periodStart), [], "Weekend flags must remain effective without an override");

const defaultCalendarPreset = withCapacityRuleIndex(null, buildCapacityRuleIndex());
assert.deepStrictEqual(shiftWindows(machine, 5, "NORMAL", defaultCalendarPreset, periodStart), [], "Saturday must be closed when auto allocation runs without a saved preset");
assert.deepStrictEqual(shiftWindows(machine, 6, "NORMAL", defaultCalendarPreset, periodStart), [], "Sunday must be closed when auto allocation runs without a saved preset");

const derivedDays = buildDerivedCapacityDays([
  { machine, mode: "PARALLEL", shift: "1", start: 480, end: 540, overtime: false },
  { machine, mode: "THREE_SHIFT", shift: "3", start: 1440 + 60, end: 1440 + 120, overtime: false },
  { machine, mode: "OVERTIME", shift: "2", start: 2 * 1440 + 1400, end: 2 * 1440 + 1460, overtime: true },
], periodStart, noSundayRulePreset);
assert.strictEqual(derivedDays.size, 2, "Parallel placement alone must not create a false three-shift day override");
assert.strictEqual(derivedDays.get(`${machine.id}|2026-08-11`).shiftsPerDay, 3, "Only a used third-shift slot should persist a three-shift escalation");
assert.strictEqual(derivedDays.get(`${machine.id}|2026-08-12`).overtime, true, "Actual overtime usage must remain auditable as a derived capacity day");

assert.deepStrictEqual(
  freeCapacitySegments([{ start: 10, end: 20 }, { start: 15, end: 25 }, { start: 40, end: 50 }], 0, 60),
  [{ start: 0, end: 10 }, { start: 25, end: 40 }, { start: 50, end: 60 }],
  "Downtime duration reservations need deterministic non-overlapping free segments",
);

const downtimeUsage = new Map();
const downtimePreset = withCapacityRuleIndex({
  shiftCount: 2,
  shifts: configuredPreset.shifts,
  includeSaturday: true,
  includeSunday: true,
  dailyOverrides: {},
}, buildCapacityRuleIndex());
const downtimeAudit = reserveDowntimeCapacity({
  usage: downtimeUsage,
  machines: [machine],
  preset: downtimePreset,
  periodStart,
  periodEnd,
  downtimes: [
    {
      downtimeNumber: "DT-EXACT",
      downtimeDate: "2026-08-10",
      machineCode: "MC-01",
      shift: "1A",
      startTime: new Date("2026-08-10T10:00:00.000Z"),
      endTime: new Date("2026-08-10T10:30:00.000Z"),
      durationMinutes: 30,
    },
    {
      downtimeNumber: "DT-START-DURATION",
      downtimeDate: "2026-08-10",
      machineCode: "MC-01",
      shift: "1A",
      startTime: new Date("2026-08-10T11:00:00.000Z"),
      endTime: null,
      durationMinutes: 20,
    },
    { downtimeNumber: "DT-EST-1", downtimeDate: "2026-08-10", machineCode: "mc-01", shift: "1B", durationMinutes: 45 },
    { downtimeNumber: "DT-EST-2", downtimeDate: "2026-08-10", machineCode: "MC-01", shift: "1A", durationMinutes: 30 },
    { downtimeNumber: "DT-UNKNOWN", downtimeDate: "2026-08-10", machineCode: "MC-MISSING", shift: "1", durationMinutes: 15 },
  ],
});
const reservations = (downtimeUsage.get(machine.id) || []).sort((left, right) => left.start - right.start);
assert.deepStrictEqual(reservations.map((row) => [row.start, row.end, row.reservationPrecision]), [
  [480, 525, "SHIFT_DURATION"],
  [525, 555, "SHIFT_DURATION"],
  [600, 630, "EXACT"],
  [660, 680, "START_PLUS_DURATION"],
], "Duration-only downtime rows must consume distinct deterministic capacity before exact downtime");
assert.strictEqual(downtimeAudit.exactCount, 1);
assert.strictEqual(downtimeAudit.inferredEndpointCount, 1);
assert.strictEqual(downtimeAudit.estimatedCount, 2);
assert.strictEqual(downtimeAudit.unknownMachineCount, 1);
assert.strictEqual(downtimeAudit.reservedMinutes, 125);
assert.strictEqual(downtimeAudit.unreservedMinutes, 15);
assert(reservations.every((row) => row.capacityReservation && row.reservationSource === "DOWNTIME_LOG"), "Usage intervals must retain blocker source metadata");

const crossingUsage = new Map();
const crossingAudit = reserveDowntimeCapacity({
  usage: crossingUsage,
  machines: [machine],
  preset: downtimePreset,
  periodStart,
  periodEnd,
  downtimes: [{
    downtimeNumber: "DT-CROSS-HORIZON",
    downtimeDate: "2026-08-10",
    machineCode: "MC-01",
    startTime: new Date("2026-08-09T23:30:00.000Z"),
    endTime: new Date("2026-08-10T00:30:00.000Z"),
    durationMinutes: 60,
  }],
});
assert.deepStrictEqual((crossingUsage.get(machine.id) || []).map((row) => [row.start, row.end]), [[0, 30]], "Exact downtime crossing into the horizon must be safely clipped");
assert.strictEqual(crossingAudit.reservedMinutes, 30);

const planningSnapshotSource = fs.readFileSync(path.join(__dirname, "../src/prisma/services/planning/capacityPlanningService.js"), "utf8");
assert.match(
  planningSnapshotSource,
  /dayOverrideByMachineDate\.get\(`\$\{machineId\}\|\$\{key\}`\)[\s\S]*?presetDayOverrideByDate\.get\(key\)[\s\S]*?globalDayOverrideByMachineDate\.get\(`\$\{machineId\}\|\$\{key\}`\)/,
  "Capacity snapshot must resolve plan > preset > global just like the allocator",
);
assert.match(planningSnapshotSource, /cell\.dayOverride = dayOverrideForDate\(key, machine\.id\)/, "Heatmap evidence must expose the same effective rule used for its available minutes");

console.log("Capacity calendar constraint verification passed.");
