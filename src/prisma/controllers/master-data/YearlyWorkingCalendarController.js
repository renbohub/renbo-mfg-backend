"use strict";

const crypto = require("node:crypto");
const { prisma } = require("../../index");
const { invalidateRccpByMachineCalendarRange } = require("../../services/planning/rccpService");
const {
  MARKER_PREFIX,
  dateKey,
  datesForEvent,
  markerFor,
  normalizeEventInput,
  parseMarker,
  shiftsForDate,
} = require("../../services/planning/yearlyWorkingCalendarService");

const profileInclude = {
  rules: { include: { shift: true }, orderBy: [{ dayOfWeek: "asc" }, { shift: { sequence: "asc" } }] },
};

function httpError(message, status = 400) {
  const error = new Error(message); error.status = status; return error;
}

function activeMachine(row) {
  return !["INACTIVE", "RETIRED"].includes(String(row.status || "").toUpperCase());
}

function presentGroups(rows, machineCount) {
  const groups = new Map();
  rows.forEach((row) => {
    const marker = parseMarker(row.reason);
    if (!marker) return;
    if (!groups.has(marker.eventId)) groups.set(marker.eventId, { marker, rows: [] });
    groups.get(marker.eventId).rows.push(row);
  });
  return [...groups.values()].map(({ marker, rows: eventRows }) => {
    const dates = [...new Set(eventRows.map((row) => dateKey(row.scheduleDate)))].sort();
    const machineIds = new Set(eventRows.map((row) => row.machineId));
    const statuses = [...new Set(eventRows.map((row) => row.dayStatus))];
    const representative = eventRows[0];
    const applicableDays = [...new Set(dates.map((date) => {
      const day = new Date(`${date}T00:00:00.000Z`).getUTCDay(); return day === 0 ? 7 : day;
    }))].sort((a, b) => a - b);
    return {
      id: marker.eventId,
      eventId: marker.eventId,
      eventName: marker.eventName,
      eventType: marker.eventType,
      workingHourProfileCode: marker.profileCode,
      dateFrom: dates[0],
      dateTo: dates[dates.length - 1],
      dates,
      applicableDays,
      dayStatus: statuses.length === 1 ? statuses[0] : "MIXED",
      shiftsPerDay: representative.shiftsPerDay,
      shiftOverrides: representative.shiftOverrides || [],
      appliedMachineCount: machineIds.size,
      machineCount,
      coverageStatus: machineCount > 0 && machineIds.size >= machineCount ? "COMPLETE" : "PARTIAL",
      overrideCount: eventRows.length,
      changedBy: representative.changedBy,
      updatedAt: eventRows.reduce((latest, row) => row.updatedAt > latest ? row.updatedAt : latest, representative.updatedAt),
    };
  }).sort((a, b) => a.dateFrom.localeCompare(b.dateFrom) || a.eventName.localeCompare(b.eventName));
}

async function loadActiveMachines(client = prisma) {
  const rows = await client.machine.findMany({ where: { isDeleted: false }, select: { id: true, machineCode: true, machineName: true, status: true } });
  return rows.filter(activeMachine);
}

async function findProfile(client, payload) {
  if (payload.dayStatus !== "WORKING") return null;
  if (!payload.workingHourProfileId) throw httpError("Working Hour Profile wajib dipilih untuk hari kerja khusus.");
  const profile = await client.workingHourProfile.findFirst({ where: { id: payload.workingHourProfileId, isDeleted: false, isActive: true }, include: profileInclude });
  if (!profile) throw httpError("Working Hour Profile aktif tidak ditemukan.");
  return profile;
}

async function saveEvent(req, res, next) {
  try {
    const payload = normalizeEventInput(req.body);
    const eventId = req.params.eventId || crypto.randomUUID();
    const machines = await loadActiveMachines();
    if (!machines.length) throw httpError("Tidak ada mesin aktif untuk menerima kalender kerja.", 409);
    const profile = await findProfile(prisma, payload);
    const requestedDates = datesForEvent(payload.dateFrom, payload.dateTo, payload.applicableDays);
    const skippedNoShift = [];
    const dateSettings = requestedDates.map((scheduleDate) => {
      const shiftOverrides = payload.dayStatus === "WORKING" ? shiftsForDate(profile, scheduleDate) : [];
      if (payload.dayStatus === "WORKING" && !shiftOverrides.length) skippedNoShift.push(dateKey(scheduleDate));
      return { scheduleDate, shiftOverrides };
    }).filter((entry) => payload.dayStatus === "HOLIDAY" || entry.shiftOverrides.length > 0);
    if (payload.dayStatus === "WORKING" && skippedNoShift.length) {
      throw httpError(`Working day tidak dapat diterapkan: ${skippedNoShift.length} tanggal tidak memiliki Shift Master aktif pada profile ${profile.profileCode}.`);
    }
    if (!dateSettings.length) throw httpError("Profile tidak memiliki shift aktif pada hari yang dipilih.");
    const changedBy = req.user?.username || req.user?.email || "system";
    const marker = markerFor(eventId, payload.eventType, profile?.profileCode, payload.eventName);
    const machineIds = machines.map((machine) => machine.id);
    const dateValues = dateSettings.map((entry) => entry.scheduleDate);

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.capacityCalendarOverride.findMany({
        where: { machineId: { in: machineIds }, scheduleDate: { in: dateValues } },
        select: { id: true, machineId: true, scheduleDate: true, reason: true, isDeleted: true },
      });
      const existingMap = new Map(existing.map((row) => [`${row.machineId}|${dateKey(row.scheduleDate)}`, row]));
      const conflicts = [];
      const updates = [];
      const creates = [];
      for (const machine of machines) {
        for (const setting of dateSettings) {
          const key = `${machine.id}|${dateKey(setting.scheduleDate)}`;
          const current = existingMap.get(key);
          const currentMarker = parseMarker(current?.reason);
          const belongsToEvent = currentMarker?.eventId === eventId;
          if (current && !current.isDeleted && !belongsToEvent && !payload.overwriteExisting) {
            conflicts.push({ machineCode: machine.machineCode, scheduleDate: dateKey(setting.scheduleDate), reason: current.reason || "Override manual" });
            continue;
          }
          const values = {
            dayStatus: payload.dayStatus,
            shiftsPerDay: payload.dayStatus === "HOLIDAY" ? 0 : setting.shiftOverrides.length,
            shiftOverrides: setting.shiftOverrides,
            overtimeStart: null,
            overtimeEnd: null,
            reason: marker,
            changedBy,
            changedAt: new Date(),
            isDeleted: false,
          };
          if (current) updates.push({ id: current.id, data: values });
          else creates.push({ machineId: machine.id, scheduleDate: setting.scheduleDate, ...values });
        }
      }
      if (req.params.eventId) {
        await tx.capacityCalendarOverride.updateMany({
          where: { reason: { startsWith: `${MARKER_PREFIX}${eventId}:` } },
          data: { isDeleted: true, changedBy, changedAt: new Date() },
        });
      }
      for (const row of updates) await tx.capacityCalendarOverride.update({ where: { id: row.id }, data: row.data });
      if (creates.length) await tx.capacityCalendarOverride.createMany({ data: creates });
      const affectedDates = dateSettings.map((entry) => entry.scheduleDate);
      const invalidatedMpsCount = await invalidateRccpByMachineCalendarRange(
        tx, machineIds,
        affectedDates.reduce((min, date) => date < min ? date : min, affectedDates[0]),
        affectedDates.reduce((max, date) => date > max ? date : max, affectedDates[0]),
      );
      return { conflicts, appliedOverrideCount: updates.length + creates.length, invalidatedMpsCount };
    }, { maxWait: 30000, timeout: 120000 });

    res.status(req.params.eventId ? 200 : 201).json({
      ok: true, eventId, ...result, skippedNoShift: [...new Set(skippedNoShift)],
      message: `${payload.eventName} diterapkan ke ${result.appliedOverrideCount} kalender mesin.`,
    });
  } catch (error) { next(error); }
}

exports.list = async (req, res, next) => {
  try {
    const year = Number(req.query.year || new Date().getUTCFullYear());
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw httpError("Tahun kalender harus antara 2000 dan 2100.");
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year + 1, 0, 1));
    const [machines, rows] = await Promise.all([
      loadActiveMachines(),
      prisma.capacityCalendarOverride.findMany({
        where: { scheduleDate: { gte: start, lt: end }, isDeleted: false, reason: { startsWith: MARKER_PREFIX } },
        include: { machine: { select: { machineCode: true, machineName: true } } },
        orderBy: [{ scheduleDate: "asc" }, { machineId: "asc" }],
      }),
    ]);
    const items = presentGroups(rows, machines.length);
    res.json({ items, total: items.length, year, machineCount: machines.length });
  } catch (error) { next(error); }
};

exports.create = saveEvent;
exports.update = saveEvent;

exports.remove = async (req, res, next) => {
  try {
    const eventId = String(req.params.eventId || "");
    const rows = await prisma.capacityCalendarOverride.findMany({
      where: { reason: { startsWith: `${MARKER_PREFIX}${eventId}:` }, isDeleted: false },
      select: { machineId: true, scheduleDate: true },
    });
    if (!rows.length) return res.status(404).json({ message: "Event kalender tidak ditemukan." });
    const machineIds = [...new Set(rows.map((row) => row.machineId))];
    const dates = rows.map((row) => row.scheduleDate);
    const changedBy = req.user?.username || req.user?.email || "system";
    const invalidatedMpsCount = await prisma.$transaction(async (tx) => {
      await tx.capacityCalendarOverride.updateMany({
        where: { reason: { startsWith: `${MARKER_PREFIX}${eventId}:` }, isDeleted: false },
        data: { isDeleted: true, changedBy, changedAt: new Date() },
      });
      return invalidateRccpByMachineCalendarRange(
        tx, machineIds,
        dates.reduce((min, date) => date < min ? date : min, dates[0]),
        dates.reduce((max, date) => date > max ? date : max, dates[0]),
      );
    }, { maxWait: 30000, timeout: 120000 });
    res.json({ ok: true, removedOverrideCount: rows.length, invalidatedMpsCount });
  } catch (error) { next(error); }
};

exports._private = { presentGroups };
