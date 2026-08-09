"use strict";

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const dateKey = (value) => new Date(value).toISOString().slice(0, 10);

function isWorkingDay(value, holidayKeys = new Set()) {
  const date = new Date(value);
  const day = date.getUTCDay();
  return day !== 0 && day !== 6 && !holidayKeys.has(dateKey(date));
}

function subtractWorkingDays(value, days, holidays = []) {
  const result = new Date(value);
  const holidayKeys = new Set(holidays.map(dateKey));
  let remaining = Math.max(Math.ceil(number(days)), 0);
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() - 1);
    if (isWorkingDay(result, holidayKeys)) remaining -= 1;
  }
  return result;
}

function monthOffset(from, to) {
  const left = new Date(from);
  const right = new Date(to);
  return (right.getUTCFullYear() - left.getUTCFullYear()) * 12 + right.getUTCMonth() - left.getUTCMonth();
}

function classifyProcurementWindow({ materialRequiredDate, latestPrDate, asOf = new Date() }) {
  const need = new Date(materialRequiredDate);
  const release = new Date(latestPrDate || materialRequiredDate);
  const today = new Date(asOf);
  if (release <= today) return "EXPEDITE";
  const offset = monthOffset(today, need);
  const day = need.getUTCDate();
  if (offset <= 0) return "CURRENT_MONTH";
  if (offset === 1) return day <= 15 ? "DELIVERY_1_15" : "DELIVERY_16_EOM";
  if (offset === 2 && day <= 15) return "EARLY_FOLLOWING_MONTH";
  return "FUTURE";
}

function procurementSchedule({
  materialRequiredDate,
  supplierLeadTimeDays = 0,
  prApprovalDays = 1,
  poProcessingDays = 1,
  transitDays = 0,
  receivingQcDays = 1,
  safetyLeadTimeDays = 1,
  holidays = [],
  asOf = new Date(),
}) {
  const totalLeadTimeDays = [supplierLeadTimeDays, prApprovalDays, poProcessingDays, transitDays, receivingQcDays, safetyLeadTimeDays]
    .reduce((sum, value) => sum + Math.max(number(value), 0), 0);
  const latestPrDate = subtractWorkingDays(materialRequiredDate, totalLeadTimeDays, holidays);
  return {
    latestPrDate,
    totalLeadTimeDays,
    procurementWindow: classifyProcurementWindow({ materialRequiredDate, latestPrDate, asOf }),
  };
}

module.exports = { isWorkingDay, subtractWorkingDays, classifyProcurementWindow, procurementSchedule };
