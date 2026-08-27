"use strict";

const assert = require("assert");
const {
  createHandlers,
  validateSelection,
} = require("../src/prisma/controllers/planning/MonthlyPlanRecommendationController");

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

function assertBadSelection(value) {
  assert.throws(
    () => validateSelection(value),
    (error) => error.statusCode === 400,
  );
}

assert.deepStrictEqual(validateSelection({ mode: "ALL" }), { mode: "ALL" });
assert.deepStrictEqual(validateSelection({ mode: "EXISTING_TASKS" }), { mode: "EXISTING_TASKS" });
assert.deepStrictEqual(
  validateSelection({ mode: "WORK_CENTER", workCenterIds: ["wc-1", "wc-1", ""] }),
  { mode: "WORK_CENTER", workCenterIds: ["wc-1"] },
);
assert.deepStrictEqual(
  validateSelection({ mode: "ITEMS", itemIds: ["item-1"] }),
  { mode: "ITEMS", itemIds: ["item-1"] },
);
assertBadSelection(null);
assertBadSelection({ mode: "UNKNOWN" });
assertBadSelection({ mode: "WORK_CENTER", workCenterIds: [] });
assertBadSelection({ mode: "ITEMS", itemIds: [] });

(async () => {
  const calls = [];
  const service = {
    generateRecommendationScenario: async (_prisma, input) => {
      calls.push(["generate", input]);
      return { id: "scenario-1", status: "READY" };
    },
    getActiveRecommendationScenario: async (_prisma, planNumber) => {
      calls.push(["active", planNumber]);
      return planNumber === "MPP-NONE" ? null : { id: "scenario-1" };
    },
    getRecommendationScenario: async (_prisma, scenarioId) => {
      calls.push(["detail", scenarioId]);
      return { id: scenarioId, items: [] };
    },
    applyRecommendationScenario: async (_prisma, input) => {
      calls.push(["apply", input]);
      return {
        scenario: { id: input.scenarioId, status: "APPLIED" },
        session: { id: "editor-1", status: "OPEN" },
      };
    },
    discardRecommendationScenario: async (_prisma, input) => {
      calls.push(["discard", input]);
      return { id: input.scenarioId, status: "DISCARDED" };
    },
  };
  const handlers = createHandlers(service, { fake: "prisma" });
  const failNext = (error) => {
    throw error;
  };

  const generatedResponse = fakeResponse();
  await handlers.generate(
    {
      params: { planNumber: "MPP-1" },
      user: { username: "ppic" },
    },
    generatedResponse,
    failNext,
  );
  assert.strictEqual(generatedResponse.statusCode, 201);
  assert.strictEqual(generatedResponse.body.status, "READY");
  assert.deepStrictEqual(calls[0], [
    "generate",
    { planNumber: "MPP-1", actor: "ppic" },
  ]);

  const activeResponse = fakeResponse();
  await handlers.active(
    { params: { planNumber: "MPP-1" } },
    activeResponse,
    failNext,
  );
  assert.strictEqual(activeResponse.body.id, "scenario-1");

  const missingResponse = fakeResponse();
  await handlers.active(
    { params: { planNumber: "MPP-NONE" } },
    missingResponse,
    failNext,
  );
  assert.strictEqual(missingResponse.statusCode, 404);
  assert.deepStrictEqual(missingResponse.body, {
    message: "Scenario recommendation aktif tidak ditemukan.",
  });

  const applyResponse = fakeResponse();
  await handlers.apply(
    {
      params: { scenarioId: "scenario-1" },
      body: { selection: { mode: "ITEMS", itemIds: ["item-1"] } },
      user: { email: "admin@example.com" },
    },
    applyResponse,
    failNext,
  );
  assert.strictEqual(applyResponse.body.scenario.status, "APPLIED");
  assert.deepStrictEqual(calls.find((call) => call[0] === "apply")[1], {
    scenarioId: "scenario-1",
    actor: "admin@example.com",
    selection: { mode: "ITEMS", itemIds: ["item-1"] },
  });

  const discardResponse = fakeResponse();
  await handlers.discard(
    { params: { scenarioId: "scenario-1" }, user: { id: "user-1" } },
    discardResponse,
    failNext,
  );
  assert.strictEqual(discardResponse.body.status, "DISCARDED");

  console.log("Monthly plan recommendation API contract passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
