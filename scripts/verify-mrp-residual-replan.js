const assert = require("assert");
const { __test } = require("../src/prisma/controllers/planning/MRPController");

async function main() {
  const plannedOrderUpdates = [];
  let plannedOrderFindCall = 0;
  let mppFindCall = 0;
  const tx = {
    mRPRun: {
      findMany: async () => [{ runNumber: "MRP-OLD" }],
      updateMany: async () => ({ count: 1 }),
    },
    mPSDetail: { findMany: async () => [{ id: "generated-child" }] },
    monthlyProductionPlanDetail: {
      findMany: async () => {
        mppFindCall += 1;
        if (mppFindCall === 1) return [{ plannedOrderNumber: "PMO-PROTECTED", qtyReleased: 40, status: "Released", plan: { planNumber: "PP-OLD", status: "Released" } }];
        return [{ plannedOrderNumber: "PMO-PROTECTED" }];
      },
    },
    manufacturingOrder: {
      count: async () => 1,
      findMany: async () => [{ plannedOrderNumber: "PMO-PROTECTED", sourcePlannedOrderNumber: null }],
    },
    plannedOrder: {
      findMany: async (args) => {
        plannedOrderFindCall += 1;
        if (plannedOrderFindCall === 1) return [
          { orderNumber: "PMO-PROTECTED", status: "Released", qtyReleased: 40 },
          { orderNumber: "PMO-DRAFT", status: "Planned", qtyReleased: 0 },
        ];
        assert.deepStrictEqual(args.where.orderNumber.notIn, ["PMO-PROTECTED"], "query supersede harus mengecualikan planned order protected");
        return [{ orderNumber: "PMO-DRAFT" }];
      },
      updateMany: async (args) => { plannedOrderUpdates.push(args); return { count: 1 }; },
    },
    mRPPegging: { updateMany: async () => ({ count: 1 }) },
  };

  const result = await __test.supersedePreviousMrpArtifacts(tx, ["MPS-202609"], "MRP-NEW", "ppic");
  assert.strictEqual(result.mode, "RESIDUAL_REPLAN_PRESERVE_EXECUTION");
  assert.deepStrictEqual(result.protectedPlannedOrderNumbers, ["PMO-PROTECTED"]);
  assert.deepStrictEqual(result.supersededPlannedOrderNumbers, ["PMO-DRAFT"]);
  assert.strictEqual(result.protectedExecutionCount, 4);
  assert.deepStrictEqual(plannedOrderUpdates[0].where.orderNumber.notIn, ["PMO-PROTECTED"]);
  assert.strictEqual(plannedOrderUpdates[0].data.status, "Superseded");
  console.log("MRP residual replan contract passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
