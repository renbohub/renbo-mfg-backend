"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  scheduleDailyReleaseAllocations,
} = require("../src/prisma/services/planning/dailyReleaseSchedulingService");

const common = {
  scheduleDate: "2026-09-07",
  workCenterId: "WC-WELD",
  eligibleMachineIds: ["M-050", "M-051"],
  plannedStartTime: "07:00",
  plannedEndTime: "09:00",
  plannedQty: 100,
  uomCode: "PCS",
};

const independent = scheduleDailyReleaseAllocations([
  { ...common, id: "A", partCode: "PART-A", machineId: "M-050", predecessorAllocationIds: [] },
  { ...common, id: "B", partCode: "PART-B", machineId: "M-050", predecessorAllocationIds: [] },
]);
assert.strictEqual(independent.items.length, 2, "satu allocation harus tetap menjadi satu item Daily Release");
assert.deepStrictEqual(independent.items.map((item) => item.plannedQty), [100, 100],
  "quantity tidak boleh dibagi antar mesin atau shift");
assert.deepStrictEqual(independent.items.map((item) => item.machineId), ["M-050", "M-051"],
  "part berbeda pada Work Center dan hari yang sama memakai mesin berbeda bila tersedia");
assert.deepStrictEqual(independent.items.map((item) => [item.plannedStartTime, item.plannedEndTime]), [
  ["07:00", "09:00"],
  ["07:00", "09:00"],
], "part independen boleh berjalan paralel");

const dependency = scheduleDailyReleaseAllocations([
  { ...common, id: "PRE", partCode: "PART-A", machineId: "M-050", plannedStartTime: "07:00", plannedEndTime: "09:00", predecessorAllocationIds: [] },
  { ...common, id: "NEXT", partCode: "PART-B", machineId: "M-051", plannedStartTime: "07:00", plannedEndTime: "08:00", predecessorAllocationIds: ["PRE"] },
]);
const successor = dependency.items.find((item) => item.id === "NEXT");
assert.strictEqual(successor.machineId, "M-051", "dependency tidak memaksa dua part ke mesin yang sama");
assert.strictEqual(successor.plannedStartTime, "10:00", "successor wajib mulai satu jam setelah predecessor selesai");
assert.strictEqual(successor.plannedEndTime, "11:00", "durasi successor tetap dipertahankan setelah digeser");

const samePart = scheduleDailyReleaseAllocations([
  { ...common, id: "A-1", partCode: "PART-A", machineId: "M-050", plannedStartTime: "07:00", plannedEndTime: "08:00", predecessorAllocationIds: [] },
  { ...common, id: "A-2", partCode: "PART-A", machineId: "M-051", plannedStartTime: "07:00", plannedEndTime: "08:00", predecessorAllocationIds: [] },
]);
assert.deepStrictEqual(samePart.items.map((item) => item.machineId), ["M-050", "M-050"],
  "part yang sama tidak boleh di-split ke mesin berbeda oleh Daily Release");
assert.strictEqual(samePart.items[1].plannedStartTime, "08:00", "batch part yang sama diantrikan pada mesin yang sama");

const limited = scheduleDailyReleaseAllocations([
  { ...common, eligibleMachineIds: ["M-050"], id: "L-1", partCode: "PART-A", machineId: "M-050", plannedStartTime: "07:00", plannedEndTime: "09:00", predecessorAllocationIds: [] },
  { ...common, eligibleMachineIds: ["M-050"], id: "L-2", partCode: "PART-B", machineId: "M-050", plannedStartTime: "07:00", plannedEndTime: "09:00", predecessorAllocationIds: [] },
]);
assert.strictEqual(limited.items[1].plannedStartTime, "09:00", "jika hanya satu mesin tersedia, allocation utuh diantrikan tanpa split");
assert.strictEqual(limited.warnings[0].code, "DAILY_RELEASE_SINGLE_MACHINE_QUEUE");

const planSpecificMachine = scheduleDailyReleaseAllocations([
  { ...common, id: "ACTIVE-ONLY", partCode: "PART-C", machineId: "M-050", eligibleMachineIds: ["M-051"], predecessorAllocationIds: [] },
]);
assert.strictEqual(planSpecificMachine.items[0].machineId, "M-051",
  "daftar mesin eligible plan-specific harus mengalahkan mesin awal yang tidak aktif");

const unavailable = scheduleDailyReleaseAllocations([
  { ...common, id: "NO-MACHINE", partCode: "PART-D", machineId: "M-050", eligibleMachineIds: [], predecessorAllocationIds: [] },
]);
assert.strictEqual(unavailable.items[0].machineId, null, "allocation tidak boleh dipasang pada mesin yang ditutup");
assert.strictEqual(unavailable.warnings[0].code, "DAILY_RELEASE_MACHINE_UNAVAILABLE");

const controller = fs.readFileSync(path.join(__dirname, "../src/prisma/controllers/planning/MonthlyProductionPlanController.js"), "utf8");
assert(controller.includes("scheduleDailyReleaseAllocations(desired.map"),
  "konversi Monthly Plan harus menjalankan scheduler Daily Release");
assert(controller.includes("machineId: item.allocation.routingMode === \"INHOUSE\" ? item.machineId : null"),
  "Daily Plan harus menyimpan mesin hasil penjadwalan, bukan selalu mesin allocation awal");
assert(!controller.includes("const shiftQuantities = splitQuantity(item.qty"),
  "fallback Daily Release tidak boleh membelah quantity berdasarkan shift");

console.log("Daily release machine scheduling contracts passed.");
