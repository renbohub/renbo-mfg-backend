"use strict";

const Ajv = require("ajv");
const { userHasPermission, normalizePermissionKey } = require("./permissionEvaluator");

function gatewayError(statusCode, code, message, details) {
  return Object.assign(new Error(message), { statusCode, status: statusCode, code, details });
}

function sanitizeForAudit(value, depth = 0) {
  if (depth > 8) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeForAudit(item, depth + 1));
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/password|secret|token|authorization|cookie|credential/i.test(key)) continue;
    result[key] = sanitizeForAudit(item, depth + 1);
  }
  return result;
}

function capArrays(value, maxRows, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.slice(0, maxRows).map((item) => capArrays(item, maxRows, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, capArrays(item, maxRows, depth + 1)]));
}

function allowTopLevelFields(value, allowlist) {
  if (!Array.isArray(allowlist) || !allowlist.length || !value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(allowlist.filter((key) => Object.prototype.hasOwnProperty.call(value, key)).map((key) => [key, value[key]]));
}

function contextMatchesRequirement(requirement = {}, pageContext = {}) {
  const expectedModule = normalizePermissionKey(requirement.moduleCode);
  const expectedPage = normalizePermissionKey(requirement.pageCode);
  const actualModule = normalizePermissionKey(pageContext.moduleCode);
  const actualPage = normalizePermissionKey(pageContext.pageCode);
  if (expectedModule && expectedModule !== "*" && actualModule !== expectedModule) return false;
  if (expectedPage && expectedPage !== "*" && actualPage !== expectedPage) return false;
  return true;
}

function createCapabilityGateway({ prisma, registry, auditStore, ajv = new Ajv({ allErrors: true, strict: true }) } = {}) {
  if (!registry) throw new TypeError("Capability registry wajib tersedia.");
  const store = auditStore || prisma?.aiCapabilityCall;
  if (!store?.create) throw new TypeError("AI capability audit store wajib tersedia.");
  const validators = new Map();

  function validatorsFor(definition) {
    if (!validators.has(definition.code)) {
      validators.set(definition.code, {
        input: ajv.compile(definition.inputSchema),
        output: ajv.compile(definition.outputSchema),
      });
    }
    return validators.get(definition.code);
  }

  async function writeAudit(data) {
    return store.create({ data: sanitizeForAudit(data) });
  }

  async function execute({ user, requestId, conversationId, capabilityCode, input = {}, pageContext = {} }) {
    const definition = registry.get(capabilityCode);
    if (!definition) throw gatewayError(404, "AI_CAPABILITY_NOT_FOUND", "Capability AI tidak ditemukan.");
    const startedAt = Date.now();
    const permissionContext = {
      userId: user?.id || null,
      roleCodes: (user?.effectiveRoles || []).map((role) => role.roleCode).filter(Boolean),
      moduleCode: pageContext.moduleCode || null,
      pageCode: pageContext.pageCode || null,
      recordKey: pageContext.recordKey || null,
      requirement: definition.permission,
    };
    try {
      if (!contextMatchesRequirement(definition.permission, pageContext) ||
          !userHasPermission(user, definition.permission, pageContext)) {
        throw gatewayError(403, "AI_CAPABILITY_FORBIDDEN", "Capability tidak diizinkan pada halaman atau role ini.");
      }
      const compiled = validatorsFor(definition);
      if (!compiled.input(input)) {
        throw gatewayError(400, "AI_CAPABILITY_INPUT_INVALID", "Parameter capability tidak valid.", compiled.input.errors);
      }
      const raw = await definition.execute({ prisma, input, user, pageContext });
      const output = capArrays(allowTopLevelFields(raw, definition.fieldAllowlist), definition.maxRows);
      if (!compiled.output(output)) {
        throw gatewayError(502, "AI_CAPABILITY_OUTPUT_INVALID", "Output capability tidak memenuhi kontrak.", compiled.output.errors);
      }
      await writeAudit({
        conversationId,
        requestId,
        capabilityCode: definition.code,
        operationClass: definition.operationClass,
        status: "COMPLETED",
        requestData: input,
        responseData: output,
        permissionContext,
        sourceRefs: output?.sources || [],
        durationMs: Date.now() - startedAt,
      });
      return output;
    } catch (error) {
      await writeAudit({
        conversationId,
        requestId,
        capabilityCode: definition.code,
        operationClass: definition.operationClass,
        status: "FAILED",
        requestData: input,
        responseData: null,
        permissionContext,
        sourceRefs: [],
        errorCode: error.code || "AI_CAPABILITY_FAILED",
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  return { execute };
}

module.exports = {
  gatewayError,
  sanitizeForAudit,
  capArrays,
  contextMatchesRequirement,
  createCapabilityGateway,
};
