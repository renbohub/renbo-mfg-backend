const ASSEMBLY_POLICIES = new Set(["INLINE", "SUB_ASSEMBLY"]);
const ASSEMBLY_POLICY_OVERRIDES = new Set(["DEFAULT", "INLINE", "SUB_ASSEMBLY"]);

function normalizeAssemblyPolicy(value, fallback = "INLINE") {
  const normalized = String(value || "").trim().toUpperCase();
  return ASSEMBLY_POLICIES.has(normalized) ? normalized : fallback;
}

function normalizeAssemblyPolicyOverride(value, fallback = "DEFAULT") {
  const normalized = String(value || "").trim().toUpperCase();
  return ASSEMBLY_POLICY_OVERRIDES.has(normalized) ? normalized : fallback;
}

function resolveAssemblyPolicy(detail = {}) {
  const override = normalizeAssemblyPolicyOverride(detail.assemblyPolicyOverride);
  if (override !== "DEFAULT") return override;

  const partPolicy = normalizeAssemblyPolicy(detail.part?.assemblyPolicy, null);
  if (partPolicy) return partPolicy;

  // Backward-compatible default for existing FG MBOM detail behavior.
  const itemType = String(detail.part?.itemType || "").trim().toUpperCase();
  const category = String(detail.category || "").trim();
  if (itemType === "FG" && category === "inHouse") return "SUB_ASSEMBLY";

  return "INLINE";
}

function isSubAssemblyDetail(detail = {}) {
  return resolveAssemblyPolicy(detail) === "SUB_ASSEMBLY";
}

module.exports = {
  ASSEMBLY_POLICIES,
  ASSEMBLY_POLICY_OVERRIDES,
  normalizeAssemblyPolicy,
  normalizeAssemblyPolicyOverride,
  resolveAssemblyPolicy,
  isSubAssemblyDetail,
};
