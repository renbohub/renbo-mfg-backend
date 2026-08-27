"use strict";

const assert = require("assert");
const {
  reviewMpsDeliveryFeasibility,
} = require("../src/prisma/services/planning/mpsDeliveryFeasibilityService");

assert.strictEqual(
  typeof reviewMpsDeliveryFeasibility,
  "function",
  "MPS must expose an in-page delivery feasibility review workflow",
);

function fixtureDocument() {
  return {
    id: "MPS-ID",
    mpsNumber: "MPS-202609",
    revision: 0,
    details: [
      {
        demandSources: [
          { deliveryTargetId: "DT-1", sourcePegging: [] },
          {
            deliveryTargetId: null,
            sourcePegging: [
              { deliveryTargetId: "DT-1" },
              { deliveryTargetId: "DT-2" },
            ],
          },
        ],
      },
    ],
  };
}

async function run() {
  const reviewed = [];
  const tx = {
    mPS: {
      findFirst: async ({ where }) => (
        where.mpsNumber === "MPS-202609" ? fixtureDocument() : null
      ),
    },
  };
  const services = {
    reviewDemand: async (_tx, deliveryTargetId, input, actor) => {
      reviewed.push({ deliveryTargetId, input, actor });
      return { deliveryTargetId, feasibilityStatus: "FEASIBLE" };
    },
    refreshMpsDeliveryFeasibility: async (_tx, mpsNumber) => ({
      mpsNumber,
      feasibilityStatus: "FEASIBLE",
      officialGateStatus: "READY_TO_RELEASE",
      blockerCount: 0,
    }),
  };

  const all = await reviewMpsDeliveryFeasibility(tx, "MPS-202609", {
    actor: "ppic.user",
  }, services);
  assert.deepStrictEqual(
    reviewed.map((row) => row.deliveryTargetId),
    ["DT-1", "DT-2"],
    "duplicate pegging must review each delivery target exactly once",
  );
  assert.ok(reviewed.every((row) => row.input.runFeasibility === true));
  assert.ok(reviewed.every((row) => row.input.status === "REVIEWED"));
  assert.ok(reviewed.every((row) => row.actor === "ppic.user"));
  assert.strictEqual(all.reviewedCount, 2);
  assert.strictEqual(all.gate.officialGateStatus, "READY_TO_RELEASE");

  reviewed.length = 0;
  const selected = await reviewMpsDeliveryFeasibility(tx, "MPS-202609", {
    actor: "ppic.user",
    deliveryTargetIds: ["DT-2", "DT-2"],
  }, services);
  assert.deepStrictEqual(reviewed.map((row) => row.deliveryTargetId), ["DT-2"]);
  assert.strictEqual(selected.reviewedCount, 1);

  await assert.rejects(
    () => reviewMpsDeliveryFeasibility(tx, "MPS-202609", {
      deliveryTargetIds: ["DT-OUTSIDE"],
    }, services),
    (error) => error.statusCode === 400 && /bukan bagian/.test(error.message),
    "review must reject a delivery target outside the active MPS revision",
  );
}

run()
  .then(() => console.log("MPS delivery feasibility review workflow: OK"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
