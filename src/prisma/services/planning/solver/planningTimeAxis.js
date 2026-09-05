"use strict";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function asDate(value, label = "date") {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} wajib berupa tanggal yang valid.`);
  return date;
}

function dateKey(value) {
  return asDate(value).toISOString().slice(0, 10);
}

function startOfUtcDay(value) {
  const date = asDate(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function normalizeCalendar(calendar = {}) {
  if (Array.isArray(calendar)) {
    return new Map(calendar.map((row) => [dateKey(row.date || row.scheduleDate || row), String(row.status || "HOLIDAY").toUpperCase()]));
  }
  if (calendar instanceof Map) return new Map(calendar);
  return new Map(Object.entries(calendar || {}).map(([key, value]) => [key.slice(0, 10), String(value?.status || value).toUpperCase()]));
}

function isWorkingDate(value, calendar = new Map()) {
  const date = asDate(value);
  const override = calendar.get(dateKey(date));
  if (["WORKING", "OPEN", "AVAILABLE"].includes(override)) return true;
  if (["HOLIDAY", "CLOSED", "UNAVAILABLE", "OFF"].includes(override)) return false;
  return ![0, 6].includes(date.getUTCDay());
}

function normalizeWindows(windows) {
  const source = Array.isArray(windows) && windows.length ? windows : [{ startMinute: 0, endMinute: 8 * 60 }];
  return source.map((row) => ({
    startMinute: Math.max(Number(row.startMinute ?? row.start ?? 0), 0),
    endMinute: Math.min(Math.max(Number(row.endMinute ?? row.end ?? 8 * 60), 1), 24 * 60),
  })).filter((row) => row.endMinute > row.startMinute).sort((a, b) => a.startMinute - b.startMinute);
}

function shiftWorkingDays(value, amount, calendar = {}) {
  const normalizedCalendar = normalizeCalendar(Array.isArray(calendar)
    ? Object.fromEntries(calendar.map((date) => [dateKey(date), "HOLIDAY"]))
    : calendar);
  let cursor = startOfUtcDay(value);
  let remaining = Math.max(Math.ceil(Math.abs(Number(amount) || 0)), 0);
  const direction = Number(amount) < 0 ? -1 : 1;
  while (remaining > 0) {
    cursor = new Date(cursor.getTime() + direction * DAY_MS);
    if (isWorkingDate(cursor, normalizedCalendar)) remaining -= 1;
  }
  return cursor;
}

function createWorkingMinuteAxis({ horizonStart, horizonEnd, calendar = {}, dailyWindows } = {}) {
  const start = startOfUtcDay(horizonStart);
  const end = startOfUtcDay(horizonEnd);
  if (end < start) throw new Error("Horizon planning tidak valid.");
  const normalizedCalendar = normalizeCalendar(calendar);
  const windows = normalizeWindows(dailyWindows);
  const slotToTimestamp = [];
  const daySlots = new Map();
  for (let day = new Date(start); day <= end; day = new Date(day.getTime() + DAY_MS)) {
    if (!isWorkingDate(day, normalizedCalendar)) continue;
    const slots = [];
    for (const window of windows) {
      for (let minute = window.startMinute; minute < window.endMinute; minute += 1) {
        const slot = slotToTimestamp.length;
        slotToTimestamp.push(day.getTime() + minute * MINUTE_MS);
        slots.push(slot);
      }
    }
    if (slots.length) daySlots.set(dateKey(day), { first: slots[0], last: slots[slots.length - 1] });
  }
  if (!slotToTimestamp.length) throw new Error("Kalender solver tidak mempunyai waktu kerja pada horizon yang dipilih.");

  function slotAtOrAfter(value) {
    const timestamp = asDate(value).getTime();
    let low = 0;
    let high = slotToTimestamp.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (slotToTimestamp[middle] < timestamp) low = middle + 1;
      else high = middle;
    }
    return Math.min(low, slotToTimestamp.length - 1);
  }

  function slotAtOrBefore(value) {
    const timestamp = asDate(value).getTime();
    let low = 0;
    let high = slotToTimestamp.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (slotToTimestamp[middle] <= timestamp) low = middle + 1;
      else high = middle;
    }
    return Math.max(low - 1, 0);
  }

  function dateAt(slot, { endExclusive = false } = {}) {
    const safe = Math.min(Math.max(Math.round(Number(slot) || 0), 0), slotToTimestamp.length - 1);
    return new Date(slotToTimestamp[safe] + (endExclusive ? MINUTE_MS : 0));
  }

  return {
    horizonStart: start,
    horizonEnd: end,
    horizonMinutes: slotToTimestamp.length,
    slotAtOrAfter,
    slotAtOrBefore,
    dateAt,
    daySlots,
    calendar: normalizedCalendar,
    dailyWindows: windows,
  };
}

module.exports = { MINUTE_MS, DAY_MS, asDate, dateKey, startOfUtcDay, normalizeCalendar, isWorkingDate, shiftWorkingDays, createWorkingMinuteAxis };
