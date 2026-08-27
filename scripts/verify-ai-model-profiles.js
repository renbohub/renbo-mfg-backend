"use strict";

const assert = require("assert");
const path = require("path");

const {
  resolveModelFile,
  validateRuntimeConfig,
  validateProfileInput,
  createModelProfileService,
} = require("../src/prisma/services/ai/aiModelProfileService");

function passingBenchmark() {
  return {
    modelLoadPass: true,
    schemaPass: true,
    goldenPass: true,
    permissionPass: true,
    resourcePass: true,
    latencyPass: true,
  };
}

function createFakePrisma(rows) {
  const calls = [];
  const delegate = {
    findMany: async () => [...rows.values()],
    findUnique: async ({ where }) => rows.get(where.id) || null,
    findFirst: async ({ where }) =>
      [...rows.values()].find(
        (row) => row.status === where.status && (!where.id?.not || row.id !== where.id.not)
      ) || null,
    create: async ({ data }) => {
      const row = { id: `profile-${rows.size + 1}`, ...data };
      rows.set(row.id, row);
      calls.push({ method: "create", data });
      return row;
    },
    updateMany: async ({ where, data }) => {
      calls.push({ method: "updateMany", where, data });
      for (const [id, row] of rows.entries()) {
        if (row.status === where.status && (!where.id?.not || id !== where.id.not)) {
          rows.set(id, { ...row, ...data });
        }
      }
      return { count: 1 };
    },
    update: async ({ where, data }) => {
      calls.push({ method: "update", where, data });
      const row = { ...rows.get(where.id), ...data };
      rows.set(where.id, row);
      return row;
    },
  };
  return {
    aiModelProfile: delegate,
    $transaction: async (work) => work({ aiModelProfile: delegate }),
    calls,
  };
}

async function run() {
  assert.throws(
    () => resolveModelFile({ ggufFileName: "../secret.gguf" }, "C:/erp/models"),
    (error) => error.code === "AI_MODEL_PATH_DENIED"
  );
  assert.strictEqual(
    resolveModelFile({ ggufFileName: "qwen3-4b-q4_k_m.gguf" }, "C:/erp/models"),
    path.resolve("C:/erp/models/qwen3-4b-q4_k_m.gguf")
  );
  assert.deepStrictEqual(
    validateRuntimeConfig({ contextSize: 4096, maxTokens: 800, cpuThreads: 6, batchSize: 128 }),
    {
      contextSize: 4096,
      maxTokens: 800,
      cpuThreads: 6,
      batchSize: 128,
      gpuMode: "cpu",
      gpuLayers: 0,
      maxMemoryMb: 5120,
      chatTimeoutMs: 45000,
      recommendationTimeoutMs: 90000,
      thinkingPolicy: "BOUNDED_RECOMMENDATION",
    }
  );
  assert.throws(
    () => validateProfileInput({
      profileCode: "QWEN3_BAD_PROMPT",
      displayName: "Qwen invalid prompt",
      modelFamily: "Qwen3",
      ggufFileName: "qwen3.gguf",
      quantization: "Q4_K_M",
      promptCompatibilityVersion: "1.0",
    }),
    (error) => error.code === "AI_PROMPT_NOT_FOUND",
    "Model profile must reject prompt versions that are not registered."
  );

  const rows = new Map([
    ["active", { id: "active", profileCode: "QWEN3-4B-CPU", displayName: "Qwen CPU", modelFamily: "Qwen3", ggufFileName: "qwen3-4b-q4_k_m.gguf", quantization: "Q4_K_M", promptCompatibilityVersion: "ERP_ASSISTANT_V1", runtimeConfig: validateRuntimeConfig(), status: "ACTIVE", benchmarkResult: passingBenchmark(), rollbackProfileId: null }],
    ["candidate", { id: "candidate", profileCode: "QWEN3-4B-V2", displayName: "Qwen CPU v2", modelFamily: "Qwen3", ggufFileName: "qwen3-4b-v2-q4_k_m.gguf", quantization: "Q4_K_M", promptCompatibilityVersion: "ERP_ASSISTANT_V1", runtimeConfig: validateRuntimeConfig(), status: "INACTIVE", benchmarkResult: passingBenchmark(), rollbackProfileId: null }],
  ]);
  const prisma = createFakePrisma(rows);
  const discovered = createModelProfileService({
    prisma,
    modelDir: "C:/erp/models",
    fs: {
      readdirSync: () => [
        { name: "qwen3-4b-q4_k_m.gguf", isFile: () => true },
        { name: "notes.txt", isFile: () => true },
        { name: "nested.gguf", isFile: () => false },
      ],
      existsSync: () => true,
      createReadStream: require("fs").createReadStream,
    },
    runtime: { probe: async () => ({ ready: true }) },
    now: () => new Date("2026-08-25T08:00:00.000Z"),
  });
  assert.deepStrictEqual(discovered.listAllowlistedModelFiles(), ["qwen3-4b-q4_k_m.gguf"]);

  const failingService = createModelProfileService({
    prisma,
    modelDir: "C:/erp/models",
    fs: { readdirSync: () => [], existsSync: () => true },
    runtime: { probe: async () => { throw Object.assign(new Error("cannot load"), { code: "AI_MODEL_LOAD_FAILED" }); } },
  });
  await assert.rejects(
    () => failingService.activateModelProfile("candidate", { id: "admin" }),
    (error) => error.code === "AI_MODEL_LOAD_FAILED"
  );
  assert.strictEqual(rows.get("active").status, "ACTIVE", "failed probe must preserve active profile");
  assert.strictEqual(prisma.calls.length, 0, "failed probe must not start profile mutation");

  const service = createModelProfileService({
    prisma,
    modelDir: "C:/erp/models",
    fs: { readdirSync: () => [], existsSync: () => true },
    runtime: { probe: async () => ({ ready: true }) },
    now: () => new Date("2026-08-25T08:00:00.000Z"),
  });
  await service.activateModelProfile("candidate", { id: "admin" });
  assert.strictEqual(rows.get("active").status, "INACTIVE");
  assert.strictEqual(rows.get("candidate").status, "ACTIVE");
  assert.strictEqual(rows.get("candidate").rollbackProfileId, "active");

  const activationCallCount = prisma.calls.length;
  await service.activateModelProfile("candidate", { id: "admin-repeat" });
  assert.strictEqual(
    prisma.calls.length,
    activationCallCount,
    "repeated activation must preserve the existing rollback profile"
  );
  assert.strictEqual(rows.get("candidate").rollbackProfileId, "active");

  await service.rollbackModelProfile("candidate", { id: "admin-2" });
  assert.strictEqual(rows.get("active").status, "ACTIVE");
  assert.strictEqual(rows.get("candidate").status, "INACTIVE");
  assert.strictEqual(rows.get("active").rollbackProfileId, "candidate");

  console.log("AI model profile contract passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
