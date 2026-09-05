"use strict";

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function issue(code, message, detail = {}, severity = "ERROR") {
  return { code, severity, message, ...detail };
}

function validateBomGraphStructure(header = {}) {
  const details = (header.details || []).filter((row) => !row.isDeleted);
  const byId = new Map(details.map((row) => [String(row.id || row.clientKey), row]));
  const errors = [];
  const warnings = [];
  const normalizedLevels = {};
  const edgeKeys = new Map();

  for (const row of details) {
    const id = String(row.id || row.clientKey || "");
    const parentId = row.parentDetailId ? String(row.parentDetailId) : null;
    if (!id) errors.push(issue("BOM_DETAIL_ID_MISSING", "Detail MBOM tidak mempunyai identity yang stabil."));
    if (!(number(row.qty) > 0)) errors.push(issue("BOM_QTY_INVALID", `Qty ${row.part?.partCode || id} harus lebih dari 0.`, { detailId: id }));
    if (!row.partId && !row.part?.id) errors.push(issue("BOM_PART_MISSING", `Part pada detail ${id || "baru"} belum dipilih.`, { detailId: id }));
    if (!row.uomCode) errors.push(issue("BOM_UOM_MISSING", `UOM ${row.part?.partCode || id} belum ditentukan.`, { detailId: id }));
    if (parentId === id) errors.push(issue("BOM_SELF_PARENT", `${row.part?.partCode || id} tidak boleh menjadi parent dirinya sendiri.`, { detailId: id }));
    if (parentId && !byId.has(parentId)) errors.push(issue("BOM_PARENT_NOT_FOUND", `Parent ${parentId} untuk ${row.part?.partCode || id} tidak ditemukan pada revision yang sama.`, { detailId: id, parentDetailId: parentId }));
    const edgeKey = `${parentId || "ROOT"}|${row.partId || row.part?.id || "NO_PART"}|${String(row.category || "").toUpperCase()}|${row.uomCode || "NO_UOM"}`;
    const duplicate = edgeKeys.get(edgeKey);
    if (duplicate) warnings.push(issue("BOM_DUPLICATE_EDGE", `${row.part?.partCode || id} muncul lebih dari sekali di parent dan kategori yang sama; gabungkan qty atau bedakan operation scope.`, { detailId: id, duplicateOfDetailId: duplicate }, "WARNING"));
    else edgeKeys.set(edgeKey, id);
    const sequences = new Set();
    for (const process of (row.mbomProcesses || []).filter((item) => !item.isDeleted)) {
      const sequence = number(process.sequence);
      if (!(sequence > 0)) errors.push(issue("BOM_PROCESS_SEQUENCE_INVALID", `Sequence process ${row.part?.partCode || id} harus lebih dari 0.`, { detailId: id, processId: process.id || null }));
      if (sequences.has(sequence)) errors.push(issue("BOM_PROCESS_SEQUENCE_AMBIGUOUS", `Sequence ${sequence} pada ${row.part?.partCode || id} dipakai lebih dari sekali.`, { detailId: id, sequence }));
      sequences.add(sequence);
      const mode = String(process.routingMode || "INHOUSE").toUpperCase();
      if (mode === "VENDOR" && !process.vendorId && !process.vendor?.id) errors.push(issue("BOM_VENDOR_RESOURCE_MISSING", `Vendor process ${row.part?.partCode || id} belum memilih vendor.`, { detailId: id, processId: process.id || null }));
      if (mode !== "VENDOR" && !process.machineId && !process.machineSpecificationCode && !process.machine?.id) warnings.push(issue("BOM_MACHINE_RESOURCE_MISSING", `In-house process ${row.part?.partCode || id} belum mempunyai machine atau specification.`, { detailId: id, processId: process.id || null }, "WARNING"));
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function levelOf(id) {
    if (normalizedLevels[id] != null) return normalizedLevels[id];
    if (visiting.has(id)) {
      errors.push(issue("BOM_CYCLE", `Cycle parent-child terdeteksi pada detail ${id}.`, { detailId: id }));
      return 0;
    }
    visiting.add(id);
    const row = byId.get(id);
    const parentId = row?.parentDetailId ? String(row.parentDetailId) : null;
    const level = parentId && byId.has(parentId) ? levelOf(parentId) + 1 : 0;
    normalizedLevels[id] = level;
    visiting.delete(id);
    visited.add(id);
    if (row && number(row.levelComponent) !== level) warnings.push(issue("BOM_LEVEL_NORMALIZED", `Level ${row.part?.partCode || id} seharusnya ${level}, bukan ${number(row.levelComponent)}.`, { detailId: id, currentLevel: number(row.levelComponent), expectedLevel: level }, "WARNING"));
    return level;
  }
  for (const id of byId.keys()) levelOf(id);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    issueCount: errors.length + warnings.length,
    roots: details.filter((row) => !row.parentDetailId).map((row) => row.id || row.clientKey),
    normalizedLevels,
    checkedAt: new Date().toISOString(),
  };
}

function assertBomGraphStructure(header = {}) {
  const validation = validateBomGraphStructure(header);
  if (!validation.valid) {
    const error = new Error(`Struktur MBOM ambigu/tidak valid: ${validation.errors.map((row) => row.message).join(" ")}`);
    error.statusCode = 409;
    error.code = "MBOM_GRAPH_AMBIGUOUS";
    error.validation = validation;
    throw error;
  }
  return validation;
}

async function selectAuthoritativeMbom(prisma, { partId, effectiveAt = new Date(), select, include } = {}) {
  const at = new Date(effectiveAt);
  const candidates = await prisma.mBOMHeader.findMany({
    where: {
      partId,
      isDeleted: false,
      AND: [
        { OR: [{ effectiveDate: null }, { effectiveDate: { lte: at } }] },
        { OR: [{ expiryDate: null }, { expiryDate: { gte: at } }] },
      ],
    },
    orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
    take: 2,
    ...(select ? { select } : {}),
    ...(include ? { include } : {}),
  });
  if (candidates.length > 1) {
    const error = new Error(`Lebih dari satu revision MBOM aktif untuk part ${partId} pada ${at.toISOString().slice(0, 10)}.`);
    error.statusCode = 409;
    error.code = "MBOM_ACTIVE_REVISION_AMBIGUOUS";
    error.candidates = candidates.map((row) => ({ id: row.id, noReg: row.noReg, revision: row.revision }));
    throw error;
  }
  return candidates[0] || null;
}

module.exports = { validateBomGraphStructure, assertBomGraphStructure, selectAuthoritativeMbom };
