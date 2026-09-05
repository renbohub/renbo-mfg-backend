"use strict";

const assert = require("assert");
const {
  reviewMpsDeliveryFeasibility,
} = require("../src/prisma/services/planning/mpsDeliveryFeasibilityService");
const {
  buildDueDateRecoveryChecklist,
  buildTrialRecoveryChecklist,
  resolveAcceptedLateDate,
  validateRecoveryChecklist,
} = require("../src/prisma/services/planning/dueDateRecoveryService");

assert.strictEqual(
  typeof reviewMpsDeliveryFeasibility,
  "function",
  "MPS must expose an in-page delivery feasibility review workflow",
);

const trialRecommendation = buildDueDateRecoveryChecklist({
  status: "MASTER_DATA_INCOMPLETE",
  criticalConstraint: "MASTER_DATA",
  requestedDeliveryDate: "2026-09-10",
  fgRequiredDate: "2026-09-09",
  earliestFeasibleDeliveryDate: "2026-09-10",
  simulatedAt: "2026-08-28",
  constraintDetails: {},
});
assert.ok(!trialRecommendation.actions.some((item) => item.id === "ACCEPT_LATE"), "incomplete master data must be corrected, not accepted as late");
const trialChecklist = buildTrialRecoveryChecklist(trialRecommendation, {
  owner: "ppic.trial",
  notes: "Trial recovery satu tombol untuk pengujian.",
  evidenceReference: "MPS-TEST",
});
assert.ok(trialChecklist.find((item) => item.id === "RUN_TRIAL_RECOVERY")?.selected, "one-click recovery must select RUN_TRIAL_RECOVERY");
assert.ok(trialChecklist.filter((item) => item.required).every((item) => item.selected && item.owner && item.targetDate));
assert.deepStrictEqual(validateRecoveryChecklist(trialChecklist, "2026-09-10"), []);
assert.strictEqual(resolveAcceptedLateDate("2026-09-10", "2026-09-15").toISOString().slice(0, 10), "2026-09-15");
assert.strictEqual(resolveAcceptedLateDate("2026-09-10", "2026-09-05"), null, "on-time estimates must not manufacture an Accept Late date");
assert.strictEqual(resolveAcceptedLateDate("2026-09-10", "2026-09-10"), null, "same-day delivery is not late");
assert.strictEqual(resolveAcceptedLateDate("invalid", "2026-09-05"), null);

const lateRecommendation = buildDueDateRecoveryChecklist({
  status: "NOT_FEASIBLE",
  criticalConstraint: "CAPACITY",
  requestedDeliveryDate: "2026-09-10",
  earliestFeasibleDeliveryDate: "2026-09-12",
  constraintDetails: {},
});
assert.ok(lateRecommendation.actions.some((item) => item.id === "ACCEPT_LATE"), "a verified date miss may offer Accept Late");

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
