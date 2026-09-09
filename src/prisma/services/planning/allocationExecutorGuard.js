"use strict";
const { resolveRoutingExecutionPolicy, loadRoutingExecutionContext, executionPolicyErrorsForSelection } = require("./routingExecutionPolicy");
const mode = value => String(value || "INHOUSE").toUpperCase();
const reject = (message, code = "EXECUTOR_USE_CHANGE_ACTION") => { throw Object.assign(new Error(message), { statusCode: 409, code }); };

function assertSameAllocationExecutor(source, request = {}) {
  const targetMode = mode(request.routingMode ?? source.routingMode);
  const vendorId = request.vendorId === undefined ? source.vendorId : request.vendorId;
  if (targetMode !== mode(source.routingMode) || targetMode === "VENDOR" && String(vendorId || "") !== String(source.vendorId || "")) {
    reject("Gunakan Ubah Pelaksana pada Monthly Plan untuk mengganti in-house/vendor atau vendor pelaksana, agar dampak dokumen dan Replan diperiksa.");
  }
}

async function assertNewAllocationExecutor(db, route, request, { period = {}, existing = null } = {}) {
  if (existing) assertSameAllocationExecutor(existing, request);
  const selectedMode = mode(request.routingMode);
  if (!["INHOUSE", "VENDOR"].includes(selectedMode)) reject("Pelaksana allocation harus INHOUSE atau VENDOR.", "EXECUTOR_MODE_NOT_ALLOWED");
  const configured = route.machinePlanningPolicy?.execution !== undefined;
  const configuredMachine = selectedMode === "INHOUSE" && Boolean(route.machinePlanningPolicy?.primaryMachineId || route.machinePlanningPolicy?.resources?.length || route.machinePlanningPolicy?.mode === "PARALLEL");
  if (!configured) {
    // Keep established same-executor scheduling of existing legacy allocations.
    if (existing && !configuredMachine) return { route, resource: null };
    if (!existing && (selectedMode !== mode(route.routingMode) || selectedMode === "VENDOR" && request.vendorId !== route.vendorId)) reject("Pelaksana ini belum diizinkan pada BOM. Atur alternatif BOM lalu gunakan Ubah Pelaksana.", "EXECUTOR_MODE_NOT_ALLOWED");
    if (selectedMode === "INHOUSE" && !configuredMachine) return { route, resource: null };
  }
  const masters = await loadRoutingExecutionContext(db);
  const policy = resolveRoutingExecutionPolicy(route, { ...masters, period });
  const errors = executionPolicyErrorsForSelection(policy, [{ ...request, routingMode: selectedMode }]);
  const resource = selectedMode === "INHOUSE" ? policy.machinePolicy?.resources.find(row => row.machineId === request.machineId) : null;
  if (selectedMode === "INHOUSE" && !resource) errors.push("Mesin belum termasuk mesin utama/cadangan yang dikualifikasi pada BOM.");
  if (request.diesId && resource && request.diesId !== resource.diesId) errors.push("Dies/jig harus mengikuti pasangan mesin yang dikualifikasi pada BOM.");
  if (errors.length) reject([...new Set(errors)].join(" "), "EXECUTOR_POLICY_INVALID");
  return { route: selectedMode === "INHOUSE" ? policy.inhouseRoute : route, resource, policy };
}

module.exports = { assertSameAllocationExecutor, assertNewAllocationExecutor };
