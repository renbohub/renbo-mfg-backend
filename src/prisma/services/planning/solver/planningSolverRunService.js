"use strict";

const crypto = require("crypto");

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function inputHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(jsonSafe(value)))).digest("hex");
}

function runNumber(scope = "PLAN", now = new Date()) {
  return `SOLVER-${String(scope).toUpperCase()}-${now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

async function enqueueSolverRun(prisma, input = {}) {
  const snapshot = jsonSafe(input.inputSnapshot || {});
  return prisma.planningSolverRun.create({ data: {
    runNumber: input.runNumber || runNumber(input.scope),
    scope: String(input.scope || "GENERIC").toUpperCase(),
    referenceType: input.referenceType || null,
    referenceNumber: input.referenceNumber || null,
    status: input.status || "QUEUED",
    modelVersion: input.modelVersion || null,
    inputHash: inputHash(snapshot),
    inputSnapshot: snapshot,
    requestedBy: input.requestedBy || null,
    ...(input.status === "RUNNING" ? { startedAt: new Date() } : {}),
  } });
}

async function completeSolverRun(prisma, id, result = {}) {
  return prisma.planningSolverRun.update({ where: { id }, data: {
    status: "COMPLETED",
    resultSnapshot: jsonSafe(result),
    blockers: jsonSafe(result.blockers || []),
    objectiveValue: Number.isFinite(Number(result.objectiveValue)) ? Number(result.objectiveValue) : null,
    bestObjectiveBound: Number.isFinite(Number(result.bestObjectiveBound)) ? Number(result.bestObjectiveBound) : null,
    wallTimeSeconds: Number.isFinite(Number(result.wallTimeSeconds)) ? Number(result.wallTimeSeconds) : null,
    finishedAt: new Date(),
  } });
}

async function failSolverRun(prisma, id, error) {
  return prisma.planningSolverRun.update({ where: { id }, data: {
    status: "FAILED",
    errorCode: error?.code || "PLANNING_SOLVER_FAILED",
    errorMessage: String(error?.message || error),
    blockers: jsonSafe(error?.validation?.errors || error?.solver?.blockers || []),
    finishedAt: new Date(),
  } });
}

module.exports = { jsonSafe, inputHash, runNumber, enqueueSolverRun, completeSolverRun, failSolverRun };
