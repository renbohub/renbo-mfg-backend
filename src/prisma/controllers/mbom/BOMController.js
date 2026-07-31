const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { convertNumericFields } = require("../../utils/numericConverter");
const { notificationHelper } = require("../../utils/notificationHelper");
const { normalizeAssemblyPolicyOverride } = require("../../utils/assemblyPolicy");
const { normalizeDurationUnit } = require("../../utils/duration");
const { generateConfiguredNumber } = require("../../services/numberingService");
const { queueDirtyPartCodes } = require("../../utils/mrpDirtyQueue");

// ============================================
// REUSABLE INCLUDES & QUERIES
// ============================================

// Include statement untuk MBOM Details dengan relasi lengkap
const MBOM_DETAIL_INCLUDE = {
  where: { isDeleted: false },
  include: {
    parentDetail: {
      include: {
        part: true,
      },
    },
    children: {
      where: { isDeleted: false },
      include: {
        part: true,
        uom: true,
      },
      orderBy: [{ levelComponent: "asc" }, { createdAt: "asc" }],
    },
    part: {
      include: {
        material: true,
        mbomHeaders: {
          where: { isDeleted: false },
          orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
          take: 1,
        },
        partBases: {
          where: { baseOn: 'Actual' },
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      },
    },
    uom: true,
    materialForm: true,
    alternateMaterialForm: true,
    mbomProcesses: {
      where: { isDeleted: false },
      include: {
        process: true,
        machine: true,
      },
      orderBy: { sequence: "asc" },
    },
  },
  orderBy: [{ levelComponent: "asc" }, { createdAt: "asc" }],
};

// Include statement lengkap untuk MBOM Header
const MBOM_HEADER_INCLUDE = {
  part: true,
  uom: true,
  details: MBOM_DETAIL_INCLUDE,
};

// Include statement untuk create/update (tanpa filter isDeleted di level details)
const MBOM_HEADER_INCLUDE_NO_FILTER = {
  part: true,
  uom: true,
  details: {
    include: {
      part: {
        include: {
          material: true,
          mbomHeaders: {
            where: { isDeleted: false },
            orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
            take: 1,
          },
          partBases: {
            where: { baseOn: 'Actual' },
            orderBy: { createdAt: 'desc' },
            take: 1
          }
        },
      },
      uom: true,
      materialForm: true,
      alternateMaterialForm: true,
      parentDetail: true,
      children: true,
      mbomProcesses: {
        include: {
          process: true,
          machine: true,
        },
      },
    },
  },
};

async function getSequenceInsertionPolicy(doc, db = prisma) {
  const [salesOrders, forecasts, mps] = await Promise.all([
    db.salesOrderDetail.count({
      where: { mbomHeaderId: doc.id, isDeleted: false, status: { not: "Cancelled" } },
    }),
    doc.partId
      ? db.forecastDetail.count({
        where: {
          partId: doc.partId,
          isDeleted: false,
          forecast: { is: { isDeleted: false, status: { not: "Obsolete" } } },
          OR: [{ M1Qty: { gt: 0 } }, { M2Qty: { gt: 0 } }, { M3Qty: { gt: 0 } }],
        },
      })
      : 0,
    db.mPSDetail.count({
      where: { mbomHeaderId: doc.id, isDeleted: false, status: { not: "Cancelled" } },
    }),
  ]);
  const locked = salesOrders > 0 || forecasts > 0 || mps > 0;
  return {
    locked,
    strategy: locked ? "INSERT_SLOT" : "SHIFT_MAIN_SEQUENCE",
    usage: { salesOrders, forecasts, mps },
  };
}

function getForeignKeyErrorMessage(error) {
  const target = `${error.meta?.field_name || error.meta?.constraint || error.message || ""}`;
  if (target.toLowerCase().includes("uom")) {
    return "UOM tidak valid atau belum terdaftar di master UOM.";
  }
  if (target.toLowerCase().includes("part")) {
    return "Part tidak valid atau belum terdaftar di master part.";
  }
  return "Foreign key constraint violated. Pastikan Part, Material, dan UOM yang direferensikan sudah ada.";
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function parseLocalDateField(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch.map(Number);
    return new Date(year, month - 1, day, 0, 0, 0, 0);
  }

  return new Date(trimmed);
}

function normalizeOptionalCode(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function calculateScrapFactorFromPartBase(partBase) {
  const grossWeight = Number(partBase?.grossWeight);
  if (!Number.isFinite(grossWeight) || grossWeight <= 0) return 0;

  const scrapWeightValue = Number(partBase?.scrapWeight);
  const netWeight = Number(partBase?.netWeight);
  let scrapWeight = 0;

  if (Number.isFinite(scrapWeightValue)) {
    scrapWeight = scrapWeightValue;
  } else if (Number.isFinite(netWeight)) {
    scrapWeight = Math.max(grossWeight - netWeight, 0);
  }

  return Math.round((scrapWeight / grossWeight) * 10000) / 100;
}

async function normalizeMBOMUomCodes(headerData, details) {
  const normalizedHeaderUom = normalizeOptionalCode(headerData.uomCode);
  const normalizedDetails = Array.isArray(details)
    ? details.map((detail) => ({
        ...detail,
        uomCode: normalizeOptionalCode(detail.uomCode),
      }))
    : details;

  const requestedCodes = [
    normalizedHeaderUom,
    ...(Array.isArray(normalizedDetails)
      ? normalizedDetails.map((detail) => detail.uomCode)
      : []),
  ].filter(Boolean);

  const uniqueCodes = [...new Set(requestedCodes)];
  if (uniqueCodes.length === 0) {
    return {
      headerData: { ...headerData, uomCode: normalizedHeaderUom },
      details: normalizedDetails,
    };
  }

  const uoms = await prisma.uom.findMany({
    where: {
      OR: uniqueCodes.map((uomCode) => ({
        uomCode: { equals: uomCode, mode: "insensitive" },
      })),
      isDeleted: false,
    },
    select: { uomCode: true },
  });

  const uomByLowerCode = new Map(
    uoms.map((uom) => [uom.uomCode.toLowerCase(), uom.uomCode])
  );
  const missingCodes = uniqueCodes.filter(
    (uomCode) => !uomByLowerCode.has(uomCode.toLowerCase())
  );

  if (missingCodes.length > 0) {
    const error = new Error(
      `UOM tidak valid atau belum terdaftar di master UOM: ${missingCodes.join(", ")}`
    );
    error.code = "INVALID_UOM";
    throw error;
  }

  return {
    headerData: {
      ...headerData,
      uomCode: normalizedHeaderUom
        ? uomByLowerCode.get(normalizedHeaderUom.toLowerCase())
        : null,
    },
    details: Array.isArray(normalizedDetails)
      ? normalizedDetails.map((detail) => ({
          ...detail,
          uomCode: detail.uomCode
            ? uomByLowerCode.get(detail.uomCode.toLowerCase())
            : null,
        }))
      : normalizedDetails,
  };
}

function getDetailReference(detail, index) {
  return detail.clientKey || detail.tempId || detail._key || detail.id || `__unsaved_${index}`;
}

function validateCreateMBOMDetailParentRefs(details = []) {
  const refSet = new Set(details.map((detail, index) => getDetailReference(detail, index)));
  const parentMap = new Map();

  details.forEach((detail, index) => {
    const ref = getDetailReference(detail, index);
    const parentRef = detail.parentDetailId || null;

    if (!parentRef) {
      parentMap.set(ref, null);
      return;
    }
    if (parentRef === ref) {
      throw badRequest("MBOM detail tidak boleh menjadi parent untuk dirinya sendiri.");
    }
    if (!refSet.has(parentRef)) {
      throw badRequest("Parent detail harus mengarah ke detail lain pada payload create MBOM yang sama.");
    }
    parentMap.set(ref, parentRef);
  });

  for (const [detailRef] of parentMap.entries()) {
    const visited = new Set([detailRef]);
    let parentRef = parentMap.get(detailRef);
    while (parentRef) {
      if (visited.has(parentRef)) {
        throw badRequest("Struktur MBOM detail tidak boleh membentuk cycle parent-child.");
      }
      visited.add(parentRef);
      parentRef = parentMap.get(parentRef);
    }
  }
}

function getDetailProcesses(detail) {
  return Array.isArray(detail.mbomProcesses)
    ? detail.mbomProcesses
    : Array.isArray(detail.processes)
      ? detail.processes
      : undefined;
}

function assignProcessRoutingNumbers(details) {
  if (!Array.isArray(details)) return details;

  const detailByRef = new Map();
  const operationsByDetail = new Map();
  const roots = [];

  details.forEach((detail, detailIndex) => {
    const detailRef = getDetailReference(detail, detailIndex);
    detailByRef.set(detailRef, { detail, detailIndex, detailRef });
    const operations = (getDetailProcesses(detail) || [])
      .map((process, processIndex) => ({ process, processIndex }))
      .filter((item) => item.process.processId && item.process.isDeleted !== true)
      .sort((a, b) => Number(a.process.sequence || 0) - Number(b.process.sequence || 0) || a.processIndex - b.processIndex)
      .map((item) => ({ ...item, detailIndex, detailRef, children: [] }));
    operationsByDetail.set(detailRef, operations);
  });

  const findAncestorLastOperation = (detail) => {
    const visited = new Set();
    let parentRef = detail.parentDetailId || null;
    while (parentRef && !visited.has(parentRef)) {
      visited.add(parentRef);
      const operations = operationsByDetail.get(parentRef) || [];
      if (operations.length) return operations[operations.length - 1];
      parentRef = detailByRef.get(parentRef)?.detail?.parentDetailId || null;
    }
    return null;
  };

  details.forEach((detail, detailIndex) => {
    const detailRef = getDetailReference(detail, detailIndex);
    const operations = operationsByDetail.get(detailRef) || [];
    if (!operations.length) return;
    for (let index = 1; index < operations.length; index += 1) {
      operations[index - 1].children.push(operations[index]);
    }
    const ancestor = findAncestorLastOperation(detail);
    if (ancestor) ancestor.children.push(operations[0]);
    else roots.push(operations[0]);
  });

  const compareOperations = (a, b) => a.detailIndex - b.detailIndex
    || Number(a.process.sequence || 0) - Number(b.process.sequence || 0)
    || a.processIndex - b.processIndex;
  const visited = new Set();
  const numberOperation = (operation, major, branchPath = []) => {
    if (!operation || visited.has(operation)) return;
    visited.add(operation);
    operation.process.routingNumber = [major, ...branchPath].join(".");
    operation.children.sort(compareOperations);
    if (operation.children.length === 1) {
      numberOperation(operation.children[0], major + 1, branchPath);
    } else if (operation.children.length > 1) {
      operation.children.forEach((child, index) => numberOperation(child, major + 1, [...branchPath, index + 1]));
    }
  };

  roots.sort(compareOperations);
  if (roots.length === 1) numberOperation(roots[0], 1);
  else roots.forEach((root, index) => numberOperation(root, 1, [index + 1]));
  return details;
}

async function assignProcessOccurrenceCodes(details, db = prisma) {
  if (!Array.isArray(details)) return details;
  const usages = [];
  details.forEach((detail, detailIndex) => (getDetailProcesses(detail) || []).forEach((process, processIndex) => {
    if (process.processId && process.isDeleted !== true) usages.push({ detailIndex, process, processIndex });
  }));
  const processIds = [...new Set(usages.map((item) => item.process.processId))];
  if (!processIds.length) return details;
  const masters = await db.process.findMany({ where: { id: { in: processIds }, isDeleted: false }, select: { id: true, processCode: true } });
  const codeById = new Map(masters.map((item) => [item.id, item.processCode]));
  const groups = new Map();
  usages.forEach((usage) => { if (!groups.has(usage.process.processId)) groups.set(usage.process.processId, []); groups.get(usage.process.processId).push(usage); });
  groups.forEach((items, processId) => {
    // Occurrence numbering follows the bottom-up BOM order: the deepest
    // detail receives -1, then the next level receives -2, etc.
    items.sort((a, b) => b.detailIndex - a.detailIndex || Number(a.process.sequence || 0) - Number(b.process.sequence || 0) || a.processIndex - b.processIndex);
    const processCode = codeById.get(processId);
    if (!processCode) throw badRequest("Master proses tidak ditemukan atau sudah nonaktif.");
    items.forEach((item, index) => { item.process.occurrenceCode = items.length === 1 ? processCode : `${processCode}-${index + 1}`; });
  });
  return details;
}

function prepareMBOMProcessData(process, noReg, mbomDetailId) {
  if (!process.processId) {
    throw badRequest("processId wajib diisi untuk MBOM process.");
  }

  return convertNumericFields({
    noReg,
    mbomDetailId,
    processId: process.processId,
    occurrenceCode: process.occurrenceCode || null,
    routingNumber: process.routingNumber || null,
    machineId: process.machineId || null,
    alternativeMachineIds: Array.isArray(process.alternativeMachineIds)
      ? [...new Set(process.alternativeMachineIds.filter(Boolean).filter((machineId) => machineId !== process.machineId))]
      : [],
    diesId: process.diesId || null,
    routingMode: String(process.routingMode || "INHOUSE").toUpperCase() === "VENDOR" ? "VENDOR" : "INHOUSE",
    vendorId: process.vendorId || null,
    sequence: process.sequence || 0,
    cycleTime: process.cycleTime || 0,
    notes: process.occurrenceCode || process.notes || null,
    isDeleted: process.isDeleted ?? false,
  }, ['sequence', 'cycleTime']);
}

async function syncMBOMDetailProcesses(tx, detailId, noReg, processes) {
  if (!Array.isArray(processes)) return;

  const existingProcesses = await tx.mBOMProcess.findMany({
    where: { mbomDetailId: detailId },
    select: { id: true },
  });
  const keepIds = processes.filter((process) => process.id).map((process) => process.id);
  const deleteIds = existingProcesses
    .map((process) => process.id)
    .filter((id) => !keepIds.includes(id));

  if (deleteIds.length > 0) {
    await tx.mBOMProcess.updateMany({
      where: { id: { in: deleteIds } },
      data: { isDeleted: true },
    });
  }

  for (const process of processes) {
    const processData = prepareMBOMProcessData(process, noReg, detailId);
    if (process.id) {
      await tx.mBOMProcess.update({
        where: { id: process.id },
        data: {
          ...processData,
          isDeleted: false,
        },
      });
    } else {
      await tx.mBOMProcess.create({ data: processData });
    }
  }
}

// Search query builder untuk MBOM (digunakan di list & autocomplete)
function buildMBOMSearchQuery(q) {
  return [
    { noReg: { contains: q, mode: "insensitive" } },
    { notes: { contains: q, mode: "insensitive" } },
    { part: { partCode: { contains: q, mode: "insensitive" } } },
    { part: { partNumber: { contains: q, mode: "insensitive" } } },
    { part: { partName: { contains: q, mode: "insensitive" } } },
    {
      details: {
        some: { part: { partCode: { contains: q, mode: "insensitive" } } },
      },
    },
    {
      details: {
        some: { part: { partNumber: { contains: q, mode: "insensitive" } } },
      },
    },
    {
      details: {
        some: { part: { partName: { contains: q, mode: "insensitive" } } },
      },
    },
    {
      details: {
        some: {
          part: { material: { materialCode: { contains: q, mode: "insensitive" } } },
        },
      },
    },
    {
      details: {
        some: {
          part: { material: { materialType: { contains: q, mode: "insensitive" } } },
        },
      },
    },
  ];
}

// Helper: Prepare MBOM Detail data untuk create/update dengan auto-calculate scrapFactor
async function prepareMBOMDetailData(detail, createdBy, options = {}) {
  const parentRelationMode = options.parentRelationMode || "create";
  const db = options.db || prisma;
  let scrapFactor = 0;
  let materialThickness = detail.materialThickness ?? null;
  let materialWidth = detail.materialWidth ?? null;
  let materialPitch = detail.materialPitch ?? null;
  let materialCavity = detail.materialCavity ?? null;
  let materialDensity = detail.materialDensity ?? null;
  let materialFormId = detail.materialFormId || null;
  const materialScheme = String(detail.materialScheme || "DEFAULT").trim().toUpperCase() === "ALTERNATIVE" ? "ALTERNATIVE" : "DEFAULT";
  let defaultGrossWeight = Math.max(Number(detail.defaultGrossWeight ?? detail.grossWeight ?? 0), 0);
  const alternateMaterialFormId = detail.alternateMaterialFormId || null;
  const alternateMaterialPitch = detail.alternateMaterialPitch ?? null;
  const alternateMaterialCavity = detail.alternateMaterialCavity
    ? Math.max(1, Math.round(Number(detail.alternateMaterialCavity)))
    : null;
  let alternateGrossWeight = Math.max(Number(detail.alternateGrossWeight || 0), 0);

  // Auto-calculate scrapFactor dari PartBase (baseOn='Actual').
  // Field ini sengaja diturunkan dari master part agar konsisten di create/update MBOM.
  if (detail.partId) {
    const rawPart = await db.part.findUnique({
      where: { id: detail.partId },
      select: {
        itemType: true,
        rawType: true,
        materialId: true,
        material: { select: { thickness: true, width: true, density: true } },
      },
    });
    if (rawPart?.itemType === "RAW" && rawPart.rawType === "MATERIAL" && rawPart.materialId) {
      materialThickness = rawPart.material?.thickness ?? materialThickness;
      materialWidth = rawPart.material?.width ?? materialWidth;
      materialDensity = rawPart.material?.density ?? materialDensity;
      if (!materialFormId) {
        throw badRequest("Material Form default wajib dipilih di BOM untuk raw material.");
      }
      const thickness = Number(materialThickness || 0); const width = Number(materialWidth || 0);
      const pitch = Number(materialPitch || 0); const cavity = Math.max(1, Number(materialCavity || 1)); const density = Number(materialDensity || 0);
      if (thickness > 0 && width > 0 && pitch > 0 && density > 0) defaultGrossWeight = thickness * width * pitch * density / cavity;
      const altPitch = Number(alternateMaterialPitch || 0);
      const altCavity = Math.max(1, Number(alternateMaterialCavity || 1));
      if (thickness > 0 && width > 0 && altPitch > 0 && density > 0) {
        alternateGrossWeight = thickness * width * altPitch * density / altCavity;
      }
    }
    const partBase = await db.partBase.findFirst({
      where: {
        partId: detail.partId,
        baseOn: 'Actual',
        grossWeight: { not: null, gt: 0 }
      },
      orderBy: { createdAt: 'desc' }
    });

    scrapFactor = calculateScrapFactorFromPartBase(partBase);
  }

  if (materialScheme === "ALTERNATIVE" && !(alternateGrossWeight > 0)) {
    throw badRequest("Skema material alternatif belum lengkap. Isi form, pitch, dan cavity sebelum dipakai untuk MRP.");
  }
  if (alternateMaterialFormId && alternateMaterialFormId === materialFormId) {
    throw badRequest("Material Form alternatif harus berbeda dari Material Form default.");
  }
  const grossWeight = materialScheme === "ALTERNATIVE" ? alternateGrossWeight : defaultGrossWeight;

  const data = convertNumericFields({
    levelComponent: detail.levelComponent || 0,
    partId: detail.partId || null,
    qty: detail.qty || 0,
    uomCode: detail.uomCode || null,
    category: detail.category || "Purchase",
    assemblyPolicyOverride: normalizeAssemblyPolicyOverride(detail.assemblyPolicyOverride, "DEFAULT"),
    scrapFactor: scrapFactor || 0,
    materialThickness,
    materialWidth,
    materialPitch,
    materialCavity: materialCavity ? Math.max(1, Math.round(Number(materialCavity))) : null,
    materialDensity,
    grossWeight,
    defaultGrossWeight,
    materialFormId,
    materialScheme,
    alternateMaterialFormId,
    alternateMaterialPitch,
    alternateMaterialCavity,
    alternateGrossWeight: alternateGrossWeight || null,
    leadTime: detail.leadTime || 0,
    leadTimeUnit: normalizeDurationUnit(detail.leadTimeUnit),
    createdBy: createdBy,
    notes: detail.notes,
    isDeleted: detail.isDeleted ?? false,
  }, [
    'levelComponent',
    'qty',
    'scrapFactor',
    'materialThickness',
    'materialWidth',
    'materialPitch',
    'materialCavity',
    'materialDensity',
    'grossWeight',
    'defaultGrossWeight',
    'alternateMaterialPitch',
    'alternateMaterialCavity',
    'alternateGrossWeight',
    'leadTime'
  ]);

  const hasParentDetailId = Object.prototype.hasOwnProperty.call(detail, "parentDetailId");
  if (parentRelationMode !== "none" && hasParentDetailId) {
    if (detail.parentDetailId) {
      data.parentDetail = { connect: { id: detail.parentDetailId } };
    } else if (parentRelationMode === "update") {
      data.parentDetail = { disconnect: true };
    }
  }

  return data;
}

async function validateMBOMDetailParents(mbomNoReg, details = [], currentDetails = []) {
  const parentIds = [
    ...new Set(
      details
        .map((detail) => detail.parentDetailId)
        .filter(Boolean)
    ),
  ];
  if (parentIds.length === 0) return;

  const parents = await prisma.mBOMDetail.findMany({
    where: { id: { in: parentIds }, noReg: mbomNoReg, isDeleted: false },
    select: { id: true },
  });
  const validParentIds = new Set(parents.map((parent) => parent.id));

  for (const detail of details) {
    if (!detail.parentDetailId) continue;
    if (detail.id && detail.id === detail.parentDetailId) {
      throw badRequest("MBOM detail tidak boleh menjadi parent untuk dirinya sendiri.");
    }
    if (!validParentIds.has(detail.parentDetailId)) {
      throw badRequest("parentDetailId harus mengarah ke detail aktif pada MBOM yang sama.");
    }
  }

  const parentMap = new Map(
    currentDetails.map((detail) => [detail.id, detail.parentDetailId || null])
  );
  for (const detail of details) {
    if (!detail.id) continue;
    parentMap.set(detail.id, detail.parentDetailId || null);
  }

  for (const [detailId] of parentMap.entries()) {
    const visited = new Set([detailId]);
    let parentId = parentMap.get(detailId);
    while (parentId) {
      if (visited.has(parentId)) {
        throw badRequest("Struktur MBOM detail tidak boleh membentuk cycle parent-child.");
      }
      visited.add(parentId);
      parentId = parentMap.get(parentId);
    }
  }
}

async function validateMBOMDetailParentRefs(mbomNoReg, details = [], currentDetails = []) {
  const currentIds = new Set(currentDetails.map((detail) => detail.id));
  const refs = new Set(details.map((detail, index) => getDetailReference(detail, index)));
  const parentIds = [...new Set(details.map((detail) => detail.parentDetailId).filter(Boolean))];
  const dbParentIds = parentIds.filter((parentId) => currentIds.has(parentId));

  if (dbParentIds.length > 0) {
    const parents = await prisma.mBOMDetail.findMany({
      where: { id: { in: dbParentIds }, noReg: mbomNoReg, isDeleted: false },
      select: { id: true },
    });
    const validParentIds = new Set(parents.map((parent) => parent.id));
    for (const parentId of dbParentIds) {
      if (!validParentIds.has(parentId)) {
        throw badRequest("parentDetailId harus mengarah ke detail aktif pada MBOM yang sama.");
      }
    }
  }

  const parentMap = new Map();
  details.forEach((detail, index) => {
    const ref = getDetailReference(detail, index);
    const parentRef = detail.parentDetailId || null;

    if (parentRef && parentRef === ref) {
      throw badRequest("MBOM detail tidak boleh menjadi parent untuk dirinya sendiri.");
    }
    if (parentRef && !refs.has(parentRef) && !currentIds.has(parentRef)) {
      throw badRequest("Parent detail harus mengarah ke detail aktif atau detail baru pada MBOM yang sama.");
    }

    parentMap.set(ref, parentRef);
  });

  for (const [detailRef] of parentMap.entries()) {
    const visited = new Set([detailRef]);
    let parentRef = parentMap.get(detailRef);
    while (parentRef && parentMap.has(parentRef)) {
      if (visited.has(parentRef)) {
        throw badRequest("Struktur MBOM detail tidak boleh membentuk cycle parent-child.");
      }
      visited.add(parentRef);
      parentRef = parentMap.get(parentRef);
    }
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

// Helper: Generate noReg otomatis (format: MBOM-YYYYMMDD-XXX)
async function generateLegacyNoReg() {
  const now = new Date();
  const datePrefix = `MBOM-${now.getFullYear()}${String(
    now.getMonth() + 1
  ).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;

  const lastDoc = await prisma.mBOMHeader.findFirst({
    where: {
      noReg: {
        startsWith: datePrefix,
      },
    },
    orderBy: {
      noReg: "desc",
    },
  });

  let sequence = 1;
  if (lastDoc && lastDoc.noReg) {
    const lastSeq = lastDoc.noReg.split("-").pop();
    sequence = parseInt(lastSeq, 10) + 1;
  }

  return `${datePrefix}-${String(sequence).padStart(3, "0")}`;
}

async function generateNoReg() {
  return generateConfiguredNumber("MBOM", { fallback: generateLegacyNoReg });
}

// Helper: Get next revision untuk MBOM dengan partId yang sama
async function getNextRevision(partId) {
  if (!partId) return 1;

  const lastMBOM = await prisma.mBOMHeader.findFirst({
    where: { partId },
    orderBy: { revision: "desc" },
  });

  return lastMBOM ? lastMBOM.revision + 1 : 1;
}

function getActor(req, fallback = "System") {
  return req.user?.username || req.user?.email || req.user?.id || fallback;
}

function shouldCreateNewRevision(body = {}, headerData = {}) {
  return (
    body.createNewRevision === true ||
    headerData.createNewRevision === true ||
    body.revisionMode === "newRevision" ||
    headerData.revisionMode === "newRevision" ||
    body.updateMode === "newRevision" ||
    headerData.updateMode === "newRevision"
  );
}

function getPreviousRevisionExpiryDate(effectiveDate) {
  if (!effectiveDate) return null;
  const expiryDate = new Date(effectiveDate);
  expiryDate.setMilliseconds(expiryDate.getMilliseconds() - 1);
  return expiryDate;
}

function stripProcessIdentity(process) {
  if (!process || typeof process !== "object") return process;
  const {
    id,
    noReg,
    mbomDetailId,
    createdAt,
    updatedAt,
    process: _process,
    machine: _machine,
    ...processData
  } = process;
  return processData;
}

async function createMBOMRevision(tx, sourceHeader, headerData, details, req) {
  const actor = getActor(req, headerData.createdBy);
  const newNoReg = await generateNoReg();
  const convertedHeader = convertNumericFields(headerData, ["revision"]);
  const partId = convertedHeader.partId !== undefined
    ? convertedHeader.partId || null
    : sourceHeader.partId || null;
  const effectiveDate = headerData.effectiveDate !== undefined
    ? parseLocalDateField(headerData.effectiveDate)
    : new Date();

  const createdHeader = await tx.mBOMHeader.create({
    data: {
      noReg: newNoReg,
      partId,
      uomCode: convertedHeader.uomCode !== undefined
        ? convertedHeader.uomCode || null
        : sourceHeader.uomCode || null,
      revision: await getNextRevision(partId),
      effectiveDate,
      expiryDate: headerData.expiryDate !== undefined
        ? parseLocalDateField(headerData.expiryDate)
        : null,
      createdBy: actor,
      notes: headerData.notes !== undefined ? headerData.notes : sourceHeader.notes,
      isDeleted: false,
    },
    select: { id: true, noReg: true },
  });

  const revisionDetails = Array.isArray(details) ? details : sourceHeader.details || [];
  if (revisionDetails.length > 0) {
    validateCreateMBOMDetailParentRefs(revisionDetails);

    const detailIdByRef = new Map();
    for (const [index, detail] of revisionDetails.entries()) {
      const detailData = await prepareMBOMDetailData(detail, actor, {
        parentRelationMode: "none",
        db: tx,
      });
      const createdDetail = await tx.mBOMDetail.create({
        data: {
          ...detailData,
          noReg: createdHeader.noReg,
          isDeleted: false,
        },
        select: { id: true },
      });

      detailIdByRef.set(getDetailReference(detail, index), createdDetail.id);
      detailIdByRef.set(`__unsaved_${index}`, createdDetail.id);
      if (detail.id) detailIdByRef.set(detail.id, createdDetail.id);

      const clonedProcesses = (getDetailProcesses(detail) || []).map(stripProcessIdentity);
      await syncMBOMDetailProcesses(
        tx,
        createdDetail.id,
        createdHeader.noReg,
        clonedProcesses
      );
    }

    for (const [index, detail] of revisionDetails.entries()) {
      if (!detail.parentDetailId) continue;

      const parentId = detailIdByRef.get(detail.parentDetailId);
      if (!parentId) {
        throw badRequest("Parent detail tidak ditemukan pada payload new revision MBOM.");
      }

      const detailId = detailIdByRef.get(getDetailReference(detail, index));
      await tx.mBOMDetail.update({
        where: { id: detailId },
        data: { parentDetail: { connect: { id: parentId } } },
      });
    }
  }

  if (headerData.expirePreviousRevision !== false && headerData.expirePrevious !== false) {
    const previousExpiryDate = getPreviousRevisionExpiryDate(effectiveDate);
    if (previousExpiryDate) {
      await tx.mBOMHeader.update({
        where: { id: sourceHeader.id },
        data: { expiryDate: previousExpiryDate },
      });
    }
  }

  return tx.mBOMHeader.findUnique({
    where: { id: createdHeader.id },
    include: MBOM_HEADER_INCLUDE,
  });
}

exports.list = async (req, res, next) => {
  try {
    const { q, isDeleted, partId, includeDetails = "true", page = 1, limit = 20 } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    if (partId) where.partId = partId;

    if (q) {
      where.OR = buildMBOMSearchQuery(q);
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.mBOMHeader.findMany({
        where,
        include: includeDetails === "false" ? { part: true, uom: true } : MBOM_HEADER_INCLUDE,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.mBOMHeader.count({ where }),
    ]);

    res.json({
      items: items.map(mapDoc),
      total,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (e) {
    next(e);
  }
};

exports.get = async (req, res, next) => {
  try {
    const key = req.params.noReg;
    const doc = await prisma.mBOMHeader.findFirst({
      where: {
        OR: [
          { noReg: key },
          { id: key },
        ],
      },
      include: MBOM_HEADER_INCLUDE,
    });

    if (!doc) return res.status(404).json({ message: "MBOM not found" });
    await assignProcessOccurrenceCodes(doc.details);
    const transformed = mapDoc(doc);
    transformed.sequenceInsertionPolicy = await getSequenceInsertionPolicy(doc);
    res.json(transformed);
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    // Extract header dan details dari payload
    const { header, details } = req.body;
    let headerData = header || req.body;

    // Auto-set createdBy dari user yang login
    if (req.user && !headerData.createdBy) {
      headerData.createdBy = req.user.username || req.user.email || req.user.id;
    }

    // Auto-generate noReg jika tidak ada
    if (!headerData.noReg) {
      headerData.noReg = await generateNoReg();
    }

    // Auto-generate revision berdasarkan partId
    if (!headerData.revision && headerData.partId) {
      headerData.revision = await getNextRevision(headerData.partId);
    }

    const normalizedPayload = await normalizeMBOMUomCodes(headerData, details);
    headerData = normalizedPayload.headerData;
    const normalizedDetails = normalizedPayload.details;
    assignProcessRoutingNumbers(normalizedDetails);
    await assignProcessOccurrenceCodes(normalizedDetails);

    // Convert numeric fields for header
    const convertedHeader = convertNumericFields(headerData, ['revision']);
    
    // Prepare header data
    const data = {
      noReg: convertedHeader.noReg,
      partId: convertedHeader.partId || null,
      uomCode: convertedHeader.uomCode || null,
      revision: convertedHeader.revision || 1,
      effectiveDate: parseLocalDateField(headerData.effectiveDate),
      expiryDate: parseLocalDateField(headerData.expiryDate),
      createdBy: headerData.createdBy,
      notes: headerData.notes,
      isDeleted: headerData.isDeleted ?? false,
    };

    if (normalizedDetails && Array.isArray(normalizedDetails)) {
      validateCreateMBOMDetailParentRefs(normalizedDetails);
    }

    const doc = await prisma.$transaction(async (tx) => {
      const createdHeader = await tx.mBOMHeader.create({ data });

      if (normalizedDetails && Array.isArray(normalizedDetails) && normalizedDetails.length > 0) {
        const detailIdByRef = new Map();

        for (const [index, detail] of normalizedDetails.entries()) {
          const detailData = await prepareMBOMDetailData(detail, headerData.createdBy, {
            parentRelationMode: "none",
            db: tx,
          });
          const createdDetail = await tx.mBOMDetail.create({
            data: {
              ...detailData,
              noReg: createdHeader.noReg,
            },
            select: { id: true },
          });

          detailIdByRef.set(getDetailReference(detail, index), createdDetail.id);
          detailIdByRef.set(`__unsaved_${index}`, createdDetail.id);

          await syncMBOMDetailProcesses(
            tx,
            createdDetail.id,
            createdHeader.noReg,
            getDetailProcesses(detail)
          );
        }

        for (const [index, detail] of normalizedDetails.entries()) {
          if (!detail.parentDetailId) continue;

          const parentId = detailIdByRef.get(detail.parentDetailId);
          if (!parentId) {
            throw badRequest("Parent detail tidak ditemukan pada payload create MBOM.");
          }

          const detailId = detailIdByRef.get(getDetailReference(detail, index));
          await tx.mBOMDetail.update({
            where: { id: detailId },
            data: { parentDetail: { connect: { id: parentId } } },
          });
        }
      }

      const created = await tx.mBOMHeader.findUnique({
        where: { id: createdHeader.id },
        include: MBOM_HEADER_INCLUDE,
      });
      await queueDirtyPartCodes(tx, [
        created.part?.partCode,
        ...(created.details || []).map((detail) => detail.part?.partCode),
      ], {
        reason: "BOM",
        sourceNumber: created.noReg,
        notes: "mBOM dibuat; struktur kebutuhan MRP berubah.",
      });
      return created;
    });

    // Send notification
    try {
      await notificationHelper.notifyMBOM('create', doc, headerData.createdBy);
    } catch (notifErr) {
      console.error('Failed to send MBOM notification:', notifErr);
    }

    res.status(201).json(mapDoc(doc));
  } catch (e) {
    console.error("MBOM Create Error:", e);
    if (e.statusCode) {
      return res.status(e.statusCode).json({
        message: e.message,
      });
    }
    if (e.code === "P2003") {
      return res.status(400).json({
        message: getForeignKeyErrorMessage(e),
        detail: e.message,
      });
    }
    if (e.code === "P2002") {
      return res.status(400).json({
        message: "Duplicate entry. noReg sudah ada.",
        detail: e.message,
      });
    }
    if (e.code === "INVALID_UOM") {
      return res.status(400).json({
        message: "UOM tidak valid atau belum terdaftar di master UOM.",
        detail: e.message,
      });
    }
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    // Extract header dan details dari payload
    const { header, details } = req.body;
    let headerData = header || req.body;
    const createNewRevision = shouldCreateNewRevision(req.body, headerData);
    const hasHeaderUomCode = Object.prototype.hasOwnProperty.call(
      headerData,
      "uomCode"
    );
    const normalizedPayload = await normalizeMBOMUomCodes(headerData, details);
    headerData = normalizedPayload.headerData;
    const normalizedDetails = normalizedPayload.details;
    assignProcessRoutingNumbers(normalizedDetails);
    await assignProcessOccurrenceCodes(normalizedDetails);

    if (createNewRevision) {
      const doc = await prisma.$transaction(async (tx) => {
        const sourceHeader = await tx.mBOMHeader.findUnique({
          where: { id: req.params.id },
          include: MBOM_HEADER_INCLUDE,
        });

        if (!sourceHeader || sourceHeader.isDeleted) {
          throw badRequest("MBOM Header not found");
        }

        const revision = await createMBOMRevision(tx, sourceHeader, headerData, normalizedDetails, req);
        await queueDirtyPartCodes(tx, [
          revision.part?.partCode,
          ...(revision.details || []).map((detail) => detail.part?.partCode),
        ], {
          reason: "BOM",
          sourceNumber: revision.noReg,
          notes: "Revisi mBOM dibuat; struktur kebutuhan MRP berubah.",
        });
        return revision;
      });

      try {
        await notificationHelper.notifyMBOM("create", doc, getActor(req));
      } catch (notifErr) {
        console.error("Failed to send MBOM revision notification:", notifErr);
      }

      return res.status(201).json(mapDoc(doc));
    }

    // Build data object - exclude immutable fields
    const {
      noReg,
      id,
      createdAt,
      updatedAt,
      createdBy,
      createNewRevision: _createNewRevision,
      revisionMode: _revisionMode,
      updateMode: _updateMode,
      expirePreviousRevision: _expirePreviousRevision,
      expirePrevious: _expirePrevious,
      ...rawData
    } = headerData;
    if (!hasHeaderUomCode) delete rawData.uomCode;

    // Convert date strings to Date objects
    const data = {};

    // Convert numeric fields
    const convertedRaw = convertNumericFields(rawData, ['revision']);
    
    if (convertedRaw.partId !== undefined) data.partId = convertedRaw.partId || null;
    if (convertedRaw.uomCode !== undefined) data.uomCode = convertedRaw.uomCode || null;
    if (convertedRaw.revision !== undefined)
      data.revision = convertedRaw.revision;
    if (rawData.effectiveDate !== undefined)
      data.effectiveDate = parseLocalDateField(rawData.effectiveDate);
    if (rawData.expiryDate !== undefined)
      data.expiryDate = parseLocalDateField(rawData.expiryDate);
    if (rawData.notes !== undefined) data.notes = rawData.notes;
    if (rawData.isDeleted !== undefined) data.isDeleted = rawData.isDeleted;

    const doc = await prisma.$transaction(async (tx) => {
      const updatedHeader = await tx.mBOMHeader.update({
        where: { id: req.params.id },
        data,
        select: { id: true, noReg: true },
      });

      if (normalizedDetails !== undefined && Array.isArray(normalizedDetails)) {
        const mbomHeader = await tx.mBOMHeader.findUnique({
          where: { id: req.params.id },
          select: { noReg: true, details: { select: { id: true, parentDetailId: true } } },
        });

        if (!mbomHeader) {
          throw badRequest("MBOM Header not found");
        }

        await validateMBOMDetailParentRefs(mbomHeader.noReg, normalizedDetails, mbomHeader.details);

        const existingDetails = normalizedDetails.filter((detail) => detail.id);
        const newDetails = normalizedDetails.filter((detail) => !detail.id);
        const keepDetailIds = existingDetails.map((detail) => detail.id);
        const allExistingIds = mbomHeader.details.map((detail) => detail.id);
        const deleteDetailIds = allExistingIds.filter((id) => !keepDetailIds.includes(id));

        if (deleteDetailIds.length > 0) {
          await tx.mBOMDetail.updateMany({
            where: { id: { in: deleteDetailIds } },
            data: { isDeleted: true },
          });
          await tx.mBOMProcess.updateMany({
            where: { mbomDetailId: { in: deleteDetailIds } },
            data: { isDeleted: true },
          });
        }

        for (const detail of existingDetails) {
          const detailData = await prepareMBOMDetailData(detail, headerData.createdBy, {
            parentRelationMode: "none",
            db: tx,
          });
          await tx.mBOMDetail.update({
            where: { id: detail.id },
            data: {
              ...detailData,
              isDeleted: false,
            },
          });
          await syncMBOMDetailProcesses(
            tx,
            detail.id,
            updatedHeader.noReg,
            getDetailProcesses(detail)
          );
        }

        const detailIdByRef = new Map();
        existingDetails.forEach((detail, index) => {
          detailIdByRef.set(detail.id, detail.id);
          detailIdByRef.set(getDetailReference(detail, index), detail.id);
        });
        for (const [index, detail] of newDetails.entries()) {
          const detailData = await prepareMBOMDetailData(
            detail,
            detail.createdBy || headerData.createdBy || req.user?.username,
            { parentRelationMode: "none", db: tx }
          );
          const createdDetail = await tx.mBOMDetail.create({
            data: {
              ...detailData,
              noReg: updatedHeader.noReg,
            },
            select: { id: true },
          });
          detailIdByRef.set(getDetailReference(detail, index), createdDetail.id);
          detailIdByRef.set(`__unsaved_${index}`, createdDetail.id);

          await syncMBOMDetailProcesses(
            tx,
            createdDetail.id,
            updatedHeader.noReg,
            getDetailProcesses(detail)
          );
        }

        for (const [index, detail] of normalizedDetails.entries()) {
          const detailId = detailIdByRef.get(getDetailReference(detail, index));
          if (!detailId) continue;

          if (detail.parentDetailId) {
            const parentId = detailIdByRef.get(detail.parentDetailId) || detail.parentDetailId;
            await tx.mBOMDetail.update({
              where: { id: detailId },
              data: { parentDetail: { connect: { id: parentId } } },
            });
          } else {
            await tx.mBOMDetail.update({
              where: { id: detailId },
              data: { parentDetail: { disconnect: true } },
            });
          }
        }
      }

      const updated = await tx.mBOMHeader.findUnique({
        where: { id: updatedHeader.id },
        include: MBOM_HEADER_INCLUDE,
      });
      await queueDirtyPartCodes(tx, [
        updated.part?.partCode,
        ...(updated.details || []).map((detail) => detail.part?.partCode),
      ], {
        reason: "BOM",
        sourceNumber: updated.noReg,
        notes: "mBOM diubah; struktur kebutuhan MRP berubah.",
      });
      return updated;
    });

    // Send notification
    try {
      await notificationHelper.notifyMBOM('update', doc, req.user?.username || 'System');
    } catch (notifErr) {
      console.error('Failed to send MBOM notification:', notifErr);
    }

    res.json(mapDoc(doc));
  } catch (e) {
    console.error("MBOM Update Error:", e);
    if (e.statusCode) {
      return res.status(e.statusCode).json({
        message: e.message,
      });
    }
    if (e.code === "P2003") {
      return res.status(400).json({
        message: getForeignKeyErrorMessage(e),
        detail: e.message,
      });
    }
    if (e.code === "P2002") {
      return res.status(400).json({
        message: "Duplicate entry. noReg sudah ada.",
        detail: e.message,
      });
    }
    if (e.code === "INVALID_UOM") {
      return res.status(400).json({
        message: "UOM tidak valid atau belum terdaftar di master UOM.",
        detail: e.message,
      });
    }
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.mBOMHeader.findUnique({
        where: { noReg: req.params.noReg },
        include: MBOM_HEADER_INCLUDE,
      });
      if (!existing) throw badRequest("MBOM Header not found");
      await tx.mBOMHeader.update({
        where: { noReg: req.params.noReg },
        data: { isDeleted: true },
      });
      await queueDirtyPartCodes(tx, [
        existing.part?.partCode,
        ...(existing.details || []).map((detail) => detail.part?.partCode),
      ], {
        reason: "BOM",
        sourceNumber: existing.noReg,
        notes: "mBOM dihapus; struktur kebutuhan MRP berubah.",
      });
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
};

exports.bulkRemove = async (req, res, next) => {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        message: "ids array required",
        received: req.body,
      });
    }

    const result = await prisma.mBOMHeader.updateMany({
      where: { id: { in: ids } },
      data: { isDeleted: true },
    });

    res.json({ deletedCount: result.count });
  } catch (e) {
    console.error("Bulk Remove Error:", e);
    next(e);
  }
};
