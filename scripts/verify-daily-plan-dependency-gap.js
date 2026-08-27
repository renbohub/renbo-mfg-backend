"use strict";

const assert = require("assert");
const { validateScheduleItems } = require("../src/prisma/services/planning/dailyPlanRevisionDomain");

const base = {
  plannedQty: 40,
  woId: "WO-1",
  productionPlanAllocationId: "ALLOC-PRE",
};

const invalid = validateScheduleItems([
  { ...base, id: "pre", scheduleNumber: "DPS-1", machineId: "M-1", plannedStartTime: "07:00", plannedEndTime: "09:00" },
  { ...base, id: "next", scheduleNumber: "DPS-2", productionPlanAllocationId: "ALLOC-NEXT", predecessorAllocationIds: ["ALLOC-PRE"], machineId: "M-2", plannedStartTime: "09:30", plannedEndTime: "10:30" },
]);
assert.strictEqual(invalid.blockers.find((item) => item.code === "DIRECT_PREDECESSOR_GAP_SHORT")?.requiredStartTime, "10:00",
  "successor langsung harus memiliki jeda minimal satu jam setelah predecessor selesai");

const valid = validateScheduleItems([
  { ...base, id: "pre", scheduleNumber: "DPS-1", machineId: "M-1", plannedStartTime: "07:00", plannedEndTime: "09:00" },
  { ...base, id: "next", scheduleNumber: "DPS-2", productionPlanAllocationId: "ALLOC-NEXT", predecessorAllocationIds: ["ALLOC-PRE"], machineId: "M-2", plannedStartTime: "10:00", plannedEndTime: "11:00" },
]);
assert.strictEqual(valid.blockers.some((item) => item.code === "DIRECT_PREDECESSOR_GAP_SHORT"), false,
  "jeda tepat satu jam harus valid");

console.log("Daily plan direct dependency gap contracts passed.");
