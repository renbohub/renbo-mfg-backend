"use strict";

const { solveFiniteSchedule } = require("../planning/solver/planningSolverService");
const DAY_MS = 86400000;
const TASK_ID = "ETA_VENDOR_RETURN";

function date(value) {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  // JS normalizes dates such as February 30; these are not source dates.
  if (typeof value === "string" && value.length === 10 && parsed.toISOString().slice(0, 10) !== value) return null;
  return parsed;
}

function leadTime(value) {
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 3650 ? parsed : null;
}

/**
 * Read-only vendor turnaround check, independent of entered ETA/qty and stock.
 * Defaults match MPS_PRODUCTION: one 8h shift, weekdays, UTC planning axis.
 * A date-only needDate allows that entire day; timestamps retain their cutoff.
 * Null leadTimeFits means unevaluated, never permission to pass a vendor gate.
 * The optional solver dependency permits failure tests without a DB or runtime.
 */
async function evaluateLeadTimeWindow(row = {}, options = {}) {
  const applicable = row.checkpoint === "MPS_VENDOR" && row.category !== "CUSTOMER";
  const result = { applicable, earliestReturnDate: null, leadTimeFits: null, diagnostics: { code: "NOT_APPLICABLE" } };
  if (!applicable) return result;

  const send = date(row.sendDate), need = date(row.needDate);
  const days = leadTime(row.confirmedLeadTimeDays);
  const hoursPerDay = options.hoursPerDay ?? 8;
  const missingFields = [!send && "sendDate", !need && "needDate", days == null && "confirmedLeadTimeDays"].filter(Boolean);
  result.diagnostics = { code: "INPUT_INCOMPLETE", missingFields, confirmedLeadTimeDays: days, hoursPerDay };
  if (missingFields.length) return result;
  if (typeof hoursPerDay !== "number" || !Number.isFinite(hoursPerDay) || hoursPerDay < 1 || hoursPerDay > 24) {
    result.diagnostics.code = "INVALID_WORKING_HOURS";
    return result;
  }
  const deadline = new Date(need);
  if (typeof row.needDate === "string" && row.needDate.length === 10) deadline.setUTCHours(23, 59, 59, 999);
  Object.assign(result.diagnostics, { sendAt: send.toISOString(), requiredReturnAt: deadline.toISOString(), calendarBasis: "WORKING_MINUTE_AXIS" });

  let earliest = send;
  if (days > 0) {
    // Same forward horizon rule as demand feasibility. Do not constrain the
    // task to the deadline: a late optimum must remain visible as a diagnostic.
    const horizonDays = Math.max(Math.ceil(days) * 3 + 30, 180);
    try {
      const solved = await (options.solveFiniteSchedule || solveFiniteSchedule)({
        horizonStart: send,
        horizonEnd: new Date(send.getTime() + horizonDays * DAY_MS),
        calendar: options.calendar ?? {},
        hoursPerDay,
        dailyWindows: [{ startMinute: 0, endMinute: hoursPerDay * 60 }],
        tasks: [{ id: TASK_ID, duration: days, durationUnit: "DAY", releaseDate: send,
          eligibleResourceIds: ["PLANNING_TIMELINE"], required: true, minimizeCompletion: true, completionWeight: 1 }],
      });
      Object.assign(result.diagnostics, { solverStatus: solved.status, engine: solved.engine || "OR_TOOLS_WASM_CP_SAT" });
      // FEASIBLE alone does not establish an earliest return / impossible window.
      if (!solved.feasible || solved.status !== "OPTIMAL") {
        result.diagnostics.code = "SOLVER_NOT_OPTIMAL";
        return result;
      }
      earliest = date(solved.tasks?.find((task) => task.id === TASK_ID)?.endDate);
      if (!earliest || earliest < send) {
        result.diagnostics.code = "SOLVER_RESULT_INVALID";
        return result;
      }
    } catch (error) {
      result.diagnostics.code = "SOLVER_UNAVAILABLE";
      result.diagnostics.message = error.message || "Forward schedule unavailable.";
      return result;
    }
  }
  // A confirmed zero turnaround is an explicit no-wait milestone. The finite
  // scheduler clamps tasks to one minute, so do not invent work for this case.
  result.earliestReturnDate = earliest.toISOString().slice(0, 10);
  result.leadTimeFits = earliest <= deadline;
  Object.assign(result.diagnostics, { code: result.leadTimeFits ? "LEAD_TIME_FITS" : "LEAD_TIME_EXCEEDS_WINDOW",
    earliestReturnAt: earliest.toISOString(), zeroLeadTime: days === 0 });
  return result;
}

module.exports = { evaluateLeadTimeWindow };
