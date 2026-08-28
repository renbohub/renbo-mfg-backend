"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  deriveMpsDeliveryGate,
  normalizeDeliveryFeasibility,
  shouldRetireOfficialMrp,
  isPromotableCustomerDeliverySource,
  deliveryTargetIdsFromMps,
} = require("../src/prisma/services/planning/mpsDeliveryFeasibilityService");

const root = path.resolve(__dirname, "..");
const source = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function snapshot(overrides = {}) {
  return {
    deliveryTargetId: "DT-001",
    feasibilityStatus: "FEASIBLE",
    dispositionStatus: "NONE",
    sourceCurrent: true,
    acceptLateNewDate: null,
    acceptLateReason: null,
    decisionApprovedBy: null,
    decisionApprovedAt: null,
    ...overrides,
  };
}

assert.strictEqual(normalizeDeliveryFeasibility("NOT_FEASIBLE"), "INFEASIBLE");
assert.strictEqual(normalizeDeliveryFeasibility("LATE"), "INFEASIBLE");
assert.strictEqual(normalizeDeliveryFeasibility("FEASIBLE"), "FEASIBLE");
assert.strictEqual(normalizeDeliveryFeasibility("AT_RISK"), "AT_RISK");
assert.strictEqual(normalizeDeliveryFeasibility("NOT_SIMULATED"), "UNKNOWN");

assert.deepStrictEqual(deriveMpsDeliveryGate([]), {
  feasibilityStatus: "STALE",
  dispositionStatus: "NONE",
  officialGateStatus: "BLOCKED",
  blockerCount: 1,
  exceptionCount: 0,
  reason: "MPS belum memiliki snapshot feasibility delivery untuk revisi aktif.",
});

assert.strictEqual(deriveMpsDeliveryGate([snapshot()]).officialGateStatus, "READY_TO_RELEASE");
assert.deepStrictEqual(deriveMpsDeliveryGate([snapshot({ feasibilityStatus: "AT_RISK" })]), {
  feasibilityStatus: "AT_RISK",
  dispositionStatus: "NONE",
  officialGateStatus: "READY_TO_RELEASE",
  blockerCount: 0,
  exceptionCount: 0,
  reason: "1 delivery phase berisiko tetapi masih memenuhi tanggal delivery.",
});
assert.strictEqual(deriveMpsDeliveryGate([snapshot({ feasibilityStatus: "INFEASIBLE" })]).officialGateStatus, "BLOCKED");
assert.strictEqual(deriveMpsDeliveryGate([snapshot({
  feasibilityStatus: "INFEASIBLE",
  dispositionStatus: "RECOVERY_APPROVED",
})]).officialGateStatus, "BLOCKED", "Recovery approval is not proof of feasibility");
assert.strictEqual(deriveMpsDeliveryGate([snapshot({
  feasibilityStatus: "INFEASIBLE",
  dispositionStatus: "ACCEPT_LATE_APPROVED",
  acceptLateNewDate: "2026-09-12",
  acceptLateReason: "Customer menyetujui tanggal komitmen pengganti.",
  decisionApprovedBy: "ppic.approver",
  decisionApprovedAt: "2026-08-23T08:00:00.000Z",
})]).officialGateStatus, "APPROVED_WITH_EXCEPTION");
assert.strictEqual(deriveMpsDeliveryGate([snapshot({ sourceCurrent: false })]).feasibilityStatus, "STALE");
assert.strictEqual(deriveMpsDeliveryGate([snapshot({ sourceCurrent: false })]).officialGateStatus, "BLOCKED");
assert.strictEqual(shouldRetireOfficialMrp({ officialGateStatus: "BLOCKED" }), true);
assert.strictEqual(shouldRetireOfficialMrp({ officialGateStatus: "OFFICIAL" }), false);
assert.strictEqual(shouldRetireOfficialMrp({ officialGateStatus: "APPROVED_WITH_EXCEPTION" }), false);

const mixedDetail = {
  actualSalesOrderQty: 2500,
  calculationTrace: { efd: { source: "PO" } },
  demandSources: [
    { sourceType: "FORECAST", qty: 2000, deliveryTargetId: "forecast-target", sourcePegging: [{ deliveryTargetId: "forecast-target" }] },
    { sourceType: "SALES_ORDER", qty: 2500, deliveryTargetId: "so-target", sourcePegging: [{ deliveryTargetId: "so-target" }] },
  ],
};
assert.strictEqual(isPromotableCustomerDeliverySource(mixedDetail, mixedDetail.demandSources[0]), false, "Forecast tidak boleh menjadi delivery commitment ketika SO sudah ada");
assert.deepStrictEqual(deliveryTargetIdsFromMps({ details: [mixedDetail] }), ["so-target"], "Delivery gate harus mengikuti target SO saja");
const forecastFallbackDetail = {
  actualSalesOrderQty: 0,
  calculationTrace: { efd: { source: "FORECAST" } },
  demandSources: [{ sourceType: "FORECAST", qty: 2000, sourcePegging: [{ deliveryTargetId: "forecast-fallback" }] }],
};
assert.deepStrictEqual(deliveryTargetIdsFromMps({ details: [forecastFallbackDetail] }), ["forecast-fallback"], "Forecast tetap menjadi delivery fallback saat SO nol dan EFD Forecast dipilih");

const mpsController = source("src/prisma/controllers/planning/MPSController.js");
const mrpController = source("src/prisma/controllers/planning/MRPController.js");
const workbenchService = source("src/prisma/services/planning/mpsWorkbenchService.js");
const workbenchUi = source("../renbo-mfg-frontend/public/js/ppic-mps-workbench.js");

assert.match(mpsController, /assertMpsDeliveryApprovalAllowed/);
assert.match(mrpController, /assertOfficialMpsDeliveryGate/);
assert.match(mrpController, /deliveryGateSnapshot/);
assert.match(source("src/prisma/services/planning/mpsDeliveryFeasibilityService.js"), /scenarioStatus:\s*"SUPERSEDED"/);
assert.match(workbenchService, /deliveryGate/);
assert.match(workbenchUi, /deliveryGate/);
assert.doesNotMatch(workbenchUi, /mrp-simulation/);
assert.match(workbenchUi, /Hasil berstatus Simulated sampai PPIC melakukan Approve/);

console.log("MPS delivery feasibility gate contracts: OK");
