const { assertQuantity } = require("../../utils/uomQuantity");

const normalize = (value) => String(value ?? "").trim();

function activeMbomWhere(at = new Date()) {
  return {
    isDeleted: false,
    OR: [{ effectiveDate: null }, { effectiveDate: { lte: at } }],
    AND: [{ OR: [{ expiryDate: null }, { expiryDate: { gte: at } }] }],
  };
}

const sourceInclude = {
  part: {
    include: {
      material: true,
    },
  },
  mbomHeader: {
    include: {
      part: {
        select: { partCode: true, partNumber: true, partName: true },
      },
    },
  },
  materialForm: {
    select: { id: true, formCode: true, formName: true, symbol: true },
  },
  alternateMaterialForm: {
    select: { id: true, formCode: true, formName: true, symbol: true },
  },
};

function eligibleSourceWhere(at = new Date()) {
  return {
    isDeleted: false,
    grossWeight: { gt: 0 },
    part: {
      isDeleted: false,
      itemType: { equals: "RAW", mode: "insensitive" },
      rawType: { equals: "MATERIAL", mode: "insensitive" },
      material: { isDeleted: false },
    },
    mbomHeader: activeMbomWhere(at),
  };
}

function mapSource(detail) {
  const material = detail.part?.material;
  const activeForm = detail.materialScheme === "ALTERNATIVE"
    ? detail.alternateMaterialForm
    : detail.materialForm;
  return {
    mbomDetailId: detail.id,
    mbomNoReg: detail.noReg,
    mbomRevision: detail.mbomHeader?.revision ?? null,
    parentPartCode: detail.mbomHeader?.part?.partCode || null,
    parentPartNumber: detail.mbomHeader?.part?.partNumber || null,
    parentPartName: detail.mbomHeader?.part?.partName || null,
    sourcePartId: detail.part?.id || null,
    sourcePartCode: detail.part?.partCode || null,
    sourcePartNumber: detail.part?.partNumber || null,
    sourcePartName: detail.part?.partName || null,
    sourceUomCode: "PCS",
    grossWeightKgPerPcs: Number(detail.grossWeight || 0),
    materialScheme: detail.materialScheme || "DEFAULT",
    materialFormId: activeForm?.id || null,
    materialFormCode: activeForm?.formCode || null,
    materialFormName: activeForm?.formName || null,
    materialFormSymbol: activeForm?.symbol || null,
    materialId: material?.id || null,
    materialCode: material?.materialCode || null,
    materialName: material?.materialName || material?.spec || null,
    materialType: material?.materialType || null,
    materialSpec: material?.spec || null,
    materialThickness: material?.thickness ?? detail.materialThickness ?? null,
    materialWidth: material?.width ?? detail.materialWidth ?? null,
    materialCSP: material?.CSP || activeForm?.symbol || null,
  };
}

async function listMaterialPieceSources(tx, { at = new Date(), q = "" } = {}) {
  const normalizedQuery = normalize(q).toLowerCase();
  const details = await tx.mBOMDetail.findMany({
    where: eligibleSourceWhere(at),
    include: sourceInclude,
    orderBy: [{ updatedAt: "desc" }],
  });
  return details
    .map(mapSource)
    .filter((source) => source.materialId && source.materialCode)
    .filter((source) => !normalizedQuery || [
      source.sourcePartCode,
      source.sourcePartNumber,
      source.sourcePartName,
      source.materialCode,
      source.materialName,
      source.mbomNoReg,
      source.parentPartCode,
    ].some((value) => String(value || "").toLowerCase().includes(normalizedQuery)));
}

async function resolveMaterialPieceConversion(tx, input, { at = new Date() } = {}) {
  const mbomDetailId = normalize(input.mbomDetailId || input.sourceMbomDetailId);
  const sourcePartCode = normalize(input.sourcePartCode);
  if (!mbomDetailId && !sourcePartCode) {
    const error = new Error("Part sumber PCS dan referensi BOM wajib dipilih.");
    error.statusCode = 400;
    throw error;
  }
  const sourceQtyPcs = Number(input.sourceQtyPcs);
  if (!Number.isFinite(sourceQtyPcs) || sourceQtyPcs <= 0) {
    const error = new Error("Qty sumber PCS harus berupa angka lebih besar dari 0.");
    error.statusCode = 400;
    throw error;
  }
  assertQuantity(sourceQtyPcs, "PCS", "Qty sumber PCS");

  const candidates = await tx.mBOMDetail.findMany({
    where: {
      ...eligibleSourceWhere(at),
      ...(mbomDetailId ? { id: mbomDetailId } : { part: { ...eligibleSourceWhere(at).part, partCode: sourcePartCode } }),
    },
    include: sourceInclude,
    orderBy: [{ updatedAt: "desc" }],
    take: mbomDetailId ? 1 : 2,
  });
  if (!candidates.length) {
    const error = new Error("Konversi PCS ke KG tidak ditemukan. Pastikan Part bertipe RAW MATERIAL, terhubung ke Material Master, dan gross weight BOM aktif lebih dari nol.");
    error.statusCode = 409;
    throw error;
  }
  if (!mbomDetailId && candidates.length > 1) {
    const error = new Error("Part memiliki lebih dari satu referensi gross weight BOM. Pilih referensi BOM secara spesifik.");
    error.statusCode = 409;
    throw error;
  }
  const source = mapSource(candidates[0]);
  if (sourcePartCode && source.sourcePartCode !== sourcePartCode) {
    const error = new Error("Part sumber tidak sesuai dengan referensi BOM yang dipilih.");
    error.statusCode = 409;
    throw error;
  }
  if (!source.materialId || !source.materialCode) {
    const error = new Error("Part sumber belum terhubung ke Material Master.");
    error.statusCode = 409;
    throw error;
  }
  const convertedQtyKg = Math.round(sourceQtyPcs * source.grossWeightKgPerPcs * 1e9) / 1e9;
  if (!(convertedQtyKg > 0)) {
    const error = new Error("Hasil konversi KG tidak valid. Periksa gross weight BOM.");
    error.statusCode = 409;
    throw error;
  }
  return { ...source, sourceQtyPcs, convertedQtyKg, targetUomCode: "KG" };
}

module.exports = {
  listMaterialPieceSources,
  resolveMaterialPieceConversion,
};
