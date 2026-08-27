"use strict";

const RUNTIME_STATE = Object.freeze({
  OFFLINE: "OFFLINE",
  LOADING: "LOADING_MODEL",
  READY: "READY",
  BUSY: "BUSY",
  DEGRADED: "DEGRADED",
});

const OPERATION_CLASS = Object.freeze({
  READ: "READ",
  ANALYZE: "ANALYZE",
  DRAFT: "DRAFT",
  FINAL_MUTATION: "FINAL_MUTATION",
});

function generateEnvelope(job) {
  return {
    type: "GENERATE",
    requestId: job.id,
    profile: job.profile,
    messages: job.messages,
    outputSchema: job.outputSchema,
    maxTokens: job.maxTokens || job.profile?.runtimeConfig?.maxTokens || 800,
    thinkingMode: job.thinkingMode || "disabled",
    seed: Number.isInteger(job.seed) ? job.seed : 42,
  };
}

module.exports = { RUNTIME_STATE, OPERATION_CLASS, generateEnvelope };
