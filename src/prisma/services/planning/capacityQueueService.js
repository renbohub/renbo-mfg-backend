"use strict";

const key = (value) => value ? String(value instanceof Date ? value.toISOString() : value).slice(0, 10) : null;

function dependencyWindow({ predecessorFinishDates = [], successorStartDates = [], fgRequiredDate }) {
  const predecessors = predecessorFinishDates.map(key).filter(Boolean).sort();
  const successors = successorStartDates.map(key).filter(Boolean).sort();
  return {
    earliestStartDate: predecessors.at(-1) || null,
    latestFinishDate: successors[0] || key(fgRequiredDate),
  };
}

function rankCapacityAlternatives({ earliestStartDate, latestFinishDate, alternatives = [] }) {
  return alternatives.map((alternative) => {
    const date = key(alternative.date);
    const insideWindow = (!earliestStartDate || date >= key(earliestStartDate)) && (!latestFinishDate || date <= key(latestFinishDate));
    const capacityEnough = Number(alternative.availableMinutes || 0) >= Number(alternative.requiredMinutes || 0);
    const slack = Number(alternative.availableMinutes || 0) - Number(alternative.requiredMinutes || 0);
    const requiresForce = !insideWindow || !capacityEnough;
    return { ...alternative, date, insideWindow, capacityEnough, requiresForce, score: (insideWindow ? 1000 : 0) + (capacityEnough ? 500 : 0) + Math.max(Math.min(slack, 400), -400) };
  }).sort((left, right) => Number(left.requiresForce) - Number(right.requiresForce) || right.score - left.score || left.date.localeCompare(right.date));
}

module.exports = { dependencyWindow, rankCapacityAlternatives };
