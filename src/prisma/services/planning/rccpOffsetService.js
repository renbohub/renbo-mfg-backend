"use strict";

const { solveBackwardMilestones, solveFiniteSchedule } = require("./solver/planningSolverService");

const EPSILON = 0.000001;
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value, digits = 6) => {
  const factor = 10 ** digits;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
};

function utcDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dateKey(value) {
  return utcDate(value)?.toISOString().slice(0, 10) || "";
}

function calendarOverrideMap(overrides = []) {
  return new Map(overrides.map((row) => [dateKey(row.scheduleDate), row]));
}

function isWorkingDay(value, options = {}) {
  const date = utcDate(value);
  if (!date) return false;
  const override = options.overrideMap?.get(dateKey(date))
    || calendarOverrideMap(options.overrides || []).get(dateKey(date));
  if (override) {
    return String(override.dayStatus || "WORKING").toUpperCase() !== "HOLIDAY"
      && number(override.shiftsPerDay ?? options.shiftsPerDay ?? 1) > 0;
  }
  if (options.useWorkingCalendar === false) return true;
  const mode = String(options.calendarMode || "WEEKDAY").toUpperCase();
  return mode === "ALL_DAYS" || (date.getUTCDay() !== 0 && date.getUTCDay() !== 6);
}

function addWorkingDays(value, amount, options = {}) {
  let cursor = utcDate(value);
  if (!cursor) return null;
  const direction = amount >= 0 ? 1 : -1;
  let remaining = Math.abs(Math.trunc(number(amount)));
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + direction);
    if (isWorkingDay(cursor, options)) remaining -= 1;
  }
  return cursor;
}

function leadTimeWorkingDays(profile = {}) {
  const value = Math.max(number(profile.leadTimeValue), 0);
  const unit = String(profile.leadTimeUnit || "WORKING_DAY").toUpperCase();
  if (["MINUTE", "MINUTES"].includes(unit)) return Math.max(Math.ceil(value / (14 * 60)), value > EPSILON ? 1 : 0);
  if (["HOUR", "HOURS"].includes(unit)) return Math.max(Math.ceil(value / 14), value > EPSILON ? 1 : 0);
  return Math.ceil(value);
}

function resolvedCalendarId(profile = {}) {
  return profile.calendarId
    || (String(profile.resourceType || "INTERNAL").toUpperCase() === "OUTSOURCE" ? "VENDOR" : "FACTORY");
}

async function backwardOffsetPhase(input = {}) {
  const requiredDate = utcDate(input.requiredDate);
  if (!requiredDate) throw new Error("Required Date RCCP tidak valid.");
  const profiles = [...(input.profiles || [])]
    .filter((profile) => input.includeVendorLeadTime !== false || String(profile.resourceType || "INTERNAL").toUpperCase() !== "OUTSOURCE")
    .sort((left, right) => number(left.sequence) - number(right.sequence));
  if (!profiles.length) return { requiredDate, earliestStartDate: requiredDate, details: [], solver: { engine: "OR_TOOLS_WASM_CP_SAT", status: "OPTIMAL" } };
  const hoursPerDay = 14;
  const calendar = {};
  for (const profile of profiles) {
    for (const override of input.overridesByMachine?.get(profile.machineId) || []) {
      if (String(override.dayStatus || "WORKING").toUpperCase() === "HOLIDAY" || number(override.shiftsPerDay) <= 0) calendar[dateKey(override.scheduleDate)] = "HOLIDAY";
    }
  }
  const solved = await solveBackwardMilestones({
    targetDate: requiredDate,
    hoursPerDay,
    calendar: input.useWorkingCalendar === false ? {} : calendar,
    dailyWindows: [{ startMinute: 0, endMinute: hoursPerDay * 60 }],
    tasks: profiles.map((profile) => {
      const rawUnit = String(profile.leadTimeUnit || "WORKING_DAY").toUpperCase();
      const unit = rawUnit.startsWith("MINUTE") ? "MINUTE" : rawUnit.startsWith("HOUR") ? "HOUR" : "DAY";
      return { id: `RCCP:${profile.id || profile.resourceCode}:${profile.sequence}`, duration: Math.max(number(profile.leadTimeValue), 1), unit };
    }),
  });
  const details = profiles.map((profile, index) => {
    const timing = solved.tasks[index];
    return {
      profile,
      sequence: number(profile.sequence),
      resourceCode: profile.resourceCode,
      resourceName: profile.resourceName || profile.resourceCode,
      resourceType: String(profile.resourceType || "INTERNAL").toUpperCase(),
      requiredDate,
      calculatedStartDate: timing.startDate,
      calculatedFinishDate: timing.endDate,
      leadTimeDays: leadTimeWorkingDays(profile),
      calendarId: resolvedCalendarId(profile),
      solverTaskId: timing.id,
    };
  });
  return { requiredDate, earliestStartDate: details[0]?.calculatedStartDate || requiredDate, details, solver: solved };
}

function weekStart(value) {
  const date = utcDate(value);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date;
}

function weekEnd(value) {
  const date = weekStart(value);
  date.setUTCDate(date.getUTCDate() + 6);
  return date;
}

function weeklyBuckets(start, end) {
  const first = weekStart(start);
  const last = utcDate(end);
  const result = [];
  for (let cursor = first; cursor <= last; cursor = addWorkingDays(cursor, 7, { useWorkingCalendar: false })) {
    result.push({ start: new Date(cursor), end: weekEnd(cursor) });
  }
  return result;
}

function allocateWeeklyLoad(input = {}) {
  const start = utcDate(input.startDate);
  const finish = utcDate(input.finishDate);
  const totalHours = Math.max(number(input.totalHours), 0);
  if (!start || !finish || totalHours <= EPSILON) return [];
  const calendar = input.calendar || {};
  const workingDates = [];
  for (const cursor = new Date(start); cursor <= finish; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    if (isWorkingDay(cursor, calendar)) workingDates.push(new Date(cursor));
  }
  if (!workingDates.length) workingDates.push(start);
  const daysByWeek = new Map();
  for (const workingDate of workingDates) {
    const bucketStart = weekStart(workingDate);
    const key = dateKey(bucketStart);
    const current = daysByWeek.get(key) || { bucketStart, workingDays: 0 };
    current.workingDays += 1;
    daysByWeek.set(key, current);
  }
  const groups = [...daysByWeek.values()].sort((left, right) => left.bucketStart - right.bucketStart);
  let allocatedHours = 0;
  return groups.map((group, index) => {
    const hours = index === groups.length - 1
      ? round(totalHours - allocatedHours)
      : round(totalHours * group.workingDays / workingDates.length);
    allocatedHours += hours;
    return {
      bucketStart: group.bucketStart,
      workingDays: group.workingDays,
      totalWorkingDays: workingDates.length,
      hours,
    };
  });
}

function capacityOffsetStatus(hasPreviousMonthLoad, previousStatuses = []) {
  if (!hasPreviousMonthLoad) return "SAME_MONTH";
  if (previousStatuses.includes("OVERLOAD")) return "PREVIOUS_MONTH_OVERLOAD";
  if (previousStatuses.includes("WARNING")) return "PREVIOUS_MONTH_WARNING";
  if (previousStatuses.length && previousStatuses.every((status) => status === "FEASIBLE")) return "PREVIOUS_MONTH_FEASIBLE";
  return "PREVIOUS_MONTH_REQUIRED";
}

async function findEarlierFeasibleStart(input = {}) {
  const originalStart = utcDate(input.originalStartDate);
  const searchWindow = Math.max(Math.trunc(number(input.searchWindowDays)), 0);
  const requirement = number(input.currentRequirement);
  const candidates = [];
  for (let offset = 1; offset <= searchWindow; offset += 1) {
    const candidate = addWorkingDays(originalStart, -offset, input.calendar || {});
    const capacity = input.capacityAt(candidate) || {};
    const available = number(capacity.availableCapacity);
    const total = number(capacity.existingLoad) + requirement;
    const loadPercentage = available > EPSILON ? round(total / available * 100, 4) : 0;
    if (available > EPSILON && loadPercentage <= number(input.overloadThreshold ?? 100)) {
      candidates.push({ candidate, loadPercentage, existingLoad: number(capacity.existingLoad), availableCapacity: available });
    }
  }
  if (!candidates.length) return null;
  const earliest = candidates.reduce((min, row) => row.candidate < min ? row.candidate : min, candidates[0].candidate);
  const calendar = {};
  for (let cursor = new Date(earliest); cursor <= originalStart; cursor.setUTCDate(cursor.getUTCDate() + 1)) calendar[dateKey(cursor)] = "WORKING";
  const resources = Object.fromEntries(candidates.map((row, index) => [`RCCP-CANDIDATE-${index}`, [{ date: dateKey(row.candidate), startMinute: 0, endMinute: 1 }]]));
  const solved = await solveFiniteSchedule({
    horizonStart: earliest,
    horizonEnd: originalStart,
    calendar,
    dailyWindows: [{ startMinute: 0, endMinute: 1 }],
    resourceAvailability: resources,
    scheduleDirection: "BACKWARD",
    tasks: [{ id: "RCCP-EARLIER-START", durationMinutes: 1, eligibleResourceIds: Object.keys(resources), dueDate: originalStart, required: true, tardinessWeight: 1000000 }],
    options: { maxTimeInSeconds: 10, numSearchWorkers: 2, randomSeed: 1 },
  });
  if (!solved.feasible || !solved.tasks[0]?.resourceId) return null;
  const index = Number(String(solved.tasks[0].resourceId).split("-").at(-1));
  const selected = candidates[index];
  return { recommendedStartDate: selected.candidate, recommendedLoadPercentage: selected.loadPercentage, existingLoad: selected.existingLoad, availableCapacity: selected.availableCapacity, solver: { engine: solved.engine, status: solved.status } };
}

module.exports = {
  utcDate,
  dateKey,
  isWorkingDay,
  addWorkingDays,
  leadTimeWorkingDays,
  resolvedCalendarId,
  backwardOffsetPhase,
  weekStart,
  weekEnd,
  weeklyBuckets,
  allocateWeeklyLoad,
  capacityOffsetStatus,
  findEarlierFeasibleStart,
};
