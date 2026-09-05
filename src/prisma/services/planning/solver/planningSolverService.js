"use strict";

const { DAY_MS, asDate, createWorkingMinuteAxis, startOfUtcDay } = require("./planningTimeAxis");

let solverModulePromise;
function solverModule() {
  solverModulePromise ||= import("./planningCpSatSolver.mjs");
  return solverModulePromise;
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function durationMinutes(value, unit = "MINUTE", hoursPerDay = 8) {
  const amount = Math.max(number(value), 0);
  const normalized = String(unit || "MINUTE").toUpperCase();
  if (["DAY", "DAYS"].includes(normalized)) return Math.ceil(amount * Math.max(number(hoursPerDay), 1) * 60);
  if (["HOUR", "HOURS"].includes(normalized)) return Math.ceil(amount * 60);
  if (["SECOND", "SECONDS"].includes(normalized)) return Math.ceil(amount / 60);
  return Math.ceil(amount);
}

async function solveBackwardMilestones(input = {}) {
  const targetDate = asDate(input.targetDate, "targetDate");
  const hoursPerDay = Math.max(number(input.hoursPerDay) || 8, 1);
  const tasks = (input.tasks || []).map((task, index) => ({
    ...task,
    id: String(task.id || `MILESTONE-${index + 1}`),
    durationMinutes: Math.max(durationMinutes(task.duration ?? task.durationMinutes, task.durationMinutes != null ? "MINUTE" : task.unit, hoursPerDay), 0),
    alignToWorkingDay: ["DAY", "DAYS"].includes(String(task.unit || "").toUpperCase()),
  }));
  const totalMinutes = tasks.reduce((sum, task) => sum + task.durationMinutes, 0);
  const horizonDays = Math.max(Math.ceil(totalMinutes / (hoursPerDay * 60) * 2) + 90, number(input.minimumHorizonDays) || 180);
  const axis = createWorkingMinuteAxis({
    horizonStart: input.horizonStart || new Date(startOfUtcDay(targetDate).getTime() - horizonDays * DAY_MS),
    horizonEnd: input.horizonEnd || new Date(startOfUtcDay(targetDate).getTime() + DAY_MS),
    calendar: input.calendar || Object.fromEntries((input.holidays || []).map((date) => [new Date(date).toISOString().slice(0, 10), "HOLIDAY"])),
    dailyWindows: input.dailyWindows || [{ startMinute: 0, endMinute: hoursPerDay * 60 }],
  });
  const dayStarts = [...axis.daySlots.values()].map((row) => row.first);
  const result = await (await solverModule()).solveBackwardChain({
    tasks: tasks.map((task) => ({ ...task, allowedStartMinutes: task.alignToWorkingDay ? dayStarts : undefined })),
    horizonMinutes: axis.horizonMinutes,
    targetMinute: axis.slotAtOrBefore(targetDate) + 1,
    options: input.options,
  });
  if (!result.feasible) {
    const error = new Error(`Planning solver tidak menemukan backward schedule yang feasible (${result.status}).`);
    error.code = "PLANNING_SOLVER_INFEASIBLE";
    error.solver = result;
    throw error;
  }
  return {
    ...result,
    engine: "OR_TOOLS_WASM_CP_SAT",
    engineVersion: "0.9.1",
    tasks: result.tasks.map((task) => ({
      ...task,
      startDate: axis.dateAt(task.startMinute),
      endDate: axis.dateAt(Math.max(task.endMinute - 1, task.startMinute), { endExclusive: true }),
    })),
  };
}

async function solveFiniteSchedule(input = {}) {
  const horizonStart = asDate(input.horizonStart, "horizonStart");
  const horizonEnd = asDate(input.horizonEnd, "horizonEnd");
  const axis = createWorkingMinuteAxis({ horizonStart, horizonEnd, calendar: input.calendar, dailyWindows: input.dailyWindows });
  const tasks = (input.tasks || []).map((task) => ({
    ...task,
    durationMinutes: Math.max(durationMinutes(task.duration ?? task.durationMinutes, task.durationMinutes != null ? "MINUTE" : task.durationUnit, input.hoursPerDay || 8), 1),
    releaseMinute: task.releaseDate ? axis.slotAtOrAfter(task.releaseDate) : number(task.releaseMinute),
    dueMinute: task.dueDate ? axis.slotAtOrBefore(task.dueDate) : (task.dueMinute ?? axis.horizonMinutes - 1),
    fixedStartMinute: task.fixedStartDate ? axis.slotAtOrAfter(task.fixedStartDate) : task.fixedStartMinute,
    baselineStartMinute: task.baselineStartDate ? axis.slotAtOrAfter(task.baselineStartDate) : task.baselineStartMinute,
  }));
  const resourceBlockedIntervals = [...(input.resourceBlockedIntervals || [])];
  for (const [resourceId, windows] of Object.entries(input.resourceAvailability || {})) {
    const byDate = new Map((windows || []).map((row) => [String(row.date || row.scheduleDate).slice(0, 10), row]));
    for (const [key, slots] of axis.daySlots.entries()) {
      const source = byDate.get(key);
      if (!source) {
        resourceBlockedIntervals.push({ resourceId, startMinute: slots.first, durationMinutes: slots.last - slots.first + 1 });
        continue;
      }
      const ranges = Array.isArray(source.windows) ? source.windows : [source];
      const allowed = ranges.map((row) => ({
        start: slots.first + Math.max(number(row.startMinute ?? row.start), 0),
        end: slots.first + Math.min(number(row.endMinute ?? row.end), slots.last - slots.first + 1),
      })).filter((row) => row.end > row.start).sort((a, b) => a.start - b.start);
      let cursor = slots.first;
      for (const range of allowed) {
        if (range.start > cursor) resourceBlockedIntervals.push({ resourceId, startMinute: cursor, durationMinutes: range.start - cursor });
        cursor = Math.max(cursor, range.end);
      }
      if (cursor <= slots.last) resourceBlockedIntervals.push({ resourceId, startMinute: cursor, durationMinutes: slots.last - cursor + 1 });
    }
  }
  const result = await (await solverModule()).solveFiniteSchedule({ ...input, tasks, resourceBlockedIntervals, horizonMinutes: axis.horizonMinutes });
  return {
    ...result,
    engine: "OR_TOOLS_WASM_CP_SAT",
    engineVersion: "0.9.1",
    tasks: result.tasks.map((task) => ({
      ...task,
      startDate: task.startMinute == null ? null : axis.dateAt(task.startMinute),
      endDate: task.endMinute == null ? null : axis.dateAt(Math.max(task.endMinute - 1, task.startMinute), { endExclusive: true }),
    })),
  };
}

module.exports = { durationMinutes, solveBackwardMilestones, solveFiniteSchedule };
