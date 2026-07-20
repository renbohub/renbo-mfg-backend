"use strict";

const DURATION_UNITS = new Set(["SECOND", "MINUTE", "HOUR", "DAY"]);

function normalizeDurationUnit(value, fallback = "HOUR") {
  const unit = String(value || fallback).trim().toUpperCase();
  return DURATION_UNITS.has(unit) ? unit : fallback;
}

function durationToHours(value, unit = "HOUR") {
  const amount = Math.max(Number(value || 0), 0);
  switch (normalizeDurationUnit(unit)) {
    case "SECOND": return amount / 3600;
    case "MINUTE": return amount / 60;
    case "DAY": return amount * 8;
    default: return amount;
  }
}

function durationToWorkingDays(value, unit = "HOUR") {
  const hours = durationToHours(value, unit);
  return hours > 0 ? Math.ceil(hours / 8) : 0;
}

module.exports = { DURATION_UNITS, normalizeDurationUnit, durationToHours, durationToWorkingDays };
