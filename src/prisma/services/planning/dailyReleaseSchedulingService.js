"use strict";

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const dateKey = (value) => String(value instanceof Date ? value.toISOString() : value || "").slice(0, 10);
const dateOrdinal = (value) => Math.floor(new Date(`${dateKey(value)}T00:00:00.000Z`).getTime() / 86400000);
const MINIMUM_SUCCESSOR_GAP_MINUTES = 120;

function toMinute(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 47 || minute > 59) return null;
  return hour * 60 + minute;
}

function toTime(value) {
  const minute = Math.max(Math.round(number(value)), 0);
  const hour = Math.floor(minute / 60);
  return `${String(hour).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function dependencyDepth(item, byId, memo, visiting = new Set()) {
  if (!item?.id || memo.has(item.id)) return memo.get(item?.id) || 0;
  if (visiting.has(item.id)) return 0;
  const nextVisiting = new Set(visiting).add(item.id);
  const predecessors = (Array.isArray(item.predecessorAllocationIds) ? item.predecessorAllocationIds : [])
    .map((id) => byId.get(id)).filter(Boolean);
  const depth = predecessors.length
    ? Math.max(...predecessors.map((predecessor) => dependencyDepth(predecessor, byId, memo, nextVisiting))) + 1
    : 0;
  memo.set(item.id, depth);
  return depth;
}

function allocationDuration(item, fallbackMinutes = 60) {
  const start = toMinute(item.plannedStartTime);
  const end = toMinute(item.plannedEndTime);
  if (start != null && end != null && end > start) return end - start;
  return Math.max(Math.ceil(number(item.durationMinutes || item.minutes) || fallbackMinutes), 1);
}

function candidateMachines(item) {
  if (Array.isArray(item.eligibleMachineIds)) {
    return [...new Set(item.eligibleMachineIds.filter(Boolean))];
  }
  return item.machineId ? [item.machineId] : [];
}

function operationalMinute(value, dayStart = 420) {
  const minute = toMinute(value);
  if (minute == null) return null;
  return minute < dayStart ? minute + 1440 : minute;
}

function normalizePlacementWindows(windows = [], dayStart = 420) {
  return windows.map((window, index) => {
    const start = operationalMinute(window.startTime || window.start, dayStart);
    let end = operationalMinute(window.endTime || window.end, dayStart);
    if (start == null || end == null) return null;
    if (end <= start) end += 1440;
    return { shift: String(window.shift || window.shiftCode || index + 1), start, end };
  }).filter(Boolean).sort((left, right) => left.start - right.start || left.end - right.end);
}

function machinePlacementWindows(windowsByMachine, machineId, fromDate, dayStart = 420) {
  const fromOrdinal = dateOrdinal(fromDate);
  const suffix = `|${machineId}`;
  const result = [];
  for (const [key, sourceWindows] of windowsByMachine.entries()) {
    if (!String(key).endsWith(suffix)) continue;
    const scheduleDate = String(key).slice(0, -suffix.length);
    const ordinal = dateOrdinal(scheduleDate);
    if (!Number.isFinite(ordinal) || ordinal < fromOrdinal) continue;
    normalizePlacementWindows(sourceWindows, dayStart).forEach((window) => result.push({
      ...window,
      date: scheduleDate,
      dayBase: ordinal * 1440,
      start: ordinal * 1440 + window.start,
      end: ordinal * 1440 + window.end,
    }));
  }
  return result.sort((left, right) => left.start - right.start || left.end - right.end);
}

function absoluteScheduleMinutes(item, field, dayStart = 420) {
  const minute = operationalMinute(item?.[field], dayStart);
  return minute == null ? null : dateOrdinal(item.scheduleDate) * 1440 + minute;
}

function displayPlacementTime(absoluteMinute, dayBase) {
  // Keep an operational-day time (for example 30:15 for 06:15 on the
  // following calendar day).  Reducing it modulo 24 hours creates an invalid
  // range when a placement crosses the 07:00 operational-day boundary.
  const local = Math.max(number(absoluteMinute) - number(dayBase), 0);
  return toTime(local);
}

function placementMergeKey(item = {}) {
  return [
    dateKey(item.scheduleDate),
    item.machineId || "UNASSIGNED",
    item.partCode || item.partId || "PART",
    item.processId || item.mbomProcessId || "PROCESS",
    item.moId || item.moNumber || "MO",
    item.woId || item.woNumber || "WO",
    item.uomCode || "UOM",
  ].map((value) => String(value)).join("|");
}

function utcDateTime(date, minute) {
  const base = new Date(`${dateKey(date)}T00:00:00.000Z`);
  return new Date(base.getTime() + Math.max(number(minute), 0) * 60000);
}

function resourceAvailabilityFromWindows(windowsByMachine, dayStart = 420) {
  const source = windowsByMachine instanceof Map ? windowsByMachine : new Map(Object.entries(windowsByMachine || {}));
  const grouped = {};
  function add(machineId, date, startMinute, endMinute) {
    if (!(endMinute > startMinute)) return;
    grouped[machineId] ||= new Map();
    const rows = grouped[machineId].get(date) || [];
    rows.push({ startMinute, endMinute });
    grouped[machineId].set(date, rows);
  }
  for (const [key, windows] of source.entries()) {
    const separator = String(key).lastIndexOf("|");
    if (separator < 0) continue;
    const date = String(key).slice(0, separator);
    const machineId = String(key).slice(separator + 1);
    for (const window of normalizePlacementWindows(windows, dayStart)) {
      const start = window.start;
      const end = window.end;
      if (start < 1440) add(machineId, date, start, Math.min(end, 1440));
      if (end > 1440) {
        const next = new Date(`${date}T00:00:00.000Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        add(machineId, dateKey(next), 0, end - 1440);
      }
    }
  }
  return Object.fromEntries(Object.entries(grouped).map(([machineId, byDate]) => [
    machineId,
    [...byDate.entries()].map(([date, windows]) => ({ date, windows })),
  ]));
}

function completeCalendar(start, end) {
  const calendar = {};
  for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    calendar[dateKey(cursor)] = "WORKING";
  }
  return calendar;
}

function solverTask(item, options = {}) {
  const id = String(item.productionPlanAllocationId || item.id);
  const candidates = candidateMachines(item);
  const baseStart = operationalMinute(item.plannedStartTime, toMinute(options.dayStart || "07:00") ?? 420);
  const startDate = utcDateTime(item.scheduleDate, baseStart == null ? 420 : baseStart);
  const dayEndMinute = Math.max(number(options.operationalDayEndMinute), 31 * 60);
  const dueDate = utcDateTime(item.scheduleDate, dayEndMinute);
  const fixed = item.movable === false || ["Released", "In Progress", "Completed"].includes(item.status);
  return {
    id,
    durationMinutes: allocationDuration(item, options.defaultDurationMinutes || 60),
    eligibleResourceIds: candidates,
    preferredResourceId: item.machineId || null,
    assignmentGroupId: [dateKey(item.scheduleDate), item.partCode || item.partId, item.processId || item.mbomProcessId, item.moId || item.moNumber, item.woId || item.woNumber].filter(Boolean).join("|"),
    requiredResourceIds: item.diesId ? [`DIES:${item.diesId}`] : [],
    predecessorIds: (item.predecessorAllocationIds || []).map(String),
    predecessorGapMinutes: Math.max(number(options.dependencyGapMinutes ?? MINIMUM_SUCCESSOR_GAP_MINUTES), 0),
    releaseDate: fixed ? startDate : utcDateTime(item.scheduleDate, toMinute(options.dayStart || "07:00") ?? 420),
    dueDate,
    baselineStartDate: startDate,
    fixedStartDate: fixed ? startDate : null,
    required: candidates.length > 0,
    unscheduledPenalty: 10000000,
    tardinessWeight: 100000,
    movementWeight: 1,
    _source: item,
  };
}

function displayTimeFor(date, scheduleDate) {
  const start = new Date(`${dateKey(scheduleDate)}T00:00:00.000Z`);
  const minutes = Math.round((new Date(date) - start) / 60000);
  return toTime(Math.max(minutes, 0));
}

async function runDailySolver(items = [], options = {}) {
  if (!items.length) return { items: [], changes: [], warnings: [], solver: { status: "OPTIMAL", engine: "OR_TOOLS_WASM_CP_SAT" } };
  const { solveFiniteSchedule } = require("./solver/planningSolverService");
  const dates = items.map((item) => new Date(item.scheduleDate)).filter((date) => !Number.isNaN(date.getTime()));
  const first = new Date(Math.min(...dates));
  first.setUTCDate(first.getUTCDate() - 1);
  const last = new Date(Math.max(...dates));
  last.setUTCDate(last.getUTCDate() + Math.max(number(options.horizonDays), 14));
  const resourceAvailability = resourceAvailabilityFromWindows(options.windowsByMachine, toMinute(options.dayStart || "07:00") ?? 420);
  const taskDefinitions = items.map((item) => solverTask(item, options));
  if (options.windowsByMachine && (options.windowsByMachine instanceof Map ? options.windowsByMachine.size : Object.keys(options.windowsByMachine).length)) {
    for (const task of taskDefinitions) for (const resourceId of task.eligibleResourceIds || []) resourceAvailability[resourceId] ||= [];
  }
  const solverInput = {
    horizonStart: first,
    horizonEnd: last,
    calendar: completeCalendar(first, last),
    dailyWindows: [{ startMinute: 0, endMinute: 1440 }],
    resourceAvailability: Object.keys(resourceAvailability).length ? resourceAvailability : undefined,
    tasks: taskDefinitions,
    options: {
      maxTimeInSeconds: number(options.maxTimeInSeconds) || 30,
      numSearchWorkers: number(options.numSearchWorkers) || 2,
      randomSeed: 1,
    },
  };
  let solverRun = null;
  if (options.prisma) {
    const { enqueueSolverRun } = require("./solver/planningSolverRunService");
    solverRun = await enqueueSolverRun(options.prisma, {
      scope: "DAILY_SCHEDULE",
      referenceType: options.referenceType || "DAILY_PLAN",
      referenceNumber: options.referenceNumber || dateKey(first),
      modelVersion: "OR-TOOLS-WASM-CP-SAT-V1",
      inputSnapshot: solverInput,
      requestedBy: options.actor || "system",
      status: "RUNNING",
    });
  }
  let result;
  try {
    result = await solveFiniteSchedule(solverInput);
    if (!result.feasible) {
      const infeasible = new Error(`Daily planning solver tidak menemukan schedule feasible (${result.status}).`);
      infeasible.statusCode = 409;
      infeasible.code = "DAILY_SOLVER_INFEASIBLE";
      infeasible.solver = result;
      throw infeasible;
    }
    if (solverRun) {
      const { completeSolverRun } = require("./solver/planningSolverRunService");
      await completeSolverRun(options.prisma, solverRun.id, result);
    }
  } catch (error) {
    if (solverRun) {
      const { failSolverRun } = require("./solver/planningSolverRunService");
      await failSolverRun(options.prisma, solverRun.id, error);
    }
    throw error;
  }
  const solvedById = new Map(result.tasks.map((task) => [String(task.id), task]));
  const warnings = [];
  const scheduledItems = items.map((item) => {
    const id = String(item.productionPlanAllocationId || item.id);
    const solved = solvedById.get(id);
    if (!solved?.scheduled) {
      warnings.push({
        code: candidateMachines(item).length ? "DAILY_SOLVER_UNSCHEDULED" : "DAILY_RELEASE_MACHINE_UNAVAILABLE",
        itemId: item.id || null,
        machineId: item.machineId || null,
        message: `${item.partCode || "Operation"} tidak dapat ditempatkan oleh planning solver.`,
      });
      return { ...item, machineId: null, plannedStartTime: null, plannedEndTime: null, solverEngine: result.engine, solverStatus: result.status };
    }
    const scheduleDate = dateKey(solved.startDate);
    if (number(solved.tardinessMinutes) > 0) warnings.push({
      code: "DAILY_SOLVER_LATE",
      itemId: item.id || null,
      machineId: solved.resourceId,
      tardinessMinutes: solved.tardinessMinutes,
      message: `${item.partCode || "Operation"} terlambat ${solved.tardinessMinutes} menit terhadap due window.`,
    });
    return {
      ...item,
      machineId: solved.resourceId,
      scheduleDate: item.scheduleDate instanceof Date ? new Date(`${scheduleDate}T00:00:00.000Z`) : scheduleDate,
      plannedStartTime: displayTimeFor(solved.startDate, scheduleDate),
      plannedEndTime: displayTimeFor(solved.endDate, scheduleDate),
      solverEngine: result.engine,
      solverStatus: result.status,
      solverTardinessMinutes: solved.tardinessMinutes,
    };
  });
  const changes = scheduledItems.filter((item, index) =>
    dateKey(item.scheduleDate) !== dateKey(items[index].scheduleDate)
    || item.machineId !== items[index].machineId
    || item.plannedStartTime !== items[index].plannedStartTime
    || item.plannedEndTime !== items[index].plannedEndTime);
  return { items: scheduledItems, changes, warnings, solver: result };
}

async function autoCorrectWorkPlacements(items = [], options = {}) {
  return runDailySolver(items, options);
}

async function scheduleDailyReleaseAllocations(allocations = [], options = {}) {
  return runDailySolver(allocations, options);
}
module.exports = { MINIMUM_SUCCESSOR_GAP_MINUTES, toMinute, toTime, allocationDuration, normalizePlacementWindows, autoCorrectWorkPlacements, scheduleDailyReleaseAllocations };
