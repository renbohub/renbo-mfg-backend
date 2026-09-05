"use strict";

const { solveBackwardMilestones } = require("./solver/planningSolverService");

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

function productionLeadTimeDays(metric = {}, queueBufferHours = 0) {
  const hoursPerDay = Math.max(number(metric.workingHoursPerDay), 8);
  return Math.max(number(metric.productionLeadTimeDays), 0)
    + Math.ceil(Math.max(number(queueBufferHours), 0) / hoursPerDay);
}

async function resolveProductionRequirementDates({
  fgRequiredDate,
  customerTargetDate,
  routingMetric,
  queueBufferHours = 0,
  holidays = [],
}) {
  const fgDue = new Date(fgRequiredDate || customerTargetDate);
  if (Number.isNaN(fgDue.getTime())) throw new Error("FG Required Date wajib valid untuk backward MRP.");
  const scheduledProductionLeadTimeDays = productionLeadTimeDays(routingMetric, queueBufferHours);
  const solver = await solveBackwardMilestones({
    targetDate: fgDue,
    holidays,
    tasks: [{ id: "PRODUCTION", duration: scheduledProductionLeadTimeDays, unit: "DAY" }],
  });
  const productionLatestStartDate = solver.tasks[0]?.startDate || new Date(fgDue);
  return {
    customerTargetDate: customerTargetDate ? new Date(customerTargetDate) : new Date(fgDue),
    fgRequiredDate: new Date(fgDue),
    productionLatestStartDate,
    materialRequiredDate: new Date(productionLatestStartDate),
    scheduledProductionLeadTimeDays,
    solver: { engine: solver.engine, engineVersion: solver.engineVersion, status: solver.status, milestones: solver.tasks },
  };
}

module.exports = { productionLeadTimeDays, resolveProductionRequirementDates };
