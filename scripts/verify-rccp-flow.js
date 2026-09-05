"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  capacityStatusForLoad,
  worstCapacityStatus,
  workingDaysInPeriod,
  availableCapacityHours,
  capacityForProfilesAcrossBuckets,
  calculateRccpLoad,
} = require("../src/prisma/services/planning/rccpService");
const { resolvedCalendarId } = require("../src/prisma/services/planning/rccpOffsetService");

const septemberWorkingDays = workingDaysInPeriod(
  new Date("2026-09-01T00:00:00.000Z"),
  new Date("2026-09-30T00:00:00.000Z"),
);
assert.strictEqual(septemberWorkingDays, 22, "September 2026 harus memiliki 22 weekday");

const available = availableCapacityHours({
  shiftsPerDay: 2,
  effectiveHoursPerShift: 7,
  resourceCount: 1,
  efficiencyPercent: 85,
  plannedDowntimeHours: 8,
}, septemberWorkingDays);
assert.strictEqual(available, 253.8, "Available capacity harus mengikuti shift, efficiency, dan downtime");

const load = calculateRccpLoad({
  mpsQty: 443,
  standardTimeHours: 0.02,
  setupTimeHours: 0.5,
  existingLoad: 240,
  availableCapacity: available,
  warningThreshold: 90,
  overloadThreshold: 100,
});
assert.strictEqual(load.currentMpsLoad, 9.36, "Required hours = MPS Qty × standard time + setup");
assert.strictEqual(load.totalLoad, 249.36, "Total load harus menjumlahkan current MPS dan existing load");
assert.strictEqual(load.status, "WARNING", "Load di atas 90% dan tidak melebihi 100% harus WARNING");
assert.strictEqual(capacityStatusForLoad(90), "FEASIBLE", "Threshold warning bersifat lebih besar dari 90%");
assert.strictEqual(capacityStatusForLoad(90.01), "WARNING");
assert.strictEqual(capacityStatusForLoad(100.01), "OVERLOAD");
assert.strictEqual(worstCapacityStatus(["FEASIBLE", "OVERLOAD", "WARNING"]), "OVERLOAD");
assert.strictEqual(resolvedCalendarId({ resourceType: "INTERNAL", calendarId: null }), "FACTORY", "Calendar internal kosong harus memakai fallback FACTORY yang stabil");
assert.strictEqual(resolvedCalendarId({ resourceType: "OUTSOURCE", calendarId: null }), "VENDOR", "Calendar outsource kosong harus memakai fallback VENDOR yang stabil");

const bucketCapacity = capacityForProfilesAcrossBuckets([
  {
    id: "PROFILE-A", partId: "PART-A", resourceCode: "PRESS", machineId: "MACHINE-A",
    isCapacityConstrained: true, calendarMode: "WEEKDAY", shiftsPerDay: 1,
    effectiveHoursPerShift: 8, resourceCount: 1, efficiencyPercent: 100, plannedDowntimeHours: 0,
  },
], new Date("2026-09-01T00:00:00.000Z"), new Date("2026-09-14T00:00:00.000Z"));
assert.strictEqual(bucketCapacity, 120, "Freshness approval harus menjumlahkan kapasitas per weekly bucket dengan rumus RCCP yang sama");

const controller = fs.readFileSync(path.resolve(__dirname, "../src/prisma/controllers/planning/MPSController.js"), "utf8");
const routes = fs.readFileSync(path.resolve(__dirname, "../src/prisma/routes/planning/mps.js"), "utf8");
const monthly = fs.readFileSync(path.resolve(__dirname, "../src/prisma/services/planning/monthlyPlanningService.js"), "utf8");
const rccp = fs.readFileSync(path.resolve(__dirname, "../src/prisma/services/planning/rccpService.js"), "utf8");
const automatic = fs.readFileSync(path.resolve(__dirname, "../src/prisma/services/planning/mpsAutomaticEvaluationService.js"), "utf8");
assert(!routes.includes('/:mpsNumber/rccp/run'), "RCCP tidak boleh memiliki route run manual");
assert(routes.includes('/:mpsNumber/approve'), "Route approval MPS harus tersedia");
assert(controller.includes("runAutomaticMpsEvaluation(prisma, result.docs"), "Create dan recalculate MPS wajib menjalankan evaluasi otomatis");
assert(automatic.includes("await executeRccp"), "Pipeline otomatis wajib menjalankan RCCP");
assert(automatic.includes("refreshDelivery"), "Pipeline otomatis wajib merefresh delivery gate");
assert(automatic.includes("readWorkbench"), "Pipeline otomatis wajib menghitung checklist workbench");
assert(controller.includes("assertMpsApprovalAllowed"), "Approval MPS wajib melewati RCCP gate");
assert(controller.includes("invalidateRccp"), "Perubahan adjustment MPS wajib meng-invalidasi RCCP");
assert(monthly.includes("MPS Qty/periode berubah saat monthly sync"), "Perubahan demand sumber wajib meng-invalidasi RCCP");
assert(rccp.includes('lifecycleStatus: "CAPACITY_CHECKED"'), "RCCP yang diterima harus membuka lifecycle CAPACITY_CHECKED");
assert(rccp.includes('code: "CAPACITY_CHANGED_AFTER_RCCP"'), "Perubahan master capacity setelah snapshot wajib memblokir approval");
assert(!rccp.includes("productionOrder.create"), "RCCP tidak boleh membuat Production Order");

console.log("RCCP MPS automatic capacity-gate contracts passed.");
