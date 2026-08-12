"use strict";

const { subtractWorkingDays } = require("./procurementSchedulingService");

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

function productionLeadTimeDays(metric = {}, queueBufferHours = 0) {
  const hoursPerDay = Math.max(number(metric.workingHoursPerDay), 8);
  return Math.max(number(metric.productionLeadTimeDays), 0)
    + Math.ceil(Math.max(number(queueBufferHours), 0) / hoursPerDay);
}

function resolveProductionRequirementDates({
  fgRequiredDate,
  customerTargetDate,
  routingMetric,
  queueBufferHours = 0,
  holidays = [],
}) {
  const fgDue = new Date(fgRequiredDate || customerTargetDate);
  if (Number.isNaN(fgDue.getTime())) throw new Error("FG Required Date wajib valid untuk backward MRP.");
  const scheduledProductionLeadTimeDays = productionLeadTimeDays(routingMetric, queueBufferHours);
  const productionLatestStartDate = subtractWorkingDays(fgDue, scheduledProductionLeadTimeDays, holidays);
  return {
    customerTargetDate: customerTargetDate ? new Date(customerTargetDate) : new Date(fgDue),
    fgRequiredDate: new Date(fgDue),
    productionLatestStartDate,
    materialRequiredDate: new Date(productionLatestStartDate),
    scheduledProductionLeadTimeDays,
  };
}

module.exports = { productionLeadTimeDays, resolveProductionRequirementDates };
