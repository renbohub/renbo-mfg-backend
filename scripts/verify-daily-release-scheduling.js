"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  autoCorrectWorkPlacements,
  scheduleDailyReleaseAllocations,
  toMinute,
} = require("../src/prisma/services/planning/dailyReleaseSchedulingService");

(async () => {

const common = {
  scheduleDate: "2026-09-07",
  workCenterId: "WC-WELD",
  eligibleMachineIds: ["M-050", "M-051"],
  plannedStartTime: "07:00",
  plannedEndTime: "09:00",
  plannedQty: 100,
  uomCode: "PCS",
};

assert.strictEqual(toMinute("32:04"), 1924,
  "jam absolut legacy harus tetap dapat dibaca agar durasi tidak berubah saat Auto Correct");

const independent = await scheduleDailyReleaseAllocations([
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

const dependency = await scheduleDailyReleaseAllocations([
  { ...common, id: "PRE", partCode: "PART-A", machineId: "M-050", plannedStartTime: "07:00", plannedEndTime: "09:00", predecessorAllocationIds: [] },
  { ...common, id: "NEXT", partCode: "PART-B", machineId: "M-051", plannedStartTime: "07:00", plannedEndTime: "08:00", predecessorAllocationIds: ["PRE"] },
]);
const successor = dependency.items.find((item) => item.id === "NEXT");
assert.strictEqual(successor.machineId, "M-051", "dependency tidak memaksa dua part ke mesin yang sama");
assert.strictEqual(successor.plannedStartTime, "11:00", "successor wajib mulai dua jam setelah predecessor selesai");
assert.strictEqual(successor.plannedEndTime, "12:00", "durasi successor tetap dipertahankan setelah digeser");

const samePart = await scheduleDailyReleaseAllocations([
  { ...common, id: "A-1", partCode: "PART-A", machineId: "M-050", plannedStartTime: "07:00", plannedEndTime: "08:00", predecessorAllocationIds: [] },
  { ...common, id: "A-2", partCode: "PART-A", machineId: "M-051", plannedStartTime: "07:00", plannedEndTime: "08:00", predecessorAllocationIds: [] },
]);
assert.strictEqual(new Set(samePart.items.map((item) => item.machineId)).size, 1,
  "part yang sama tidak boleh di-split ke mesin berbeda oleh Daily Release");
assert.strictEqual(samePart.items[1].plannedStartTime, "08:00", "batch part yang sama diantrikan pada mesin yang sama");

const limited = await scheduleDailyReleaseAllocations([
  { ...common, eligibleMachineIds: ["M-050"], id: "L-1", partCode: "PART-A", machineId: "M-050", plannedStartTime: "07:00", plannedEndTime: "09:00", predecessorAllocationIds: [] },
  { ...common, eligibleMachineIds: ["M-050"], id: "L-2", partCode: "PART-B", machineId: "M-050", plannedStartTime: "07:00", plannedEndTime: "09:00", predecessorAllocationIds: [] },
]);
assert.strictEqual(limited.items[1].plannedStartTime, "09:00", "jika hanya satu mesin tersedia, allocation utuh diantrikan tanpa split");
assert.strictEqual(limited.solver.engine, "OR_TOOLS_WASM_CP_SAT", "single-machine queue harus berasal dari solver finite-capacity");

const planSpecificMachine = await scheduleDailyReleaseAllocations([
  { ...common, id: "ACTIVE-ONLY", partCode: "PART-C", machineId: "M-050", eligibleMachineIds: ["M-051"], predecessorAllocationIds: [] },
]);
assert.strictEqual(planSpecificMachine.items[0].machineId, "M-051",
  "daftar mesin eligible plan-specific harus mengalahkan mesin awal yang tidak aktif");

const unavailable = await scheduleDailyReleaseAllocations([
  { ...common, id: "NO-MACHINE", partCode: "PART-D", machineId: "M-050", eligibleMachineIds: [], predecessorAllocationIds: [] },
]);
assert.strictEqual(unavailable.items[0].machineId, null, "allocation tidak boleh dipasang pada mesin yang ditutup");
assert.strictEqual(unavailable.warnings[0].code, "DAILY_RELEASE_MACHINE_UNAVAILABLE");

const workWindows = new Map([["2026-09-07|M-050", [
  { shift: "1", startTime: "08:00", endTime: "16:00" },
  { shift: "2", startTime: "16:00", endTime: "00:00" },
]]]);
const correctedOverlap = await autoCorrectWorkPlacements([
  { ...common, id: "C-1", machineId: "M-050", shift: "1", plannedStartTime: "08:00", plannedEndTime: "10:00", sequence: 1, predecessorAllocationIds: [] },
  { ...common, id: "C-2", machineId: "M-050", shift: "1", plannedStartTime: "08:30", plannedEndTime: "09:30", sequence: 2, predecessorAllocationIds: [] },
], { windowsByMachine: workWindows });
assert.deepStrictEqual(correctedOverlap.items.map((item) => [item.plannedStartTime, item.plannedEndTime]), [["08:00", "10:00"], ["10:00", "11:00"]],
  "Auto Correct harus mengantrikan operation overlap pada mesin yang sama");
assert.strictEqual(correctedOverlap.changes.length, 1);

const correctedOutsideShift = await autoCorrectWorkPlacements([
  { ...common, id: "EARLY", machineId: "M-050", shift: "1", plannedStartTime: "07:00", plannedEndTime: "08:00", sequence: 1, predecessorAllocationIds: [] },
], { windowsByMachine: workWindows });
assert.deepStrictEqual([correctedOutsideShift.items[0].plannedStartTime, correctedOutsideShift.items[0].plannedEndTime], ["08:00", "09:00"],
  "Operation di luar jam kerja harus digeser ke awal shift aktif");

const correctedAgainstReleased = await autoCorrectWorkPlacements([
  { ...common, id: "FIXED", status: "Released", movable: false, machineId: "M-050", shift: "1", plannedStartTime: "08:00", plannedEndTime: "10:00", sequence: 1, predecessorAllocationIds: [] },
  { ...common, id: "DRAFT", status: "Draft", machineId: "M-050", shift: "1", plannedStartTime: "08:00", plannedEndTime: "09:00", sequence: 2, predecessorAllocationIds: [] },
], { windowsByMachine: workWindows });
assert.strictEqual(correctedAgainstReleased.items[0].plannedStartTime, "08:00", "Released operation harus tetap immutable");
assert.deepStrictEqual([correctedAgainstReleased.items[1].plannedStartTime, correctedAgainstReleased.items[1].plannedEndTime], ["10:00", "11:00"],
  "Draft operation harus menghindari slot Released");

const correctedAbsoluteTime = await autoCorrectWorkPlacements([
  { ...common, id: "ABSOLUTE", machineId: "M-050", shift: "2", plannedStartTime: "32:04", plannedEndTime: "35:04", sequence: 1, predecessorAllocationIds: [] },
], { windowsByMachine: workWindows });
assert.strictEqual(toMinute(correctedAbsoluteTime.items[0].plannedEndTime) - toMinute(correctedAbsoluteTime.items[0].plannedStartTime), 180,
  "jam absolut di luar operation day harus dipindahkan ke work window tanpa mengubah durasi");

const rollingWorkWindows = new Map([
  ...workWindows,
  ["2026-09-08|M-050", [
    { shift: "1", startTime: "08:00", endTime: "16:00" },
    { shift: "2", startTime: "16:00", endTime: "00:00" },
  ]],
]);
const correctedToNextDay = await autoCorrectWorkPlacements([
  { ...common, id: "LATE-PRE", status: "Released", movable: false, machineId: "M-051", plannedStartTime: "21:00", plannedEndTime: "23:00", predecessorAllocationIds: [] },
  { ...common, id: "NEXT-DAY", machineId: "M-050", plannedStartTime: "23:00", plannedEndTime: "26:00", predecessorAllocationIds: ["LATE-PRE"] },
], { windowsByMachine: rollingWorkWindows });
assert.strictEqual(String(correctedToNextDay.items[1].scheduleDate).slice(0, 10), "2026-09-08",
  "operation yang tidak muat harus diteruskan ke hari kerja berikutnya");
assert.deepStrictEqual([correctedToNextDay.items[1].plannedStartTime, correctedToNextDay.items[1].plannedEndTime], ["08:00", "11:00"],
  "rolling placement harus memakai jam normal pada tanggal tujuan dan mempertahankan durasi");
assert.strictEqual(correctedToNextDay.warnings[0]?.code, "DAILY_SOLVER_LATE", "rolling placement lintas hari harus menyimpan bukti tardiness solver");

const thirdShiftWindows = new Map([["2026-09-07|M-050", [
  { shift: "3", startTime: "00:00", endTime: "08:00" },
]]]);
const correctedAcrossOperationalBoundary = await autoCorrectWorkPlacements([
  { ...common, id: "NIGHT", machineId: "M-050", plannedStartTime: "06:50", plannedEndTime: "07:20", predecessorAllocationIds: [] },
], { windowsByMachine: thirdShiftWindows });
assert.strictEqual(String(correctedAcrossOperationalBoundary.items[0].scheduleDate).slice(0, 10), "2026-09-08",
  "shift malam harus disimpan pada tanggal kalender aktual oleh solver");
assert.strictEqual(toMinute(correctedAcrossOperationalBoundary.items[0].plannedEndTime) - toMinute(correctedAcrossOperationalBoundary.items[0].plannedStartTime), 30,
  "shift malam yang melewati batas operational day harus mempertahankan durasi");

const controller = fs.readFileSync(path.join(__dirname, "../src/prisma/controllers/planning/MonthlyProductionPlanController.js"), "utf8");
assert(controller.includes("scheduleDailyReleaseAllocations(desired.map"),
  "konversi Monthly Plan harus menjalankan scheduler Daily Release");
assert(controller.includes("machineId: item.allocation.routingMode === \"INHOUSE\" ? item.machineId : null"),
  "Daily Plan harus menyimpan mesin hasil penjadwalan, bukan selalu mesin allocation awal");
assert(!controller.includes("const shiftQuantities = splitQuantity(item.qty"),
  "fallback Daily Release tidak boleh membelah quantity berdasarkan shift");

console.log("Daily release machine scheduling contracts passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
