"use strict";
const assert = require("node:assert/strict");
const { resolvePool, poolCapacityHours, poolSignature } = require("../src/prisma/services/planning/rccpWorkCenterService");
const { availableCapacityHoursForPeriod, capacityForProfilesAcrossBuckets, calculateRccpLoad } = require("../src/prisma/services/planning/rccpService");
const machines = [1,2,3,4].map(i => ({ id: `M${i}`, machineCode: `M-00${i}`, machineSpecificationCode: "110T", status: "Active" }));
const wc = { id: "WC1", workCenterCode: "PRESS 110T", isActive: true, machines: [...machines.map(m => ({ machineId: m.id })), { machineId: "M5" }] };
const process = { machineId: "M4", machineSpecificationCode: "110T", process: { processCode: "PRG" } };
const pool = resolvePool(process, [wc], [...machines, { id: "M5", machineCode: "M5", machineSpecificationCode: "150T", status: "Active" }]);
assert.equal(pool.machines.length, 4, "all compatible members, not only the selected or primary machine");
assert.equal(poolSignature({ workCenterId: "WC1", specification: "110T", machines: [{ id: "M1" }, { id: "M2" }] }),
  poolSignature({ machines: [{ id: "M2" }, { id: "M1" }], specification: "110T", workCenterId: "WC1" }), "JSONB key order does not invalidate a fresh run");
assert.equal(resolvePool(process, [wc], machines.map(m => m.id === "M2" ? { ...m, status: "Maintenance" } : m)).machines.length, 3);
assert.throws(() => resolvePool(process, [{ ...wc, isActive: false }], machines), { code: "RCCP_WORK_CENTER_INVALID" });
assert.throws(() => resolvePool(process, [wc, { ...wc, id: "WC2" }], machines), { code: "RCCP_WORK_CENTER_INVALID" });
const profile = { id: "P1", partId: "FG", resourceCode: pool.code, isCapacityConstrained: true, resourceCount: 4, poolMachines: pool.machines,
  poolWorkCenter: wc, shiftsPerDay: 2, effectiveHoursPerShift: 7, efficiencyPercent: 85, plannedDowntimeHours: 0, calendarMode: "WEEKDAY" };
const start = new Date("2026-09-07"), end = new Date("2026-09-13");
assert.ok(Math.abs(poolCapacityHours(profile, start, end) - 238) < 0.000001);
const holiday = [{ machineId: "M2", scheduleDate: "2026-09-07", dayStatus: "HOLIDAY" }];
assert.equal(availableCapacityHoursForPeriod(profile, start, end, holiday), 226.1, "one machine holiday must not close the whole work center");
assert.equal(capacityForProfilesAcrossBuckets([profile, { ...profile, id: "P2", partId: "OTHER" }], start, end), 238, "two parts sharing a work center do not duplicate capacity");
const shiftProfile = { isActive: true, rules: [{ dayOfWeek: 1, startTime: "08:00", endTime: "16:00", breakMinutes: 60 }] };
assert.equal(availableCapacityHoursForPeriod({ ...profile, poolMachines: [{ ...machines[0], workingHourProfile: shiftProfile }] }, start, start), 5.95);
assert.equal(availableCapacityHoursForPeriod({ ...profile, poolMachines: [{ ...machines[0], workingHourProfile: shiftProfile }] }, start, start,
  [{ machineId: "M1", scheduleDate: "2026-09-07", shiftsPerDay: 0 }]), 0);
assert.equal(calculateRccpLoad({ mpsQty: 10, standardTimeHours: 1, availableCapacity: 0 }).status, "OVERLOAD");
console.log("RCCP work center: compatible/active members, ambiguity guards, per-machine calendars, shared capacity and zero-capacity blocking PASS");
