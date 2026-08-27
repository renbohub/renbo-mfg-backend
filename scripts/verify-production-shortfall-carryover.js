const assert = require("assert");
const { createProductionShortfallCarryover } = require("../src/prisma/services/planning/productionShortfallCarryoverService");

const targetDate = new Date("2026-08-08T00:00:00.000Z");
const sourceSchedule = {
  id: "DPS-SOURCE-ID", scheduleNumber: "DPS-20260807-001", scheduleDate: new Date("2026-08-07T00:00:00.000Z"),
  shift: "1", machineId: "MACHINE-1", moId: "MO-1", moNumber: "MO-001", woId: "WO-1", woNumber: "WO-001",
  partId: "PART-1", partCode: "PART-A", processId: "PROCESS-1", productionPlanId: "PLAN-1",
  productionPlanAllocationId: "ALLOCATION-1", mbomProcessId: "ROUTE-1", uomCode: "PCS", sequence: 10,
  deliveryPhaseId: "PHASE-1", deliveryPhaseNumber: 1, transferBatchNumber: 1, predecessorAllocationIds: [],
};
const log = { id: "LOG-ID", logNumber: "LOG-20260807-001", logDate: sourceSchedule.scheduleDate, qtyPlanned: 100, qtyGood: 80 };
const machine = {
  id: "MACHINE-1", machineCode: "MC-01", status: "Active", machineSpecificationCode: null,
  cycleTime: 60, defaultShiftHours: 8, shift1Start: "08:00", shift1End: "16:00",
};
const workOrder = { id: "WO-1", machineId: machine.id, cycleTime: 60 };

function fakeTransaction(plannedQty) {
  const state = { updates: [], creates: [], carryover: null, advisoryLockCount: 0 };
  const nextDayDpp = {
    ...sourceSchedule,
    id: "DPS-NEXT-ID",
    scheduleNumber: "DPS-20260808-001",
    scheduleDate: targetDate,
    plannedQty,
    actualQty: 0,
    schedulePriority: 100,
    status: "Draft",
    notes: null,
    createdAt: targetDate,
  };
  const tx = {
    $executeRaw: async () => { state.advisoryLockCount += 1; return 1; },
    productionLogCarryover: {
      findUnique: async () => null,
      create: async ({ data }) => { state.carryover = { id: "CARRY-1", ...data }; return state.carryover; },
    },
    workOrder: {
      findFirst: async () => workOrder,
      findMany: async () => [workOrder],
    },
    mBOMProcess: { findFirst: async () => ({ machineSpecificationCode: null }) },
    machine: {
      findMany: async () => [machine],
      findFirst: async () => machine,
    },
    dailyProductionSchedule: {
      findMany: async () => [nextDayDpp],
      findFirst: async (args) => args?.where?.scheduleNumber ? { scheduleNumber: "DPS-20260808-001" } : nextDayDpp,
      update: async ({ where, data }) => { state.updates.push({ where, data }); return { ...nextDayDpp, ...data }; },
      create: async ({ data }) => { const row = { id: `CREATED-${state.creates.length + 1}`, ...data }; state.creates.push(row); return row; },
    },
  };
  return { tx, state };
}

(async () => {
  const spare = fakeTransaction(50);
  const spareResult = await createProductionShortfallCarryover(spare.tx, { log, schedule: sourceSchedule, actor: "test" });
  assert.equal(spare.state.updates.length, 1, "next-day DPP should be increased when spare capacity exists");
  assert.equal(spare.state.updates[0].data.plannedQty.increment, 20);
  assert.equal(spare.state.creates.length, 0, "no extra DPP should be created while capacity is available");
  assert.equal(spareResult.status, "ALLOCATED");

  const full = fakeTransaction(408);
  const fullResult = await createProductionShortfallCarryover(full.tx, { log: { ...log, id: "LOG-FULL", logNumber: "LOG-20260807-002" }, schedule: sourceSchedule, actor: "test" });
  assert.equal(full.state.updates.length, 0, "full next-day DPP must not be inflated");
  assert.equal(full.state.creates.length, 1, "full capacity must create an additional DPP");
  assert.equal(full.state.creates[0].schedulePriority, 1);
  assert.match(full.state.creates[0].notes, /CAPACITY-OVERFLOW/);
  assert.equal(fullResult.status, "OVER_CAPACITY");
  assert.equal(full.state.advisoryLockCount, 1, "new DPS number must use an execute-only advisory lock");

  console.log("Production shortfall carry-over checks passed: spare-capacity increase and full-capacity extra DPP");
})().catch((error) => { console.error(error); process.exit(1); });
