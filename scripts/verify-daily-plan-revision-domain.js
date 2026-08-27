const assert = require("assert");
const {
  toMinute,
  validateScheduleItems,
  summarizeRevision,
  buildExecutionExceptions,
} = require("../src/prisma/services/planning/dailyPlanRevisionDomain");

assert.strictEqual(toMinute("07:30"), 450, "07:30 must be represented as minute 450");
assert.strictEqual(toMinute("24:00"), 1440, "24:00 is a valid shift boundary");
assert.strictEqual(toMinute("7.30"), null, "malformed time must not be guessed");

const base = {
  id: "a",
  scheduleNumber: "DPS-1",
  machineId: "machine-1",
  woId: "wo-1",
  plannedStartTime: "07:00",
  plannedEndTime: "09:00",
  plannedQty: 40,
};

assert.deepStrictEqual(validateScheduleItems([base]), { blockers: [], warnings: [] });
const materialWarningValidation = validateScheduleItems([{
  ...base,
  materialReadinessStatus: "WARNING_MATERIAL_SHORTAGE",
}]);
assert.strictEqual(materialWarningValidation.blockers.length, 0,
  "material shortage tidak boleh menjadi blocker Daily Plan release");
assert.strictEqual(materialWarningValidation.warnings.length, 1,
  "Daily Plan harus membawa tepat satu material warning");
assert.strictEqual(materialWarningValidation.warnings[0].code, "MATERIAL_SHORTAGE_WARNING",
  "Daily Plan harus mempertahankan material warning sampai release");

const overlap = validateScheduleItems([
  base,
  { ...base, id: "b", scheduleNumber: "DPS-2", plannedStartTime: "08:30", plannedEndTime: "10:00" },
]);
assert.strictEqual(overlap.blockers[0].code, "MACHINE_TIME_OVERLAP");

assert.strictEqual(validateScheduleItems([{ ...base, machineId: null }]).blockers[0].code, "MACHINE_REQUIRED");
assert.strictEqual(validateScheduleItems([{ ...base, plannedQty: 0 }]).blockers[0].code, "PLANNED_QTY_REQUIRED");
assert.strictEqual(validateScheduleItems([{ ...base, plannedStartTime: "10:00", plannedEndTime: "09:00" }]).blockers[0].code, "TIME_RANGE_INVALID");

assert.deepStrictEqual(
  summarizeRevision({ status: "Released", version: 3, schedules: [{ ...base, status: "Released" }] }),
  { status: "Released", version: 3, itemCount: 1, totalQty: 40, editable: false, releasedCount: 1 },
);

const executionExceptions = buildExecutionExceptions([{
  id: "schedule-a",
  scheduleNumber: "DPS-1",
  scheduleDate: new Date("2026-08-24"),
  status: "Completed",
  machineId: "machine-1",
  partCode: "PART-A",
  processCode: "WELD",
  plannedQty: 100,
  uomCode: "PCS",
  productionLogs: [{ id: "log-a", qtyGood: 80, qtyReject: 5, qtyRework: 5, downtime: 20 }],
}]);
assert.deepStrictEqual(executionExceptions.map((row) => row.exceptionType), ["PRODUCTION_SHORTFALL", "NG_PENDING_REVIEW", "MACHINE_DOWNTIME"]);
assert.strictEqual(executionExceptions[0].qty, 20);
assert.strictEqual(executionExceptions[1].qty, 10);

console.log("Daily plan revision domain contracts passed.");
