"use strict";

const ALLOWED_OPERATION_CLASSES = new Set(["READ", "ANALYZE", "DRAFT"]);

function registryError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 400, status: 400 });
}

function createCapabilityRegistry() {
  const definitions = new Map();

  function register(definition) {
    const code = String(definition?.code || "").trim();
    const operationClass = String(definition?.operationClass || "").trim().toUpperCase();
    if (operationClass === "FINAL_MUTATION") {
      throw registryError("AI_FINAL_MUTATION_DENIED", "AI tidak boleh mendaftarkan final mutation.");
    }
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/.test(code)) {
      throw registryError("AI_CAPABILITY_CODE_INVALID", "Kode capability tidak valid.");
    }
    if (!ALLOWED_OPERATION_CLASSES.has(operationClass)) {
      throw registryError("AI_OPERATION_CLASS_INVALID", "Operation class capability tidak valid.");
    }
    if (definitions.has(code)) throw new Error(`Capability duplicate: ${code}`);
    if (!definition.permission || !definition.inputSchema || !definition.outputSchema || typeof definition.execute !== "function") {
      throw registryError("AI_CAPABILITY_DEFINITION_INVALID", "Definisi capability belum lengkap.");
    }
    const stored = Object.freeze({
      ...definition,
      code,
      operationClass,
      maxRows: Math.min(Math.max(Number(definition.maxRows) || 100, 1), 500),
      fieldAllowlist: Object.freeze([...(definition.fieldAllowlist || [])]),
    });
    definitions.set(code, stored);
    return stored;
  }

  return {
    register,
    get: (code) => definitions.get(String(code || "")) || null,
    list: () => [...definitions.values()],
    has: (code) => definitions.has(String(code || "")),
  };
}

const capabilityRegistry = createCapabilityRegistry();
require("./capabilities/inventoryCapabilities").registerInventoryCapabilities(capabilityRegistry);
require("./capabilities/purchasingCapabilities").registerPurchasingCapabilities(capabilityRegistry);
require("./capabilities/productionCapabilities").registerProductionCapabilities(capabilityRegistry);
require("./capabilities/ppicCapabilities").registerPpicCapabilities(capabilityRegistry);
require("./capabilities/capacityCapabilities").registerCapacityCapabilities(capabilityRegistry);

module.exports = { ALLOWED_OPERATION_CLASSES, createCapabilityRegistry, capabilityRegistry };
