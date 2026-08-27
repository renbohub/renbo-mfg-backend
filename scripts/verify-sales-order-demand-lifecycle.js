"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { retireDeliveryTargets } = require("../src/prisma/services/planning/demandDeliveryTargetService");

async function verifyRetirementWrite() {
  let invocation = null;
  const tx = {
    demandDeliveryTarget: {
      updateMany: async (args) => {
        invocation = args;
        return { count: 2 };
      },
    },
  };
  const result = await retireDeliveryTargets(tx, {
    sourceType: "SALES_ORDER",
    sourceNumber: "SO-REV-OLD",
    status: "SUPERSEDED",
    user: "qa",
  });
  assert.equal(result.count, 2);
  assert.deepEqual(invocation.where, {
    sourceType: "SALES_ORDER",
    sourceNumber: "SO-REV-OLD",
    isDeleted: false,
    status: "ACTIVE",
  });
  assert.deepEqual(invocation.data, {
    status: "SUPERSEDED",
    isDeleted: false,
    updatedBy: "qa",
  });
}

function source(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, "..", relativePath), "utf8");
}

async function main() {
  await verifyRetirementWrite();

  const controller = source("src/prisma/controllers/sales/SalesOrderController.js");
  assert.match(controller, /retireDeliveryTargets\(tx,[\s\S]*status:\s*"SUPERSEDED"/);

  for (const relativePath of [
    "src/prisma/services/planning/demandPlanningService.js",
    "src/prisma/services/planning/monthlyDemandReviewService.js",
    "src/prisma/services/planning/yearlyDemandService.js",
  ]) {
    assert.match(source(relativePath), /Superseded/, `${relativePath} must exclude superseded Sales Orders`);
  }

  console.log("sales-order demand lifecycle contracts: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
