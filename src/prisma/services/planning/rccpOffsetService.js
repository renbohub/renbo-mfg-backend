"use strict";

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

function moveToWorkingDay(value, direction, options = {}, includeCurrent = true) {
  const cursor = utcDate(value);
  if (!cursor) return null;
  if (includeCurrent && isWorkingDay(cursor, options)) return cursor;
  do cursor.setUTCDate(cursor.getUTCDate() + (direction >= 0 ? 1 : -1));
  while (!isWorkingDay(cursor, options));
  return cursor;
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

function backwardOffsetPhase(input = {}) {
  const requiredDate = utcDate(input.requiredDate);
  if (!requiredDate) throw new Error("Required Date RCCP tidak valid.");
  const profiles = [...(input.profiles || [])]
    .filter((profile) => input.includeVendorLeadTime !== false || String(profile.resourceType || "INTERNAL").toUpperCase() !== "OUTSOURCE")
    .sort((left, right) => number(right.sequence) - number(left.sequence));
  const details = [];
  let cursor = requiredDate;
  let upstreamMayFinishOnCursor = false;
  for (const profile of profiles) {
    const calendar = {
      calendarMode: profile.calendarMode,
      shiftsPerDay: profile.shiftsPerDay,
      useWorkingCalendar: input.useWorkingCalendar !== false,
      overrides: input.overridesByMachine?.get(profile.machineId) || [],
    };
    // A short downstream internal operation (for example the 2-hour final
    // packing phase) can start after its upstream operation finishes on the
    // same working day. Keep the default one-day handoff for full-day and
    // outsourced operations.
    const finish = moveToWorkingDay(cursor, -1, calendar, upstreamMayFinishOnCursor);
    const leadDays = Math.max(leadTimeWorkingDays(profile), 1);
    const start = addWorkingDays(finish, -(leadDays - 1), calendar);
    details.unshift({
      profile,
      sequence: number(profile.sequence),
      resourceCode: profile.resourceCode,
      resourceName: profile.resourceName || profile.resourceCode,
      resourceType: String(profile.resourceType || "INTERNAL").toUpperCase(),
      requiredDate,
      calculatedStartDate: start,
      calculatedFinishDate: finish,
      leadTimeDays: leadDays,
      calendarId: resolvedCalendarId(profile),
    });
    cursor = start;
    upstreamMayFinishOnCursor = profile.allowUpstreamSameDay === true;
  }
  return { requiredDate, earliestStartDate: details[0]?.calculatedStartDate || requiredDate, details };
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

function findEarlierFeasibleStart(input = {}) {
  const originalStart = utcDate(input.originalStartDate);
  const searchWindow = Math.max(Math.trunc(number(input.searchWindowDays)), 0);
  const requirement = number(input.currentRequirement);
  for (let offset = 1; offset <= searchWindow; offset += 1) {
    const candidate = addWorkingDays(originalStart, -offset, input.calendar || {});
    const capacity = input.capacityAt(candidate) || {};
    const available = number(capacity.availableCapacity);
    const total = number(capacity.existingLoad) + requirement;
    const loadPercentage = available > EPSILON ? round(total / available * 100, 4) : 0;
    if (available > EPSILON && loadPercentage <= number(input.overloadThreshold ?? 100)) {
      return { recommendedStartDate: candidate, recommendedLoadPercentage: loadPercentage, existingLoad: number(capacity.existingLoad), availableCapacity: available };
    }
  }
  return null;
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
