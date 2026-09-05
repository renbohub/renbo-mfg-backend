"use strict";

const { solveBackwardMilestones } = require("./solver/planningSolverService");

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

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

async function procurementSchedule({
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
  const leadTimeBreakdown = {
    prApprovalDays: Math.max(number(prApprovalDays), 0),
    poProcessingDays: Math.max(number(poProcessingDays), 0),
    supplierLeadTimeDays: Math.max(number(supplierLeadTimeDays), 0),
    transitDays: Math.max(number(transitDays), 0),
    receivingQcDays: Math.max(number(receivingQcDays), 0),
    safetyLeadTimeDays: Math.max(number(safetyLeadTimeDays), 0),
  };
  const totalLeadTimeDays = Object.values(leadTimeBreakdown).reduce((sum, value) => sum + value, 0);
  const solver = await solveBackwardMilestones({
    targetDate: materialRequiredDate,
    holidays,
    tasks: [
      { id: "PR_APPROVAL", duration: leadTimeBreakdown.prApprovalDays, unit: "DAY" },
      { id: "PO_PROCESSING", duration: leadTimeBreakdown.poProcessingDays, unit: "DAY" },
      { id: "SUPPLIER", duration: leadTimeBreakdown.supplierLeadTimeDays, unit: "DAY" },
      { id: "TRANSIT", duration: leadTimeBreakdown.transitDays, unit: "DAY" },
      { id: "RECEIVING_QC", duration: leadTimeBreakdown.receivingQcDays, unit: "DAY" },
      { id: "SAFETY", duration: leadTimeBreakdown.safetyLeadTimeDays, unit: "DAY" },
    ],
  });
  const milestone = Object.fromEntries(solver.tasks.map((task) => [task.id, task]));
  const latestPrDate = milestone.PR_APPROVAL?.startDate || new Date(materialRequiredDate);
  const latestPoDate = milestone.SUPPLIER?.startDate || milestone.PO_PROCESSING?.endDate || latestPrDate;
  const supplierRequiredArrivalDate = milestone.RECEIVING_QC?.startDate || milestone.TRANSIT?.endDate || latestPoDate;
  return {
    materialRequiredDate: new Date(materialRequiredDate),
    supplierRequiredArrivalDate,
    latestPoDate,
    latestPrDate,
    totalLeadTimeDays,
    leadTimeBreakdown,
    procurementWindow: classifyProcurementWindow({ materialRequiredDate: supplierRequiredArrivalDate, latestPrDate, asOf }),
    solver: {
      engine: solver.engine,
      engineVersion: solver.engineVersion,
      status: solver.status,
      objectiveValue: solver.objectiveValue,
      wallTimeSeconds: solver.wallTimeSeconds,
      milestones: solver.tasks,
    },
  };
}

module.exports = { classifyProcurementWindow, procurementSchedule };
