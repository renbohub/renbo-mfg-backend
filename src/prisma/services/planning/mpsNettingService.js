"use strict";
const { roundProductionAfterBuffer } = require("./mpsQuantityPolicy");

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value, digits = 6) => {
  const factor = 10 ** Math.max(0, Math.trunc(digits));
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
};

function timePhasedProductionFloor({ openingAvailableQty = 0, receipts = [], demands = [] } = {}) {
  const valid = (date) => date && Number.isFinite(new Date(date).getTime());
  const events = [
    ...receipts.filter((row) => valid(row.date)).map((row) => ({ date: new Date(row.date), qty: Math.max(number(row.qty), 0), receipt: true })),
    ...demands.filter((row) => valid(row.date)).map((row) => ({ date: new Date(row.date), qty: Math.max(number(row.qty), 0), receipt: false })),
  ].sort((a, b) => a.date - b.date || Number(b.receipt) - Number(a.receipt));
  let available = Math.max(number(openingAvailableQty), 0); let production = 0;
  for (const event of events) {
    available += event.receipt ? event.qty : -event.qty;
    if (available < 0) { production -= available; available = 0; }
  }
  return round(production);
}

function buildDatedMpsDemand({ targets = [], policyDemandQty = 0, productionPercent = 100, reservations = [], fallbackDate } = {}) {
  const reservedBySo = new Map();
  for (const row of reservations) {
    const key = String(row.referenceNumber || "").trim();
    reservedBySo.set(key, number(reservedBySo.get(key)) + Math.max(number(row.appliedQty), 0));
  }
  const sorted = [...targets].sort((a, b) => new Date(a.fgRequiredDate || a.targetDate) - new Date(b.fgRequiredDate || b.targetDate));
  const firm = sorted.filter((row) => row.sourceType === "SALES_ORDER");
  const events = firm.map((row) => {
    const demandQty = Math.max(number(row.qty), 0);
    const key = String(row.sourceNumber || "").trim();
    const reservedQty = Math.min(number(reservedBySo.get(key)), demandQty);
    reservedBySo.set(key, number(reservedBySo.get(key)) - reservedQty);
    return { date: row.fgRequiredDate || row.targetDate, qty: demandQty - reservedQty, demandQty, reservedQty, sourceNumber: row.sourceNumber, sourceType: row.sourceType };
  });
  // Firm commitments cannot be reduced by an EFD/production-percent override.
  let remaining = Math.max(number(policyDemandQty) - firm.reduce((sum, row) => sum + Math.max(number(row.qty), 0), 0), 0);
  for (const row of sorted.filter((target) => target.sourceType !== "SALES_ORDER")) {
    const qty = Math.min(Math.max(number(row.qty), 0), remaining);
    remaining -= qty;
    events.push({ date: row.fgRequiredDate || row.targetDate, qty: qty * Math.max(number(productionPercent), 0) / 100, sourceType: row.sourceType });
  }
  if (remaining > 0) events.push({ date: fallbackDate, qty: remaining * Math.max(number(productionPercent), 0) / 100, sourceType: "EFD_RESIDUAL" });
  return events;
}

function netMpsBucket(input = {}) {
  const openingAvailableQty = Math.max(number(input.openingAvailableQty), 0);
  const firmScheduledReceiptQty = Math.max(number(input.firmScheduledReceiptQty), 0);
  const grossDemandQty = Math.max(number(input.grossDemandQty), 0);
  const targetEndingStockQty = Math.max(number(input.targetEndingStockQty), 0);
  const productionPercent = Math.max(number(input.productionPercent ?? 100), 0);
  const actualSalesOrderQty = Math.max(number(input.actualSalesOrderQty), 0);
  const availableBeforeProduction = openingAvailableQty + firmScheduledReceiptQty;
  const netProductionBeforeOverride = Math.max(grossDemandQty + targetEndingStockQty - availableBeforeProduction, 0);
  const firmSalesOrderShortageQty = Math.max(actualSalesOrderQty - availableBeforeProduction, 0);
  const timePhasedMinimumQty = timePhasedProductionFloor({ openingAvailableQty: input.timePhasedOpeningAvailableQty ?? openingAvailableQty, receipts: input.receiptEvents, demands: input.demandEvents });
  const rawPlannedProductionQty = Math.max(netProductionBeforeOverride * productionPercent / 100, firmSalesOrderShortageQty, timePhasedMinimumQty);
  const rounding = roundProductionAfterBuffer(rawPlannedProductionQty, input.uomCode);
  const plannedProductionQty = rounding.roundedQty;
  const projectedEndingStockQty = Math.max(availableBeforeProduction + plannedProductionQty - grossDemandQty, 0);
  return {
    openingAvailableQty: round(openingAvailableQty), firmScheduledReceiptQty: round(firmScheduledReceiptQty),
    availableBeforeProduction: round(availableBeforeProduction), grossDemandQty: round(grossDemandQty),
    targetEndingStockQty: round(targetEndingStockQty), netProductionBeforeOverride: round(netProductionBeforeOverride),
    productionPercent: round(productionPercent), firmSalesOrderShortageQty: round(firmSalesOrderShortageQty),
    plannedProductionQty: round(plannedProductionQty), projectedEndingStockQty: round(projectedEndingStockQty), timePhasedMinimumQty,
    rawPlannedProductionQty: round(rawPlannedProductionQty), lotRoundingDeltaQty: rounding.roundingQty, productionRoundingMultiple: rounding.multiple,
  };
}

function allocateMpsProductionToPhases({ openingAvailableQty = 0, firmScheduledReceiptQty = 0, targetEndingStockQty = 0, plannedProductionQty = 0, phases = [] } = {}) {
  let available = Math.max(number(openingAvailableQty) + number(firmScheduledReceiptQty), 0);
  let remainingProduction = Math.max(number(plannedProductionQty), 0);
  const allocations = [];
  for (const phase of [...phases].sort((left, right) => new Date(left.requiredDate || left.plannedDate) - new Date(right.requiredDate || right.plannedDate))) {
    const demandQty = Math.max(number(phase.qty), 0);
    const productionQty = Math.min(Math.max(demandQty - available, 0), remainingProduction);
    available = Math.max(available + productionQty - demandQty, 0);
    remainingProduction = Math.max(remainingProduction - productionQty, 0);
    allocations.push({ ...phase, demandQty: round(demandQty), productionQty: round(productionQty), projectedAvailableAfter: round(available) });
  }
  const bufferProductionQty = Math.min(Math.max(number(targetEndingStockQty) - available, 0), remainingProduction);
  available += bufferProductionQty;
  remainingProduction = Math.max(remainingProduction - bufferProductionQty, 0);
  if (remainingProduction > 0) available += remainingProduction;
  return { phases: allocations, bufferProductionQty: round(bufferProductionQty + remainingProduction), projectedEndingStockQty: round(available) };
}

function buildMpsCalculationTrace({ month, partCode, policy, forecastQty, actualSalesOrderQty, bufferBaseQty, bufferPercent, openingFreeQty, peggedReservationQty, reservationRows = [], netting, sourceRows = [] } = {}) {
  return { version: 4, formulaVersion: "MPS_MONTHLY_INITIAL_1000_V2", rawPlannedProductionQty: netting.rawPlannedProductionQty, lotRoundingDeltaQty: netting.lotRoundingDeltaQty, productionRoundingMultiple: netting.productionRoundingMultiple, formula: "net produksi setelah buffer dan batas demand bertanggal; jumlah awal bulanan satuan utuh positif dibulatkan ke atas kelipatan 1000", month, partCode, policy, steps: [
    { order: 1, key: "FORECAST", label: "Forecast setelah consumption", formula: "sum(forecast delivery target - qty yang dikonsumsi SO)", value: round(forecastQty), sources: sourceRows.filter((row) => row.sourceType === "FORECAST") },
    { order: 2, key: "SALES_ORDER", label: "Firm Sales Order", formula: "sum(outstanding confirmed SO delivery target)", value: round(actualSalesOrderQty), sources: sourceRows.filter((row) => row.sourceType === "SALES_ORDER") },
    { order: 3, key: "GROSS_DEMAND", label: "Gross demand sesuai policy", formula: "sum(effective delivery target Forecast/SO setelah consumption)", value: netting.grossDemandQty },
    { order: 4, key: "OPENING_FREE_FG", label: "Free FG", formula: "bulan pertama: sum(stock balance qtyAvailable); bulan berikutnya: projected ending bulan sebelumnya", value: round(openingFreeQty), sources: [] },
    { order: 5, key: "PEGGED_SO_RESERVATION", label: "Reservasi FG untuk SO dalam bucket", formula: "sum(max(qtyReserved - qtyReleased, 0)) hanya bila referenceType=SO dan referenceNumber termasuk firm SO bucket", value: round(peggedReservationQty), sources: reservationRows },
    { order: 6, key: "OPENING_NETTABLE", label: "Opening FG yang boleh dinetting", formula: "free FG + pegged SO reservation", value: netting.openingAvailableQty },
    { order: 7, key: "FIRM_RECEIPT", label: "Firm scheduled receipt", formula: "sum(max(MO qtyPlanned - qtyGood/qtyProduced - qtyReject, 0)) due pada bucket", value: netting.firmScheduledReceiptQty },
    {
      order: 8, key: "BUFFER_TARGET", label: "Target ending stock",
      formula: "round(bufferBaseQty * bufferPercent / 100, 6)", value: netting.targetEndingStockQty,
      inputs: { bufferBaseQty: round(bufferBaseQty), bufferPercent: round(bufferPercent) },
    },
    {
      order: 9, key: "NET_PRODUCTION", label: "Net planned production",
      formula: "net produksi setelah buffer/stock/receipt dan batas tanggal, lalu bulatkan ke atas kelipatan 1000 untuk jumlah awal bulanan satuan utuh positif", value: netting.plannedProductionQty,
      inputs: { timePhasedMinimumQty: netting.timePhasedMinimumQty || 0 },
    },
    { order: 10, key: "LOT_ROUNDING", label: "Tambahan pembulatan setelah buffer", formula: "rounded production - raw net production", value: netting.lotRoundingDeltaQty || 0, inputs: { rawQty: netting.rawPlannedProductionQty, multiple: netting.productionRoundingMultiple } },
    { order: 11, key: "PROJECTED_ENDING", label: "Projected ending FG", formula: "max(openingAvailable + firmReceipt + netProduction - grossDemand, 0)", value: netting.projectedEndingStockQty },
  ] };
}

module.exports = { netMpsBucket, allocateMpsProductionToPhases, buildMpsCalculationTrace, timePhasedProductionFloor, buildDatedMpsDemand };
