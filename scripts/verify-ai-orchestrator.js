"use strict";

const assert = require("assert");
const { createAiOrchestrator } = require("../src/prisma/services/ai/aiOrchestrator");
const { ASSISTANT_ENVELOPE_SCHEMA } = require("../src/prisma/services/ai/promptRegistry");

function runtimeWith(outputs) {
  const calls = [];
  return {
    calls,
    enqueue: async (job) => {
      calls.push(job);
      const next = outputs.shift();
      if (next instanceof Error) throw next;
      return { json: next, text: JSON.stringify(next), metrics: { durationMs: 1 } };
    },
  };
}

async function run() {
  const answerSchema = ASSISTANT_ENVELOPE_SCHEMA.oneOf.find((entry) => entry.properties?.type?.const === "ANSWER");
  assert.ok(answerSchema.properties.answer.maxLength <= 1024, "Assistant grammar must stay within llama.cpp repetition limit.");

  const runtime = runtimeWith([
    { type: "TOOL_CALL", capabilityCode: "inventory.get_stock_summary", arguments: { partCode: "A" } },
    { type: "ANSWER", answer: "Stock tersedia.", sources: [{ entityType: "STOCK_BALANCE", entityId: "S1" }] },
  ]);
  const gatewayCalls = [];
  const orchestrator = createAiOrchestrator({
    runtime,
    gateway: {
      execute: async (input) => {
        gatewayCalls.push(input);
        return { rows: [{ partCode: "A", freeQty: 10 }], sources: [{ entityType: "STOCK_BALANCE", entityId: "S1" }] };
      },
    },
  });
  const answer = await orchestrator.runToolLoop({
    user: { id: "u1" },
    requestId: "r1",
    conversationId: "c1",
    pageContext: { moduleCode: "inventory", pageCode: "stock-balances" },
    profile: { profileCode: "TEST", runtimeConfig: { maxTokens: 800 } },
    messages: [{ role: "user", content: "Cek stock A" }],
  });
  assert.strictEqual(answer.answer, "Stock tersedia.");
  assert.strictEqual(gatewayCalls.length, 1);
  assert.strictEqual(runtime.calls.length, 2);
  assert.strictEqual(runtime.calls[0].maxTokens, 256, "Interactive chat must use the low-latency token budget.");
  assert.strictEqual(runtime.calls[1].messages.at(-1).role, "tool");

  const denied = createAiOrchestrator({
    runtime: runtimeWith([{ type: "TOOL_CALL", capabilityCode: "purchasing.find_late_po", arguments: {} }]),
    gateway: { execute: async () => { throw Object.assign(new Error("denied"), { code: "AI_CAPABILITY_FORBIDDEN" }); } },
  });
  await assert.rejects(
    () => denied.runToolLoop({ user: { id: "u1" }, requestId: "r2", conversationId: "c1", pageContext: {}, profile: {}, messages: [{ role: "user", content: "x" }] }),
    (error) => error.code === "AI_CAPABILITY_FORBIDDEN"
  );

  let loopCalls = 0;
  const bounded = createAiOrchestrator({
    runtime: runtimeWith(Array.from({ length: 5 }, () => ({ type: "TOOL_CALL", capabilityCode: "inventory.get_stock_summary", arguments: { partCode: "A" } }))),
    gateway: { execute: async () => { loopCalls += 1; return { rows: [], sources: [] }; } },
  });
  await assert.rejects(
    () => bounded.runToolLoop({ user: { id: "u1" }, requestId: "r3", conversationId: "c1", pageContext: {}, profile: {}, messages: [{ role: "user", content: "x" }] }),
    (error) => error.code === "AI_TOOL_LOOP_LIMIT"
  );
  assert.strictEqual(loopCalls, 4, "orchestrator must execute at most four capabilities");

  const malformed = createAiOrchestrator({
    runtime: runtimeWith([{ unexpected: true }]),
    gateway: { execute: async () => ({}) },
  });
  await assert.rejects(
    () => malformed.runToolLoop({ user: { id: "u1" }, requestId: "r4", conversationId: "c1", pageContext: {}, profile: {}, messages: [{ role: "user", content: "x" }] }),
    (error) => error.code === "AI_OUTPUT_INVALID"
  );

  const repairRuntime = runtimeWith([
    { qty: -2, partCode: "A" },
    { qty: 5, partCode: "A" },
  ]);
  const repair = createAiOrchestrator({ runtime: repairRuntime, gateway: { execute: async () => ({}) } });
  const workflow = await repair.generateStructuredWorkflow({
    requestId: "wf1",
    userId: "u1",
    profile: { profileCode: "TEST", runtimeConfig: { maxTokens: 1200 } },
    messages: [{ role: "user", content: "Buat draft" }],
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["qty", "partCode"],
      properties: { qty: { type: "number", minimum: 0 }, partCode: { const: "A" } },
    },
    validateBusiness: async (value) => value.qty <= 10 ? [] : [{ code: "QTY_TOO_HIGH" }],
  });
  assert.deepStrictEqual(workflow.value, { qty: 5, partCode: "A" });
  assert.strictEqual(workflow.corrected, true);
  assert.strictEqual(repairRuntime.calls.length, 2, "structured workflow gets one repair attempt");

  console.log("AI orchestrator contract passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
