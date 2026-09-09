"use strict";

// machineId on older BOMs is only a representative of the specification.
// Never promote that value to an engineering-approved primary machine.
function resolveRoutingMachinePolicy(route, machines, dies = [], period = {}) {
  const policy = route.machinePlanningPolicy || {};
  const specification = route.machineSpecificationCode || route.machine?.machineSpecificationCode;
  const eligible = machines.filter((m) => !m.isDeleted && m.status === "Active" &&
    (specification ? m.machineSpecificationCode === specification : m.id === route.machineId));
  const errors = [];
  const primaryMachineId = policy.primaryMachineId || (eligible.length === 1 ? eligible[0].id : null);
  const mode = policy.mode === "PARALLEL" ? "PARALLEL" : "SINGLE";
  const parallel = mode === "PARALLEL";
  const toolingRequired = parallel || policy.requiresTooling === true || /PRESS/i.test(specification || "");
  const configured = Array.isArray(policy.resources) ? policy.resources : [];
  const ids = parallel ? [primaryMachineId, ...configured.map((r) => r.machineId)] : [primaryMachineId];
  const machineIds = [...new Set(ids.filter(Boolean))];
  if (!primaryMachineId) errors.push("Pilih mesin utama pada Routing BOM; spesifikasi mesin saja belum cukup.");
  if (parallel && (!Number.isInteger(Number(policy.maxParallelMachines)) || Number(policy.maxParallelMachines) < 2 || machineIds.length < 2 || machineIds.length > Number(policy.maxParallelMachines))) {
    errors.push("Jumlah mesin paralel harus 2 atau lebih dan tidak melebihi batas paralel yang disetujui.");
  }
  if (parallel && !String(policy.approvalReference || "").trim()) errors.push("Isi referensi persetujuan engineering/PPIC untuk produksi paralel.");
  const qualifiedIds = [...new Set([primaryMachineId, ...configured.map((r) => r.machineId)].filter(Boolean))];
  const resources = qualifiedIds.map((machineId) => {
    const setting = configured.find((r) => r.machineId === machineId) || {};
    const machine = eligible.find((m) => m.id === machineId);
    if (!machine) errors.push(`Mesin ${machineId} tidak aktif atau tidak sesuai spesifikasi routing.`);
    const cycleTimeSeconds = Number(setting.cycleTimeSeconds ?? route.cycleTime);
    if (!(cycleTimeSeconds > 0) || !Number.isFinite(cycleTimeSeconds)) errors.push(`Lengkapi cycle time detik/pcs untuk mesin ${machine?.machineName || machineId}.`);
    const setupMinutes = Number(setting.setupMinutes || 0);
    if (!Number.isFinite(setupMinutes) || setupMinutes < 0) errors.push("Waktu setup harus angka non-negatif.");
    const diesId = setting.diesId || (machineId === primaryMachineId ? route.diesId : null) || null;
    const tool = dies.find((d) => d.id === diesId && !d.isDeleted && d.status === "Active");
    if (toolingRequired && !diesId) errors.push(`Lengkapi dies/jig fisik untuk mesin ${machine?.machineName || machineId}.`);
    if (diesId && !tool) errors.push(`Dies/jig ${diesId} tidak aktif atau tidak tersedia.`);
    const partId = route.mbomDetail?.partId;
    if (tool && partId && !(tool.diesParts || []).some((p) => p.partId === partId && p.isActive !== false)) errors.push(`Dies/jig ${tool.diesCode} belum dipetakan ke part routing.`);
    if (tool && partId && period.start && period.end && !(tool.diesParts || []).some((p) => p.partId === partId && p.isActive !== false && (!p.effectiveDate || new Date(p.effectiveDate) <= new Date(period.start)) && (!p.expiryDate || new Date(p.expiryDate) >= new Date(period.end)))) errors.push(`Masa berlaku relasi dies/jig ${tool.diesCode} belum mencakup periode plan; tinjau kualifikasi tooling.`);
    if (tool?.tonnage && machine?.tonnage && Number(tool.tonnage) > Number(machine.tonnage)) errors.push(`Tonnage dies/jig ${tool.diesCode} melebihi mesin ${machine.machineName || machineId}.`);
    return { machineId, diesId, cycleTimeSeconds, setupMinutes };
  });
  if (parallel && new Set(resources.map((r) => r.diesId).filter(Boolean)).size !== resources.length) errors.push("Paralel memerlukan dies/jig fisik berbeda untuk setiap mesin; satu dies tidak boleh digandakan.");
  return { mode, primaryMachineId, maxParallelMachines: parallel ? Number(policy.maxParallelMachines) : 1,
    source: policy.primaryMachineId ? "BOM_APPROVED" : "UNIQUE_MACHINE", resources, errors,
    automaticMachineIds: errors.length ? [] : machineIds };
}

module.exports = { resolveRoutingMachinePolicy };
