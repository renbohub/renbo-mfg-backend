const DEFAULT_PLANNING_TIME_ZONE = "Asia/Jakarta";

function planningTimeZone() {
  const candidate = String(
    process.env.PLANNING_TIME_ZONE ||
      process.env.BUSINESS_TIME_ZONE ||
      DEFAULT_PLANNING_TIME_ZONE,
  ).trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch (_error) {
    return DEFAULT_PLANNING_TIME_ZONE;
  }
}

function parseDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" && /^\d{4}-\d{2}$/.test(value.trim())) {
    const parsed = new Date(`${value.trim()}-01T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = value == null ? null : new Date(value);
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

function planningMonthKey(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}$/.test(value.trim())) {
    return value.trim();
  }
  const parsed = parseDate(value);
  if (!parsed) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: planningTimeZone(),
    year: "numeric",
    month: "2-digit",
  }).formatToParts(parsed);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : "";
}

function parseMonthKey(value) {
  const key = planningMonthKey(value);
  const match = key.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  return { key, year: Number(match[1]), monthIndex: Number(match[2]) - 1 };
}

function utcMonthStart(value) {
  const parsed = parseMonthKey(value);
  return parsed ? new Date(Date.UTC(parsed.year, parsed.monthIndex, 1)) : null;
}

function utcMonthEnd(value) {
  const parsed = parseMonthKey(value);
  return parsed ? new Date(Date.UTC(parsed.year, parsed.monthIndex + 1, 0)) : null;
}

function utcMonthEndInstant(value) {
  const parsed = parseMonthKey(value);
  return parsed
    ? new Date(Date.UTC(parsed.year, parsed.monthIndex + 1, 0, 23, 59, 59, 999))
    : null;
}

function nextPlanningMonthKey(value) {
  const parsed = parseMonthKey(value);
  if (!parsed) return "";
  const next = new Date(Date.UTC(parsed.year, parsed.monthIndex + 1, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
}

module.exports = {
  DEFAULT_PLANNING_TIME_ZONE,
  planningTimeZone,
  planningMonthKey,
  utcMonthStart,
  utcMonthEnd,
  utcMonthEndInstant,
  nextPlanningMonthKey,
};
