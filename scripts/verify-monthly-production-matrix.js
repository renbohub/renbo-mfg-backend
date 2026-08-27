const assert = require("assert");
const { buildMonthlyProductionMatrix } = require("../src/prisma/services/planning/monthlyProductionMatrixService");

const matrix = buildMonthlyProductionMatrix({
  dates: ["2026-08-01", "2026-08-02"],
  machines: [{
    id: "machine-1",
    machineCode: "WELD-01",
    lineCode: "L2",
    cells: {
      "2026-08-01": { availableMinutes: 100, loadMinutes: 125, items: [
        { source: "MANUAL", allocationId: "allocation-1", machineId: "machine-1", shift: "SHIFT-1", partCode: "PART-A", processCode: "WELD", operationCode: "WELD-1", fgRequiredDate: "2026-08-05", qty: 100, uomCode: "PCS", minutes: 120, planNumber: "PP-001" },
        { source: "PROPOSED", allocationId: null, machineId: "machine-1", partCode: "PART-GHOST", processCode: "INSP", qty: 242, uomCode: "PCS", minutes: 5, planNumber: "PP-001" },
      ] },
      "2026-08-02": { availableMinutes: 100, loadMinutes: 50, items: [{ source: "MANUAL", partCode: "PART-B", processCode: "WELD", qty: 50, uomCode: "PCS", minutes: 50, planNumber: "PP-001" }] },
    },
  }],
  vendorAssignments: [
    { source: "MANUAL", allocationId: "vendor-allocation-1", vendorId: "vendor-1", sendDate: "2026-08-02", partCode: "PART-C", processCode: "PAINT", mbomProcessId: "route-paint", lineNumber: 3, qty: 80, uomCode: "PCS", planNumber: "PP-001", deliveryPhaseId: "phase-1", fgRequiredDate: "2026-08-02" },
    { source: "PROPOSED", vendorId: "vendor-1", sendDate: "2026-08-01", partCode: "PART-C", processCode: "PAINT", mbomProcessId: "route-paint", lineNumber: 4, qty: 25, uomCode: "PCS", planNumber: "PP-001", deliveryPhaseId: "phase-2", fgRequiredDate: "2026-08-03" },
    { source: "PROPOSED", vendorId: "vendor-1", sendDate: "2026-07-29", partCode: "PART-M1", processCode: "PAINT", mbomProcessId: "route-paint-m1", lineNumber: 6, qty: 15, uomCode: "PCS", planNumber: "PP-001", deliveryPhaseId: "phase-m1", fgRequiredDate: "2026-08-01" },
  ],
  manualAllocationCatalog: [
    { planNumber: "PP-001", lineNumber: 4, mbomProcessId: "route-paint", partCode: "PART-C", processCode: "PAINT", routingMode: "VENDOR", remainingQty: 25, uomCode: "PCS" },
    { planNumber: "PP-001", lineNumber: 5, mbomProcessId: "route-insp", partCode: "PART-D", processCode: "INSP-PACK-2", routingMode: "INHOUSE", allowedMachineIds: ["machine-1"], remainingQty: 30, uomCode: "PCS" },
  ],
  catalogs: { vendors: [{ id: "vendor-1", vendorCode: "PAINT-01", vendorName: "Paint Vendor" }] },
  unscheduled: [],
}, [{ id: "wc-1", workCenterCode: "WELDING", workCenterName: "Welding Line", machines: [{ machine: { id: "machine-1" } }] }], [
  { partCode: "PART-A", partNumber: "FG-100-A", partName: "Bracket A", itemType: "WIP" },
  { partCode: "PART-B", partName: "Bracket B" },
  { partCode: "PART-C", partName: "Bracket C" },
  { partCode: "PART-C-IN", partNumber: "BRACKET-C", partName: "Bracket C Input", itemType: "FG" },
  { partCode: "PART-C-LAST", partNumber: "BRACKET-C", partName: "Bracket C Last WIP", itemType: "WIP" },
  { partCode: "PART-D", partName: "Bracket D" },
  { partCode: "FG-PARENT", partNumber: "FG-001", partName: "Parent Bracket", itemType: "FG" },
], [{ planNumber: "PP-001", deliveryPhaseId: "phase-1", partCode: "FG-PARENT", qty: 80, uomCode: "PCS", fgRequiredDate: "2026-08-02" }], [{
  partCode: "FG-PARENT",
  currentStockQty: 9,
  availableStockQty: 7,
  stockReservedQty: 2,
  stockQcQty: 0,
  efdM: 342,
  bufferQty: 112,
  shortageM1: 5,
  components: [{
    partCode: "PART-A",
    qtyPerFg: 2,
    uomCode: "PCS",
    currentStockQty: 65,
    availableStockQty: 50,
    stockReservedQty: 10,
    stockQcQty: 5,
    dependencies: [{ parentPartCode: "WIP-WELD", qtyPerParent: 2 }],
    processes: [{ processCode: "SPOT" }],
  }, {
    partCode: "PART-C",
    qtyPerFg: 1,
    uomCode: "PCS",
    currentStockQty: 0,
    availableStockQty: 0,
    dependencies: [{ parentPartCode: "FG-PARENT", qtyPerParent: 1 }],
    processes: [{ processCode: "PAINT" }],
  }, {
    partCode: "PART-C-IN",
    qtyPerFg: 1,
    uomCode: "PCS",
    itemType: "FG",
    currentStockQty: 0,
    availableStockQty: 0,
    dependencies: [{ parentPartCode: "PART-C", qtyPerParent: 1 }],
    processes: [{ processCode: "INSP" }],
  }, {
    partCode: "PART-C-LAST",
    qtyPerFg: 1,
    uomCode: "PCS",
    itemType: "WIP",
    currentStockQty: 191,
    availableStockQty: 191,
    dependencies: [{ parentPartCode: "PART-C-IN", qtyPerParent: 1 }],
    processes: [{ processCode: "SPOT" }],
  }, {
    partCode: "WIP-WELD",
    qtyPerFg: 1,
    uomCode: "PCS",
    currentStockQty: 22,
    availableStockQty: 20,
    stockReservedQty: 2,
    stockQcQty: 0,
    dependencies: [{ parentPartCode: "FG-PARENT", qtyPerParent: 1 }],
    processes: [{ processCode: "WELD" }],
  }],
}]);

assert.deepStrictEqual(matrix.dates, ["2026-08-01", "2026-08-02"]);
assert.strictEqual(matrix.rows[0].workCenterCode, "WELDING", "work center dengan blocker harus berada di awal");
assert.strictEqual(matrix.rows[0].days["2026-08-01"].qty, 100);
assert.strictEqual(matrix.rows[0].children.some((child) => child.partCode === "PART-GHOST"), false,
  "proposal tanpa allocation id tidak boleh tampil sebagai alokasi produksi bertanggal");
assert.strictEqual(matrix.unallocatedRequirements.length, 3,
  "proposal in-house, vendor, dan vendor lintas bulan harus tersedia sebagai kebutuhan belum dialokasikan");
assert.deepStrictEqual(matrix.unallocatedRequirements.find((item) => item.partCode === "PART-GHOST"), {
  planNumber: "PP-001",
  partCode: "PART-GHOST",
  processCode: "INSP",
  machineCode: "WELD-01",
  suggestedDate: "2026-08-01",
  qty: 242,
  uomCode: "PCS",
  minutes: 5,
  reason: "Belum menjadi allocation tersimpan",
});
assert.deepStrictEqual(matrix.unallocatedRequirements.find((item) => item.mbomProcessId === "route-paint"), {
  planNumber: "PP-001",
  lineNumber: 4,
  mbomProcessId: "route-paint",
  partCode: "PART-C",
  processCode: "PAINT",
  routingMode: "VENDOR",
  vendorId: "vendor-1",
  suggestedDate: "2026-08-01",
  qty: 25,
  uomCode: "PCS",
  minutes: 0,
  reason: "Belum menjadi allocation tersimpan",
});
assert.deepStrictEqual(matrix.unallocatedRequirements.find((item) => item.mbomProcessId === "route-paint-m1"), {
  planNumber: "PP-001",
  lineNumber: 6,
  mbomProcessId: "route-paint-m1",
  partCode: "PART-M1",
  processCode: "PAINT",
  routingMode: "VENDOR",
  vendorId: "vendor-1",
  suggestedDate: "2026-07-29",
  qty: 15,
  uomCode: "PCS",
  minutes: 0,
  crossMonth: true,
  timingScope: "PREVIOUS_MONTH",
  reason: "Kebutuhan lintas bulan belum menjadi allocation tersimpan",
});
assert.deepStrictEqual(matrix.remainingAllocations.find((item) => item.mbomProcessId === "route-paint"), {
  planNumber: "PP-001", lineNumber: 4, mbomProcessId: "route-paint", partCode: "PART-C", processCode: "PAINT", routingMode: "VENDOR", remainingQty: 25, uomCode: "PCS",
  inputAvailableQty: 191,
  inputStockSources: [{
    partCode: "PART-C-IN", partNumber: "BRACKET-C", partName: "Bracket C Input", itemType: "FG",
    sourceRole: "DIRECT_INPUT", requiredPartCode: "PART-C-IN", inputGroupKey: "PART-C-IN",
    stockWhQty: 0, stockReservedQty: 0, availableQty: 0, qtyPerParent: 1, equivalentOutputQty: 0, uomCode: "PCS",
  }, {
    partCode: "PART-C-LAST", partNumber: "BRACKET-C", partName: "Bracket C Last WIP", itemType: "WIP",
    sourceRole: "PREVIOUS_WIP", requiredPartCode: "PART-C-IN", inputGroupKey: "PART-C-IN",
    stockWhQty: 191, stockReservedQty: 0, availableQty: 191, qtyPerParent: 1, equivalentOutputQty: 191, uomCode: "PCS",
  }],
  inputStockGroups: [{ requiredPartCode: "PART-C-IN", inputGroupKey: "PART-C-IN", availableOutputQty: 191 }],
}, "matrix harus membawa candidate remaining yang dapat ditempel melalui editor");
const storedPaintAllocation = matrix.rows
  .flatMap((row) => row.children)
  .flatMap((child) => Object.values(child.days))
  .flatMap((day) => day.allocations || [])
  .find((allocation) => allocation.allocationId === "vendor-allocation-1");
assert.strictEqual(storedPaintAllocation.inputAvailableQty, 191,
  "allocation tersimpan harus membawa net availability agar modal Move/Split dapat menampilkan tabel stock");
assert.deepStrictEqual(storedPaintAllocation.inputStockSources.map((source) => ({
  partCode: source.partCode, itemType: source.itemType, sourceRole: source.sourceRole, availableQty: source.availableQty,
})), [
  { partCode: "PART-C-IN", itemType: "FG", sourceRole: "DIRECT_INPUT", availableQty: 0 },
  { partCode: "PART-C-LAST", itemType: "WIP", sourceRole: "PREVIOUS_WIP", availableQty: 191 },
], "modal Move/Split harus menerima FG direct input beserta WIP satu level sebelumnya");
assert.ok(matrix.rows.some((row) => row.children.some((child) => child.partCode === "PART-D" && child.processCodes.includes("INSP-PACK-2"))),
  "route yang seluruh qty-nya belum dialokasikan tetap harus mempunyai baris child untuk menerima klik pada cell kosong");
assert.strictEqual(matrix.rows[0].days["2026-08-01"].loadPercent, 120);
assert.strictEqual(matrix.rows[0].capacityState, "OVERLOAD", "header Work Center harus membawa status kapasitas agregat");
assert.strictEqual(matrix.rows[0].days["2026-08-01"].capacityState, "OVERLOAD");
assert.strictEqual(matrix.rows[0].days["2026-08-01"].allocations[0].allocationId, "allocation-1", "editor membutuhkan allocation id nyata");
assert.strictEqual(matrix.rows[0].days["2026-08-01"].machines[0].machineCode, "WELD-01", "cell Work Center harus menjelaskan sumber kapasitas mesin");
assert.strictEqual(matrix.rows[0].days["2026-08-01"].blocker.peakPercent, 120, "persentase blocker harus ditumpuk di tanggal awal");
assert.strictEqual(matrix.rows[0].children[0].type, "BLOCKER", "baris blocker harus muncul sebelum child part");
const partA = matrix.rows[0].children.find((child) => child.partCode === "PART-A");
assert.strictEqual(partA.days["2026-08-01"].allocations[0].shift, "SHIFT-1");
assert.strictEqual(partA.partNumber, "FG-100-A", "child harus membawa Part Number master");
assert.strictEqual(partA.itemType, "WIP", "child harus membawa tipe part");
assert.deepStrictEqual(partA.processCodes, ["WELD-1"], "WIP harus menampilkan occurrence routing, bukan menggabungkan semua tahap ke master process");
assert.deepStrictEqual(partA.fgRequiredDates, ["2026-08-05"], "child harus membawa FG Required dari delivery phase");
assert.deepStrictEqual(partA.planning, {
  currentStockQty: 50,
  stockOnHandQty: 65,
  stockReservedQty: 10,
  stockQcQty: 5,
  stockCoverageQty: 104,
  wipCoverageQty: 40,
  fgCoverageQty: 14,
  stockCoverageSources: [
    { kind: "CURRENT", partCode: "PART-A", processCode: "SPOT", availableStockQty: 50, equivalentQty: 50 },
    { kind: "WIP", partCode: "WIP-WELD", processCode: "WELD", availableStockQty: 20, equivalentQty: 40 },
    { kind: "FG", partCode: "FG-PARENT", processCode: "FG", availableStockQty: 7, equivalentQty: 14 },
  ],
  efdQty: 684,
  bufferQty: 224,
  shortageM1Qty: 10,
  totalRequirementQty: 918,
  uomCode: "PCS",
  sourceFgCount: 1,
}, "child harus membawa stock available dan kebutuhan gross EFD + buffer + shortage M-1 yang dikali Qty/FG");
assert.strictEqual(partA.monthlyProductionQty, 100, "total produksi bulanan child harus menjumlah allocation authoritative di seluruh tanggal");
assert.ok(matrix.rows.some((row) => row.type === "OUTSOURCE" && row.days["2026-08-02"].qty === 80), "vendor process harus menjadi work center outsource");
assert.strictEqual(matrix.fgRequirements.length, 1, "FG Required harus tersedia sebagai kelompok mandiri");
assert.strictEqual(matrix.fgRequirements[0].partNumber, "FG-001", "FG Required harus membawa Part Number FG parent");
assert.strictEqual(matrix.fgRequirements[0].qty, 80, "qty FG Required harus berasal dari receipt FG, bukan qty agregat proses");
assert.strictEqual(matrix.fgRequirements[0].fgRequiredDate, "2026-08-02", "qty FG harus ditempatkan pada tanggal wajib selesai");
assert.strictEqual(matrix.summary.planCount, 1);
assert.strictEqual(matrix.summary.blockerCount, 1, "blocker hanya menghitung masalah kapasitas authoritative");
assert.strictEqual(matrix.summary.unallocatedCount, 3);
assert.strictEqual(matrix.summary.unallocatedMinutes, 5);
assert.strictEqual(matrix.summary.crossMonthCount, 1);
assert.strictEqual(matrix.summary.crossMonthQty, 15);
assert.strictEqual(matrix.summary.attentionCount, 4);
assert.strictEqual(matrix.summary.overloadedCells, 1, "overload MPP hanya boleh dihitung dari allocation tersimpan");

console.log("Monthly Production Plan matrix contract passed.");
