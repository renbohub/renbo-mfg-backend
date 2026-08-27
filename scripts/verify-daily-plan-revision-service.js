const assert = require("assert");
const {
  buildRevisionNumber,
  copyScheduleData,
  productionHandoffView,
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

console.log("Daily plan revision service contracts passed.");
