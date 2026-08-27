"use strict";

const assert = require("assert");
const {
  createSessionState,
  stageChange,
  cancelSession,
  previewAllocations,
  validateCommit,
  editorScopeForPlanStatus,
  validateChangeForScope,
  buildRemainingAllocationData,
  distributeRemainingAllocation,
  validateInputAvailability,
  validateCutPasteTargetAvailability,
  calculateTemporalInputAvailability,
  calculateTemporalInputAvailabilityDetails,
  routeInputAvailability,
  isSessionPlanCurrent,
  openPersistentSession,
  stagePersistentChange,
  stageRecommendationChanges,
  cancelPersistentSession,
  undoPersistentChange,
} = require("../src/prisma/services/planning/capacityEditSessionService");

assert.strictEqual(editorScopeForPlanStatus("Draft"), "PLAN");
assert.strictEqual(editorScopeForPlanStatus("Confirmed"), "PLAN");
assert.strictEqual(editorScopeForPlanStatus("Released"), "REPLAN", "Released harus membuka residual replan, bukan mengubah Published history");
assert.strictEqual(editorScopeForPlanStatus("In Progress"), "REPLAN");
assert.doesNotThrow(() => validateChangeForScope("GLOBAL", { type: "MACHINE_DAY" }));
assert.throws(() => validateChangeForScope("GLOBAL", { type: "MOVE_ALLOCATION" }), /global calendar/i,
  "Global calendar hanya boleh mengubah kapasitas mesin, bukan allocation plan");

const official = [{ id: "a1", plannedQty: 100, scheduleDate: "2026-09-06", machineId: "m1", status: "Draft" }];
let session = createSessionState({ planId: "p1", planStatus: "Draft", baseVersion: "v1", allocations: official });
session = stageChange(session, {
  type: "MOVE_ALLOCATION",
  allocationId: "a1",
  qty: 40,
  targetDate: "2026-09-07",
  targetMachineId: "m2",
});

assert.deepStrictEqual(official, [{ id: "a1", plannedQty: 100, scheduleDate: "2026-09-06", machineId: "m1", status: "Draft" }],
  "stage tidak boleh memutasi official allocation");
const preview = previewAllocations(session);
assert.strictEqual(preview.length, 2, "partial move harus memisahkan remainder dan moved allocation");
assert.strictEqual(preview.find((row) => row.id === "a1").plannedQty, 60);
assert.strictEqual(preview.find((row) => row.id !== "a1").plannedQty, 40);
assert.strictEqual(preview.reduce((sum, row) => sum + row.plannedQty, 0), 100);

const remainingSession = stageChange(createSessionState({ planId: "p1", planStatus: "Draft", baseVersion: "v1", allocations: [] }), {
  type: "ALLOCATE_REMAINING",
  planNumber: "MPP-001",
  lineNumber: 12,
  mbomProcessId: "route-insp",
  partCode: "PART-A",
  processCode: "INSP-PACK-1",
  qty: 60,
  targetDate: "2026-09-01",
  routingMode: "INHOUSE",
  targetMachineId: "machine-1",
  shift: "1",
});
assert.deepStrictEqual(previewAllocations(remainingSession), [{
  id: remainingSession.changes[0].id,
  planNumber: "MPP-001",
  lineNumber: 12,
  mbomProcessId: "route-insp",
  partCode: "PART-A",
  processCode: "INSP-PACK-1",
  plannedQty: 60,
  scheduleDate: "2026-09-01",
  routingMode: "INHOUSE",
  machineId: "machine-1",
  vendorId: null,
  shift: "1",
  staged: true,
}], "Remain Allocation in-house harus muncul di preview tanpa memutasi plan resmi");

const planFixture = { id: "p1", periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-30T00:00:00.000Z") };
const lineFixture = { lineNumber: 12, partCode: "C002-C004-020", qtyPlanned: 100, uomCode: "PCS", fgRequiredDate: new Date("2026-09-10T00:00:00.000Z"), partId: "part-1" };
const routeFixture = { id: "route-insp", machineSpecificationCode: "INSP", mbomDetail: { partId: "part-1" } };
const inhouseDraft = buildRemainingAllocationData({
  plan: planFixture,
  line: lineFixture,
  route: routeFixture,
  allocatedQty: 40,
  machine: { id: "machine-1", status: "Active", machineSpecificationCode: "INSP" },
  value: { qty: 60, targetDate: "2026-09-01", routingMode: "INHOUSE", targetMachineId: "machine-1", shift: "1", reason: "Alokasi dari matrix" },
  actor: "ppic",
});
assert.strictEqual(inhouseDraft.data.plannedQty, 60);
assert.strictEqual(inhouseDraft.data.machineId, "machine-1");
assert.strictEqual(inhouseDraft.data.vendorId, null);
assert.strictEqual(inhouseDraft.remainingAfter, 0);

const vendorDraft = buildRemainingAllocationData({
  plan: planFixture,
  line: lineFixture,
  route: { ...routeFixture, id: "route-paint" },
  allocatedQty: 60,
  vendor: { id: "vendor-1", status: "Active", leadTimeDays: 2 },
  value: { qty: 40, targetDate: "2026-09-02", routingMode: "VENDOR", vendorId: "vendor-1", vendorReturnDate: "2026-09-04", reason: "Kirim painting" },
  actor: "ppic",
});
assert.strictEqual(vendorDraft.data.routingMode, "VENDOR");
assert.strictEqual(vendorDraft.data.shift, "VENDOR");
assert.strictEqual(vendorDraft.data.vendorId, "vendor-1");
assert.strictEqual(vendorDraft.data.machineId, null);
assert.strictEqual(vendorDraft.data.vendorReturnDate.toISOString().slice(0, 10), "2026-09-04");
assert.throws(() => buildRemainingAllocationData({
  plan: planFixture,
  line: lineFixture,
  route: { ...routeFixture, id: "route-paint" },
  allocatedQty: 0,
  vendor: { id: "vendor-1", status: "Active", leadTimeDays: 2 },
  value: { qty: 40, targetDate: "2026-09-19", routingMode: "VENDOR", vendorId: "vendor-1", vendorReturnDate: "2026-09-18" },
}), /Tanggal kirim\/allocation 2026-09-19.*tanggal kembali 2026-09-18/i,
"validasi vendor harus menyebut allocation date dan return date yang salah");
assert.throws(() => buildRemainingAllocationData({
  plan: planFixture,
  line: lineFixture,
  route: routeFixture,
  allocatedQty: 90,
  machine: { id: "machine-1", status: "Active", machineSpecificationCode: "INSP" },
  value: { qty: 20, targetDate: "2026-09-01", processCode: "INSP-PACK-2", routingMode: "INHOUSE", targetMachineId: "machine-1", shift: "1" },
}), /C002-C004-020.*INSP-PACK-2.*Line 12.*01 Sep 2026.*Diminta 20 PCS.*kebutuhan 100 PCS.*sudah dialokasikan 90 PCS.*sisa 10 PCS/i,
"error remaining harus menyebut part, proses, line, tanggal, requested, kebutuhan, allocated, dan sisa");

assert.deepStrictEqual(distributeRemainingAllocation([
  { lineNumber: 39, remainingQty: 22, requiredDate: "2026-08-25" },
  { lineNumber: 56, remainingQty: 60, requiredDate: "2026-08-25" },
  { lineNumber: 40, remainingQty: 20, requiredDate: "2026-08-28" },
  { lineNumber: 41, remainingQty: 80, requiredDate: "2026-09-01" },
  { lineNumber: 122, remainingQty: 40, requiredDate: "2026-09-08" },
], 191), [
  { lineNumber: 39, qty: 22 },
  { lineNumber: 56, qty: 60 },
  { lineNumber: 40, qty: 20 },
  { lineNumber: 41, qty: 80 },
  { lineNumber: 122, qty: 9 },
], "batch 191 harus di-pegging ke beberapa delivery line tanpa melebihi requirement masing-masing");
assert.throws(() => distributeRemainingAllocation([{ lineNumber: 1, remainingQty: 22 }], 23), /total remaining/i,
  "batch tidak boleh melampaui total kebutuhan route");
assert.doesNotThrow(() => validateInputAvailability({ requestedQty: 191, inputAvailableQty: 191, uomCode: "PCS" }));
assert.doesNotThrow(() => validateCutPasteTargetAvailability({ requestedQty: 31, inputAvailableQty: 35, uomCode: "PCS", targetPartCode: "C002-C004-010", processCode: "INSP-PACK-2", targetDate: "2026-09-09" }));
assert.throws(() => validateCutPasteTargetAvailability({ requestedQty: 31, inputAvailableQty: 20, uomCode: "PCS", targetPartCode: "C002-C004-010", processCode: "INSP-PACK-2", targetDate: "2026-09-09" }), (error) => {
  assert.strictEqual(error.statusCode, 409);
  assert.strictEqual(error.code, "CUT_PASTE_TARGET_STOCK_INSUFFICIENT");
  assert.match(error.message, /Available|tersedia 20 PCS/i);
  return true;
}, "Cut & Paste API harus menolak target ketika Available di Target tidak cukup");
const materialShortageWarning = validateInputAvailability({ requestedQty: 192, inputAvailableQty: 191, uomCode: "PCS" });
assert.deepStrictEqual({
  code: materialShortageWarning.code,
  severity: materialShortageWarning.severity,
  blocking: materialShortageWarning.blocking,
  shortageQty: materialShortageWarning.shortageQty,
}, {
  code: "MATERIAL_SHORTAGE_WARNING",
  severity: "WARNING",
  blocking: false,
  shortageQty: 1,
}, "planning harus menerima batch yang melampaui stock input sebagai material warning non-blocking");
const detailedMaterialWarning = validateInputAvailability({
  requestedQty: 31,
  inputAvailableQty: 0,
  uomCode: "PCS",
  targetPartCode: "C002-C004-010",
  processCode: "INSP-PACK-2",
  targetDate: "2026-09-04",
  inputSources: [{
    partNumber: "23062-1498C",
    partCode: "C002-C004-020",
    itemType: "WIP",
    stockWhQty: 0,
    receiptQty: 0,
    allocatedQty: 60,
    availableOutputQty: 0,
    qtyPerOutput: 1,
  }],
});
assert.ok(/C002-C004-010/.test(detailedMaterialWarning.message)
  && /INSP-PACK-2/.test(detailedMaterialWarning.message)
  && /C002-C004-020/.test(detailedMaterialWarning.message)
  && /Stock WH 0 PCS/.test(detailedMaterialWarning.message)
  && /sudah dialokasikan 60 PCS/.test(detailedMaterialWarning.message),
"material warning harus menyebut target dan input part yang menyebabkan available 0");
assert.strictEqual(calculateTemporalInputAvailability({
  targetDate: "2026-09-02",
  inputs: [{ partId: "paint-part", partCode: "C002-C004-020", qtyPerOutput: 1 }],
  stockByPart: new Map([["paint-part", 60]]),
  predecessorAllocations: [{ partId: "paint-part", plannedQty: 191, scheduleDate: "2026-09-01", vendorReturnDate: "2026-09-03", routingMode: "VENDOR" }],
  consumerAllocations: [{ plannedQty: 60, scheduleDate: "2026-09-01" }],
}), 0, "stok PAINT yang sudah dipakai INSPECTION tidak boleh tersedia lagi sebelum vendor return");
assert.strictEqual(calculateTemporalInputAvailability({
  targetDate: "2026-09-03",
  inputs: [{ partId: "paint-part", partCode: "C002-C004-020", qtyPerOutput: 1 }],
  stockByPart: new Map([["paint-part", 60]]),
  predecessorAllocations: [{ partId: "paint-part", plannedQty: 191, scheduleDate: "2026-09-01", vendorReturnDate: "2026-09-03", routingMode: "VENDOR" }],
  consumerAllocations: [{ plannedQty: 60, scheduleDate: "2026-09-01" }],
}), 191, "hasil PAINT vendor harus tersedia untuk INSPECTION mulai tanggal kembali");
assert.strictEqual(calculateTemporalInputAvailability({
  targetDate: new Date("2026-09-02T00:00:00.000Z"),
  inputs: [{ partId: "paint-part", partCode: "C002-C004-020", qtyPerOutput: 1 }],
  stockByPart: new Map([["paint-part", 60]]),
  predecessorAllocations: [{ partId: "paint-part", plannedQty: 191, scheduleDate: "2026-09-01", vendorReturnDate: "2026-09-03", routingMode: "VENDOR" }],
  consumerAllocations: [{ plannedQty: 60, scheduleDate: "2026-09-01" }],
}), 0, "perhitungan tanggal harus konsisten saat Prisma mengirim objek Date");
const groupedInputAvailability = calculateTemporalInputAvailabilityDetails({
  targetDate: "2026-09-19",
  inputs: [
    { partId: "pin", partNumber: "92043-1766", partCode: "C002-0007-000", itemType: "RAW", qtyPerOutput: 2 },
    { partId: "fg-1292", partNumber: "11058-1292", partCode: "C002-0006-000", itemType: "FG", sourceRole: "DIRECT_INPUT", inputGroupKey: "C002-0006-000", qtyPerOutput: 1 },
    { partId: "wip-1292", partNumber: "11058-1292", partCode: "C002-0006-010", itemType: "WIP", sourceRole: "PREVIOUS_WIP", inputGroupKey: "C002-0006-000", qtyPerOutput: 1 },
  ],
  stockByPart: new Map([["pin", 412], ["fg-1292", 0], ["wip-1292", 815]]),
  consumerAllocations: [{ plannedQty: 31, scheduleDate: "2026-09-13" }],
});
const groupedMaterialWarning = validateInputAvailability({
  requestedQty: 200,
  inputAvailableQty: groupedInputAvailability.availableQty,
  uomCode: "PCS",
  targetPartCode: "C002-C004-070",
  processCode: "WELD-1",
  targetDate: "2026-09-19",
  inputSources: groupedInputAvailability.sources,
});
assert.ok(/C002-0007-000/.test(groupedMaterialWarning.message) && !/C002-0006-000/.test(groupedMaterialWarning.message),
"warning harus menyebut PIN sebagai grup pembatas tanpa menuduh FG yang sudah ditutup terminal WIP");
assert.strictEqual(isSessionPlanCurrent({ basePlanUpdatedAt: new Date("2026-08-24T03:00:00Z") }, { updatedAt: new Date("2026-08-24T09:00:00Z") }), false,
  "session lama tidak boleh digunakan setelah MPP diregenerasi");
assert.strictEqual(isSessionPlanCurrent({ basePlanUpdatedAt: new Date("2026-08-24T09:00:00Z") }, { updatedAt: new Date("2026-08-24T09:00:00Z") }), true);

const cancelled = cancelSession(session);
assert.strictEqual(cancelled.status, "CANCELLED");
assert.deepStrictEqual(cancelled.allocations, official, "Cancel harus restore snapshot persis");

session = stageChange(createSessionState({ planId: "p1", planStatus: "Draft", baseVersion: "v1", allocations: official }), {
  type: "MOVE_ALLOCATION", allocationId: "a1", qty: 100, targetDate: "2026-09-01", force: true,
});
assert.throws(() => validateCommit(session, { currentVersion: "v1" }), /alasan/i,
  "Force Move wajib alasan");
session.changes[0].reason = "Customer menyetujui overlap proses";
assert.throws(() => validateCommit(session, { currentVersion: "v1" }), /approval/i,
  "Force Move wajib approval");
session.changes[0].approvalStatus = "APPROVED";
assert.doesNotThrow(() => validateCommit(session, { currentVersion: "v1" }));
assert.throws(() => validateCommit(session, { currentVersion: "v2" }), /berubah/i,
  "optimistic lock harus menolak plan yang berubah");

(async () => {
  const replacementCalls = { count: 0, create: 0, update: null };
  const replacementClient = {
    capacityEditSession: {
      findFirst: async () => ({
        id: "session-replace",
        scope: "PLAN",
        status: "OPEN",
        basePlanUpdatedAt: new Date("2026-08-24T09:00:00Z"),
        plan: { updatedAt: new Date("2026-08-24T09:00:00Z") },
      }),
    },
    capacityEditChange: {
      findFirst: async () => ({ id: "change-draft-1", sessionId: "session-replace", sequence: 1 }),
      count: async () => { replacementCalls.count += 1; return 1; },
      create: async () => { replacementCalls.create += 1; return null; },
      update: async ({ where, data }) => { replacementCalls.update = { where, data }; return { id: where.id, ...data }; },
    },
  };
  const replacedDraft = await stagePersistentChange(replacementClient, {
    sessionId: "session-replace",
    actor: "ppic",
    change: {
      type: "ALLOCATE_REMAINING",
      replaceChangeId: "change-draft-1",
      qty: 40,
      targetDate: "2026-09-19",
      vendorReturnDate: "2026-09-21",
      reason: "Koreksi tanggal kembali vendor",
    },
  });
  assert.strictEqual(replacedDraft.id, "change-draft-1", "edit draft harus mempertahankan identity staged change");
  assert.strictEqual(replacementCalls.create, 0, "edit draft tidak boleh menambah staged change kedua");
  assert.strictEqual(replacementCalls.count, 0, "sequence baru tidak diperlukan ketika mengganti draft");
  assert.strictEqual(replacementCalls.update.data.afterValue.vendorReturnDate, "2026-09-21");
  assert.strictEqual(replacementCalls.update.data.afterValue.replaceChangeId, undefined,
    "metadata replacement tidak boleh ikut menjadi payload allocation resmi");

  let gapSequence = null;
  const gapClient = {
    capacityEditSession: {
      findFirst: async () => ({
        id: "session-gap",
        scope: "PLAN",
        status: "OPEN",
        basePlanUpdatedAt: new Date("2026-08-24T09:00:00Z"),
        plan: { updatedAt: new Date("2026-08-24T09:00:00Z") },
      }),
    },
    capacityEditChange: {
      findFirst: async () => ({ id: "change-3", sessionId: "session-gap", sequence: 3 }),
      create: async ({ data }) => { gapSequence = data.sequence; return { id: "change-4", ...data }; },
    },
  };
  await stagePersistentChange(gapClient, {
    sessionId: "session-gap",
    actor: "ppic",
    change: { type: "ALLOCATE_REMAINING", qty: 40, targetDate: "2026-09-19" },
  });
  assert.strictEqual(gapSequence, 4,
    "sequence baru harus memakai max + 1, bukan count + 1, karena draft yang dihapus dapat meninggalkan gap");

  const terminalWipStock = new Map([
    ["C002-0006-000", 0],
    ["C002-0006-010", 815],
  ]);
  const inputAvailabilityClient = {
    mBOMHeader: {
      findMany: async () => [{
        partId: "fg-11058-1292",
        revision: 1,
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
        details: [{
          qty: 1,
          parentDetailId: null,
          part: {
            id: "wip-11058-1292-be",
            partNumber: "11058-1292",
            partCode: "C002-0006-010",
            partName: "BRACKET",
            itemType: "WIP",
          },
        }],
      }],
    },
    stockBalance: {
      groupBy: async ({ where }) => (where.partCode.in || [])
        .filter((partCode) => terminalWipStock.has(partCode))
        .map((partCode) => ({ partCode, _sum: { qtyAvailable: terminalWipStock.get(partCode) } })),
    },
    productionPlanAllocation: {
      findMany: async ({ where }) => where.mbomProcessId
        ? [{ plannedQty: 31, scheduleDate: new Date("2026-09-13T00:00:00.000Z") }]
        : [],
    },
  };
  const terminalWipAvailability = await routeInputAvailability(inputAvailabilityClient, {
    id: "route-c002-c004-070-weld-1",
    mbomDetail: {
      children: [{
        qty: 1,
        part: {
          id: "fg-11058-1292",
          partNumber: "11058-1292",
          partCode: "C002-0006-000",
          partName: "BRACKET",
          itemType: "FG",
        },
      }],
    },
  }, new Date("2026-09-19T00:00:00.000Z"));
  assert.strictEqual(terminalWipAvailability.availableQty, 784,
    "terminal WIP C002-0006-010 harus menjadi stock ekuivalen FG C002-0006-000 sebelum dikurangi allocation 31 PCS");
  assert.deepStrictEqual(terminalWipAvailability.sources.map((source) => ({
    partCode: source.partCode,
    sourceRole: source.sourceRole,
  })), [
    { partCode: "C002-0006-000", sourceRole: "DIRECT_INPUT" },
    { partCode: "C002-0006-010", sourceRole: "PREVIOUS_WIP" },
  ], "audit stock harus menunjukkan FG langsung dan terminal WIP yang mewakilinya");

  const plan = { id: "plan-1", planNumber: "MPP-001", status: "Draft", updatedAt: new Date("2026-08-24T09:00:00Z") };
  const staleSession = { id: "session-stale", planId: plan.id, scope: "PLAN", status: "OPEN", basePlanUpdatedAt: new Date("2026-08-24T03:00:00Z") };
  const calls = { cancelled: null, created: null };
  const client = {
    monthlyProductionPlan: { findFirst: async () => plan },
    productionPlanAllocation: { findMany: async () => [] },
    capacityEditSession: {
      findFirst: async () => staleSession,
      update: async ({ where, data }) => { calls.cancelled = { where, data }; return { ...staleSession, ...data }; },
      create: async ({ data }) => { calls.created = data; return { id: "session-fresh", ...data }; },
    },
  };
  const reopened = await openPersistentSession(client, { planNumber: plan.planNumber, actor: "admin", scope: "PLAN" });
  assert.strictEqual(calls.cancelled.where.id, "session-stale", "session stale harus ditutup sebelum editor baru dibuka");
  assert.strictEqual(calls.cancelled.data.status, "CANCELLED");
  assert.strictEqual(reopened.id, "session-fresh", "editor harus memakai snapshot plan terbaru");
  assert.strictEqual(calls.created.basePlanUpdatedAt.toISOString(), plan.updatedAt.toISOString());

  const stagedRows = [];
  const recommendationClient = {
    capacityEditSession: {
      findFirst: async () => ({
        id: "session-recommendation",
        scope: "PLAN",
        status: "OPEN",
        basePlanUpdatedAt: plan.updatedAt,
        plan: { updatedAt: plan.updatedAt },
      }),
    },
    capacityEditChange: {
      findFirst: async () => stagedRows.length ? stagedRows[stagedRows.length - 1] : null,
      create: async ({ data }) => {
        const row = { id: `change-${stagedRows.length + 1}`, ...data };
        stagedRows.push(row);
        return row;
      },
    },
  };
  const stagedRecommendation = await stageRecommendationChanges(
    recommendationClient,
    {
      sessionId: "session-recommendation",
      actor: "ppic",
      changes: [
        {
          type: "MOVE_ALLOCATION",
          allocationId: "allocation-1",
          qty: 40,
          targetDate: "2026-09-08",
          targetMachineId: "machine-2",
        },
        {
          type: "ALLOCATE_REMAINING",
          planNumber: "MPP-001",
          lineNumber: 12,
          mbomProcessId: "route-insp",
          qty: 60,
          targetDate: "2026-09-09",
          targetMachineId: "machine-1",
        },
      ],
    },
  );
  assert.deepStrictEqual(
    stagedRecommendation.map((row) => row.changeType),
    ["MOVE_ALLOCATION", "ALLOCATE_REMAINING"],
  );
  assert.strictEqual(
    stagedRecommendation.every(
      (row) => row.afterValue.recommendationSource === true,
    ),
    true,
    "recommendation stages must remain auditable inside Capacity Editor",
  );

  const rollbackCalls = { itemIds: [], scenarioStatuses: [], sessionStatus: null, deleted: null };
  const recommendationChanges = [
    { id: "change-rec-1", sequence: 1, afterValue: { recommendationScenarioId: "scenario-1", recommendationItemId: "item-1" } },
    { id: "change-manual", sequence: 2, afterValue: { type: "MOVE_ALLOCATION" } },
  ];
  const rollbackClient = {
    $transaction: async (handler) => handler(rollbackClient),
    capacityEditSession: {
      findFirst: async () => ({ id: "session-rollback", status: "OPEN", changes: recommendationChanges }),
      update: async ({ data }) => { rollbackCalls.sessionStatus = data.status; return { id: "session-rollback", ...data }; },
    },
    capacityEditChange: {
      findFirst: async () => recommendationChanges[0],
      delete: async ({ where }) => { rollbackCalls.deleted = where.id; return recommendationChanges[0]; },
    },
    monthlyPlanRecommendationItem: {
      updateMany: async ({ where, data }) => { rollbackCalls.itemIds.push(...where.id.in); return { count: data.applyStatus === "PENDING" ? where.id.in.length : 0 }; },
    },
    monthlyPlanRecommendationScenario: {
      findUnique: async () => ({ id: "scenario-1", status: "PARTIALLY_APPLIED", summary: { materialQueueQty: 12 } }),
      update: async ({ data }) => { rollbackCalls.scenarioStatuses.push(data.status); return data; },
    },
  };
  await cancelPersistentSession(rollbackClient, { sessionId: "session-rollback", actor: "ppic" });
  assert.deepStrictEqual(rollbackCalls.itemIds, ["item-1"], "Cancel must return recommendation items to PENDING");
  assert.deepStrictEqual(rollbackCalls.scenarioStatuses, ["MATERIAL_QUEUE"]);
  assert.strictEqual(rollbackCalls.sessionStatus, "CANCELLED");

  rollbackCalls.itemIds = [];
  rollbackCalls.scenarioStatuses = [];
  await undoPersistentChange(rollbackClient, "session-rollback");
  assert.deepStrictEqual(rollbackCalls.itemIds, ["item-1"], "Undo must return its recommendation item to PENDING");
  assert.strictEqual(rollbackCalls.deleted, "change-rec-1");
  console.log("Capacity edit session contract passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
