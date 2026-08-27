"use strict";

const text = (value) => String(value || "").trim();
const kind = (value) => (text(value).toUpperCase() === "DELTA" ? "DELTA" : "BASELINE");
const monthKey = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? text(value).slice(0, 7) : date.toISOString().slice(0, 7);
};

function currentPlanScope(run = {}) {
  const planKind = kind(run.planKind);
  return {
    planKind,
    planningMonth: monthKey(run.planningMonth),
    baselineRunNumber: planKind === "DELTA" ? text(run.baselineRunNumber) || null : null,
  };
}

function sameCurrentPlanScope(left = {}, right = {}) {
  const a = currentPlanScope(left);
  const b = currentPlanScope(right);
  return a.planKind === b.planKind
    && a.planningMonth === b.planningMonth
    && a.baselineRunNumber === b.baselineRunNumber;
}

function deltaMrpMetadata({ deltaMpsNumber, baselineMpsNumber, baselineRunNumber } = {}) {
  if (!text(baselineRunNumber)) throw new Error("Delta MRP membutuhkan baseline MRP yang Approved dan current.");
  if (!text(deltaMpsNumber)) throw new Error("Delta MRP membutuhkan source Delta MPS.");
  return {
    planKind: "DELTA",
    baselineRunNumber: text(baselineRunNumber),
    sourceDeltaMpsNumber: text(deltaMpsNumber),
    baselineMpsNumber: text(baselineMpsNumber) || null,
  };
}

function currentScopeWhere(run = {}) {
  const scope = currentPlanScope(run);
  return scope.planKind === "DELTA"
    ? { planKind: "DELTA", planningMonth: new Date(`${scope.planningMonth}-01T00:00:00.000Z`), baselineRunNumber: scope.baselineRunNumber }
    : { planKind: "BASELINE", planningMonth: new Date(`${scope.planningMonth}-01T00:00:00.000Z`) };
}

module.exports = { currentPlanScope, sameCurrentPlanScope, deltaMrpMetadata, currentScopeWhere };
