const assert = require("node:assert/strict");
const materialReadinessService = require("../src/prisma/services/planning/materialReadinessService");
const {
  materialGateForJob,
  resolveSuggestionMaterialGate,
  suggestionSystemMaterialDate,
} = materialReadinessService;

assert.equal(typeof materialReadinessService.planningMaterialDisposition, "function",
  "material readiness planning harus memiliki kebijakan warning non-blocking");
const planningWarning = materialReadinessService.planningMaterialDisposition({
  ready: false,
  issues: [{ code: "SUPPLIER_DATE_MISSING", severity: "BLOCKING", partCode: "MI-M06-N01" }],
});
assert.equal(planningWarning.allowed, true, "material shortage tidak boleh memblokir MPP release");
assert.deepEqual(planningWarning.warnings.map((warning) => ({ code: warning.code, severity: warning.severity })), [
  { code: "MATERIAL_NOT_READY", severity: "WARNING" },
]);

const utc = (value) => new Date(`${value}T00:00:00.000Z`);

const fallback = resolveSuggestionMaterialGate({
  netRequirement: 10,
  materialRequiredDate: utc("2026-08-15"),
  confirmationStatus: "Not Confirmed",
  supplierAllocations: [],
});
assert.equal(fallback.source, "PURCHASE_SUGGESTION_SYSTEM_DUE");
assert.equal(fallback.readyDate.toISOString().slice(0, 10), "2026-08-15");
assert.equal(fallback.confirmed, false);

const confirmed = resolveSuggestionMaterialGate({
  netRequirement: 10,
  materialRequiredDate: utc("2026-08-15"),
  supplierAllocations: [
    { status: "Confirmed", confirmationStatus: "Available", confirmedQty: 4, deliveryDate: utc("2026-08-12"), supplierCode: "S001" },
    { status: "Confirmed", confirmationStatus: "Confirmed", confirmedQty: 6, deliveryDate: utc("2026-08-14"), supplierCode: "S002" },
  ],
});
assert.equal(confirmed.source, "SUPPLIER_CONFIRMED_DELIVERY");
assert.equal(confirmed.readyDate.toISOString().slice(0, 10), "2026-08-14");
assert.equal(confirmed.confirmed, true);

const partial = resolveSuggestionMaterialGate({
  netRequirement: 10,
  materialRequiredDate: utc("2026-08-15"),
  supplierAllocations: [
    { status: "Confirmed", confirmationStatus: "Available", confirmedQty: 4, deliveryDate: utc("2026-08-18"), supplierCode: "S001" },
  ],
});
assert.equal(partial.source, "PARTIAL_CONFIRMATION_SYSTEM_DUE_FALLBACK");
assert.equal(partial.readyDate.toISOString().slice(0, 10), "2026-08-18");
assert.equal(partial.confirmed, false);

const selected = materialGateForJob({
  source: "OVERALL",
  phaseGates: {
    "delivery-1": { source: "PHASE", readyDate: utc("2026-08-13") },
  },
}, { sourceDeliveryTargetId: "delivery-1" });
assert.equal(selected.source, "PHASE");
assert.equal(selected.matchStatus, "PHASE_MATCHED");

const stockCoveredPhase = materialGateForJob({
  planNumber: "PP-001",
  mpsNumber: "MPS-001",
  source: "PURCHASE_SUGGESTION_SYSTEM_DUE",
  readyDate: utc("2026-09-29"),
  phaseGates: {
    "delivery-later": { source: "PHASE", readyDate: utc("2026-09-29") },
  },
}, { sourceDeliveryTargetId: "delivery-stock-covered" });
assert.equal(stockCoveredPhase.source, "NO_PHASE_PURCHASE_REQUIREMENT",
  "phase yang tidak menghasilkan net purchase tidak boleh mewarisi gate global phase lain");
assert.equal(stockCoveredPhase.readyDate, null);
assert.equal(stockCoveredPhase.confirmed, true);
assert.equal(stockCoveredPhase.matchStatus, "PHASE_NOT_IN_PURCHASE_REQUIREMENT");

const bufferGate = materialGateForJob({
  source: "OVERALL",
  readyDate: utc("2026-09-29"),
  phaseGates: { "delivery-1": { source: "PHASE" } },
}, { isBufferStock: true });
assert.equal(bufferGate.source, "OVERALL", "buffer tanpa delivery target tetap memakai gate agregat");
assert.equal(bufferGate.matchStatus, "OVERALL_FALLBACK");

const scopedBufferGate = materialGateForJob({
  planNumber: "PP-001",
  mpsNumber: "MPS-001",
  mrpRunNumber: "MRP-001",
  suggestionNumber: "PS-001",
  source: "OVERALL",
  readyDate: utc("2026-09-29"),
  phaseGates: {
    "delivery-fg-a": { source: "PHASE", readyDate: utc("2026-09-29") },
    "delivery-fg-b": { source: "PHASE", readyDate: utc("2026-08-19") },
  },
  items: [
    {
      suggestionItemId: "item-fg-a", partCode: "FG-A-PART", materialCode: "MAT-A",
      deliveryTargetIds: ["delivery-fg-a"], readyDate: utc("2026-09-29"),
      source: "PURCHASE_SUGGESTION_SYSTEM_DUE", confirmed: false,
    },
    {
      suggestionItemId: "item-fg-b", partCode: "FG-B-PART", materialCode: "MAT-B",
      deliveryTargetIds: ["delivery-fg-b"], readyDate: utc("2026-08-19"),
      source: "PURCHASE_SUGGESTION_SYSTEM_DUE", confirmed: false,
    },
  ],
}, { isBufferStock: true, materialScopeDeliveryTargetIds: ["delivery-fg-b", "delivery-fg-b-stock-covered"] });
assert.equal(scopedBufferGate.readyDate.toISOString().slice(0, 10), "2026-08-19",
  "buffer FG-B tidak boleh mewarisi material gate FG-A");
assert.equal(scopedBufferGate.itemCount, 1);
assert.equal(scopedBufferGate.criticalItems[0].materialCode, "MAT-B");
assert.equal(scopedBufferGate.matchStatus, "FG_TARGETS_MATCHED");

const stockCoveredBufferGate = materialGateForJob({
  planNumber: "PP-001",
  phaseGates: { "delivery-other-fg": { source: "PHASE", readyDate: utc("2026-09-29") } },
  items: [{
    suggestionItemId: "item-other-fg", deliveryTargetIds: ["delivery-other-fg"],
    readyDate: utc("2026-09-29"), source: "PURCHASE_SUGGESTION_SYSTEM_DUE", confirmed: false,
  }],
}, { isBufferStock: true, materialScopeDeliveryTargetIds: ["delivery-stock-covered"] });
assert.equal(stockCoveredBufferGate.source, "NO_FG_PURCHASE_REQUIREMENT");
assert.equal(stockCoveredBufferGate.readyDate, null);
assert.equal(stockCoveredBufferGate.confirmed, true);
assert.equal(stockCoveredBufferGate.matchStatus, "FG_TARGETS_NOT_IN_PURCHASE_REQUIREMENT");

const backwardDue = suggestionSystemMaterialDate({
  customerDeliveryDate: new Date("2026-08-31T07:00:00.000Z"),
  materialRequiredDate: new Date("2026-08-11T07:00:00.000Z"),
  sourceRequirements: [{ deliveryTargetId: "delivery-1" }],
  productionLeadTimeBreakdown: {
    productionLeadTimeDays: 13,
    inhouseScheduledDays: 8,
    vendorScheduledDays: 5,
    vendorLeadTimeDays: 5,
    inhouseProcessHours: 41.64,
    processPath: [{
      detailCode: "C002-C004-020", sequence: 10, processCode: "PAINT", mode: "VENDOR",
      vendorCode: "V-AUDIT-PAINT", vendorLeadTimeDays: 5, elapsedHours: 40, rawElapsedDays: 5, elapsedDays: 5,
    }],
  },
}, new Map([["delivery-1", {
  deliveryTargetId: "forecast-delivery-1",
  planningDecisionTargetId: "forecast-delivery-1",
  actualDeliveryTargetId: "delivery-1",
  constraintDetails: {
    capacityAssumption: { shiftsPerDay: 1, hoursPerShift: 8 },
    vendorProcessAdjustments: [{
      key: "C002-C004-020::SEQ-10::PAINT::V-AUDIT-PAINT::0",
      adjustedDurationHours: 24,
      reason: "Confirmed vendor three days",
    }],
  },
}]]));
assert.equal(backwardDue.toISOString(), "2026-08-14T07:00:00.000Z");

console.log("Capacity material gate contracts PASS");
