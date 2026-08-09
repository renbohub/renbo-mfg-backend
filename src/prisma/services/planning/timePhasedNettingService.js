"use strict";

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const at = (value) => new Date(value).getTime();

function normalizeSupplyEvents(events = []) {
  return events
    .map((row, index) => ({
      ...row,
      id: row.id || `${row.sourceType || "SUPPLY"}:${row.sourceNumber || index}`,
      qty: Math.max(number(row.qty), 0),
      availableDate: new Date(row.availableDate || row.date),
      confidence: String(row.confidence || "PLANNED").toUpperCase(),
    }))
    .filter((row) => row.qty > 0 && Number.isFinite(row.availableDate.getTime()))
    .sort((left, right) => at(left.availableDate) - at(right.availableDate));
}

function netTimePhasedDemand({ openingQty = 0, supplyEvents = [], demandEvents = [] }) {
  const supplies = normalizeSupplyEvents(supplyEvents);
  const demands = demandEvents
    .map((row, index) => ({ ...row, _index: index, qty: Math.max(number(row.qty), 0), requiredDate: new Date(row.requiredDate) }))
    .filter((row) => row.qty > 0 && Number.isFinite(row.requiredDate.getTime()))
    .sort((left, right) => at(left.requiredDate) - at(right.requiredDate) || left._index - right._index);
  let expectedBalance = Math.max(number(openingQty), 0);
  let firmBalance = expectedBalance;
  let supplyIndex = 0;
  const appliedSupply = [];
  const results = [];

  for (const demand of demands) {
    const newlyAvailable = [];
    while (supplyIndex < supplies.length && at(supplies[supplyIndex].availableDate) <= at(demand.requiredDate)) {
      const supply = supplies[supplyIndex++];
      expectedBalance += supply.qty;
      if (supply.confidence === "FIRM") firmBalance += supply.qty;
      appliedSupply.push(supply);
      newlyAvailable.push(supply);
    }
    const expectedBefore = expectedBalance;
    const firmBefore = firmBalance;
    const netRequirement = Math.max(demand.qty - expectedBefore, 0);
    const firmNetRequirement = Math.max(demand.qty - firmBefore, 0);
    const rawExpectedAfter = expectedBefore - demand.qty;
    const rawFirmAfter = firmBefore - demand.qty;
    expectedBalance = Math.max(rawExpectedAfter, 0);
    firmBalance = Math.max(rawFirmAfter, 0);
    results.push({
      ...demand,
      expectedAvailableBefore: expectedBefore,
      firmAvailableBefore: firmBefore,
      netRequirement,
      firmNetRequirement,
      atRiskSupplyQty: Math.max(firmNetRequirement - netRequirement, 0),
      projectedAvailableAfter: rawExpectedAfter,
      firmProjectedAvailableAfter: rawFirmAfter,
      newlyAvailableSupply: newlyAvailable,
      eligibleSupply: appliedSupply.slice(),
    });
  }
  return results.sort((left, right) => left._index - right._index).map(({ _index, ...row }) => row);
}

module.exports = { normalizeSupplyEvents, netTimePhasedDemand };
