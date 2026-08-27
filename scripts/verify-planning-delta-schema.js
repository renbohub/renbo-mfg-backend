const assert = require("node:assert/strict");
const { Prisma } = require("@prisma/client");

const models = new Map(Prisma.dmmf.datamodel.models.map((model) => [model.name, model]));

function model(name) {
  const value = models.get(name);
  assert.ok(value, `generated Prisma client must expose ${name}`);
  return value;
}

function field(modelName, fieldName) {
  const value = model(modelName).fields.find((candidate) => candidate.name === fieldName);
  assert.ok(value, `${modelName}.${fieldName} must exist`);
  return value;
}

function run() {
  const baselineLock = model("PlanningBaselineLock");
  assert.equal(baselineLock.dbName, "tbl_planning_baseline_lock");
  for (const name of ["periodMonth", "customerCode", "partCode", "sourceFingerprint"]) {
    field("PlanningBaselineLock", name);
  }

  assert.equal(field("PlanningBaselineLock", "coverages").type, "AdditionalDemandCoverage");
  assert.equal(field("PlanningBaselineLock", "adjustments").type, "PlanningAdjustment");
  assert.equal(field("AdditionalDemandCoverage", "baselineLock").type, "PlanningBaselineLock");
  assert.equal(field("PlanningAdjustmentLine", "adjustment").type, "PlanningAdjustment");

  for (const name of ["planKind", "baselineMpsNumber", "lockedAt", "lockedBy"]) field("MPS", name);
  for (const name of ["planKind", "baselineRunNumber", "sourceDeltaMpsNumber", "lockedAt", "lockedBy"]) field("MRPRun", name);

  assert.equal(field("AdditionalDemandCoverage", "idempotencyKey").dbName, "idempotency_key");
  assert.equal(field("PlanningAdjustment", "adjustmentNumber").dbName, "adjustment_number");

  console.log("PASS verify-planning-delta-schema: generated Prisma contract verified");
}

run();
