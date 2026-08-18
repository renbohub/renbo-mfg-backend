const assert = require("assert");
const {
  predecessorQuantityStatus,
  groupPredecessorAllocations,
  reservePredecessorGroupOutput,
  predecessorGroupReadiness,
  compareAllocationConsumptionOrder,
  allocationFinishMoment,
  crossPlanPredecessorStatus,
  resolveVendorReturnDeadline,
} = require("../src/prisma/services/planning/capacityPlanningService");
const {
  generatedBatchQuantity,
  priorityNetBatchQuantity,
  phaseJobs,
  combineSingleDeliveryBufferCampaigns,
  fitFirstBatchStrategies,
  scorePlacementCandidate,
  SCORING_MODEL,
} = require("../src/prisma/services/planning/capacityRecommendationService");

const equalBomCoverage = predecessorQuantityStatus(57.333, 172, 78.667, 236);
assert.strictEqual(equalBomCoverage.mode, "COVERAGE");
assert.strictEqual(equalBomCoverage.short, false, "Rasio BOM berbeda dengan coverage batch sama tidak boleh menjadi blocker");

const realCoverageShortage = predecessorQuantityStatus(43, 172, 78.667, 236);
assert.strictEqual(realCoverageShortage.short, true, "Coverage predecessor 25% harus memblokir successor 33,33%");

const rawFallbackShortage = predecessorQuantityStatus(5, 0, 6, 0);
assert.strictEqual(rawFallbackShortage.mode, "RAW_QTY");
assert.strictEqual(rawFallbackShortage.short, true, "Tanpa target MPP, validator harus memakai fallback qty mentah");

const paintPhase1 = generatedBatchQuantity(100, 0, 280 / 300, "pcs");
const paintPhase2 = generatedBatchQuantity(200, 100, 280 / 300, "pcs");
assert.deepStrictEqual([paintPhase1, paintPhase2, paintPhase1 + paintPhase2], [93, 187, 280], "PCS harus bulat dan sisa pembulatan masuk ke phase berikutnya");

const roundedEqualCoverage = predecessorQuantityStatus(57, 172, 79, 236, "pcs", "pcs");
assert.strictEqual(roundedEqualCoverage.short, false, "Selisih coverage akibat pembulatan maksimal setengah PCS per line tidak boleh menjadi blocker");

const roundedRealShortage = predecessorQuantityStatus(55, 172, 79, 236, "pcs", "pcs");
assert.strictEqual(roundedRealShortage.short, true, "Kekurangan riil di luar toleransi pembulatan PCS harus tetap menjadi blocker");

function predecessorBatch(id, qty, finishTime, transferBatchNumber) {
  return {
    id,
    plan: { planNumber: "MPP-202608-001" },
    lineNumber: 10,
    mbomProcessId: "ROUTE-WELD-10",
    deliveryPhaseId: "PHASE-1",
    deliveryPhaseNumber: 1,
    transferBatchNumber,
    routingMode: "INHOUSE",
    scheduleDate: "2026-08-10",
    plannedEndTime: finishTime,
    plannedQty: qty,
    uomCode: "PCS",
    mbomProcess: { process: { processCode: "WELD" } },
  };
}

const successorStart = new Date("2026-08-10T10:00:00.000Z");
const split292 = groupPredecessorAllocations([
  predecessorBatch("PRED-146-A", 146, "08:00", 1),
  predecessorBatch("PRED-146-B", 146, "09:00", 2),
], successorStart);
assert.strictEqual(split292.length, 1, "Split transfer batch pada route/line/phase yang sama harus menjadi satu logical predecessor");
assert.strictEqual(split292[0].availableOutputQty, 292, "Output split 146 + 146 harus dijumlahkan menjadi WIP siap 292");
assert.strictEqual(predecessorQuantityStatus(split292[0].availableOutputQty, 292, 292, 292, "PCS", "PCS").short, false, "146 + 146 harus memenuhi successor 292 tanpa false-positive blocker");

const split300 = groupPredecessorAllocations([
  predecessorBatch("PRED-150-A", 150, "08:15", 1),
  predecessorBatch("PRED-150-B", 150, "09:15", 2),
], successorStart);
assert.strictEqual(split300[0].availableOutputQty, 300, "Output split 150 + 150 harus dijumlahkan menjadi WIP siap 300");
assert.strictEqual(predecessorQuantityStatus(split300[0].availableOutputQty, 300, 300, 300, "PCS", "PCS").short, false, "150 + 150 harus memenuhi successor 300 tanpa false-positive blocker");

const futureSplit = groupPredecessorAllocations([
  predecessorBatch("PRED-146-READY", 146, "09:00", 1),
  predecessorBatch("PRED-146-LATE", 146, "11:00", 2),
], successorStart)[0];
assert.deepStrictEqual([futureSplit.availableOutputQty, futureSplit.lateOutputQty, futureSplit.lateBatchCount], [146, 146, 1], "Batch yang selesai setelah successor mulai tidak boleh dihitung sebagai WIP siap");
assert.strictEqual(predecessorQuantityStatus(futureSplit.availableOutputQty, 292, 292, 292, "PCS", "PCS").short, true, "Split yang belum selesai harus tetap memblokir successor");
assert.strictEqual(predecessorGroupReadiness(futureSplit, 292, 292, 292, "PCS").status, "TIMING_BLOCKED", "Jika total linked output cukup tetapi belum selesai, validator harus menghasilkan blocker waktu saja");

const insufficientSplit = groupPredecessorAllocations([
  predecessorBatch("PRED-140-A", 140, "08:00", 1),
  predecessorBatch("PRED-140-B", 140, "09:00", 2),
], successorStart)[0];
assert.strictEqual(insufficientSplit.availableOutputQty, 280, "Semua split selesai tetap harus memakai total output aktual");
assert.strictEqual(predecessorQuantityStatus(insufficientSplit.availableOutputQty, 292, 292, 292, "PCS", "PCS").short, true, "Kekurangan riil 280 terhadap kebutuhan 292 harus tetap menjadi blocker");
assert.strictEqual(predecessorGroupReadiness(insufficientSplit, 292, 292, 292, "PCS").status, "QTY_BLOCKED", "Kekurangan riil harus menghasilkan blocker quantity, bukan timing");

const irrelevantFutureSplit = groupPredecessorAllocations([
  predecessorBatch("PRED-300-READY", 300, "09:00", 1),
  predecessorBatch("PRED-100-EXTRA", 100, "11:00", 2),
], successorStart)[0];
assert.strictEqual(predecessorGroupReadiness(irrelevantFutureSplit, 400, 300, 400, "PCS").status, "READY", "Future split yang tidak dibutuhkan karena WIP siap sudah mencukupi tidak boleh membuat blocker");

const sharedWipState = new Map();
const sharedPredecessors = [
  predecessorBatch("PRED-SHARED-A", 60, "08:00", 1),
  predecessorBatch("PRED-SHARED-B", 40, "09:00", 2),
];
const firstSharedGroup = groupPredecessorAllocations(sharedPredecessors, successorStart, sharedWipState)[0];
const firstSharedReservation = reservePredecessorGroupOutput(
  firstSharedGroup,
  60,
  { id: "SUCCESSOR-A", startAt: successorStart },
  sharedWipState,
);
assert.deepStrictEqual(
  [firstSharedReservation.reservedQty, sharedWipState.get("PRED-SHARED-A").remainingOutputQty, sharedWipState.get("PRED-SHARED-B").remainingOutputQty],
  [60, 0, 40],
  "Successor pertama harus mengonsumsi batch fisik secara deterministic berdasarkan finish time dan allocation id",
);

const secondSharedStart = new Date("2026-08-10T11:00:00.000Z");
const secondSharedGroup = groupPredecessorAllocations(sharedPredecessors, secondSharedStart, sharedWipState)[0];
assert.deepStrictEqual(
  [secondSharedGroup.grossLinkedOutputQty, secondSharedGroup.reservedOutputQty, secondSharedGroup.availableOutputQty],
  [100, 60, 40],
  "Successor kedua hanya boleh melihat sisa WIP; output yang telah direservasi tidak boleh dihitung ulang",
);
assert.strictEqual(
  predecessorGroupReadiness(secondSharedGroup, 100, 60, 100, "PCS").status,
  "QTY_BLOCKED",
  "Dua successor tidak boleh sama-sama lulus dengan memakai predecessor output yang sama",
);
const independentlyLinkedBatch = groupPredecessorAllocations(
  [sharedPredecessors[1]],
  secondSharedStart,
  sharedWipState,
)[0];
assert.strictEqual(independentlyLinkedBatch.availableOutputQty, 40, "Reservasi batch A tidak boleh mengurangi source batch B yang berbeda");
const secondSharedReservation = reservePredecessorGroupOutput(
  secondSharedGroup,
  60,
  { id: "SUCCESSOR-B", startAt: secondSharedStart },
  sharedWipState,
);
assert.deepStrictEqual(
  [secondSharedReservation.reservedQty, secondSharedReservation.unreservedQty],
  [40, 20],
  "Successor yang kekurangan tetap mereservasi WIP tersisa agar successor berikutnya tidak dapat memakainya kembali",
);

const partialWipState = new Map();
const partialPredecessors = [
  predecessorBatch("PRED-PARTIAL-A", 70, "08:00", 1),
  predecessorBatch("PRED-PARTIAL-B", 50, "09:00", 2),
];
const partialFirstGroup = groupPredecessorAllocations(partialPredecessors, successorStart, partialWipState)[0];
reservePredecessorGroupOutput(partialFirstGroup, 80, { id: "SUCCESSOR-PARTIAL-A", startAt: successorStart }, partialWipState);
const partialSecondGroup = groupPredecessorAllocations(partialPredecessors, secondSharedStart, partialWipState)[0];
assert.deepStrictEqual(
  [partialWipState.get("PRED-PARTIAL-A").remainingOutputQty, partialWipState.get("PRED-PARTIAL-B").remainingOutputQty, partialSecondGroup.availableOutputQty],
  [0, 40, 40],
  "Reservasi lintas split batch harus menyimpan sisa parsial pada source batch yang benar",
);

const timingWipState = new Map();
const timingPredecessors = [
  predecessorBatch("PRED-TIMING-READY", 60, "09:00", 1),
  predecessorBatch("PRED-TIMING-LATE", 40, "12:00", 2),
];
const timingGroup = groupPredecessorAllocations(timingPredecessors, successorStart, timingWipState)[0];
assert.strictEqual(predecessorGroupReadiness(timingGroup, 100, 100, 100, "PCS").status, "TIMING_BLOCKED", "WIP belum selesai harus tetap menghasilkan akar masalah timing sebelum direservasi");
const timingReservation = reservePredecessorGroupOutput(timingGroup, 100, { id: "SUCCESSOR-TIMING", startAt: successorStart }, timingWipState);
assert.deepStrictEqual([timingReservation.readyReservedQty, timingReservation.lateReservedQty], [60, 40], "Reservasi harus mempertahankan pemisahan output ready dan late untuk blocker timing tunggal");
const afterTimingGroup = groupPredecessorAllocations(timingPredecessors, new Date("2026-08-10T13:00:00.000Z"), timingWipState)[0];
assert.strictEqual(predecessorGroupReadiness(afterTimingGroup, 100, 10, 100, "PCS").status, "QTY_BLOCKED", "WIP late yang sudah direservasi successor sebelumnya tidak boleh tersedia kembali setelah finish time");

const sameStartAllocations = [
  { id: "SUCCESSOR-Z", scheduleDate: "2026-08-10", plannedStartTime: "10:00", routingMode: "INHOUSE" },
  { id: "SUCCESSOR-A", scheduleDate: "2026-08-10", plannedStartTime: "10:00", routingMode: "INHOUSE" },
];
assert.deepStrictEqual(sameStartAllocations.sort(compareAllocationConsumptionOrder).map((item) => item.id), ["SUCCESSOR-A", "SUCCESSOR-Z"], "Successor dengan waktu mulai sama harus memakai allocation id sebagai tie-break deterministic");

const duplicateLinkGroup = groupPredecessorAllocations([sharedPredecessors[0], sharedPredecessors[0]], successorStart)[0];
assert.strictEqual(duplicateLinkGroup.linkedOutputQty, 60, "ID predecessor yang terduplikasi dalam dependency list hanya boleh dihitung satu kali");

const bufferJobs = phaseJobs(
  { periodEnd: new Date("2026-08-31T00:00:00.000Z") },
  [{ id: "receipt-1", mpsDetailId: "mps-detail-1", partCode: "FG-001", uomCode: "pcs", qtyPlanned: 430, actualSalesOrderQty: 300, forecastQty: 300, effectiveDemandQty: 450, bufferQty: 150, requiredDate: new Date("2026-08-31T00:00:00.000Z"), notes: "" }],
  [{ id: "phase-1", mpsDetailId: "mps-detail-1", phaseNumber: 1, plannedDate: new Date("2026-08-30T00:00:00.000Z"), qtyPlanned: 300, targetType: "CUSTOMER", targetCode: "C001", sourceType: "SALES_ORDER", sourceNumber: "SO-001" }],
  { finishedGoodStockBalances: [{ id: "stock-1", partCode: "FG-001", uomCode: "pcs", warehouseCode: "FG", rackCode: "R01", lotNumber: "LOT-001", qtyOnHand: 20, qtyReserved: 20, qtyQC: 0, qtyAvailable: 0, lastMovement: new Date("2026-07-31T00:00:00.000Z"), stockReservations: [{ id: "reservation-1", reservationNumber: "RSV-001", reservationDate: new Date("2026-07-31T00:00:00.000Z"), qtyReserved: 20, qtyReleased: 0, referenceType: "SO", referenceNumber: "SO-001#1", status: "Active" }] }] },
);
assert.deepStrictEqual(bufferJobs.map((job) => [job.targetType, job.qty, job.stockCoverageQty || 0, job.configurationError || null]), [["CUSTOMER", 280, 20, null], ["INTERNAL_STOCK", 150, 0, null]], "Priority 1 harus mengonsumsi stock FG lebih dulu, sedangkan buffer tetap diproduksi setelah demand customer");
assert.deepStrictEqual(bufferJobs[0].stockCoverageHistory.map((line) => [line.warehouseCode, line.rackCode, line.lotNumber, line.usedQty, line.coverageSource, line.reservationNumber]), [["FG", "R01", "LOT-001", 20, "RESERVED_TO_DEMAND", "RSV-001"]], "Audit priority demand harus menyimpan asal warehouse, rack, lot, reservation SO, dan qty stock yang dipakai");

const continuousCampaign = combineSingleDeliveryBufferCampaigns(bufferJobs);
assert.strictEqual(continuousCampaign.length, 1, "Satu delivery customer dan buffer dengan FG due yang sama harus menjadi satu production campaign");
assert.strictEqual(continuousCampaign[0].qty, 430, "Campaign harus memproduksi total 280 customer + 150 buffer tanpa memecah eksekusi route");
assert.deepStrictEqual(continuousCampaign[0].campaignSegments.map((segment) => [segment.targetType, segment.productionQty, segment.stockCoverageQty]), [["CUSTOMER", 280, 20], ["INTERNAL_STOCK", 150, 0]], "Pegging customer dan buffer harus tetap terpisah walaupun eksekusi mesin dikonsolidasikan");

const priorityRoutePhase1 = priorityNetBatchQuantity(280, 0, 341, 430, "pcs");
const priorityRouteBuffer = priorityNetBatchQuantity(150, 280, 341, 430, "pcs");
assert.deepStrictEqual([priorityRoutePhase1, priorityRouteBuffer], [280, 61], "Route net requirement harus diberikan ke priority demand dahulu, bukan dibagi proporsional dengan route factor");
const priorityShift1 = priorityNetBatchQuantity(150, 0, 341, 430, "pcs");
const priorityShift2 = priorityNetBatchQuantity(130, 150, 341, 430, "pcs");
assert.deepStrictEqual([priorityShift1, priorityShift2], [150, 130], "Sisa priority demand harus pindah ke batch/shift berikutnya sebelum buffer memakai sisa kebutuhan route");

const fitFirst = fitFirstBatchStrategies(400, [100, 100, 100, 100]);
assert.deepStrictEqual(fitFirst, [[400], [100, 100, 100, 100]], "Auto allocation harus mencoba qty 400 sebagai satu blok sebelum memakai split kapasitas");

const strongCandidate = scorePlacementCandidate({
  candidate: { start: 60, end: 180, overtime: false },
  machineIntervals: [],
  window: { start: 0, end: 480 },
  earliest: 60,
  due: 960,
  cycleMinutes: 1,
  bestCycleMinutes: 1,
  partCode: "FG-001",
  processCode: "PRESS",
});
assert.strictEqual(strongCandidate.model, SCORING_MODEL, "Hasil scoring harus menyimpan identitas model yang dapat diaudit");

const weakCandidate = scorePlacementCandidate({
  candidate: { start: 350, end: 470, overtime: true },
  machineIntervals: [{ start: 0, end: 300, partCode: "FG-OTHER", processCode: "WELD" }],
  window: { start: 0, end: 480 },
  earliest: 0,
  due: 480,
  cycleMinutes: 2,
  bestCycleMinutes: 1,
  partCode: "FG-001",
  processCode: "PRESS",
});
assert(strongCandidate.score > weakCandidate.score, "Mesin cepat, kosong, tanpa overtime, dan tanpa antre harus mendapat skor lebih tinggi");

const scoreTotal = Object.values(strongCandidate.breakdown).reduce((sum, weightedScore) => sum + weightedScore, 0);
assert(Math.abs(scoreTotal - strongCandidate.score) < 0.1, "Total breakdown scoring harus konsisten dengan recommendation score");

const vendorAllocation = {
  id: "VENDOR-PAINT",
  plan: { planNumber: "MPP-202609-001" },
  routingMode: "VENDOR",
  vendorSendDate: "2026-09-16",
  vendorReturnDate: "2026-09-21",
  plannedStartTime: "12:12",
  plannedEndTime: "12:12",
  latestFinishDate: "2026-09-29",
  fgRequiredDate: "2026-09-29",
};
const vendorSuccessor = {
  id: "INSP-PACK",
  plan: { planNumber: "MPP-202609-001" },
  routingMode: "INHOUSE",
  scheduleDate: "2026-09-21",
  plannedStartTime: "12:12",
  predecessorAllocationIds: [vendorAllocation.id],
  mbomProcess: { process: { processCode: "INSP-PACK" } },
};
const vendorDeadline = resolveVendorReturnDeadline(vendorAllocation, [vendorAllocation, vendorSuccessor]);
assert.strictEqual(vendorDeadline.source, "SUCCESSOR_START", "Vendor route harus dinilai terhadap start successor, bukan start seluruh production chain");
assert.strictEqual(vendorDeadline.deadline.toISOString(), "2026-09-21T12:12:00.000Z");
assert(allocationFinishMoment(vendorAllocation) <= vendorDeadline.deadline, "Return vendor tepat saat successor mulai harus valid");

const terminalVendorDeadline = resolveVendorReturnDeadline(vendorAllocation, [vendorAllocation]);
assert.strictEqual(terminalVendorDeadline.source, "ROUTE_LATEST_FINISH", "Vendor terminal harus memakai latest finish dari backward routing pass");
assert.strictEqual(terminalVendorDeadline.deadline.toISOString(), "2026-09-29T23:59:00.000Z");

const augustPainting = {
  plan: { planNumber: "MPP-202608-002", sourceType: "MPS:MPS-202609" },
  routingMode: "VENDOR",
  vendorReturnDate: "2026-09-02",
  plannedEndTime: "00:00",
};
const septemberSuccessor = {
  plan: { planNumber: "MPP-202609-001", sourceType: "MPS:MPS-202609" },
  routingMode: "INHOUSE",
  scheduleDate: "2026-09-02",
  plannedStartTime: "08:00",
};
assert.strictEqual(crossPlanPredecessorStatus(augustPainting, septemberSuccessor), "READY", "Vendor return bulan lalu sebelum successor harus valid");
assert.strictEqual(crossPlanPredecessorStatus(augustPainting, { ...septemberSuccessor, scheduleDate: "2026-09-01" }), "LATE", "Successor tidak boleh mulai sebelum vendor return bulan lalu");
assert.strictEqual(crossPlanPredecessorStatus(
  augustPainting,
  { ...septemberSuccessor, plan: { ...septemberSuccessor.plan, sourceType: "MPS:MPS-LAIN" } },
), "SOURCE_MISMATCH", "Cross-MPP predecessor wajib berasal dari source MPS yang sama");

console.log("Capacity predecessor, cumulative WIP reservation, vendor deadline, priority stock, allocation, buffer, fit-first, scoring, and cross-MPP checks passed: 39/39 cases");
