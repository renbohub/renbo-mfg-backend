const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  buildRevisionNumber,
  copyScheduleData,
  productionHandoffView,
  placementWindowsForMachine,
  validationForSchedule,
} = require("../src/prisma/services/planning/dailyPlanRevisionService");

assert.strictEqual(buildRevisionNumber("2026-08-24", 1), "DPR-20260824-R001");
assert.strictEqual(buildRevisionNumber(new Date("2026-08-24T00:00:00Z"), 12), "DPR-20260824-R012");

const copied = copyScheduleData({
  id: "old-id",
  scheduleNumber: "DPS-20260824-001",
  scheduleDate: new Date("2026-08-24"),
  shift: "1",
  plannedStartTime: "07:00",
  plannedEndTime: "08:00",
  plannedQty: 20,
  actualQty: 18,
  status: "Completed",
  productionLogs: [{ id: "log" }],
  createdAt: new Date(),
  updatedAt: new Date(),
}, { revisionId: "revision-new", revisionSequence: 2 });

assert.strictEqual(copied.scheduleNumber, "DPS-20260824-001-R002");
assert.strictEqual(copied.dailyPlanRevisionId, "revision-new");
assert.strictEqual(copied.status, "Draft");
assert.strictEqual(copied.actualQty, 0);
assert.strictEqual(copied.productionLogs, undefined);
assert.strictEqual(copied.id, undefined);

const confirmedHandoff = productionHandoffView({
  plan: {
    planNumber: "PP-2026-0001",
    status: "Confirmed",
    periodStart: new Date("2026-09-01T00:00:00Z"),
    _count: { manualAllocations: 97, dailyProductionSchedules: 0 },
  },
});
assert.strictEqual(confirmedHandoff.code, "RELEASE_MONTHLY_PLAN");
assert.strictEqual(confirmedHandoff.actionLabel, "Release Monthly Plan");
assert.match(confirmedHandoff.actionUrl, /month=2026-09/);
assert.strictEqual(confirmedHandoff.allocationCount, 97);

const releasedDateHandoff = productionHandoffView({
  upcomingRevision: {
    revisionNumber: "DPR-20260901-R001",
    planDate: new Date("2026-09-01T00:00:00Z"),
    status: "Released",
    sourcePlanNumber: "PP-2026-0001",
  },
});
assert.strictEqual(releasedDateHandoff.code, "RELEASED_ON_OTHER_DATE");
assert.match(releasedDateHandoff.actionUrl, /date=2026-09-01/);

const existingScheduleHandoff = productionHandoffView({
  upcomingSchedule: {
    scheduleNumber: "DPS-20260915-001",
    scheduleDate: new Date("2026-09-15T00:00:00Z"),
    status: "Draft",
    mppNumber: "PP-2026-0001",
  },
});
assert.strictEqual(existingScheduleHandoff.code, "DAILY_SCHEDULE_AVAILABLE");
assert.strictEqual(existingScheduleHandoff.actionUrl, "/modules/production/daily-production-schedules/DPS-20260915-001");
assert.strictEqual(existingScheduleHandoff.planNumber, "PP-2026-0001");

const releaseCandidate = {
  id: "candidate",
  scheduleNumber: "DPS-CANDIDATE",
  machineId: "machine-1",
  woId: "wo-1",
  plannedStartTime: "08:00",
  plannedEndTime: "09:00",
  plannedQty: 10,
};
const selectedOverlap = validationForSchedule(releaseCandidate, [
  releaseCandidate,
  { ...releaseCandidate, id: "conflict", scheduleNumber: "DPS-CONFLICT", plannedStartTime: "08:30", plannedEndTime: "09:30" },
]);
assert.strictEqual(selectedOverlap.blockers[0].code, "MACHINE_TIME_OVERLAP", "selected operation must be blocked even when it is referenced as the conflict");
const unrelatedInvalid = validationForSchedule(releaseCandidate, [
  releaseCandidate,
  { ...releaseCandidate, id: "other", scheduleNumber: "DPS-OTHER", machineId: null },
]);
assert.strictEqual(unrelatedInvalid.blockers.length, 0, "invalid operation lain tidak boleh menahan release operation yang dipilih");

assert.deepStrictEqual(placementWindowsForMachine({}, null, new Date("2026-09-01T00:00:00Z")), [
  { shift: "1", startTime: "08:00", endTime: "16:00" },
  { shift: "2", startTime: "16:00", endTime: "00:00" },
], "Auto Correct harus memakai dua shift fallback saat mesin belum mempunyai calendar");
assert.deepStrictEqual(placementWindowsForMachine({}, null, new Date("2026-09-06T00:00:00Z")), [],
  "fallback Auto Correct tidak boleh menempatkan produksi pada hari Minggu");
assert.deepStrictEqual(placementWindowsForMachine({}, {
  shiftsPerDay: 1,
  shiftOverrides: [{ startTime: "08:00", endTime: "16:00", overtimeBeforeStart: "07:00", overtimeBeforeEnd: "08:00", overtimeAfterStart: "16:00", overtimeAfterEnd: "18:00" }],
}, new Date("2026-09-01T00:00:00Z")), [
  { shift: "1", startTime: "07:00", endTime: "08:00" },
  { shift: "1", startTime: "08:00", endTime: "16:00" },
  { shift: "1", startTime: "16:00", endTime: "18:00" },
], "Auto Correct harus menghormati lembur awal dan akhir per shift");

const serviceSource = fs.readFileSync(path.join(__dirname, "../src/prisma/services/planning/dailyPlanRevisionService.js"), "utf8");
assert(!serviceSource.includes("DAILY_PLAN_INDIVIDUAL_RELEASE_REQUIRED"), "Release revision tidak boleh dipaksa satu operation per request");
assert(serviceSource.includes("releasedCount: draftSchedules.length"), "Release revision harus mengembalikan jumlah operation yang direlease sekaligus");
assert(serviceSource.includes("dailyProductionSchedule.updateMany"), "Release revision harus mengubah seluruh operation Draft secara atomic");

console.log("Daily plan revision service contracts passed.");
