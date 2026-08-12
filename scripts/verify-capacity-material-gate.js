const assert = require("node:assert/strict");
const {
  materialGateForJob,
  resolveSuggestionMaterialGate,
  suggestionSystemMaterialDate,
} = require("../src/prisma/services/planning/materialReadinessService");

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

console.log("Capacity material gate contracts PASS (5/5)");
