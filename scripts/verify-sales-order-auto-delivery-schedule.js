"use strict";

const assert = require("assert");

function loadSubject() {
  try {
    return require("../src/prisma/services/outgoing/automaticDeliveryScheduleService");
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND" && error.message.includes("automaticDeliveryScheduleService")) return {};
    throw error;
  }
}

async function main() {
  const { syncAutomaticDeliverySchedule } = loadSubject();
  assert.equal(typeof syncAutomaticDeliverySchedule, "function", "automatic delivery schedule sync must exist");

  const state = { schedule: null };
  const tx = {
    deliverySchedule: {
      findFirst: async ({ where }) => state.schedule?.soNumber === where.soNumber ? state.schedule : null,
      create: async ({ data }) => {
        state.schedule = { id: "schedule-1", ...data, details: data.details.create };
        return state.schedule;
      },
      update: async ({ data }) => {
        state.schedule = { ...state.schedule, ...data, details: data.details.create };
        return state.schedule;
      },
    },
  };
  const so = {
    soNumber: "SO-2026-001",
    soDate: new Date("2026-08-20T00:00:00.000Z"),
    deliveryDate: new Date("2026-09-02T00:00:00.000Z"),
    shippingAddress: "Bangkok Warehouse",
    details: [
      { id: "line-1", lineNumber: 1, qty: 12, notes: "Fragile" },
      { id: "line-2", lineNumber: 2, qty: 4, notes: null },
    ],
  };

  const created = await syncAutomaticDeliverySchedule(tx, so, { now: new Date("2026-08-28T10:00:00.000Z"), uuid: "abcdef12-3456" });
  assert.equal(created.scheduleNumber, "DS-20260828-ABCDEF12");
  assert.equal(created.plannedDate.toISOString(), "2026-09-02T00:00:00.000Z");
  assert.equal(created.deliveryAddress, "Bangkok Warehouse");
  assert.deepEqual(created.details, [
    { soDetailId: "line-1", lineNumber: 1, qty: 12, notes: "Fragile" },
    { soDetailId: "line-2", lineNumber: 2, qty: 4, notes: null },
  ]);

  so.deliveryDate = null;
  so.shippingAddress = "Updated Address";
  so.details = [{ id: "line-3", lineNumber: 1, qty: 7, notes: null }];
  const updated = await syncAutomaticDeliverySchedule(tx, so);
  assert.equal(updated.id, "schedule-1", "Draft SO edits must reuse its automatic schedule");
  assert.equal(updated.plannedDate.toISOString(), "2026-08-20T00:00:00.000Z", "SO date is the planned-date fallback");
  assert.equal(updated.deliveryAddress, "Updated Address");
  assert.deepEqual(updated.details, [{ soDetailId: "line-3", lineNumber: 1, qty: 7, notes: null }]);

  console.log("sales-order automatic delivery schedule: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
