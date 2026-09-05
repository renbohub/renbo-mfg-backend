"use strict";

const EVENT_TYPES = new Set([
  "NATIONAL_HOLIDAY",
  "COLLECTIVE_LEAVE",
  "RAMADAN_SHIFT",
  "COMPANY_EVENT",
  "MAINTENANCE",
  "OTHER",
]);
const HOLIDAY_EVENT_TYPES = new Set(["NATIONAL_HOLIDAY", "COLLECTIVE_LEAVE"]);
const MARKER_PREFIX = "[YEARLY-CALENDAR:";
const MARKER_PATTERN = /^\[YEARLY-CALENDAR:([^:]+):([A-Z_]+):([^\]]+)\]\s*(.*)$/;

function dateOnly(value, fieldName = "tanggal") {
  const raw = String(value || "").slice(0, 10);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00.000Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    const error = new Error(`${fieldName} tidak valid.`);
    error.status = 400;
    throw error;
  }
  return parsed;
}

function dateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function isoDay(value) {
  const day = new Date(value).getUTCDay();
  return day === 0 ? 7 : day;
}

function datesForEvent(dateFrom, dateTo, applicableDays = [1, 2, 3, 4, 5, 6, 7]) {
  const allowed = new Set(applicableDays.map(Number));
  const result = [];
  for (let cursor = new Date(dateFrom); cursor <= dateTo; cursor = new Date(cursor.getTime() + 86400000)) {
    if (allowed.has(isoDay(cursor))) result.push(cursor);
  }
  return result;
}

function markerFor(eventId, eventType, profileCode, eventName) {
  return `${MARKER_PREFIX}${eventId}:${eventType}:${profileCode || "NONE"}] ${String(eventName).trim()}`;
}

function parseMarker(reason) {
  const match = String(reason || "").match(MARKER_PATTERN);
  if (!match) return null;
  return { eventId: match[1], eventType: match[2], profileCode: match[3] === "NONE" ? null : match[3], eventName: match[4] };
}

function normalizeEventInput(body = {}) {
  const eventName = String(body.eventName || "").trim();
  const eventType = String(body.eventType || "COMPANY_EVENT").trim().toUpperCase();
  if (!eventName) {
    const error = new Error("Nama event wajib diisi."); error.status = 400; throw error;
  }
  if (!EVENT_TYPES.has(eventType)) {
    const error = new Error("Tipe event kalender tidak valid."); error.status = 400; throw error;
  }
  const dateFrom = dateOnly(body.dateFrom, "Tanggal mulai");
  const dateTo = dateOnly(body.dateTo, "Tanggal selesai");
  if (dateTo < dateFrom) {
    const error = new Error("Tanggal selesai tidak boleh sebelum tanggal mulai."); error.status = 400; throw error;
  }
  if (dateFrom.getUTCFullYear() !== dateTo.getUTCFullYear()) {
    const error = new Error("Satu event harus berada dalam tahun kalender yang sama."); error.status = 400; throw error;
  }
  const span = Math.floor((dateTo - dateFrom) / 86400000) + 1;
  if (span > 366) {
    const error = new Error("Rentang event maksimal 366 hari."); error.status = 400; throw error;
  }
  const dayStatus = HOLIDAY_EVENT_TYPES.has(eventType)
    ? "HOLIDAY"
    : String(body.dayStatus || "WORKING").trim().toUpperCase();
  if (!["WORKING", "HOLIDAY"].includes(dayStatus)) {
    const error = new Error("Status hari harus WORKING atau HOLIDAY."); error.status = 400; throw error;
  }
  const applicableDays = [...new Set((Array.isArray(body.applicableDays) ? body.applicableDays : [1, 2, 3, 4, 5, 6, 7]).map(Number))]
    .filter((day) => day >= 1 && day <= 7).sort((a, b) => a - b);
  if (!applicableDays.length) {
    const error = new Error("Pilih minimal satu hari penerapan."); error.status = 400; throw error;
  }
  return {
    eventName, eventType, dateFrom, dateTo, dayStatus, applicableDays,
    workingHourProfileId: dayStatus === "WORKING" ? String(body.workingHourProfileId || "").trim() || null : null,
    overwriteExisting: body.overwriteExisting === true || body.overwriteExisting === "true",
  };
}

function shiftsForDate(profile, scheduleDate) {
  if (!profile) return [];
  return (profile.rules || [])
    .filter((rule) => rule.isEnabled && Number(rule.dayOfWeek) === isoDay(scheduleDate))
    .map((rule) => ({
      shiftCode: rule.shift?.shiftCode || null,
      shiftName: rule.shift?.shiftName || null,
      startTime: rule.startTime,
      endTime: rule.endTime,
      breakMinutes: Number(rule.breakMinutes || 0),
      overtimeMinutes: Number(rule.overtimeMinutes || 0),
    }));
}

module.exports = {
  EVENT_TYPES,
  HOLIDAY_EVENT_TYPES,
  MARKER_PREFIX,
  dateKey,
  datesForEvent,
  isoDay,
  markerFor,
  normalizeEventInput,
  parseMarker,
  shiftsForDate,
};
