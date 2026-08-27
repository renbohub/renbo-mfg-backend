"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const controller = require("../src/prisma/controllers/planning/MRPController");
const monthlyPlanController = require("../src/prisma/controllers/planning/MonthlyProductionPlanController");
const {
  aggregateCapacityRouteTasks,
  capacityTaskBatchQuantity,
  isReplaceableAutoAllocation,
} = require("../src/prisma/services/planning/capacityRecommendationService");
const { mergeDisplayMrpRuns, mrpLifecycleStatus } = require("../src/prisma/services/planning/planningExecutionCockpitService");
const { prisma } = require("../src/prisma");

const {
  explicitSalesOrderNumbersForMpsDetail,
  consumeSalesOrdersAlreadyRepresentedByMps,
  productionProcessScheduleQty,
  buildMPlusOneInventoryNettingItem,
  resolveMPlusOnePreviewBasisQty,
  enrichMPlusOnePreviewDisplayQty,
  shouldExplodeNestedMbom,
  isCurrentMPlusOnePreviewRun,
  mrpApprovalEligibility,
  mrpApprovalTransitionData,
  mrpApprovalCycleMpsNumbers,
  mrpCalculationLifecycle,
  assertApprovedCurrentMrp,
  buildMrpSourceSnapshot,
  mrpSourceSnapshotMatches,
  isEmbeddedStockInputPart,
  filterWipLinesForRequirementPath,
  enrichMPlusOnePreviewRequirements,
} = controller.__test;

assert.strictEqual(typeof isEmbeddedStockInputPart, "function", "MRP harus memiliki klasifikasi component yang dapat dicover WIP");
assert.strictEqual(isEmbeddedStockInputPart({ itemType: "RAW", rawType: "MATERIAL" }), true, "raw material harus dapat dicover stock output WIP pada jalur BOM");
assert.strictEqual(isEmbeddedStockInputPart({ itemType: "RAW", rawType: "PURCHASE_PART" }), true, "purchase part seperti NUT-M6 harus dapat dicover stock output WIP pada jalur BOM");
assert.strictEqual(isEmbeddedStockInputPart({ itemType: "WIP" }), false, "output WIP tidak boleh diperlakukan sebagai raw component embedded");
assert.strictEqual(typeof filterWipLinesForRequirementPath, "function", "MRP harus memfilter sumber WIP per jalur BOM requirement");
assert.deepStrictEqual(
  filterWipLinesForRequirementPath(
    [
      { sourcePartCode: "C002-C005-010", qtyOnHand: 83 },
      { sourcePartCode: "C002-C006-010", qtyOnHand: 84 },
    ],
    new Set(["C002-C006-010"]),
  ).map((row) => row.sourcePartCode),
  ["C002-C006-010"],
  "baris NUT untuk C002-C006 tidak boleh menampilkan stock WIP milik C002-C005",
);
assert.strictEqual(typeof enrichMPlusOnePreviewRequirements, "function", "preview M+1 harus memakai pipeline enrichment yang dapat diuji");
(async () => {
  const calls = [];
  const result = await enrichMPlusOnePreviewRequirements({}, [{ id: "CLAMP-PREVIEW" }], {}, {
    qty: async (_tx, rows) => { calls.push("qty"); return rows.map((row) => ({ ...row, qtyReady: true })); },
    supply: async (_tx, rows) => { calls.push("supply"); return rows.map((row) => ({ ...row, supplyBreakdown: { warehouseStock: { qtyAvailable: 619 }, wipStock: { planningSupplyQty: 262 } } })); },
    display: (rows) => { calls.push("display"); return rows; },
    group: (rows) => { calls.push("group"); return rows; },
  });
  assert.deepStrictEqual(calls, ["qty", "supply", "display", "group"], "preview M+1 harus enrich stock sebelum dibentuk menjadi baris display");
  assert.strictEqual(result[0].supplyBreakdown.warehouseStock.qtyAvailable, 619, "preview CLAMP harus membawa stock warehouse");
  assert.strictEqual(result[0].supplyBreakdown.wipStock.planningSupplyQty, 262, "preview CLAMP harus membawa stock WIP-equivalent");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

assert.strictEqual(typeof mrpApprovalEligibility, "function", "MRP harus mempunyai gate approval untuk working revision Simulated");
assert.deepStrictEqual(
  mrpApprovalEligibility({ status: "Completed", scenarioStatus: "SIMULATED", isCurrentPlan: false, scenarioAssumptions: { planningMode: "OFFICIAL" } }),
  { allowed: true, code: "READY_TO_APPROVE" },
  "Snapshot Simulated official harus dapat dipromosikan tanpa hitung ulang",
);
assert.deepStrictEqual(
  mrpApprovalEligibility({ status: "Completed", scenarioStatus: "SIMULATION", isCurrentPlan: false, scenarioAssumptions: { planningMode: "OFFICIAL" } }),
  { allowed: true, code: "READY_TO_APPROVE" },
  "Alias legacy SIMULATION harus diperlakukan sebagai working revision Simulated tanpa melemahkan gate lain",
);
assert.deepStrictEqual(
  mrpApprovalEligibility({ status: "Completed", scenarioStatus: "UNKNOWN", isCurrentPlan: false, scenarioAssumptions: { planningMode: "OFFICIAL" } }),
  { allowed: false, code: "MRP_NOT_SIMULATED" },
  "Status tidak dikenal tidak boleh diam-diam ditampilkan atau dipromosikan sebagai Simulated",
);
assert.deepStrictEqual(
  mrpApprovalEligibility({ status: "Completed", scenarioStatus: "SIMULATED", isCurrentPlan: false, scenarioAssumptions: { planningMode: "M_PLUS_ONE_PREVIEW" } }),
  { allowed: false, code: "LOOKAHEAD_PREVIEW_NOT_APPROVABLE" },
  "Preview M+1 tidak boleh dipromosikan menjadi MRP official",
);
assert.deepStrictEqual(
  mrpApprovalTransitionData({ scenarioAssumptions: { planningMode: "OFFICIAL", sourceMpsNumbers: ["MPS-202609"] } }, "ppic.user"),
  {
    status: "Completed",
    scenarioStatus: "APPROVED",
    isCurrentPlan: true,
    scenarioAssumptions: { planningMode: "OFFICIAL", sourceMpsNumbers: ["MPS-202609"], approvedFromSnapshot: true, approvedBy: "ppic.user" },
  },
  "Approval harus mempromosikan snapshot yang sama dan menyimpan jejak approver",
);
assert.strictEqual(typeof mrpApprovalCycleMpsNumbers, "function", "MRP approval harus mempunyai resolver planning cycle");
assert.deepStrictEqual(
  mrpApprovalCycleMpsNumbers({ mpsNumber: "MPS-202609", scenarioAssumptions: { officialSourceMpsNumbers: ["MPS-202609"], sourceMpsNumbers: ["MPS-202609"], planningCycleMpsNumbers: ["MPS-202609", "MPS-202610", "MPS-202611"] } }),
  ["MPS-202609"],
  "Approval official hanya memeriksa source resmi; M+1/M+2 look-ahead tidak boleh menjadi blocker eksekusi",
);
assert.deepStrictEqual(
  mrpCalculationLifecycle(undefined),
  { allowed: true, initialStatus: "DRAFT", completedStatus: "SIMULATED", isCurrentPlan: false },
  "Endpoint hitung harus selalu membuat working revision Draft lalu Simulated",
);
assert.deepStrictEqual(
  mrpCalculationLifecycle("APPROVED"),
  { allowed: false, code: "MRP_APPROVAL_ENDPOINT_REQUIRED" },
  "Endpoint hitung tidak boleh menerima bypass status Approved",
);
assert.throws(
  () => assertApprovedCurrentMrp({ status: "Completed", scenarioStatus: "SIMULATED", isCurrentPlan: false, scenarioAssumptions: { planningMode: "OFFICIAL" } }),
  (error) => error.code === "MRP_OUTPUT_REQUIRES_APPROVAL",
  "Output eksekusi harus ditolak untuk revision Simulated",
);
assert.doesNotThrow(
  () => assertApprovedCurrentMrp({ status: "Completed", scenarioStatus: "APPROVED", isCurrentPlan: true, scenarioAssumptions: { planningMode: "OFFICIAL" } }),
  "Output eksekusi hanya boleh berasal dari revision Approved/current",
);
const mrpSourceSnapshot = buildMrpSourceSnapshot([
  { mpsNumber: "MPS-202609", revision: 7, deliveryFeasibilityFingerprint: "fp-sep" },
  { mpsNumber: "MPS-202610", revision: 3, deliveryFeasibilityFingerprint: "fp-oct" },
]);
assert.strictEqual(
  mrpSourceSnapshotMatches(mrpSourceSnapshot, [
    { mpsNumber: "MPS-202609", revision: 7, deliveryFeasibilityFingerprint: "fp-sep" },
    { mpsNumber: "MPS-202610", revision: 3, deliveryFeasibilityFingerprint: "fp-oct" },
  ]),
  true,
  "Approval harus menerima source MPS yang revision dan delivery fingerprint-nya masih sama",
);
assert.strictEqual(
  mrpSourceSnapshotMatches({
    planningCycleMpsRevisions: [
      { revision: 7, mpsNumber: "MPS-202609" },
      { revision: 3, mpsNumber: "MPS-202610" },
    ],
    planningCycleDeliveryFingerprints: [
      { fingerprint: "fp-sep", mpsNumber: "MPS-202609" },
      { fingerprint: "fp-oct", mpsNumber: "MPS-202610" },
    ],
  }, [
    { mpsNumber: "MPS-202609", revision: 7, deliveryFeasibilityFingerprint: "fp-sep" },
    { mpsNumber: "MPS-202610", revision: 3, deliveryFeasibilityFingerprint: "fp-oct" },
  ]),
  true,
  "Approval tidak boleh bergantung pada urutan key JSONB snapshot",
);
assert.strictEqual(
  mrpSourceSnapshotMatches(mrpSourceSnapshot, [
    { mpsNumber: "MPS-202609", revision: 8, deliveryFeasibilityFingerprint: "fp-sep" },
    { mpsNumber: "MPS-202610", revision: 3, deliveryFeasibilityFingerprint: "fp-oct" },
  ]),
  false,
  "Approval harus menolak snapshot setelah revision MPS berubah",
);
assert.strictEqual(
  mrpSourceSnapshotMatches(mrpSourceSnapshot, [
    { mpsNumber: "MPS-202609", revision: 7, deliveryFeasibilityFingerprint: "fp-sep" },
  ]),
  true,
  "Snapshot planning cycle harus dapat divalidasi terhadap subset source official tanpa menggating look-ahead",
);
const legacyDeliveryFingerprint = createHash("sha256").update(JSON.stringify(["fp-sep-phase-1"])).digest("hex");
assert.strictEqual(
  mrpSourceSnapshotMatches({
    deliveryGateSnapshot: [{
      mpsNumber: "MPS-202609",
      snapshots: [{ mpsRevision: 7, sourceFingerprint: "fp-sep-phase-1" }],
    }],
  }, [{
    mpsNumber: "MPS-202609",
    revision: 7,
    deliveryFeasibilityFingerprint: legacyDeliveryFingerprint,
  }]),
  true,
  "Working revision legacy tanpa planningCycleMpsRevisions harus memakai delivery gate fingerprint yang tersimpan, bukan diblokir tanpa alasan",
);

assert.strictEqual(
  typeof buildMPlusOneInventoryNettingItem,
  "function",
  "preview M+1 harus mempunyai kalkulator netting berbasis snapshot inventory saat ini",
);
const currentInventoryPreview = buildMPlusOneInventoryNettingItem({
  partCode: "FG-01",
  forecastQty: 223,
  targetEndingStockQty: 50,
  firmScheduledReceiptQty: 80,
}, {
  onHandQty: 150,
  reservedQty: 40,
  freeQty: 110,
});
assert.deepStrictEqual(
  currentInventoryPreview,
  {
    partCode: "FG-01",
    efdMPlusOne: 223,
    inventoryStockQty: 150,
    reservedStockQty: 40,
    freeStockQty: 110,
    stockCoverageQty: 150,
    netDemandOnly: 73,
    targetEndingBufferMPlusOne: 50,
    netWithMPlusTwoBuffer: 123,
  },
  "net M+1 harus memakai EFD delivery dikurangi current inventory, tanpa projected closing M atau firm receipt",
);

assert.strictEqual(
  shouldExplodeNestedMbom({ childExplosionQty: 0, forecastQty: 223, includeZeroNetForecastTree: true }),
  true,
  "preview M+1 harus tetap membuka nested BOM untuk kebutuhan teoritis ketika WIP membuat net operational nol",
);
assert.strictEqual(
  shouldExplodeNestedMbom({ childExplosionQty: 0, forecastQty: 223, includeZeroNetForecastTree: false }),
  false,
  "MRP official tidak boleh membuka nested BOM yang sudah dihentikan oleh netting stock/WIP",
);
assert.strictEqual(
  shouldExplodeNestedMbom({ childExplosionQty: 12, forecastQty: 0, includeZeroNetForecastTree: false }),
  true,
  "nested BOM dengan driver produksi positif harus tetap diexplode seperti sebelumnya",
);
assert.strictEqual(
  isCurrentMPlusOnePreviewRun({ scenarioAssumptions: { planningMode: "M_PLUS_ONE_PREVIEW", previewTreeVersion: 1 } }),
  false,
  "preview lama yang belum menyimpan full nested forecast tree harus diregenerasi",
);
assert.strictEqual(
  isCurrentMPlusOnePreviewRun({ scenarioAssumptions: { planningMode: "M_PLUS_ONE_PREVIEW", previewTreeVersion: 2 } }),
  false,
  "preview lama yang masih memakai projected closing M harus diregenerasi",
);
assert.strictEqual(
  isCurrentMPlusOnePreviewRun({ scenarioAssumptions: { planningMode: "M_PLUS_ONE_PREVIEW", previewTreeVersion: 3 } }),
  true,
  "preview current-inventory version boleh dipakai kembali tanpa membuat simulasi ganda",
);

assert.strictEqual(
  resolveMPlusOnePreviewBasisQty({ efdMPlusOne: 223, netDemandOnly: 111 }, "FULL_EFD"),
  223,
  "preview Full EFD harus memakai EFD M+1 tanpa mengurangi coverage bulan M",
);
assert.strictEqual(
  resolveMPlusOnePreviewBasisQty({ efdMPlusOne: 223, netDemandOnly: 111 }, "NET_CURRENT_STOCK"),
  111,
  "preview default harus memakai net EFD M+1 sesudah snapshot inventory saat ini",
);
const previewDisplayRows = enrichMPlusOnePreviewDisplayQty([
  { id: "phase-1-nut", planningPartCode: "FG-01", forecastQty: 186, grossRequirement: 186, onHandQty: 150, allocatedQty: 40, netRequirement: 36 },
  { id: "phase-2-nut", planningPartCode: "FG-01", forecastQty: 260, grossRequirement: 260, onHandQty: 0, allocatedQty: 0, netRequirement: 260 },
], {
  totals: { efdMPlusOne: 223, netDemandOnly: 73 },
  items: [{ partCode: "FG-01", efdMPlusOne: 223, netDemandOnly: 73, inventoryStockQty: 150, reservedStockQty: 40, freeStockQty: 110 }],
});
assert.strictEqual(previewDisplayRows[0].mPlusOneFullEfdGrossQty, 186, "gross preview full harus mempertahankan hasil BOM explosion teoritis per phase");
assert.strictEqual(previewDisplayRows[0].mPlusOneDeliveryRequirementQty, 186, "card phase pertama harus menampilkan kebutuhan delivery sebelum stock");
assert.strictEqual(previewDisplayRows[0].mPlusOneInventoryStockQty, 150, "card harus menampilkan inventory snapshot sebelum phase");
assert.strictEqual(previewDisplayRows[0].mPlusOneReservedStockQty, 40, "card harus menampilkan reserved stock");
assert.strictEqual(previewDisplayRows[0].mPlusOneFreeStockQty, 110, "card harus menampilkan free stock");
assert.strictEqual(previewDisplayRows[0].mPlusOneStockUsedQty, 150, "phase pertama memakai current stock maksimal sebesar delivery requirement");
assert.strictEqual(previewDisplayRows[0].mPlusOneNetRequirementQty, 36, "preview default harus menampilkan net requirement setelah current stock");
assert.strictEqual(previewDisplayRows[1].mPlusOneFullEfdGrossQty, 260, "qty BOM phase kedua tidak boleh hilang ketika parent tertutup WIP");
assert.strictEqual(previewDisplayRows[1].mPlusOneInventoryStockQty, 0, "stock yang habis di phase pertama tidak boleh dipakai ulang pada phase kedua");
assert.strictEqual(previewDisplayRows[1].mPlusOneNetRequirementQty, 260, "phase kedua harus menampilkan sisa kebutuhan setelah stock pool phase sebelumnya habis");
assert.strictEqual(previewDisplayRows[0].grossRequirement, 186, "preview display tidak boleh menulis ulang gross authoritative engine");
assert.strictEqual(previewDisplayRows[0].netRequirement, 36, "preview display tidak boleh mengubah net purchase authoritative engine");

const detail = {
  partCode: "FG-01",
  endDate: new Date("2026-09-29T00:00:00.000Z"),
  _deliveryPhaseId: "phase-september",
  demandSources: [{ sourceType: "SALES_ORDER", sourceNumber: "SO-2026-001" }],
};
assert.deepStrictEqual([...explicitSalesOrderNumbersForMpsDetail(detail)], ["SO-2026-001"]);

const demand = {
  "FG-01": [
    { sourceNumber: "SO-2026-001#1", dueDate: new Date("2026-09-30T00:00:00.000Z"), remainingQty: 300 },
    { sourceNumber: "SO-OTHER#1", dueDate: new Date("2026-09-28T00:00:00.000Z"), remainingQty: 50 },
  ],
};
const consumed = consumeSalesOrdersAlreadyRepresentedByMps(demand, detail, 0);
assert.strictEqual(consumed.consumedQty, 300, "SO yang sudah ada di MPS harus dikonsumsi walau original due berbeda satu hari");
assert.strictEqual(demand["FG-01"][0].remainingQty, 0, "SO terwakili MPS tidak boleh menjadi demand tambahan");
assert.strictEqual(demand["FG-01"][1].remainingQty, 50, "SO lain tidak boleh ikut dikonsumsi oleh phase ini");

assert.strictEqual(
  productionProcessScheduleQty({ orderType: "Production", grossRequirement: 60, onHandQty: 60 }),
  0,
  "stok output sesudah PAINT boleh menutup operasi PAINT",
);
assert.strictEqual(
  productionProcessScheduleQty({ orderType: "Production", grossRequirement: 60, onHandQty: 0 }),
  60,
  "stok child sebelum PAINT tidak boleh menghapus operasi PAINT pada output parent",
);
assert.strictEqual(
  productionProcessScheduleQty({ orderType: "Purchase", grossRequirement: 60, onHandQty: 0 }),
  0,
  "process schedule hanya berlaku untuk requirement Production",
);
assert.strictEqual(
  monthlyPlanController.__test.requirementExecutionQty({ requirementType: "Dependent", levelMBOM: 2, grossRequirement: 60, onHandQty: 0, netRequirement: 0 }),
  60,
  "MPP harus mempertahankan PAINT ketika stok berada pada child stage sebelum PAINT",
);
assert.strictEqual(
  monthlyPlanController.__test.requirementExecutionQty({ requirementType: "Dependent", levelMBOM: 2, grossRequirement: 60, onHandQty: 60, netRequirement: 0 }),
  0,
  "MPP boleh melewati PAINT ketika stok output PAINT sendiri sudah tersedia",
);
assert.strictEqual(
  monthlyPlanController.__test.requirementExecutionQty({ requirementType: "Independent", levelMBOM: 0, grossRequirement: 60, onHandQty: 11, netRequirement: 60 }),
  60,
  "FG receipt tetap memakai net production authoritative dari MRP",
);
const consolidatedMppProcess = monthlyPlanController.__test.consolidateGeneratedExecutionDetails([
  { id: "mps-process-a", mpsDetailId: "mps-process-a", partCode: "C002-C004-010", qtyPlanned: 38, uomCode: "pcs", startDate: new Date("2026-08-19T00:00:00.000Z"), endDate: new Date("2026-08-19T00:00:00.000Z"), notes: "[MRP-PRODUCTION] [MPS-SOURCE:fg-source] [MRP-TARGET:phase-1] [MRP-ORDER-MONTH:2026-08]" },
  { id: "mps-process-b", mpsDetailId: "mps-process-b", partCode: "C002-C004-010", qtyPlanned: 22, uomCode: "pcs", startDate: new Date("2026-08-19T00:00:00.000Z"), endDate: new Date("2026-08-19T00:00:00.000Z"), notes: "[MRP-PRODUCTION] [MPS-SOURCE:fg-source] [MRP-TARGET:phase-1] [MRP-ORDER-MONTH:2026-08]" },
]);
assert.strictEqual(consolidatedMppProcess.length, 1, "MPP harus mempunyai satu execution line untuk output operation dan phase yang sama");
assert.strictEqual(consolidatedMppProcess[0].qtyPlanned, 60, "qty execution line MPP harus menjumlahkan duplicate technical MPS rows");
assert.strictEqual(
  monthlyPlanController.__test.canonicalMrpExecutionNotes(
    "[MRP-PRODUCTION] [MPS-SOURCE:fg-source] [MRP-RUN:MRP-202609-R005] [MRP-TARGET:old] [MRP-ORDER-MONTH:2026-08] [MRP-RUN:MRP-202609-R006]",
    "MRP-202609-R006",
    "phase-9",
    "2026-09",
  ),
  "[MRP-PRODUCTION] [MPS-SOURCE:fg-source] [MRP-RUN:MRP-202609-R006] [MRP-TARGET:phase-9] [MRP-ORDER-MONTH:2026-09]",
  "sinkronisasi Production Plan harus mengganti marker revision MRP lama, bukan menumpuk R005 dan R006",
);
assert.deepStrictEqual(
  monthlyPlanController.__test.sourceMrpRunNumbers({
    details: [{ notes: "[MRP-RUN:MRP-202609-R006]" }],
    recommendationSummary: { sourcePlanSync: { sourceMrpRunNumber: "MRP-202609-R005" } },
  }),
  ["MRP-202609-R006"],
  "snapshot detail executable harus authoritative ketika audit capacity masih menyimpan revision lama",
);
assert.deepStrictEqual(
  monthlyPlanController.__test.sourceMrpRunNumbers({
    details: [{ notes: "legacy detail tanpa marker" }],
    recommendationSummary: { sourcePlanSync: { sourceMrpRunNumber: "MRP-202609-R006" } },
  }),
  ["MRP-202609-R006"],
  "audit sourcePlanSync tetap menjadi fallback untuk legacy detail tanpa marker",
);
const capacityToday = new Date("2026-08-20T00:00:00.000Z");
assert.strictEqual(
  isReplaceableAutoAllocation({ id: "past-draft", allocationSource: "AUTO_RECOMMENDATION", status: "Draft", scheduleDate: new Date("2026-08-19T00:00:00.000Z") }, capacityToday),
  true,
  "auto-allocation Draft yang sudah lewat tetap boleh diganti ketika MPP direplan",
);
assert.strictEqual(
  isReplaceableAutoAllocation({ id: "past-published", allocationSource: "AUTO_RECOMMENDATION", status: "Published", scheduleDate: new Date("2026-08-19T00:00:00.000Z") }, capacityToday),
  false,
  "allocation Published di masa lalu harus dipertahankan sebagai history",
);
assert.strictEqual(
  isReplaceableAutoAllocation({ id: "future-auto", allocationSource: "AUTO_RECOMMENDATION", status: "Published", scheduleDate: new Date("2026-08-21T00:00:00.000Z") }, capacityToday),
  true,
  "auto-allocation masa depan yang belum firm tetap boleh diganti",
);
assert.strictEqual(
  isReplaceableAutoAllocation({ id: "firm-auto", allocationSource: "AUTO_RECOMMENDATION", status: "Draft", scheduleDate: new Date("2026-08-19T00:00:00.000Z") }, capacityToday, new Set(["firm-auto"])),
  false,
  "allocation yang sudah terhubung ke eksekusi tidak boleh diganti",
);
const aggregatedInspection = aggregateCapacityRouteTasks([
  { detail: { id: "detail-a", qtyPlanned: 38, uomCode: "pcs" }, route: { id: "route-insp" }, phasePlannedQty: 38, phaseReceiptQty: 60 },
  { detail: { id: "detail-b", qtyPlanned: 22, uomCode: "pcs" }, route: { id: "route-insp" }, phasePlannedQty: 22, phaseReceiptQty: 60 },
]);
assert.strictEqual(aggregatedInspection.length, 1, "baris MPS pada operation MBOM yang sama harus menjadi satu capacity task");
assert.strictEqual(aggregatedInspection[0].phasePlannedQty, 60, "qty operation gabungan harus mempertahankan total semua baris MPS");
assert.strictEqual(
  capacityTaskBatchQuantity(aggregatedInspection[0], 60, 0, 60, 0),
  60,
  "PAINT/INSP phase 60 tidak boleh berkurang karena duplicate route node",
);

const mrpSource = fs.readFileSync(path.resolve(__dirname, "../src/prisma/controllers/planning/MRPController.js"), "utf8");
const purchaseSuggestionSource = fs.readFileSync(path.resolve(__dirname, "../src/prisma/controllers/purchasing/PurchaseSuggestionController.js"), "utf8");
const monthlyPlanSource = fs.readFileSync(path.resolve(__dirname, "../src/prisma/controllers/planning/MonthlyProductionPlanController.js"), "utf8");
const executionCockpitSource = fs.readFileSync(path.resolve(__dirname, "../src/prisma/services/planning/planningExecutionCockpitService.js"), "utf8");
const uiSource = fs.readFileSync(path.resolve(__dirname, "../../frontend/public/js/ppic-dashboard.js"), "utf8");
const monthlyPlanUiSource = fs.readFileSync(path.resolve(__dirname, "../../frontend/public/js/operations-detail.js"), "utf8");
const lifecycleMigration = fs.readFileSync(path.resolve(__dirname, "../prisma/migrations/20260823150000_mrp_lifecycle_status/migration.sql"), "utf8");
assert(mrpSource.includes('code: "MPS_CYCLE_INCOMPLETE"'), "Backend harus menolak subset planning cycle");
assert(mrpSource.includes("expectedMpsNumbers"), "Error cycle parsial harus menjelaskan MPS yang diharapkan");
assert(mrpSource.includes("mrpCalculationLifecycle(req.body?.scenarioStatus)"), "Endpoint hitung harus menolak bypass lifecycle dari request client");
assert(mrpSource.includes('scenarioStatus: { in: ["SIMULATION", "SIMULATED"] }, isCurrentPlan: false'), "Approval harus memakai conditional transition yang aman untuk working revision canonical dan legacy");
assert(lifecycleMigration.includes("SET \"scenario_status\" = 'SIMULATED'") && lifecycleMigration.includes("tbl_mrp_run_scenario_status_check"), "Migrasi lifecycle harus menormalisasi SIMULATION dan membatasi vocabulary baru");
assert(mrpSource.includes('isolationLevel: "Serializable"'), "Approval concurrent harus berjalan dalam transaksi serializable");
assert(mrpSource.includes("mrpSourceSnapshotMatches(snapshot.scenarioAssumptions || {}, approvalCycleMps)"), "Approval harus membandingkan revision/fingerprint source di dalam transaksi");
assert(mrpSource.includes('"RESIDUAL_REPLAN_PRESERVE_EXECUTION"'), "Approval revision baru harus memakai residual replan ketika lineage lama sudah Released");
assert(mrpSource.includes("executionDetailLineageFilters"), "Proteksi lineage harus membaca MPP melalui mpsDetailId dan marker MRP, bukan hanya planned order");
assert(mrpSource.includes("protectedPreviousOrderNumbers") && mrpSource.includes("generatedMoCount"), "MPP/MO dari generated child schedule yang sudah firm harus dipertahankan");
assert(mrpSource.includes("supersededPlannedOrderNumbers") && mrpSource.includes("protectedPlannedOrderNumbers"), "Residual replan harus memisahkan recommendation lama yang aman disupersede dari histori protected");
assert(!mrpSource.includes('code: "MRP_RELEASED_LINEAGE_PROTECTED"'), "Lineage Released tidak boleh lagi memblokir approval residual replan");
assert(mrpSource.includes('assertApprovedCurrentMrp(run, "Production Plan")'), "Production Plan harus ditolak server untuk MRP yang belum Approved/current");
assert(purchaseSuggestionSource.includes('assertApprovedCurrentMrp(run, "Purchase Suggestion")'), "Purchase Suggestion harus ditolak server untuk MRP yang belum Approved/current");
assert(purchaseSuggestionSource.includes('assertApprovedCurrentMrp(sourceRun, "Purchase Requisition")'), "Konversi PR harus mempertahankan gate Approved/current sampai output purchasing");
assert(!uiSource.includes('document.status === "Confirmed" ? `<button data-run-mrp="${esc(mpsNumber)}">Run MRP</button>`'), "Cell bulanan tidak boleh memiliki tombol Run MRP");
assert(uiSource.includes('Run MRP Cycle (${cycleNumbers.length} bulan)'), "Planning cycle harus mempunyai satu tombol Run MRP");
assert(uiSource.includes('Production Plan</button>'), "Production Plan harus tersedia dari demand-phase planning cycle");
assert(monthlyPlanSource.includes('ownershipRule: "DEMAND_PHASE_HORIZON"'), "Production Plan harus dimiliki demand-phase horizon, bukan bulan kalender");
assert(monthlyPlanSource.includes('const prefix = `PP-${date.getUTCFullYear()}-`'), "Nomor Production Plan baru tidak boleh memakai bulan sebagai identitas");
assert(monthlyPlanSource.includes("new Map([[horizon.ownerKey, details]])"), "Detail lintas bulan harus dikonsolidasikan menjadi satu Production Plan horizon");
assert(monthlyPlanSource.includes("periodStart: { lt: filterEndExclusive }, periodEnd: { gte: filterStart }"), "Filter bulan Production Plan harus memakai overlap horizon, bukan planMonth");
assert(monthlyPlanSource.includes("planId: { in: relatedPlanIds.length ? relatedPlanIds : [plan.id] }"), "Timeline harus mampu menyambungkan allocation lintas legacy plan");
assert(monthlyPlanSource.includes("ownerAllocation?.plan?.planNumber || supersededByPlanNumber || plan.planNumber"), "Legacy plan tanpa allocation harus tetap menjadi carry-over ke owner aktif");
assert(monthlyPlanSource.includes('status: { in: ["Draft", "Published"] }'), "Allocation non-eksekusi pada legacy plan harus dihentikan saat konsolidasi");
assert(executionCockpitSource.includes('NOT: { notes: { contains: "[SUPERSEDED-BY:" } }'), "Control Tower tidak boleh menghitung plan superseded sebagai owner aktif");
const displayedMrpRuns = mergeDisplayMrpRuns(
  [{ runNumber: "MRP-R020", mpsNumber: "MPS-202609", isCurrentPlan: true, status: "Completed", planRevision: 20 }],
  [
    { runNumber: "MRP-R022", mpsNumber: "MPS-202609", isCurrentPlan: false, status: "Completed", scenarioStatus: "SIMULATED", scenarioAssumptions: { planningMode: "M_PLUS_ONE_PREVIEW" }, planRevision: 22 },
    { runNumber: "MRP-R021", mpsNumber: "MPS-202609", isCurrentPlan: false, status: "Completed", scenarioStatus: "SIMULATION", planRevision: 21 },
    { runNumber: "MRP-R020", mpsNumber: "MPS-202609", isCurrentPlan: true, status: "Completed", planRevision: 20 },
  ],
  [{ runNumber: "MRP-R010", mpsNumber: "MPS-202608", isCurrentPlan: true, status: "Completed", planRevision: 10 }],
  "2026-09",
);
assert.strictEqual(typeof mrpLifecycleStatus, "function", "Lifecycle MRP Draft/Simulated/Approved harus tersedia sebagai kontrak domain");
assert.deepStrictEqual(displayedMrpRuns.map((row) => row.runNumber), ["MRP-R021", "MRP-R010"], "Daftar MRP hanya boleh menampilkan revision aktif terbaru per MPS");
assert.strictEqual(displayedMrpRuns[0].executionScope, "PERIOD", "Working revision terbaru harus menjadi owner tampilan periode");
assert.strictEqual(displayedMrpRuns[0].presentationStatus, "SIMULATED", "Hasil kalkulasi yang belum disetujui harus berstatus Simulated");
assert.strictEqual(displayedMrpRuns[0].approvedRunNumber, "MRP-R020", "Working revision harus tetap menunjukkan revision Approved yang sedang official");
assert.strictEqual(displayedMrpRuns[1].presentationStatus, "APPROVED", "Current official harus berstatus Approved");
assert.strictEqual(displayedMrpRuns[1].executionScope, "LINKED_SOURCE", "MRP current dari MPP lintas bulan tetap ditandai linked source");
assert.strictEqual(mrpLifecycleStatus({ status: "Running", scenarioStatus: "DRAFT" }), "DRAFT", "Run yang belum selesai dihitung harus berstatus Draft");
assert.strictEqual(mrpLifecycleStatus({ status: "Failed", scenarioStatus: "DRAFT" }), "FAILED", "Run gagal tidak boleh tetap terlihat sebagai Draft");
assert(monthlyPlanUiSource.includes("REQ, stock, dan EFF hanya dihitung di owner plan"), "UI harus mencegah demand dan stock dihitung dua kali pada carry-over");
assert(monthlyPlanUiSource.includes("Full Horizon"), "Matrix mingguan harus dapat menampilkan seluruh planning horizon lintas bulan");

console.log("MRP planning-cycle, lifecycle, output-gate, WIP-stage, and cross-month ownership contracts passed: 48/48 cases");
prisma.$disconnect().catch(() => {});
