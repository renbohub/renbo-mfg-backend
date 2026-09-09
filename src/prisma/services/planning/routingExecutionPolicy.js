"use strict";

const { resolveRoutingMachinePolicy } = require("./routingMachinePolicy");
const MODES = ["INHOUSE", "VENDOR"];
const unique = (values) => [...new Set(values.filter(Boolean))];
const active = (row) => row && !row.isDeleted && row.status === "Active";

function inhouseRouteForExecution(route) {
  if (!route) return null;
  if (String(route.routingMode || "INHOUSE").toUpperCase() !== "VENDOR") return route;
  const execution = route.machinePlanningPolicy?.execution;
  if (!Array.isArray(execution?.allowedModes) || !execution.allowedModes.includes("INHOUSE")) return null;
  const alternate = execution.inhouse || {};
  const machinePlanningPolicy = { ...alternate.machinePlanningPolicy };
  delete machinePlanningPolicy.execution;
  return { ...route, routingMode: "INHOUSE", vendorId: null, machine: null,
    machineId: machinePlanningPolicy.primaryMachineId || null,
    machineSpecificationCode: alternate.machineSpecificationCode || null,
    cycleTime: Number(alternate.cycleTime || 0), diesId: alternate.diesId || null,
    machinePlanningPolicy };
}

// routingMode is the BOM default. Alternative execution is explicit, so older
// BOMs never gain permission to outsource or manufacture internally by inference.
// The nested inhouse route preserves tooling when the default is vendor (whose
// top-level machine fields are intentionally empty).
function resolveRoutingExecutionPolicy(route, context = {}) {
  const { machines = [], dies = [], vendors = [], vendorAssignments = [], vendorProcesses = [], processes = [], period = {} } = context;
  const defaultMode = String(route.routingMode || "INHOUSE").toUpperCase() === "VENDOR" ? "VENDOR" : "INHOUSE";
  const execution = route.machinePlanningPolicy?.execution;
  const configured = Boolean(execution && typeof execution === "object" && !Array.isArray(execution));
  const errors = [];
  if (execution != null && !configured) errors.push("Aturan pelaksana BOM harus berupa objek yang valid.");
  if (configured && (!Array.isArray(execution.allowedModes) || execution.allowedModes.some(mode => !MODES.includes(mode)))) errors.push("Pilihan pelaksana yang diizinkan harus INHOUSE atau VENDOR.");
  if (configured && (!Array.isArray(execution.allowedModes) || !execution.allowedModes.includes(defaultMode))) errors.push("Pelaksana default harus termasuk pilihan yang diizinkan.");
  const allowedModes = unique([defaultMode, ...(Array.isArray(execution?.allowedModes) ? execution.allowedModes.filter(mode => MODES.includes(mode)) : [])]);
  const allowSplit = execution?.allowSplit === true && allowedModes.length === 2;
  if (execution?.allowSplit === true && !allowSplit) errors.push("Pembagian qty membutuhkan izin untuk in-house dan vendor.");
  if (configured && execution.vendorIds != null && (!Array.isArray(execution.vendorIds) || execution.vendorIds.some(id => typeof id !== "string" || !id.trim()))) errors.push("Daftar vendor alternatif belum valid.");
  const requestedVendorIds = unique([...(defaultMode === "VENDOR" ? [route.vendorId] : []), ...(Array.isArray(execution?.vendorIds) ? execution.vendorIds.filter(id => typeof id === "string" && id.trim()) : [])]);
  const globalErrors = [...errors];
  const errorsByMode = { INHOUSE: [], VENDOR: [] };
  const errorsByVendor = {};
  const process = processes.find(item => item.id === route.processId) || route.process;
  const processCode = process?.isDeleted ? "" : String(process?.processCode || "").toUpperCase();
  const eligibleVendorIds = [];
  if (allowedModes.includes("VENDOR")) {
    if (!requestedVendorIds.length) errorsByMode.VENDOR.push("Pilih minimal satu vendor yang diizinkan untuk proses ini.");
    if (defaultMode === "VENDOR" && !route.vendorId) errorsByMode.VENDOR.push("Vendor default belum dipilih.");
    for (const vendorId of requestedVendorIds) {
      const vendor = vendors.find(item => item.id === vendorId);
      const qualified = vendorAssignments.some(assignment => {
        const master = assignment.vendorProcess || vendorProcesses.find(item => item.id === assignment.vendorProcessId);
        return assignment.vendorId === vendorId && assignment.entityType === "vendor" && !master?.isDeleted &&
          processCode && String(master?.vendorProcessCode || "").toUpperCase() === processCode;
      });
      if (!active(vendor) || !qualified) errorsByVendor[vendorId] = [`Vendor ${vendor?.vendorCode || vendorId} tidak aktif atau belum diizinkan untuk proses ${processCode || "terpilih"}.`];
      else eligibleVendorIds.push(vendorId);
    }
  }
  let inhouseRoute = null;
  let machinePolicy = null;
  if (allowedModes.includes("INHOUSE")) {
    const alternate = execution?.inhouse || {};
    const machinePlanningPolicy = { ...(defaultMode === "INHOUSE" ? route.machinePlanningPolicy : alternate.machinePlanningPolicy) };
    delete machinePlanningPolicy.execution;
    inhouseRoute = defaultMode === "INHOUSE" ? { ...route, machinePlanningPolicy } : {
      ...route, routingMode: "INHOUSE", vendorId: null, machine: null,
      machineId: machinePlanningPolicy.primaryMachineId || null,
      machineSpecificationCode: alternate.machineSpecificationCode || null,
      cycleTime: Number(alternate.cycleTime || 0), diesId: alternate.diesId || null,
      machinePlanningPolicy,
    };
    machinePolicy = resolveRoutingMachinePolicy(inhouseRoute, machines, dies, period);
    errorsByMode.INHOUSE.push(...machinePolicy.errors);
  }
  return { configured, defaultMode, allowedModes, allowSplit, eligibleVendorIds, inhouseRoute, machinePolicy,
    globalErrors, errorsByMode, errorsByVendor,
    errors: unique([...globalErrors, ...errorsByMode.INHOUSE, ...errorsByMode.VENDOR, ...Object.values(errorsByVendor).flat()]) };
}

function executionPolicyErrorsForSelection(policy, allocations) {
  // All errors remain available to BOM maintenance, but an unavailable default
  // must not prevent PPIC selecting a healthy, explicitly approved alternative.
  if (!policy.errorsByMode) return policy.errors || [];
  const errors = [...(policy.globalErrors || [])];
  for (const mode of unique(allocations.map(row => String(row.routingMode || "INHOUSE").toUpperCase()))) {
    if (!policy.allowedModes.includes(mode)) errors.push("Pelaksana belum diizinkan pada Routing BOM.");
    errors.push(...(policy.errorsByMode[mode] || []));
  }
  for (const row of allocations.filter(row => String(row.routingMode).toUpperCase() === "VENDOR")) {
    errors.push(...(policy.errorsByVendor[row.vendorId] || []));
    if (!policy.eligibleVendorIds.includes(row.vendorId)) errors.push("Vendor yang dipilih belum dikualifikasi pada Routing BOM.");
  }
  return unique(errors);
}

async function loadRoutingExecutionContext(db) {
  const [machines, dies, vendors, vendorAssignments, processes] = await Promise.all([
    db.machine.findMany({ where: { isDeleted: false } }),
    db.dies.findMany({ where: { isDeleted: false }, include: { diesParts: true } }),
    db.vendor.findMany({ where: { isDeleted: false } }),
    db.entityVendorProcess.findMany({ where: { entityType: "vendor" }, include: { vendorProcess: true } }),
    db.process.findMany({ where: { isDeleted: false } }),
  ]);
  return { machines, dies, vendors, vendorAssignments, processes };
}

module.exports = { resolveRoutingExecutionPolicy, loadRoutingExecutionContext, inhouseRouteForExecution, executionPolicyErrorsForSelection };
