const { generateMovementNumber } = require("../../../utils/movementNumberGenerator");
const { createWIPEntry } = require("../WIPController");
const {
  normalizeAllocationStrategy,
  reserveSourceWipForMO,
  syncReservationsForMO,
  releaseReservationsForMO,
} = require("./moReservationService");
const {
  buildExcludeSpecialRackCondition,
} = require("../../inventory/utils/stockReservationHelpers");
const { assertStockBalanceNotFrozen } = require("../../inventory/utils/stockOpnameFreezeGuard");
const { isSubAssemblyDetail } = require("../../../utils/assemblyPolicy");
const {
  canonicalizeRoutingOperations,
} = require("../../../utils/routingSequence");
const ACTIVE_WO_STATUSES = [
  "Draft",
  "Released",
  "Material Issued",
  "In Production",
  "QC Pending",
  "Rework",
  "Planned",
  "In Progress",
];
// Historical QC records use both Accepted and Passed/Pass for a good result.
// Treat all positive decisions as terminal so a completed FG receipt can
// close its MO instead of leaving it Released forever.
const COMPLETED_QC_DECISIONS = ["Accepted", "Conditional Accept", "Passed", "Pass", "Rework"];
const QUANTITY_TOLERANCE = 0.005;

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeRateType(value) {
  return String(value || "PER_HOUR").trim().toUpperCase();
}

function toMachineRatePerSecond(rate, rateType) {
  const numericRate = toNumber(rate);
  switch (normalizeRateType(rateType)) {
    case "PER_SECOND":
      return numericRate;
    case "PER_MINUTE":
      return numericRate / 60;
    case "PER_CYCLE":
      return numericRate;
    case "PER_HOUR":
    default:
      return numericRate / 3600;
  }
}

function getPlannedProcessCost(cycleTime, machine) {
  if (!machine) return 0;
  return toNumber(cycleTime) * toMachineRatePerSecond(machine.costingRate, machine.costingRateType);
}

function roundQuantity(value) {
  return Math.round(toNumber(value) * 1000000) / 1000000;
}

function isPositiveQuantity(value) {
  return roundQuantity(value) > QUANTITY_TOLERANCE;
}

function normalizeUomCode(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeRequirementUomMode(value) {
  const normalized = String(value || "kg").trim().toUpperCase();
  if (normalized === "KG") return "kg";
  return ["ORIGINAL", "BY_ITEM_TYPE"].includes(normalized)
    ? normalized
    : "kg";
}

function normalizePartBaseOn(value) {
  return String(value || "").trim().toUpperCase();
}


function getPreferredPartBase(part = {}) {
  const bases = Array.isArray(part.partBases) ? part.partBases : [];
  return (
    bases.find((base) => normalizePartBaseOn(base.baseOn) === "ACTUAL") ||
    bases.find((base) => normalizePartBaseOn(base.baseOn) === "QTN") ||
    bases[0] ||
    null
  );
}

function resolveKgPerQty(part = {}) {
  const base = getPreferredPartBase(part);
  const grossWeight = toNumber(base?.grossWeight);
  return grossWeight > 0 ? grossWeight : null;
}

function normalizeMaterialRequirementToKg(rawQtyRequired, detail) {
  if (normalizeUomCode(detail.uomCode) === "kg") {
    return roundQuantity(rawQtyRequired);
  }

  const kgPerQty = resolveKgPerQty(detail.part);
  if (!kgPerQty) {
    return roundQuantity(rawQtyRequired);
  }

  return roundQuantity(rawQtyRequired * kgPerQty);
}

function inferStartSequenceFromSourcePartCode(operations = [], sourcePartCode) {
  if (!sourcePartCode) return 0;
  const normalizedPartCode = String(sourcePartCode).trim().toLowerCase();
  if (!normalizedPartCode) return 0;

  const matchedOperation = operations.find((operation) =>
    String(operation?.componentPartCode || "").trim().toLowerCase() === normalizedPartCode,
  );
  return toNumber(matchedOperation?.sequence, 0);
}

function buildRequirementOrderMatch(requirement) {
  return {
    runNumber: requirement.runNumber,
    partCode: requirement.partCode,
    requiredDate: requirement.requiredDate,
    ...(requirement.orderDate ? { orderDate: requirement.orderDate } : {}),
  };
}

function normalizePlannedMaterialQtyToKg(plannedOrder) {
  const qty = toNumber(plannedOrder?.qty);
  if (normalizeUomCode(plannedOrder?.uomCode) === "kg") {
    return roundQuantity(qty);
  }

  const kgPerQty = resolveKgPerQty(plannedOrder?.part);
  return kgPerQty ? roundQuantity(qty * kgPerQty) : roundQuantity(qty);
}

function buildPurchaseCoverageByPart(plannedOrders = []) {
  const result = new Map();
  for (const plannedOrder of plannedOrders) {
    const partCode = plannedOrder.partCode || "";
    if (!partCode) continue;

    const qtyKg = normalizePlannedMaterialQtyToKg(plannedOrder);
    const current = result.get(partCode) || 0;
    result.set(partCode, Math.max(current, qtyKg));
  }

  return result;
}

function scaleCoverageByMoQty(coverageByPart, mo, rootPlannedOrder) {
  const rootQty = toNumber(rootPlannedOrder?.qty);
  const moQty = toNumber(mo?.qtyPlanned);
  if (!rootQty || !moQty || moQty === rootQty) return coverageByPart;

  const factor = moQty / rootQty;
  const scaled = new Map();
  for (const [partCode, qty] of coverageByPart.entries()) {
    scaled.set(partCode, roundQuantity(toNumber(qty) * factor));
  }
  return scaled;
}

async function getMrpPurchaseRequirementByPart(tx, mo) {
  if (!mo?.plannedOrderNumber) return new Map();

  const rootPlannedOrder = await tx.plannedOrder.findUnique({
    where: { orderNumber: mo.plannedOrderNumber },
    select: {
      orderNumber: true,
      runNumber: true,
      referenceNumber: true,
      partCode: true,
      qty: true,
      requiredDate: true,
      orderDate: true,
    },
  });
  if (!rootPlannedOrder?.runNumber) return new Map();

  const candidateRunNumbers = [rootPlannedOrder.runNumber];
  if (rootPlannedOrder.referenceNumber) {
    const latestPlanRun = await tx.mRPRun.findFirst({
      where: {
        planNumber: rootPlannedOrder.referenceNumber,
        isDeleted: false,
      },
      select: { runNumber: true },
      orderBy: { createdAt: "desc" },
    });
    if (latestPlanRun?.runNumber && !candidateRunNumbers.includes(latestPlanRun.runNumber)) {
      candidateRunNumbers.push(latestPlanRun.runNumber);
    }
  }

  async function findRootRequirementForRun(runNumber) {
    const exactRootRequirement = await tx.mRPRequirement.findFirst({
      where: {
        runNumber,
        partCode: rootPlannedOrder.partCode,
        requiredDate: rootPlannedOrder.requiredDate,
        orderDate: rootPlannedOrder.orderDate,
        isDeleted: false,
      },
      orderBy: [{ levelMBOM: "asc" }, { createdAt: "asc" }],
      select: { id: true, runNumber: true, rootRequirementId: true, treePath: true, levelMBOM: true },
    });
    if (exactRootRequirement) return exactRootRequirement;

    return tx.mRPRequirement.findFirst({
      where: {
        runNumber,
        partCode: rootPlannedOrder.partCode,
        levelMBOM: 0,
        requirementType: { not: "Dependent" },
        sourceType: { not: "MBOM" },
        isDeleted: false,
      },
      orderBy: [{ createdAt: "asc" }],
      select: { id: true, runNumber: true, rootRequirementId: true, treePath: true, levelMBOM: true },
    });
  }

  let rootRequirement = null;
  for (const runNumber of candidateRunNumbers) {
    rootRequirement = await findRootRequirementForRun(runNumber);
    if (rootRequirement) break;
  }
  const activeRunNumber = rootRequirement?.runNumber || candidateRunNumbers[0];

  const isDependentSource = Number(rootRequirement?.levelMBOM || 0) > 0;
  const rootRequirementId = rootRequirement?.rootRequirementId || rootRequirement?.id || null;
  const dependentWhere = isDependentSource
    ? rootRequirement.treePath
      ? { treePath: { startsWith: `${rootRequirement.treePath}.` } }
      : { parentRequirementId: rootRequirement.id }
    : rootRequirementId
      ? {
          OR: [
            { rootRequirementId },
            { rootRequirementId: null, levelMBOM: { gt: 0 } },
          ],
        }
      : { levelMBOM: { gt: 0 } };

  const requirements = await tx.mRPRequirement.findMany({
    where: {
      runNumber: activeRunNumber,
      orderType: "Purchase",
      plannedOrderQty: { gt: 0 },
      isDeleted: false,
      ...dependentWhere,
    },
    select: {
      runNumber: true,
      partCode: true,
      requiredDate: true,
      orderDate: true,
    },
  });
  if (requirements.length === 0 && rootPlannedOrder.referenceNumber) {
    const coveredPurchaseOrders = await tx.plannedOrder.findMany({
      where: {
        referenceNumber: rootPlannedOrder.referenceNumber,
        isDeleted: false,
        status: { not: "Cancelled" },
        orderType: "Purchase",
      },
      orderBy: [{ createdAt: "desc" }],
      select: {
        partCode: true,
        qty: true,
        uomCode: true,
        part: {
          select: {
            partBases: {
              select: {
                baseOn: true,
                grossWeight: true,
              },
            },
          },
        },
      },
    });
    return scaleCoverageByMoQty(
      buildPurchaseCoverageByPart(coveredPurchaseOrders),
      mo,
      rootPlannedOrder,
    );
  }
  if (requirements.length === 0) return new Map();

  const plannedOrders = await tx.plannedOrder.findMany({
    where: {
      isDeleted: false,
      status: { not: "Cancelled" },
      orderType: "Purchase",
      OR: requirements.map(buildRequirementOrderMatch),
    },
    select: {
      partCode: true,
      qty: true,
      uomCode: true,
      createdAt: true,
      part: {
        select: {
          partBases: {
            select: {
              baseOn: true,
              grossWeight: true,
            },
          },
        },
      },
    },
  });
  if (plannedOrders.length > 0) {
    return scaleCoverageByMoQty(buildPurchaseCoverageByPart(plannedOrders), mo, rootPlannedOrder);
  }

  if (rootPlannedOrder.referenceNumber) {
    const coveredPurchaseOrders = await tx.plannedOrder.findMany({
      where: {
        referenceNumber: rootPlannedOrder.referenceNumber,
        isDeleted: false,
        status: { not: "Cancelled" },
        orderType: "Purchase",
      },
      orderBy: [{ createdAt: "desc" }],
      select: {
        partCode: true,
        qty: true,
        uomCode: true,
        part: {
          select: {
            partBases: {
              select: {
                baseOn: true,
                grossWeight: true,
              },
            },
          },
        },
      },
    });
    return scaleCoverageByMoQty(
      buildPurchaseCoverageByPart(coveredPurchaseOrders),
      mo,
      rootPlannedOrder,
    );
  }

  return new Map();
}

async function getPlannedOrderQtyKg(tx, mo) {
  if (!mo?.plannedOrderNumber) return null;

  const plannedOrder = await tx.plannedOrder.findUnique({
    where: { orderNumber: mo.plannedOrderNumber },
    select: {
      qty: true,
      uomCode: true,
      part: {
        select: {
          partBases: {
            select: {
              baseOn: true,
              grossWeight: true,
            },
          },
        },
      },
    },
  });
  if (!plannedOrder) return null;

  return normalizePlannedMaterialQtyToKg(plannedOrder);
}

function resolvePartStockIdentity(part = {}) {
  const partBase = getPreferredPartBase(part) || {};
  return {
    partNumber: part.partNumber || null,
    partName: part.partName || null,
    spec: part.material?.spec || null,
    thickness: partBase.thickness ?? null,
    width: partBase.width ?? null,
    CSP: partBase.CSP || null,
  };
}

function normalizeManualAllocations(allocations = [], lineNumber = null) {
  return (Array.isArray(allocations) ? allocations : [])
    .filter((allocation) => {
      if (!allocation?.stockBalanceId) return false;
      if (lineNumber == null) return true;
      return Number(allocation.lineNumber) === Number(lineNumber);
    })
    .map((allocation) => ({
      stockBalanceId: allocation.stockBalanceId,
      qty: roundQuantity(toNumber(allocation.qty)),
    }))
    .filter((allocation) => allocation.qty > 0);
}

function getAllocationOrderBy(strategy) {
  switch (normalizeAllocationStrategy(strategy)) {
    case "FIFO":
      return [{ lastMovement: "asc" }, { createdAt: "asc" }, { qtyAvailable: "asc" }];
    case "LIFO":
      return [{ lastMovement: "desc" }, { createdAt: "desc" }, { qtyAvailable: "asc" }];
    case "LARGEST":
      return [{ qtyAvailable: "desc" }, { lastMovement: "asc" }];
    case "SMALLEST":
    default:
      return [{ qtyAvailable: "asc" }, { lastMovement: "asc" }];
  }
}

async function getManualStockSources(tx, item, manualAllocations = []) {
  const selectedAllocations = normalizeManualAllocations(manualAllocations, item.lineNumber);
  if (selectedAllocations.length === 0) return [];

  const balances = await tx.stockBalance.findMany({
    where: {
      AND: [
        {
          id: { in: selectedAllocations.map(allocation => allocation.stockBalanceId) },
          partCode: item.partCode,
          uomCode: item.uomCode || null,
          isDeleted: false,
          qtyAvailable: { gt: 0 },
        },
        buildExcludeSpecialRackCondition(),
      ],
    },
    select: {
      id: true,
      warehouseCode: true,
      rackCode: true,
      lotNumber: true,
      qtyAvailable: true,
      partCode: true,
      partNumber: true,
      partName: true,
      productId: true,
      description: true,
      spec: true,
      thickness: true,
      width: true,
      CSP: true,
      uomCode: true,
    },
  });
  const balanceMap = new Map(balances.map(balance => [balance.id, balance]));
  let remaining = toNumber(item.qtyRequired);
  const sources = [];

  for (const allocation of selectedAllocations) {
    if (remaining <= 0) break;

    const balance = balanceMap.get(allocation.stockBalanceId);
    if (!balance) continue;

    const qtyAvailable = toNumber(balance.qtyAvailable);
    const qtyCandidate = Math.min(qtyAvailable, allocation.qty, remaining);
    if (qtyCandidate <= 0) continue;

    sources.push({
      stockBalanceId: balance.id,
      warehouseCode: balance.warehouseCode || null,
      rackCode: balance.rackCode || null,
      lotNumber: balance.lotNumber || null,
      qtyAvailable,
      qtyCandidate: roundQuantity(qtyCandidate),
      partCode: balance.partCode || null,
      partNumber: balance.partNumber || null,
      partName: balance.partName || null,
      productId: balance.productId || null,
      description: balance.description || null,
      spec: balance.spec || null,
      thickness: balance.thickness ?? null,
      width: balance.width ?? null,
      CSP: balance.CSP || null,
    });
    remaining = roundQuantity(remaining - qtyCandidate);
  }

  return sources;
}

async function getAvailableStockSources(tx, item, options = {}) {
  const allocationStrategy = normalizeAllocationStrategy(options.allocationStrategy);
  if (normalizeManualAllocations(options.manualAllocations, item.lineNumber).length > 0) {
    return getManualStockSources(tx, item, options.manualAllocations);
  }

  const balances = await tx.stockBalance.findMany({
    where: {
      AND: [
        {
          partCode: item.partCode,
          uomCode: item.uomCode || null,
          isDeleted: false,
          qtyAvailable: { gt: 0 },
        },
        buildExcludeSpecialRackCondition(),
      ],
    },
    orderBy: getAllocationOrderBy(allocationStrategy),
    select: {
      id: true,
      warehouseCode: true,
      rackCode: true,
      lotNumber: true,
      qtyAvailable: true,
      partCode: true,
      partNumber: true,
      partName: true,
      productId: true,
      description: true,
      spec: true,
      thickness: true,
      width: true,
      CSP: true,
      uomCode: true,
    },
  });

  let remaining = toNumber(item.qtyRequired);
  const sources = [];

  for (const balance of balances) {
    if (remaining <= 0) break;

    const qtyAvailable = toNumber(balance.qtyAvailable);
    const qtyCandidate = Math.min(qtyAvailable, remaining);
    if (qtyCandidate <= 0) continue;

    sources.push({
      stockBalanceId: balance.id,
      warehouseCode: balance.warehouseCode || null,
      rackCode: balance.rackCode || null,
      lotNumber: balance.lotNumber || null,
      qtyAvailable,
      qtyCandidate: roundQuantity(qtyCandidate),
      partCode: balance.partCode || null,
      partNumber: balance.partNumber || null,
      partName: balance.partName || null,
      productId: balance.productId || null,
      description: balance.description || null,
      spec: balance.spec || null,
      thickness: balance.thickness ?? null,
      width: balance.width ?? null,
      CSP: balance.CSP || null,
    });
    remaining = roundQuantity(remaining - qtyCandidate);
  }

  return sources;
}

async function resolveStockSourceOrigin(tx, source = {}) {
  let warehouseCode = source?.warehouseCode || null;
  let rackCode = source?.rackCode || null;
  let lotNumber = source?.lotNumber || null;
  let partCode = source?.partCode || null;

  if (source?.stockBalanceId && (!warehouseCode || !partCode || !rackCode || !lotNumber)) {
    const balance = await tx.stockBalance.findUnique({
      where: { id: source.stockBalanceId },
      select: {
        warehouseCode: true,
        rackCode: true,
        lotNumber: true,
        partCode: true,
      },
    });
    warehouseCode = warehouseCode || balance?.warehouseCode || null;
    rackCode = rackCode || balance?.rackCode || null;
    lotNumber = lotNumber || balance?.lotNumber || null;
    partCode = partCode || balance?.partCode || null;
  }

  if (!warehouseCode || !partCode) return null;

  const movement = await tx.stockMovement.findFirst({
    where: {
      isDeleted: false,
      direction: "IN",
      warehouseCode,
      rackCode: rackCode || null,
      lotNumber: lotNumber || null,
      partCode,
    },
    orderBy: [
      { movementDate: "desc" },
      { createdAt: "desc" },
    ],
    select: {
      transactionType: true,
      referenceType: true,
      referenceNumber: true,
      movementDate: true,
      createdAt: true,
      warehouseCode: true,
      rackCode: true,
      lotNumber: true,
    },
  });

  if (!movement?.referenceNumber) {
    return movement
      ? {
          transactionType: movement.transactionType || null,
          referenceType: movement.referenceType || null,
          referenceNumber: movement.referenceNumber || null,
          movementDate: movement.movementDate || movement.createdAt || null,
          supplierCode: null,
          supplierName: null,
          vendorCode: null,
          vendorName: null,
          poNumber: null,
          grNumber: null,
        }
      : null;
  }

  let supplierCode = null;
  let supplierName = null;
  let vendorCode = null;
  let vendorName = null;
  let poNumber = null;
  let grNumber = null;

  if (movement.referenceType === "GR") {
    const gr = await tx.goodsReceipt.findUnique({
      where: { grNumber: movement.referenceNumber },
      select: {
        grNumber: true,
        poNumber: true,
        po: {
          select: {
            supplierCode: true,
            supplierName: true,
            vendorCode: true,
            vendorName: true,
          },
        },
      },
    });
    grNumber = gr?.grNumber || movement.referenceNumber;
    poNumber = gr?.poNumber || null;
    supplierCode = gr?.po?.supplierCode || null;
    supplierName = gr?.po?.supplierName || null;
    vendorCode = gr?.po?.vendorCode || null;
    vendorName = gr?.po?.vendorName || null;
  }
  else if (movement.referenceType === "INCOMING_INSPECTION") {
    const inspection = await tx.incomingInspection.findUnique({
      where: { inspectionNumber: movement.referenceNumber },
      select: {
        inspectionNumber: true,
        grNumber: true,
        gr: {
          select: {
            poNumber: true,
            po: {
              select: {
                supplierCode: true,
                supplierName: true,
                vendorCode: true,
                vendorName: true,
              },
            },
          },
        },
      },
    });
    grNumber = inspection?.grNumber || null;
    poNumber = inspection?.gr?.poNumber || null;
    supplierCode = inspection?.gr?.po?.supplierCode || null;
    supplierName = inspection?.gr?.po?.supplierName || null;
    vendorCode = inspection?.gr?.po?.vendorCode || null;
    vendorName = inspection?.gr?.po?.vendorName || null;
  }

  return {
    transactionType: movement.transactionType || null,
    referenceType: movement.referenceType || null,
    referenceNumber: movement.referenceNumber || null,
    movementDate: movement.movementDate || movement.createdAt || null,
    supplierCode,
    supplierName,
    vendorCode,
    vendorName,
    poNumber,
    grNumber,
  };
}

async function enrichSourceOrigins(tx, sources = []) {
  if (!Array.isArray(sources) || sources.length === 0) return [];

  return Promise.all(
    sources.map(async (source) => ({
      ...source,
      origin: await resolveStockSourceOrigin(tx, source),
    })),
  );
}

function buildHistoricalIssueSources(issueDocuments = []) {
  if (!Array.isArray(issueDocuments) || issueDocuments.length === 0) return [];

  const grouped = new Map();
  for (const issue of issueDocuments) {
    const stockBalanceId = issue?.stockBalanceId || null;
    const warehouseCode = issue?.warehouseCode || null;
    const rackCode = issue?.rackCode || null;
    const lotNumber = issue?.lotNumber || null;
    const partCode = issue?.partCode || null;
    const partNumber = issue?.partNumber || null;
    const partName = issue?.partName || null;
    const qtyConsumed = roundQuantity(issue?.netIssued || 0);
    if (qtyConsumed <= 0) continue;

    const key = [
      stockBalanceId || "-",
      warehouseCode || "-",
      rackCode || "-",
      lotNumber || "-",
      partCode || "-",
    ].join("|");

    const current = grouped.get(key) || {
      stockBalanceId,
      warehouseCode,
      rackCode,
      lotNumber,
      partCode,
      partNumber,
      partName,
      qtyConsumed: 0,
      qtyHistorical: 0,
      sourceType: "ISSUED_HISTORY",
    };

    current.qtyConsumed = roundQuantity(current.qtyConsumed + qtyConsumed);
    current.qtyHistorical = current.qtyConsumed;
    grouped.set(key, current);
  }

  return [...grouped.values()];
}

async function generateDailyNumber(tx, modelName, fieldName, prefix, width = 3) {
  const last = await tx[modelName].findFirst({
    where: { [fieldName]: { startsWith: prefix } },
    orderBy: { [fieldName]: "desc" },
    select: { [fieldName]: true },
  });

  let seq = 1;
  if (last?.[fieldName]) {
    const parts = last[fieldName].split("-");
    seq = parseInt(parts[parts.length - 1], 10) + 1;
  }

  return `${prefix}-${String(seq).padStart(width, "0")}`;
}

function buildWoPrefix(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `WO-${y}${m}${d}`;
}

function getLocalDayBounds(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);

  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

async function getActiveMbomHeader(tx, partId) {
  if (!partId) return null;
  const { start, end } = getLocalDayBounds();
  return tx.mBOMHeader.findFirst({
    where: {
      partId,
      isDeleted: false,
      OR: [{ effectiveDate: null }, { effectiveDate: { lte: end } }],
      AND: [{ OR: [{ expiryDate: null }, { expiryDate: { gte: start } }] }],
    },
    orderBy: [{ revision: "desc" }, { createdAt: "desc" }],
    select: {
      noReg: true,
      revision: true,
      part: {
        select: {
          id: true,
          partCode: true,
          partNumber: true,
          partName: true,
          itemType: true,
          rawType: true,
          assemblyPolicy: true,
        },
      },
    },
  });
}

async function getMaterialRequirements(tx, mo, options = {}) {
  const requirementUomMode = normalizeRequirementUomMode(
    options.requirementUomMode || mo?.materialRequirementUomMode,
  );
  const includeDirectProductionInputs = options.includeDirectProductionInputs === true;
  const mbomHeader = await getActiveMbomHeader(tx, mo.partId);
  if (!mbomHeader) return { mbomHeader: null, items: [] };

  const structureDetails = await tx.mBOMDetail.findMany({
    where: {
      noReg: mbomHeader.noReg,
      isDeleted: false,
    },
    include: {
      part: {
        select: {
          id: true,
          partCode: true,
          partNumber: true,
          partName: true,
          itemType: true,
          rawType: true,
          assemblyPolicy: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const assemblyDetails = structureDetails.filter((detail) =>
    ["inHouse", "Vendor"].includes(detail.category),
  );

  function resolvePreviousSameLevelAssembly(detail) {
    const detailIndex = structureDetails.findIndex((item) => item.id === detail.id);
    const currentLevel = Number(detail.levelComponent || 0);

    if (detailIndex <= 0) {
      return null;
    }

    for (let index = detailIndex - 1; index >= 0; index -= 1) {
      const candidate = structureDetails[index];
      const sameLevel = Number(candidate.levelComponent || 0) === currentLevel;
      const isOutput = ["inHouse", "Vendor"].includes(candidate.category);

      if (sameLevel && isOutput && candidate.part?.partCode) {
        return candidate.part;
      }
    }

    return null;
  }

  function resolveConsumedBy(detail) {
    // Raw sibling pada parent dan level yang sama dikonsumsi oleh process assembly tersebut.
    // Contoh: NUT M6 mendampingi C001-0001-000 pada Progressive di MBOM parent.
    const sameParentAssemblies = assemblyDetails.filter((assembly) => {
      const sameParent =
        (assembly.parentDetailId || null) === (detail.parentDetailId || null);
      const sameLevel =
        Number(assembly.levelComponent || 0) ===
        Number(detail.levelComponent || 0);

      return sameParent && sameLevel && assembly.part?.partCode;
    });

    if (sameParentAssemblies.length > 0)
      return sameParentAssemblies[0].part;

    const previousSameLevelAssembly = resolvePreviousSameLevelAssembly(detail);

    if (previousSameLevelAssembly)
      return previousSameLevelAssembly;

    const detailIndex = structureDetails.findIndex((item) => item.id === detail.id);
    const expectedParentLevel = Number(detail.levelComponent || 0) - 1;
    if (detailIndex > 0 && expectedParentLevel >= 1) {
      const previousParent = [...structureDetails]
        .slice(0, detailIndex)
        .reverse()
        .find(
          (candidate) =>
            Number(candidate.levelComponent || 0) === expectedParentLevel &&
            candidate.part?.partCode,
        );

      if (previousParent?.part)
        return previousParent.part;
    }

    if (detail.parentDetail?.part)
      return detail.parentDetail.part;


    return null;
  }

  const details = await tx.mBOMDetail.findMany({
    where: {
      noReg: mbomHeader.noReg,
      isDeleted: false,
      OR: [
        { category: "Purchase" },
        { category: { in: ["inHouse", "Vendor"] } },
      ],
    },
    include: {
      parentDetail: {
        select: {
          id: true,
          levelComponent: true,
          part: {
            select: {
              id: true,
              partCode: true,
              partNumber: true,
              partName: true,
              itemType: true,
              assemblyPolicy: true,
            },
          },
        },
      },
      part: {
        select: {
          id: true,
          partCode: true,
          partNumber: true,
          partName: true,
          itemType: true,
          rawType: true,
          assemblyPolicy: true,
          material: { select: { spec: true } },
          partBases: {
            select: {
              baseOn: true,
              CSP: true,
              thickness: true,
              width: true,
              grossWeight: true,
            },
          },
        },
      },
    },
    orderBy: [{ levelComponent: "asc" }, { createdAt: "asc" }],
  });

  const mrpPurchaseRequirementByPart = await getMrpPurchaseRequirementByPart(tx, mo);
  const plannedOrderQtyKg = await getPlannedOrderQtyKg(tx, mo);
  const shouldUsePlannedKgRequirement =
    plannedOrderQtyKg != null &&
    plannedOrderQtyKg > 0 &&
    details.length === 1 &&
    !details.some((detail) => isSubAssemblyDetail(detail));

  const items = details
    .filter((detail) => detail.part?.partCode)
    .map((detail, index) => {
      const qtyPer = toNumber(detail.qty);
      const isSubAssembly = isSubAssemblyDetail(detail);
      const isDirectProductionInput =
        includeDirectProductionInputs &&
        ["inHouse", "Vendor"].includes(detail.category);
      const isAssemblyInput = isSubAssembly || isDirectProductionInput;
      // Scrap is a material-consumption allowance. A subassembly requirement
      // represents discrete units supplied by its own MO, so its required pcs
      // must follow qty-per-parent x parent MO planned qty without scrap uplift.
      const scrapFactor = isAssemblyInput ? 0 : toNumber(detail.scrapFactor) / 100;
      const qtyRequiredOriginal = roundQuantity(
        qtyPer * toNumber(mo.qtyPlanned) * (1 + scrapFactor),
      );
      const mrpQtyRequired = isAssemblyInput
        ? null
        : mrpPurchaseRequirementByPart.get(detail.part.partCode);
      const useOriginalUom = !isAssemblyInput && (
        requirementUomMode === "ORIGINAL" ||
        (
          requirementUomMode === "BY_ITEM_TYPE" &&
          String(detail.part?.rawType || "").trim().toUpperCase() === "PURCHASE_PART"
        )
      );
      const qtyRequiredFromMbom = isAssemblyInput || useOriginalUom
        ? qtyRequiredOriginal
        : normalizeMaterialRequirementToKg(qtyRequiredOriginal, detail);
      const qtyRequiredBeforePlannedCap = !useOriginalUom && mrpQtyRequired != null
        ? mrpQtyRequired
        : qtyRequiredFromMbom;
      const qtyRequired = !useOriginalUom && !isAssemblyInput && shouldUsePlannedKgRequirement
        ? plannedOrderQtyKg
        : qtyRequiredBeforePlannedCap;
      const partBase = getPreferredPartBase(detail.part);
      const consumedBy = resolveConsumedBy(detail);

      return {
        lineNumber: index + 1,
        detailId: detail.id,
        parentDetailId: detail.parentDetailId || null,
        levelComponent: detail.levelComponent || 0,
        rootPartId: mbomHeader.part?.id || null,
        rootPartCode: mbomHeader.part?.partCode || null,
        rootPartNumber: mbomHeader.part?.partNumber || null,
        rootPartName: mbomHeader.part?.partName || null,
        parentPartId: detail.parentDetail?.part?.id || null,
        parentPartCode: detail.parentDetail?.part?.partCode || null,
        parentPartNumber: detail.parentDetail?.part?.partNumber || null,
        parentPartName: detail.parentDetail?.part?.partName || null,
        consumedByPartId: consumedBy?.id || null,
        consumedByPartCode: consumedBy?.partCode || null,
        consumedByPartNumber: consumedBy?.partNumber || null,
        consumedByPartName: consumedBy?.partName || null,
        partId: detail.partId,
        partCode: detail.part.partCode,
        partNumber: detail.part.partNumber,
        partName: detail.part.partName,
        spec: detail.part.material?.spec || null,
        thickness: partBase?.thickness ?? null,
        width: partBase?.width ?? null,
        CSP: partBase?.CSP || null,
        category: detail.category || null,
        itemType: detail.part.itemType || null,
        rawType: detail.part.rawType || null,
        isSubAssembly,
        isDirectProductionInput,
        uomCode: isAssemblyInput || useOriginalUom ? detail.uomCode || "pcs" : "kg",
        qtyPer,
        parentMoQtyPlanned: isAssemblyInput ? toNumber(mo.qtyPlanned) : null,
        qtyPerKg: qtyPer > 0 && toNumber(mo.qtyPlanned) > 0
          ? roundQuantity(qtyRequired / toNumber(mo.qtyPlanned))
          : 0,
        scrapFactor: isAssemblyInput ? 0 : detail.scrapFactor || 0,
        configuredScrapFactor: detail.scrapFactor || 0,
        qtyRequiredOriginal,
        qtyRequiredFromMbom,
        qtyRequiredBeforePlannedCap,
        plannedOrderQtyKg: shouldUsePlannedKgRequirement ? plannedOrderQtyKg : null,
        originalUomCode: detail.uomCode || null,
        kgPerQty: isAssemblyInput ? null : resolveKgPerQty(detail.part),
        requirementUomMode: isAssemblyInput ? "ORIGINAL" : requirementUomMode,
        requirementSource: isSubAssembly
          ? "SubAssembly"
          : isDirectProductionInput
            ? "DirectProductionChild"
          : useOriginalUom
            ? "MBOMOriginal"
            : shouldUsePlannedKgRequirement
            ? "PlannedOrderKg"
            : mrpQtyRequired != null
              ? "MRPPlannedOrder"
              : "MBOM",
        qtyRequired,
      };
    })
    .filter((item) =>
      item.qtyRequired > 0
      && (item.category === "Purchase" || item.isSubAssembly || item.isDirectProductionInput),
    )
    // Reservation MO memakai nomor urut dari daftar material yang sudah difilter.
    // Compact ulang line number agar availability, reservation, dan Material Issue
    // selalu merujuk line yang sama meskipun MBOM memiliki inline process di antaranya.
    .map((item, index) => ({ ...item, lineNumber: index + 1 }));

  return { mbomHeader, items };
}

async function getRoutingOperations(tx, mo) {
  const mbomHeader = await getActiveMbomHeader(tx, mo.partId);
  if (!mbomHeader) return { mbomHeader: null, operations: [] };

  const mbomDetails = await tx.mBOMDetail.findMany({
    where: {
      noReg: mbomHeader.noReg,
      isDeleted: false,
      category: "inHouse",
    },
    include: {
      part: { select: { id: true, partCode: true, partNumber: true, partName: true, itemType: true, assemblyPolicy: true } },
      parentDetail: {
        select: {
          id: true,
          levelComponent: true,
          part: { select: { id: true, partCode: true, partNumber: true, partName: true, itemType: true, assemblyPolicy: true } },
        },
      },
      uom: { select: { uomCode: true, uomName: true } },
      mbomProcesses: {
        where: { isDeleted: false },
        include: {
          process: { select: { processCode: true, processName: true } },
          machine: {
            select: {
              id: true,
              machineCode: true,
              machineName: true,
              costingRate: true,
              costingRateType: true,
              currencyCode: true,
            },
          },
        },
        orderBy: { sequence: "asc" },
      },
    },
    orderBy: [{ levelComponent: "asc" }, { createdAt: "asc" }],
  });

  const operations = [];
  for (const detail of mbomDetails) {
    const qtyPer = toNumber(detail.qty, 1);
    const plannedQty = roundQuantity(qtyPer * toNumber(mo.qtyPlanned));

    for (const process of detail.mbomProcesses) {
      operations.push({
        mbomDetailId: detail.id,
        parentDetailId: detail.parentDetailId || null,
        levelComponent: detail.levelComponent || 0,
        componentPartId: detail.part?.id || null,
        componentPartCode: detail.part?.partCode || null,
        componentPartNumber: detail.part?.partNumber || null,
        componentPartName: detail.part?.partName || null,
        parentPartCode: detail.parentDetail?.part?.partCode || null,
        parentPartName: detail.parentDetail?.part?.partName || null,
        componentQtyPer: qtyPer,
        plannedQty,
        uomCode: detail.uomCode || mo.uomCode || null,
        processId: process.processId,
        machineId: process.machineId || null,
        machine: process.machine || null,
        process,
        routingNumber: process.routingNumber || null,
        sourceSequence: process.sequence || 0,
        sequence: process.sequence || operations.length + 1,
        cycleTime: process.cycleTime || 0,
      });
    }
  }

  return {
    mbomHeader,
    operations: canonicalizeRoutingOperations(operations),
  };
}

async function buildAvailability(tx, mo, options = {}) {
  const allocationStrategy = normalizeAllocationStrategy(options.allocationStrategy);
  if (mo?.inputSourceType === "WIP_STOCK" && mo?.sourceStockBalanceId) {
    const stockBalance = await tx.stockBalance.findFirst({
      where: {
        id: mo.sourceStockBalanceId,
        uomCode: mo.uomCode || null,
        isDeleted: false,
        stockType: "WIP",
      },
      select: {
        id: true,
        warehouseCode: true,
        rackCode: true,
        lotNumber: true,
        uomCode: true,
        partCode: true,
        partNumber: true,
        partName: true,
        qtyAvailable: true,
      },
    });

    const qtyRequired = roundQuantity(toNumber(mo.sourceQtyPlanned, toNumber(mo.qtyPlanned)));
    const qtyAvailable = roundQuantity(toNumber(stockBalance?.qtyAvailable));
    const shortage = Math.max(0, roundQuantity(qtyRequired - qtyAvailable));

    return {
      mbomHeader: null,
      isAvailable: shortage <= QUANTITY_TOLERANCE,
      summary: {
        qtyRequired,
        qtyAvailable,
        shortage,
        sourceType: "WIP_STOCK",
        allocationStrategy,
      },
      items: [{
        lineNumber: 1,
        partCode: stockBalance?.partCode || mo.sourcePartCode || null,
        partNumber: stockBalance?.partNumber || mo.sourcePartNumber || null,
        partName: stockBalance?.partName || mo.sourcePartName || null,
        qtyRequired,
        qtyAvailable,
        qtyReserved: 0,
        qtyIssued: 0,
        qtyRemaining: qtyRequired,
        shortage,
        warehouseCode: stockBalance?.warehouseCode || mo.sourceWarehouseCode || null,
        rackCode: stockBalance?.rackCode || mo.sourceRackCode || null,
        lotNumber: stockBalance?.lotNumber || mo.sourceLotNumber || null,
        stockBalanceId: stockBalance?.id || mo.sourceStockBalanceId || null,
        sourceType: "WIP_STOCK",
        isSufficient: shortage <= QUANTITY_TOLERANCE,
      }],
    };
  }

  const requirementUomMode = normalizeRequirementUomMode(
    options.requirementUomMode || mo?.materialRequirementUomMode,
  );
  const { mbomHeader, items } = await getMaterialRequirements(tx, mo, {
    requirementUomMode,
    includeDirectProductionInputs: options.includeDirectProductionInputs === true,
  });
  const availabilityItems = [];
  const reservations = mo?.moNumber && !options.ignoreReservations
    ? await tx.stockReservation.findMany({
        where: {
          referenceType: "MANUFACTURING_ORDER",
          referenceNumber: { startsWith: `${mo.moNumber}#` },
          status: { in: ["Active", "Released"] },
          isDeleted: false,
        },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const reservationsByLine = new Map();
  const consumedReservationQtyByLine = new Map();
  const warehouseCodes = new Set();
  const issuedByLine = new Map();

  const materialIssues = mo?.id && !options.ignoreMaterialIssues
    ? await tx.materialIssue.findMany({
        where: {
          moId: mo.id,
          isDeleted: false,
          status: { in: ["Issued", "Partially Returned", "Closed"] },
        },
        select: {
          issueNumber: true,
          issueDate: true,
          createdAt: true,
          issuedBy: true,
          warehouseCode: true,
          status: true,
          details: {
            where: { isDeleted: false },
            select: {
              lineNumber: true,
              qtyRequired: true,
              qtyIssued: true,
              qtyReturned: true,
              stockBalanceId: true,
              rackCode: true,
              lotNumber: true,
              partCode: true,
              partNumber: true,
              partName: true,
            },
          },
        },
      })
    : [];

  for (const issue of materialIssues) {
    for (const detail of issue.details || []) {
      const lineNumber = Number(detail.lineNumber);
      if (!Number.isFinite(lineNumber)) continue;

      const netIssued = Math.max(
        0,
        toNumber(detail.qtyIssued) - toNumber(detail.qtyReturned),
      );
      issuedByLine.set(
        lineNumber,
        roundQuantity(toNumber(issuedByLine.get(lineNumber)) + netIssued),
      );
    }
  }

  for (const reservation of reservations) {
    const lineToken = String(reservation.referenceNumber || "").split("#").pop()?.split("@")[0];
    const lineNumber = Number(lineToken);
    if (!Number.isFinite(lineNumber)) continue;

    const qtyReserved = Math.max(
      0,
      toNumber(reservation.qtyReserved) - toNumber(reservation.qtyReleased),
    );
    consumedReservationQtyByLine.set(
      lineNumber,
      roundQuantity(
        toNumber(consumedReservationQtyByLine.get(lineNumber)) +
        Math.min(toNumber(reservation.qtyReserved), toNumber(reservation.qtyReleased)),
      ),
    );
    if (qtyReserved <= 0) continue;

    if (reservation.warehouseCode) warehouseCodes.add(reservation.warehouseCode);
    if (!reservationsByLine.has(lineNumber)) reservationsByLine.set(lineNumber, []);
    reservationsByLine.get(lineNumber).push({
      reservationId: reservation.id,
      stockBalanceId: reservation.stockBalanceId || null,
      warehouseCode: reservation.warehouseCode || null,
      rackCode: reservation.rackCode || null,
      lotNumber: reservation.lotNumber || null,
      qtyReserved,
      partCode: reservation.partCode || null,
      partNumber: reservation.partNumber || null,
      partName: reservation.partName || null,
      productId: reservation.productId || null,
      description: reservation.description || null,
      spec: reservation.spec || null,
      thickness: reservation.thickness ?? null,
      width: reservation.width ?? null,
      CSP: reservation.CSP || null,
    });
  }

  for (const item of items) {
    const reservationSources = reservationsByLine.get(item.lineNumber) || [];
    const qtyReserved = roundQuantity(
      reservationSources.reduce((sum, source) => sum + toNumber(source.qtyReserved), 0),
    );
    const stockAgg = await tx.stockBalance.aggregate({
      where: {
        AND: [
          { partCode: item.partCode, uomCode: item.uomCode || null, isDeleted: false },
          buildExcludeSpecialRackCondition(),
        ],
      },
      _sum: { qtyAvailable: true },
    });
    const qtyAvailable = roundQuantity(stockAgg._sum.qtyAvailable);
    const candidateSources = reservationSources.length > 0
      ? []
      : await getAvailableStockSources(tx, item, {
          allocationStrategy,
          manualAllocations: options.manualAllocations,
        });
    for (const source of candidateSources) {
      if (source.warehouseCode) warehouseCodes.add(source.warehouseCode);
    }
    const enrichedReservationSources = await enrichSourceOrigins(tx, reservationSources);
    const enrichedCandidateSources = await enrichSourceOrigins(tx, candidateSources);
    const qtyIssued = item.isSubAssembly
      ? roundQuantity(consumedReservationQtyByLine.get(item.lineNumber) || 0)
      : roundQuantity(issuedByLine.get(item.lineNumber) || 0);
    const issueDocuments = item.isSubAssembly ? [] : materialIssues.flatMap((issue) => {
      const matchedDetails = (issue.details || []).filter(detail => Number(detail.lineNumber) === Number(item.lineNumber));
      return matchedDetails.map((detail) => {
        const netIssued = Math.max(0, toNumber(detail.qtyIssued) - toNumber(detail.qtyReturned));
        return {
          issueNumber: issue.issueNumber,
          issueDate: issue.issueDate || issue.createdAt || null,
          issuedBy: issue.issuedBy || null,
          warehouseCode: issue.warehouseCode || null,
          status: issue.status || null,
          lineNumber: detail.lineNumber,
          stockBalanceId: detail.stockBalanceId || null,
          rackCode: detail.rackCode || null,
          lotNumber: detail.lotNumber || null,
          partCode: detail.partCode || item.partCode || null,
          partNumber: detail.partNumber || item.partNumber || null,
          partName: detail.partName || item.partName || null,
          qtyRequired: toNumber(detail.qtyRequired),
          qtyIssued: toNumber(detail.qtyIssued),
          qtyReturned: toNumber(detail.qtyReturned),
          netIssued: roundQuantity(netIssued),
        };
      });
    });
    const issueRequired = roundQuantity(
      issueDocuments.reduce(
        (maxQty, detail) => Math.max(maxQty, toNumber(detail.qtyRequired)),
        0,
      ),
    );
    // Subassembly availability is driven by the parent MO quantity in pcs.
    // Material Issue history belongs to consumable materials and must not
    // override a subassembly requirement that happens to share a line number.
    const effectiveQtyRequired = item.isSubAssembly
      ? item.qtyRequired
      : issueRequired > 0
        ? issueRequired
        : item.qtyRequired;
    const historicalIssueSources = buildHistoricalIssueSources(issueDocuments);
    const enrichedHistoricalIssueSources = await enrichSourceOrigins(tx, historicalIssueSources);
    const sourceList = enrichedReservationSources.length > 0
      ? enrichedReservationSources
      : enrichedHistoricalIssueSources.length > 0
        ? enrichedHistoricalIssueSources
        : enrichedCandidateSources;
    const singleSource = sourceList.length === 1 ? sourceList[0] : null;
    const qtySourceAvailable = roundQuantity(sourceList.reduce((sum, source) => {
      const sourceQty =
        source.qtyReserved ??
        source.qtyCandidate ??
        source.qtyConsumed ??
        source.qtyHistorical ??
        source.qtyAvailable ??
        0;
      return sum + toNumber(sourceQty);
    }, 0));
    const displayQtyAvailable =
      enrichedReservationSources.length > 0 || enrichedHistoricalIssueSources.length > 0
        ? qtySourceAvailable
        : qtyAvailable;
    const qtyIssuable = roundQuantity(qtySourceAvailable);
    const qtyRemaining = Math.max(0, roundQuantity(effectiveQtyRequired - qtyIssued));
    const shortage = isPositiveQuantity(qtyRemaining - qtyIssuable)
      ? roundQuantity(qtyRemaining - qtyIssuable)
      : 0;

    availabilityItems.push({
      ...item,
      qtyRequired: effectiveQtyRequired,
      requirementSource:
        !item.isSubAssembly && issueRequired > 0
          ? "MaterialIssue"
          : item.requirementSource,
      stockBalanceId: singleSource?.stockBalanceId || null,
      warehouseCode: singleSource?.warehouseCode || null,
      rackCode: singleSource?.rackCode || null,
      lotNumber: singleSource?.lotNumber || null,
      reservationSources: enrichedReservationSources,
      candidateSources: enrichedCandidateSources,
      historicalSources: enrichedHistoricalIssueSources,
      sourceDetails: sourceList,
      issueDocuments,
      qtyReserved,
      qtyAvailable: displayQtyAvailable,
      qtyIssuable,
      qtyIssued,
      qtyRemaining,
      shortage,
      isSufficient: shortage === 0,
    });
  }

  const shortageItems = availabilityItems.filter((item) => !item.isSufficient);
  return {
    mbomHeader,
    items: availabilityItems,
    warehouseCode: warehouseCodes.size === 1 ? [...warehouseCodes][0] : null,
    warehouseCodes: [...warehouseCodes],
    summary: {
      total: availabilityItems.length,
      sufficient: availabilityItems.length - shortageItems.length,
      shortage: shortageItems.length,
      allocationStrategy,
      requirementUomMode,
    },
    isAvailable: shortageItems.length === 0,
  };
}

async function syncMaterialReservations(tx, mo, options = {}) {
  const { items } = await getMaterialRequirements(tx, mo, options);
  const reservationDetails = items.map((item) => ({
    isDeleted: false,
    qty: item.qtyRequired / Math.max(1, toNumber(mo.qtyPlanned, 1)),
    part: { partCode: item.partCode },
    uomCode: item.uomCode || null,
    category: item.category || "Purchase",
  }));
  await syncReservationsForMO(tx, mo, reservationDetails, {
    allocationStrategy: options.allocationStrategy,
    manualAllocations: options.manualAllocations,
  });
  return items;
}

async function generateWorkOrdersFromRouting(tx, mo, options = {}) {
  const existingCount = await tx.workOrder.count({
    where: { moId: mo.id, isDeleted: false },
  });
  if (existingCount > 0 && !options.force) {
    throw new Error("MO sudah memiliki Work Order. Hapus/cancel dulu jika ingin generate ulang.");
  }

  const { mbomHeader, operations } = await getRoutingOperations(tx, mo);
  if (!mbomHeader) {
    throw new Error(`MBOM aktif tidak ditemukan untuk part MO ${mo.moNumber}.`);
  }
  const requestedStartSequence = toNumber(
    options.startSequence ?? mo?.sourceStartSequence,
    0,
  ) || inferStartSequenceFromSourcePartCode(operations, mo?.sourcePartCode);
  const scopedOperations = requestedStartSequence > 0
    ? operations.filter(operation => toNumber(operation.sequence) >= requestedStartSequence)
    : operations;
  if (scopedOperations.length === 0) {
    throw new Error("Tidak ada routing process inHouse di MBOM untuk digenerate menjadi Work Order.");
  }

  const now = new Date();
  const prefix = buildWoPrefix(now);
  let plannedDate = mo.plannedStartDate || now;
  const created = [];

  for (const operation of scopedOperations) {
    const plannedQty = toNumber(operation.plannedQty, mo.qtyPlanned);
    const woNumber = await generateDailyNumber(tx, "workOrder", "woNumber", prefix);
    const wo = await tx.workOrder.create({
      data: {
        woNumber,
        woDate: now,
        moId: mo.id,
        mbomDetailId: operation.mbomDetailId || null,
        outputPartId: operation.componentPartId || null,
        outputPartCode: operation.componentPartCode || null,
        outputPartNumber: operation.componentPartNumber || null,
        outputPartName: operation.componentPartName || null,
        processId: operation.processId || null,
        machineId: operation.machineId || null,
        machineCostingRate: operation.machine?.costingRate ?? null,
        machineRateType: operation.machine?.costingRateType || null,
        machineCurrency: operation.machine?.currencyCode || null,
        plannedProcessCost: getPlannedProcessCost(operation.cycleTime, operation.machine),
        sequence: operation.sequence || created.length + 1,
        cycleTime: operation.cycleTime || 0,
        plannedDate,
        plannedQty,
        uomCode: operation.uomCode || mo.uomCode || null,
        status: options.status || "Planned",
        notes:
          options.notes ||
          `Generated from MBOM ${mbomHeader.noReg} routing (${operation.process?.process?.processName || operation.processId || "process"}) for ${operation.componentPartCode || "component"} x ${operation.componentQtyPer || 1}`,
      },
      include: {
        mbomDetail: {
          include: {
            part: {
              select: {
                partCode: true,
                partNumber: true,
                partName: true,
                itemType: true,
                assemblyPolicy: true,
              },
            },
            parentDetail: {
              include: {
                part: {
              select: {
                partCode: true,
                partNumber: true,
                partName: true,
                itemType: true,
                assemblyPolicy: true,
              },
            },
              },
            },
          },
        },
        process: { select: { processCode: true, processName: true } },
        machine: { select: { machineCode: true, machineName: true, costingRate: true, costingRateType: true, currencyCode: true } },
        uom: { select: { uomCode: true, uomName: true } },
      },
    });

    created.push(wo);

    const totalMinutes = toNumber(operation.cycleTime) * plannedQty;
    if (totalMinutes > 0) {
      plannedDate = new Date(plannedDate.getTime() + Math.ceil(totalMinutes / 480) * 86400000);
    }
  }

  return created;
}

async function coverDependentInHousePlannedOrdersForWorkOrders(tx, mo, workOrders = [], vendorProcessOrders = []) {
  const hasWorkOrders = Array.isArray(workOrders) && workOrders.length > 0;
  const hasVendorProcessOrders = Array.isArray(vendorProcessOrders) && vendorProcessOrders.length > 0;
  if (!mo?.plannedOrderNumber || (!hasWorkOrders && !hasVendorProcessOrders)) {
    return [];
  }

  const rootPlannedOrder = await tx.plannedOrder.findUnique({
    where: { orderNumber: mo.plannedOrderNumber },
    select: {
      orderNumber: true,
      runNumber: true,
      referenceNumber: true,
      partCode: true,
      requiredDate: true,
      orderDate: true,
    },
  });
  if (!rootPlannedOrder?.runNumber) return [];

  const subAssemblyOperationPartCodes = [
    ...new Set(
      workOrders
        .filter((wo) => isSubAssemblyDetail(wo.mbomDetail || {}))
        .map((wo) => wo.mbomDetail?.part?.partCode || wo.outputPartCode)
        .filter(Boolean),
    ),
  ];
  const operationPartCodes = [
    ...new Set(
      [
        ...workOrders
          .filter((wo) => !isSubAssemblyDetail(wo.mbomDetail || {}))
          .map((wo) => wo.mbomDetail?.part?.partCode || wo.outputPartCode),
        ...vendorProcessOrders.flatMap((order) => [order.inputPartCode, order.outputPartCode]),
      ]
        .filter(Boolean),
    ),
  ];

  const planScopeConditions = [{ runNumber: rootPlannedOrder.runNumber }];
  if (rootPlannedOrder.referenceNumber) {
    planScopeConditions.push({ referenceNumber: rootPlannedOrder.referenceNumber });
  }

  // SUB_ASSEMBLY tetap membutuhkan supply/MO sendiri. WO routing parent hanya
  // memproses input tersebut dan tidak boleh menutup planned order-nya.
  if (subAssemblyOperationPartCodes.length > 0) {
    await tx.plannedOrder.updateMany({
      where: {
        orderNumber: { not: rootPlannedOrder.orderNumber },
        orderType: "Production",
        status: "Covered",
        isDeleted: false,
        partCode: { in: subAssemblyOperationPartCodes },
        OR: planScopeConditions,
      },
      data: { status: "Planned" },
    });
  }

  if (operationPartCodes.length === 0) return [];

  const plannedOrderWhere = {
    orderNumber: { not: rootPlannedOrder.orderNumber },
    orderType: "Production",
    status: "Planned",
    isDeleted: false,
    partCode: { in: operationPartCodes },
    OR: planScopeConditions,
  };
  const plannedOrders = await tx.plannedOrder.findMany({
    where: plannedOrderWhere,
    select: { orderNumber: true },
  });
  const orderNumbers = [...new Set(plannedOrders.map((order) => order.orderNumber))];
  if (orderNumbers.length === 0) return [];

  await tx.plannedOrder.updateMany({
    where: { orderNumber: { in: orderNumbers }, status: "Planned", isDeleted: false },
    data: {
      status: "Covered",
    },
  });

  return tx.plannedOrder.findMany({
    where: { orderNumber: { in: orderNumbers } },
  });
}

async function releaseManufacturingOrder(tx, mo, options = {}) {
  if (!["Draft", "Planned"].includes(mo.status)) {
    throw new Error(`MO tidak bisa direlease dari status "${mo.status}".`);
  }

  if (mo.inputSourceType === "WIP_STOCK") {
    const availability = await buildAvailability(tx, mo, options);
    if (!availability.isAvailable && !options.allowShortage) {
      const shortage = roundQuantity(toNumber(availability.summary?.shortage));
      throw new Error(`WIP source belum cukup untuk release MO ${mo.moNumber}: kurang ${shortage}`);
    }

    if (!options.skipReservation) {
      await reserveSourceWipForMO(tx, mo);
    }

    const updated = await tx.manufacturingOrder.update({
      where: { id: mo.id },
      data: { status: "Released" },
    });

    return { manufacturingOrder: updated, availability, workOrders: [] };
  }

  const availability = await buildAvailability(tx, mo, options);
  if (!availability.mbomHeader) {
    throw new Error(`MBOM aktif tidak ditemukan untuk MO ${mo.moNumber}.`);
  }
  if (!availability.isAvailable && !options.allowShortage) {
    const shortageCodes = availability.items
      .filter((item) => !item.isSufficient)
      .map((item) => `${item.partCode} kurang ${item.shortage}`)
      .join(", ");
    throw new Error(`Material belum cukup untuk release MO ${mo.moNumber}: ${shortageCodes}`);
  }

  if (availability.items.length > 0 && !options.skipReservation) {
    await syncMaterialReservations(tx, mo, options);
  }

  const updated = await tx.manufacturingOrder.update({
    where: { id: mo.id },
    data: {
      status: "Released",
      materialRequirementUomMode: normalizeRequirementUomMode(
        options.requirementUomMode || mo.materialRequirementUomMode,
      ),
    },
  });

  return { manufacturingOrder: updated, availability, workOrders: [] };
}

async function startManufacturingOrder(tx, mo) {
  if (!["Released", "In Progress", "FG Ready to Receipt"].includes(mo.status)) {
    throw new Error(`MO harus Release dulu sebelum mulai produksi. Status sekarang "${mo.status}".`);
  }

  const activeWoCount = await tx.workOrder.count({
    where: {
      moId: mo.id,
      isDeleted: false,
      status: { in: ["Released", "Material Issued", "In Production", "Rework", "Planned", "In Progress"] },
    },
  });
  const activeVendorProcessCount = await tx.vendorProcessOrder.count({
    where: {
      moId: mo.id,
      isDeleted: false,
      status: { in: ["Planned", "Ready to Send", "Sent", "Partial Sent", "Partial Received", "QC Hold"] },
    },
  });
  if (activeWoCount === 0 && activeVendorProcessCount === 0) {
    throw new Error("MO belum punya Work Order atau Vendor Process Order aktif. Generate routing dulu sebelum mulai produksi.");
  }

  const updated = await tx.manufacturingOrder.update({
    where: { id: mo.id },
    data: {
      status: "In Progress",
      actualStartDate: mo.actualStartDate || new Date(),
    },
  });

  await tx.workOrder.updateMany({
    where: { moId: mo.id, isDeleted: false, status: "Planned" },
    data: { status: "Released" },
  });

  return updated;
}

async function validateMoCanComplete(tx, mo, options = {}) {
  const [workOrders, vendorProcessOrders] = await Promise.all([
    tx.workOrder.findMany({
      where: { moId: mo.id, isDeleted: false, status: { not: "Cancelled" } },
      select: {
        woNumber: true,
        status: true,
        sequence: true,
        qtyProduced: true,
        qtyGood: true,
        qtyReject: true,
      },
      orderBy: { sequence: "asc" },
    }),
    tx.vendorProcessOrder.findMany({
      where: { moId: mo.id, isDeleted: false, status: { not: "Cancelled" } },
      select: {
        orderNumber: true,
        status: true,
        sequence: true,
        qtyReceived: true,
        qtyAccepted: true,
        qtyReject: true,
        qtyScrap: true,
      },
      orderBy: { sequence: "asc" },
    }),
  ]);

  if (workOrders.length === 0 && vendorProcessOrders.length === 0) {
    throw new Error("MO belum punya Work Order atau Vendor Process Order, tidak bisa complete.");
  }

  const unfinished = workOrders.filter((wo) => wo.status !== "Completed");
  if (unfinished.length > 0 && !options.allowIncompleteWorkOrders) {
    throw new Error(`Masih ada WO belum Completed: ${unfinished.map((wo) => wo.woNumber).join(", ")}`);
  }
  const unfinishedVendorOrders = vendorProcessOrders.filter((order) => !["Completed", "Closed"].includes(order.status));
  if (unfinishedVendorOrders.length > 0 && !options.allowIncompleteWorkOrders) {
    throw new Error(`Masih ada Vendor Process belum Completed: ${unfinishedVendorOrders.map((order) => order.orderNumber).join(", ")}`);
  }

  const openMaterialIssues = await tx.materialIssue.findMany({
    where: {
      moId: mo.id,
      isDeleted: false,
      status: { in: ["Draft", "Issued", "Partially Returned"] },
    },
    select: { issueNumber: true, status: true },
  });
  if (openMaterialIssues.length > 0 && !options.allowOpenMaterialIssues) {
    throw new Error(`Masih ada Material Issue belum Closed: ${openMaterialIssues.map((mi) => mi.issueNumber).join(", ")}`);
  }

  const blockingQc = await tx.qualityInspection.findMany({
    where: {
      moId: mo.id,
      isDeleted: false,
      status: { not: "Completed" },
    },
    select: { inspectionNumber: true, status: true },
  });
  if (blockingQc.length > 0 && !options.allowOpenQc) {
    throw new Error(`Masih ada QC belum Completed: ${blockingQc.map((qc) => qc.inspectionNumber).join(", ")}`);
  }

  const rejectedQc = await tx.qualityInspection.findMany({
    where: {
      moId: mo.id,
      isDeleted: false,
      status: "Completed",
      decision: { notIn: COMPLETED_QC_DECISIONS },
    },
    select: { inspectionNumber: true, decision: true },
  });
  if (rejectedQc.length > 0 && !options.allowRejectedQc) {
    throw new Error(`Masih ada QC belum accepted: ${rejectedQc.map((qc) => `${qc.inspectionNumber} (${qc.decision})`).join(", ")}`);
  }

  return { workOrders, vendorProcessOrders, openMaterialIssues, blockingQc, rejectedQc };
}

function getFinalWorkOrder(workOrders = []) {
  return [...workOrders]
    .filter((wo) => wo.status !== "Cancelled")
    .sort((a, b) => toNumber(b.sequence) - toNumber(a.sequence))[0] || null;
}

async function receiveFinishedGoods(tx, mo, qtyGood, stockTarget, performedBy) {
  if (!stockTarget?.warehouseCode || qtyGood <= 0 || !mo.part?.partCode) return null;

  const now = new Date();
  const stockIdentity = resolvePartStockIdentity(mo.part);
  const balanceWhere = {
    warehouseCode: stockTarget.warehouseCode,
    rackCode: stockTarget.rackCode || null,
    lotNumber: stockTarget.lotNumber || null,
    partCode: mo.part.partCode,
    productId: null,
    description: null,
    ...stockIdentity,
    uomCode: mo.uomCode || null,
    isDeleted: false,
  };

  const existingBalance = await tx.stockBalance.findFirst({
    where: balanceWhere,
    select: { id: true, qtyOnHand: true, qtyReserved: true },
  });

  const qtyBefore = toNumber(existingBalance?.qtyOnHand);
  const qtyAfter = qtyBefore + qtyGood;
  const qtyReserved = toNumber(existingBalance?.qtyReserved);
  const movementNumber = await generateMovementNumber("IN", tx);

  await tx.stockMovement.create({
    data: {
      movementNumber,
      movementDate: now,
      movementType: "IN",
      direction: "IN",
      transactionType: "PRODUCTION",
      warehouseCode: stockTarget.warehouseCode,
      rackCode: stockTarget.rackCode || null,
      lotNumber: stockTarget.lotNumber || null,
      partCode: mo.part.partCode,
      ...stockIdentity,
      stockType: "Finished Goods",
      qty: qtyGood,
      deltaQty: qtyGood,
      qtyBefore,
      qtyAfter,
      uomCode: mo.uomCode || null,
      referenceType: "MANUFACTURING_ORDER",
      referenceNumber: mo.moNumber,
      notes: `FG receipt from MO ${mo.moNumber}`,
      performedBy,
    },
  });

  if (existingBalance) {
    await assertStockBalanceNotFrozen(tx, existingBalance.id);
    await tx.stockBalance.update({
      where: { id: existingBalance.id },
      data: {
        qtyOnHand: qtyAfter,
        qtyAvailable: qtyAfter - qtyReserved,
        lastMovement: now,
      },
    });
  } else {
    await tx.stockBalance.create({
      data: {
        warehouseCode: stockTarget.warehouseCode,
        rackCode: stockTarget.rackCode || null,
        lotNumber: stockTarget.lotNumber || null,
        partCode: mo.part.partCode,
        ...stockIdentity,
        uomCode: mo.uomCode || null,
        stockType: "Finished Goods",
        qtyOnHand: qtyGood,
        qtyReserved: 0,
        qtyAvailable: qtyGood,
        lastMovement: now,
      },
    });
  }

  await createWIPEntry(tx, {
    entryDate: now,
    moId: mo.id,
    costType: "Material",
    sourceType: "FGReceipt",
    sourceId: mo.id,
    sourceRef: mo.moNumber,
    qty: qtyGood,
    rate: 0,
    amount: 0,
    direction: "OUT",
    notes: `FG receipt MO ${mo.moNumber}`,
    createdBy: performedBy,
  });

  return movementNumber;
}

async function completeManufacturingOrder(tx, mo, options = {}) {
  if (!["In Progress", "FG Ready to Receipt"].includes(mo.status)) {
    throw new Error(`MO tidak bisa complete dari status "${mo.status}".`);
  }

  const { workOrders, vendorProcessOrders } = await validateMoCanComplete(tx, mo, options);
  const finalWorkOrder = getFinalWorkOrder(workOrders);
  const finalVendorProcessOrder = vendorProcessOrders.length > 0
    ? vendorProcessOrders[vendorProcessOrders.length - 1]
    : null;
  const finalSource = !finalVendorProcessOrder
    || toNumber(finalWorkOrder?.sequence) >= toNumber(finalVendorProcessOrder?.sequence)
    ? { type: "WO", row: finalWorkOrder }
    : { type: "VENDOR", row: finalVendorProcessOrder };
  const totalProduced = finalSource.type === "VENDOR"
    ? toNumber(finalSource.row?.qtyReceived)
    : toNumber(finalSource.row?.qtyProduced);
  const totalGood = finalSource.type === "VENDOR"
    ? toNumber(finalSource.row?.qtyAccepted)
    : toNumber(finalSource.row?.qtyGood);
  const totalReject = finalSource.type === "VENDOR"
    ? toNumber(finalSource.row?.qtyReject) + toNumber(finalSource.row?.qtyScrap)
    : toNumber(finalSource.row?.qtyReject);
  const finalGood = options.qtyGood !== undefined ? toNumber(options.qtyGood) : totalGood;
  const finalProduced = options.qtyProduced !== undefined ? toNumber(options.qtyProduced) : totalProduced;
  const finalReject = options.qtyReject !== undefined ? toNumber(options.qtyReject) : totalReject;
  const plannedQty = toNumber(mo.qtyPlanned);

  if (finalGood <= 0 && !options.allowZeroGood) {
    throw new Error("Qty good masih 0. Complete MO hanya boleh setelah ada output good.");
  }

  if (
    plannedQty > 0
    && finalGood + QUANTITY_TOLERANCE < plannedQty
    && !options.allowUnderPlannedQty
  ) {
    throw new Error(
      `Qty OK/FG akhir (${finalGood}) masih kurang dari MO Planned Qty (${plannedQty}). MO belum bisa Completed.`,
    );
  }

  const updated = await tx.manufacturingOrder.update({
    where: { id: mo.id },
    data: {
      status: "Completed",
      actualEndDate: new Date(),
      qtyProduced: finalProduced,
      qtyGood: finalGood,
      qtyReject: finalReject,
    },
  });

  if (options.receiveFinishedGoods) {
    await receiveFinishedGoods(tx, mo, finalGood, options.stockTarget, options.performedBy || "system");
  }

  if (finalReject > 0) {
    await createWIPEntry(tx, {
      entryDate: new Date(),
      moId: mo.id,
      costType: "Scrap",
      sourceType: "ManufacturingOrder",
      sourceId: mo.id,
      sourceRef: mo.moNumber,
      qty: finalReject,
      rate: 0,
      amount: 0,
      direction: "OUT",
      notes: `Scrap MO ${mo.moNumber}`,
      createdBy: options.performedBy || "system",
    });
  }

  await releaseReservationsForMO(tx, mo.moNumber, "Released");
  return updated;
}

async function syncManufacturingOrderQtyFromWorkOrders(tx, moId) {
  if (!moId) return null;

  const [mo, workOrders, vendorProcessOrders, openQcCount, rejectedQcCount, openMaterialIssueCount, completedFinalQcs] = await Promise.all([
    tx.manufacturingOrder.findUnique({
      where: { id: moId },
      select: { id: true, moNumber: true, parentMoNumber: true, status: true, qtyPlanned: true },
    }),
    tx.workOrder.findMany({
      where: {
        moId,
        isDeleted: false,
        status: { not: "Cancelled" },
      },
      orderBy: [{ sequence: "asc" }, { plannedDate: "asc" }, { createdAt: "asc" }],
      select: {
        status: true,
        sequence: true,
        plannedDate: true,
        createdAt: true,
        qtyProduced: true,
        qtyGood: true,
        qtyReject: true,
      },
    }),
    tx.vendorProcessOrder.findMany({
      where: {
        moId,
        isDeleted: false,
        status: { not: "Cancelled" },
      },
      orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
      select: {
        status: true,
        sequence: true,
        createdAt: true,
        qtyReceived: true,
        qtyAccepted: true,
        qtyReject: true,
        qtyRework: true,
        qtyScrap: true,
      },
    }),
    tx.qualityInspection.count({
      where: { moId, isDeleted: false, status: { not: "Completed" } },
    }),
    tx.qualityInspection.count({
      where: {
        moId,
        isDeleted: false,
        status: "Completed",
        decision: { notIn: COMPLETED_QC_DECISIONS },
      },
    }),
    tx.materialIssue.count({
      where: {
        moId,
        isDeleted: false,
        status: { in: ["Draft", "Issued", "Partially Returned"] },
      },
    }),
    tx.qualityInspection.findMany({
      where: {
        moId,
        isDeleted: false,
        status: "Completed",
        productionLogId: { not: null },
        qtyPassed: { gt: 0 },
      },
      select: {
        inspectionNumber: true,
        qtyPassed: true,
        workOrder: {
          select: {
            id: true,
            moId: true,
            sequence: true,
          },
        },
      },
    }),
  ]);
  if (!mo) return null;

  const childManufacturingOrders = await tx.manufacturingOrder.findMany({
    where: {
      parentMoNumber: mo.moNumber,
      isDeleted: false,
      status: { not: "Cancelled" },
    },
    select: {
      status: true,
      qtyGood: true,
    },
  });
  const completedChildGood = childManufacturingOrders
    .filter((child) => child.status === "Completed")
    .reduce((sum, child) => sum + toNumber(child.qtyGood), 0);

  const finalWorkOrder = getFinalWorkOrder(workOrders);
  const finalVendorProcessOrder = vendorProcessOrders.length > 0
    ? vendorProcessOrders[vendorProcessOrders.length - 1]
    : null;
  const finalSource = !finalVendorProcessOrder
    || toNumber(finalWorkOrder?.sequence) >= toNumber(finalVendorProcessOrder?.sequence)
    ? { type: "WO", row: finalWorkOrder }
    : { type: "VENDOR", row: finalVendorProcessOrder };
  const finalProduced = finalSource.type === "VENDOR"
    ? toNumber(finalSource.row?.qtyReceived)
    : toNumber(finalSource.row?.qtyProduced);
  const finalAcceptedGood = finalSource.type === "VENDOR"
    ? toNumber(finalSource.row?.qtyAccepted)
    : toNumber(finalSource.row?.qtyGood);
  const finalReject = finalSource.type === "VENDOR"
    ? toNumber(finalSource.row?.qtyReject) + toNumber(finalSource.row?.qtyScrap)
    : toNumber(finalSource.row?.qtyReject);
  const finalWoSequence = toNumber(finalWorkOrder?.sequence);
  const completedFinalWoQcs = completedFinalQcs.filter((inspection) => (
    inspection.workOrder?.moId === moId
    && toNumber(inspection.workOrder.sequence) === finalWoSequence
  ));
  const completedFinalQcQty = completedFinalWoQcs.reduce(
    (sum, inspection) => sum + toNumber(inspection.qtyPassed),
    0,
  );
  const fgReceiptMovements = completedFinalWoQcs.length > 0
    ? await tx.stockMovement.aggregate({
        where: {
          referenceType: "QUALITY_INSPECTION",
          referenceNumber: { in: completedFinalWoQcs.map((inspection) => inspection.inspectionNumber) },
          transactionType: "PRODUCTION",
          movementType: "IN",
          stockType: "Finished Goods",
          isDeleted: false,
        },
        _sum: { qty: true },
      })
    : { _sum: { qty: 0 } };
  const receivedFgQty = toNumber(fgReceiptMovements._sum.qty);
  const fulfilledReceiptQty = roundQuantity(receivedFgQty + completedChildGood);
  const hasAnyFgReceipt = receivedFgQty > QUANTITY_TOLERANCE;
  const plannedQty = toNumber(mo.qtyPlanned);
  const productionMeetsPlannedQty = plannedQty <= 0 || finalAcceptedGood + completedChildGood + QUANTITY_TOLERANCE >= plannedQty;
  const receiptMeetsPlannedQty = plannedQty <= 0 || fulfilledReceiptQty + QUANTITY_TOLERANCE >= plannedQty;
  const hasPendingFgReceipt = completedFinalQcQty > 0
    && receivedFgQty + QUANTITY_TOLERANCE < completedFinalQcQty;
  const productionFlowDone =
    (workOrders.length > 0 || vendorProcessOrders.length > 0) &&
    workOrders.every((wo) => wo.status === "Completed") &&
    vendorProcessOrders.every((order) => ["Completed", "Closed"].includes(order.status)) &&
    openQcCount === 0 &&
    rejectedQcCount === 0 &&
    openMaterialIssueCount === 0 &&
    finalAcceptedGood + completedChildGood > 0;
  // Legacy records may retain an open material-issue flag after QC/FG receipt.
  // The completed receipt is still terminal evidence for the MO.
  const receiptFlowDone =
    hasAnyFgReceipt &&
    (workOrders.length > 0 || vendorProcessOrders.length > 0) &&
    workOrders.every((wo) => wo.status === "Completed") &&
    vendorProcessOrders.every((order) => ["Completed", "Closed"].includes(order.status)) &&
    openQcCount === 0 &&
    rejectedQcCount === 0 &&
    receiptMeetsPlannedQty;
  // A released MO may already have its final WO/QC/FG receipt completed
  // (for example when Production consumes a daily plan directly).  Do not
  // leave it stuck in Released once terminal evidence is present.
  const canAutoComplete =
    ["Released", "In Progress", "FG Ready to Receipt"].includes(mo.status) &&
    (productionFlowDone || receiptFlowDone) &&
    receiptMeetsPlannedQty &&
    !hasPendingFgReceipt;

  const updateData = {
    qtyProduced: finalProduced,
    qtyGood: receivedFgQty,
    qtyReject: finalReject,
  };

  if (
    productionFlowDone
    && hasPendingFgReceipt
    && !["Cancelled"].includes(mo.status)
  ) {
    updateData.status = "FG Ready to Receipt";
    updateData.actualEndDate = null;
  }

  if (
    !hasPendingFgReceipt
    &&
    !productionMeetsPlannedQty
    && (
      ["FG Ready to Receipt", "Completed"].includes(mo.status)
      || (productionFlowDone && hasAnyFgReceipt)
      || (productionFlowDone && !hasAnyFgReceipt)
    )
  ) {
    updateData.status = "In Progress";
    updateData.actualEndDate = null;
  }

  if (canAutoComplete) {
    if (openMaterialIssueCount > 0) {
      await tx.materialIssue.updateMany({
        where: { moId, isDeleted: false, status: { in: ["Draft", "Issued", "Partially Returned"] } },
        data: { status: "Closed", notes: "Auto-closed after completed QC and FG receipt." },
      });
    }
    updateData.status = "Completed";
    updateData.actualEndDate = new Date();
    await releaseReservationsForMO(tx, mo.moNumber, "Released");
  }

  const updatedMo = await tx.manufacturingOrder.update({
    where: { id: moId },
    data: updateData,
  });

  if (mo.parentMoNumber) {
    const parentMo = await tx.manufacturingOrder.findUnique({
      where: { moNumber: mo.parentMoNumber },
      select: { id: true, isDeleted: true },
    });
    if (parentMo && !parentMo.isDeleted) {
      await syncManufacturingOrderQtyFromWorkOrders(tx, parentMo.id);
    }
  }

  return updatedMo;
}

module.exports = {
  ACTIVE_WO_STATUSES,
  buildAvailability,
  completeManufacturingOrder,
  coverDependentInHousePlannedOrdersForWorkOrders,
  generateWorkOrdersFromRouting,
  getRoutingOperations,
  getMaterialRequirements,
  releaseManufacturingOrder,
  startManufacturingOrder,
  syncManufacturingOrderQtyFromWorkOrders,
  syncMaterialReservations,
  validateMoCanComplete,
};
