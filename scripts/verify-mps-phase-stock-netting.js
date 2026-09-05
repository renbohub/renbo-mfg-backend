"use strict";

const assert = require("assert");
const { buildLedger, attachPhaseNetting, demandPhases } = require("../src/prisma/services/planning/mpsWorkbenchService");

const deliveryDates = ["02", "04", "07", "09", "11", "14", "16", "18", "21", "23", "28"];
const detail = {
  id: "C003-0010-000",
  startDate: new Date("2026-09-01T00:00:00.000Z"),
  endDate: new Date("2026-09-30T00:00:00.000Z"),
  openingAvailableQty: 31797,
  firmScheduledReceiptQty: 0,
  targetEndingStockQty: 60000,
  projectedEndingStockQty: 60000,
  qtyPlanned: 138203,
  demandSources: deliveryDates.map((day, index) => ({
    id: `SO-2026-001:${index + 1}`,
    sourceType: "SALES_ORDER",
    sourceNumber: "SO-2026-001",
    customerCode: "C003",
    qty: 10000,
    targetDeliveryDate: new Date(`2026-09-${day}T00:00:00.000Z`),
    fgRequiredDate: new Date(`2026-09-${day}T00:00:00.000Z`),
  })),
};

const netting = buildLedger({
  detail,
  stockLines: [{ qtyOnHand: 31797, qtyAvailable: 31797, qtyReserved: 0, qtyQC: 0 }],
  reservations: [],
  receipts: [],
});
const phases = attachPhaseNetting(netting.phases, netting.ledger);

assert.deepEqual(phases.slice(0, 5).map((phase) => phase.plannedProductionQty), [0, 0, 0, 8203, 10000]);
assert.deepEqual(phases.slice(0, 5).map((phase) => phase.stockUsedQty), [10000, 10000, 10000, 1797, 0]);
assert.equal(phases.reduce((sum, phase) => sum + phase.stockUsedQty, 0), 31797);
assert.equal(phases.reduce((sum, phase) => sum + phase.plannedProductionQty, 0), 78203);
assert.equal(netting.ledger.find((row) => row.eventType === "BUFFER_TARGET").plannedProductionQty, 60000);
assert.equal(netting.metrics.plannedProductionUsedQty, 138203);
assert.equal(netting.metrics.projectedEndingQty, 60000);

const tiedFinishDates = demandPhases({
  id: "FIFO-TIE",
  endDate: new Date("2026-09-30T00:00:00.000Z"),
  demandSources: [{
    id: "SO-TIE",
    sourceType: "SALES_ORDER",
    sourceNumber: "SO-TIE",
    qty: 20,
    sourcePegging: [
      { deliveryTargetId: "LATE", qty: 10, targetDeliveryDate: "2026-09-20", fgFinishSplits: [{ qty: 10, targetFinishDate: "2026-09-01" }] },
      { deliveryTargetId: "EARLY", qty: 10, targetDeliveryDate: "2026-09-05", fgFinishSplits: [{ qty: 10, targetFinishDate: "2026-09-01" }] },
    ],
  }],
});
assert.deepEqual(tiedFinishDates.map((phase) => phase.deliveryTargetId), ["EARLY", "LATE"], "equal FG dates must net stock against the earliest customer delivery first");

console.log("MPS phase FIFO stock netting PASS");
