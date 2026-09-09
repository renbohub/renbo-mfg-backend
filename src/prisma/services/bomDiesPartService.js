"use strict";

function processDiesIds(process) {
  const ids = [];
  // Also check saved alternative tooling: changing executor must not revive a
  // tool that belongs to another child part.
  for (const route of [process, process.machinePlanningPolicy?.execution?.inhouse].filter(Boolean)) {
    if (route.diesId) ids.push(route.diesId);
    const resources = route.machinePlanningPolicy?.resources;
    if (resources != null && !Array.isArray(resources)) {
      throw Object.assign(new Error("Daftar mesin/tooling BOM tidak valid."), { statusCode: 400 });
    }
    for (const resource of resources || []) if (resource?.diesId) ids.push(resource.diesId);
  }
  if (ids.some((id) => typeof id !== "string" || !id.trim())) {
    throw Object.assign(new Error("Pilihan dies BOM tidak valid."), { statusCode: 400 });
  }
  return [...new Set(ids)];
}

async function assertBomDiesPartRelations(db, detailId, processes) {
  const ids = [...new Set(processes.flatMap(processDiesIds))];
  if (!ids.length) return;
  // Resolve the actual persisted detail instead of trusting a process payload's partId.
  const detail = await db.mBOMDetail.findUnique({ where: { id: detailId }, select: { partId: true } });
  const allowed = detail?.partId ? await db.dies.findMany({
    where: { id: { in: ids }, isDeleted: false, status: "Active",
      diesParts: { some: { partId: detail.partId, isActive: true } } },
    select: { id: true },
  }) : [];
  if (ids.some((id) => !allowed.some((die) => die.id === id))) {
    throw Object.assign(new Error("Dies yang dipilih tidak aktif atau belum memiliki relasi aktif dengan child part pada baris BOM. Pilih ulang dies atau lengkapi Master Relasi Dies-Part."), { statusCode: 400 });
  }
}

module.exports = { processDiesIds, assertBomDiesPartRelations };
