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

function nextPlacementSlot({ windows, occupied, earliestStart, duration }) {
  for (const window of windows) {
    let cursor = Math.max(number(earliestStart), window.start);
    if (cursor + duration > window.end) continue;
    for (const interval of occupied) {
      if (interval.end <= cursor || interval.start >= window.end) continue;
      if (interval.start >= cursor + duration) break;
      cursor = Math.max(cursor, interval.end);
      if (cursor + duration > window.end) break;
    }
    if (cursor + duration <= window.end) return { start: cursor, end: cursor + duration, shift: window.shift, date: window.date, dayBase: window.dayBase };
  }
  return null;
}

function autoCorrectWorkPlacements(items = [], options = {}) {
  const dayStart = toMinute(options.dayStart || "07:00") ?? 420;
  const dependencyGapMinutes = Math.max(number(options.dependencyGapMinutes ?? MINIMUM_SUCCESSOR_GAP_MINUTES), 0);
  const windowsByMachine = options.windowsByMachine instanceof Map
    ? options.windowsByMachine
    : new Map(Object.entries(options.windowsByMachine || {}));
  const identity = (item) => item.productionPlanAllocationId || item.id;
  const byIdentity = new Map(items.map((item) => [identity(item), item]).filter(([id]) => id));
  const dependencyItems = new Map([...byIdentity].map(([id, item]) => [id, { ...item, id }]));
  const depthMemo = new Map();
  const occupiedByMachine = new Map();
  const correctedByIdentity = new Map();
  const lastPlacedEndByGroup = new Map();
  const warnings = [];
  const movable = [];
  const groupFirstStart = new Map();

  for (const item of items) {
    const start = absoluteScheduleMinutes(item, "plannedStartTime", dayStart);
    let end = absoluteScheduleMinutes(item, "plannedEndTime", dayStart);
    if (start != null && end != null && end <= start) end += 1440;
    if (item.movable === false || ["Released", "In Progress", "Completed"].includes(item.status)) {
      if (item.machineId && start != null && end != null) {
        const rows = occupiedByMachine.get(item.machineId) || [];
        rows.push({ start, end, fixed: true, id: identity(item) });
        occupiedByMachine.set(item.machineId, rows);
      }
      correctedByIdentity.set(identity(item), { ...item, _startAbsolute: start, _endAbsolute: end });
    } else {
      movable.push(item);
      const key = placementMergeKey(item);
      const start = operationalMinute(item.plannedStartTime, dayStart);
      const previous = groupFirstStart.get(key);
      groupFirstStart.set(key, previous == null ? number(start) : Math.min(previous, number(start)));
    }
  }

  movable.sort((left, right) =>
    dateKey(left.scheduleDate).localeCompare(dateKey(right.scheduleDate))
    || dependencyDepth({ ...left, id: identity(left) }, dependencyItems, depthMemo) - dependencyDepth({ ...right, id: identity(right) }, dependencyItems, depthMemo)
    || number(left.sequence) - number(right.sequence)
    // Keep identical operations together. The individual records remain
    // available for lineage/release, but Auto Correct places them as one
    // continuous production run so the Daily Plan can present one total.
    || number(groupFirstStart.get(placementMergeKey(left))) - number(groupFirstStart.get(placementMergeKey(right)))
    || placementMergeKey(left).localeCompare(placementMergeKey(right))
    || number(operationalMinute(left.plannedStartTime, dayStart)) - number(operationalMinute(right.plannedStartTime, dayStart)));

  for (const item of movable) {
    const id = identity(item);
    const mergeKey = placementMergeKey(item);
    const windows = item.machineId ? machinePlacementWindows(windowsByMachine, item.machineId, item.scheduleDate, dayStart) : [];
    if (!item.machineId || !windows.length) {
      warnings.push({ code: item.machineId ? "DAILY_WORK_WINDOW_UNAVAILABLE" : "DAILY_RELEASE_MACHINE_UNAVAILABLE", itemId: item.id || null, machineId: item.machineId || null, message: item.machineId ? "Jam kerja mesin belum tersedia untuk tanggal ini." : "Mesin belum dipilih." });
      const start = absoluteScheduleMinutes(item, "plannedStartTime", dayStart);
      let end = absoluteScheduleMinutes(item, "plannedEndTime", dayStart);
      if (start != null && end != null && end <= start) end += 1440;
      correctedByIdentity.set(id, { ...item, _startAbsolute: start, _endAbsolute: end });
      continue;
    }
    const duration = allocationDuration(item, options.defaultDurationMinutes || 60);
    const parsedOriginalStart = absoluteScheduleMinutes(item, "plannedStartTime", dayStart);
    const previousIdenticalEnd = lastPlacedEndByGroup.get(mergeKey);
    const originalStart = previousIdenticalEnd != null
      ? previousIdenticalEnd
      : parsedOriginalStart != null && windows.some((window) => parsedOriginalStart >= window.start && parsedOriginalStart + duration <= window.end)
        ? parsedOriginalStart
        : windows[0].start;
    const predecessorEnd = (Array.isArray(item.predecessorAllocationIds) ? item.predecessorAllocationIds : [])
      .map((predecessorId) => correctedByIdentity.get(predecessorId)?._endAbsolute)
      .filter((value) => value != null);
    const earliestStart = Math.max(originalStart, predecessorEnd.length ? Math.max(...predecessorEnd) + dependencyGapMinutes : originalStart);
    const occupied = (occupiedByMachine.get(item.machineId) || []).sort((left, right) => left.start - right.start || left.end - right.end);
    const slot = nextPlacementSlot({ windows, occupied, earliestStart, duration });
    if (!slot) {
      warnings.push({ code: "DAILY_WORK_WINDOW_FULL", itemId: item.id || null, machineId: item.machineId, message: `${item.partCode || "Operation"} tidak mempunyai slot kerja yang cukup sampai akhir horizon Auto Correct.` });
      const start = absoluteScheduleMinutes(item, "plannedStartTime", dayStart);
      let end = absoluteScheduleMinutes(item, "plannedEndTime", dayStart);
      if (start != null && end != null && end <= start) end += 1440;
      correctedByIdentity.set(id, { ...item, _startAbsolute: start, _endAbsolute: end });
      continue;
    }
    const correctedDate = item.scheduleDate instanceof Date ? new Date(`${slot.date}T00:00:00.000Z`) : slot.date;
    const corrected = { ...item, scheduleDate: correctedDate, plannedStartTime: displayPlacementTime(slot.start, slot.dayBase), plannedEndTime: displayPlacementTime(slot.end, slot.dayBase), shift: slot.shift, _startAbsolute: slot.start, _endAbsolute: slot.end };
    occupied.push({ start: slot.start, end: slot.end, fixed: false, id });
    occupiedByMachine.set(item.machineId, occupied);
    lastPlacedEndByGroup.set(mergeKey, slot.end);
    correctedByIdentity.set(id, corrected);
  }

  const correctedItems = items.map((item) => correctedByIdentity.get(identity(item)) || item).map(({ _startAbsolute, _endAbsolute, ...item }) => item);
  const changes = correctedItems.filter((item, index) => dateKey(item.scheduleDate) !== dateKey(items[index].scheduleDate) || item.plannedStartTime !== items[index].plannedStartTime || item.plannedEndTime !== items[index].plannedEndTime || String(item.shift || "") !== String(items[index].shift || ""));
  return { items: correctedItems, changes, warnings };
}

function scheduleDailyReleaseAllocations(allocations = [], options = {}) {
  const defaultStart = toMinute(options.dayStart || "07:00") ?? 420;
  const dependencyGapMinutes = Math.max(number(options.dependencyGapMinutes ?? MINIMUM_SUCCESSOR_GAP_MINUTES), 0);
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

module.exports = { MINIMUM_SUCCESSOR_GAP_MINUTES, toMinute, toTime, allocationDuration, normalizePlacementWindows, nextPlacementSlot, autoCorrectWorkPlacements, scheduleDailyReleaseAllocations };
