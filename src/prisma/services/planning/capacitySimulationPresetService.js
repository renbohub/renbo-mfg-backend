const { randomUUID } = require("crypto");

const SETTING_KEY = "CAPACITY_SIMULATION_PRESETS_V1";
const DEFAULT_SHIFTS = [
  { start: "08:00", end: "16:00" },
  { start: "16:00", end: "00:00" },
  { start: "00:00", end: "08:00" },
];

const bounded = (value, min, max, fallback) => {
  const parsed = Number(value);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : fallback, min), max);
};
const bool = (value, fallback = false) => value == null ? fallback : value === true || String(value).toLowerCase() === "true";
const monthKey = (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || "")) ? String(value) : null;
const dateKey = (value) => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(value || "")) ? String(value) : null;
const time = (value, fallback = null) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "")) ? String(value) : fallback;

function normalizeShift(value = {}, index = 0) {
  return {
    start: time(value.start, DEFAULT_SHIFTS[index].start),
    end: time(value.end, DEFAULT_SHIFTS[index].end),
  };
}

function normalizeDailyOverrides(value, presetMonth) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(source).flatMap(([date, rule]) => {
    const validDate = dateKey(date);
    if (!validDate || !validDate.startsWith(`${presetMonth}-`)) return [];
    const shiftCount = Math.round(bounded(rule?.shiftCount, 0, 3, 1));
    const shifts = DEFAULT_SHIFTS.map((_, index) => normalizeShift(rule?.shifts?.[index], index)).slice(0, shiftCount);
    return [[validDate, {
      dayStatus: ["WORKING", "HOLIDAY", "OVERLOAD"].includes(String(rule?.dayStatus || "").toUpperCase()) ? String(rule.dayStatus).toUpperCase() : "WORKING",
      shiftCount,
      shifts,
      overtimeStart: time(rule?.overtimeStart),
      overtimeEnd: time(rule?.overtimeEnd),
      reason: String(rule?.reason || "Daily simulation adjustment").trim().slice(0, 250),
    }]];
  }));
}

function normalizePreset(payload = {}, existing = null, actor = "system") {
  const month = monthKey(payload.month || existing?.month);
  if (!month) throw Object.assign(new Error("Bulan preset wajib menggunakan format YYYY-MM."), { statusCode: 400 });
  const name = String(payload.name || existing?.name || "").trim().slice(0, 100);
  if (!name) throw Object.assign(new Error("Nama preset wajib diisi."), { statusCode: 400 });
  const shiftCount = Math.round(bounded(payload.shiftCount ?? existing?.shiftCount, 1, 3, 1));
  const suppliedShifts = Array.isArray(payload.shifts) ? payload.shifts : existing?.shifts;
  const shifts = DEFAULT_SHIFTS.map((_, index) => normalizeShift(suppliedShifts?.[index], index));
  const overtimeStart = time(payload.overtimeStart ?? existing?.overtimeStart);
  const overtimeEnd = time(payload.overtimeEnd ?? existing?.overtimeEnd);
  if (Boolean(overtimeStart) !== Boolean(overtimeEnd)) throw Object.assign(new Error("Jam mulai dan selesai overtime harus diisi berpasangan."), { statusCode: 400 });
  return {
    id: existing?.id || `preset-${randomUUID()}`,
    month,
    name,
    planNumber: String(payload.planNumber ?? existing?.planNumber ?? "").trim() || null,
    shiftCount,
    shifts,
    efficiency: bounded(payload.efficiency ?? existing?.efficiency, 1, 100, 85),
    includeSaturday: bool(payload.includeSaturday ?? existing?.includeSaturday, false),
    includeSunday: bool(payload.includeSunday ?? existing?.includeSunday, false),
    overtimeStart,
    overtimeEnd,
    algorithm: {
      method: "DELIVERY_BACKWARD",
      allowParallel: bool(payload.algorithm?.allowParallel ?? existing?.algorithm?.allowParallel, true),
      allowExtraShift: bool(payload.algorithm?.allowExtraShift ?? existing?.algorithm?.allowExtraShift, true),
      allowOvertime: bool(payload.algorithm?.allowOvertime ?? existing?.algorithm?.allowOvertime, true),
    },
    dailyOverrides: normalizeDailyOverrides(payload.dailyOverrides ?? existing?.dailyOverrides, month),
    createdBy: existing?.createdBy || actor,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedBy: actor,
    updatedAt: new Date().toISOString(),
  };
}

async function loadPresetStore(prisma) {
  const row = await prisma.systemSetting.findFirst({ where: { settingKey: SETTING_KEY, isDeleted: false }, select: { settingValue: true } });
  try {
    const parsed = JSON.parse(row?.settingValue || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

async function savePresetStore(prisma, presets, actor) {
  await prisma.systemSetting.upsert({
    where: { settingKey: SETTING_KEY },
    update: { settingValue: JSON.stringify(presets), description: "Monthly PPIC capacity simulation presets", updatedBy: actor, isDeleted: false },
    create: { settingKey: SETTING_KEY, settingValue: JSON.stringify(presets), description: "Monthly PPIC capacity simulation presets", updatedBy: actor },
  });
}

async function findPreset(prisma, id) {
  if (!id) return null;
  return (await loadPresetStore(prisma)).find((preset) => preset.id === id) || null;
}

function shiftDurationMinutes(shift) {
  const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  const start = minutes(shift.start); const end = minutes(shift.end);
  return end > start ? end - start : end + 1440 - start;
}

function presetCapacityQuery(preset) {
  if (!preset) return {};
  const activeShifts = preset.shifts.slice(0, preset.shiftCount);
  const averageHours = activeShifts.reduce((sum, shift) => sum + shiftDurationMinutes(shift), 0) / Math.max(activeShifts.length, 1) / 60;
  let overtimeHours = 0;
  if (preset.overtimeStart && preset.overtimeEnd) overtimeHours = shiftDurationMinutes({ start: preset.overtimeStart, end: preset.overtimeEnd }) / 60;
  return {
    shiftsPerDay: preset.shiftCount,
    shiftHours: averageHours,
    efficiencyPercent: preset.efficiency,
    overtimeHours,
    includeSaturday: preset.includeSaturday,
    includeSunday: preset.includeSunday,
    scenarioName: preset.name,
    planningGranularity: "DAY",
  };
}

module.exports = { SETTING_KEY, DEFAULT_SHIFTS, normalizePreset, loadPresetStore, savePresetStore, findPreset, presetCapacityQuery, shiftDurationMinutes };
