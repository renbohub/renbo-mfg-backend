"use strict";
const { businessNow } = require("../../utils/businessClock");
const { solveFiniteSchedule } = require("../planning/solver/planningSolverService");
const { evaluateLeadTimeWindow } = require("./etaLeadTimeService");
const day = (v) => v && Number.isFinite(new Date(v).getTime()) ? new Date(v).toISOString().slice(0, 10) : null;
const number = (v) => v !== null && v !== undefined && v !== "" && typeof v !== "boolean" && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 3650 ? Number(v) : null;
const latest = (...values) => values.filter((v) => day(v)).map((v) => new Date(v)).sort((a, b) => b - a)[0];
async function calculate(row, options = {}) {
  const result = { available: false, eta: null, readyDate: null, leadTimeDays: number(row.leadTime), basis: "BOM_WORKING_CALENDAR", reason: null };
  if (!row.mpsNumber || !row.bomId || row.stale || row.checkOnly) return { ...result, reason: "Checksheet BOM terbaru belum tersedia." };
  if (!row.partnerCode || !row.uom || !(Number(row.requiredQty ?? row.qty) > 0) || !day(row.needDate) || result.leadTimeDays == null) return { ...result, reason: "Partner, qty, UOM, tanggal kebutuhan, atau lead time BOM belum lengkap." };
  const asOf = options.asOf || businessNow();
  if (row.checkpoint === "MPS_VENDOR") {
    if (!day(row.sendDate)) return { ...result, reason: "Tanggal mulai proses vendor belum tersedia." };
    const start = latest(asOf, row.sendDate, row.bomStartDate);
    const checked = await (options.evaluateLeadTimeWindow || evaluateLeadTimeWindow)({ ...row, sendDate: start.toISOString(), confirmedLeadTimeDays: result.leadTimeDays });
    if (checked.leadTimeFits == null) return { ...result, reason: "Jadwal vendor By BOM belum dapat dihitung." };
    return { ...result, available: true, startDate: day(start), eta: checked.earliestReturnDate, leadTimeFits: checked.leadTimeFits, diagnostics: checked.diagnostics };
  }
  if (row.checkpoint !== "MPS_MATERIAL") return { ...result, reason: "Sumber ini belum memiliki jadwal BOM." };
  const policy = row.procurementPolicy;
  const fields = row.category === "CUSTOMER" ? ["transitDays", "receivingQcDays", "safetyLeadTimeDays"] : ["prApprovalDays", "poProcessingDays", "transitDays", "receivingQcDays", "safetyLeadTimeDays"];
  if (!policy || fields.some((key) => number(policy[key]) == null)) return { ...result, reason: "Waktu transit / QC pada BOM belum lengkap. Lengkapi checksheet atau gunakan konfirmasi manual." };
  const steps = [
    ["ORDER", row.category === "CUSTOMER" ? 0 : number(policy.prApprovalDays) + number(policy.poProcessingDays)],
    ["ARRIVAL", result.leadTimeDays + number(policy.transitDays)],
    ["READY", number(policy.receivingQcDays) + number(policy.safetyLeadTimeDays)],
  ];
  const start = latest(asOf), duration = steps.reduce((sum, [, days]) => sum + days, 0);
  const tasks = []; let previous = null;
  for (const [id, days] of steps) if (days > 0) { tasks.push({ id, duration: days, durationUnit: "DAY", releaseDate: start, predecessorIds: previous ? [previous] : [], eligibleResourceIds: ["PLANNING_TIMELINE"], required: true, minimizeCompletion: true, completionWeight: 1 }); previous = id; }
  let solved = { feasible: true, status: "OPTIMAL", tasks: [] };
  if (tasks.length) {
    try {
      const calendar = Object.fromEntries((policy.holidays || []).map((value) => [day(value), "HOLIDAY"]));
      solved = await (options.solveFiniteSchedule || solveFiniteSchedule)({ horizonStart: start, horizonEnd: new Date(start.getTime() + Math.max(Math.ceil(duration) * 3 + 30, 180) * 86400000), calendar, hoursPerDay: 8, dailyWindows: [{ startMinute: 0, endMinute: 480 }], tasks });
    } catch { return { ...result, reason: "Perhitungan kalender BOM belum tersedia. Coba refresh atau gunakan konfirmasi manual." }; }
  }
  if (!solved.feasible || solved.status !== "OPTIMAL") return { ...result, reason: "Jadwal By BOM belum menghasilkan perhitungan yang lengkap." };
  let instant = start; const milestones = {};
  for (const [id, days] of steps) {
    if (days > 0) {
      const task = solved.tasks?.find((t) => t.id === id);
      if (!day(task?.endDate) || new Date(task.endDate) < instant) return { ...result, reason: "Hasil tanggal BOM tidak lengkap; periksa checksheet." };
      instant = new Date(task.endDate);
    }
    milestones[id] = day(instant);
  }
  return { ...result, available: true, startDate: day(start), qty: Number(row.requiredQty ?? row.qty), eta: milestones.ARRIVAL, readyDate: milestones.READY };
}
async function attach(row, options = {}) {
  if (row.etaMode !== "BOM") return { ...row, etaBasis: row.confirmed ? "MANUAL" : "PENDING" };
  const key = JSON.stringify([row.checkpoint, row.category, row.leadTime, row.needDate, row.sendDate, row.bomStartDate, row.procurementPolicy, row.bomId, row.stale, row.checkOnly, row.partnerCode, row.uom, row.requiredQty ?? row.qty]);
  const cache = options.cache;
  if (cache && !cache.has(key)) cache.set(key, calculate(row, options));
  const bom = await (cache ? cache.get(key) : calculate(row, options));
  return { ...row, etaBasis: "BOM", bomCalculation: bom, effectiveLeadTimeDays: row.leadTime,
    // Preserve the record for audit/switching back, but use the selected BOM
    // source for planning even when the estimate is unavailable.
    confirmed: false, confirmedQty: null, confirmedLeadTimeDays: null, eta: null, readyDate: null, leadTimeFits: null, earliestReturnDate: null,
    ...(bom.available ? { eta: bom.eta, readyDate: bom.readyDate, plannedQty: Number(row.requiredQty ?? row.qty), leadTimeFits: bom.leadTimeFits, earliestReturnDate: row.checkpoint === "MPS_VENDOR" ? bom.eta : null } : {}) };
}
module.exports = { calculate, attach };
