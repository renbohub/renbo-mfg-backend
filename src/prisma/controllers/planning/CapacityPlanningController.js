const { prisma } = require("../../index");
const { buildCapacitySnapshot } = require("../../services/planning/capacityPlanningService");
const { normalizePreset, loadPresetStore, savePresetStore, activePresetId } = require("../../services/planning/capacitySimulationPresetService");

const SCENARIO_KEYS = {
  "simulation-1": "CAPACITY_SCENARIO_SIMULATION_1",
  "simulation-2": "CAPACITY_SCENARIO_SIMULATION_2",
};
const SCENARIO_DEFAULTS = {
  "simulation-1": { name: "Simulation 1", shifts: "2", hours: "8", overtime: "2", saturday: "false", sunday: "false", efficiency: "85", granularity: "DAY", lookbackWeeks: "1", freezeDays: "3" },
  "simulation-2": { name: "Simulation 2", shifts: "2", hours: "8", overtime: "4", saturday: "true", sunday: "false", efficiency: "85", granularity: "WEEK", lookbackWeeks: "1", freezeDays: "1" },
};
const jakartaTodayKey = () => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};
function assertPastPresetDaysUnchanged(existing = null, nextPreset = {}) {
  const today = jakartaTodayKey();
  const previous = existing?.dailyOverrides || {};
  const next = nextPreset.dailyOverrides || {};
  const pastDates = new Set([...Object.keys(previous), ...Object.keys(next)].filter((date) => date < today));
  const changedDate = [...pastDates].find((date) => JSON.stringify(previous[date] || null) !== JSON.stringify(next[date] || null));
  if (changedDate) {
    throw Object.assign(new Error(`Preset tanggal ${changedDate} sudah lewat dan dikunci sebagai histori Production.`), { statusCode: 409, code: "CAPACITY_HISTORY_LOCKED" });
  }
}

function normalizeScenario(key, payload = {}) {
  const fallback = SCENARIO_DEFAULTS[key];
  const bounded = (value, min, max, fallbackValue) => {
    const parsed = Number(value);
    return String(Math.min(Math.max(Number.isFinite(parsed) ? parsed : Number(fallbackValue), min), max));
  };
  return {
    name: String(payload.name || fallback.name).trim().slice(0, 100) || fallback.name,
    shifts: bounded(payload.shifts, 1, 3, fallback.shifts),
    hours: bounded(payload.hours, 1, 24, fallback.hours),
    overtime: bounded(payload.overtime, 0, 12, fallback.overtime),
    saturday: String(payload.saturday) === "true" ? "true" : "false",
    sunday: String(payload.sunday) === "true" ? "true" : "false",
    efficiency: bounded(payload.efficiency, 1, 100, fallback.efficiency),
    granularity: String(payload.granularity || fallback.granularity).toUpperCase() === "WEEK" ? "WEEK" : "DAY",
    lookbackWeeks: bounded(payload.lookbackWeeks, 0, 12, fallback.lookbackWeeks),
    freezeDays: bounded(payload.freezeDays, 0, 31, fallback.freezeDays),
  };
}

exports.snapshot = async (req, res, next) => {
  try {
    res.json(await buildCapacitySnapshot(prisma, req.query));
  } catch (error) {
    next(error);
  }
};

exports.checkPlan = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber: req.params.planNumber, isDeleted: false },
      select: { planNumber: true, periodStart: true, periodEnd: true, status: true },
    });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan." });
    const snapshot = await buildCapacitySnapshot(prisma, {
      ...req.query,
      planNumber: plan.planNumber,
      startDate: req.query.startDate || plan.periodStart,
      endDate: req.query.endDate || plan.periodEnd,
    });
    res.json(snapshot);
  } catch (error) {
    next(error);
  }
};

exports.getScenarios = async (_req, res, next) => {
  try {
    const rows = await prisma.systemSetting.findMany({
      where: { settingKey: { in: Object.values(SCENARIO_KEYS) }, isDeleted: false },
      select: { settingKey: true, settingValue: true, updatedBy: true, updatedAt: true },
    });
    const bySettingKey = new Map(rows.map((row) => [row.settingKey, row]));
    const scenarios = Object.fromEntries(Object.entries(SCENARIO_KEYS).map(([key, settingKey]) => {
      const row = bySettingKey.get(settingKey);
      let stored = {};
      try { stored = JSON.parse(row?.settingValue || "{}"); } catch (_) { stored = {}; }
      return [key, { ...normalizeScenario(key, stored), updatedBy: row?.updatedBy || null, updatedAt: row?.updatedAt || null }];
    }));
    res.json({ scenarios });
  } catch (error) {
    next(error);
  }
};

exports.saveScenario = async (req, res, next) => {
  try {
    const key = String(req.params.scenarioKey || "").toLowerCase();
    const settingKey = SCENARIO_KEYS[key];
    if (!settingKey) return res.status(400).json({ message: "Scenario hanya mendukung simulation-1 dan simulation-2." });
    const scenario = normalizeScenario(key, req.body);
    const updatedBy = req.user?.username || req.user?.email || "system";
    const row = await prisma.systemSetting.upsert({
      where: { settingKey },
      update: { settingValue: JSON.stringify(scenario), description: `Custom Capacity Planning ${scenario.name}`, updatedBy, isDeleted: false },
      create: { settingKey, settingValue: JSON.stringify(scenario), description: `Custom Capacity Planning ${scenario.name}`, updatedBy },
      select: { updatedBy: true, updatedAt: true },
    });
    res.json({ scenario: { ...scenario, ...row }, message: `${scenario.name} tersimpan.` });
  } catch (error) {
    next(error);
  }
};

exports.getPresets = async (req, res, next) => {
  try {
    const month = String(req.query.month || "").trim();
    const [storedPresets, currentPresetId] = await Promise.all([loadPresetStore(prisma), activePresetId(prisma)]);
    const presets = storedPresets
      .filter((preset) => !month || preset.month === month)
      .map((preset) => ({ ...preset, isCurrentUse: preset.id === currentPresetId }))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    res.json({ presets, total: presets.length, currentPresetId });
  } catch (error) { next(error); }
};

exports.createPreset = async (req, res, next) => {
  try {
    const actor = req.user?.username || req.user?.email || "system";
    const presets = await loadPresetStore(prisma);
    const preset = normalizePreset(req.body, null, actor);
    assertPastPresetDaysUnchanged(null, preset);
    if (presets.some((item) => item.month === preset.month && item.name.toLowerCase() === preset.name.toLowerCase())) {
      return res.status(409).json({ message: `Preset ${preset.name} sudah ada pada ${preset.month}. Gunakan nama lain atau update preset tersebut.` });
    }
    presets.push(preset); await savePresetStore(prisma, presets, actor);
    res.status(201).json({ preset, message: `${preset.name} tersimpan untuk ${preset.month}.` });
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.updatePreset = async (req, res, next) => {
  try {
    const actor = req.user?.username || req.user?.email || "system";
    const presets = await loadPresetStore(prisma); const index = presets.findIndex((item) => item.id === req.params.presetId);
    if (index < 0) return res.status(404).json({ message: "Preset simulasi tidak ditemukan." });
    const preset = normalizePreset(req.body, presets[index], actor);
    assertPastPresetDaysUnchanged(presets[index], preset);
    if (presets.some((item, itemIndex) => itemIndex !== index && item.month === preset.month && item.name.toLowerCase() === preset.name.toLowerCase())) {
      return res.status(409).json({ message: `Nama preset ${preset.name} sudah dipakai pada ${preset.month}.` });
    }
    presets[index] = preset; await savePresetStore(prisma, presets, actor);
    const isCurrentUse = (await activePresetId(prisma)) === preset.id;
    if (isCurrentUse) {
      const periodStart = new Date(`${preset.month}-01T00:00:00.000Z`);
      const periodEnd = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1));
      await prisma.monthlyProductionPlan.updateMany({
        where: { isDeleted: false, status: { in: ["Draft", "Confirmed", "Released", "In Progress"] }, periodStart: { lt: periodEnd }, periodEnd: { gte: periodStart } },
        data: { replanRequired: true, replanReason: `Current Use Capacity ${preset.name} berubah; jalankan ulang auto recommendation sebelum sinkronisasi DPP.` },
      });
    }
    res.json({ preset: { ...preset, isCurrentUse }, message: isCurrentUse ? `${preset.name} diperbarui sebagai Current Use. MPP bulan terkait ditandai untuk auto recommendation ulang.` : `${preset.name} diperbarui.` });
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};
