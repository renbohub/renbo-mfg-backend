"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { getPrompt } = require("./promptRegistry");

const PROFILE_STATUS = Object.freeze({
  DRAFT: "DRAFT",
  TESTING: "TESTING",
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
  FAILED: "FAILED",
});

const REQUIRED_BENCHMARK_GATES = Object.freeze([
  "modelLoadPass",
  "schemaPass",
  "goldenPass",
  "permissionPass",
  "resourcePass",
  "latencyPass",
]);

function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, status: statusCode, code });
}

function normalizeActor(actor) {
  return String(actor?.id || actor?.username || actor?.email || actor || "system").trim() || "system";
}

function bounded(number, min, max, fallback) {
  const parsed = Number(number);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(value, min), max);
}

function validateRuntimeConfig(value = {}) {
  const gpuMode = ["cpu", "auto", "cuda", "vulkan"].includes(value.gpuMode)
    ? value.gpuMode
    : "cpu";
  const defaultThreads = Math.max((os.cpus()?.length || 6) - 2, 1);
  return {
    contextSize: bounded(value.contextSize, 1024, 8192, 4096),
    maxTokens: bounded(value.maxTokens, 128, 1200, 800),
    cpuThreads: bounded(value.cpuThreads, 1, 64, defaultThreads),
    batchSize: bounded(value.batchSize, 32, 256, 128),
    gpuMode,
    gpuLayers: gpuMode === "cpu" ? 0 : bounded(value.gpuLayers, 0, 999, 0),
    maxMemoryMb: bounded(value.maxMemoryMb, 2048, 6144, 5120),
    chatTimeoutMs: bounded(value.chatTimeoutMs, 5000, 90000, 45000),
    recommendationTimeoutMs: bounded(value.recommendationTimeoutMs, 10000, 180000, 90000),
    thinkingPolicy: ["DISABLED", "BOUNDED_RECOMMENDATION"].includes(value.thinkingPolicy)
      ? value.thinkingPolicy
      : "BOUNDED_RECOMMENDATION",
  };
}

function resolveModelFile(profile, modelDir) {
  const configuredRoot = String(modelDir || "").trim();
  const name = String(profile?.ggufFileName || "").trim();
  if (!configuredRoot || !/^[A-Za-z0-9._-]+\.gguf$/i.test(name)) {
    throw httpError(400, "AI_MODEL_PATH_DENIED", "Model harus berasal dari allowlist GGUF.");
  }
  const root = path.resolve(configuredRoot);
  const resolved = path.resolve(root, name);
  if (path.dirname(resolved) !== root) {
    throw httpError(400, "AI_MODEL_PATH_DENIED", "Model berada di luar allowlist.");
  }
  return resolved;
}

function listAllowlistedModelFiles(modelDir, fsImpl = fs) {
  const root = path.resolve(String(modelDir || ""));
  try {
    return fsImpl
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry?.isFile?.() && /^[A-Za-z0-9._-]+\.gguf$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function sha256(file, fsImpl = fs) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fsImpl.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function validateProfileInput(input = {}) {
  const profileCode = String(input.profileCode || "").trim().toUpperCase();
  const displayName = String(input.displayName || "").trim();
  const modelFamily = String(input.modelFamily || "").trim();
  const ggufFileName = String(input.ggufFileName || "").trim();
  const quantization = String(input.quantization || "").trim();
  const promptCompatibilityVersion = String(input.promptCompatibilityVersion || "").trim();
  if (!/^[A-Z0-9][A-Z0-9_-]{2,63}$/.test(profileCode)) {
    throw httpError(400, "AI_PROFILE_CODE_INVALID", "Kode profile model tidak valid.");
  }
  if (!displayName || !modelFamily || !quantization || !promptCompatibilityVersion) {
    throw httpError(400, "AI_PROFILE_REQUIRED_FIELDS", "Informasi profile model belum lengkap.");
  }
  getPrompt(promptCompatibilityVersion);
  return {
    profileCode,
    displayName,
    modelFamily,
    ggufFileName,
    quantization,
    promptCompatibilityVersion,
    runtimeConfig: validateRuntimeConfig(input.runtimeConfig),
  };
}

function assertBenchmarkPassed(profile) {
  const result = profile?.benchmarkResult || {};
  const failed = REQUIRED_BENCHMARK_GATES.filter((key) => result[key] !== true);
  if (failed.length) {
    throw httpError(
      409,
      "AI_PROFILE_BENCHMARK_REQUIRED",
      `Profile belum lulus gate: ${failed.join(", ")}.`
    );
  }
}

function createModelProfileService({
  prisma,
  modelDir = process.env.AI_MODEL_DIR,
  fs: fsImpl = fs,
  runtime,
  now = () => new Date(),
} = {}) {
  if (!prisma?.aiModelProfile) throw new TypeError("Prisma aiModelProfile delegate wajib tersedia.");
  const runtimeAdapter = runtime || {
    probe: async () => {
      throw httpError(503, "AI_RUNTIME_OFFLINE", "Runtime AI belum tersedia.");
    },
  };

  function listFiles() {
    return listAllowlistedModelFiles(modelDir, fsImpl);
  }

  function runtimeProfile(profile) {
    const resolvedModelPath = resolveModelFile(profile, modelDir);
    if (!fsImpl.existsSync(resolvedModelPath)) {
      throw httpError(404, "AI_MODEL_FILE_NOT_FOUND", "File GGUF tidak ditemukan pada model directory.");
    }
    return {
      ...profile,
      resolvedModelPath,
      runtimeConfig: validateRuntimeConfig(profile.runtimeConfig),
    };
  }

  async function listModelProfiles() {
    return prisma.aiModelProfile.findMany({ orderBy: [{ status: "asc" }, { profileCode: "asc" }] });
  }

  async function createModelProfile(input, actor) {
    const data = validateProfileInput(input);
    const resolvedModelPath = resolveModelFile(data, modelDir);
    if (!listFiles().includes(data.ggufFileName) || !fsImpl.existsSync(resolvedModelPath)) {
      throw httpError(404, "AI_MODEL_FILE_NOT_FOUND", "Pilih file GGUF dari model directory.");
    }
    return prisma.aiModelProfile.create({
      data: {
        ...data,
        sha256: await sha256(resolvedModelPath, fsImpl),
        status: PROFILE_STATUS.DRAFT,
        createdBy: normalizeActor(actor),
      },
    });
  }

  async function recordProfileTest(id, result, actor) {
    const current = await prisma.aiModelProfile.findUnique({ where: { id } });
    if (!current) throw httpError(404, "AI_PROFILE_NOT_FOUND", "Profile model tidak ditemukan.");
    const passed = REQUIRED_BENCHMARK_GATES.every((key) => result?.[key] === true);
    return prisma.aiModelProfile.update({
      where: { id },
      data: {
        benchmarkResult: { ...result, testedBy: normalizeActor(actor), testedAt: now().toISOString() },
        status: passed ? PROFILE_STATUS.INACTIVE : PROFILE_STATUS.FAILED,
      },
    });
  }

  async function testModelProfile(id, actor) {
    const profile = await prisma.aiModelProfile.findUnique({ where: { id } });
    if (!profile) throw httpError(404, "AI_PROFILE_NOT_FOUND", "Profile model tidak ditemukan.");
    await prisma.aiModelProfile.update({ where: { id }, data: { status: PROFILE_STATUS.TESTING } });
    try {
      const result = await runtimeAdapter.probe(runtimeProfile(profile));
      return recordProfileTest(id, result, actor);
    } catch (error) {
      await prisma.aiModelProfile.update({
        where: { id },
        data: {
          status: PROFILE_STATUS.FAILED,
          benchmarkResult: {
            modelLoadPass: false,
            errorCode: String(error?.code || "AI_PROFILE_TEST_FAILED"),
            testedBy: normalizeActor(actor),
            testedAt: now().toISOString(),
          },
        },
      });
      throw error;
    }
  }

  async function activateModelProfile(id, actor) {
    const candidate = await prisma.aiModelProfile.findUnique({ where: { id } });
    if (!candidate) throw httpError(404, "AI_PROFILE_NOT_FOUND", "Profile model tidak ditemukan.");
    if (candidate.status === PROFILE_STATUS.ACTIVE) return candidate;
    assertBenchmarkPassed(candidate);
    await runtimeAdapter.probe(runtimeProfile(candidate));
    const previous = await prisma.aiModelProfile.findFirst({
      where: { status: PROFILE_STATUS.ACTIVE, id: { not: id } },
    });
    return prisma.$transaction(async (tx) => {
      await tx.aiModelProfile.updateMany({
        where: { status: PROFILE_STATUS.ACTIVE, id: { not: id } },
        data: { status: PROFILE_STATUS.INACTIVE },
      });
      return tx.aiModelProfile.update({
        where: { id },
        data: {
          status: PROFILE_STATUS.ACTIVE,
          rollbackProfileId: previous?.id || null,
          activatedBy: normalizeActor(actor),
          activatedAt: now(),
        },
      });
    });
  }

  async function rollbackModelProfile(activeId, actor) {
    const current = await prisma.aiModelProfile.findUnique({ where: { id: activeId } });
    if (!current || current.status !== PROFILE_STATUS.ACTIVE) {
      throw httpError(409, "AI_PROFILE_NOT_ACTIVE", "Profile aktif tidak ditemukan.");
    }
    if (!current.rollbackProfileId) {
      throw httpError(409, "AI_ROLLBACK_PROFILE_MISSING", "Profile rollback belum tersedia.");
    }
    const target = await prisma.aiModelProfile.findUnique({ where: { id: current.rollbackProfileId } });
    if (!target) throw httpError(404, "AI_ROLLBACK_PROFILE_MISSING", "Profile rollback tidak ditemukan.");
    assertBenchmarkPassed(target);
    await runtimeAdapter.probe(runtimeProfile(target));
    return prisma.$transaction(async (tx) => {
      await tx.aiModelProfile.update({ where: { id: current.id }, data: { status: PROFILE_STATUS.INACTIVE } });
      return tx.aiModelProfile.update({
        where: { id: target.id },
        data: {
          status: PROFILE_STATUS.ACTIVE,
          rollbackProfileId: current.id,
          activatedBy: normalizeActor(actor),
          activatedAt: now(),
        },
      });
    });
  }

  return {
    listAllowlistedModelFiles: listFiles,
    listModelProfiles,
    createModelProfile,
    recordProfileTest,
    testModelProfile,
    activateModelProfile,
    rollbackModelProfile,
  };
}

module.exports = {
  PROFILE_STATUS,
  REQUIRED_BENCHMARK_GATES,
  resolveModelFile,
  listAllowlistedModelFiles,
  validateRuntimeConfig,
  validateProfileInput,
  assertBenchmarkPassed,
  sha256,
  createModelProfileService,
};
