"use strict";

function minutesOfDay(value) {
  const [hour, minute] = String(value || "00:00").split(":").map(Number);
  return (hour * 60) + minute;
}

function calculateShiftMinutes(startTime, endTime, breakMinutes = 0) {
  const start = minutesOfDay(startTime);
  let end = minutesOfDay(endTime);
  if (end <= start) end += 24 * 60;
  return Math.max(end - start - Number(breakMinutes || 0), 0);
}

function dateOnly(value) {
  return String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
}

function activeProfile(profile, date) {
  if (!profile) return false;
  const key = dateOnly(date);
  return (!profile.effectiveFrom || key >= dateOnly(profile.effectiveFrom))
    && (!profile.effectiveUntil || key <= dateOnly(profile.effectiveUntil));
}

function ruleDay(date) {
  const day = new Date(`${dateOnly(date)}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function normalizeShifts(rules, date) {
  const day = ruleDay(date);
  return (rules || [])
    .filter((rule) => Number(rule.dayOfWeek) === day && rule.isEnabled !== false)
    .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0))
    .map((rule, index) => ({
      shiftCode: rule.shiftCode || rule.shift?.shiftCode || `SHIFT-${index + 1}`,
      startTime: rule.startTime,
      endTime: rule.endTime,
      breakMinutes: Number(rule.breakMinutes || 0),
      overtimeMinutes: Number(rule.overtimeMinutes || 0),
      effectiveMinutes: calculateShiftMinutes(rule.startTime, rule.endTime, rule.breakMinutes) + Number(rule.overtimeMinutes || 0),
    }));
}

function resolveCapacityFromProfiles({ date, profiles = {}, planOverride, globalOverride }) {
  let source = "SYSTEM_FALLBACK";
  let rules = profiles.fallback?.rules || [];
  let dayStatus = "WORKING";

  const profileCandidates = [
    ["WORK_CENTER_PROFILE", profiles.workCenter],
    ["MACHINE_PROFILE", profiles.machine],
  ];
  for (const [candidateSource, profile] of profileCandidates) {
    if (activeProfile(profile, date)) {
      source = candidateSource;
      rules = profile.rules || [];
    }
  }

  const override = planOverride || globalOverride;
  if (override) {
    source = planOverride ? "PLAN_OVERRIDE" : "GLOBAL_OVERRIDE";
    dayStatus = String(override.dayStatus || "WORKING").toUpperCase();
    if (Array.isArray(override.shiftOverrides)) rules = override.shiftOverrides.map((rule, index) => ({ ...rule, dayOfWeek: ruleDay(date), sequence: index + 1 }));
  }

  const shifts = dayStatus === "WORKING" ? normalizeShifts(rules, date) : [];
  return {
    source,
    dayStatus,
    shifts,
    availableMinutes: shifts.reduce((sum, shift) => sum + shift.effectiveMinutes, 0),
    overtimeMinutes: shifts.reduce((sum, shift) => sum + shift.overtimeMinutes, 0),
    calendarStatus: shifts.length ? "READY" : "NO_CALENDAR",
  };
}

function classifyCapacity(loadMinutes, availableMinutes) {
  const load = Number(loadMinutes || 0);
  const available = Number(availableMinutes || 0);
  if (load <= 0) return "NO_LOAD";
  if (available <= 0) return "NO_CALENDAR";
  const percent = (load / available) * 100;
  if (percent <= 85) return "OK";
  if (percent <= 100) return "WARNING";
  return "OVERLOAD";
}

async function resolveMachineDayCapacity(client, { machine, workCenter, date, planOverride, globalOverride, fallbackProfile }) {
  const profileIds = [machine?.workingHourProfileId, workCenter?.workingHourProfileId].filter(Boolean);
  const records = profileIds.length && client?.workingHourProfile
    ? await client.workingHourProfile.findMany({
      where: { id: { in: profileIds }, isActive: true, isDeleted: false },
      include: { rules: { include: { shift: true } } },
    })
    : [];
  const byId = new Map(records.map((profile) => [profile.id, profile]));
  return resolveCapacityFromProfiles({
    date,
    planOverride,
    globalOverride,
    profiles: {
      fallback: fallbackProfile || {
        code: "SYSTEM_DEFAULT",
        rules: [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startTime: "07:00", endTime: "14:00", breakMinutes: 0 })),
      },
      workCenter: byId.get(workCenter?.workingHourProfileId),
      machine: byId.get(machine?.workingHourProfileId),
    },
  });
}

module.exports = { calculateShiftMinutes, resolveCapacityFromProfiles, resolveMachineDayCapacity, classifyCapacity };
