"use strict";

const assert = require("assert");
const {
  resolveReceiptDefinition,
  childFgReceiptMarker,
} = require("../src/prisma/controllers/production/services/childFgReceiptService");

const receiptLines = [
  {
    id: "receipt-line-1",
    lineNumber: 99,
    qtyPlanned: 40,
    uomCode: "PCS",
    deliveryPhaseId: null,
    requiredDate: new Date("2026-09-08T00:00:00.000Z"),
    fgRequiredDate: new Date("2026-09-19T00:00:00.000Z"),
  },
  {
    id: "receipt-line-2",
    lineNumber: 100,
    qtyPlanned: 20,
    uomCode: "PCS",
    deliveryPhaseId: null,
    requiredDate: new Date("2026-09-15T00:00:00.000Z"),
    fgRequiredDate: new Date("2026-09-26T00:00:00.000Z"),
  },
];

const tx = {
  monthlyProductionPlan: {
    findUnique: async () => ({ id: "plan-1", planNumber: "MPP-202609-001" }),
  },
  monthlyProductionPlanDetail: {
    findMany: async () => receiptLines,
  },
  productionPlanAllocation: {
    findUnique: async () => ({
      id: "allocation-2",
      deliveryPhaseId: null,
      fgRequiredDate: new Date("2026-09-26T00:00:00.000Z"),
    }),
  },
  mBOMHeader: {
    findFirst: async () => ({
      noReg: "MBOM-CHILD",
      part: {
        id: "fg-part",
        partCode: "CHILD-FG",
        partNumber: "11058-1292",
        partName: "BRACKET",
        itemType: "FG",
        material: null,
        partBases: [],
      },
      details: [
        {
          id: "root-wip-detail",
          uomCode: "PCS",
          part: { id: "wip-part", partCode: "CHILD-FINAL-WIP", itemType: "WIP" },
        },
      ],
    }),
  },
};

(async () => {
  const definition = await resolveReceiptDefinition(
    tx,
    {
      productionPlanId: "plan-1",
      productionPlanAllocationId: "allocation-2",
      fgRequiredDate: new Date("2026-09-26T00:00:00.000Z"),
    },
    "CHILD-FG",
  );
  assert.strictEqual(
    definition.receiptLine.id,
    "receipt-line-2",
    "child-FG receipt must use the authorization matching the consuming delivery requirement, not the first line for the part",
  );
  assert.strictEqual(
    childFgReceiptMarker(definition.plan, definition.receiptLine, "CHILD-FG"),
    "[CHILD-FG-RECEIPT:MPP-202609-001:receipt-line-2:CHILD-FG]",
    "movement history must be capped and traceable per receipt authorization line",
  );
  console.log("Child FG receipt phase contract passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
