"use strict";

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const dateKey = (value) => String(value instanceof Date ? value.toISOString() : value || "").slice(0, 10);

function toMinute(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) return null;
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

function scheduleDailyReleaseAllocations(allocations = [], options = {}) {
  const defaultStart = toMinute(options.dayStart || "07:00") ?? 420;
  const dependencyGapMinutes = Math.max(number(options.dependencyGapMinutes ?? 60), 0);
  const byId = new Map((allocations || []).filter((item) => item?.id).map((item) => [item.id, item]));
  const depthMemo = new Map();
  const ordered = [...(allocations || [])].sort((left, right) =>
    dateKey(left.scheduleDate).localeCompare(dateKey(right.scheduleDate))
    || dependencyDepth(left, byId, depthMemo) - dependencyDepth(right, byId, depthMemo)
    || number(left.sequence) - number(right.sequence)
    || String(left.id || "").localeCompare(String(right.id || "")));
  const machineAvailableAt = new Map();
  const partMachine = new Map();
  const scheduledById = new Map();
  const warnings = [];

  const items = ordered.map((source) => {
    const item = { ...source };
    const day = dateKey(item.scheduleDate);
    const workCenter = item.workCenterId || `MACHINE-GROUP:${item.machineId || "UNASSIGNED"}`;
    const partKey = `${day}|${workCenter}|${item.partCode || item.id || "PART"}`;
    const candidates = candidateMachines(item);
    if (!candidates.length) {
      warnings.push({
        code: "DAILY_RELEASE_MACHINE_UNAVAILABLE",
        allocationId: item.id || null,
        partCode: item.partCode || null,
        machineId: null,
        scheduleDate: day,
        message: `${item.partCode || "Part"} belum mempunyai mesin aktif pada tanggal Daily Release.`,
      });
    }
    const baseStart = toMinute(item.plannedStartTime) ?? defaultStart;
    const duration = allocationDuration(item, options.defaultDurationMinutes || 60);
    const predecessorSchedules = (Array.isArray(item.predecessorAllocationIds) ? item.predecessorAllocationIds : [])
      .map((id) => scheduledById.get(id))
      .filter((predecessor) => predecessor && dateKey(predecessor.scheduleDate) === day);
    const dependencyStart = predecessorSchedules.length
      ? Math.max(...predecessorSchedules.map((predecessor) => number(predecessor._endMinute) + dependencyGapMinutes))
      : baseStart;

    let machineId = partMachine.get(partKey) || null;
    if (!machineId || !candidates.includes(machineId)) {
      machineId = [...candidates].sort((left, right) => {
        const leftAvailable = number(machineAvailableAt.get(`${day}|${left}`));
        const rightAvailable = number(machineAvailableAt.get(`${day}|${right}`));
        if (leftAvailable !== rightAvailable) return leftAvailable - rightAvailable;
        if (left === item.machineId) return -1;
        if (right === item.machineId) return 1;
        return String(left).localeCompare(String(right));
      })[0] || (Array.isArray(item.eligibleMachineIds) ? null : item.machineId) || null;
      if (machineId) partMachine.set(partKey, machineId);
    }

    const machineKey = `${day}|${machineId || "UNASSIGNED"}`;
    const machineStart = number(machineAvailableAt.get(machineKey));
    const start = Math.max(baseStart, dependencyStart, machineStart);
    const end = start + duration;
    const waitedForMachine = machineStart > baseStart && dependencyStart <= machineStart;
    if (waitedForMachine && candidates.length <= 1 && !predecessorSchedules.length) {
      warnings.push({
        code: "DAILY_RELEASE_SINGLE_MACHINE_QUEUE",
        allocationId: item.id || null,
        partCode: item.partCode || null,
        machineId,
        scheduleDate: day,
        message: `${item.partCode || "Part"} diantrikan utuh pada satu-satunya mesin yang tersedia; quantity tidak di-split.`,
      });
    }
    if (end > 1440) {
      warnings.push({
        code: "DAILY_RELEASE_DAY_OVERRUN",
        allocationId: item.id || null,
        partCode: item.partCode || null,
        machineId,
        scheduleDate: day,
        message: `${item.partCode || "Part"} selesai melewati batas hari dan perlu koreksi PPIC.`,
      });
    }
    machineAvailableAt.set(machineKey, end);
    const scheduled = {
      ...item,
      machineId,
      plannedStartTime: toTime(start),
      plannedEndTime: toTime(end),
      _startMinute: start,
      _endMinute: end,
    };
    if (item.id) scheduledById.set(item.id, scheduled);
    return scheduled;
  }).map(({ _startMinute, _endMinute, ...item }) => item);

  return { items, warnings };
}

module.exports = { toMinute, toTime, allocationDuration, scheduleDailyReleaseAllocations };
