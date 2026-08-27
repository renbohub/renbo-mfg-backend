"use strict";
const DEFAULT_MODULES = ["planning-ppic", "inventory", "purchasing", "production"];
function csv(value, fallback = []) { const rows = String(value || "").split(",").map((row) => row.trim()).filter(Boolean); return rows.length ? rows : fallback; }
function createAiFeaturePolicy({ prisma, runtime, env = process.env } = {}) {
  async function isAiEnabled({ moduleCode, capabilityCode, user, requireRuntime = true } = {}) {
    if (String(env.AI_ASSISTANT_ENABLED || "false").toLowerCase() !== "true") return { enabled: false, reason: "FEATURE_DISABLED" };
    if (!user) return { enabled: false, reason: "USER_REQUIRED" };
    if (!csv(env.AI_ALLOWED_MODULES, DEFAULT_MODULES).includes(moduleCode)) return { enabled: false, reason: "MODULE_DISABLED" };
    const capabilities = csv(env.AI_ALLOWED_CAPABILITIES);
    if (capabilityCode && capabilities.length && !capabilities.includes(capabilityCode)) return { enabled: false, reason: "CAPABILITY_DISABLED" };
    const profile = await prisma.aiModelProfile.findFirst({ where: { status: "ACTIVE" }, select: { id: true, profileCode: true } });
    if (!profile) return { enabled: false, reason: "NO_ACTIVE_PROFILE" };
    const status = runtime?.status?.() || {};
    if (requireRuntime && ["FAILED", "DEGRADED"].includes(String(status.status || status.state || "").toUpperCase())) return { enabled: false, reason: "RUNTIME_UNHEALTHY", profile };
    return { enabled: true, reason: "READY", profile };
  }
  return { isAiEnabled };
}
module.exports = { createAiFeaturePolicy };
