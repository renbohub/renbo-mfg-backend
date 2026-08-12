"use strict";

function isUncommittedPlannedSupply(order = {}) {
  if (String(order.status || "Planned") !== "Planned") return false;
  if (String(order.runNumber || "").trim()) return false;
  const referenceType = String(order.referenceType || "").trim().toUpperCase();
  return !["MRP", "SO"].includes(referenceType);
}

module.exports = { isUncommittedPlannedSupply };
