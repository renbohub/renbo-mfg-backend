"use strict";

const RULE_SETTING_KEY = "PPIC_DEMAND_EFD_RULE_V1";
const OVERRIDE_SETTING_KEY = "PPIC_DEMAND_EFD_OVERRIDES_V1";
const RULE_MODES = new Set(["PO_THEN_FORECAST", "MAX_FORECAST_PO", "FORECAST_ONLY"]);
const OVERRIDE_SOURCES = new Set(["PO", "FORECAST", "MANUAL"]);

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value) => Math.round((number(value) + Number.EPSILON) * 1000000) / 1000000;
const text = (value) => String(value ?? "").trim();
const overrideKey = (partCode, month) => `${text(month)}|${text(partCode).toUpperCase()}`;

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch (_error) { return fallback; }
}

function normalizeRule(input = {}) {
  const mode = RULE_MODES.has(text(input.mode).toUpperCase()) ? text(input.mode).toUpperCase() : "PO_THEN_FORECAST";
  return {
    mode,
    label: mode === "MAX_FORECAST_PO" ? "Nilai terbesar Forecast / PO" : mode === "FORECAST_ONLY" ? "Selalu Forecast" : "PO jika tersedia, jika kosong gunakan Forecast",
  };
}

function normalizeOverride(input = {}) {
  const partCode = text(input.partCode).toUpperCase();
  const month = text(input.month);
  const source = text(input.source).toUpperCase();
  if (!partCode) throw Object.assign(new Error("Part Number wajib diisi."), { status: 400 });
  if (!/^\d{4}-\d{2}$/.test(month)) throw Object.assign(new Error("Bulan EFD tidak valid."), { status: 400 });
  if (!OVERRIDE_SOURCES.has(source)) throw Object.assign(new Error("Sumber EFD harus PO, FORECAST, atau MANUAL."), { status: 400 });
  const manualQty = source === "MANUAL" ? number(input.manualQty) : null;
  if (source === "MANUAL" && manualQty < 0) throw Object.assign(new Error("Nilai EFD manual tidak boleh negatif."), { status: 400 });
  return { partCode, month, source, manualQty, reason: text(input.reason) || null };
}

async function loadEfdConfiguration(tx) {
  const rows = await tx.systemSetting.findMany({
    where: { settingKey: { in: [RULE_SETTING_KEY, OVERRIDE_SETTING_KEY] }, isDeleted: false },
    select: { settingKey: true, settingValue: true, updatedBy: true, updatedAt: true },
  });
  const byKey = new Map(rows.map((row) => [row.settingKey, row]));
  const ruleRow = byKey.get(RULE_SETTING_KEY);
  const overrideRow = byKey.get(OVERRIDE_SETTING_KEY);
  const rule = normalizeRule(parseJson(ruleRow?.settingValue, {}));
  const stored = parseJson(overrideRow?.settingValue, []);
  const entries = Array.isArray(stored) ? stored : [];
  return {
    rule: { ...rule, updatedBy: ruleRow?.updatedBy || null, updatedAt: ruleRow?.updatedAt || null },
    overrides: new Map(entries.filter((row) => row?.partCode && row?.month).map((row) => [overrideKey(row.partCode, row.month), row])),
  };
}

function resolveEfd({ forecastQty, poQty, calculatedQty, partCode, month }, configuration = {}) {
  const forecast = round(forecastQty);
  const po = round(poQty);
  const calculated = round(calculatedQty);
  const rule = normalizeRule(configuration.rule);
  const override = configuration.overrides?.get(overrideKey(partCode, month)) || null;
  let value;
  let source;
  if (override?.source === "MANUAL") {
    value = round(override.manualQty);
    source = "MANUAL";
  } else if (override?.source === "FORECAST") {
    value = forecast;
    source = "FORECAST";
  } else if (override?.source === "PO") {
    value = po > 0 ? po : forecast;
    source = po > 0 ? "PO" : "FORECAST_FALLBACK";
  } else if (rule.mode === "FORECAST_ONLY") {
    value = forecast;
    source = "FORECAST";
  } else if (rule.mode === "MAX_FORECAST_PO") {
    value = Math.max(forecast, po);
    source = po > forecast ? "PO" : "FORECAST";
  } else {
    value = po > 0 ? po : forecast;
    source = po > 0 ? "PO" : "FORECAST_FALLBACK";
  }
  return { value: round(value), source, override, calculated, ruleMode: rule.mode };
}

async function saveEfdRule(tx, input, actor) {
  const rule = normalizeRule(input);
  const row = await tx.systemSetting.upsert({
    where: { settingKey: RULE_SETTING_KEY },
    update: { settingValue: JSON.stringify(rule), description: "General rule Effective Demand (EFD) PPIC", updatedBy: actor, isDeleted: false },
    create: { settingKey: RULE_SETTING_KEY, settingValue: JSON.stringify(rule), description: "General rule Effective Demand (EFD) PPIC", updatedBy: actor },
    select: { updatedBy: true, updatedAt: true },
  });
  return { ...rule, ...row };
}

async function saveEfdOverride(tx, input, actor) {
  const next = normalizeOverride(input);
  const row = await tx.systemSetting.findUnique({ where: { settingKey: OVERRIDE_SETTING_KEY }, select: { settingValue: true } });
  const stored = parseJson(row?.settingValue, []);
  const entries = Array.isArray(stored) ? stored : [];
  const key = overrideKey(next.partCode, next.month);
  const updated = { ...next, updatedBy: actor, updatedAt: new Date().toISOString() };
  const output = [...entries.filter((entry) => overrideKey(entry.partCode, entry.month) !== key), updated]
    .sort((left, right) => overrideKey(left.partCode, left.month).localeCompare(overrideKey(right.partCode, right.month)));
  await tx.systemSetting.upsert({
    where: { settingKey: OVERRIDE_SETTING_KEY },
    update: { settingValue: JSON.stringify(output), description: "Per part-month Effective Demand (EFD) overrides", updatedBy: actor, isDeleted: false },
    create: { settingKey: OVERRIDE_SETTING_KEY, settingValue: JSON.stringify(output), description: "Per part-month Effective Demand (EFD) overrides", updatedBy: actor },
  });
  return updated;
}

async function removeEfdOverride(tx, input, actor) {
  const partCode = text(input.partCode).toUpperCase();
  const month = text(input.month);
  const row = await tx.systemSetting.findUnique({ where: { settingKey: OVERRIDE_SETTING_KEY }, select: { settingValue: true } });
  const stored = parseJson(row?.settingValue, []);
  const entries = Array.isArray(stored) ? stored : [];
  const key = overrideKey(partCode, month);
  const output = entries.filter((entry) => overrideKey(entry.partCode, entry.month) !== key);
  await tx.systemSetting.upsert({
    where: { settingKey: OVERRIDE_SETTING_KEY },
    update: { settingValue: JSON.stringify(output), updatedBy: actor, isDeleted: false },
    create: { settingKey: OVERRIDE_SETTING_KEY, settingValue: "[]", description: "Per part-month Effective Demand (EFD) overrides", updatedBy: actor },
  });
  return { removed: output.length !== entries.length, partCode, month };
}

module.exports = {
  RULE_SETTING_KEY, OVERRIDE_SETTING_KEY, loadEfdConfiguration, resolveEfd,
  saveEfdRule, saveEfdOverride, removeEfdOverride, normalizeRule,
};
