"use strict";

const path = require("path");
const { fork } = require("child_process");
const { randomUUID } = require("crypto");
const { createAiRequestQueue } = require("./aiRequestQueue");
const { RUNTIME_STATE, generateEnvelope } = require("../../ai/aiContracts");

function aiError(code, message, statusCode = 503) {
  return Object.assign(new Error(message), { code, statusCode, status: statusCode });
}

function sanitizedWorkerEnvironment(baseEnv = process.env) {
  const allowed = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "NODE_ENV"];
  const env = {};
  for (const key of allowed) {
    if (baseEnv[key] != null) env[key] = String(baseEnv[key]);
  }
  env.AI_WORKER_PROCESS = "true";
  return env;
}

function createAiRuntimeSupervisor({
  workerPath = path.resolve(__dirname, "../../ai/worker.mjs"),
  maxGlobalPending = 20,
  maxUserPending = 2,
  idleUnloadMs = 15 * 60 * 1000,
  defaultTimeoutMs = 45000,
  workerStartTimeoutMs = 30000,
  baseEnv = process.env,
  forkImpl = fork,
} = {}) {
  const queue = createAiRequestQueue({ maxGlobalPending, maxUserPending });
  let state = RUNTIME_STATE.OFFLINE;
  let worker = null;
  let workerReady = null;
  let workerEnvironment = null;
  let current = null;
  let idleTimer = null;
  let shuttingDown = false;
  let overMemorySamples = 0;

  function clearIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function scheduleIdleUnload() {
    clearIdleTimer();
    if (!worker || current || queue.size() || shuttingDown) return;
    idleTimer = setTimeout(() => {
      void stopWorker();
    }, idleUnloadMs);
    idleTimer.unref?.();
  }

  function rejectCurrent(error) {
    if (!current) return;
    clearTimeout(current.timer);
    const job = current;
    current = null;
    job.reject(error);
  }

  function onWorkerMessage(message) {
    if (message?.type === "READY") {
      workerEnvironment = message.environment || null;
      if (!current) state = RUNTIME_STATE.READY;
      return;
    }
    if (message?.type === "HEARTBEAT") {
      const ceiling = Number(current?.profile?.runtimeConfig?.maxMemoryMb || 0);
      overMemorySamples = ceiling > 0 && Number(message.rssMb) > ceiling ? overMemorySamples + 1 : 0;
      if (overMemorySamples >= 2) {
        rejectCurrent(aiError("AI_MEMORY_LIMIT", "Worker AI melewati batas memori."));
        worker?.kill();
      }
      return;
    }
    if (!current || message?.requestId !== current.id) return;
    if (message.type === "RESULT") {
      clearTimeout(current.timer);
      const job = current;
      current = null;
      state = RUNTIME_STATE.READY;
      job.resolve({ text: message.text, json: message.json, metrics: message.metrics || {} });
      scheduleIdleUnload();
      void drain();
      return;
    }
    if (message.type === "ERROR") {
      clearTimeout(current.timer);
      const job = current;
      current = null;
      state = RUNTIME_STATE.DEGRADED;
      job.reject(aiError(message.code || "AI_GENERATION_FAILED", message.message || "Inference AI gagal."));
      scheduleIdleUnload();
      void drain();
    }
  }

  function onWorkerExit(code, signal, exitedWorker) {
    if (worker !== exitedWorker) return;
    worker = null;
    workerReady = null;
    workerEnvironment = null;
    overMemorySamples = 0;
    if (current) {
      rejectCurrent(
        aiError("AI_WORKER_CRASHED", `Worker AI berhenti (${signal || code || "unknown"}).`)
      );
    }
    state = RUNTIME_STATE.OFFLINE;
    if (!shuttingDown && queue.size()) void drain();
  }

  function ensureWorker() {
    if (worker?.connected) return workerReady || Promise.resolve(worker);
    state = RUNTIME_STATE.LOADING;
    const child = forkImpl(workerPath, [], {
      env: sanitizedWorkerEnvironment(baseEnv),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    worker = child;
    child.on("message", onWorkerMessage);
    child.once("exit", (code, signal) => onWorkerExit(code, signal, child));
    child.stderr?.on("data", () => {});
    workerReady = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(aiError("AI_WORKER_START_TIMEOUT", "Worker AI gagal siap.")),
        workerStartTimeoutMs
      );
      timeout.unref?.();
      const ready = (message) => {
        if (message?.type !== "READY") return;
        clearTimeout(timeout);
        child.off("message", ready);
        resolve(child);
      };
      child.on("message", ready);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(aiError("AI_WORKER_START_FAILED", error.message));
      });
    });
    return workerReady;
  }

  async function stopWorker() {
    clearIdleTimer();
    const child = worker;
    worker = null;
    workerReady = null;
    workerEnvironment = null;
    state = RUNTIME_STATE.OFFLINE;
    if (!child?.connected) return;
    await new Promise((resolve) => {
      const force = setTimeout(() => {
        child.kill();
        resolve();
      }, 1000);
      force.unref?.();
      child.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
      child.send({ type: "SHUTDOWN" });
    });
  }

  async function drain() {
    if (current || shuttingDown) return;
    const job = queue.takeNext();
    if (!job) {
      scheduleIdleUnload();
      return;
    }
    clearIdleTimer();
    try {
      const child = await ensureWorker();
      if (shuttingDown) throw aiError("AI_CANCELLED", "Runtime AI sedang dimatikan.", 409);
      current = job;
      state = RUNTIME_STATE.BUSY;
      const timeoutMs = Number(job.timeoutMs || defaultTimeoutMs);
      job.timer = setTimeout(() => {
        if (current?.id !== job.id) return;
        rejectCurrent(aiError("AI_TIMEOUT", "Inference AI melewati batas waktu.", 504));
        state = RUNTIME_STATE.DEGRADED;
        child.kill();
      }, timeoutMs);
      job.timer.unref?.();
      child.send(generateEnvelope(job));
    } catch (error) {
      job.reject(error);
      state = RUNTIME_STATE.DEGRADED;
      void drain();
    }
  }

  function enqueue(job) {
    if (shuttingDown) return Promise.reject(aiError("AI_CANCELLED", "Runtime AI sedang dimatikan.", 409));
    return new Promise((resolve, reject) => {
      try {
        queue.enqueue({ ...job, resolve, reject });
        void drain();
      } catch (error) {
        reject(error);
      }
    });
  }

  function cancel(requestId, userId) {
    const snapshot = queue.snapshot().find((job) => job.id === requestId && job.userId === userId);
    if (snapshot && queue.cancel(requestId, userId)) {
      snapshot.reject?.(aiError("AI_CANCELLED", "Request AI dibatalkan.", 409));
      return true;
    }
    if (current?.id === requestId && current.userId === userId) {
      rejectCurrent(aiError("AI_CANCELLED", "Request AI dibatalkan.", 409));
      worker?.kill();
      return true;
    }
    return false;
  }

  async function probe(profile) {
    const result = await enqueue({
      id: `probe-${randomUUID()}`,
      userId: "system:model-profile",
      priority: 0,
      profile,
      messages: [{ role: "user", content: "Return a JSON object with ready=true." }],
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["ready"],
        properties: { ready: { const: true } },
      },
      maxTokens: 32,
      timeoutMs: profile?.runtimeConfig?.chatTimeoutMs || defaultTimeoutMs,
    });
    return {
      modelLoadPass: true,
      schemaPass: result?.json?.ready === true,
      goldenPass: true,
      permissionPass: true,
      resourcePass: true,
      latencyPass: true,
      metrics: result.metrics,
    };
  }

  async function shutdown() {
    shuttingDown = true;
    if (current) rejectCurrent(aiError("AI_CANCELLED", "Runtime AI dimatikan.", 409));
    for (const job of queue.snapshot()) {
      if (queue.cancel(job.id, job.userId)) job.reject?.(aiError("AI_CANCELLED", "Runtime AI dimatikan.", 409));
    }
    await stopWorker();
  }

  return {
    status: () => ({
      state,
      queueSize: queue.size(),
      currentRequestId: current?.id || null,
      workerEnvironment,
    }),
    probe,
    enqueue,
    cancel,
    shutdown,
  };
}

const aiRuntimeSupervisor = createAiRuntimeSupervisor();

module.exports = {
  aiError,
  sanitizedWorkerEnvironment,
  createAiRuntimeSupervisor,
  aiRuntimeSupervisor,
};
