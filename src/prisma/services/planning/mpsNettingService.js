"use strict";

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value, digits = 6) => {
  const factor = 10 ** Math.max(0, Math.trunc(digits));
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
};

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
  const plannedProductionQty = Math.max(netProductionBeforeOverride * productionPercent / 100, firmSalesOrderShortageQty);
  const projectedEndingStockQty = Math.max(availableBeforeProduction + plannedProductionQty - grossDemandQty, 0);
  return {
    openingAvailableQty: round(openingAvailableQty), firmScheduledReceiptQty: round(firmScheduledReceiptQty),
    availableBeforeProduction: round(availableBeforeProduction), grossDemandQty: round(grossDemandQty),
    targetEndingStockQty: round(targetEndingStockQty), netProductionBeforeOverride: round(netProductionBeforeOverride),
    productionPercent: round(productionPercent), firmSalesOrderShortageQty: round(firmSalesOrderShortageQty),
    plannedProductionQty: round(plannedProductionQty), projectedEndingStockQty: round(projectedEndingStockQty),
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
  return { version: 3, formula: "max((grossDemand + targetEnding - (freeFG + peggedSOReservation) - firmReceipts) * productionPercent / 100, actualSO - availableBeforeProduction)", month, partCode, policy, steps: [
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
      formula: "max(max(grossDemand + targetEnding - openingAvailable - firmReceipt, 0) * productionPercent / 100, actualSO - openingAvailable - firmReceipt)", value: netting.plannedProductionQty,
    },
    { order: 10, key: "PROJECTED_ENDING", label: "Projected ending FG", formula: "max(openingAvailable + firmReceipt + netProduction - grossDemand, 0)", value: netting.projectedEndingStockQty },
  ] };
}

module.exports = { netMpsBucket, allocateMpsProductionToPhases, buildMpsCalculationTrace };
