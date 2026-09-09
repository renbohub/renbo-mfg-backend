"use strict";
const assert = require("node:assert/strict");
const { procurementSchedule } = require("../src/prisma/services/planning/procurementSchedulingService");
const day = (v) => new Date(v).toISOString().slice(0,10);
(async () => {
  const schedule = await procurementSchedule({materialRequiredDate:"2026-09-22",supplierLeadTimeDays:5,asOf:new Date("2026-08-20")});
  assert.equal(day(schedule.supplierRequiredArrivalDate),"2026-09-18");
  assert.equal(day(schedule.latestPoDate),"2026-09-11");
  assert.equal(day(schedule.latestPrDate),"2026-09-09");
  const shorter = await procurementSchedule({materialRequiredDate:"2026-09-22",supplierLeadTimeDays:2});
  assert.ok(new Date(shorter.latestPoDate) > new Date(schedule.latestPoDate));
  assert.equal(day(shorter.supplierRequiredArrivalDate),day(schedule.supplierRequiredArrivalDate));
  const waived = await procurementSchedule({materialRequiredDate:"2026-09-22",supplierLeadTimeDays:0,receivingQcDays:0,safetyLeadTimeDays:0,transitDays:0,prApprovalDays:0,poProcessingDays:0});
  assert.equal(day(waived.latestPoDate),"2026-09-22");
  assert.equal(day(waived.supplierRequiredArrivalDate),"2026-09-22");
  console.log("PASS purchasing date chain: QC/safety, weekends, supplier LT, separate PO/PR milestones, waived buffers.");
})().catch(e=>{console.error(e);process.exitCode=1;});
