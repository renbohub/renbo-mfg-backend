"use strict";

const assert = require("assert");
const path = require("path");
const { createAiRequestQueue } = require("../src/prisma/services/ai/aiRequestQueue");
const { createAiRuntimeSupervisor } = require("../src/prisma/services/ai/aiRuntimeSupervisor");

async function run() {
  const queue = createAiRequestQueue({ maxGlobalPending: 2, maxUserPending: 1 });
  queue.enqueue({ id: "r1", userId: "u1", priority: 100 });
  assert.throws(
    () => queue.enqueue({ id: "r2", userId: "u1", priority: 100 }),
    (error) => error.code === "AI_USER_QUEUE_FULL"
  );
  queue.enqueue({ id: "r3", userId: "u2", priority: 10 });
  assert.strictEqual(queue.takeNext().id, "r3", "lower priority number must run first");
  assert.strictEqual(queue.position("r1"), 1);
  assert.strictEqual(queue.cancel("r1", "u1"), true);
  assert.strictEqual(queue.size(), 0);

  const supervisor = createAiRuntimeSupervisor({
    workerPath: path.resolve(__dirname, "fixtures", "fake-ai-worker.js"),
    maxGlobalPending: 4,
    maxUserPending: 2,
    idleUnloadMs: 1000,
    defaultTimeoutMs: 80,
    baseEnv: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      DATABASE_URL: "must-not-leak",
      JWT_SECRET: "must-not-leak",
    },
  });

  const result = await supervisor.enqueue({
    id: "ok-1",
    userId: "u1",
    profile: { profileCode: "TEST", runtimeConfig: { maxMemoryMb: 5120 } },
    messages: [{ role: "user", content: "HELLO" }],
    outputSchema: { type: "object" },
    timeoutMs: 500,
  });
  assert.deepStrictEqual(result.json, { answer: "HELLO" });
  assert.deepStrictEqual(supervisor.status().workerEnvironment, {
    hasDatabaseUrl: false,
    hasJwtSecret: false,
    hasPath: true,
  });

  await assert.rejects(
    () => supervisor.enqueue({
      id: "timeout-1",
      userId: "u1",
      profile: { profileCode: "TEST", runtimeConfig: { maxMemoryMb: 5120 } },
      messages: [{ role: "user", content: "DELAY" }],
      outputSchema: { type: "object" },
      timeoutMs: 30,
    }),
    (error) => error.code === "AI_TIMEOUT"
  );

  await assert.rejects(
    () => supervisor.enqueue({
      id: "crash-1",
      userId: "u2",
      profile: { profileCode: "TEST", runtimeConfig: { maxMemoryMb: 5120 } },
      messages: [{ role: "user", content: "CRASH" }],
      outputSchema: { type: "object" },
      timeoutMs: 500,
    }),
    (error) => error.code === "AI_WORKER_CRASHED"
  );

  const restarted = await supervisor.enqueue({
    id: "ok-2",
    userId: "u2",
    profile: { profileCode: "TEST", runtimeConfig: { maxMemoryMb: 5120 } },
    messages: [{ role: "user", content: "RESTARTED" }],
    outputSchema: { type: "object" },
    timeoutMs: 500,
  });
  assert.deepStrictEqual(restarted.json, { answer: "RESTARTED" });

  await supervisor.shutdown();
  assert.strictEqual(supervisor.status().state, "OFFLINE");
  console.log("AI runtime contract passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
