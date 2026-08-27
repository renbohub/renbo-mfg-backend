const { randomUUID } = require("crypto");
const { Prisma } = require("@prisma/client");
const { prisma } = require("../../index");
const { nextMonthlyMrpIdentity } = require("../../services/planning/mrpPlanningIdentityService");
const {
  planningMonthKey,
  nextPlanningMonthKey,
} = require("../../utils/planningMonth");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { parseDate } = require("../../utils/parseDate");
const { parseFilter } = require("../../utils/parseFilter");
const { getSoDemandTimeFenceSetting } = require("../../utils/systemSettings");
const {
  buildExcludeSpecialRackCondition,
} = require("../inventory/utils/stockReservationHelpers");
const {
  syncOperationalSalesOrderStatus,
} = require("../../services/production/sales-order/soStatusService");
const {
  emitPlanningMrpRunUpdate,
  emitPlanningPlannedOrderBulkUpdate,
} = require("./services/planningRealtimeService");
const { isSubAssemblyDetail } = require("../../utils/assemblyPolicy");
const { durationToWorkingDays } = require("../../utils/duration");
const { effectiveDemandQty: resolvePolicyDemandQty } = require("../../services/planning/demandConsumptionService");
const { netTimePhasedDemand } = require("../../services/planning/timePhasedNettingService");
const { procurementSchedule } = require("../../services/planning/procurementSchedulingService");
const { resolveProductionRequirementDates } = require("../../services/planning/mrpDueDateService");
const {
  loadDemandPlanningConstraintMap,
  applyDecisionToRoutingMetric,
  procurementPolicyFromDecision,
} = require("../../services/planning/demandPlanningConstraintService");
const { isUncommittedPlannedSupply } = require("../../services/planning/plannedSupplyCommitmentService");
const { getFormulaSet, evaluateFromSet } = require("../../services/masterFormulaService");
const hybridMrpService = require("../../services/planning/hybridMrpService");
const {
  generateForRun: generatePurchaseSuggestionForRun,
  routingMetricsForRequests,
} = require("../purchasing/PurchaseSuggestionController");
const { procurementView, customerPeggingView } = require("../../services/planning/mrpPresentationService");
const { getMpsDeliveryGate, assertOfficialMpsDeliveryGate } = require("../../services/planning/mpsDeliveryFeasibilityService");
const {
  canonicalMrpLifecycleStatus,
  mrpCalculationLifecycle,
  mrpApprovalEligibility,
  mrpApprovalTransitionData,
  mrpApprovalCycleMpsNumbers,
  assertApprovedCurrentMrp,
  buildMrpSourceSnapshot,
  mrpSourceSnapshotMatches,
} = require("../../services/planning/mrpLifecycleService");
const { deltaMrpMetadata, currentScopeWhere } = require("../../services/planning/planningDeltaMrpService");
const { attachBaselineMrp } = require("../../services/planning/planningBaselineLockService");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const GENERATED_MPS_CHILD_NOTE_PREFIX = "[MRP-PRODUCTION]";
const M_PLUS_ONE_PREVIEW_TREE_VERSION = 3;
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

function isCurrentMPlusOnePreviewRun(run = {}) {
  const assumptions = run?.scenarioAssumptions || {};
  return String(assumptions.planningMode || "").trim().toUpperCase() === "M_PLUS_ONE_PREVIEW"
    && Number(assumptions.previewTreeVersion || 0) >= M_PLUS_ONE_PREVIEW_TREE_VERSION;
}

function createRequirementIdentity(parentRequirementId = null, rootRequirementId = null) {
  const id = randomUUID();
  return {
    id,
    parentRequirementId,
    rootRequirementId: rootRequirementId || id,
  };
}

function formatTreeSegment(value) {
  return String(Math.max(Number(value || 0), 0)).padStart(4, "0");
}

function buildRequirementTreePath(parentTreePath, level, sequence) {
  const segment = `${formatTreeSegment(level)}-${formatTreeSegment(sequence)}`;
  return parentTreePath ? `${parentTreePath}.${segment}` : segment;
}

function sortMbomDetailsParentFirst(details = []) {
  const detailById = new Map(details.map((detail) => [detail.id, detail]));
  const depthById = new Map();
  const getDepth = (detail, visiting = new Set()) => {
    if (depthById.has(detail.id)) return depthById.get(detail.id);
    if (!detail.parentDetailId || !detailById.has(detail.parentDetailId)) return 0;
    if (visiting.has(detail.id)) return 0;

    const nextVisiting = new Set(visiting).add(detail.id);
    const depth = getDepth(detailById.get(detail.parentDetailId), nextVisiting) + 1;
    depthById.set(detail.id, depth);
    return depth;
  };

  return details
    .map((detail, index) => ({ detail, index, depth: getDepth(detail) }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index)
    .map(({ detail }) => detail);
}

function resolvePlanHorizonDays(planHorizonInput, periodStart, periodEnd) {
  const parsedInput = Number(planHorizonInput);
  if (Number.isFinite(parsedInput) && parsedInput > 0) {
    return Math.max(Math.trunc(parsedInput), 1);
  }

  const start = parseDate(periodStart);
  const end = parseDate(periodEnd);
  if (!start || !end) {
    return 90;
  }

  const diffDays = Math.ceil((end.getTime() - start.getTime()) / MS_PER_DAY);
  return Math.max(diffDays, 1);
}

function buildMbomValidityWhere(targetDate) {
  const validOn = parseDate(targetDate);
  return {
    AND: [
      {
        OR: [{ effectiveDate: null }, { effectiveDate: { lte: validOn } }],
      },
      {
        OR: [{ expiryDate: null }, { expiryDate: { gte: validOn } }],
      },
    ],
  };
}

async function findActiveMbomHeader(tx, partId, targetDate) {
  if (!partId) return null;

  return tx.mBOMHeader.findFirst({
    where: {
      partId,
      isDeleted: false,
      ...buildMbomValidityWhere(targetDate),
    },
    orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
    select: { id: true, uomCode: true },
  });
}

async function supersedePreviousMrpArtifacts(tx, mpsNumberOrNumbers, currentRunNumber, runBy) {
  const sourceMpsNumbers = [...new Set(
    (Array.isArray(mpsNumberOrNumbers) ? mpsNumberOrNumbers : [mpsNumberOrNumbers])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )];
  if (sourceMpsNumbers.length === 0) return;

  const previousRuns = await tx.mRPRun.findMany({
    where: {
      mpsNumber: { in: sourceMpsNumbers },
      isDeleted: false,
      runNumber: { not: currentRunNumber },
    },
    select: { runNumber: true },
  });

  const previousRunNumbers = previousRuns.map((row) => row.runNumber).filter(Boolean);
  if (previousRunNumbers.length === 0) return;

  const generatedMpsDetails = await tx.mPSDetail.findMany({
    where: {
      isDeleted: false,
      notes: { startsWith: GENERATED_MPS_CHILD_NOTE_PREFIX },
      OR: previousRunNumbers.map((previousRunNumber) => ({ notes: { contains: `Generated from ${previousRunNumber}` } })),
    },
    select: { id: true },
  });
  const generatedMpsDetailIds = generatedMpsDetails.map((row) => row.id);
  const executionDetailLineageFilters = [
    ...(generatedMpsDetailIds.length ? [{ mpsDetailId: { in: generatedMpsDetailIds } }] : []),
    ...previousRunNumbers.map((previousRunNumber) => ({ notes: { contains: `[MRP-RUN:${previousRunNumber}]` } })),
  ];
  const generatedExecutionDetails = executionDetailLineageFilters.length ? await tx.monthlyProductionPlanDetail.findMany({
    where: { isDeleted: false, OR: executionDetailLineageFilters },
    select: {
      plannedOrderNumber: true,
      qtyReleased: true,
      status: true,
      plan: { select: { planNumber: true, status: true } },
    },
  }) : [];
  const generatedExecutionPlanNumbers = [...new Set(generatedExecutionDetails.map((row) => row.plan?.planNumber).filter(Boolean))];
  const generatedMoCount = generatedExecutionPlanNumbers.length ? await tx.manufacturingOrder.count({
    where: { isDeleted: false, status: { not: "Cancelled" }, monthlyProductionPlanNumber: { in: generatedExecutionPlanNumbers } },
  }) : 0;
  const previousPlannedOrders = await tx.plannedOrder.findMany({
    where: { isDeleted: false, referenceType: "MRP", runNumber: { in: previousRunNumbers } },
    select: { orderNumber: true, status: true, qtyReleased: true },
  });
  const previousOrderNumbers = previousPlannedOrders.map((row) => row.orderNumber).filter(Boolean);
  const [linkedManufacturingOrders, releasedPlanDetails] = await Promise.all([
    previousOrderNumbers.length ? tx.manufacturingOrder.findMany({
      where: {
        isDeleted: false,
        status: { not: "Cancelled" },
        OR: [
          { plannedOrderNumber: { in: previousOrderNumbers } },
          { sourcePlannedOrderNumber: { in: previousOrderNumbers } },
        ],
      },
      select: { plannedOrderNumber: true, sourcePlannedOrderNumber: true },
    }) : [],
    previousOrderNumbers.length ? tx.monthlyProductionPlanDetail.findMany({
      where: {
        isDeleted: false,
        plannedOrderNumber: { in: previousOrderNumbers },
        OR: [
          { qtyReleased: { gt: 0 } },
          { status: { in: ["Partially Released", "Released", "Completed"] } },
          { plan: { status: { in: ["Confirmed", "Released", "Closed"] } } },
        ],
      },
      select: { plannedOrderNumber: true },
    }) : [],
  ]);
  const protectedPreviousOrderNumbers = [...new Set([
    ...previousPlannedOrders
      .filter((row) => Number(row.qtyReleased || 0) > 0
        || !["Draft", "Planned", "Simulation", "Superseded", "Cancelled"].includes(row.status))
      .map((row) => row.orderNumber),
    ...linkedManufacturingOrders.flatMap((row) => [row.plannedOrderNumber, row.sourcePlannedOrderNumber]),
    ...releasedPlanDetails.map((row) => row.plannedOrderNumber),
    ...generatedExecutionDetails.map((row) => row.plannedOrderNumber),
  ].filter(Boolean))];
  const protectedExecutionCount = generatedExecutionDetails.filter((row) => Number(row.qtyReleased || 0) > 0
    || ["Partially Released", "Released", "Completed"].includes(row.status)
    || ["Confirmed", "Released", "Closed"].includes(row.plan?.status)).length
    + linkedManufacturingOrders.length
    + releasedPlanDetails.length
    + generatedMoCount;
  const unprotectedOrderFilter = protectedPreviousOrderNumbers.length
    ? { orderNumber: { notIn: protectedPreviousOrderNumbers } }
    : {};

  const plannedOrdersToSupersede = await tx.plannedOrder.findMany({
    where: {
      isDeleted: false,
      status: { in: ["Planned", "Draft", "Simulation"] },
      referenceType: "MRP",
      runNumber: { in: previousRunNumbers },
      ...unprotectedOrderFilter,
    },
    select: { orderNumber: true },
  });
  const plannedOrderNumbersToSupersede = plannedOrdersToSupersede
    .map((order) => order.orderNumber)
    .filter(Boolean);

  // Retire recommendations without deleting audit history. Released execution
  // documents are outside this filter and remain untouched.
  await tx.plannedOrder.updateMany({
    where: {
      isDeleted: false,
      status: { in: ["Planned", "Draft", "Simulation"] },
      referenceType: "MRP",
      runNumber: { in: previousRunNumbers },
      ...unprotectedOrderFilter,
    },
    data: {
      status: "Superseded",
      notes: `Superseded by MRP run ${currentRunNumber} (${runBy || "system"})`,
    },
  });

  if (plannedOrderNumbersToSupersede.length > 0) {
    await tx.mRPPegging.updateMany({
      where: {
        supplyType: "PlannedOrder",
        supplyNumber: { in: plannedOrderNumbersToSupersede },
        status: "Active",
      },
      data: {
        status: "Closed",
        notes: `Superseded by MRP run ${currentRunNumber} (${runBy || "system"})`,
      },
    });
  }

  await tx.mRPRun.updateMany({
    where: {
      isDeleted: false,
      runNumber: { in: previousRunNumbers },
    },
    data: {
      status: "SUPERSEDED",
      scenarioStatus: "SUPERSEDED",
      isCurrentPlan: false,
      notes: `Superseded by MRP run ${currentRunNumber} (${runBy || "system"})`,
    },
  });

  return {
    mode: protectedPreviousOrderNumbers.length || protectedExecutionCount > 0
      ? "RESIDUAL_REPLAN_PRESERVE_EXECUTION"
      : "STANDARD_SUPERSEDE",
    previousRunNumbers,
    protectedPlannedOrderNumbers: protectedPreviousOrderNumbers,
    protectedExecutionCount,
    supersededPlannedOrderNumbers: plannedOrderNumbersToSupersede,
  };
}

function buildMpsPlanNumber(mpsNumber) {
  return mpsNumber ? `MRP-${mpsNumber}` : null;
}

function buildSoPlanNumber(soNumber) {
  return soNumber ? `MRP-${soNumber}` : null;
}

async function supersedeSoOnlyPlansCoveredByMps(tx, soNumbers, currentRunNumber, currentPlanNumber, runBy) {
  const uniqueSoNumbers = [...new Set((soNumbers || []).filter(Boolean))];
  if (uniqueSoNumbers.length === 0) return;

  const soPlanNumbers = uniqueSoNumbers.map(buildSoPlanNumber).filter(Boolean);
  if (soPlanNumbers.length === 0) return;

  const soRuns = await tx.mRPRun.findMany({
    where: {
      isDeleted: false,
      planScope: "SO",
      planNumber: { in: soPlanNumbers },
      runNumber: { not: currentRunNumber },
    },
    select: {
      runNumber: true,
    },
  });
  const soRunNumbers = soRuns.map((run) => run.runNumber).filter(Boolean);
  if (soRunNumbers.length === 0) return;

  const notes = `Superseded by MPS MRP ${currentPlanNumber || currentRunNumber} (${runBy || "system"})`;

  const plannedOrders = await tx.plannedOrder.findMany({
    where: {
      isDeleted: false,
      status: "Planned",
      runNumber: { in: soRunNumbers },
    },
    select: { orderNumber: true },
  });
  const plannedOrderNumbers = plannedOrders.map((order) => order.orderNumber).filter(Boolean);

  await tx.plannedOrder.updateMany({
    where: {
      isDeleted: false,
      status: "Planned",
      runNumber: { in: soRunNumbers },
    },
    data: {
      status: "Superseded",
      notes,
    },
  });

  if (plannedOrderNumbers.length > 0) {
    await tx.mRPPegging.updateMany({
      where: {
        demandType: "SO",
        demandNumber: { in: uniqueSoNumbers },
        supplyType: "PlannedOrder",
        supplyNumber: { in: plannedOrderNumbers },
        status: "Active",
      },
      data: {
        status: "Closed",
        notes,
      },
    });
  }

  await tx.mRPRun.updateMany({
    where: {
      isDeleted: false,
      runNumber: { in: soRunNumbers },
    },
    data: {
      status: "SUPERSEDED",
      scenarioStatus: "SUPERSEDED",
      isCurrentPlan: false,
      notes,
    },
  });
}

async function resolvePlanIdentity(tx, { mpsNumber, planNumber, planScope = "MPS" }) {
  const resolvedPlanNumber = planNumber || buildMpsPlanNumber(mpsNumber);
  if (!resolvedPlanNumber) {
    return {
      planNumber: null,
      planRevision: 1,
      planScope: planScope || "Manual",
      isCurrentPlan: true,
    };
  }

  const latestPlanRun = await tx.mRPRun.findFirst({
    where: { planNumber: resolvedPlanNumber },
    orderBy: [{ planRevision: "desc" }, { runDate: "desc" }],
    select: { planRevision: true },
  });

  return {
    planNumber: resolvedPlanNumber,
    planRevision: Number(latestPlanRun?.planRevision || 0) + 1,
    planScope,
    isCurrentPlan: true,
  };
}

async function retirePreviousPlanRevisions(tx, planNumber, currentRunNumber) {
  if (!planNumber) return;

  await tx.mRPRun.updateMany({
    where: {
      planNumber,
      runNumber: { not: currentRunNumber },
      isCurrentPlan: true,
    },
    data: { isCurrentPlan: false },
  });
}

async function findRunByNumberOrCurrentPlan(identifier, include = undefined) {
  if (!identifier) return null;

  const byRunNumber = await prisma.mRPRun.findUnique({
    where: { runNumber: identifier },
    ...(include ? { include } : {}),
  });
  if (byRunNumber && !byRunNumber.isDeleted) return byRunNumber;

  // Link run lama tetap berguna setelah recalculation. Jika revision lama sudah
  // superseded, tampilkan revision current dari plan yang sama.
  if (byRunNumber?.planNumber) {
    const currentRevision = await prisma.mRPRun.findFirst({
      where: {
        planNumber: byRunNumber.planNumber,
        isCurrentPlan: true,
        isDeleted: false,
      },
      orderBy: [{ planRevision: "desc" }, { runDate: "desc" }],
      ...(include ? { include } : {}),
    });
    if (currentRevision) return currentRevision;
  }

  return prisma.mRPRun.findFirst({
    where: {
      planNumber: identifier,
      isCurrentPlan: true,
    },
    orderBy: [{ planRevision: "desc" }, { runDate: "desc" }],
    ...(include ? { include } : {}),
  });
}

async function resolveCurrentRunNumber(identifier) {
  const run = await findRunByNumberOrCurrentPlan(identifier, undefined);
  return run?.runNumber || null;
}

async function enrichPlannedOrderDisplay(tx, orders = []) {
  if (!Array.isArray(orders) || orders.length === 0) return orders;

  const partCodes = [
    ...new Set(
      orders
        .map((order) => normalizePartCode(order.partCode || order.part?.partCode))
        .filter(Boolean),
    ),
  ];
  const mbomHeaderIds = [
    ...new Set(orders.map((order) => order.mbomHeaderId).filter(Boolean)),
  ];

  const [parts, mbomHeaders] = await Promise.all([
    partCodes.length > 0
      ? tx.part.findMany({
          where: { partCode: { in: partCodes }, isDeleted: false },
          select: {
            id: true,
             partCode: true,
             partNumber: true,
             partName: true,
            itemType: true,
            rawType: true,
            material: {
              select: {
                id: true,
                materialCode: true,
                materialName: true,
                materialType: true,
                materialForm: true,
                spec: true,
                defaultPurchaseUomCode: true,
                defaultConversionUomCode: true,
                defaultConversionFactor: true,
              },
            },
             supplier: {
              select: { supplierCode: true, supplierName: true },
            },
          },
        })
      : [],
    mbomHeaderIds.length > 0
      ? tx.mBOMHeader.findMany({
          where: { id: { in: mbomHeaderIds }, isDeleted: false },
          select: { id: true, noReg: true, revision: true, uomCode: true },
        })
      : [],
  ]);

  const partByCode = new Map(parts.map((part) => [part.partCode, part]));
  const mbomById = new Map(mbomHeaders.map((mbom) => [mbom.id, mbom]));

  return orders.map((order) => {
    const part = order.part || partByCode.get(normalizePartCode(order.partCode)) || null;
    const mbomHeader = order.mbomHeaderId ? mbomById.get(order.mbomHeaderId) || null : null;

    return {
      ...order,
      part,
      partName: part?.partName || order.partName || null,
      mbomHeader,
      mbomHeaderNoReg: mbomHeader?.noReg || null,
      supplierReadiness:
        String(order.orderType || "").toUpperCase() !== "PURCHASE"
          ? {
              ready: true,
              status: "NOT REQUIRED",
              source: null,
              message: "Supplier tidak diperlukan untuk order produksi.",
            }
          : {
              ready: true,
              status: "PURCHASING",
              source: "PURCHASING",
              supplierCode: null,
              supplierName: null,
              message: "PPIC hanya mengirim kebutuhan; supplier dipilih Purchasing pada PR/PO.",
            },
    };
  });
}

function normalizePartCode(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveBufferPercent(part) {
  const bufferStock = Number(part?.bufferStock || 0);
  if (!Number.isFinite(bufferStock) || bufferStock <= 0) return 0;
  return bufferStock;
}

function applyBufferStockPercent(baseQty, part) {
  const demandQty = Number(baseQty || 0);
  const bufferPercent = resolveBufferPercent(part);
  const bufferQty = demandQty > 0 && bufferPercent > 0
    ? (demandQty * bufferPercent) / 100
    : 0;

  return {
    demandQty,
    bufferPercent,
    bufferQty,
    grossRequirement: demandQty + bufferQty,
  };
}

function buildStockPositionMaps(stockRows = []) {
  return stockRows.reduce(
    (acc, stock) => {
      const partCode = normalizePartCode(stock.partCode);
      if (!partCode) return acc;

      const qtyOnHand = Number(stock.qtyOnHand || 0);
      const qtyReserved = Number(stock.qtyReserved || 0);
      const qtyQC = Number(stock.qtyQC || 0);
      const qtyAvailable = stock.qtyAvailable == null
        ? Math.max(qtyOnHand - qtyReserved - qtyQC, 0)
        : Number(stock.qtyAvailable || 0);

      acc.onHand[partCode] = Number(acc.onHand[partCode] || 0) + qtyOnHand;
      acc.allocated[partCode] =
        Number(acc.allocated[partCode] || 0) + qtyReserved + qtyQC;
      acc.available[partCode] =
        Number(acc.available[partCode] || 0) + Math.max(qtyAvailable, 0);
      return acc;
    },
    { onHand: {}, allocated: {}, available: {} },
  );
}

function normalizeUomCode(value) {
  const code = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["kgs", "kilogram", "kilograms"].includes(code)) return "kg";
  if (["pc", "piece", "pieces"].includes(code)) return "pcs";
  return code;
}

function normalizePartBaseOn(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function isKgUom(value) {
  const code = normalizeUomCode(value);
  return code === "kg";
}

function isPcsUom(value) {
  const code = normalizeUomCode(value);
  return code === "pcs";
}

function isRawMaterialPart(part) {
  return part?.itemType === "RAW" && part?.rawType === "MATERIAL";
}

// Any RAW component can already be embedded in a downstream WIP/FG output.
// This includes purchased components (for example NUT-M6), not only material
// measured in KG. Unit conversion remains material-specific elsewhere.
function isEmbeddedStockInputPart(part) {
  return part?.itemType === "RAW";
}

function filterWipLinesForRequirementPath(lines = [], pathCodes) {
  if (!(pathCodes instanceof Set)) return lines;
  return lines.filter((row) => pathCodes.has(normalizePartCode(row.sourcePartCode || row.partCode)));
}

function planningStockKey(partCode, part = {}) {
  if (isRawMaterialPart(part)) {
    const materialIdentity = part.materialId || part.material?.materialCode;
    if (materialIdentity) return `MATERIAL:${String(materialIdentity).trim().toUpperCase()}`;
  }
  return normalizePartCode(partCode);
}

function buildTargetedReservationPool(reservations = []) {
  const pool = {};
  for (const reservation of reservations) {
    const targetPartCode = normalizePartCode(reservation.targetPartCode || reservation.referenceNumber);
    const stock = reservation.stockBalance || {};
    const materialIdentity = stock.materialId || stock.materialCode || reservation.materialId || reservation.materialCode;
    const stockKey = materialIdentity
      ? `MATERIAL:${String(materialIdentity).trim().toUpperCase()}`
      : normalizePartCode(stock.partCode || reservation.partCode);
    const openQty = Math.max(Number(reservation.qtyReserved || 0) - Number(reservation.qtyReleased || 0), 0);
    if (!stockKey || !targetPartCode || openQty <= 0) continue;
    const key = `${stockKey}|${targetPartCode}`;
    pool[key] = Number(pool[key] || 0) + openQty;
  }
  return pool;
}

function isPieceMaterialPart(part) {
  return isRawMaterialPart(part) && normalizeUomCode(part?.material?.materialForm) === "pcs";
}

function purchasePackageUomForPart(part) {
  const configured = String(part?.material?.defaultPurchaseUomCode || "").trim().toUpperCase();
  if (configured) return configured;
  const form = String(part?.material?.materialForm || "").trim().toUpperCase();
  if (form === "SHEET") return "SHEET";
  if (form === "COIL") return "COIL";
  if (["PIECES", "PIECE", "PCS"].includes(form)) return "PCS";
  return form || "LOT";
}

function resolveMaterialPurchaseConversion(order, part) {
  const pieceMaterial = isPieceMaterialPart(part);
  const packageUomCode = String(
    order.purchasePackageUomCode
      || part?.material?.defaultPurchaseUomCode
      || purchasePackageUomForPart(part),
  ).trim().toUpperCase();
  const conversionUomCode = String(
    order.conversionUomCode
      || part?.material?.defaultConversionUomCode
      || (Number(order.purchaseQtyKg || 0) > 0 ? "KG" : pieceMaterial ? "PCS" : ""),
  ).trim().toUpperCase();
  const conversionFactor = Number(
    order.conversionFactor
      ?? order.kgPerLot
      ?? part?.material?.defaultConversionFactor
      ?? (pieceMaterial ? 1 : 0),
  );
  let purchasePackageQty = Number(order.purchasePackageQty ?? order.lotCount ?? 0);
  if (
    !(purchasePackageQty > 0)
    && conversionFactor > 0
    && conversionUomCode
    && normalizeUomCode(conversionUomCode) === normalizeUomCode(order.uomCode)
  ) {
    purchasePackageQty = Math.ceil(Number(order.qty || 0) / conversionFactor);
  }
  const convertedPurchaseQty = Number(
    order.convertedPurchaseQty
      ?? order.purchaseQtyKg
      ?? (purchasePackageQty > 0 && conversionFactor > 0
        ? roundPlanningQty(purchasePackageQty * conversionFactor)
        : 0),
  );
  return {
    pieceMaterial,
    packageUomCode,
    conversionUomCode,
    conversionFactor,
    purchasePackageQty,
    convertedPurchaseQty,
  };
}

function getPreferredPartBase(part) {
  const bases = Array.isArray(part?.partBases) ? part.partBases : [];
  return (
    bases.find((base) => normalizePartBaseOn(base.baseOn) === "ACTUAL") ||
    bases.find((base) => normalizePartBaseOn(base.baseOn) === "QTN") ||
    bases[0] ||
    null
  );
}

function resolveKgPerPcs(part) {
  // Focus sementara: konversi planning ke kg hanya memakai gross weight part.
  // Packing ratio dinonaktifkan dulu sampai rule bisnisnya dikonfirmasi.
  // const pcsPerBox = Number(part?.pcsPerBox || 0);
  // const kgPerBox = Number(part?.kgPerBox || 0);
  // if (pcsPerBox > 0 && kgPerBox > 0) {
  //   return { factor: kgPerBox / pcsPerBox, source: "packing box" };
  // }

  // const pcsPerPlastic = Number(part?.pcsPerPlastic || 0);
  // const kgPerPlastic = Number(part?.kgPerPlastic || 0);
  // if (pcsPerPlastic > 0 && kgPerPlastic > 0) {
  //   return { factor: kgPerPlastic / pcsPerPlastic, source: "packing plastic" };
  // }

  const base = getPreferredPartBase(part);
  const grossWeight = Number(base?.grossWeight || 0);
  if (grossWeight > 0) {
    return { factor: grossWeight, source: `${base.baseOn || "part"} gross weight` };
  }

  // const netWeight = Number(base?.netWeight || 0);
  // if (netWeight > 0) {
  //   return { factor: netWeight, source: `${base.baseOn || "part"} net weight` };
  // }

  return { factor: null, source: null };
}

function normalizePurchasingSupplyQty(row, options = {}) {
  const qty = Number(row?.qty || 0);
  if (qty <= 0) return 0;
  const targetUomCode = normalizeUomCode(options.targetUomCode);
  const sourceUomCode = normalizeUomCode(row?.uomCode);
  const fallbackFactor = Number(options.kgPerQty || 0);
  const kgPerQty = fallbackFactor > 0 ? fallbackFactor : resolveKgPerPcs(row?.part).factor;

  if (targetUomCode === "kg") {
    if (sourceUomCode === "kg" || !sourceUomCode) return qty;
    return kgPerQty ? qty * kgPerQty : qty;
  }
  if (sourceUomCode === "kg") return kgPerQty ? qty / kgPerQty : qty;
  return qty;
}

function normalizePlanningStockRows(stockRows = [], options = {}) {
  const planningUomByPartCode = options.planningUomByPartCode || {};
  const kgPerQtyByPartCode = options.kgPerQtyByPartCode || {};
  return stockRows.map((row) => {
    const partCode = normalizePartCode(row.partCode);
    const targetUomCode = planningUomByPartCode[partCode];
    if (!targetUomCode) return row;
    const kgPerQty = Number(kgPerQtyByPartCode[partCode] || 0);
    const convert = (value) => normalizePurchasingSupplyQty(
      { qty: value, uomCode: row.uomCode },
      { targetUomCode, kgPerQty },
    );
    return {
      ...row,
      qtyOnHand: convert(row.qtyOnHand),
      qtyReserved: convert(row.qtyReserved),
      qtyQC: convert(row.qtyQC),
      qtyAvailable: convert(row.qtyAvailable),
    };
  });
}

// Convert a stock line using the source part's gross weight when a pcs WIP/FG
// balance is used to cover a raw-material requirement in KG.  Falling back to
// the requirement factor keeps legacy material-only rows (partCode = NULL)
// compatible with the existing material conversion rule.
function normalizeStockRowForRequirement(row, targetPart, targetUomCode, fallbackKgPerQty, sourcePartByCode) {
  const sourcePart = sourcePartByCode?.get(normalizePartCode(row.partCode)) || null;
  const sourceItemType = String(sourcePart?.itemType || "").trim().toUpperCase();
  const sourceProcesses = (sourcePart?.mbomDetails || []).flatMap((detail) => detail.mbomProcesses || []).map((route) => ({
    code: route.process?.processCode || route.occurrenceCode || null,
    name: route.process?.processName || route.occurrenceCode || null,
    sequence: Number(route.sequence || 0),
  })).filter((route) => route.code || route.name);
  const isConvertedWipStock = ["FG", "WIP", "SFG"].includes(sourceItemType)
    || (!sourcePart && isWipStockType(row.stockType));
  const sourceFactor = Number(resolveKgPerPcs(sourcePart || targetPart).factor || 0);
  // For a raw-material target the fallback is the BOM material gross weight;
  // it must win over a different FG/WIP gross weight. This is the rule that
  // converts WIP/FG pcs into the material KG they represent.
  const kgPerQty = Number(fallbackKgPerQty || 0) > 0
    ? Number(fallbackKgPerQty)
    : sourceFactor;
  const convert = (value) => normalizePurchasingSupplyQty(
    { qty: value, uomCode: row.uomCode, part: sourcePart || targetPart },
    { targetUomCode, kgPerQty },
  );
  return {
    ...row,
    sourcePartCode: sourcePart?.partCode || row.partCode || null,
    sourcePartName: sourcePart?.partName || null,
    sourceItemType: sourceItemType || null,
    sourceProcesses,
    supplyClass: isConvertedWipStock ? "WIP_EQUIVALENT" : "WAREHOUSE_MATERIAL",
    conversionFactorKgPerPcs: isConvertedWipStock ? kgPerQty : null,
    sourceUomCode: row.uomCode || null,
    sourceQtyOnHand: Number(row.qtyOnHand || 0),
    sourceQtyAvailable: Number(row.qtyAvailable || 0),
    qtyOnHand: convert(row.qtyOnHand),
    qtyReserved: convert(row.qtyReserved),
    qtyQC: convert(row.qtyQC),
    qtyAvailable: convert(row.qtyAvailable),
  };
}

const WIP_STOCK_TYPES = new Set(["WIP", "SEMI-FINISHED", "SEMI FINISHED", "SFG"]);
const PRODUCTION_ITEM_TYPES = new Set(["FG", "WIP", "SFG"]);
function isWipStockType(value) {
  return WIP_STOCK_TYPES.has(String(value || "").trim().toUpperCase());
}

function isProductionItemType(value) {
  return PRODUCTION_ITEM_TYPES.has(String(value || "").trim().toUpperCase());
}

function collectProductionPathCodes(mbomHeader, details, detail, inheritedCodes = []) {
  const codes = new Set(inheritedCodes.map(normalizePartCode).filter(Boolean));
  if (isProductionItemType(mbomHeader?.part?.itemType)) {
    codes.add(normalizePartCode(mbomHeader.part.partCode));
  }

  const detailById = new Map(details.map((row) => [row.id, row]));
  let current = detail;
  const visited = new Set();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (isProductionItemType(current.part?.itemType)) {
      codes.add(normalizePartCode(current.part.partCode));
    }
    current = current.parentDetailId
      ? detailById.get(current.parentDetailId)
      : null;
  }
  return [...codes];
}

async function loadSupplyPathMbom(tx, mbomHeaderId, cache) {
  if (!mbomHeaderId) return null;
  if (cache.has(mbomHeaderId)) return cache.get(mbomHeaderId);

  const mbom = await tx.mBOMHeader.findFirst({
    where: { id: mbomHeaderId, isDeleted: false },
    include: {
      part: { select: { id: true, partCode: true, partName: true, itemType: true } },
      details: {
        where: { isDeleted: false },
        include: {
          part: { select: { id: true, partCode: true, partName: true, itemType: true } },
        },
        orderBy: [{ levelComponent: "asc" }, { createdAt: "asc" }],
      },
    },
  });
  cache.set(mbomHeaderId, mbom);
  return mbom;
}

async function findRequirementProductionPathCodes(
  tx,
  mbomHeaderId,
  requirement,
  inheritedCodes,
  caches,
  visitedMbomIds = new Set(),
) {
  if (!mbomHeaderId || visitedMbomIds.has(mbomHeaderId)) return null;
  const mbom = await loadSupplyPathMbom(tx, mbomHeaderId, caches.mbomById);
  if (!mbom) return null;

  const nextVisited = new Set(visitedMbomIds).add(mbomHeaderId);
  const headerCodes = new Set(inheritedCodes.map(normalizePartCode).filter(Boolean));
  if (isProductionItemType(mbom.part?.itemType)) {
    headerCodes.add(normalizePartCode(mbom.part.partCode));
  }

  const details = sortMbomDetailsParentFirst(mbom.details || []);
  const childrenByParentId = new Map();
  for (const detail of details) {
    const parentKey = detail.parentDetailId || "__ROOT__";
    if (!childrenByParentId.has(parentKey)) childrenByParentId.set(parentKey, []);
    childrenByParentId.get(parentKey).push(detail);
  }

  const visitDetail = async (detail, pathCodes) => {
    const detailCodes = new Set(pathCodes);
    if (isProductionItemType(detail.part?.itemType)) {
      detailCodes.add(normalizePartCode(detail.part.partCode));
    }

    if (
      mbom.noReg === requirement.sourceNumber
      && normalizePartCode(detail.part?.partCode) === normalizePartCode(requirement.partCode)
    ) {
      return [...detailCodes];
    }

    for (const child of childrenByParentId.get(detail.id) || []) {
      const localMatch = await visitDetail(child, detailCodes);
      if (localMatch) return localMatch;
    }

    if (detail.part?.id && isProductionItemType(detail.part.itemType)) {
      const validityKey = `${detail.part.id}|${planningMonthKey(requirement.requiredDate)}`;
      let nestedMbom = caches.activeMbomByPartAndMonth.get(validityKey);
      if (nestedMbom === undefined) {
        nestedMbom = await findActiveMbomHeader(tx, detail.part.id, requirement.requiredDate);
        caches.activeMbomByPartAndMonth.set(validityKey, nestedMbom || null);
      }
      if (nestedMbom?.id && nestedMbom.id !== mbom.id) {
        const nestedMatch = await findRequirementProductionPathCodes(
          tx,
          nestedMbom.id,
          requirement,
          [...detailCodes],
          caches,
          nextVisited,
        );
        if (nestedMatch) return nestedMatch;
      }
    }
    return null;
  };

  for (const root of childrenByParentId.get("__ROOT__") || []) {
    const match = await visitDetail(root, headerCodes);
    if (match) return match;
  }
  return null;
}

async function enrichRequirementSupplyBreakdown(tx, requirements = []) {
  if (!Array.isArray(requirements) || requirements.length === 0) return requirements;

  const partCodes = [...new Set(requirements.map((row) => normalizePartCode(row.partCode)).filter(Boolean))];
  if (partCodes.length === 0) return requirements;

  const parts = await tx.part.findMany({
    where: { partCode: { in: partCodes }, isDeleted: false },
    select: {
      partCode: true,
      materialId: true,
      material: { select: { materialCode: true } },
      itemType: true,
      rawType: true,
      partBases: { select: { baseOn: true, grossWeight: true } },
    },
  });
  const materialIds = [...new Set(parts.map((part) => part.materialId).filter(Boolean))];
  const materialCodes = [...new Set(parts.map((part) => part.material?.materialCode).filter(Boolean))];
  const rawRequirements = requirements.filter((row) => isEmbeddedStockInputPart(
    row.part || parts.find((part) => normalizePartCode(part.partCode) === normalizePartCode(row.partCode)),
  ));
  const sourceMbomNumbers = [...new Set(rawRequirements.map((row) => row.sourceNumber).filter(Boolean))];
  const sourceMboms = sourceMbomNumbers.length ? await tx.mBOMHeader.findMany({
    where: { noReg: { in: sourceMbomNumbers }, isDeleted: false },
    include: {
      part: { select: { partCode: true, partName: true, itemType: true } },
      details: {
        where: { isDeleted: false },
        include: { part: { select: { partCode: true, partName: true, itemType: true } } },
      },
    },
  }) : [];
  const sourceMbomByNumber = new Map(sourceMboms.map((row) => [row.noReg, row]));
  const mpsDetailIds = [...new Set(rawRequirements.map((row) => row.mpsDetailId).filter(Boolean))];
  const mpsDetailRows = mpsDetailIds.length ? await tx.mPSDetail.findMany({
    where: { id: { in: mpsDetailIds }, isDeleted: false },
    select: { id: true, mbomHeaderId: true },
  }) : [];
  const rootMbomIdByMpsDetail = new Map(
    mpsDetailRows.map((row) => [row.id, row.mbomHeaderId]).filter(([, mbomHeaderId]) => mbomHeaderId),
  );
  const supplyPathCaches = {
    mbomById: new Map(),
    activeMbomByPartAndMonth: new Map(),
  };
  const requirementPartCodesBySourcePart = new Map();
  const productionPathCodesByRequirement = new Map();
  for (const requirement of rawRequirements) {
    const requirementPartCode = normalizePartCode(requirement.partCode);
    const sourceMbom = sourceMbomByNumber.get(requirement.sourceNumber);
    const sourceDetail = (sourceMbom?.details || []).find(
      (detail) => normalizePartCode(detail.part?.partCode) === requirementPartCode,
    );
    const fallbackCodes = sourceDetail
      ? collectProductionPathCodes(sourceMbom, sourceMbom.details || [], sourceDetail)
      : [];
    const rootMbomId = rootMbomIdByMpsDetail.get(requirement.mpsDetailId);
    const resolvedCodes = rootMbomId
      ? await findRequirementProductionPathCodes(
          tx,
          rootMbomId,
          requirement,
          [],
          supplyPathCaches,
        )
      : null;
    const productionPathCodes = new Set([...(resolvedCodes || []), ...fallbackCodes].map(normalizePartCode).filter(Boolean));
    productionPathCodesByRequirement.set(requirement, productionPathCodes);
    for (const sourcePartCode of productionPathCodes) {
      if (!sourcePartCode) continue;
      if (!requirementPartCodesBySourcePart.has(sourcePartCode)) {
        requirementPartCodesBySourcePart.set(sourcePartCode, new Set());
      }
      requirementPartCodesBySourcePart.get(sourcePartCode).add(requirementPartCode);
    }
  }
  const relatedProductionPartCodes = [...requirementPartCodesBySourcePart.keys()];
  const [stockRows, purchaseOrderRows] = await Promise.all([
    tx.stockBalance.findMany({
      where: {
        AND: [
          {
            OR: [
              { partCode: { in: partCodes } },
              ...(relatedProductionPartCodes.length ? [{ partCode: { in: relatedProductionPartCodes } }] : []),
              ...(materialIds.length ? [{ materialId: { in: materialIds } }] : []),
              ...(materialCodes.length ? [{ materialCode: { in: materialCodes } }] : []),
            ],
          },
          { isDeleted: false },
          buildExcludeSpecialRackCondition(),
        ],
      },
      select: {
        id: true,
        partCode: true,
        materialId: true,
        materialCode: true,
        warehouseCode: true,
        rackCode: true,
        lotNumber: true,
        stockType: true,
        uomCode: true,
        qtyOnHand: true,
        qtyReserved: true,
        qtyQC: true,
        qtyAvailable: true,
        warehouse: { select: { warehouseCode: true, warehouseName: true } },
      },
      orderBy: [{ warehouseCode: "asc" }, { rackCode: "asc" }, { lotNumber: "asc" }],
    }),
    tx.purchaseOrderDetail.findMany({
      where: {
        isDeleted: false,
        partCode: { in: partCodes },
        po: {
          isDeleted: false,
          status: { in: ["Approved", "Sent", "Confirmed", "Partial Receipt"] },
        },
      },
      select: {
        id: true,
        partCode: true,
        qty: true,
        qtyReceived: true,
        uomCode: true,
        convertedPurchaseQty: true,
        conversionFactor: true,
        conversionUomCode: true,
        po: {
          select: {
            poNumber: true,
            status: true,
            deliveryDate: true,
            supplierCode: true,
            supplierName: true,
            vendorCode: true,
            vendorName: true,
          },
        },
      },
      orderBy: [{ po: { deliveryDate: "asc" } }, { createdAt: "asc" }],
    }),
  ]);

  // Stock WIP/FG can carry its own partCode while the requirement is a raw
  // material code. Load those source parts so pcs stock can be converted with
  // the source part gross weight before netting the material demand.
  const stockPartCodes = [...new Set(stockRows.map((row) => normalizePartCode(row.partCode)).filter(Boolean))];
  const stockParts = stockPartCodes.length ? await tx.part.findMany({
    where: { partCode: { in: stockPartCodes }, isDeleted: false },
    select: {
      partCode: true,
      partName: true,
      itemType: true,
      materialId: true,
      material: { select: { materialCode: true } },
      partBases: { select: { baseOn: true, grossWeight: true } },
      mbomDetails: {
        where: { isDeleted: false },
        orderBy: { updatedAt: "desc" },
        take: 1,
        select: {
          mbomProcesses: {
            where: { isDeleted: false },
            orderBy: { sequence: "asc" },
            select: {
              sequence: true,
              occurrenceCode: true,
              process: { select: { processCode: true, processName: true } },
            },
          },
        },
      },
    },
  }) : [];
  const stockPartByCode = new Map(stockParts.map((part) => [normalizePartCode(part.partCode), part]));

    const partByCode = new Map(parts.map((part) => [normalizePartCode(part.partCode), part]));
    const partCodesByMaterial = new Map();
  const partCodesByMaterialId = new Map();
    for (const part of parts) {
      const materialKey = String(part.material?.materialCode || "").trim().toUpperCase();
      const partCode = normalizePartCode(part.partCode);
      if (materialKey) {
        if (!partCodesByMaterial.has(materialKey)) partCodesByMaterial.set(materialKey, []);
        partCodesByMaterial.get(materialKey).push(partCode);
      }
      if (part.materialId) {
        if (!partCodesByMaterialId.has(part.materialId)) partCodesByMaterialId.set(part.materialId, []);
        partCodesByMaterialId.get(part.materialId).push(partCode);
      }
  }
  const requirementPartCodesByMaterial = new Map(partCodesByMaterial);
  const requirementPartCodesByMaterialId = new Map(partCodesByMaterialId);
  for (const part of stockParts) {
    const materialKey = String(part.material?.materialCode || "").trim().toUpperCase();
    if (materialKey && !requirementPartCodesByMaterial.has(materialKey)) requirementPartCodesByMaterial.set(materialKey, []);
    if (materialKey) {
      const list = requirementPartCodesByMaterial.get(materialKey);
      for (const requirementPart of parts) {
        if (String(requirementPart.material?.materialCode || "").trim().toUpperCase() === materialKey && !list.includes(requirementPart.partCode)) list.push(requirementPart.partCode);
      }
    }
    if (part.materialId) {
      if (!requirementPartCodesByMaterialId.has(part.materialId)) requirementPartCodesByMaterialId.set(part.materialId, []);
      const list = requirementPartCodesByMaterialId.get(part.materialId);
      for (const requirementPart of parts) {
        if (requirementPart.materialId === part.materialId && !list.includes(requirementPart.partCode)) list.push(requirementPart.partCode);
      }
    }
  }
  const planningUomByPartCode = {};
  const kgPerQtyByPartCode = {};
  for (const requirement of requirements) {
    const partCode = normalizePartCode(requirement.partCode);
    const part = requirement.part || partByCode.get(partCode);
    if (!partCode || !isRawMaterialPart(part)) continue;
    const targetUomCode = isKgUom(requirement.uomCode) || requirement.plannedOrderQtyKg != null ? "kg" : requirement.uomCode;
    if (!targetUomCode) continue;
    planningUomByPartCode[partCode] = targetUomCode;
    const factor = Number(requirement.mbomDetail?.grossWeight || 0) || Number(resolveKgPerPcs(partByCode.get(partCode)).factor || 0);
    if (factor > 0) kgPerQtyByPartCode[partCode] = factor;
  }

  const stocksByPart = new Map();
  for (const stock of stockRows) {
      const directPartCode = normalizePartCode(stock.partCode);
      const materialKey = String(stock.materialCode || "").trim().toUpperCase();
      const targetPartCodes = [...new Set([
        ...(partCodes.includes(directPartCode) ? [directPartCode] : []),
        ...[...(requirementPartCodesBySourcePart.get(directPartCode) || [])],
        ...(requirementPartCodesByMaterial.get(materialKey) || []),
        ...(requirementPartCodesByMaterialId.get(stock.materialId) || []),
      ])];
    for (const partCode of targetPartCodes) {
      if (!stocksByPart.has(partCode)) stocksByPart.set(partCode, []);
      const targetPart = partByCode.get(partCode);
      stocksByPart.get(partCode).push(normalizeStockRowForRequirement(
        stock,
        targetPart,
        planningUomByPartCode[partCode],
        kgPerQtyByPartCode[partCode],
        stockPartByCode,
      ));
    }
  }

  const supplierByPart = new Map();
  for (const row of purchaseOrderRows) {
    const partCode = normalizePartCode(row.partCode);
    const conversionFactor = Number(row.conversionFactor || 0);
    const usesPurchaseConversion = Number(row.convertedPurchaseQty || 0) > 0
      && conversionFactor > 0
      && normalizeUomCode(row.conversionUomCode);
    const orderedSourceQty = usesPurchaseConversion
      ? Number(row.convertedPurchaseQty || 0)
      : Number(row.qty || 0);
    const receivedSourceQty = usesPurchaseConversion
      ? Number(row.qtyReceived || 0) * conversionFactor
      : Number(row.qtyReceived || 0);
    const sourceUomCode = usesPurchaseConversion ? row.conversionUomCode : row.uomCode;
    const outstandingOriginalQty = Math.max(orderedSourceQty - receivedSourceQty, 0);
    if (!partCode || outstandingOriginalQty <= 0) continue;
    const outstandingQty = normalizePurchasingSupplyQty(
      { ...row, qty: outstandingOriginalQty, uomCode: sourceUomCode, part: partByCode.get(partCode) },
      { targetUomCode: planningUomByPartCode[partCode], kgPerQty: kgPerQtyByPartCode[partCode] },
    );
    if (!supplierByPart.has(partCode)) supplierByPart.set(partCode, []);
    supplierByPart.get(partCode).push({
      poDetailId: row.id,
      poNumber: row.po.poNumber,
      poStatus: row.po.status,
      supplierCode: row.po.supplierCode || row.po.vendorCode || null,
      supplierName: row.po.supplierName || row.po.vendorName || null,
      deliveryDate: row.po.deliveryDate,
      orderedQty: normalizePurchasingSupplyQty(
        { ...row, qty: orderedSourceQty, uomCode: sourceUomCode, part: partByCode.get(partCode) },
        { targetUomCode: planningUomByPartCode[partCode], kgPerQty: kgPerQtyByPartCode[partCode] },
      ),
      receivedQty: normalizePurchasingSupplyQty(
        { ...row, qty: receivedSourceQty, uomCode: sourceUomCode, part: partByCode.get(partCode) },
        { targetUomCode: planningUomByPartCode[partCode], kgPerQty: kgPerQtyByPartCode[partCode] },
      ),
      outstandingQty: roundPlanningQty(outstandingQty),
      uomCode: planningUomByPartCode[partCode] || row.uomCode || null,
    });
  }

  return requirements.map((requirement) => {
    const partCode = normalizePartCode(requirement.partCode);
    const stockLines = stocksByPart.get(partCode) || [];
    const warehouseLines = stockLines.filter((row) => row.supplyClass !== "WIP_EQUIVALENT");
    const wipLines = filterWipLinesForRequirementPath(
      stockLines.filter((row) => row.supplyClass === "WIP_EQUIVALENT"),
      productionPathCodesByRequirement.get(requirement),
    );
    const supplierLines = (supplierByPart.get(partCode) || []).map((row) => ({
      ...row,
      eligibleForRequirement: !row.deliveryDate || new Date(row.deliveryDate) <= new Date(requirement.requiredDate),
    }));
    const stockSummary = (lines) => ({
      qtyOnHand: roundPlanningQty(lines.reduce((sum, row) => sum + Number(row.qtyOnHand || 0), 0)),
      qtyReserved: roundPlanningQty(lines.reduce((sum, row) => sum + Number(row.qtyReserved || 0), 0)),
      qtyQC: roundPlanningQty(lines.reduce((sum, row) => sum + Number(row.qtyQC || 0), 0)),
      qtyAvailable: roundPlanningQty(lines.reduce((sum, row) => sum + Number(row.qtyAvailable || 0), 0)),
      lines: lines.map((row) => ({
        stockBalanceId: row.id,
        warehouseCode: row.warehouseCode,
        warehouseName: row.warehouse?.warehouseName || null,
        rackCode: row.rackCode,
        lotNumber: row.lotNumber,
        stockType: row.stockType,
        sourcePartCode: row.sourcePartCode,
        sourcePartName: row.sourcePartName,
        sourceItemType: row.sourceItemType,
        sourceProcesses: row.sourceProcesses,
        supplyClass: row.supplyClass,
        conversionFactorKgPerPcs: row.conversionFactorKgPerPcs,
        sourceUomCode: row.sourceUomCode,
        sourceQtyOnHand: row.sourceQtyOnHand,
        sourceQtyAvailable: row.sourceQtyAvailable,
        uomCode: planningUomByPartCode[partCode] || row.uomCode || null,
        qtyOnHand: roundPlanningQty(row.qtyOnHand),
        qtyReserved: roundPlanningQty(row.qtyReserved),
        qtyQC: roundPlanningQty(row.qtyQC),
        qtyAvailable: roundPlanningQty(row.qtyAvailable),
      })),
    });

    const warehouseStock = stockSummary(warehouseLines);
    const wipStock = stockSummary(wipLines);
    warehouseStock.planningSupplyQty = warehouseStock.qtyAvailable;
    // WIP/FG merupakan material yang sudah tertanam pada hasil proses. Untuk
    // netting raw material gunakan seluruh physical on-hand, termasuk stock FG
    // yang sudah di-reserve ke demand yang sedang direncanakan.
    wipStock.planningSupplyQty = wipStock.qtyOnHand;
    const supplierOutstanding = {
      qtyOutstanding: roundPlanningQty(supplierLines.reduce((sum, row) => sum + Number(row.outstandingQty || 0), 0)),
      qtyEligible: roundPlanningQty(supplierLines.filter((row) => row.eligibleForRequirement).reduce((sum, row) => sum + Number(row.outstandingQty || 0), 0)),
      lines: supplierLines,
    };
    const visibleSupplyQty = roundPlanningQty(
      Number(warehouseStock.qtyAvailable || 0) +
        Number(wipStock.planningSupplyQty || 0) +
        Number(supplierOutstanding.qtyEligible || 0),
    );
    const grossRequirement = Math.max(Number(requirement.grossRequirement || 0), 0);
    const coveredDemandQty = roundPlanningQty(
      Math.min(grossRequirement, visibleSupplyQty),
    );

    const currentOnHand = roundPlanningQty(Number(warehouseStock.qtyOnHand || 0) + Number(wipStock.qtyOnHand || 0));
    const currentAllocated = roundPlanningQty(Number(warehouseStock.qtyReserved || 0) + Number(wipStock.qtyReserved || 0));
    return {
      ...requirement,
      // Refresh the visible stock columns from the current stock balance so a
      // movement posted after the MRP run is immediately visible in detail.
      onHandQty: currentOnHand,
      allocatedQty: currentAllocated,
      supplyBreakdown: {
        warehouseStock,
        wipStock,
        supplierOutstanding,
        coverage: {
          visibleSupplyQty,
          coveredDemandQty,
          uncoveredDemandQty: roundPlanningQty(
            Math.max(grossRequirement - visibleSupplyQty, 0),
          ),
          coveragePercent:
            grossRequirement > 0
              ? roundPlanningQty((coveredDemandQty / grossRequirement) * 100)
              : 100,
          note:
            "Coverage visual = stock warehouse available + stock WIP available + open PO eligible sebelum required date.",
        },
      },
    };
  });
}

function buildMaterialPlanningRules(details = []) {
  const planningUomByPartCode = {};
  const kgPerQtyByPartCode = {};

  for (const detail of details) {
    if (!isRawMaterialPart(detail.part)) continue;
    const partCode = normalizePartCode(detail.part?.partCode);
    if (!partCode) continue;
    if (isKgUom(detail.uomCode)) {
      planningUomByPartCode[partCode] = "kg";
      kgPerQtyByPartCode[partCode] = 1;
      continue;
    }
    const detailFactor = Number(detail.grossWeight || 0);
    const partFactor = Number(resolveKgPerPcs(detail.part).factor || 0);
    const factor = detailFactor > 0 ? detailFactor : partFactor;
    if (factor > 0) {
      planningUomByPartCode[partCode] = "kg";
      kgPerQtyByPartCode[partCode] = factor;
    }
  }

  return { planningUomByPartCode, kgPerQtyByPartCode };
}

async function buildProductionMbomKgPerPcsMap(tx, requirements = [], partMap = new Map()) {
  const productionRows = requirements.filter(
    (row) => row.orderType === "Production" || row.levelMBOM === 0,
  );
  const result = new Map();

  for (const row of productionRows) {
    const part =
      partMap.get(row.partId) ||
      partMap.get(normalizePartCode(row.partCode)) ||
      null;
    const partId = row.partId || part?.id || null;
    if (!partId) continue;

    const mbom = await tx.mBOMHeader.findFirst({
      where: {
        partId,
        isDeleted: false,
        ...buildMbomValidityWhere(row.requiredDate),
      },
      orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
      include: {
        details: {
          where: { isDeleted: false },
          include: {
            part: {
              select: {
                id: true,
                partCode: true,
                pcsPerBox: true,
                kgPerBox: true,
                pcsPerPlastic: true,
                kgPerPlastic: true,
                partBases: {
                  select: {
                    baseOn: true,
                    netWeight: true,
                    grossWeight: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!mbom?.details?.length) continue;

    let factor = 0;
    for (const detail of mbom.details) {
      const childFactor = resolveKgPerPcs(detail.part).factor;
      if (!childFactor) continue;
      factor += Number(detail.qty || 0) * childFactor;
    }

    if (factor > 0) {
      const roundedFactor = roundPlanningQty(factor);
      if (row.partId) result.set(row.partId, roundedFactor);
      if (row.partCode) result.set(normalizePartCode(row.partCode), roundedFactor);
    }
  }

  return result;
}

async function buildProductionRequirementKgMap(tx, requirements = [], partMap = new Map()) {
  if (!Array.isArray(requirements) || requirements.length === 0) return new Map();

  const result = new Map();
  const productionRows = requirements.filter(
    (row) => row.orderType === "Production" || row.levelMBOM === 0,
  );
  const dependentRows = requirements.filter((row) => Number(row.levelMBOM || 0) > 0);
  const missingPartIds = [
    ...new Set(dependentRows.map((row) => row.partId).filter((id) => id && !partMap.has(id))),
  ];
  const missingPartCodes = [
    ...new Set(
      dependentRows
        .map((row) => normalizePartCode(row.partCode))
        .filter((code) => code && !partMap.has(code)),
    ),
  ];

  if (missingPartIds.length > 0 || missingPartCodes.length > 0) {
    const parts = await tx.part.findMany({
      where: {
        isDeleted: false,
        OR: [
          ...(missingPartIds.length > 0 ? [{ id: { in: missingPartIds } }] : []),
          ...(missingPartCodes.length > 0 ? [{ partCode: { in: missingPartCodes } }] : []),
        ],
      },
      select: {
        id: true,
        partCode: true,
        pcsPerBox: true,
        kgPerBox: true,
        pcsPerPlastic: true,
        kgPerPlastic: true,
        partBases: {
          select: {
            baseOn: true,
            netWeight: true,
            grossWeight: true,
          },
        },
      },
    });

    for (const part of parts) {
      if (part.id) partMap.set(part.id, part);
      if (part.partCode) partMap.set(normalizePartCode(part.partCode), part);
    }
  }

  for (const row of productionRows) {
    const rowDate = row.requiredDate ? new Date(row.requiredDate).getTime() : null;
    if (!rowDate) continue;

    let totalKg = 0;
    for (const dependent of dependentRows) {
      const dependentDate = dependent.requiredDate ? new Date(dependent.requiredDate).getTime() : null;
      if (dependentDate !== rowDate) continue;

      const part =
        partMap.get(dependent.partId) ||
        partMap.get(normalizePartCode(dependent.partCode)) ||
        null;
      const factor = resolveKgPerPcs(part).factor;
      if (!factor) continue;

      totalKg += Number(dependent.plannedOrderQty || dependent.netRequirement || 0) * Number(factor || 0);
    }

    if (totalKg > 0) {
      const roundedKg = roundPlanningQty(totalKg);
      if (row.id) result.set(row.id, roundedKg);
      if (row.partId) result.set(row.partId, roundedKg);
      if (row.partCode) result.set(normalizePartCode(row.partCode), roundedKg);
    }
  }

  return result;
}

function roundPlanningQty(value) {
  const qty = Number(value || 0);
  if (!Number.isFinite(qty)) return 0;
  return Number(qty.toFixed(6));
}

function normalizeReferencePcs(value) {
  const qty = Number(value || 0);
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  const nearestInteger = Math.round(qty);
  return Math.abs(qty - nearestInteger) < 0.0001
    ? nearestInteger
    : Math.ceil(qty);
}

function expandMpsDetailsByDeliveryPhases(details = [], deliveryPlans = []) {
  const plansByDetail = new Map();
  for (const plan of deliveryPlans) {
    if (!plan?.mpsDetailId || !plan.plannedDate || Number(plan.qtyPlanned || 0) <= 0) continue;
    if (!plansByDetail.has(plan.mpsDetailId)) plansByDetail.set(plan.mpsDetailId, []);
    plansByDetail.get(plan.mpsDetailId).push(plan);
  }

  return details.flatMap((detail) => {
    const phases = (plansByDetail.get(detail.id) || [])
      .sort((left, right) => new Date(left.fgRequiredDate || left.plannedDate) - new Date(right.fgRequiredDate || right.plannedDate) || Number(left.phaseNumber || 0) - Number(right.phaseNumber || 0));
    if (!phases.length) return [{ ...detail, _deliveryPhaseId: null, _deliveryPhaseNumber: null }];

    const phaseTotal = phases.reduce((sum, phase) => sum + Number(phase.qtyPlanned || 0), 0);
    if (phaseTotal <= 0) return [{ ...detail, _deliveryPhaseId: null, _deliveryPhaseNumber: null }];
    const originalStart = new Date(detail.startDate);
    const originalEnd = new Date(detail.endDate);
    const leadTimeMs = Number.isNaN(originalStart.getTime()) || Number.isNaN(originalEnd.getTime())
      ? 0
      : Math.max(originalEnd - originalStart, 0);
    const plannedTotal = Math.max(Number(detail.qtyPlanned || 0), 0);
    // Marketing phases represent customer commitments only. MPS buffer is an
    // internal ending-stock target and must not inflate every customer phase.
    // If PPIC intentionally lowers production below customer demand, reduce
    // the customer phases proportionally; otherwise preserve their exact qty.
    const customerPlannedTotal = Math.min(phaseTotal, plannedTotal);
    const customerScale = phaseTotal > 0 ? customerPlannedTotal / phaseTotal : 0;
    let allocatedCustomerQty = 0;
    const customerRows = phases.map((phase, index) => {
      const isLast = index === phases.length - 1;
      const phaseQty = isLast
        ? roundPlanningQty(customerPlannedTotal - allocatedCustomerQty)
        : roundPlanningQty(Number(phase.qtyPlanned || 0) * customerScale);
      allocatedCustomerQty = roundPlanningQty(allocatedCustomerQty + phaseQty);
      const dueDate = new Date(phase.fgRequiredDate || phase.plannedDate);
      const phaseStart = new Date(dueDate.getTime() - leadTimeMs);
      const phaseSourceType = String(phase.sourceType || "").trim().toUpperCase();
      return {
        ...detail,
        forecastQty: phaseSourceType === "SALES_ORDER" ? 0 : phaseQty,
        actualSalesOrderQty: phaseSourceType === "SALES_ORDER" ? phaseQty : 0,
        bufferBaseQty: 0,
        bufferQty: 0,
        effectiveDemandQty: phaseQty,
        productionPercent: 100,
        qtyPlanned: phaseQty,
        lineNumber: Number(detail.lineNumber || 0) * 1000 + Number(phase.phaseNumber || index + 1),
        startDate: phaseStart,
        endDate: dueDate,
        _deliveryPhaseId: phase.id,
        _deliveryPhaseNumber: phase.phaseNumber || index + 1,
        _deliveryPhaseSourceType: phase.sourceType || null,
        _deliveryPhaseSourceNumber: phase.sourceNumber || null,
        _deliveryTargetId: phase.sourceDeliveryTargetId || null,
        _customerCode: phase.targetCode || null,
        _customerTargetDate: phase.plannedDate || null,
        _fgRequiredDate: phase.fgRequiredDate || phase.plannedDate || null,
        _fgFinishSplitNumber: phase.fgFinishSplitNumber || null,
        _isBufferPhase: false,
      };
    });

    const bufferPlannedQty = roundPlanningQty(Math.max(plannedTotal - customerPlannedTotal, 0));
    if (bufferPlannedQty <= 0) return customerRows;
    const bufferDueDate = new Date(detail.endDate);
    const bufferStart = new Date(bufferDueDate.getTime() - leadTimeMs);
    return [...customerRows, {
      ...detail,
      forecastQty: 0,
      actualSalesOrderQty: 0,
      bufferQty: bufferPlannedQty,
      effectiveDemandQty: bufferPlannedQty,
      productionPercent: 100,
      qtyPlanned: bufferPlannedQty,
      lineNumber: Number(detail.lineNumber || 0) * 1000 + 999,
      startDate: bufferStart,
      endDate: bufferDueDate,
      customerCode: null,
      deliveryPhaseId: null,
      customerTargetDate: null,
      fgRequiredDate: bufferDueDate,
      priorityScore: null,
      priorityClass: null,
      _deliveryPhaseId: null,
      _deliveryPhaseNumber: null,
      _deliveryPhaseSourceType: "BUFFER",
      _deliveryPhaseSourceNumber: detail._sourceMpsNumber || detail.mpsNumber || null,
      _deliveryTargetId: null,
      _customerCode: null,
      _customerTargetDate: bufferDueDate,
      _fgRequiredDate: bufferDueDate,
      _fgFinishSplitNumber: null,
      _isBufferPhase: true,
    }];
  });
}

function demandPeggingForPhase(detail) {
  const referenceSources = (detail.demandSources || []).map((source) => ({
    sourceType: source.sourceType,
    sourceNumber: source.sourceNumber,
    sourceLineId: source.sourceLineId || null,
    forecastDetailId: source.forecastDetailId || null,
    customerCode: source.customerCode || null,
    qty: number(source.qty),
    uomCode: source.uomCode || null,
    requiredDate: source.effectiveRequiredDate || source.requiredDate || null,
  }));
  if (detail._isBufferPhase) {
    return [{
      sourceType: "BUFFER",
      sourceNumber: detail._sourceMpsNumber || detail.mpsNumber || null,
      customerCode: null,
      deliveryTargetId: null,
      targetDeliveryDate: detail.endDate,
      fgRequiredDate: detail.endDate,
      fgPartCode: detail.partCode,
      qty: number(detail.qtyPlanned),
      phaseLabel: "Buffer akhir bulan",
      deliveryPhaseNumber: null,
      referenceSources,
    }];
  }
  const targetId = detail._deliveryTargetId || detail.deliveryPhaseId || null;
  const rows = (detail.demandSources || []).flatMap((source) => {
    const sourceRows = Array.isArray(source.sourcePegging) ? source.sourcePegging : [];
    const matching = targetId ? sourceRows.filter((peg) => peg.deliveryTargetId === targetId) : sourceRows;
    return matching.map((peg) => ({
      ...peg,
      sourceType: source.sourceType,
      sourceNumber: source.sourceNumber,
      sourceLineId: source.sourceLineId || null,
      forecastDetailId: source.forecastDetailId || null,
      customerCode: peg.customerCode || source.customerCode || detail.customerCode || null,
      fgPartCode: detail.partCode,
      fgRequiredDate: detail._fgRequiredDate || peg.fgRequiredDate || null,
      fgFinishSplitNumber: detail._fgFinishSplitNumber || null,
      deliveryPhaseNumber: detail._deliveryPhaseNumber || peg.phaseNumber || null,
      phaseLabel: detail._deliveryPhaseNumber ? `Phase ${detail._deliveryPhaseNumber}` : null,
      referenceSources,
    }));
  });
  if (rows.length) {
    const targetQty = number(detail.qtyPlanned);
    const sourceTotal = rows.reduce((sum, row) => sum + number(row.qty), 0);
    let allocated = 0;
    return rows.map((row, index) => {
      const qty = index === rows.length - 1
        ? roundPlanningQty(targetQty - allocated)
        : roundPlanningQty(targetQty * (sourceTotal > 0 ? number(row.qty) / sourceTotal : 1 / rows.length));
      allocated = roundPlanningQty(allocated + qty);
      return { ...row, qty };
    });
  }
  return [{
    sourceType: detail._deliveryPhaseSourceType || detail.demandSources?.[0]?.sourceType || "MPS",
    sourceNumber: detail._deliveryPhaseSourceNumber || detail.demandSources?.[0]?.sourceNumber || null,
    sourceLineId: detail.demandSources?.[0]?.sourceLineId || null,
    forecastDetailId: detail.demandSources?.[0]?.forecastDetailId || null,
    customerCode: detail.customerCode || detail.demandSources?.[0]?.customerCode || null,
    deliveryTargetId: targetId,
    targetDeliveryDate: detail._customerTargetDate || detail.customerTargetDate || detail.endDate,
    fgRequiredDate: detail._fgRequiredDate || detail.endDate,
    fgFinishSplitNumber: detail._fgFinishSplitNumber || null,
    deliveryPhaseNumber: detail._deliveryPhaseNumber || null,
    phaseLabel: detail._deliveryPhaseNumber ? `Phase ${detail._deliveryPhaseNumber}` : "Delivery phase belum dipetakan",
    fgPartCode: detail.partCode,
    qty: number(detail.qtyPlanned),
    referenceSources,
  }];
}

async function buildProductionConversionPartMap(tx, requirements = []) {
  const partIds = [...new Set(requirements.map((row) => row.partId).filter(Boolean))];
  const partCodes = [
    ...new Set(requirements.map((row) => normalizePartCode(row.partCode)).filter(Boolean)),
  ];

  if (partIds.length === 0 && partCodes.length === 0) return new Map();

  const parts = await tx.part.findMany({
    where: {
      isDeleted: false,
      OR: [
        ...(partIds.length > 0 ? [{ id: { in: partIds } }] : []),
        ...(partCodes.length > 0 ? [{ partCode: { in: partCodes } }] : []),
      ],
    },
    select: {
      id: true,
      partCode: true,
      itemType: true,
      rawType: true,
      pcsPerBox: true,
      kgPerBox: true,
      pcsPerPlastic: true,
      kgPerPlastic: true,
      partBases: {
        select: {
          baseOn: true,
          netWeight: true,
          grossWeight: true,
        },
      },
    },
  });

  const map = new Map();
  for (const part of parts) {
    if (part.id) map.set(part.id, part);
    if (part.partCode) map.set(normalizePartCode(part.partCode), part);
  }
  return map;
}

function resolveProductionPlannedOrderQuantity({ qty, sourceUomCode, part, fallbackKgPerPcs = null }) {
  const sourceCode = normalizeUomCode(sourceUomCode);
  const partConversion = resolveKgPerPcs(part);
  const fallbackFactor = Number(fallbackKgPerPcs || 0);
  const factor = partConversion.factor || (fallbackFactor > 0 ? fallbackFactor : null);
  const source = partConversion.source || (factor ? "active mbom component gross weight" : null);

  if (factor) {
    const convertedQty = roundPlanningQty(Number(qty || 0) * Number(factor || 0));
    return {
      qty: convertedQty,
      uomCode: "kg",
      note: `Auto converted production qty from ${roundPlanningQty(qty)} ${sourceUomCode || "original uom"} to ${convertedQty} kg using ${source}.`,
    };
  }

  if (isKgUom(sourceCode)) {
    return {
      qty: roundPlanningQty(qty),
      uomCode: "kg",
      note: null,
    };
  }

  if (!factor) {
    return {
      qty: roundPlanningQty(qty),
      uomCode: sourceUomCode || null,
      note: sourceCode && !isPcsUom(sourceCode)
        ? null
        : "Production qty belum dikonversi ke kg karena data berat/packing part belum lengkap.",
    };
  }
}

function buildPlannedOrderRequirementKey(row) {
  const requiredDate = row.requiredDate ? new Date(row.requiredDate).toISOString() : "";
  const orderDate = row.orderDate ? new Date(row.orderDate).toISOString() : "";
  return [
    row.runNumber || "",
    normalizePartCode(row.partCode),
    requiredDate,
    orderDate,
  ].join("|");
}

function parseSoSourceNumber(value) {
  const [soNumber, lineNumber] = String(value || "").split("#");
  const parsedLineNumber = Number(lineNumber);
  return {
    soNumber: soNumber || null,
    lineNumber: Number.isFinite(parsedLineNumber) ? parsedLineNumber : null,
  };
}

async function buildRequirementOriginalUomMap(tx, requirements = []) {
  const map = new Map();
  if (!Array.isArray(requirements) || requirements.length === 0) return map;

  const mpsDetailIds = [
    ...new Set(requirements.map((row) => row.mpsDetailId).filter(Boolean)),
  ];
  if (mpsDetailIds.length > 0) {
    const mpsDetails = await tx.mPSDetail.findMany({
      where: { id: { in: mpsDetailIds } },
      select: {
        id: true,
        mbom: { select: { uomCode: true } },
        forecastDetail: { select: { uomCode: true } },
      },
    });
    const uomByMpsDetailId = new Map(
      mpsDetails.map((detail) => [
        detail.id,
        detail.forecastDetail?.uomCode || detail.mbom?.uomCode || null,
      ]),
    );
    for (const requirement of requirements) {
      const uomCode = uomByMpsDetailId.get(requirement.mpsDetailId);
      if (uomCode) map.set(requirement.id, uomCode);
    }
  }

  const soRequirements = requirements.filter((row) => row.sourceType === "SO" && row.sourceNumber);
  if (soRequirements.length > 0) {
    const soFilters = soRequirements
      .map((row) => parseSoSourceNumber(row.sourceNumber))
      .filter((row) => row.soNumber && row.lineNumber != null);
    const soDetails = soFilters.length > 0
      ? await tx.salesOrderDetail.findMany({
          where: {
            OR: soFilters.map((row) => ({
              soNumber: row.soNumber,
              lineNumber: row.lineNumber,
            })),
          },
          select: {
            soNumber: true,
            lineNumber: true,
            uomCode: true,
          },
        })
      : [];
    const uomBySoLine = new Map(
      soDetails.map((detail) => [`${detail.soNumber}#${detail.lineNumber}`, detail.uomCode]),
    );
    for (const requirement of soRequirements) {
      const uomCode = uomBySoLine.get(requirement.sourceNumber);
      if (uomCode) map.set(requirement.id, uomCode);
    }
  }

  const mbomRequirements = requirements.filter(
    (row) => row.sourceType === "MBOM" && row.sourceNumber && row.partId,
  );
  if (mbomRequirements.length > 0) {
    const noRegs = [...new Set(mbomRequirements.map((row) => row.sourceNumber).filter(Boolean))];
    const partIds = [...new Set(mbomRequirements.map((row) => row.partId).filter(Boolean))];
    const details = await tx.mBOMDetail.findMany({
      where: {
        noReg: { in: noRegs },
        partId: { in: partIds },
        isDeleted: false,
      },
      select: {
        noReg: true,
        partId: true,
        uomCode: true,
      },
    });
    const uomByMbomPart = new Map(
      details.map((detail) => [`${detail.noReg}|${detail.partId}`, detail.uomCode]),
    );
    for (const requirement of mbomRequirements) {
      const uomCode = uomByMbomPart.get(`${requirement.sourceNumber}|${requirement.partId}`);
      if (uomCode) map.set(requirement.id, uomCode);
    }
  }

  return map;
}

async function enrichPlannedOrderQtyBreakdown(tx, orders = []) {
  if (!Array.isArray(orders) || orders.length === 0) return orders;

  const runNumbers = [...new Set(orders.map((order) => order.runNumber).filter(Boolean))];
  const partCodes = [
    ...new Set(orders.map((order) => normalizePartCode(order.partCode)).filter(Boolean)),
  ];

  if (runNumbers.length === 0 || partCodes.length === 0) {
    return orders.map((order) => ({
      ...order,
      qtyPcs: order.orderType === "Purchase" && isPcsUom(order.uomCode) ? Number(order.qty || 0) : null,
      qtyKg: isKgUom(order.uomCode) ? Number(order.qty || 0) : null,
    }));
  }

  const requirements = await tx.mRPRequirement.findMany({
    where: {
      runNumber: { in: runNumbers },
      plannedOrderQty: { gt: 0 },
      isDeleted: false,
    },
    select: {
      id: true,
      runNumber: true,
      parentRequirementId: true,
      rootRequirementId: true,
      treePath: true,
      partCode: true,
      requiredDate: true,
      orderDate: true,
      plannedOrderQty: true,
      levelMBOM: true,
      mbomLevelComponent: true,
      mbomDetailId: true,
      requirementType: true,
      partId: true,
      orderType: true,
      netRequirement: true,
      mpsDetailId: true,
      sourceType: true,
      sourceNumber: true,
      mbomDetail: { select: { grossWeight: true } },
    },
  });

  const requirementByKey = new Map(
    requirements.map((requirement) => [buildPlannedOrderRequirementKey(requirement), requirement]),
  );
  const productionConversionPartMap = await buildProductionConversionPartMap(tx, requirements);
  const productionRequirementKgMap = await buildProductionRequirementKgMap(
    tx,
    requirements,
    productionConversionPartMap,
  );
  const originalUomMap = await buildRequirementOriginalUomMap(tx, requirements);

  return orders.map((order) => {
    const requirement = requirementByKey.get(buildPlannedOrderRequirementKey(order));
    const originalUomCode = requirement ? originalUomMap.get(requirement.id) || null : null;
    const ownPart =
      productionConversionPartMap.get(order.partId) ||
      productionConversionPartMap.get(normalizePartCode(order.partCode)) ||
      null;
    const ownKgPerQty = resolveKgPerPcs(ownPart).factor;
    const referenceKgPerPcs = Number(requirement?.mbomDetail?.grossWeight || 0)
      || Number(ownKgPerQty || 0);
    const qtyPcs = order.orderType === "Production"
      ? (requirement ? normalizeReferencePcs(requirement.plannedOrderQty) : null)
      : (isPcsUom(order.uomCode)
        ? normalizeReferencePcs(order.qty)
        : (requirement && isPcsUom(originalUomCode)
          ? (isKgUom(order.uomCode) && referenceKgPerPcs > 0
            ? normalizeReferencePcs(Number(order.qty || 0) / referenceKgPerPcs)
            : normalizeReferencePcs(requirement.plannedOrderQty))
          : null));
    const originalQty = Number(qtyPcs ?? order.qty ?? 0);
    const storedOrderQtyKg = isKgUom(order.uomCode)
      ? Number(order.qty || 0)
      : null;
    const qtyKg = storedOrderQtyKg != null
      ? storedOrderQtyKg
      : order.orderType === "Production" && isKgUom(originalUomCode)
        ? originalQty
        : ownKgPerQty
          ? roundPlanningQty(originalQty * Number(ownKgPerQty || 0))
      : order.orderType === "Production"
        ? productionRequirementKgMap.get(requirement?.id) ||
          productionRequirementKgMap.get(requirement?.partId) ||
          productionRequirementKgMap.get(normalizePartCode(requirement?.partCode || order.partCode)) ||
          null
        : null;
    const displayQty = order.orderType === "Production" && qtyPcs != null
      ? qtyPcs
      : Number(order.qty || 0);
    const displayUomCode = order.orderType === "Production" && qtyPcs != null
      ? originalUomCode || order.uomCode
      : order.uomCode;

    return {
      ...order,
      qty: displayQty,
      uomCode: displayUomCode,
      qtyPcs,
      qtyKg,
      mrpRequirementId: requirement?.id ?? null,
      mrpRequirementParentId: requirement?.parentRequirementId ?? null,
      mrpRequirementRootId: requirement?.rootRequirementId ?? null,
      mrpRequirementTreePath: requirement?.treePath ?? null,
      mrpRequirementLevelMBOM: requirement?.levelMBOM ?? null,
      mbomLevelComponent: requirement?.mbomLevelComponent ?? null,
      mbomDetailId: requirement?.mbomDetailId ?? null,
      mrpRequirementType: requirement?.requirementType ?? null,
      mrpRequirementSourceType: requirement?.sourceType ?? null,
    };
  });
}

async function enrichRequirementQtyBreakdown(tx, requirements = []) {
  if (!Array.isArray(requirements) || requirements.length === 0) return requirements;

  const runNumbers = [...new Set(requirements.map((row) => row.runNumber).filter(Boolean))];
  const plannedOrderKgByRequirementKey = new Map();
  if (runNumbers.length > 0) {
    const plannedOrders = await tx.plannedOrder.findMany({
      where: {
        runNumber: { in: runNumbers },
        isDeleted: false,
      },
      select: {
        runNumber: true,
        partCode: true,
        requiredDate: true,
        orderDate: true,
        qty: true,
        uomCode: true,
      },
    });

    for (const order of plannedOrders) {
      if (!isKgUom(order.uomCode)) continue;
      plannedOrderKgByRequirementKey.set(
        buildPlannedOrderRequirementKey(order),
        Number(order.qty || 0),
      );
    }
  }

  const productionConversionPartMap = await buildProductionConversionPartMap(tx, requirements);
  const productionMbomKgPerPcsMap = await buildProductionMbomKgPerPcsMap(
    tx,
    requirements,
    productionConversionPartMap,
  );
  const productionRequirementKgMap = await buildProductionRequirementKgMap(
    tx,
    requirements,
    productionConversionPartMap,
  );
  const originalUomMap = await buildRequirementOriginalUomMap(tx, requirements);

  return requirements.map((requirement) => {
    const plannedOrderQty = Number(requirement.plannedOrderQty || 0);
    const grossRequirement = Number(requirement.grossRequirement || 0);
    const onHandQty = Number(requirement.onHandQty || 0);
    const netRequirement = Number(requirement.netRequirement || 0);
    const scheduledSupplyQty = Math.max(
      roundPlanningQty(grossRequirement - onHandQty - netRequirement),
      0,
    );
    const isProduction = requirement.orderType === "Production" || requirement.levelMBOM === 0;
    const part =
      productionConversionPartMap.get(requirement.partId) ||
      productionConversionPartMap.get(normalizePartCode(requirement.partCode)) ||
      null;
    const rawMaterial = isRawMaterialPart(requirement.part || part);
    const detailKgPerQty = Number(requirement.mbomDetail?.grossWeight || 0);
    const rawMaterialKgPerQty = rawMaterial
      ? (detailKgPerQty > 0 ? detailKgPerQty : resolveKgPerPcs(part).factor)
      : null;
    const originalUomCode = requirement.uomCode || originalUomMap.get(requirement.id) || null;
    const uomCode = rawMaterial && (rawMaterialKgPerQty || isKgUom(originalUomCode))
      ? "kg"
      : originalUomCode;
    let plannedOrderQtyKg = null;

    if (plannedOrderQty > 0) {
      if (isKgUom(originalUomCode)) {
        plannedOrderQtyKg = plannedOrderQty;
      }
      plannedOrderQtyKg =
        plannedOrderQtyKg ??
        plannedOrderKgByRequirementKey.get(buildPlannedOrderRequirementKey(requirement)) ??
        null;
      const ownKgPerQty = rawMaterial
        ? rawMaterialKgPerQty
        : isProduction
          ? resolveKgPerPcs(part).factor
          : null;
      if (plannedOrderQtyKg == null && ownKgPerQty) {
        plannedOrderQtyKg = roundPlanningQty(plannedOrderQty * Number(ownKgPerQty || 0));
      }
      if (plannedOrderQtyKg == null && isProduction && !isKgUom(uomCode)) {
        const conversion = resolveProductionPlannedOrderQuantity({
          qty: plannedOrderQty,
          sourceUomCode: uomCode,
          part,
          fallbackKgPerPcs:
            productionMbomKgPerPcsMap.get(requirement.partId) ||
            productionMbomKgPerPcsMap.get(normalizePartCode(requirement.partCode)),
        });
        plannedOrderQtyKg = isKgUom(conversion.uomCode)
          ? conversion.qty
          : productionRequirementKgMap.get(requirement.id) ||
            productionRequirementKgMap.get(requirement.partId) ||
            productionRequirementKgMap.get(normalizePartCode(requirement.partCode)) ||
            null;
      }
    }

    const referenceDemandQtyPcs = rawMaterial && rawMaterialKgPerQty && isKgUom(uomCode)
      ? normalizeReferencePcs(Number(requirement.effectiveDemandQty || grossRequirement) / rawMaterialKgPerQty)
      : isPcsUom(uomCode)
        ? normalizeReferencePcs(requirement.effectiveDemandQty || grossRequirement)
        : null;
    const plannedOrderQtyPcs = rawMaterial && rawMaterialKgPerQty && plannedOrderQtyKg != null
      ? normalizeReferencePcs(plannedOrderQtyKg / rawMaterialKgPerQty)
      : isPcsUom(uomCode)
        ? normalizeReferencePcs(plannedOrderQty)
        : null;

    return {
      ...requirement,
      uomCode,
      scheduledSupplyQty,
      plannedOrderQtyKg,
      referenceDemandQtyPcs,
      plannedOrderQtyPcs,
    };
  });
}

function buildBufferStockNote(bufferPercent, bufferQty) {
  if (!bufferPercent || !bufferQty) return null;
  return `Buffer stock ${bufferPercent}% x forecast bulan berikutnya = ${bufferQty}`;
}

function buildMpsDemandContextMap(mpsDetails = []) {
  return new Map(
    mpsDetails.map((row) => [
      row.id,
      {
        customerCode: normalizePartCode(row.customerCode) || "Tanpa Customer",
        planPartCode: normalizePartCode(row.partCode) || "Tanpa Part",
        requiredDate: row.endDate || row.startDate,
      },
    ]),
  );
}

function applyNextMonthPurchaseBuffer(requirements = [], options = {}) {
  const purchaseRequirements = requirements.filter((row) => row.orderType === "Purchase");
  const contextByMpsDetailId = buildMpsDemandContextMap(options.mpsDetails || []);
  const groups = new Map();

  for (const row of purchaseRequirements) {
    const context = contextByMpsDetailId.get(row.mpsDetailId) || {
      customerCode: row.sourceType === "SO" ? row.sourceNumber || "SO" : "Tanpa Customer",
      planPartCode: row.sourceType === "SO" ? row.partCode : "Tanpa Part",
      requiredDate: row.requiredDate,
    };
    const month = planningMonthKey(context.requiredDate || row.requiredDate);
    const baseKey = [
      normalizePartCode(row.partCode),
      context.customerCode,
      context.planPartCode,
    ].join("|");
    const key = `${baseKey}|${month}`;
    if (!groups.has(key)) {
      groups.set(key, { baseKey, month, requiredDate: context.requiredDate || row.requiredDate, rows: [], baseQty: 0 });
    }
    const group = groups.get(key);
    group.rows.push(row);
    group.baseQty += Number(row.effectiveDemandQty || 0);
  }

  for (const group of groups.values()) {
    const nextGroup = groups.get(`${group.baseKey}|${nextPlanningMonthKey(group.requiredDate)}`);
    const nextMonthDemandQty = Number(nextGroup?.baseQty || 0);
    const groupBaseQty = Number(group.baseQty || 0);
    for (const [index, row] of group.rows.entries()) {
      // MPS-driven rows already contain the parent FG buffer. Recomputing a
      // next-month buffer here would double count it (and a single-month MRP
      // would incorrectly reset the buffer to zero).
      if (row._bufferFromMps) continue;
      const rowBaseQty = Number(row.effectiveDemandQty || 0);
      const allocation = groupBaseQty > 0
        ? nextMonthDemandQty * (rowBaseQty / groupBaseQty)
        : index === 0
          ? nextMonthDemandQty
          : 0;
      const bufferBaseQty = roundPlanningQty(allocation);
      const bufferPercent = resolveBufferPercent({ bufferStock: row._partBufferPercent });
      const bufferQty = roundPlanningQty((bufferBaseQty * bufferPercent) / 100);
      row.bufferBaseQty = bufferBaseQty;
      row.bufferPercent = bufferPercent;
      row.bufferQty = bufferQty;
      row.bufferOverridden = false;
      row.grossRequirement = roundPlanningQty(rowBaseQty + bufferQty);
      row.notes = buildBufferStockNote(bufferPercent, bufferQty);
    }
  }

  const rowsBySupply = new Map();
  for (const row of purchaseRequirements) {
    const supplyKey = row._planningStockKey || normalizePartCode(row.partCode);
    if (!rowsBySupply.has(supplyKey)) rowsBySupply.set(supplyKey, []);
    rowsBySupply.get(supplyKey).push(row);
  }

  for (const [supplyKey, rows] of rowsBySupply.entries()) {
    let projectedAvailable = Number(options.initialAvailableMap?.[supplyKey] || 0);
    let projectedActual = Number(options.initialActualAvailableMap?.[supplyKey] || 0);
    const allocatedQty = Number(options.initialAllocatedMap?.[supplyKey] || 0);
    rows.sort((a, b) => new Date(a.requiredDate) - new Date(b.requiredDate) || String(a.treePath || "").localeCompare(String(b.treePath || "")));
    for (const row of rows) {
      row.onHandQty = projectedActual;
      row.allocatedQty = allocatedQty;
      row.netRequirement = roundPlanningQty(evaluateFromSet(options.formulas, "MRP_NET_REQUIREMENT", {
        grossRequirement: Number(row.grossRequirement || 0),
        projectedAvailable,
      }));
      row.plannedOrderQty = row.netRequirement;
      row.orderPercent = Number(row.orderPercent ?? 100);
      row.adjustedOrderQty = row.netRequirement;
      projectedAvailable = Math.max(projectedAvailable - Number(row.grossRequirement || 0), 0);
      projectedActual = Math.max(projectedActual - Number(row.grossRequirement || 0), 0);
    }
  }

  return purchaseRequirements;
}

function applyTimePhasedPurchaseNetting(requirements = [], supplyEvents = [], options = {}) {
  const rowsBySupply = new Map();
  for (const row of requirements) {
    const supplyKey = row._planningStockKey || normalizePartCode(row.partCode);
    if (!rowsBySupply.has(supplyKey)) rowsBySupply.set(supplyKey, []);
    rowsBySupply.get(supplyKey).push(row);
  }
  for (const [supplyKey, rows] of rowsBySupply.entries()) {
    const events = supplyEvents.filter((event) => event.supplyKey === supplyKey);
    const netted = netTimePhasedDemand({
      openingQty: Number(options.initialStockAvailableMap?.[supplyKey] || 0),
      supplyEvents: events,
      demandEvents: rows.map((row) => ({ id: row.id, qty: Number(row.grossRequirement || 0), requiredDate: row.requiredDate })),
    });
    const resultById = new Map(netted.map((row) => [row.id, row]));
    for (const row of rows) {
      const result = resultById.get(row.id);
      if (!result) continue;
      const eligibleSupply = result.eligibleSupply || [];
      row.firmSupplyQty = roundPlanningQty(eligibleSupply.filter((event) => event.confidence === "FIRM").reduce((sum, event) => sum + Number(event.qty || 0), 0));
      row.plannedSupplyQty = roundPlanningQty(eligibleSupply.filter((event) => event.confidence !== "FIRM").reduce((sum, event) => sum + Number(event.qty || 0), 0));
      row.netRequirement = roundPlanningQty(result.netRequirement);
      row.firmNetRequirement = roundPlanningQty(result.firmNetRequirement);
      row.atRiskSupplyQty = roundPlanningQty(result.atRiskSupplyQty);
      row.projectedAvailableQty = roundPlanningQty(result.projectedAvailableAfter);
      row.firmProjectedAvailableQty = roundPlanningQty(result.firmProjectedAvailableAfter);
      row.supplyTimeline = eligibleSupply.map((event) => ({
        sourceType: event.sourceType,
        sourceNumber: event.sourceNumber,
        status: event.status || null,
        confidence: event.confidence,
        availableDate: event.availableDate,
        qty: roundPlanningQty(event.qty),
      }));
      row.plannedOrderQty = row.netRequirement;
      row.adjustedOrderQty = row.netRequirement;
      const leadTime = Number(options.partnerMap?.[row.partCode]?.leadTimeDays || row.leadTime || 0);
      const planningDecision = options.planningConstraintByTarget?.get(row.deliveryTargetId) || null;
      const schedule = procurementSchedule({
        materialRequiredDate: row.requiredDate,
        supplierLeadTimeDays: leadTime,
        ...procurementPolicyFromDecision(planningDecision, options.procurementPolicy || {}),
        asOf: options.asOf || new Date(),
      });
      row.materialRequiredDate = new Date(row.requiredDate);
      row.supplierRequiredArrivalDate = schedule.supplierRequiredArrivalDate;
      row.orderDate = schedule.latestPoDate;
      row.latestPrDate = schedule.latestPrDate;
      row.procurementWindow = schedule.procurementWindow;
      row.scheduleSource = row.scheduleSource || "MRP_BACKWARD_SCHEDULE";
    }
  }
  return requirements;
}

function productionProcessScheduleQty(requirement = {}) {
  if (requirement.orderType !== "Production") return 0;
  return Math.max(
    Number(requirement.grossRequirement || 0) - Number(requirement.onHandQty || 0),
    0,
  );
}

function stripRequirementInternals(requirements = []) {
  const persistedIds = new Set(requirements.map((row) => row.id));
  return requirements.map((row) => {
    const data = Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("_")));
    if (data.parentRequirementId && !persistedIds.has(data.parentRequirementId)) {
      data.parentRequirementId = null;
    }
    return data;
  });
}

async function syncProductionRequirementsToMps(tx, mps, requirements, mbomHeaderByPartCode, runNumber) {
  // MPS is an approved demand snapshot. Net production after stock/open-supply
  // netting belongs to MRPRequirement and must never overwrite the approved
  // MPS quantity. MPP reads the current MRP root requirement explicitly.

  await tx.mPSDetail.updateMany({
    where: {
      mpsNumber: mps.mpsNumber,
      isDeleted: false,
      notes: { startsWith: GENERATED_MPS_CHILD_NOTE_PREFIX },
    },
    data: { isDeleted: true },
  });

  const sourceDetails = mps.details.filter(
    (row) => !String(row.notes || "").startsWith(GENERATED_MPS_CHILD_NOTE_PREFIX),
  );
  const sourceById = new Map(sourceDetails.map((row) => [row.id, row]));
  const groups = new Map();
  for (const row of requirements) {
    if (row.orderType !== "Production" || Number(row.levelMBOM || 0) <= 0) continue;
    // A dependent FG owns a nested BOM and is an intermediate receipt between
    // its own operations and the parent BOM operations. Keep it in MPS as a
    // child FG receipt; it is not a second top-level demand.
    const itemType = String(row._partItemType || "").trim().toUpperCase();
    // `_productionScheduleQty` is the child-explosion driver after WIP
    // netting. It is valid for deciding how far upstream material demand must
    // continue, but it is not always the quantity of the operation that
    // produces this row. Stock at a child stage (for example stock before
    // PAINT) may stop the upstream explosion while PAINT itself is still
    // required. Keep that downstream transformation through the separate
    // process-output driver calculated against stock of this exact part.
    const qtyPlanned = Math.max(
      Number(row._productionScheduleQty || 0),
      Number(row._processScheduleQty || 0),
    );
    if (qtyPlanned <= 0) continue;
    const source = sourceById.get(row.mpsDetailId);
    if (!source) continue;
    const key = [source.id, normalizePartCode(row.partCode), planningMonthKey(row.requiredDate)].join("|");
    if (!groups.has(key)) {
      groups.set(key, {
        source,
        partCode: row.partCode,
        partId: row.partId || null,
        itemType,
        qtyPlanned: 0,
        startDate: row.orderDate || source.startDate,
        endDate: row.requiredDate || source.endDate,
      });
    }
    const group = groups.get(key);
    group.qtyPlanned += qtyPlanned;
    if (new Date(row.orderDate) < new Date(group.startDate)) group.startDate = row.orderDate;
    if (new Date(row.requiredDate) > new Date(group.endDate)) group.endDate = row.requiredDate;
  }

  const generated = [...groups.values()];
  if (generated.length === 0) return 0;
  const firstGeneratedLine = sourceDetails.reduce((max, row) => Math.max(max, Number(row.lineNumber || 0)), 0) + 1;
  await tx.mPSDetail.createMany({
    data: generated.map((row, index) => ({
      mpsNumber: mps.mpsNumber,
      lineNumber: firstGeneratedLine + index,
      partCode: row.partCode,
      partId: row.partId,
      mbomHeaderId: mbomHeaderByPartCode[row.partCode] || null,
      // Child/SFG schedule inherits the planning context of its FG receipt.
      // This keeps buffer visible and traceable throughout the production tree.
      forecastQty: Number(row.source.forecastQty || 0),
      actualSalesOrderQty: Number(row.source.actualSalesOrderQty || 0),
      bufferBaseQty: Number(row.source.bufferBaseQty || 0),
      bufferPercent: Number(row.source.bufferPercent || 0),
      bufferQty: Number(row.source.bufferQty || 0),
      effectiveDemandQty: Number(row.source.effectiveDemandQty || 0),
      productionPercent: Number(row.source.productionPercent || 100),
      qtyPlanned: roundPlanningQty(row.qtyPlanned),
      startDate: row.startDate,
      endDate: row.endDate,
      priority: row.source.priority || 1,
      status: "Planned",
      customerCode: row.source.customerCode,
      forecastPeriodOffset: row.source.forecastPeriodOffset,
      notes: `${GENERATED_MPS_CHILD_NOTE_PREFIX}${row.itemType === "FG" ? " [FG-RECEIPT:CHILD]" : ""} Generated from ${runNumber}; source ${row.source.partCode}; [MPS-SOURCE:${row.source.id}]`,
    })),
  });
  return generated.length;
}

function enrichRequirementPlanningGroups(requirements = []) {
  const byId = new Map(requirements.map((row) => [row.id, row]));
  return requirements.map((row) => {
    const root = Number(row.levelMBOM || 0) === 0
      ? row
      : byId.get(row.rootRequirementId) || byId.get(row.parentRequirementId) || row;
    const mpsDetail = row.mpsDetail || root.mpsDetail || null;
    return {
      ...row,
      planningCustomerCode: mpsDetail?.customerCode || "Tanpa Customer",
      planningMonth: mpsDetail?.startDate || mpsDetail?.endDate || row.requiredDate,
      planningPartCode: root.partCode || mpsDetail?.partCode || row.partCode,
      planningPartNumber: root.part?.partNumber || row.part?.partNumber || null,
      planningPartName: root.part?.partName || row.part?.partName || null,
      planningPartItemType: root.part?.itemType || row.part?.itemType || null,
    };
  });
}

function resolvePlanningPolicy(part) {
  return part?.planningPolicy === "MTS" ? "MTS" : "MTO";
}

function resolveIndependentDemandQty(forecastQty, soQty, part) {
  return resolvePolicyDemandQty({
    forecastQty,
    salesOrderQty: soQty,
    part,
  });
}

function upsertSupplyQty(map, partCode, qty) {
  const code = normalizePartCode(partCode);
  if (!code) return;
  const safeQty = Number(qty || 0);
  if (safeQty <= 0) return;
  map[code] = Number(map[code] || 0) + safeQty;
}

function mergeQtyMaps(...maps) {
  const merged = {};
  for (const m of maps) {
    if (!m) continue;
    for (const [partCode, qty] of Object.entries(m)) {
      upsertSupplyQty(merged, partCode, qty);
    }
  }
  return merged;
}

function resolveOpenManufacturingSupplyQty(mo) {
  const plannedQty = Number(mo?.qtyPlanned || 0);
  if (plannedQty <= 0) return 0;

  // Fulfillment MO is based on the MO header. Historical rows may only
  // have qtyProduced populated, so keep it as a fallback signal.
  const fulfilledQty = Math.max(
    Number(mo?.qtyGood || 0),
    Number(mo?.qtyProduced || 0),
  );
  const rejectedQty = Number(mo?.qtyReject || 0);

  return Math.max(plannedQty - fulfilledQty - rejectedQty, 0);
}

function resolveFirmExecutionSupplyQty(row) {
  const plannedQty = Number(row?.plannedQty ?? row?.qtyPlanned ?? 0);
  if (plannedQty <= 0) return 0;

  // WO/VPO routing is already a firm execution plan for dependent inHouse/Vendor
  // MBOM rows. Count the planned quantity as coverage so rerunning MRP does not
  // create duplicate child PMO after the FG/root MO has been released.
  return plannedQty;
}

function isValidLinkedPrSupply(detail, plannedOrderByNumber = new Map()) {
  if (!detail?.plannedOrderNumber) return true;
  const plannedOrder = plannedOrderByNumber.get(detail.plannedOrderNumber);
  if (!plannedOrder) return false;
  if (!["Partially Released", "Released"].includes(plannedOrder.status)) return false;
  if (detail.createdAt && plannedOrder.createdAt && new Date(detail.createdAt) < new Date(plannedOrder.createdAt)) {
    return false;
  }
  return true;
}

function isValidLinkedMppSupply(detail, plannedOrderByNumber = new Map()) {
  if (!detail?.plannedOrderNumber) return true;
  const plannedOrder = plannedOrderByNumber.get(detail.plannedOrderNumber);
  if (!plannedOrder) return false;
  if (!["Monthly Planned", "Partially Released", "Released"].includes(plannedOrder.status)) return false;
  if (detail.createdAt && plannedOrder.createdAt && new Date(detail.createdAt) < new Date(plannedOrder.createdAt)) {
    return false;
  }
  return true;
}

function isValidLinkedMoSupply(mo, plannedOrderByNumber = new Map()) {
  if (!mo?.plannedOrderNumber) return true;
  const plannedOrder = plannedOrderByNumber.get(mo.plannedOrderNumber);
  if (!plannedOrder) return false;
  if (!["Partially Released", "Released"].includes(plannedOrder.status)) return false;
  if (mo.createdAt && plannedOrder.createdAt && new Date(mo.createdAt) < new Date(plannedOrder.createdAt)) {
    return false;
  }
  return true;
}

function buildNettingRunSummary(soDemandConsumptionSummary) {
  return {
    totalConsumedQty: Number(soDemandConsumptionSummary.totalConsumedQty || 0),
    impactedMpsLines: Number(soDemandConsumptionSummary.impactedMpsLines || 0),
    byPart: Object.entries(soDemandConsumptionSummary.byPart || {}).map(
      ([partCode, value]) => ({
        partCode,
        consumedQty: Number(value?.consumedQty || 0),
        sources: [...new Set(value?.sources || [])],
      }),
    ),
  };
}

function normalizeNettingSummary(summary) {
  const normalized = {
    totalConsumedQty: Number(summary?.totalConsumedQty || 0),
    impactedMpsLines: Number(summary?.impactedMpsLines || 0),
    byPart: {},
  };

  if (Array.isArray(summary?.byPart)) {
    for (const row of summary.byPart) {
      if (!row?.partCode) continue;
      normalized.byPart[row.partCode] = {
        consumedQty: Number(row.consumedQty || 0),
        sources: Array.isArray(row.sources) ? row.sources : [],
      };
    }
  } else if (summary?.byPart && typeof summary.byPart === "object") {
    for (const [partCode, value] of Object.entries(summary.byPart)) {
      normalized.byPart[partCode] = {
        consumedQty: Number(value?.consumedQty || 0),
        sources: Array.isArray(value?.sources) ? value.sources : [],
      };
    }
  }

  return normalized;
}

function parseLegacyNettingSummary(notes) {
  if (!notes || !notes.includes("NETTING_SUMMARY=")) return null;
  try {
    const jsonText = notes.slice(notes.indexOf("NETTING_SUMMARY=") + "NETTING_SUMMARY=".length);
    return JSON.parse(jsonText);
  } catch (parseErr) {
    console.warn(`[MRP Audit] Failed to parse legacy netting summary: ${parseErr.message}`);
    return null;
  }
}

function isWithinSoDemandTimeFence(targetDate, fenceConfig = {}) {
  const fenceDays = Math.max(Number(fenceConfig.days || 0), 0);
  const fenceHours = Math.max(Number(fenceConfig.hours || 0), 0);
  if (fenceDays <= 0 && fenceHours <= 0) return true;

  const dueDate = parseDate(targetDate);
  if (!dueDate) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const fenceDate = new Date(today);
  fenceDate.setDate(fenceDate.getDate() + fenceDays);
  fenceDate.setHours(fenceDate.getHours() + fenceHours);
  return dueDate <= fenceDate;
}

async function buildPlannedOrderPartnerMap(tx, partCodes) {
  const normalizedPartCodes = [...new Set((partCodes || []).map(normalizePartCode).filter(Boolean))];
  if (normalizedPartCodes.length === 0) return {};

  const parts = await tx.part.findMany({
    where: {
      partCode: { in: normalizedPartCodes },
      isDeleted: false,
    },
    select: {
      partCode: true,
      supplier: {
        select: {
          supplierCode: true,
          leadTimeDays: true,
        },
      },
      supplierItems: {
        where: { isActive: true },
        orderBy: [{ isPreferred: "desc" }, { priority: "asc" }],
        take: 1,
        select: {
          leadTimeDays: true,
          supplier: {
            select: {
              supplierCode: true,
              leadTimeDays: true,
            },
          },
        },
      },
      vendorPriceLists: {
        where: { isDeleted: false },
        orderBy: [{ pricingYear: "desc" }, { createdAt: "desc" }],
        take: 1,
        select: {
          vendor: {
            select: {
              vendorCode: true,
            },
          },
        },
      },
    },
  });

  return parts.reduce((acc, part) => {
    acc[part.partCode] = {
      supplierCode: part.supplierItems?.[0]?.supplier?.supplierCode || part.supplier?.supplierCode || null,
      leadTimeDays: Math.max(Number(
        part.supplierItems?.[0]?.leadTimeDays ??
        part.supplierItems?.[0]?.supplier?.leadTimeDays ??
        part.supplier?.leadTimeDays ??
        0
      ), 0),
      vendorCode: part.vendorPriceLists?.[0]?.vendor?.vendorCode || null,
    };
    return acc;
  }, {});
}

const OPEN_SO_HEADER_STATUSES = [
  "Confirmed",
  "In Progress",
  "In Production",
  "Ready to Deliver",
];

const OPEN_SO_DETAIL_STATUSES = [
  "Pending",
  "In Planning",
  "In Production",
];

async function buildOpenSoDemandByPart(tx, partCodes, cutoffDate) {
  const normalizedPartCodes = [...new Set((partCodes || []).map(normalizePartCode).filter(Boolean))];

  // Parse cutoff date - hanya fetch SO yang due date <= cutoff
  const whereDate = cutoffDate ? parseDate(cutoffDate) : null;
  if (cutoffDate && !whereDate) {
    // Invalid cutoff date
    console.warn(`[buildOpenSoDemandByPart] Invalid cutoffDate: ${cutoffDate}`);
    return {};
  }

  const soDetails = await tx.salesOrderDetail.findMany({
    where: {
      isDeleted: false,
      ...(normalizedPartCodes.length > 0 ? { partCode: { in: normalizedPartCodes } } : {}),
      status: { in: OPEN_SO_DETAIL_STATUSES },
      soHeader: {
        isDeleted: false,
        status: { in: OPEN_SO_HEADER_STATUSES },
      },
    },
    select: {
      soNumber: true,
      lineNumber: true,
      partCode: true,
      part: {
        select: { id: true },
      },
      uomCode: true,
      qty: true,
      qtyDelivered: true,
      deliveryDate: true,
      soHeader: {
        select: {
          soDate: true,
          deliveryDate: true,
        },
      },
    },
  });

  const demandByPart = {};

  for (const detail of soDetails) {
    const partCode = normalizePartCode(detail.partCode);
    if (!partCode) continue;

    const outstandingQty = Math.max(
      Number(detail.qty || 0) - Number(detail.qtyDelivered || 0),
      0,
    );
    if (outstandingQty <= 0) continue;

    const dueDate = parseDate(
      detail.deliveryDate || detail.soHeader?.deliveryDate || detail.soHeader?.soDate,
    );
    if (!dueDate) continue;
    if (whereDate && dueDate > whereDate) continue;

    if (!demandByPart[partCode]) {
      demandByPart[partCode] = [];
    }

    demandByPart[partCode].push({
      dueDate,
      remainingQty: outstandingQty,
      partId: detail.part?.id || null,
      uomCode: detail.uomCode || null,
      sourceNumber: `${detail.soNumber}#${detail.lineNumber}`,
    });
  }

  for (const bucket of Object.values(demandByPart)) {
    bucket.sort((a, b) => a.dueDate - b.dueDate);
  }

  return demandByPart;
}

function consumeSoDemandForPart(demandByPart, partCode, upToDate, targetQty, options = {}) {
  const code = normalizePartCode(partCode);
  const target = Number(targetQty || 0);
  if (!code || target <= 0) return { consumedQty: 0, sources: [] };

  const bucket = demandByPart[code] || [];
  if (bucket.length === 0) return { consumedQty: 0, sources: [] };

  const limitDate = upToDate ? parseDate(upToDate) : null;
  const canConsume = typeof options.canConsume === "function" ? options.canConsume : () => true;
  let remainingTarget = target;
  let consumedQty = 0;
  const sources = [];

  for (const row of bucket) {
    if (remainingTarget <= 0) break;
    if (row.remainingQty <= 0) continue;
    if (limitDate && row.dueDate > limitDate) continue;
    if (!canConsume(row)) continue;

    const used = Math.min(row.remainingQty, remainingTarget);
    if (used <= 0) continue;

    row.remainingQty -= used;
    remainingTarget -= used;
    consumedQty += used;
    sources.push(`${row.sourceNumber}:${used}`);
  }

  return { consumedQty, sources };
}

function explicitSalesOrderNumbersForMpsDetail(detail = {}) {
  return new Set((detail.demandSources || [])
    .filter((source) => String(source.sourceType || "").toUpperCase() === "SALES_ORDER")
    .map((source) => String(source.sourceNumber || "").trim())
    .filter(Boolean));
}

function consumeSalesOrdersAlreadyRepresentedByMps(demandByPart, mpsDetail, soDemandTimeFence) {
  if (mpsDetail._isBufferPhase) return { consumedQty: 0, sources: [] };
  const explicitSoNumbers = explicitSalesOrderNumbersForMpsDetail(mpsDetail);
  const phaseTargetQty = mpsDetail._deliveryPhaseId
    ? (mpsDetail.qtyPlanned == null
      ? Number.MAX_SAFE_INTEGER
      : Math.max(Number(mpsDetail.qtyPlanned || 0), 0))
    : Number.MAX_SAFE_INTEGER;
  return consumeSoDemandForPart(
    demandByPart,
    mpsDetail.partCode,
    explicitSoNumbers.size ? null : mpsDetail.endDate,
    phaseTargetQty,
    {
      canConsume: (row) => {
        const sourceNumber = String(row.sourceNumber || "").split("#")[0];
        if (explicitSoNumbers.size) return explicitSoNumbers.has(sourceNumber);
        return (
          (mpsDetail._deliveryPhaseId
            ? new Date(row.dueDate) <= new Date(mpsDetail.endDate)
            : planningMonthKey(row.dueDate) === planningMonthKey(mpsDetail.endDate))
          || isWithinSoDemandTimeFence(row.dueDate, soDemandTimeFence)
        );
      },
    },
  );
}

function parseSoConsumptionSource(source) {
  const match = String(source || "").match(/^(.*)#(\d+):([0-9.]+)$/);
  if (!match) return null;
  return {
    soNumber: match[1],
    lineNumber: Number(match[2]),
    qty: Number(match[3] || 0),
  };
}

async function resolveMbomLeadTimeDays(tx, mbomHeaderId) {
  if (!mbomHeaderId) return 0;

  const mbomHeader = await tx.mBOMHeader.findUnique({
    where: { id: mbomHeaderId },
    select: { noReg: true },
  });
  if (!mbomHeader?.noReg) return 0;

  const details = await tx.mBOMDetail.findMany({
    where: {
      noReg: mbomHeader.noReg,
      isDeleted: false,
    },
    select: { leadTime: true, leadTimeUnit: true },
  });
  return details.reduce((maximum, detail) => Math.max(maximum, durationToWorkingDays(detail.leadTime, detail.leadTimeUnit)), 0);
}

function collectRemainingSoDemandRows(openSoDemandByPart) {
  const rows = [];
  for (const [partCode, bucket] of Object.entries(openSoDemandByPart || {})) {
    for (const demand of bucket || []) {
      const remainingQty = Number(demand.remainingQty || 0);
      if (remainingQty <= 0) continue;
      rows.push({
        ...demand,
        partCode,
        remainingQty,
      });
    }
  }
  rows.sort((a, b) => a.dueDate - b.dueDate);
  return rows;
}

function collectSoPlanNumbersFromDemand(openSoDemandByPart) {
  const planNumbers = [];
  for (const bucket of Object.values(openSoDemandByPart || {})) {
    for (const demand of bucket || []) {
      const soNumber = String(demand.sourceNumber || "").split("#")[0];
      const planNumber = buildSoPlanNumber(soNumber);
      if (planNumber) planNumbers.push(planNumber);
    }
  }
  return [...new Set(planNumbers)];
}

async function upsertMrpPegging(tx, data) {
  const toNullableInt = (value) => {
    if (value === undefined || value === null || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const where = {
    demandType: data.demandType,
    demandNumber: data.demandNumber,
    demandLineNumber: toNullableInt(data.demandLineNumber),
    supplyType: data.supplyType,
    supplyNumber: data.supplyNumber,
    supplyLineNumber: toNullableInt(data.supplyLineNumber),
    itemId: data.itemId,
  };

  const updated = await tx.mRPPegging.updateMany({
    where,
    data: {
      qtyPegged: data.qtyPegged,
      status: "Active",
      notes: data.notes || null,
    },
  });

  if (updated.count === 0) {
    await tx.mRPPegging.create({
      data: {
        ...where,
        qtyPegged: data.qtyPegged,
        status: "Active",
        notes: data.notes || null,
      },
    });
  }
}

async function buildOpenSupplyMap(tx, partCodes, cutoffDate, options = {}) {
  const normalizedPartCodes = [...new Set((partCodes || []).map(normalizePartCode).filter(Boolean))];
  if (normalizedPartCodes.length === 0) return {};

  const whereDate = cutoffDate ? parseDate(cutoffDate) : null;
  const excludedRunNumbers = Array.isArray(options.excludeRunNumbers)
    ? options.excludeRunNumbers.filter(Boolean)
    : [];
  const excludedPlanNumbers = new Set(
    Array.isArray(options.excludePlanNumbers)
      ? options.excludePlanNumbers.filter(Boolean)
      : [],
  );
  const planningUomByPartCode = options.planningUomByPartCode || {};
  const kgPerQtyByPartCode = options.kgPerQtyByPartCode || {};
  const excludedSourceMpsNumbers = [...new Set([
    ...(Array.isArray(options.excludeSourceMpsNumbers) ? options.excludeSourceMpsNumbers : []),
    options.excludeSourceMpsNumber,
  ].map((value) => String(value || "").trim()).filter(Boolean))];

  const plannedOrderWhere = {
    partCode: { in: normalizedPartCodes },
    isDeleted: false,
    status: "Planned",
  };
  if (whereDate) {
    plannedOrderWhere.requiredDate = { lte: whereDate };
  }
  if (excludedRunNumbers.length > 0) {
    plannedOrderWhere.AND = [{ NOT: { runNumber: { in: excludedRunNumbers } } }];
  }

  const plannedOrders = await tx.plannedOrder.findMany({
    where: plannedOrderWhere,
    select: {
      orderNumber: true,
      runNumber: true,
      partCode: true,
      qty: true,
      uomCode: true,
      orderType: true,
      status: true,
      referenceType: true,
      referenceNumber: true,
      mrpRun: {
        select: { planNumber: true },
      },
    },
  });

  // Hanya firm MO yang dihitung sebagai scheduled receipt untuk FG in-house.
  // Status Completed tidak otomatis berarti fulfilled; netting tetap pakai sisa qty header MO.
  const manufacturingOrders = await tx.manufacturingOrder.findMany({
    where: {
      isDeleted: false,
      AND: [
        {
          OR: [
            { status: { in: ["Released", "In Progress", "Completed"] } },
            {
              status: "Draft",
              referenceType: { in: ["MRPPlannedOrder", "MonthlyProductionPlan"] },
            },
          ],
        },
        ...(whereDate
          ? [{ OR: [{ plannedEndDate: null }, { plannedEndDate: { lte: whereDate } }] }]
          : []),
      ],
      part: {
        partCode: { in: normalizedPartCodes },
      },
    },
    select: {
      moNumber: true,
      qtyPlanned: true,
      qtyProduced: true,
      qtyGood: true,
      qtyReject: true,
      part: {
        select: {
          partCode: true,
        },
      },
    },
  });

  const workOrders = await tx.workOrder.findMany({
    where: {
      isDeleted: false,
      isReworkOrder: false,
      status: { not: "Cancelled" },
      outputPartCode: { in: normalizedPartCodes },
      plannedQty: { gt: 0 },
      ...(whereDate ? { plannedDate: { lte: whereDate } } : {}),
    },
    select: {
      outputPartCode: true,
      plannedQty: true,
    },
  });

  const vendorProcessOrders = await tx.vendorProcessOrder.findMany({
    where: {
      isDeleted: false,
      isReworkOrder: false,
      status: { not: "Cancelled" },
      outputPartCode: { in: normalizedPartCodes },
      qtyPlanned: { gt: 0 },
      ...(whereDate
        ? {
            OR: [
              { dueDate: { lte: whereDate } },
              { dueDate: null, orderDate: { lte: whereDate } },
            ],
          }
        : {}),
    },
    select: {
      outputPartCode: true,
      qtyPlanned: true,
    },
  });
  // MPP hasil release planned order adalah firm production coverage sampai
  // qty-nya penuh dikonversi ke MO. Kalau tidak dihitung, MRP run ulang akan
  // membuat PMO baru untuk demand FG yang sama.
  const monthlyProductionPlanDetails = await tx.monthlyProductionPlanDetail.findMany({
    where: {
      isDeleted: false,
      partCode: { in: normalizedPartCodes },
      status: { in: ["Planned", "Partially Released"] },
      ...(excludedSourceMpsNumbers.length
        ? {
            AND: [{
              OR: [
                { plan: { sourceType: { notIn: excludedSourceMpsNumbers.map((value) => `MPS:${value}`) } } },
                { plan: { status: { in: ["Confirmed", "Released", "In Progress"] } } },
              ],
            }],
          }
        : {}),
      ...(whereDate
        ? {
            OR: [{ requiredDate: null }, { requiredDate: { lte: whereDate } }],
          }
        : {}),
      plan: {
        isDeleted: false,
        status: { not: "Cancelled" },
      },
    },
    select: {
      partCode: true,
      qtyPlanned: true,
      qtyReleased: true,
      plannedOrderNumber: true,
      createdAt: true,
    },
  });

  const purchaseRequisitionDetails = await tx.purchaseRequisitionDetail.findMany({
    where: {
      isDeleted: false,
      partCode: { in: normalizedPartCodes },
      pr: {
        isDeleted: false,
        status: { not: "Rejected" },
        ...(whereDate ? { requiredDate: { lte: whereDate } } : {}),
      },
    },
    select: {
      partCode: true,
      qty: true,
      orderedQty: true,
      uomCode: true,
      plannedOrderNumber: true,
      createdAt: true,
    },
  });

  // PO open qty dihitung dari qty order - qty received untuk dokumen yang sudah firm.
  const purchaseOrderDetails = await tx.purchaseOrderDetail.findMany({
    where: {
      isDeleted: false,
      partCode: { in: normalizedPartCodes },
      po: {
        isDeleted: false,
        status: { in: ["Approved", "Sent", "Confirmed", "Partial Receipt"] },
        ...(whereDate ? { deliveryDate: { lte: whereDate } } : {}),
      },
    },
    select: {
      partCode: true,
      qty: true,
      qtyReceived: true,
      uomCode: true,
      convertedPurchaseQty: true,
      conversionFactor: true,
      conversionUomCode: true,
    },
  });

  const supplyPartCodes = [...new Set([
    ...purchaseRequisitionDetails.map((row) => normalizePartCode(row.partCode)),
    ...purchaseOrderDetails.map((row) => normalizePartCode(row.partCode)),
  ].filter(Boolean))];
  const supplyParts = supplyPartCodes.length > 0
    ? await tx.part.findMany({
      where: { partCode: { in: supplyPartCodes }, isDeleted: false },
      select: {
        partCode: true,
        partBases: {
          select: { baseOn: true, grossWeight: true },
        },
      },
    })
    : [];
  const supplyPartByCode = new Map(supplyParts.map((part) => [normalizePartCode(part.partCode), part]));

  const plannedOrderMap = {};
  for (const row of plannedOrders) {
    if (!isUncommittedPlannedSupply(row)) continue;
    const planNumber = row.referenceNumber || row.mrpRun?.planNumber;
    if (planNumber && excludedPlanNumbers.has(planNumber)) continue;
    const partCode = normalizePartCode(row.partCode);
    upsertSupplyQty(plannedOrderMap, row.partCode, normalizePurchasingSupplyQty(row, {
      targetUomCode: planningUomByPartCode[partCode],
      kgPerQty: kgPerQtyByPartCode[partCode],
    }));
  }

  const moMap = {};
  for (const row of manufacturingOrders) {
    const remaining = resolveOpenManufacturingSupplyQty(row);
    upsertSupplyQty(moMap, row.part?.partCode, remaining);
  }

  const productionExecutionMap = {};
  for (const row of workOrders) {
    upsertSupplyQty(productionExecutionMap, row.outputPartCode, resolveFirmExecutionSupplyQty(row));
  }
  for (const row of vendorProcessOrders) {
    upsertSupplyQty(productionExecutionMap, row.outputPartCode, resolveFirmExecutionSupplyQty(row));
  }
  const mppMap = {};
  const mppPlannedOrderNumbers = [...new Set(monthlyProductionPlanDetails
    .map((row) => row.plannedOrderNumber)
    .filter(Boolean))];
  const mppPlannedOrders = mppPlannedOrderNumbers.length > 0
    ? await tx.plannedOrder.findMany({
      where: {
        orderNumber: { in: mppPlannedOrderNumbers },
        isDeleted: false,
      },
      select: { orderNumber: true, status: true, createdAt: true },
    })
    : [];
  const mppPlannedOrderByNumber = new Map(mppPlannedOrders.map((order) => [order.orderNumber, order]));

  for (const row of monthlyProductionPlanDetails) {
    if (!isValidLinkedMppSupply(row, mppPlannedOrderByNumber)) continue;
    const openQty = Math.max(Number(row.qtyPlanned || 0) - Number(row.qtyReleased || 0), 0);
    upsertSupplyQty(mppMap, row.partCode, openQty);
  }

  const prMap = {};
  const prPlannedOrderNumbers = [...new Set(purchaseRequisitionDetails
    .map((row) => row.plannedOrderNumber)
    .filter(Boolean))];
  const prPlannedOrders = prPlannedOrderNumbers.length > 0
    ? await tx.plannedOrder.findMany({
      where: {
        orderNumber: { in: prPlannedOrderNumbers },
        isDeleted: false,
      },
      select: { orderNumber: true, status: true, createdAt: true },
    })
    : [];
  const prPlannedOrderByNumber = new Map(prPlannedOrders.map((order) => [order.orderNumber, order]));

  for (const row of purchaseRequisitionDetails) {
    if (!isValidLinkedPrSupply(row, prPlannedOrderByNumber)) continue;
    const openQty = Math.max(
      normalizePurchasingSupplyQty({
        ...row,
        qty: Number(row.qty || 0) - Number(row.orderedQty || 0),
        part: supplyPartByCode.get(normalizePartCode(row.partCode)),
      }, {
        targetUomCode: planningUomByPartCode[normalizePartCode(row.partCode)],
        kgPerQty: kgPerQtyByPartCode[normalizePartCode(row.partCode)],
      }),
      0,
    );
    upsertSupplyQty(prMap, row.partCode, openQty);
  }

  const poMap = {};
  for (const row of purchaseOrderDetails) {
    const conversionFactor = Number(row.conversionFactor || 0);
    const usesPurchaseConversion = Number(row.convertedPurchaseQty || 0) > 0
      && conversionFactor > 0
      && normalizeUomCode(row.conversionUomCode);
    const remainingQty = usesPurchaseConversion
      ? Number(row.convertedPurchaseQty || 0) - (Number(row.qtyReceived || 0) * conversionFactor)
      : Number(row.qty || 0) - Number(row.qtyReceived || 0);
    const openQty = Math.max(
      normalizePurchasingSupplyQty({
        ...row,
        qty: remainingQty,
        uomCode: usesPurchaseConversion ? row.conversionUomCode : row.uomCode,
        part: supplyPartByCode.get(normalizePartCode(row.partCode)),
      }, {
        targetUomCode: planningUomByPartCode[normalizePartCode(row.partCode)],
        kgPerQty: kgPerQtyByPartCode[normalizePartCode(row.partCode)],
      }),
      0,
    );
    upsertSupplyQty(poMap, row.partCode, openQty);
  }

  return mergeQtyMaps(plannedOrderMap, moMap, productionExecutionMap, mppMap, prMap, poMap);
}

async function buildPurchasingSupplyTimeline(tx, requirements = [], cutoffDate, options = {}) {
  const partCodes = [...new Set(requirements.map((row) => normalizePartCode(row.partCode)).filter(Boolean))];
  if (!partCodes.length) return [];
  const cutoff = parseDate(cutoffDate) || new Date(Math.max(...requirements.map((row) => new Date(row.requiredDate).getTime())));
  const parts = await tx.part.findMany({
    where: { partCode: { in: partCodes }, isDeleted: false },
    select: {
      partCode: true, itemType: true, rawType: true, materialId: true,
      material: { select: { materialCode: true } },
      partBases: { select: { baseOn: true, grossWeight: true } },
    },
  });
  const partByCode = new Map(parts.map((part) => [normalizePartCode(part.partCode), part]));
  const materialIds = [...new Set(parts.map((part) => part.materialId).filter(Boolean))];
  const materialCodes = [...new Set(parts.map((part) => part.material?.materialCode).filter(Boolean))];
  const requirementByPart = new Map(requirements.map((row) => [normalizePartCode(row.partCode), row]));
  const requirementByMaterial = new Map(requirements.map((row) => {
    const part = partByCode.get(normalizePartCode(row.partCode));
    return [part?.materialId || part?.material?.materialCode, row];
  }).filter(([identity]) => identity));
  const identityWhere = {
    OR: [
      { partCode: { in: partCodes } },
      ...(materialIds.length ? [{ materialId: { in: materialIds } }] : []),
      ...(materialCodes.length ? [{ materialCode: { in: materialCodes } }] : []),
    ],
  };
  const [plannedOrders, prRows, poRows] = await Promise.all([
    tx.plannedOrder.findMany({
      where: {
        isDeleted: false, orderType: "Purchase", status: "Planned",
        partCode: { in: partCodes }, requiredDate: { lte: cutoff },
        ...(options.excludeRunNumber ? { runNumber: { not: options.excludeRunNumber } } : {}),
      },
      select: {
        orderNumber: true, runNumber: true, referenceType: true,
        partCode: true, qty: true, qtyReleased: true, uomCode: true, requiredDate: true,
      },
    }),
    tx.purchaseRequisitionDetail.findMany({
      where: { isDeleted: false, ...identityWhere, pr: { isDeleted: false, status: { not: "Rejected" }, requiredDate: { lte: cutoff } } },
      select: {
        id: true, prNumber: true, partCode: true, materialId: true, materialCode: true,
        qty: true, orderedQty: true, uomCode: true, convertedPurchaseQty: true,
        conversionFactor: true, conversionUomCode: true, plannedOrderNumber: true,
        pr: { select: { requiredDate: true, status: true } },
      },
    }),
    tx.purchaseOrderDetail.findMany({
      where: {
        isDeleted: false,
        po: { isDeleted: false, status: { in: ["Approved", "Sent", "Confirmed", "Partial Receipt"] } },
        AND: [
          identityWhere,
          { OR: [
            { deliveryDate: { lte: cutoff } },
            { deliveryDate: null, po: { deliveryDate: { lte: cutoff } } },
          ] },
        ],
      },
      select: {
        id: true, poNumber: true, partCode: true, materialId: true, materialCode: true,
        qty: true, qtyReceived: true, uomCode: true, convertedPurchaseQty: true,
        conversionFactor: true, conversionUomCode: true, deliveryDate: true,
        po: { select: { deliveryDate: true, status: true } },
      },
    }),
  ]);

  const resolveRequirement = (row) => requirementByPart.get(normalizePartCode(row.partCode))
    || requirementByMaterial.get(row.materialId || row.materialCode);
  const normalizeQty = (row, qty) => {
    const requirement = resolveRequirement(row);
    const part = partByCode.get(normalizePartCode(requirement?.partCode || row.partCode));
    const kgPerQty = resolveKgPerPcs(part).factor;
    return Math.max(normalizePurchasingSupplyQty({ ...row, qty, part }, {
      targetUomCode: requirement?.uomCode || options.uomCodeByPartCode?.[requirement?.partCode],
      kgPerQty,
    }), 0);
  };
  const events = [];
  const shiftedDate = (value, delayDays = 0) => {
    const result = new Date(value);
    result.setUTCDate(result.getUTCDate() + Math.max(Number(delayDays || 0), 0));
    return result;
  };
  for (const row of plannedOrders) {
    // A generated planned order is already committed to the demand/run that
    // created it. It is a recommendation, not unrestricted stock. Counting an
    // August MRP recommendation as free September supply silently steals it
    // from the August demand. Released execution is represented separately by
    // open PR/PO, while only genuinely manual/unscoped planned supply may enter
    // this timeline.
    if (!isUncommittedPlannedSupply(row)) continue;
    const requirement = resolveRequirement(row);
    if (!requirement) continue;
    const qty = normalizeQty(row, Number(row.qty || 0) - Number(row.qtyReleased || 0));
    if (qty > 0) events.push({ supplyKey: requirement._planningStockKey || normalizePartCode(requirement.partCode), partCode: requirement.partCode, qty, availableDate: row.requiredDate, confidence: "PLANNED", sourceType: "PLANNED_ORDER", sourceNumber: row.orderNumber });
  }
  for (const row of prRows) {
    const requirement = resolveRequirement(row);
    if (!requirement) continue;
    const qty = normalizeQty(row, Number(row.qty || 0) - Number(row.orderedQty || 0));
    if (qty > 0) events.push({ supplyKey: requirement._planningStockKey || normalizePartCode(requirement.partCode), partCode: requirement.partCode, qty, availableDate: row.pr.requiredDate, confidence: "PLANNED", sourceType: "PR", sourceNumber: row.prNumber, status: row.pr.status });
  }
  for (const row of poRows) {
    const requirement = resolveRequirement(row);
    if (!requirement) continue;
    const usesConversion = Number(row.convertedPurchaseQty || 0) > 0 && Number(row.conversionFactor || 0) > 0;
    const remaining = usesConversion
      ? Number(row.convertedPurchaseQty || 0) - Number(row.qtyReceived || 0) * Number(row.conversionFactor || 0)
      : Number(row.qty || 0) - Number(row.qtyReceived || 0);
    const qty = normalizeQty({ ...row, uomCode: usesConversion ? row.conversionUomCode : row.uomCode }, remaining);
    if (qty > 0) events.push({
      supplyKey: requirement._planningStockKey || normalizePartCode(requirement.partCode), partCode: requirement.partCode,
      qty, availableDate: shiftedDate(row.deliveryDate || row.po.deliveryDate, options.poDelayDays),
      confidence: ["Confirmed", "Partial Receipt"].includes(row.po.status) ? "FIRM" : "PROBABLE",
      sourceType: "PO", sourceNumber: row.poNumber, status: row.po.status,
    });
  }
  return events.sort((left, right) => new Date(left.availableDate) - new Date(right.availableDate));
}

async function buildOpenMppSupplyMap(tx, partCodes, cutoffDate, options = {}) {
  const normalizedPartCodes = [...new Set((partCodes || []).map(normalizePartCode).filter(Boolean))];
  if (normalizedPartCodes.length === 0) return {};

  const whereDate = cutoffDate ? new Date(cutoffDate) : null;
  const excludedSourceMpsNumbers = [...new Set([
    ...(Array.isArray(options.excludeSourceMpsNumbers) ? options.excludeSourceMpsNumbers : []),
    options.excludeSourceMpsNumber,
  ].map((value) => String(value || "").trim()).filter(Boolean))];
  const monthlyProductionPlanDetails = await tx.monthlyProductionPlanDetail.findMany({
    where: {
      isDeleted: false,
      partCode: { in: normalizedPartCodes },
      status: { in: ["Planned", "Partially Released"] },
      ...(excludedSourceMpsNumbers.length
        ? {
            AND: [{
              OR: [
                { plan: { sourceType: { notIn: excludedSourceMpsNumbers.map((value) => `MPS:${value}`) } } },
                { plan: { status: { in: ["Confirmed", "Released", "In Progress"] } } },
              ],
            }],
          }
        : {}),
      ...(whereDate
        ? {
            OR: [{ requiredDate: null }, { requiredDate: { lte: whereDate } }],
          }
        : {}),
      plan: {
        isDeleted: false,
        status: { not: "Cancelled" },
      },
    },
    select: {
      partCode: true,
      qtyPlanned: true,
      qtyReleased: true,
      plannedOrderNumber: true,
      createdAt: true,
    },
  });

  const plannedOrderNumbers = [...new Set(monthlyProductionPlanDetails
    .map((row) => row.plannedOrderNumber)
    .filter(Boolean))];
  const plannedOrders = plannedOrderNumbers.length > 0
    ? await tx.plannedOrder.findMany({
      where: {
        orderNumber: { in: plannedOrderNumbers },
        isDeleted: false,
      },
      select: { orderNumber: true, status: true, createdAt: true },
    })
    : [];
  const plannedOrderByNumber = new Map(plannedOrders.map((order) => [order.orderNumber, order]));

  const mppMap = {};
  for (const row of monthlyProductionPlanDetails) {
    if (!isValidLinkedMppSupply(row, plannedOrderByNumber)) continue;
    const openQty = Math.max(Number(row.qtyPlanned || 0) - Number(row.qtyReleased || 0), 0);
    upsertSupplyQty(mppMap, row.partCode, openQty);
  }
  return mppMap;
}

async function buildOpenMoSupplyMap(tx, partCodes, cutoffDate) {
  const normalizedPartCodes = [...new Set((partCodes || []).map(normalizePartCode).filter(Boolean))];
  if (normalizedPartCodes.length === 0) return {};

  const whereDate = cutoffDate ? new Date(cutoffDate) : null;
  const manufacturingOrders = await tx.manufacturingOrder.findMany({
    where: {
      isDeleted: false,
      AND: [
        {
          OR: [
            { status: { in: ["Released", "In Progress", "Completed"] } },
            {
              status: "Draft",
              referenceType: { in: ["MRPPlannedOrder", "MonthlyProductionPlan"] },
            },
          ],
        },
        ...(whereDate
          ? [{ OR: [{ plannedEndDate: null }, { plannedEndDate: { lte: whereDate } }] }]
          : []),
      ],
      part: {
        partCode: { in: normalizedPartCodes },
      },
    },
    select: {
      qtyPlanned: true,
      qtyProduced: true,
      qtyGood: true,
      qtyReject: true,
      plannedOrderNumber: true,
      createdAt: true,
      part: {
        select: {
          partCode: true,
        },
      },
    },
  });

  const plannedOrderNumbers = [...new Set(manufacturingOrders
    .map((row) => row.plannedOrderNumber)
    .filter(Boolean))];
  const plannedOrders = plannedOrderNumbers.length > 0
    ? await tx.plannedOrder.findMany({
      where: {
        orderNumber: { in: plannedOrderNumbers },
        isDeleted: false,
      },
      select: { orderNumber: true, status: true, createdAt: true },
    })
    : [];
  const plannedOrderByNumber = new Map(plannedOrders.map((order) => [order.orderNumber, order]));

  const moMap = {};
  for (const row of manufacturingOrders) {
    if (!isValidLinkedMoSupply(row, plannedOrderByNumber)) continue;
    upsertSupplyQty(moMap, row.part?.partCode, resolveOpenManufacturingSupplyQty(row));
  }
  return moMap;
}

// ============================================
// GENERATE RUN NUMBER
// ============================================
exports.generateNumber = async (req, res, next) => {
  try {
    const planningMonth = String(req.query.planningMonth || req.query.planningAnchorMonth || new Date().toISOString().slice(0, 7));
    res.json({ ...(await nextMonthlyMrpIdentity(prisma, planningMonth)), planningMonth });
  } catch (e) {
    next(e);
  }
};

// ============================================
// LIST MRP RUNS
// ============================================
exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      status,
      mpsNumber,
      includeRevisions,
      isCurrentPlan,
      dateFrom,
      dateTo,
      page = 1,
      limit = 20,
    } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;

    if (isCurrentPlan !== undefined) {
      where.isCurrentPlan = isCurrentPlan === "true";
    } else if (includeRevisions !== "true") {
      where.isCurrentPlan = true;
    }

    if (mpsNumber) {
      where.mpsNumber = mpsNumber;
    }

    if (dateFrom || dateTo) {
      where.runDate = {};
      if (dateFrom) where.runDate.gte = parseDate(dateFrom);
      if (dateTo) where.runDate.lte = parseDate(dateTo);
    }

    if (q) {
      where.OR = [
        { runNumber: { contains: q, mode: "insensitive" } },
        { planNumber: { contains: q, mode: "insensitive" } },
        { mpsNumber: { contains: q, mode: "insensitive" } },
        { notes: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query) || { runDate: "desc" };
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.mRPRun.findMany({
        where,
        include: {
          mps: {
            select: {
              mpsNumber: true,
              mpsName: true,
              periodStart: true,
              periodEnd: true,
            },
          },
          _count: {
            select: {
              requirements: true,
              plannedOrders: true,
            },
          },
        },
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.mRPRun.count({ where }),
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

// ============================================
// GET MRP RUN BY NUMBER
// ============================================
function buildMPlusOneInventoryNettingItem(detail = {}, inventory = {}) {
  const efdMPlusOne = roundPlanningQty(Math.max(Number(detail.forecastQty || 0), 0));
  const inventoryStockQty = roundPlanningQty(Math.max(Number(inventory.onHandQty || 0), 0));
  const reservedStockQty = roundPlanningQty(Math.max(Number(inventory.reservedQty || 0), 0));
  const freeStockQty = roundPlanningQty(Math.max(Number(inventory.freeQty || 0), 0));
  const stockCoverageQty = roundPlanningQty(Math.min(efdMPlusOne, inventoryStockQty));
  const targetEndingBufferMPlusOne = roundPlanningQty(Math.max(
    Number(detail.targetEndingStockQty || detail.bufferQty || 0),
    0,
  ));

  return {
    partCode: detail.partCode,
    efdMPlusOne,
    inventoryStockQty,
    reservedStockQty,
    freeStockQty,
    stockCoverageQty,
    netDemandOnly: roundPlanningQty(Math.max(efdMPlusOne - inventoryStockQty, 0)),
    targetEndingBufferMPlusOne,
    netWithMPlusTwoBuffer: roundPlanningQty(Math.max(
      efdMPlusOne + targetEndingBufferMPlusOne - inventoryStockQty,
      0,
    )),
  };
}

async function buildMPlusOneOptionContext(mrpRun) {
  if (!mrpRun?.mpsNumber || !mrpRun?.mps?.periodStart) {
    return { available: false, message: "Source MPS official tidak tersedia." };
  }
  const periodStart = new Date(mrpRun.mps.periodStart);
  const horizonEnd = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 3, 1));
  const documents = await prisma.mPS.findMany({
    where: {
      isDeleted: false,
      status: { notIn: ["Superseded", "Cancelled"] },
      periodStart: { gte: periodStart, lt: horizonEnd },
    },
    orderBy: { periodStart: "asc" },
    select: {
      mpsNumber: true,
      revision: true,
      status: true,
      forecastNumber: true,
      periodStart: true,
      periodEnd: true,
      details: {
        where: { isDeleted: false, status: { not: "Cancelled" }, notes: { not: { startsWith: GENERATED_MPS_CHILD_NOTE_PREFIX } } },
        select: {
          id: true,
          partCode: true,
          forecastQty: true,
          bufferQty: true,
          targetEndingStockQty: true,
          projectedEndingStockQty: true,
          firmScheduledReceiptQty: true,
          demandSources: {
            select: {
              sourceType: true,
              sourceNumber: true,
              forecastDetail: {
                select: {
                  forecastNumber: true,
                  forecast: { select: { version: true, revisionNumber: true, status: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  const official = documents.find((row) => row.mpsNumber === mrpRun.mpsNumber) || documents[0];
  const lookahead = documents.find((row) => new Date(row.periodStart) > new Date(official?.periodStart || periodStart));
  if (!official || !lookahead) {
    return { available: false, message: "MPS M+1 belum tersedia pada planning cycle ini." };
  }
  const lookaheadPartCodes = [...new Set(lookahead.details.map((row) => normalizePartCode(row.partCode)).filter(Boolean))];
  const stockRows = lookaheadPartCodes.length ? await prisma.stockBalance.findMany({
    where: {
      AND: [
        { partCode: { in: lookaheadPartCodes }, isDeleted: false },
        buildExcludeSpecialRackCondition(),
      ],
    },
    select: {
      partCode: true,
      qtyOnHand: true,
      qtyReserved: true,
      qtyQC: true,
      qtyAvailable: true,
    },
  }) : [];
  const inventoryByPart = stockRows.reduce((map, row) => {
    const partCode = normalizePartCode(row.partCode);
    const current = map.get(partCode) || { onHandQty: 0, reservedQty: 0, freeQty: 0 };
    current.onHandQty += Number(row.qtyOnHand || 0);
    current.reservedQty += Number(row.qtyReserved || 0);
    current.freeQty += row.qtyAvailable == null
      ? Math.max(Number(row.qtyOnHand || 0) - Number(row.qtyReserved || 0) - Number(row.qtyQC || 0), 0)
      : Math.max(Number(row.qtyAvailable || 0), 0);
    map.set(partCode, current);
    return map;
  }, new Map());
  const items = lookahead.details.map((row) => {
    const netting = buildMPlusOneInventoryNettingItem(
      row,
      inventoryByPart.get(normalizePartCode(row.partCode)) || {},
    );
    const forecastSources = [...new Map(row.demandSources.flatMap((source) => {
      const numberValue = source.forecastDetail?.forecastNumber || (String(source.sourceType || "").toUpperCase() === "FORECAST" ? source.sourceNumber : null);
      if (!numberValue) return [];
      return [[numberValue, {
        forecastNumber: numberValue,
        version: source.forecastDetail?.forecast?.version ?? null,
        revisionNumber: source.forecastDetail?.forecast?.revisionNumber ?? null,
        status: source.forecastDetail?.forecast?.status || null,
      }]];
    })).values()];
    return {
      ...netting,
      forecastSources,
    };
  });
  const sum = (field) => roundPlanningQty(items.reduce((total, row) => total + Number(row[field] || 0), 0));
  const forecastSources = [...new Map(items.flatMap((row) => row.forecastSources).map((row) => [row.forecastNumber, row])).values()];
  return {
    available: true,
    officialMpsNumber: official.mpsNumber,
    officialMpsRevision: official.revision,
    sourceMpsNumber: lookahead.mpsNumber,
    sourceMpsRevision: lookahead.revision,
    sourceMpsStatus: lookahead.status,
    periodStart: lookahead.periodStart,
    periodEnd: lookahead.periodEnd,
    forecastSources,
    itemCount: items.length,
    items,
    totals: {
      efdMPlusOne: sum("efdMPlusOne"),
      inventoryStockQty: sum("inventoryStockQty"),
      reservedStockQty: sum("reservedStockQty"),
      freeStockQty: sum("freeStockQty"),
      stockCoverageQty: sum("stockCoverageQty"),
      targetEndingBufferMPlusOne: sum("targetEndingBufferMPlusOne"),
      netDemandOnly: sum("netDemandOnly"),
      netWithMPlusTwoBuffer: sum("netWithMPlusTwoBuffer"),
    },
  };
}

function resolveMPlusOnePreviewBasisQty(optionItem = {}, mode = "NET_CURRENT_STOCK") {
  const normalizedMode = String(mode || "NET_CURRENT_STOCK").trim().toUpperCase();
  const field = normalizedMode === "FULL_EFD" ? "efdMPlusOne" : "netDemandOnly";
  return roundPlanningQty(Math.max(Number(optionItem?.[field] || 0), 0));
}

function enrichMPlusOnePreviewDisplayQty(requirements = [], optionContext = {}) {
  const optionItems = Array.isArray(optionContext?.items) ? optionContext.items : [];
  const optionsByPart = new Map(optionItems.map((item) => [normalizePartCode(item.partCode), item]));
  const fallbackOption = optionContext?.totals || {};

  return requirements.map((row) => {
    const planningPartCode = normalizePartCode(
      row.planningPartCode
      || row.fgPartCode
      || row.mpsDetail?.partCode,
    );
    const optionItem = optionsByPart.get(planningPartCode) || fallbackOption;
    const fullBasisQty = resolveMPlusOnePreviewBasisQty(optionItem, "FULL_EFD");
    const coveredBasisQty = resolveMPlusOnePreviewBasisQty(optionItem, "NET_AFTER_M_COVERAGE");
    // forecastQty on a dependent requirement retains the theoretical BOM
    // explosion per delivery phase even when parent WIP makes authoritative
    // gross/net zero. It is therefore the safe read-only basis for look-ahead.
    const fullGrossQty = roundPlanningQty(Math.max(Number(row.forecastQty ?? row.grossRequirement ?? 0), 0));
    const deliveryRequirementQty = roundPlanningQty(Math.max(Number(row.grossRequirement ?? fullGrossQty), 0));
    const inventoryStockQty = roundPlanningQty(Math.max(Number(row.onHandQty || 0), 0));
    const reservedStockQty = roundPlanningQty(Math.max(Number(row.allocatedQty || 0), 0));
    const freeStockQty = roundPlanningQty(Math.max(inventoryStockQty - reservedStockQty, 0));
    const actualNetQty = roundPlanningQty(Math.max(Number(row.netRequirement || 0), 0));
    const stockUsedQty = roundPlanningQty(Math.max(deliveryRequirementQty - actualNetQty, 0));

    return {
      ...row,
      mPlusOneFullEfdBasisQty: fullBasisQty,
      mPlusOneCoveredBasisQty: coveredBasisQty,
      mPlusOneCoverageQty: roundPlanningQty(Math.max(fullBasisQty - coveredBasisQty, 0)),
      mPlusOneFullEfdGrossQty: fullGrossQty,
      mPlusOneCoveredGrossQty: actualNetQty,
      mPlusOneDeliveryRequirementQty: deliveryRequirementQty,
      mPlusOneInventoryStockQty: inventoryStockQty,
      mPlusOneReservedStockQty: reservedStockQty,
      mPlusOneFreeStockQty: freeStockQty,
      mPlusOneStockUsedQty: stockUsedQty,
      mPlusOneNetRequirementQty: actualNetQty,
      mPlusOneActualNetPurchaseQty: actualNetQty,
    };
  });
}

async function enrichMPlusOnePreviewRequirements(tx, requirements = [], optionContext = {}, services = {}) {
  const qtyEnricher = services.qty || enrichRequirementQtyBreakdown;
  const supplyEnricher = services.supply || enrichRequirementSupplyBreakdown;
  const displayEnricher = services.display || enrichMPlusOnePreviewDisplayQty;
  const groupEnricher = services.group || enrichRequirementPlanningGroups;
  const withQty = await qtyEnricher(tx, requirements);
  // Preview M+1 must use the same live warehouse/WIP provenance as official
  // requirements. Without this step a covered CLAMP row rendered stock 0.
  const withSupply = await supplyEnricher(tx, withQty);
  return groupEnricher(displayEnricher(withSupply, optionContext));
}

exports.get = async (req, res, next) => {
  try {
    const { runNumber } = req.params;

    const mrpRun = await findRunByNumberOrCurrentPlan(runNumber, {
        mps: true,
        requirements: {
          where: { isDeleted: false, orderType: "Purchase" },
          orderBy: [{ levelMBOM: "asc" }, { requiredDate: "asc" }],
          include: {
            part: {
              select: {
                partCode: true,
                partNumber: true,
                partName: true,
                itemType: true,
                rawType: true,
                material: {
                  select: {
                    materialCode: true,
                    materialName: true,
                    materialForm: true,
                    defaultPurchaseUomCode: true,
                    defaultConversionUomCode: true,
                    defaultConversionFactor: true,
                  },
                },
              },
            },
            mbomDetail: {
              select: {
                id: true,
                noReg: true,
                qty: true,
                uomCode: true,
                grossWeight: true,
                category: true,
                mbomHeader: {
                  select: {
                    noReg: true,
                    part: { select: { partCode: true, partNumber: true, partName: true } },
                  },
                },
                parentDetail: {
                  select: {
                    id: true,
                    part: { select: { partCode: true, partNumber: true, partName: true } },
                    mbomProcesses: {
                      where: { isDeleted: false },
                      orderBy: [{ sequence: "asc" }],
                      select: {
                        sequence: true,
                        occurrenceCode: true,
                        routingMode: true,
                        process: { select: { processCode: true, processName: true } },
                      },
                    },
                  },
                },
                mbomProcesses: {
                  where: { isDeleted: false },
                  orderBy: [{ sequence: "asc" }],
                  select: {
                    sequence: true,
                    occurrenceCode: true,
                    routingMode: true,
                    process: { select: { processCode: true, processName: true } },
                  },
                },
              },
            },
            mpsDetail: { select: { partCode: true, customerCode: true, startDate: true, endDate: true, fgRequiredDate: true, part: { select: { partCode: true, partNumber: true, partName: true } } } },
          },
        },
        plannedOrders: {
          where: { isDeleted: false, orderType: "Purchase" },
          orderBy: [{ orderDate: "asc" }],
        },
    });

    if (!mrpRun) {
      return res.status(404).json({ message: "MRP Run tidak ditemukan" });
    }

    // Flat tree used by the UI formula audit. The main table remains limited
    // to purchase requirements, while this trace also carries production and
    // intermediate levels that explain why a lower-level qty was reduced.
    const requirementTrace = await prisma.mRPRequirement.findMany({
      where: { runNumber: mrpRun.runNumber, isDeleted: false },
      orderBy: [{ levelMBOM: "asc" }, { treePath: "asc" }, { requiredDate: "asc" }],
      select: {
        id: true,
        parentRequirementId: true,
        rootRequirementId: true,
        treePath: true,
        levelMBOM: true,
        partCode: true,
        requirementType: true,
        sourceType: true,
        sourceNumber: true,
        requiredDate: true,
        parentRequiredDate: true,
        materialRequiredDate: true,
        productionRequiredDate: true,
        orderDate: true,
        grossRequirement: true,
        onHandQty: true,
        allocatedQty: true,
        firmSupplyQty: true,
        atRiskSupplyQty: true,
        supplyTimeline: true,
        netRequirement: true,
        plannedOrderQty: true,
        adjustedOrderQty: true,
        orderType: true,
        procurementWindow: true,
        mpsDetailId: true,
        customerCode: true,
        fgPartCode: true,
        targetDeliveryDate: true,
        deliveryTargetId: true,
        mpsDetail: { select: { partCode: true, customerCode: true, startDate: true, endDate: true, fgRequiredDate: true, part: { select: { partCode: true, partNumber: true, partName: true } } } },
        part: { select: { partCode: true, partNumber: true, partName: true, itemType: true, rawType: true, baseUomCode: true, productionUomCode: true, stockUomCode: true } },
        mbomDetail: {
          select: {
            qty: true,
            uomCode: true,
            category: true,
            grossWeight: true,
            mbomHeader: {
              select: {
                noReg: true,
                part: { select: { partCode: true, partNumber: true, partName: true } },
              },
            },
            parentDetail: {
              select: {
                id: true,
                part: { select: { partCode: true, partNumber: true, partName: true } },
                mbomProcesses: {
                  where: { isDeleted: false },
                  orderBy: [{ sequence: "asc" }],
                  select: {
                    sequence: true,
                    occurrenceCode: true,
                    routingMode: true,
                    process: { select: { processCode: true, processName: true } },
                  },
                },
              },
            },
            mbomProcesses: {
              where: { isDeleted: false },
              orderBy: [{ sequence: "asc" }],
              select: {
                sequence: true,
                occurrenceCode: true,
                routingMode: true,
                process: { select: { processCode: true, processName: true } },
              },
            },
          },
        },
      },
    });

    // Older runs persisted only the root Production requirement. Reconstruct
    // their intermediate production netting from the generated MPS schedule
    // and the exact MBOM parent-detail edges, so WIP reductions remain visible
    // without rewriting historical planning documents.
    const generatedMpsDetails = await prisma.mPSDetail.findMany({
      where: {
        mpsNumber: mrpRun.mpsNumber,
        isDeleted: false,
        notes: { contains: `Generated from ${mrpRun.runNumber}` },
      },
      select: { id: true, partId: true, partCode: true, qtyPlanned: true, notes: true },
    });
    const generatedPartIds = [...new Set(generatedMpsDetails.map((row) => row.partId).filter(Boolean))];
    const generatedEdges = generatedPartIds.length ? await prisma.mBOMDetail.findMany({
      where: { partId: { in: generatedPartIds }, isDeleted: false },
      orderBy: [{ updatedAt: "desc" }],
      select: {
        id: true,
        partId: true,
        qty: true,
        uomCode: true,
        levelComponent: true,
        noReg: true,
        parentDetail: { select: { part: { select: { partCode: true, partName: true } } } },
        mbomHeader: { select: { part: { select: { partCode: true, partName: true } } } },
      },
    }) : [];
    const rootProductionRows = requirementTrace.filter((row) => row.orderType === "Production" && Number(row.levelMBOM || 0) === 0);
    const scheduleBySourceAndPart = new Map();
    for (const root of rootProductionRows) {
      scheduleBySourceAndPart.set(`${root.mpsDetailId}|${root.partCode}`, Number(root.netRequirement || 0));
    }
    for (const row of generatedMpsDetails) {
      const sourceId = String(row.notes || "").match(/\[MPS-SOURCE:([^\]]+)\]/)?.[1];
      if (!sourceId) continue;
      const key = `${sourceId}|${row.partCode}`;
      scheduleBySourceAndPart.set(key, Number(scheduleBySourceAndPart.get(key) || 0) + Number(row.qtyPlanned || 0));
    }
    const edgeBySourceAndPart = new Map();
    for (const row of generatedMpsDetails) {
      const sourceId = String(row.notes || "").match(/\[MPS-SOURCE:([^\]]+)\]/)?.[1];
      if (!sourceId) continue;
      const candidates = generatedEdges.filter((edge) => edge.partId === row.partId);
      const edge = candidates.find((candidate) => {
        const parentCode = candidate.parentDetail?.part?.partCode || candidate.mbomHeader?.part?.partCode;
        return scheduleBySourceAndPart.has(`${sourceId}|${parentCode}`);
      });
      if (edge) edgeBySourceAndPart.set(`${sourceId}|${row.partCode}`, edge);
    }
    const productionScheduleTrace = generatedMpsDetails.map((row) => {
      const sourceId = String(row.notes || "").match(/\[MPS-SOURCE:([^\]]+)\]/)?.[1];
      const edge = edgeBySourceAndPart.get(`${sourceId}|${row.partCode}`);
      const parentPart = edge?.parentDetail?.part || edge?.mbomHeader?.part || null;
      const parentQty = parentPart ? Number(scheduleBySourceAndPart.get(`${sourceId}|${parentPart.partCode}`) || 0) : 0;
      const ratio = Number(edge?.qty || 1);
      const grossRequirement = parentQty > 0 ? parentQty * ratio : Number(row.qtyPlanned || 0);
      const netRequirement = Number(row.qtyPlanned || 0);
      return {
        id: `mps-trace:${row.id}`,
        mpsDetailId: sourceId || null,
        partCode: row.partCode,
        parentPartCode: parentPart?.partCode || null,
        parentPartName: parentPart?.partName || null,
        levelMBOM: Number(edge?.levelComponent || 0),
        grossRequirement,
        netRequirement,
        plannedOrderQty: netRequirement,
        adjustedOrderQty: netRequirement,
        orderType: "Production",
        mbomDetail: edge ? { qty: ratio, uomCode: edge.uomCode, noReg: edge.noReg } : null,
      };
    });
    const absoluteLevelBySourceAndPart = new Map(rootProductionRows.map((row) => [`${row.mpsDetailId}|${row.partCode}`, 0]));
    for (let pass = 0; pass <= productionScheduleTrace.length; pass += 1) {
      let changed = false;
      for (const row of productionScheduleTrace) {
        const key = `${row.mpsDetailId}|${row.partCode}`;
        if (absoluteLevelBySourceAndPart.has(key) || !row.parentPartCode) continue;
        const parentLevel = absoluteLevelBySourceAndPart.get(`${row.mpsDetailId}|${row.parentPartCode}`);
        if (parentLevel == null) continue;
        row.levelMBOM = parentLevel + 1;
        absoluteLevelBySourceAndPart.set(key, row.levelMBOM);
        changed = true;
      }
      if (!changed) break;
    }

    const requirementsWithQtyBreakdown = await enrichRequirementQtyBreakdown(
      prisma,
      mrpRun.requirements,
    );
    const requirementsWithSupplyBreakdown = await enrichRequirementSupplyBreakdown(
      prisma,
      requirementsWithQtyBreakdown,
    );
    let groupedRequirements = enrichRequirementPlanningGroups(requirementsWithSupplyBreakdown);
    const sourceMpsDetailIds = [...new Set(groupedRequirements.map((row) => row.mpsDetailId).filter(Boolean))];
    const sourceMpsDetailRows = sourceMpsDetailIds.length ? await prisma.mPSDetail.findMany({
      where: { id: { in: sourceMpsDetailIds }, isDeleted: false },
      select: {
        id: true,
        mpsNumber: true,
        demandSources: {
          select: {
            sourceType: true,
            sourceNumber: true,
            sourceLineId: true,
            forecastDetailId: true,
            customerCode: true,
            qty: true,
            uomCode: true,
            requiredDate: true,
            effectiveRequiredDate: true,
            sourcePegging: true,
          },
        },
        mps: { select: { forecastNumber: true, revision: true } },
      },
    }) : [];
    const sourceDetailById = new Map(sourceMpsDetailRows.map((row) => [row.id, row]));
    const deliveryTargetIds = [...new Set(groupedRequirements.flatMap((row) => {
      const pegging = Array.isArray(row.customerPegging) ? row.customerPegging : [];
      return [row.deliveryTargetId, ...pegging.map((item) => item.deliveryTargetId)].filter(Boolean);
    }))];
    const deliveryPlanRows = deliveryTargetIds.length ? await prisma.mPSDeliveryPlan.findMany({
      where: { sourceDeliveryTargetId: { in: deliveryTargetIds }, isDeleted: false, status: { not: "Cancelled" } },
      select: { sourceDeliveryTargetId: true, phaseNumber: true, fgFinishSplitNumber: true, plannedDate: true, fgRequiredDate: true },
    }) : [];
    const deliveryPlanByTarget = new Map(deliveryPlanRows.map((row) => [row.sourceDeliveryTargetId, row]));
    groupedRequirements = groupedRequirements.map((row) => {
      const sourceDetail = sourceDetailById.get(row.mpsDetailId);
      const fallbackReferences = (sourceDetail?.demandSources || []).map((source) => ({
        sourceType: source.sourceType,
        sourceNumber: source.sourceNumber,
        sourceLineId: source.sourceLineId,
        forecastDetailId: source.forecastDetailId,
        customerCode: source.customerCode,
        qty: Number(source.qty || 0),
        uomCode: source.uomCode,
        requiredDate: source.effectiveRequiredDate || source.requiredDate,
      }));
      const persistedPegging = Array.isArray(row.customerPegging) ? row.customerPegging : [];
      const customerPegging = persistedPegging.map((peg) => {
        const deliveryPlan = deliveryPlanByTarget.get(peg.deliveryTargetId || row.deliveryTargetId);
        return {
          ...peg,
          deliveryPhaseNumber: peg.deliveryPhaseNumber || peg.phaseNumber || deliveryPlan?.fgFinishSplitNumber || deliveryPlan?.phaseNumber || null,
          phaseLabel: peg.phaseLabel || (deliveryPlan ? `Phase ${deliveryPlan.fgFinishSplitNumber || deliveryPlan.phaseNumber}` : null),
          referenceSources: Array.isArray(peg.referenceSources) && peg.referenceSources.length
            ? peg.referenceSources
            : fallbackReferences,
          mpsNumber: sourceDetail?.mpsNumber || row.sourceNumber || null,
          mpsRevision: sourceDetail?.mps?.revision ?? null,
        };
      });
      return { ...row, customerPegging };
    });
    const plannedOrdersWithQtyBreakdown = await enrichPlannedOrderQtyBreakdown(
      prisma,
      mrpRun.plannedOrders,
    );
    const enrichedPlannedOrders = await enrichPlannedOrderDisplay(
      prisma,
      plannedOrdersWithQtyBreakdown,
    );
    const releasedOrderNumbers = enrichedPlannedOrders.map((row) => row.orderNumber).filter(Boolean);
    const prLinks = releasedOrderNumbers.length ? await prisma.purchaseRequisitionDetail.findMany({
      where: {
        isDeleted: false,
        pr: { isDeleted: false },
        OR: [
          { plannedOrderNumber: { in: releasedOrderNumbers } },
          { sourcePlannedOrderNumbers: { not: Prisma.DbNull } },
        ],
      },
      select: {
        id: true,
        plannedOrderNumber: true,
        sourcePlannedOrderNumbers: true,
        prNumber: true,
        qty: true,
        orderedQty: true,
        uomCode: true,
        pr: { select: { status: true } },
        poDetails: {
          where: { isDeleted: false, po: { isDeleted: false, status: { not: "Cancelled" } } },
          select: {
            id: true, poNumber: true, qty: true, qtyReceived: true, uomCode: true, deliveryDate: true,
            po: { select: { status: true, supplierCode: true, supplierName: true, deliveryDate: true } },
          },
        },
      },
    }) : [];
    const releasedOrderSet = new Set(releasedOrderNumbers);
    const prByPlannedOrder = new Map();
    for (const row of prLinks) {
      const sourceNumbers = Array.isArray(row.sourcePlannedOrderNumbers)
        ? row.sourcePlannedOrderNumbers
        : [];
      for (const orderNumber of [row.plannedOrderNumber, ...sourceNumbers].filter(Boolean)) {
        if (releasedOrderSet.has(orderNumber)) {
          const current = prByPlannedOrder.get(orderNumber) || [];
          current.push({
            prDetailId: row.id,
            prNumber: row.prNumber,
            status: row.pr.status,
            requestedQty: Number(row.qty || 0),
            orderedQty: Number(row.orderedQty || 0),
            uomCode: row.uomCode,
            purchaseOrders: row.poDetails.map((detail) => ({
              poDetailId: detail.id,
              poNumber: detail.poNumber,
              status: detail.po.status,
              supplierCode: detail.po.supplierCode,
              supplierName: detail.po.supplierName,
              orderedQty: Number(detail.qty || 0),
              receivedQty: Number(detail.qtyReceived || 0),
              outstandingQty: Math.max(Number(detail.qty || 0) - Number(detail.qtyReceived || 0), 0),
              uomCode: detail.uomCode,
              deliveryDate: detail.deliveryDate || detail.po.deliveryDate,
            })),
          });
          prByPlannedOrder.set(orderNumber, current);
        }
      }
    }
    const purchaseSuggestion = await prisma.purchaseSuggestion.findFirst({
      where: { runNumber: mrpRun.runNumber, isDeleted: false, status: { not: "Cancelled" } },
      orderBy: { createdAt: "desc" },
      select: { suggestionNumber: true, status: true, updatedAt: true },
    });
    const scenarioRuns = mrpRun.mpsNumber ? await prisma.mRPRun.findMany({
      where: { mpsNumber: mrpRun.mpsNumber, isDeleted: false, status: "Completed" },
      orderBy: [{ runDate: "desc" }],
      take: 12,
      select: {
        runNumber: true, runDate: true, scenarioKey: true, scenarioName: true, scenarioStatus: true, scenarioAssumptions: true, isCurrentPlan: true,
        requirements: {
          where: { isDeleted: false, orderType: "Purchase" },
          select: { grossRequirement: true, netRequirement: true, firmNetRequirement: true, atRiskSupplyQty: true, procurementWindow: true },
        },
      },
    }) : [];
    const scenarioComparison = scenarioRuns.map((run) => ({
      runNumber: run.runNumber,
      runDate: run.runDate,
      scenarioKey: run.scenarioKey,
      scenarioName: run.scenarioName || (["SIMULATION", "SIMULATED"].includes(run.scenarioStatus) ? run.scenarioKey : "Baseline"),
      scenarioStatus: run.scenarioStatus,
      scenarioAssumptions: run.scenarioAssumptions,
      isCurrentPlan: run.isCurrentPlan,
      itemCount: run.requirements.length,
      grossRequirement: roundPlanningQty(run.requirements.reduce((sum, row) => sum + Number(row.grossRequirement || 0), 0)),
      netRequirement: roundPlanningQty(run.requirements.reduce((sum, row) => sum + Number(row.netRequirement || 0), 0)),
      firmNetRequirement: roundPlanningQty(run.requirements.reduce((sum, row) => sum + Number(row.firmNetRequirement || 0), 0)),
      atRiskSupplyQty: roundPlanningQty(run.requirements.reduce((sum, row) => sum + Number(row.atRiskSupplyQty || 0), 0)),
      expediteCount: run.requirements.filter((row) => row.procurementWindow === "EXPEDITE" && Number(row.netRequirement || 0) > 0).length,
    }));
    const revisionHistory = await prisma.mRPRun.findMany({
      where: {
        isDeleted: false,
        ...(mrpRun.planNumber ? { planNumber: mrpRun.planNumber } : { mpsNumber: mrpRun.mpsNumber }),
      },
      orderBy: [{ planRevision: "desc" }, { runDate: "desc" }],
      take: 30,
      select: {
        runNumber: true,
        planNumber: true,
        planRevision: true,
        status: true,
        scenarioStatus: true,
        scenarioKey: true,
        scenarioName: true,
        scenarioAssumptions: true,
        isCurrentPlan: true,
        runDate: true,
        runBy: true,
        totalRequirements: true,
        totalPlannedOrders: true,
      },
    });
    const mPlusOneOption = await buildMPlusOneOptionContext(mrpRun);
    const recentPreviewRuns = mrpRun.mpsNumber ? await prisma.mRPRun.findMany({
      where: {
        mpsNumber: mrpRun.mpsNumber,
        isDeleted: false,
        status: "Completed",
        scenarioStatus: { in: ["SIMULATION", "SIMULATED"] },
      },
      orderBy: { runDate: "desc" },
      take: 12,
      select: { runNumber: true, runDate: true, scenarioName: true, scenarioAssumptions: true },
    }) : [];
    const mPlusOnePreviewRun = recentPreviewRuns.find(isCurrentMPlusOnePreviewRun);
    let mPlusOnePreview = null;
    if (mPlusOnePreviewRun) {
      const previewRequirements = await prisma.mRPRequirement.findMany({
        where: { runNumber: mPlusOnePreviewRun.runNumber, isDeleted: false, orderType: "Purchase" },
        orderBy: [{ levelMBOM: "asc" }, { requiredDate: "asc" }],
        include: {
          part: {
            select: {
              partCode: true, partNumber: true, partName: true, itemType: true, rawType: true,
              material: {
                select: {
                  materialCode: true, materialName: true, materialForm: true,
                  defaultPurchaseUomCode: true, defaultConversionUomCode: true, defaultConversionFactor: true,
                },
              },
            },
          },
          mbomDetail: {
            select: {
              id: true, noReg: true, qty: true, uomCode: true, grossWeight: true, category: true,
              mbomHeader: { select: { noReg: true, part: { select: { partCode: true, partNumber: true, partName: true } } } },
              parentDetail: {
                select: {
                  id: true,
                  part: { select: { partCode: true, partNumber: true, partName: true } },
                  mbomProcesses: {
                    where: { isDeleted: false }, orderBy: [{ sequence: "asc" }],
                    select: { sequence: true, occurrenceCode: true, routingMode: true, process: { select: { processCode: true, processName: true } } },
                  },
                },
              },
              mbomProcesses: {
                where: { isDeleted: false }, orderBy: [{ sequence: "asc" }],
                select: { sequence: true, occurrenceCode: true, routingMode: true, process: { select: { processCode: true, processName: true } } },
              },
            },
          },
          mpsDetail: { select: { mpsNumber: true, partCode: true, customerCode: true, startDate: true, endDate: true, fgRequiredDate: true, mps: { select: { revision: true } }, part: { select: { partCode: true, partNumber: true, partName: true } } } },
        },
      });
      const previewGrouped = (await enrichMPlusOnePreviewRequirements(
        prisma,
        previewRequirements,
        mPlusOneOption,
      )).map((row) => ({
        ...row,
        customerPegging: (Array.isArray(row.customerPegging) ? row.customerPegging : []).map((peg) => ({
          ...peg,
          mpsNumber: row.mpsDetail?.mpsNumber || null,
          mpsRevision: row.mpsDetail?.mps?.revision ?? null,
        })),
      }));
      mPlusOnePreview = {
        ...mPlusOnePreviewRun,
        requirements: previewGrouped,
      };
    }
    const recoveryTargetIds = [...new Set(groupedRequirements.flatMap((row) => {
      const pegging = Array.isArray(row.customerPegging) ? row.customerPegging : [];
      return [row.deliveryTargetId, ...pegging.map((item) => item.deliveryTargetId)].filter(Boolean);
    }))];
    const recoveryPlans = recoveryTargetIds.length ? await prisma.dueDateRecoveryPlan.findMany({
      where: { deliveryTargetId: { in: recoveryTargetIds }, isCurrentPlan: true, isDeleted: false },
      select: {
        id: true, deliveryTargetId: true, revision: true, status: true, checklist: true, notes: true,
        requestedDeliveryDate: true, earliestFeasibleDelivery: true, approvedBy: true, approvedAt: true,
      },
    }) : [];
    res.json(mapDoc({
      ...mrpRun,
      lifecycleStatus: canonicalMrpLifecycleStatus(mrpRun.scenarioStatus),
      approvalEligibility: mrpApprovalEligibility(mrpRun),
      purchaseSuggestion,
      scenarioComparison,
      revisionHistory,
      mPlusOneOption,
      mPlusOnePreview,
      recoveryPlans,
      requirementTrace,
      productionScheduleTrace,
      requirements: groupedRequirements,
      plannedOrders: enrichedPlannedOrders.map((row) => ({ ...row, purchaseRequests: prByPlannedOrder.get(row.orderNumber) || [], purchaseRequest: prByPlannedOrder.get(row.orderNumber)?.[0] || null })),
    }));
  } catch (e) {
    next(e);
  }
};

// ============================================
// GET MRP AUDIT - DEMAND NETTING DETAILS
// ============================================
exports.getAudit = async (req, res, next) => {
  try {
    const { runNumber } = req.params;

    // Fetch MRP run with all details. Identifier may be runNumber or stable planNumber.
    const mrpRun = await findRunByNumberOrCurrentPlan(runNumber, {
        mps: {
          include: {
            details: {
              where: { isDeleted: false, status: { not: "Cancelled" } },
              include: {
                part: {
                  select: { partCode: true, partNumber: true, partName: true, planningPolicy: true },
                },
              },
            },
          },
        },
        requirements: {
          where: { isDeleted: false, levelMBOM: 0 }, // Only independent requirements (FG)
          orderBy: [{ requiredDate: "asc" }],
        },
        plannedOrders: {
          where: { isDeleted: false },
          orderBy: [{ orderDate: "asc" }],
        },
    });

    if (!mrpRun) {
      return res.status(404).json({ message: "MRP Run tidak ditemukan" });
    }

    const nettingSummary = normalizeNettingSummary(
      mrpRun.nettingSummary || parseLegacyNettingSummary(mrpRun.notes),
    );

    // Build detailed audit with MPS-level netting breakdown
    const mpsAudit = (mrpRun.mps?.details || []).map((mpsDetail) => {
      const requirement = mrpRun.requirements.find((r) => r.partCode === mpsDetail.partCode);
      const plannedOrder = mrpRun.plannedOrders.find((po) => po.partCode === mpsDetail.partCode);
      const nettingDetail = nettingSummary.byPart[mpsDetail.partCode] || { consumedQty: 0, sources: [] };

      return {
        mpsLineNumber: mpsDetail.lineNumber,
        partCode: mpsDetail.partCode,
        partNumber: mpsDetail.part?.partNumber || null,
        partName: mpsDetail.part?.partName || null,
        planningPolicy: resolvePlanningPolicy(mpsDetail.part),
        mpsQtyPlanned: Number(mpsDetail.qtyPlanned || 0),
        // Netting breakdown
        soConsumedQty: Number(requirement?.soConsumedQty ?? nettingDetail.consumedQty ?? 0),
        soSources: requirement?.consumptionSources || nettingDetail.sources || [],
        effectiveGrossQty: Number(
          requirement?.effectiveDemandQty ??
          resolveIndependentDemandQty(
            Number(mpsDetail.qtyPlanned || 0),
            Number(nettingDetail.consumedQty || 0),
            mpsDetail.part,
          ),
        ),
        // Resulting net requirement
        netRequirementQty: requirement
          ? Math.max(Number(requirement.grossRequirement || 0) - Number(requirement.onHandQty || 0), 0)
          : 0,
        // Planned order generated
        plannedOrderQty: plannedOrder ? Number(plannedOrder.qty || 0) : 0,
        plannedOrderNumber: plannedOrder?.orderNumber || null,
        // Audit check: verify netting math
        auditCheck: {
          expectedNetQty: requirement
            ? Math.max(
              Number(requirement.effectiveDemandQty || requirement.grossRequirement || 0) -
                Number(requirement.onHandQty || 0),
              0,
            )
            : resolveIndependentDemandQty(
              Number(mpsDetail.qtyPlanned || 0),
              Number(nettingDetail.consumedQty || 0),
              mpsDetail.part,
            ),
          actualPlannedQty: plannedOrder ? Number(plannedOrder.qty || 0) : 0,
          nettingApplied: Number(requirement?.soConsumedQty ?? nettingDetail.consumedQty ?? 0) > 0,
        },
      };
    });

    res.json({
      runNumber: mrpRun.runNumber,
      runDate: mrpRun.runDate,
      status: mrpRun.status,
      mpsNumber: mrpRun.mpsNumber,
      planHorizon: mrpRun.planHorizon,
      cutoffDate: mrpRun.cutoffDate,
      executionTime: mrpRun.executionTime,
      // Summary counts
      summaryMetrics: {
        totalMpsLines: mpsAudit.length,
        totalRequirements: mrpRun.totalRequirements || 0,
        totalPlannedOrders: mrpRun.totalPlannedOrders || 0,
        soDemandsConsumed: Number(mrpRun.soDemandConsumedQty ?? nettingSummary.totalConsumedQty ?? 0),
        impactedMpsLines: Number(mrpRun.soDemandImpactedLines ?? nettingSummary.impactedMpsLines ?? 0),
      },
      // Detailed MPS-level netting breakdown
      mpsLevelAudit: mpsAudit,
      // Overall netting summary
      nettingSummary,
    });
  } catch (e) {
    next(e);
  }
};

// ============================================
// RUN MRP CALCULATION
// ============================================
exports.runMRP = async (req, res, next) => {
  try {
    const {
      runNumber: requestedRunNumber, mpsNumber, mpsNumbers: requestedMpsNumbers, planHorizon, cutoffDate, soDemandPartCodes,
      scenarioKey, scenarioName, scenarioAssumptions, planningSnapshotAt, baselineRunNumber,
    } = req.body;
    const planningMode = String(
      req.body?.planningMode || scenarioAssumptions?.planningMode || "OFFICIAL",
    ).trim().toUpperCase();
    if (!new Set(["OFFICIAL", "M_PLUS_ONE_PREVIEW"]).has(planningMode)) {
      return res.status(400).json({ message: "planningMode harus OFFICIAL atau M_PLUS_ONE_PREVIEW." });
    }
    const isMPlusOnePreview = planningMode === "M_PLUS_ONE_PREVIEW";
    const includeMPlusTwoBuffer = Boolean(
      req.body?.includeMPlusTwoBuffer ?? scenarioAssumptions?.includeMPlusTwoBuffer,
    );
    const calculationLifecycle = mrpCalculationLifecycle(req.body?.scenarioStatus);
    if (!calculationLifecycle.allowed) {
      return res.status(409).json({
        code: calculationLifecycle.code,
        message: "Perhitungan MRP selalu membuat revision Draft lalu Simulated. Gunakan aksi Approve untuk menjadikannya official.",
      });
    }
    const scenarioStatus = calculationLifecycle.initialStatus;
    const isSimulation = true;
    const scenarioDemandMultiplier = isSimulation
      ? Math.min(Math.max(Number(scenarioAssumptions?.demandMultiplier || 1), 0), 5)
      : 1;
    const startTime = Date.now();

    const mpsPrecheck = await prisma.mPS.findUnique({
      where: { mpsNumber },
      select: {
        id: true,
        mpsNumber: true,
        revision: true,
        status: true,
        isDeleted: true,
        replanRequired: true,
        replanReason: true,
        planningAnchorMonth: true,
        periodStart: true,
        periodEnd: true,
        deliveryFeasibilityStatus: true,
        deliveryFeasibilityFingerprint: true,
        officialGateStatus: true,
        planKind: true,
        baselineMpsNumber: true,
      },
    });

    if (!mpsPrecheck || mpsPrecheck.isDeleted) {
      return res.status(404).json({ message: "MPS tidak ditemukan" });
    }
    const requestedPlanKind = String(req.body?.planKind || mpsPrecheck.planKind || "BASELINE").trim().toUpperCase() === "DELTA" ? "DELTA" : "BASELINE";
    const isDeltaRun = requestedPlanKind === "DELTA";
    let deltaMetadata = null;
    if (isDeltaRun) {
      try {
        deltaMetadata = deltaMrpMetadata({ deltaMpsNumber: mpsPrecheck.mpsNumber, baselineMpsNumber: mpsPrecheck.baselineMpsNumber, baselineRunNumber });
      } catch (error) {
        return res.status(409).json({ code: "DELTA_MRP_BASELINE_REQUIRED", message: error.message });
      }
      const baselineRun = await prisma.mRPRun.findFirst({ where: { runNumber: deltaMetadata.baselineRunNumber, planKind: "BASELINE", status: "Completed", scenarioStatus: "APPROVED", isCurrentPlan: true, isDeleted: false } });
      if (!baselineRun) return res.status(409).json({ code: "DELTA_MRP_BASELINE_NOT_CURRENT", message: "Baseline MRP harus Approved dan masih menjadi current plan sebelum Delta MRP dihitung." });
    }

    const explicitSourceMpsNumbers = [...new Set([
      mpsNumber,
      ...(Array.isArray(requestedMpsNumbers) ? requestedMpsNumbers : []),
    ].map((value) => String(value || "").trim()).filter(Boolean))];
    if (explicitSourceMpsNumbers.length > 3) {
      return res.status(400).json({
        code: "MPS_CYCLE_TOO_WIDE",
        message: "Satu run MRP maksimal mencakup 3 bulan MPS dalam satu planning cycle.",
      });
    }
    const cycleAnchor = mpsPrecheck.planningAnchorMonth || mpsPrecheck.periodStart;
    const cycleWindowEnd = new Date(cycleAnchor);
    cycleWindowEnd.setUTCMonth(cycleWindowEnd.getUTCMonth() + 3, 1);
    cycleWindowEnd.setUTCHours(0, 0, 0, 0);
    const expectedCycleMps = isDeltaRun ? [mpsPrecheck] : await prisma.mPS.findMany({
      where: {
        isDeleted: false,
        planKind: { not: "DELTA" },
        status: { notIn: ["Superseded", "Cancelled"] },
        ...(mpsPrecheck.planningAnchorMonth
          ? { planningAnchorMonth: mpsPrecheck.planningAnchorMonth }
          : { periodStart: { gte: mpsPrecheck.periodStart, lt: cycleWindowEnd } }),
        periodStart: { gte: cycleAnchor, lt: cycleWindowEnd },
      },
      select: { id: true, mpsNumber: true, revision: true, status: true, isDeleted: true, replanRequired: true, replanReason: true, planningAnchorMonth: true, periodStart: true, periodEnd: true, deliveryFeasibilityStatus: true, deliveryFeasibilityFingerprint: true, officialGateStatus: true, planKind: true, baselineMpsNumber: true },
      orderBy: { periodStart: "asc" },
      take: 3,
    });
    const expectedCycleNumbers = expectedCycleMps.map((row) => row.mpsNumber);
    if (!isDeltaRun && Array.isArray(requestedMpsNumbers) && requestedMpsNumbers.length > 0) {
      const missingCycleNumbers = expectedCycleNumbers.filter((value) => !explicitSourceMpsNumbers.includes(value));
      if (missingCycleNumbers.length) {
        return res.status(409).json({
          code: "MPS_CYCLE_INCOMPLETE",
          message: `MRP harus menjalankan seluruh planning cycle: ${expectedCycleNumbers.join(" + ")}. MPS yang belum ikut: ${missingCycleNumbers.join(", ")}.`,
          expectedMpsNumbers: expectedCycleNumbers,
          receivedMpsNumbers: explicitSourceMpsNumbers,
        });
      }
    }
    let planningCycleMpsPrechecks;
    if (isDeltaRun) {
      planningCycleMpsPrechecks = [mpsPrecheck];
    } else if (Array.isArray(requestedMpsNumbers) && requestedMpsNumbers.length > 0) {
      planningCycleMpsPrechecks = await prisma.mPS.findMany({
        where: { mpsNumber: { in: explicitSourceMpsNumbers }, isDeleted: false },
        select: { id: true, mpsNumber: true, revision: true, status: true, isDeleted: true, replanRequired: true, replanReason: true, planningAnchorMonth: true, periodStart: true, periodEnd: true, deliveryFeasibilityStatus: true, deliveryFeasibilityFingerprint: true, officialGateStatus: true },
        orderBy: { periodStart: "asc" },
      });
      if (planningCycleMpsPrechecks.length !== explicitSourceMpsNumbers.length) {
        return res.status(404).json({ message: "Sebagian MPS dalam planning cycle tidak ditemukan." });
      }
    } else {
      planningCycleMpsPrechecks = expectedCycleMps;
    }
    const planningCycleMpsNumbers = planningCycleMpsPrechecks.map((row) => row.mpsNumber);
    const planningCycleSourceSnapshot = buildMrpSourceSnapshot(planningCycleMpsPrechecks);
    const invalidStatusMps = planningCycleMpsPrechecks.find((row) => !["Confirmed", "Released"].includes(row.status));
    if (!isSimulation && invalidStatusMps) {
      return res.status(409).json({
        code: "MPS_CYCLE_NOT_LOCKED",
        message: `Semua MPS dalam planning cycle harus Confirmed/Released. ${invalidStatusMps.mpsNumber} saat ini ${invalidStatusMps.status}.`,
        sourceMpsNumbers: planningCycleMpsNumbers,
      });
    }

    const replanMps = planningCycleMpsPrechecks.find((row) => row.replanRequired);
    if (!isSimulation && replanMps) {
      return res.status(409).json({
        code: "DEMAND_REPLAN_REQUIRED",
        message: replanMps.replanReason || `${replanMps.mpsNumber} berubah. Hitung ulang dan lock planning cycle sebelum menjalankan MRP.`,
      });
    }

    const deliveryGateSnapshot = isSimulation
      ? await Promise.all(planningCycleMpsPrechecks.map(async (row) => ({ mpsNumber: row.mpsNumber, ...(await getMpsDeliveryGate(prisma, row)) })))
      : await assertOfficialMpsDeliveryGate(prisma, planningCycleMpsPrechecks);
    const primaryMpsPrecheck = planningCycleMpsPrechecks.find((row) => row.mpsNumber === mpsNumber) || mpsPrecheck;
    const futureMpsPrechecks = planningCycleMpsPrechecks
      .filter((row) => new Date(row.periodStart) > new Date(primaryMpsPrecheck.periodStart))
      .sort((left, right) => new Date(left.periodStart) - new Date(right.periodStart));
    if (isMPlusOnePreview && !futureMpsPrechecks.length) {
      return res.status(409).json({
        code: "M_PLUS_ONE_SOURCE_NOT_FOUND",
        message: "MPS M+1 belum tersedia pada planning cycle ini.",
        planningCycleMpsNumbers,
      });
    }
    // Official MRP explodes only the authoritative M document. Its qtyPlanned
    // already contains M-1 carry-over, official M demand, and the ending-stock
    // buffer sourced from EFD M+1. M+1 is an explicit simulation source so it
    // cannot be counted a second time in official output.
    const sourceMpsPrechecks = isMPlusOnePreview
      ? [futureMpsPrechecks[0]]
      : [primaryMpsPrecheck];
    const sourceMpsNumbers = sourceMpsPrechecks.map((row) => row.mpsNumber);
    const cyclePeriodStart = sourceMpsPrechecks.reduce(
      (value, row) => (!value || new Date(row.periodStart) < new Date(value) ? row.periodStart : value),
      null,
    );
    const cyclePeriodEnd = sourceMpsPrechecks.reduce(
      (value, row) => (!value || new Date(row.periodEnd) > new Date(value) ? row.periodEnd : value),
      null,
    );

    const planningMonthKey = new Date(primaryMpsPrecheck.periodStart).toISOString().slice(0, 7);
    const generatedIdentity = await nextMonthlyMrpIdentity(prisma, planningMonthKey);
    // Legacy clients may still send the former daily run number. Monthly MRP
    // identity remains authoritative for manual and normal PPIC runs.
    const requestedMonthlyRun = requestedRunNumber && /^MRP-\d{6}-R\d{3}$/i.test(requestedRunNumber)
      ? requestedRunNumber.toUpperCase()
      : null;
    const runNumber = requestedMonthlyRun === generatedIdentity.runNumber
      ? requestedMonthlyRun
      : generatedIdentity.runNumber;

    const existingRunning = await prisma.mRPRun.findFirst({
      where: {
        mpsNumber: { in: sourceMpsNumbers },
        isDeleted: false,
        status: "Running",
      },
      select: { runNumber: true },
    });

    if (existingRunning) {
      return res.status(409).json({
        message: `MRP untuk MPS ${mpsNumber} sedang berjalan di run ${existingRunning.runNumber}. Tunggu selesai lalu coba lagi.`,
      });
    }

    const resolvedPlanHorizon = resolvePlanHorizonDays(
      planHorizon,
      cyclePeriodStart,
      cyclePeriodEnd,
    );

    // Calculate cutoffDate: use provided date, or default to MPS periodEnd
    let resolvedCutoffDate = parseDate(cutoffDate);
    if (!resolvedCutoffDate) {
      // Default to MPS periodEnd or today + planHorizon days
      if (cyclePeriodEnd) {
        resolvedCutoffDate = new Date(cyclePeriodEnd);
      } else {
        resolvedCutoffDate = new Date();
        resolvedCutoffDate.setDate(resolvedCutoffDate.getDate() + resolvedPlanHorizon);
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const formulas = await getFormulaSet(tx, "planning");
      const planIdentity = await resolvePlanIdentity(tx, {
        mpsNumber,
        planNumber: generatedIdentity.planNumber,
        planScope: "MPS",
      });
      if (!isSimulation) await retirePreviousPlanRevisions(tx, planIdentity.planNumber, runNumber);

      // Create MRP Run header
      const mrpRun = await tx.mRPRun.create({
        data: {
          runNumber,
          ...planIdentity,
          planningMonth: new Date(`${planningMonthKey}-01T00:00:00.000Z`),
          planKind: requestedPlanKind,
          baselineRunNumber: deltaMetadata?.baselineRunNumber || null,
          sourceDeltaMpsNumber: deltaMetadata?.sourceDeltaMpsNumber || null,
          isCurrentPlan: calculationLifecycle.isCurrentPlan,
          planHorizon: resolvedPlanHorizon,
          cutoffDate: resolvedCutoffDate,
          planningSnapshotAt: parseDate(planningSnapshotAt) || new Date(),
          scenarioKey: String(scenarioKey || "").trim() || null,
          scenarioName: String(scenarioName || "").trim() || null,
          scenarioStatus,
          scenarioAssumptions: {
            ...(scenarioAssumptions && typeof scenarioAssumptions === "object" ? scenarioAssumptions : {}),
            planningCycleMonth: planningMonthKey,
            planningMode,
            planKind: requestedPlanKind,
            baselineRunNumber: deltaMetadata?.baselineRunNumber || null,
            baselineMpsNumber: deltaMetadata?.baselineMpsNumber || null,
            deliveryGateSnapshot,
            planningCycleMpsNumbers,
            ...planningCycleSourceSnapshot,
            sourceMpsNumbers,
            firmHorizonMonths: sourceMpsNumbers.length,
            officialSourceMpsNumbers: [primaryMpsPrecheck.mpsNumber],
            lookaheadSourceMpsNumbers: futureMpsPrechecks.map((row) => row.mpsNumber),
            includeMPlusTwoBuffer: isMPlusOnePreview && includeMPlusTwoBuffer,
            previewTreeVersion: isMPlusOnePreview ? M_PLUS_ONE_PREVIEW_TREE_VERSION : null,
          },
          status: "Running",
          runBy: req.user?.username || "system",
          mps: {
            connect: {
              mpsNumber,
            },
          },
        },
      });
      emitPlanningMrpRunUpdate(mrpRun, "start", req.user?.username || "system");

      try {
        // Get MPS details (include part untuk bisa ambil partId)
        const mpsDocuments = await tx.mPS.findMany({
          where: { mpsNumber: { in: sourceMpsNumbers }, isDeleted: false },
          include: {
            deliveryPlans: {
              where: { isDeleted: false, targetType: "CUSTOMER", status: { not: "Cancelled" } },
              orderBy: [{ plannedDate: "asc" }, { phaseNumber: "asc" }],
            },
            details: {
              where: { isDeleted: false, status: { not: "Cancelled" } },
              orderBy: { endDate: "asc" },
              include: {
                part: { select: { id: true, itemType: true, bufferStock: true, planningPolicy: true } },
                mbom: { select: { uomCode: true } },
                forecastDetail: { select: { uomCode: true } },
                demandSources: { orderBy: [{ sourceType: "asc" }, { sourceNumber: "asc" }] },
              },
            },
          },
        });

        if (mpsDocuments.length !== sourceMpsNumbers.length) {
          throw new Error("Sebagian MPS dalam planning cycle tidak ditemukan");
        }
        const primaryMps = mpsDocuments.find((row) => row.mpsNumber === mpsNumber) || mpsDocuments[0];
        const mps = {
          ...primaryMps,
          periodStart: cyclePeriodStart || primaryMps.periodStart,
          periodEnd: cyclePeriodEnd || primaryMps.periodEnd,
        };
        const previewProjectedOpeningMap = {};

        // Child production rows hasil MRP ditampilkan di MPS, tetapi bukan demand
        // baru. Hanya row sumber forecast/SO yang boleh diexplode pada run berikutnya.
        const rawSourceMpsDetailsByNumber = new Map();
        const sourceMpsDetails = mpsDocuments.flatMap((document) => {
          const rawDetails = document.details.filter(
            (row) => !String(row.notes || "").startsWith(GENERATED_MPS_CHILD_NOTE_PREFIX),
          );
          rawSourceMpsDetailsByNumber.set(document.mpsNumber, rawDetails);
          return expandMpsDetailsByDeliveryPhases(rawDetails, document.deliveryPlans || [])
            .map((row) => ({ ...row, _sourceMpsNumber: document.mpsNumber }));
        })
          .filter((row) => !isMPlusOnePreview || includeMPlusTwoBuffer || !row._isBufferPhase)
          .sort((left, right) => new Date(left.endDate) - new Date(right.endDate));
        const productionRoutingRequests = sourceMpsDetails
          .filter((detail) => detail.mbomHeaderId)
          .map((detail) => ({
            headerId: detail.mbomHeaderId,
            scheduleQty: Math.max(Number(detail.qtyPlanned || detail.effectiveDemandQty || 0), 1),
          }));
        const productionRoutingMetrics = await routingMetricsForRequests(tx, productionRoutingRequests);
        const planningConstraintByTarget = await loadDemandPlanningConstraintMap(
          tx,
          sourceMpsDetails.map((detail) => detail._deliveryTargetId || detail.deliveryPhaseId).filter(Boolean),
        );

        const runningRun = await tx.mRPRun.findFirst({
          where: {
            mpsNumber: { in: sourceMpsNumbers },
            isDeleted: false,
            status: "Running",
            runNumber: { not: runNumber },
          },
          select: { runNumber: true },
        });

        if (runningRun) {
          throw new Error(
            `MRP untuk MPS ${mpsNumber} sedang berjalan di run ${runningRun.runNumber}. Tunggu selesai lalu coba lagi.`,
          );
        }

        const unlockedMps = mpsDocuments.find((row) => !["Confirmed", "Released"].includes(row.status));
        if (!isSimulation && unlockedMps) {
          throw new Error(`MPS ${unlockedMps.mpsNumber} harus Confirmed/Released sebelum run MRP.`);
        }

        if (!isSimulation) {
          await supersedePreviousMrpArtifacts(
            tx,
            sourceMpsNumbers,
            runNumber,
            req.user?.username || "system",
          );
        }

        const requirements = [];
        const plannedOrders = [];
        const dependentProjectedAvailableMap = {};
        const dependentProjectedActualAvailableMap = {};
        const dependentProjectedAllocatedMap = {};
        const dependentProjectedMppSupplyMap = {};
        const dependentProjectedMoSupplyMap = {};
        const purchaseInitialAvailableMap = {};
        const purchaseInitialActualAvailableMap = {};
        const purchaseInitialAllocatedMap = {};
        const purchaseInitialStockAvailableMap = {};
        const manualPartReservations = await tx.stockReservation.findMany({
          where: {
            isDeleted: false,
            status: "Active",
            referenceType: "PART_ALLOCATION",
            OR: [{ expiryDate: null }, { expiryDate: { gte: new Date() } }],
          },
          select: {
            partCode: true,
            materialId: true,
            materialCode: true,
            targetPartCode: true,
            referenceNumber: true,
            qtyReserved: true,
            qtyReleased: true,
            stockBalance: { select: { partCode: true, materialId: true, materialCode: true, uomCode: true } },
          },
        });
        const targetedReservationPool = buildTargetedReservationPool(manualPartReservations);
        const mbomHeaderByPartCode = {};
        const uomCodeByPartCode = {};
        const soSourcesByRequirement = new Map();
        const affectedSoNumbers = new Set();
        const soDemandConsumptionSummary = {
          totalConsumedQty: 0,
          impactedMpsLines: 0,
          byPart: {},
        };
        const soConsumedByMpsDetail = new Map();
        const soDemandTimeFence = await getSoDemandTimeFenceSetting(tx);

        const mpsPartCodes = [
          ...new Set(sourceMpsDetails.map((detail) => detail.partCode).map(normalizePartCode).filter(Boolean)),
        ];
        const requestedSoDemandPartCodes = Array.isArray(soDemandPartCodes)
          ? [...new Set(soDemandPartCodes.map(normalizePartCode).filter(Boolean))]
          : [];
        const scopedSoDemandPartCodes = requestedSoDemandPartCodes.length > 0
          ? requestedSoDemandPartCodes.filter((partCode) => mpsPartCodes.includes(partCode))
          : mpsPartCodes;

        // Best practice ERP: SO aktual juga menjadi demand MRP.
        // Scope SO demand dibatasi ke part MPS yang sedang dirun.
        // Jadi SO part berbeda tidak ikut "numpang" ke MRP run MPS lain.
        const openSoDemandByPart = await buildOpenSoDemandByPart(
          tx,
          scopedSoDemandPartCodes,
          resolvedCutoffDate || mps.periodEnd,
        );
        const openSoDemandPartCodes = Object.keys(openSoDemandByPart);
        const soOnlyPlanNumbersInScope = collectSoPlanNumbersFromDemand(openSoDemandByPart);

        // Batch fetch semua stock balance sekaligus untuk hindari N+1
        const allPartCodes = [
            ...new Set([
              ...sourceMpsDetails.map((d) => d.partCode),
              ...openSoDemandPartCodes,
            ].map(normalizePartCode).filter(Boolean)),
        ];
        const stockBalances = await tx.stockBalance.findMany({
          where: {
            AND: [
              { partCode: { in: allPartCodes }, isDeleted: false },
              buildExcludeSpecialRackCondition(),
            ],
          },
          select: {
            partCode: true,
            stockType: true,
            uomCode: true,
            qtyOnHand: true,
            qtyReserved: true,
            qtyQC: true,
            qtyAvailable: true,
          },
        });
        const normalizedStockBalances = normalizePlanningStockRows(stockBalances);
        const stockPositionMaps = buildStockPositionMaps(normalizedStockBalances);

        // Netting scheduled receipts untuk menghindari double planned order.
        const supplyMap = await buildOpenSupplyMap(
          tx,
          allPartCodes,
          resolvedCutoffDate || mps.periodEnd,
          {
            excludeRunNumbers: [runNumber],
            excludePlanNumbers: soOnlyPlanNumbersInScope,
            excludeSourceMpsNumbers: sourceMpsNumbers,
          },
        );
        const projectedMppSupplyMap = await buildOpenMppSupplyMap(
          tx,
          allPartCodes,
          resolvedCutoffDate || mps.periodEnd,
          { excludeSourceMpsNumbers: sourceMpsNumbers },
        );
        const projectedMoSupplyMap = await buildOpenMoSupplyMap(
          tx,
          allPartCodes,
          resolvedCutoffDate || mps.periodEnd,
        );

        // Gunakan projected stock per part agar demand antar-periode tidak selalu pakai stock awal yang sama.
        // Ini mencegah false net=0 ketika part yang sama muncul di beberapa baris MPS.
        // FG stock already reserved for the same demand still covers the MPS
        // target. Use on-hand for production netting; reservation remains
        // visible separately and is not counted twice in later periods.
        const projectedAvailableMap = isMPlusOnePreview
          ? { ...stockPositionMaps.onHand }
          : mergeQtyMaps(stockPositionMaps.onHand, supplyMap);
        if (isMPlusOnePreview) {
          // Preview M+1 is an isolated look-ahead. Its opening pool is the
          // physical inventory snapshot at run time; it must not be reduced by
          // month M usage or replaced by projected closing M. The pool is
          // still consumed chronologically by the M+1 delivery phases below.
          for (const [partCode, qty] of Object.entries(stockPositionMaps.onHand)) {
            previewProjectedOpeningMap[partCode] = Number(qty || 0);
          }
        }
        const stockAllocatedMap = stockPositionMaps.allocated;

        // Debug log untuk audit
        const debugSoPartCodes = Object.keys(openSoDemandByPart);
        if (debugSoPartCodes.length > 0) {
          console.log(`[MRP ${runNumber}] SO demand parts detected: ${debugSoPartCodes.join(", ")}`);
        }

        // Process each MPS item (Level 0 - Finished Goods)
        for (const mpsDetail of sourceMpsDetails) {
          const fgPartCode = normalizePartCode(mpsDetail.partCode);
            const fgUomCode = mpsDetail.forecastDetail?.uomCode || mpsDetail.mbom?.uomCode || null;
            if (fgPartCode && fgUomCode) {
              uomCodeByPartCode[fgPartCode] = fgUomCode;
            }

          // Time fence mengikuti due date SO, bukan due date bucket MPS.
          // SO yang masih dalam fence boleh consume forecast/MPS terdekat untuk part yang sama.
          // Monthly MPS is authoritative for Forecast/SO consumption. When
          // it explicitly carries an SO source, consume that exact SO even if
          // Marketing's original date differs by a day from the effective
          // Forecast target. It must not reappear as an extra SO-only demand.
          const soConsumption = consumeSalesOrdersAlreadyRepresentedByMps(openSoDemandByPart, mpsDetail, soDemandTimeFence);

          if (soConsumption.consumedQty > 0) {
            const partCode = normalizePartCode(mpsDetail.partCode);
            for (const source of soConsumption.sources) {
              const parsed = parseSoConsumptionSource(source);
              if (parsed?.soNumber) affectedSoNumbers.add(parsed.soNumber);
            }

            soDemandConsumptionSummary.totalConsumedQty += Number(
              soConsumption.consumedQty || 0,
            );
            soDemandConsumptionSummary.impactedMpsLines += 1;

            if (!soDemandConsumptionSummary.byPart[partCode]) {
              soDemandConsumptionSummary.byPart[partCode] = {
                consumedQty: 0,
                sources: [],
              };
            }

            soDemandConsumptionSummary.byPart[partCode].consumedQty += Number(
              soConsumption.consumedQty || 0,
            );
            soDemandConsumptionSummary.byPart[partCode].sources.push(
              ...soConsumption.sources,
            );
          }

          // MPS menyimpan Forecast dan Buffer terpisah. MRP memakai demand
          // forecast+buffer sebagai baseline, tetapi tidak boleh lebih kecil dari SO aktual.
          const forecastQty = Number(mpsDetail.forecastQty ?? mpsDetail.qtyPlanned ?? 0) * scenarioDemandMultiplier;
          const soQtyInBucket = Number(soConsumption.consumedQty || 0);
          soConsumedByMpsDetail.set(
            mpsDetail.id,
            roundPlanningQty(Number(soConsumedByMpsDetail.get(mpsDetail.id) || 0) + soQtyInBucket),
          );
          const mpsUsesNetProduction = Number(mpsDetail.calculationTrace?.version || 0) >= 2;
          // qtyPlanned is synchronized to the net production target after MRP,
          // so it cannot be reused as gross input on the next run. Rebuild the
          // pre-stock target from effective demand and production policy to
          // keep recalculation idempotent.
          const forecastDemandWithBuffer = mpsUsesNetProduction
            ? Number(mpsDetail.qtyPlanned || 0) * scenarioDemandMultiplier
            : evaluateFromSet(formulas, "MPS_TARGET_QTY", {
                effectiveDemandQty: Number(mpsDetail.effectiveDemandQty ?? mpsDetail.forecastQty ?? mpsDetail.qtyPlanned ?? 0) * scenarioDemandMultiplier,
                productionPercent: Number(mpsDetail.productionPercent ?? 100),
                actualSalesOrderQty: soQtyInBucket,
              });
          // Policy MTO/MTS sudah diselesaikan secara authoritative saat MPS
          // dibentuk. Nilai ini juga membawa target ending buffer, sehingga MRP
          // tidak boleh menerapkan policy untuk kedua kalinya dan membuang
          // buffer pada MTO. SO aktual tetap menjadi batas minimum firm demand.
          const grossRequirementAfterSo = mpsUsesNetProduction
            ? Number(forecastDemandWithBuffer || 0)
            : Math.max(Number(forecastDemandWithBuffer || 0), Number(soQtyInBucket || 0));

          // MPS is monthly demand; its period start is not a production due
          // date. Use the same MBOM critical path and reviewed vendor-process
          // adjustments as Purchase Suggestion to calculate when material is
          // actually required.
          const routingQty = Math.max(Number(mpsDetail.qtyPlanned || forecastDemandWithBuffer || 0), 1);
          const routingKey = `${mpsDetail.mbomHeaderId}|${roundPlanningQty(routingQty)}`;
          const baseRoutingMetric = productionRoutingMetrics.get(routingKey) || {
            productionLeadTimeDays: 0,
            workingHoursPerDay: 8,
          };
          const planningDecision = planningConstraintByTarget.get(
            mpsDetail._deliveryTargetId || mpsDetail.deliveryPhaseId,
          ) || null;
          const routingDecision = applyDecisionToRoutingMetric(baseRoutingMetric, planningDecision);
          const customerTargetDate = mpsDetail._customerTargetDate || mpsDetail.customerTargetDate || mpsDetail.endDate;
          const fgRequiredDate = mpsDetail._fgRequiredDate || mpsDetail.fgRequiredDate || mpsDetail.endDate;
          const productionDates = resolveProductionRequirementDates({
            fgRequiredDate,
            customerTargetDate,
            routingMetric: routingDecision.metric || baseRoutingMetric,
          });
          const leadTimeDays = productionDates.scheduledProductionLeadTimeDays;
          const orderDate = productionDates.productionLatestStartDate;
          const requirementIdentity = createRequirementIdentity();
          const requirementTreePath = buildRequirementTreePath(
            null,
            0,
            mpsDetail.lineNumber || requirements.length + 1,
          );

          // Create independent requirement from MPS
          const requirement = {
            ...requirementIdentity,
            runNumber,
            treePath: requirementTreePath,
            levelMBOM: 0,
            mbomLevelComponent: 0,
            mbomDetailId: null,
            partCode: mpsDetail.partCode,
            partId: mpsDetail.partId || mpsDetail.part?.id || null,
            requirementType: "Independent",
            sourceType: "MPS",
            sourceNumber: mpsDetail._sourceMpsNumber || mpsNumber,
            rootDemandSourceType: mpsDetail._deliveryPhaseSourceType || mpsDetail.demandSources?.[0]?.sourceType || "MPS",
            rootDemandSourceNumber: mpsDetail._deliveryPhaseSourceNumber || mpsDetail.demandSources?.[0]?.sourceNumber || mpsDetail._sourceMpsNumber || mpsNumber,
            deliveryTargetId: mpsDetail._deliveryTargetId || mpsDetail.deliveryPhaseId || null,
            customerCode: mpsDetail._customerCode || mpsDetail.customerCode || mpsDetail.demandSources?.[0]?.customerCode || null,
            fgPartCode: mpsDetail.partCode,
            targetDeliveryDate: productionDates.customerTargetDate,
            parentRequiredDate: null,
            productionRequiredDate: productionDates.productionLatestStartDate,
            materialRequiredDate: productionDates.materialRequiredDate,
            priorityScore: mpsDetail.priorityScore ?? mpsDetail.demandSources?.[0]?.priorityScore ?? null,
            priorityClass: mpsDetail.priorityClass || mpsDetail.demandSources?.[0]?.priorityClass || null,
            customerPegging: demandPeggingForPhase(mpsDetail),
            // Traceability: dari MPSDetail mana requirement ini dibuat
            mpsDetailId: mpsDetail.id,
            requiredDate: productionDates.fgRequiredDate,
            grossRequirement: grossRequirementAfterSo,
            forecastQty,
            soConsumedQty: soQtyInBucket,
            effectiveDemandQty: forecastDemandWithBuffer,
            bufferBaseQty: Number(mpsDetail.bufferBaseQty || 0),
            bufferPercent: Number(mpsDetail.bufferPercent || 0),
            bufferQty: Number(mpsDetail.bufferQty || 0),
            consumptionSources: soConsumption.sources,
            onHandQty: 0,
            allocatedQty: 0,
            netRequirement: 0,
            plannedOrderQty: 0,
            orderType: "Production",
            leadTime: leadTimeDays,
            orderDate,
            notes: mpsDetail._isBufferPhase
              ? "MPS internal buffer stock"
              : mpsDetail._deliveryPhaseId
                ? `MPS delivery phase ${mpsDetail._deliveryPhaseNumber} (${mpsDetail._deliveryPhaseId})`
                : null,
            _partBufferPercent: Number(mpsDetail.part?.bufferStock || 0),
            _productionScheduleQty: grossRequirementAfterSo,
          };

          const availableBefore = isMPlusOnePreview
            ? Number(previewProjectedOpeningMap[fgPartCode] || 0)
            : Number(projectedAvailableMap[fgPartCode] || 0);
          const actualOnHandBefore = stockPositionMaps.onHand[fgPartCode] || 0;
          const allocatedQty = stockAllocatedMap[fgPartCode] || 0;
          requirement.onHandQty = actualOnHandBefore;
          requirement.allocatedQty = allocatedQty;
          // Net MPS already consumed FG stock and ending-stock target.
          requirement.netRequirement = isMPlusOnePreview
            ? roundPlanningQty(Math.max(requirement.grossRequirement - availableBefore, 0))
            : mpsUsesNetProduction
              ? requirement.grossRequirement
              : evaluateFromSet(formulas, "MRP_NET_REQUIREMENT", {
                grossRequirement: requirement.grossRequirement,
                projectedAvailable: availableBefore,
                });
          requirement.plannedOrderQty = requirement.netRequirement;
          if (requirement.orderType === "Purchase" && purchaseInitialAvailableMap[fgPartCode] === undefined) {
            purchaseInitialAvailableMap[fgPartCode] = availableBefore;
            purchaseInitialActualAvailableMap[fgPartCode] = actualOnHandBefore;
            purchaseInitialAllocatedMap[fgPartCode] = allocatedQty;
          }
          const mppAvailableBefore = Number(projectedMppSupplyMap[fgPartCode] || 0);
          const moAvailableBefore = Number(projectedMoSupplyMap[fgPartCode] || 0);
          const nonProductionDriverAvailableBefore = Math.max(
            availableBefore - mppAvailableBefore - moAvailableBefore,
            0,
          );
          const mppDrivenQty = Math.min(
            mppAvailableBefore,
            Math.max(requirement.grossRequirement - nonProductionDriverAvailableBefore, 0),
          );
          const moDrivenQty = Math.min(
            moAvailableBefore,
            Math.max(requirement.grossRequirement - nonProductionDriverAvailableBefore - mppDrivenQty, 0),
          );
          const productionExplosionQty = requirement.plannedOrderQty + mppDrivenQty + moDrivenQty;
          requirement._productionScheduleQty = productionExplosionQty;

          // Kurangi projected stock dengan gross requirement pada bucket ini.
          projectedAvailableMap[fgPartCode] = isMPlusOnePreview
            ? Math.max(availableBefore - requirement.grossRequirement, 0)
            : mpsUsesNetProduction
              ? 0
              : Math.max(
                  availableBefore - requirement.grossRequirement,
                  0
                );
          if (isMPlusOnePreview) {
            previewProjectedOpeningMap[fgPartCode] = projectedAvailableMap[fgPartCode];
          }
          projectedMppSupplyMap[fgPartCode] = Math.max(
            mppAvailableBefore - mppDrivenQty,
            0,
          );
          projectedMoSupplyMap[fgPartCode] = Math.max(
            moAvailableBefore - moDrivenQty,
            0,
          );

          // Simpan requirement level MPS walaupun net=0 agar demand tetap terlihat di UI.
          requirements.push(requirement);
          if (soConsumption.consumedQty > 0) {
            soSourcesByRequirement.set(requirement, soConsumption.sources);
          }

          if (productionExplosionQty > 0) {
            // Resolve mbomHeaderId: pakai yang ada di MPSDetail,
            // jika null → cari MBOM dari partId secara otomatis
            let mbomHeaderId = mpsDetail.mbomHeaderId || null;
            let resolvedMbomUomCode = mpsDetail.mbom?.uomCode || null;
            if (!mbomHeaderId && requirement.partId) {
              const foundBom = await findActiveMbomHeader(
                tx,
                requirement.partId,
                requirement.requiredDate,
              );
              mbomHeaderId = foundBom?.id || null;
              resolvedMbomUomCode = foundBom?.uomCode || resolvedMbomUomCode;
            }

            if (mbomHeaderId) {
              mbomHeaderByPartCode[mpsDetail.partCode] = mbomHeaderId;
              if (fgPartCode && !uomCodeByPartCode[fgPartCode] && resolvedMbomUomCode) {
                uomCodeByPartCode[fgPartCode] = resolvedMbomUomCode;
              }
            }

            // Explode MBOM untuk level berikutnya
            if (mbomHeaderId) {
              const visitedMBomIds = new Set([mbomHeaderId]); // guard circular reference
              const mbomExploded = await explodeMBOM(
                tx,
                runNumber,
                mbomHeaderId,
                productionExplosionQty,
                productionDates.materialRequiredDate,
                1, // Start from level 1
                visitedMBomIds,
                dependentProjectedAvailableMap,
                dependentProjectedActualAvailableMap,
                dependentProjectedAllocatedMap,
                mbomHeaderByPartCode,
                uomCodeByPartCode,
                {
                  excludePlanNumbers: soOnlyPlanNumbersInScope,
                  excludeSourceMpsNumbers: sourceMpsNumbers,
                  projectedMppSupplyMap: dependentProjectedMppSupplyMap,
                  projectedMoSupplyMap: dependentProjectedMoSupplyMap,
                  initialAvailableMap: purchaseInitialAvailableMap,
                  initialActualAvailableMap: purchaseInitialActualAvailableMap,
                  initialAllocatedMap: purchaseInitialAllocatedMap,
                  initialStockAvailableMap: purchaseInitialStockAvailableMap,
                  targetedReservationPool,
                  formulas,
                  includeZeroNetForecastTree: isMPlusOnePreview,
                  ignoreFirmSupply: isMPlusOnePreview,
                  parentBufferPercent: Number(mpsDetail.bufferPercent ?? mpsDetail.part?.bufferStock ?? 0),
                  // Forecast dan buffer harus tetap terpisah di setiap level BOM.
                  // Quantity produksi boleh sudah termasuk buffer, tetapi kolom
                  // Forecast MRP tidak boleh berubah menjadi Forecast + Buffer.
                  forecastDemandQty: forecastQty,
                  parentBufferBaseQty: Number(mpsDetail.bufferBaseQty || 0),
                  parentBufferQty: Number(mpsDetail.bufferQty || 0),
                  actualSalesOrderQty: Math.min(
                    Number(soQtyInBucket || 0),
                    Number(productionExplosionQty || 0),
                  ),
                  consumptionSources: soConsumption.sources,
                  mpsDetailId: mpsDetail.id,
                  parentRequirementId: requirement.id,
                  rootRequirementId: requirement.rootRequirementId,
                  parentTreePath: requirement.treePath,
                  parentRequiredDate: requirement.requiredDate,
                  rootDemandSourceType: requirement.rootDemandSourceType,
                  rootDemandSourceNumber: requirement.rootDemandSourceNumber,
                  deliveryTargetId: requirement.deliveryTargetId,
                  customerCode: requirement.customerCode,
                  fgPartCode: requirement.fgPartCode,
                  targetDeliveryDate: requirement.targetDeliveryDate,
                  priorityScore: requirement.priorityScore,
                  priorityClass: requirement.priorityClass,
                  customerPegging: requirement.customerPegging,
                },
              );

              requirements.push(...mbomExploded.requirements);
            }
          }
        }

        // Keep actualSalesOrderQty immutable on the approved monthly MPS.
        // soConsumedByMpsDetail is persisted on MRPRequirement/pegging and may
        // include earlier outstanding buckets inside a wider MRP cutoff.

        // Sisa SO demand yang tidak tercakup MPS tetap harus masuk MRP.
        // Ini menjaga flow SO -> MRP -> PlannedOrder untuk part make-to-order.
        const remainingSoDemandRows = collectRemainingSoDemandRows(openSoDemandByPart);
        for (const [soDemandIndex, soDemand] of remainingSoDemandRows.entries()) {
          const fgPartCode = normalizePartCode(soDemand.partCode);
          if (!fgPartCode) continue;
          if (soDemand.uomCode && !uomCodeByPartCode[fgPartCode]) {
            uomCodeByPartCode[fgPartCode] = soDemand.uomCode;
          }

          let partId = soDemand.partId || null;
          let partBufferStock = 0;
          if (!partId) {
            const part = await tx.part.findUnique({
              where: { partCode: fgPartCode },
              select: { id: true, bufferStock: true },
            });
            partId = part?.id || null;
            partBufferStock = Number(part?.bufferStock || 0);
          } else {
            const part = await tx.part.findUnique({
              where: { id: partId },
              select: { bufferStock: true },
            });
            partBufferStock = Number(part?.bufferStock || 0);
          }

          let mbomHeaderId = null;
          let leadTimeDays = 0;
          if (partId) {
            const activeMbom = await findActiveMbomHeader(tx, partId, soDemand.dueDate);
            mbomHeaderId = activeMbom?.id || null;
            if (activeMbom?.uomCode && !uomCodeByPartCode[fgPartCode]) {
              uomCodeByPartCode[fgPartCode] = activeMbom.uomCode;
            }
            leadTimeDays = await resolveMbomLeadTimeDays(tx, mbomHeaderId);
          }

          if (mbomHeaderId) {
            mbomHeaderByPartCode[fgPartCode] = mbomHeaderId;
          }

          const orderDate = new Date(soDemand.dueDate);
          orderDate.setDate(orderDate.getDate() - leadTimeDays);
          const requirement = {
            ...createRequirementIdentity(),
            runNumber,
            treePath: buildRequirementTreePath(null, 0, soDemandIndex + 1),
            levelMBOM: 0,
            mbomLevelComponent: 0,
            mbomDetailId: null,
            partCode: fgPartCode,
            partId,
            requirementType: "Independent",
            sourceType: "SO",
            sourceNumber: soDemand.sourceNumber,
            mpsDetailId: null,
            requiredDate: soDemand.dueDate,
            grossRequirement: soDemand.remainingQty,
            forecastQty: 0,
            soConsumedQty: soDemand.remainingQty,
            effectiveDemandQty: soDemand.remainingQty,
            consumptionSources: [`${soDemand.sourceNumber}:${Number(soDemand.remainingQty || 0)}`],
            onHandQty: 0,
            allocatedQty: 0,
            netRequirement: 0,
            plannedOrderQty: 0,
            orderType: mbomHeaderId ? "Production" : "Purchase",
            leadTime: leadTimeDays,
            orderDate,
            notes: null,
            _partBufferPercent: partBufferStock,
            _productionScheduleQty: soDemand.remainingQty,
          };

          const availableBefore = projectedAvailableMap[fgPartCode] || 0;
          const actualOnHandBefore = stockPositionMaps.onHand[fgPartCode] || 0;
          const allocatedQty = stockAllocatedMap[fgPartCode] || 0;
          requirement.onHandQty = actualOnHandBefore;
          requirement.allocatedQty = allocatedQty;
          requirement.netRequirement = evaluateFromSet(formulas, "MRP_NET_REQUIREMENT", {
            grossRequirement: requirement.grossRequirement,
            projectedAvailable: availableBefore,
          });
          requirement.plannedOrderQty = requirement.netRequirement;
          if (requirement.orderType === "Purchase" && purchaseInitialAvailableMap[fgPartCode] === undefined) {
            purchaseInitialAvailableMap[fgPartCode] = availableBefore;
            purchaseInitialActualAvailableMap[fgPartCode] = actualOnHandBefore;
            purchaseInitialAllocatedMap[fgPartCode] = allocatedQty;
          }
          const mppAvailableBefore = Number(projectedMppSupplyMap[fgPartCode] || 0);
          const moAvailableBefore = Number(projectedMoSupplyMap[fgPartCode] || 0);
          const nonProductionDriverAvailableBefore = Math.max(
            availableBefore - mppAvailableBefore - moAvailableBefore,
            0,
          );
          const mppDrivenQty = Math.min(
            mppAvailableBefore,
            Math.max(requirement.grossRequirement - nonProductionDriverAvailableBefore, 0),
          );
          const moDrivenQty = Math.min(
            moAvailableBefore,
            Math.max(requirement.grossRequirement - nonProductionDriverAvailableBefore - mppDrivenQty, 0),
          );
          const productionExplosionQty = requirement.plannedOrderQty + mppDrivenQty + moDrivenQty;
          requirement._productionScheduleQty = productionExplosionQty;

          projectedAvailableMap[fgPartCode] = Math.max(
            availableBefore - requirement.grossRequirement,
            0,
          );
          projectedMppSupplyMap[fgPartCode] = Math.max(
            mppAvailableBefore - mppDrivenQty,
            0,
          );
          projectedMoSupplyMap[fgPartCode] = Math.max(
            moAvailableBefore - moDrivenQty,
            0,
          );

          requirements.push(requirement);
          if (requirement.plannedOrderQty > 0) {
            soSourcesByRequirement.set(requirement, [
              `${soDemand.sourceNumber}:${requirement.plannedOrderQty}`,
            ]);
          }

          if (productionExplosionQty > 0 && mbomHeaderId) {
            const mbomExploded = await explodeMBOM(
              tx,
              runNumber,
              mbomHeaderId,
              productionExplosionQty,
              soDemand.dueDate,
              1,
              new Set([mbomHeaderId]),
              dependentProjectedAvailableMap,
              dependentProjectedActualAvailableMap,
              dependentProjectedAllocatedMap,
              mbomHeaderByPartCode,
              uomCodeByPartCode,
              {
                excludePlanNumbers: soOnlyPlanNumbersInScope,
                excludeSourceMpsNumbers: sourceMpsNumbers,
                projectedMppSupplyMap: dependentProjectedMppSupplyMap,
                projectedMoSupplyMap: dependentProjectedMoSupplyMap,
                initialAvailableMap: purchaseInitialAvailableMap,
                initialActualAvailableMap: purchaseInitialActualAvailableMap,
                initialAllocatedMap: purchaseInitialAllocatedMap,
                initialStockAvailableMap: purchaseInitialStockAvailableMap,
                targetedReservationPool,
                formulas,
                parentBufferPercent: partBufferStock,
                forecastDemandQty: 0,
                actualSalesOrderQty: Math.min(
                  Number(soDemand.remainingQty || 0),
                  Number(productionExplosionQty || 0),
                ),
                consumptionSources: requirement.consumptionSources,
                parentRequirementId: requirement.id,
                rootRequirementId: requirement.rootRequirementId,
                parentTreePath: requirement.treePath,
                fgPartCode: requirement.fgPartCode || fgPartCode,
              },
            );
            requirements.push(...mbomExploded.requirements);
          }
        }

        // Satu explosion menghasilkan dua output yang tegas:
        // - Production (FG/child process) disinkronkan ke MPS.
        // - Purchase saja yang menjadi requirement dan planned order MRP.
        if (!isSimulation) {
          for (const document of mpsDocuments) {
            const documentDetails = rawSourceMpsDetailsByNumber.get(document.mpsNumber) || [];
            const documentDetailIds = new Set(documentDetails.map((row) => row.id));
            await syncProductionRequirementsToMps(
              tx,
              { ...document, details: documentDetails },
              requirements.filter((row) => documentDetailIds.has(row.mpsDetailId)),
              mbomHeaderByPartCode,
              runNumber,
            );
          }
        }
        const purchaseRequirements = applyNextMonthPurchaseBuffer(requirements, {
          mpsDetails: sourceMpsDetails,
                initialAvailableMap: purchaseInitialAvailableMap,
                initialActualAvailableMap: purchaseInitialActualAvailableMap,
                initialAllocatedMap: purchaseInitialAllocatedMap,
                initialStockAvailableMap: purchaseInitialStockAvailableMap,
          formulas,
        });
        const partnerMap = await buildPlannedOrderPartnerMap(
          tx,
          purchaseRequirements.map((requirement) => requirement.partCode),
        );
        const purchasingSupplyTimeline = isMPlusOnePreview
          ? []
          : await buildPurchasingSupplyTimeline(
              tx,
              purchaseRequirements,
              resolvedCutoffDate || mps.periodEnd,
              {
                excludeRunNumber: runNumber,
                uomCodeByPartCode,
                poDelayDays: isSimulation ? Number(scenarioAssumptions?.poDelayDays || 0) : 0,
              },
            );
        applyTimePhasedPurchaseNetting(purchaseRequirements, purchasingSupplyTimeline, {
          initialStockAvailableMap: purchaseInitialStockAvailableMap,
          partnerMap,
          planningConstraintByTarget,
          asOf: parseDate(planningSnapshotAt) || new Date(),
          procurementPolicy: scenarioAssumptions?.procurementPolicy || {},
        });
        for (const requirement of purchaseRequirements) {
          const supplierLeadTime = Number(partnerMap[requirement.partCode]?.leadTimeDays || 0);
          if (supplierLeadTime <= 0) continue;
          requirement.leadTime = supplierLeadTime;
          requirement.materialRequiredDate = requirement.materialRequiredDate || requirement.requiredDate;
          requirement.supplierRequiredArrivalDate = requirement.supplierRequiredArrivalDate || requirement.requiredDate;
        }
        // Persist the complete Production -> Purchase requirement tree.  The
        // generated MPS rows remain the executable production schedule, while
        // these rows preserve the netting provenance (parent, BOM ratio, WIP
        // coverage and resulting child demand) used by the formula inspector.
        // Previously only the root Production row was stored, which severed
        // parentRequirementId on every lower-level Purchase requirement.
        const productionRequirements = requirements.filter(
          (requirement) => requirement.orderType === "Production",
        );
        const persistedRequirements = stripRequirementInternals([
          ...productionRequirements,
          ...purchaseRequirements,
        ]);

        if (persistedRequirements.length > 0) {
          await tx.mRPRequirement.createMany({
            data: persistedRequirements,
          });
        }

        // Generate planned orders dari requirements (generate nomor secara berurutan)
        let poSeq = 0;
        let moSeq = 0;
        const today = new Date();
        const dateStr = today.toISOString().split("T")[0].replace(/-/g, "");

        // Cari sequence terakhir sekali di luar loop. Referensi di PR/MO/MPP ikut
        // dihitung supaya nomor planned order tidak dipakai ulang setelah PO lama dihapus.
        const [
          lastPlo,
          lastPloPrDetail,
          lastPmo,
          lastPmoMo,
          lastPmoMppDetail,
        ] = await Promise.all([
          tx.plannedOrder.findFirst({
            where: { orderNumber: { startsWith: `PLO-${dateStr}-` } },
            orderBy: { orderNumber: "desc" },
            select: { orderNumber: true },
          }),
          tx.purchaseRequisitionDetail.findFirst({
            where: { plannedOrderNumber: { startsWith: `PLO-${dateStr}-` } },
            orderBy: { plannedOrderNumber: "desc" },
            select: { plannedOrderNumber: true },
          }),
          tx.plannedOrder.findFirst({
            where: { orderNumber: { startsWith: `PMO-${dateStr}-` } },
            orderBy: { orderNumber: "desc" },
            select: { orderNumber: true },
          }),
          tx.manufacturingOrder.findFirst({
            where: { plannedOrderNumber: { startsWith: `PMO-${dateStr}-` } },
            orderBy: { plannedOrderNumber: "desc" },
            select: { plannedOrderNumber: true },
          }),
          tx.monthlyProductionPlanDetail.findFirst({
            where: { plannedOrderNumber: { startsWith: `PMO-${dateStr}-` } },
            orderBy: { plannedOrderNumber: "desc" },
            select: { plannedOrderNumber: true },
          }),
        ]);
        const extractSeq = (str) => parseInt(str?.match(/-(\d+)$/)?.[1] || "0", 10);
        poSeq = Math.max(
          extractSeq(lastPlo?.orderNumber),
          extractSeq(lastPloPrDetail?.plannedOrderNumber),
        );
        moSeq = Math.max(
          extractSeq(lastPmo?.orderNumber),
          extractSeq(lastPmoMo?.plannedOrderNumber),
          extractSeq(lastPmoMppDetail?.plannedOrderNumber),
        );
        const productionConversionPartMap = await buildProductionConversionPartMap(tx, purchaseRequirements);
        const productionMbomKgPerPcsMap = await buildProductionMbomKgPerPcsMap(
          tx,
          purchaseRequirements,
          productionConversionPartMap,
        );
        const requirementOriginalUomMap = await buildRequirementOriginalUomMap(tx, purchaseRequirements);

        for (const mrpReq of purchaseRequirements) {
          if (mrpReq.plannedOrderQty > 0) {
            // Calculate order date (required date - lead time)
            const orderDate = new Date(mrpReq.latestPrDate || mrpReq.orderDate || mrpReq.requiredDate);

            const orderType = "Purchase";
            const isProduction = orderType === "Production";

            const prefix = isProduction ? "PMO" : "PLO";
            if (isProduction) moSeq++; else poSeq++;
            const seq = isProduction ? moSeq : poSeq;
            const orderNumber = `${prefix}-${dateStr}-${String(seq).padStart(4, "0")}`;
            const sourceUomCode =
              uomCodeByPartCode[mrpReq.partCode] ||
              requirementOriginalUomMap.get(mrpReq.id) ||
              null;
            let plannedOrderQty = mrpReq.plannedOrderQty;
            let plannedOrderUomCode = sourceUomCode;
            let plannedOrderNotes = null;
            const conversionPart =
              productionConversionPartMap.get(mrpReq.partId) ||
              productionConversionPartMap.get(normalizePartCode(mrpReq.partCode)) ||
              null;

            if (isProduction) {
              const conversion = resolveProductionPlannedOrderQuantity({
                qty: mrpReq.plannedOrderQty,
                sourceUomCode: sourceUomCode || null,
                part: conversionPart,
                fallbackKgPerPcs:
                  productionMbomKgPerPcsMap.get(mrpReq.partId) ||
                  productionMbomKgPerPcsMap.get(normalizePartCode(mrpReq.partCode)),
              });
              plannedOrderQty = mrpReq.plannedOrderQty;
              plannedOrderUomCode = sourceUomCode;
              plannedOrderNotes = conversion.note
                ? `${conversion.note} Planned order qty tetap memakai original pcs; gunakan Qty (kg) untuk konversi produksi.`
                : null;
            } else if (isRawMaterialPart(conversionPart) && !isKgUom(sourceUomCode)) {
              plannedOrderNotes = "Raw material belum dikonversi ke kg karena gross weight/pitch/cavity pada MBOM belum lengkap.";
            }

            // Purchase parts with a physical piece UOM cannot be ordered as a
            // fraction. Round upward so the released supply fully covers the
            // calculated requirement; weight/length UOMs retain decimals.
            if (!isProduction && isPcsUom(plannedOrderUomCode)) {
              plannedOrderQty = normalizeReferencePcs(plannedOrderQty);
            }

            const plannedOrder = {
              orderNumber,
              runNumber,
              orderType,
              partCode: mrpReq.partCode,
              partId: mrpReq.partId || null,
              uomCode: plannedOrderUomCode || (isProduction ? null : "pcs"),
              mbomHeaderId: isProduction
                ? mrpReq.mbomHeaderId || mbomHeaderByPartCode[mrpReq.partCode] || null
                : null,
              qty: plannedOrderQty,
              requiredDate: mrpReq.requiredDate,
              orderDate,
              // Supplier is a Purchasing decision; PPIC planned orders carry demand only.
              supplierCode: null,
              supplierProposalSource: null,
              vendorCode: isProduction ? null : partnerMap[mrpReq.partCode]?.vendorCode || null,
              referenceType: "MRP",
              referenceNumber: planIdentity.planNumber || runNumber,
              status: isSimulation ? "Draft" : "Planned",
              notes: plannedOrderNotes,
            };

            plannedOrders.push(plannedOrder);

            const soSources = soSourcesByRequirement.get(mrpReq) || [];
            if (soSources.length > 0 && mrpReq.partId) {
              for (const source of soSources) {
                const parsed = parseSoConsumptionSource(source);
                if (!parsed || parsed.qty <= 0) continue;
                affectedSoNumbers.add(parsed.soNumber);
                plannedOrder.mrpPeggings = plannedOrder.mrpPeggings || [];
                plannedOrder.mrpPeggings.push({
                  demandType: "SO",
                  demandNumber: parsed.soNumber,
                  demandLineNumber: parsed.lineNumber,
                  supplyType: "PlannedOrder",
                  supplyNumber: orderNumber,
                  supplyLineNumber: null,
                  itemId: mrpReq.partId,
                  qtyPegged: parsed.qty,
                  notes: `MRP ${runNumber} pegging SO ${parsed.soNumber} line ${parsed.lineNumber}`,
                });
              }
            }
          }
        }

        // Create all planned orders
        let createdPlannedOrders = [];
        if (plannedOrders.length > 0) {
          await tx.plannedOrder.createMany({
            data: plannedOrders.map(({ mrpPeggings, ...plannedOrder }) => plannedOrder),
          });

          for (const plannedOrder of plannedOrders) {
            for (const pegging of plannedOrder.mrpPeggings || []) {
              await upsertMrpPegging(tx, pegging);
            }
          }

          // Normalisasi konsistensi referensi untuk run ini.
          // Jika ada row lama/null (mis. data historis), paksa ke pola MRP yang konsisten.
          await tx.plannedOrder.updateMany({
            where: {
              runNumber,
              isDeleted: false,
              OR: [
                { referenceType: null },
                { referenceNumber: null },
              ],
            },
            data: {
              referenceType: "MRP",
              referenceNumber: planIdentity.planNumber || runNumber,
            },
          });

          createdPlannedOrders = await tx.plannedOrder.findMany({
            where: {
              orderNumber: { in: plannedOrders.map((order) => order.orderNumber) },
            },
          });
        }

        if (!isSimulation) {
          await supersedeSoOnlyPlansCoveredByMps(
            tx,
            [...affectedSoNumbers],
            runNumber,
            planIdentity.planNumber,
            req.user?.username || "system",
          );
        }

        // Update MRP Run status
        const executionTime = Math.round((Date.now() - startTime) / 1000);
        const nettingRunSummary = buildNettingRunSummary(soDemandConsumptionSummary);
        const completedRun = await tx.mRPRun.update({
          where: { runNumber },
          data: {
            status: "Completed",
            scenarioStatus: calculationLifecycle.completedStatus,
            totalRequirements: persistedRequirements.length,
            totalPlannedOrders: plannedOrders.length,
            soDemandConsumedQty: nettingRunSummary.totalConsumedQty,
            soDemandImpactedLines: nettingRunSummary.impactedMpsLines,
            nettingSummary: nettingRunSummary,
            executionTime,
            notes: null,
          },
        });

        emitPlanningPlannedOrderBulkUpdate(createdPlannedOrders, "create", req.user?.username || "system");
        emitPlanningMrpRunUpdate(completedRun, "complete", req.user?.username || "system");

        if (!isSimulation) {
          for (const soNumber of affectedSoNumbers) {
            await syncOperationalSalesOrderStatus(tx, soNumber);
          }
        }

        const purchaseSuggestion = !isSimulation && plannedOrders.some((order) => order.orderType === "Purchase" && Number(order.qty || 0) > 0)
          ? await generatePurchaseSuggestionForRun(tx, runNumber, req.user?.username || req.user?.email || "system")
          : null;

        return {
          ...completedRun,
          purchaseSuggestionNumber: purchaseSuggestion?.suggestionNumber || null,
          soDemandConsumption: {
            ...nettingRunSummary,
            byPart: Object.entries(soDemandConsumptionSummary.byPart).map(
              ([partCode, value]) => ({
                partCode,
                consumedQty: Number(value.consumedQty || 0),
                sources: value.sources,
              }),
            ),
          },
        };
      } catch (error) {
        // Update status to Failed on error
        const failedRun = await tx.mRPRun.update({
          where: { runNumber },
          data: {
            status: "Failed",
            errorMessage: error.message,
          },
        });
        emitPlanningMrpRunUpdate(failedRun, "fail", req.user?.username || "system");
        throw error;
      }
    }, {
      timeout: 120000, // 2 minutes timeout for MRP calculation
    });

    res.status(201).json(mapDoc(result));
  } catch (e) {
    next(e);
  }
};

exports.runDeltaMRP = (req, res, next) => {
  req.body = { ...(req.body || {}), planKind: "DELTA", planningMode: "OFFICIAL" };
  return exports.runMRP(req, res, next);
};

exports.approve = async (req, res, next) => {
  try {
    const runNumber = req.params.runNumber;
    const actor = req.user?.username || req.user?.email || "system";
    const run = await prisma.mRPRun.findFirst({ where: { runNumber, isDeleted: false } });
    if (!run) return res.status(404).json({ message: "MRP run tidak ditemukan." });

    const eligibility = mrpApprovalEligibility(run);
    if (!eligibility.allowed) {
      const messages = {
        LOOKAHEAD_PREVIEW_NOT_APPROVABLE: "Preview M+1 hanya untuk look-ahead dan tidak dapat di-approve menjadi MRP official.",
        MRP_ALREADY_APPROVED: "MRP run ini sudah Approved dan menjadi current plan.",
        MRP_NOT_SIMULATED: "MRP harus selesai dihitung dan berstatus Simulated sebelum approval.",
      };
      return res.status(409).json({ code: eligibility.code, message: messages[eligibility.code] || "MRP belum dapat di-approve." });
    }

    const approvalCycleMpsNumbers = mrpApprovalCycleMpsNumbers(run);
    const sourceMpsNumbers = approvalCycleMpsNumbers;

    const result = await prisma.$transaction(async (tx) => {
      const snapshot = await tx.mRPRun.findUnique({
        where: { runNumber },
        include: {
          requirements: { where: { isDeleted: false }, include: { part: { select: { itemType: true } } } },
          plannedOrders: { where: { isDeleted: false } },
        },
      });
      const currentEligibility = mrpApprovalEligibility(snapshot || {});
      if (!snapshot || !currentEligibility.allowed) throw Object.assign(new Error("MRP working revision sudah berubah. Muat ulang halaman sebelum approval."), { statusCode: 409 });
      const isDeltaApproval = String(snapshot.planKind || "BASELINE").toUpperCase() === "DELTA";

      const [sourceMps, approvalCycleMps] = await Promise.all([
        tx.mPS.findMany({
          where: { mpsNumber: { in: sourceMpsNumbers }, isDeleted: false },
          include: { details: { where: { isDeleted: false } } },
          orderBy: { periodStart: "asc" },
        }),
        tx.mPS.findMany({
          where: { mpsNumber: { in: approvalCycleMpsNumbers }, isDeleted: false },
          orderBy: { periodStart: "asc" },
        }),
      ]);
      if (sourceMps.length !== sourceMpsNumbers.length) throw Object.assign(new Error("Sebagian source MPS snapshot sudah tidak tersedia."), { statusCode: 409, code: "MPS_SOURCE_NOT_FOUND" });
      if (approvalCycleMps.length !== approvalCycleMpsNumbers.length) throw Object.assign(new Error("Sebagian MPS dalam planning cycle sudah tidak tersedia."), { statusCode: 409, code: "MPS_CYCLE_SOURCE_NOT_FOUND" });
      if (!mrpSourceSnapshotMatches(snapshot.scenarioAssumptions || {}, approvalCycleMps)) {
        throw Object.assign(new Error("Source MPS atau keputusan delivery berubah setelah MRP dihitung. Hitung revision MRP baru sebelum approval."), {
          statusCode: 409,
          code: "MRP_SOURCE_SNAPSHOT_CHANGED",
        });
      }
      const unlockedMps = isDeltaApproval ? null : approvalCycleMps.find((row) => !["Confirmed", "Released"].includes(row.status));
      if (unlockedMps) throw Object.assign(new Error(`${unlockedMps.mpsNumber} harus Confirmed/Released sebelum MRP di-approve.`), { statusCode: 409, code: "MPS_CYCLE_NOT_LOCKED" });
      const replanMps = approvalCycleMps.find((row) => row.replanRequired);
      if (replanMps) throw Object.assign(new Error(replanMps.replanReason || `${replanMps.mpsNumber} harus dihitung ulang sebelum MRP di-approve.`), { statusCode: 409, code: "DEMAND_REPLAN_REQUIRED" });
      if (!isDeltaApproval) await assertOfficialMpsDeliveryGate(tx, approvalCycleMps);

      const promoted = await tx.mRPRun.updateMany({
        where: { runNumber, isDeleted: false, status: "Completed", scenarioStatus: { in: ["SIMULATION", "SIMULATED"] }, isCurrentPlan: false },
        data: mrpApprovalTransitionData(snapshot, actor),
      });
      if (promoted.count !== 1) throw Object.assign(new Error("MRP working revision sudah berubah atau diproses oleh pengguna lain."), { statusCode: 409, code: "MRP_APPROVAL_CONFLICT" });

      await tx.mRPRun.updateMany({
        where: { ...currentScopeWhere(snapshot), runNumber: { not: runNumber }, isDeleted: false, isCurrentPlan: true },
        data: { isCurrentPlan: false, scenarioStatus: "SUPERSEDED" },
      });
      if (String(snapshot.planKind || "BASELINE").toUpperCase() === "BASELINE") {
        await attachBaselineMrp(tx, { baselineMpsNumber: snapshot.mpsNumber, baselineMrpNumber: runNumber, actor });
      }

      const residualReplan = await supersedePreviousMrpArtifacts(tx, sourceMpsNumbers, runNumber, actor);
      if (residualReplan?.mode === "RESIDUAL_REPLAN_PRESERVE_EXECUTION") {
        await tx.mRPRun.update({
          where: { runNumber },
          data: {
            scenarioAssumptions: {
              ...(snapshot.scenarioAssumptions && typeof snapshot.scenarioAssumptions === "object" ? snapshot.scenarioAssumptions : {}),
              residualReplan: {
                mode: residualReplan.mode,
                previousRunNumbers: residualReplan.previousRunNumbers,
                protectedPlannedOrderNumbers: residualReplan.protectedPlannedOrderNumbers,
                protectedExecutionCount: residualReplan.protectedExecutionCount,
                supersededPlannedOrderNumbers: residualReplan.supersededPlannedOrderNumbers,
                approvedAt: new Date().toISOString(),
                approvedBy: actor,
              },
            },
          },
        });
      }
      await retirePreviousPlanRevisions(tx, snapshot.planNumber, runNumber);

      const productionRequirements = snapshot.requirements
        .filter((row) => row.orderType === "Production")
        .map((row) => ({
          ...row,
          _partItemType: row.part?.itemType || null,
          _productionScheduleQty: Number(row.plannedOrderQty || productionProcessScheduleQty(row)),
          _processScheduleQty: Number(row.plannedOrderQty || productionProcessScheduleQty(row)),
        }));
      const mbomHeaderByPartCode = {};
      for (const requirement of productionRequirements) {
        if (mbomHeaderByPartCode[requirement.partCode]) continue;
        const header = await findActiveMbomHeader(tx, requirement.partId, requirement.requiredDate);
        if (header?.id) mbomHeaderByPartCode[requirement.partCode] = header.id;
      }
      for (const document of sourceMps) {
        const detailIds = new Set(document.details.map((row) => row.id));
        await syncProductionRequirementsToMps(
          tx,
          document,
          productionRequirements.filter((row) => detailIds.has(row.mpsDetailId)),
          mbomHeaderByPartCode,
          runNumber,
        );
      }

      const plannedOrderNumbers = snapshot.plannedOrders.map((row) => row.orderNumber).filter(Boolean);
      const soPeggings = plannedOrderNumbers.length ? await tx.mRPPegging.findMany({
        where: { supplyType: "PlannedOrder", supplyNumber: { in: plannedOrderNumbers }, demandType: "SO", status: "Active" },
        select: { demandNumber: true },
      }) : [];
      const affectedSoNumbers = [...new Set(soPeggings.map((row) => row.demandNumber).filter(Boolean))];

      await tx.plannedOrder.updateMany({
        where: { runNumber, isDeleted: false, status: { in: ["Draft", "Simulation"] } },
        data: { status: "Planned" },
      });
      await supersedeSoOnlyPlansCoveredByMps(tx, affectedSoNumbers, runNumber, snapshot.planNumber, actor);

      const approvedRun = await tx.mRPRun.findUnique({ where: { runNumber } });
      await tx.mPS.updateMany({
        where: { mpsNumber: { in: sourceMpsNumbers }, isDeleted: false },
        data: { lifecycleStatus: "RELEASED", simulationOnly: false, replanRequired: false, replanReason: null },
      });
      for (const soNumber of affectedSoNumbers) await syncOperationalSalesOrderStatus(tx, soNumber);

      const hasPurchaseOrder = snapshot.plannedOrders.some((row) => row.orderType === "Purchase" && Number(row.qty || 0) > 0);
      const purchaseSuggestion = hasPurchaseOrder
        ? await generatePurchaseSuggestionForRun(tx, runNumber, actor)
        : null;
      return { ...approvedRun, residualReplan, purchaseSuggestionNumber: purchaseSuggestion?.suggestionNumber || null };
    }, { timeout: 120000, isolationLevel: "Serializable" });

    emitPlanningMrpRunUpdate(result, "approve", actor);
    res.json(mapDoc(result));
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ code: error.code, message: error.message });
    next(error);
  }
};

// ============================================
// HELPER: EXPLODE MBOM
// ============================================
const MAX_MBOM_DEPTH = 10;

function shouldExplodeNestedMbom({
  childExplosionQty = 0,
  forecastQty = 0,
  includeZeroNetForecastTree = false,
} = {}) {
  return Number(childExplosionQty || 0) > 0
    || (Boolean(includeZeroNetForecastTree) && Number(forecastQty || 0) > 0);
}

async function explodeMBOM(
  tx,
  runNumber,
  mbomHeaderId,
  quantity,
  requiredDate,
  level,
  visitedMBomIds = new Set(),
  projectedAvailableMap = {},
  projectedActualAvailableMap = {},
  projectedAllocatedMap = {},
  mbomHeaderByPartCode = {},
  uomCodeByPartCode = {},
  options = {},
) {
  const requirements = [];

  // Guard: max depth untuk hindari MBOM yang terlalu dalam / infinite loop
  if (level > MAX_MBOM_DEPTH) {
    console.warn(`[MRP] explodeMBOM: max depth ${MAX_MBOM_DEPTH} tercapai di mbomHeaderId=${mbomHeaderId}`);
    return { requirements };
  }

  // Get BOM details
  const mbomHeader = await tx.mBOMHeader.findFirst({
    where: {
      id: mbomHeaderId,
      isDeleted: false,
      ...buildMbomValidityWhere(requiredDate),
    },
    include: {
      part: {
        select: {
          partCode: true,
          itemType: true,
        },
      },
      details: {
        where: { isDeleted: false },
        include: {
          part: {
            include: {
              partBases: { select: { baseOn: true, grossWeight: true } },
              material: { select: { materialCode: true, materialName: true, materialForm: true } },
            },
          },
          mbomProcesses: {
            where: { isDeleted: false },
            select: { routingMode: true, sequence: true, vendor: { select: { vendorCode: true, leadTimeDays: true } } },
          },
        },
        orderBy: [{ levelComponent: "asc" }, { createdAt: "asc" }],
      },
    },
  });

  if (!mbomHeader || !mbomHeader.details || mbomHeader.details.length === 0) {
    return { requirements };
  }

  // Skip BOMDetail yang tidak punya part (partId null)
  const validDetails = sortMbomDetailsParentFirst(
    mbomHeader.details.filter((d) => d.part != null),
  );
  if (validDetails.length === 0) return { requirements };
  const materialPlanningRules = buildMaterialPlanningRules(validDetails);
  const requirementIdByMbomDetailId = new Map();
  // Net output of a parent process becomes the gross driver of its direct
  // children. This produces a true level-by-level cascade:
  // parent target -> subtract parent stock -> child gross target.
  const netOutputQtyByMbomDetailId = new Map();
  const childSequenceByParentId = new Map();
  const projectedMppSupplyMap = options.projectedMppSupplyMap || {};
  const projectedMoSupplyMap = options.projectedMoSupplyMap || {};

  // Batch fetch stock balances untuk semua part sekaligus (hindari N+1 query)
  const allPartCodes = [...new Set(validDetails.map((d) => d.part.partCode))];
  const partByCode = new Map(validDetails.map((detail) => [normalizePartCode(detail.part.partCode), detail.part]));
  const unresolvedPartCodes = allPartCodes.filter(
    (code) => projectedAvailableMap[planningStockKey(code, partByCode.get(normalizePartCode(code)))] === undefined,
  );
  if (unresolvedPartCodes.length > 0) {
    const materialIds = [...new Set(unresolvedPartCodes.map((code) => partByCode.get(code)?.materialId).filter(Boolean))];
    const materialCodes = [...new Set(unresolvedPartCodes.map((code) => partByCode.get(code)?.material?.materialCode).filter(Boolean))];
    const stockLookupPartCodes = unresolvedPartCodes;
    const stockBalances = await tx.stockBalance.findMany({
      where: {
        AND: [
          {
            OR: [
              { partCode: { in: stockLookupPartCodes } },
              ...(materialIds.length ? [{ materialId: { in: materialIds } }] : []),
              ...(materialCodes.length ? [{ materialCode: { in: materialCodes } }] : []),
            ],
          },
          { isDeleted: false },
          buildExcludeSpecialRackCondition(),
        ],
      },
      select: {
        partCode: true,
        materialId: true,
        materialCode: true,
        stockType: true,
        uomCode: true,
        qtyOnHand: true,
        qtyReserved: true,
        qtyQC: true,
        qtyAvailable: true,
      },
    });
    const stockPartCodes = [...new Set(stockBalances.map((row) => normalizePartCode(row.partCode)).filter(Boolean))];
    const stockParts = stockPartCodes.length ? await tx.part.findMany({
      where: { partCode: { in: stockPartCodes }, isDeleted: false },
      select: {
        partCode: true,
        partName: true,
        itemType: true,
        materialId: true,
        material: { select: { materialCode: true } },
        partBases: { select: { baseOn: true, grossWeight: true } },
      },
    }) : [];
    const stockPartByCode = new Map(stockParts.map((part) => [normalizePartCode(part.partCode), part]));
    const supplyMap = options.ignoreFirmSupply ? {} : await buildOpenSupplyMap(
      tx,
      unresolvedPartCodes,
      requiredDate,
      {
        excludeRunNumbers: [runNumber],
        excludePlanNumbers: options.excludePlanNumbers || [],
        excludeSourceMpsNumbers: options.excludeSourceMpsNumbers,
        excludeSourceMpsNumber: options.excludeSourceMpsNumber,
        ...materialPlanningRules,
      },
    );
    const mppSupplyMap = options.ignoreFirmSupply ? {} : await buildOpenMppSupplyMap(tx, unresolvedPartCodes, requiredDate, {
      excludeSourceMpsNumbers: options.excludeSourceMpsNumbers,
      excludeSourceMpsNumber: options.excludeSourceMpsNumber,
    });
    const moSupplyMap = options.ignoreFirmSupply ? {} : await buildOpenMoSupplyMap(tx, unresolvedPartCodes, requiredDate);
    for (const partCode of unresolvedPartCodes) {
      const part = partByCode.get(partCode);
      const stockKey = planningStockKey(partCode, part);
      const materialId = part?.materialId || null;
      const materialCode = String(part?.material?.materialCode || "").trim().toUpperCase();
      const rowsForPart = stockBalances.filter((row) => {
        const sourceCode = normalizePartCode(row.partCode);
        const sourcePart = stockPartByCode.get(sourceCode);
        const sourceMaterialId = sourcePart?.materialId || row.materialId;
        const sourceMaterialCode = String(sourcePart?.material?.materialCode || row.materialCode || "").trim().toUpperCase();
        return sourceCode === partCode
          || (materialId && sourceMaterialId === materialId)
          || (materialCode && sourceMaterialCode === materialCode);
      }).map((row) => ({
        // Normalize the physical stock identity of this requirement. WIP/FG
        // coverage is already cascaded through each production level and must
        // not be counted again as raw-material stock here.
        ...normalizeStockRowForRequirement(
          row,
          part,
          materialPlanningRules.planningUomByPartCode[partCode],
          materialPlanningRules.kgPerQtyByPartCode[partCode],
          stockPartByCode,
        ),
        partCode,
      }));
      const stockForPart = buildStockPositionMaps(rowsForPart);
      const itemType = String(part?.itemType || "").trim().toUpperCase();
      const isProductionPart = ["FG", "WIP", "SFG"].includes(itemType);
      const rawMaterialPlanning = isRawMaterialPart(part);
      const stockQty = rawMaterialPlanning
        ? rowsForPart.reduce(
            (sum, row) => sum + Number(
              row.supplyClass === "WIP_EQUIVALENT"
                ? row.qtyOnHand
                : row.qtyAvailable,
            ),
            0,
          )
        : isProductionPart
          ? Number(stockForPart.onHand[partCode] || 0)
          : Number(stockForPart.available[partCode] || 0);
      if (options.initialStockAvailableMap && options.initialStockAvailableMap[stockKey] === undefined) {
        options.initialStockAvailableMap[stockKey] = stockQty;
      }
      projectedAvailableMap[stockKey] = stockQty + Number(supplyMap[partCode] || 0);
      projectedActualAvailableMap[stockKey] = rawMaterialPlanning
        ? rowsForPart.reduce((sum, row) => sum + Number(row.qtyOnHand || 0), 0)
        : stockQty;
      projectedAllocatedMap[stockKey] = Number(stockForPart.allocated[partCode] || 0);
      projectedMppSupplyMap[partCode] = Number(mppSupplyMap[partCode] || 0);
      projectedMoSupplyMap[partCode] = Number(moSupplyMap[partCode] || 0);
    }
  }

  for (const detail of validDetails) {
    const partCode = detail.part.partCode;
    const normalizedPartCode = normalizePartCode(partCode);
    const stockKey = planningStockKey(normalizedPartCode, detail.part);
    const kgPerQty = Number(materialPlanningRules.kgPerQtyByPartCode[normalizedPartCode] || 0);
    const planRawMaterialInKg = materialPlanningRules.planningUomByPartCode[normalizedPartCode] === "kg";
    const parentOutputMap = netOutputQtyByMbomDetailId;
    const parentOutputQty = detail.parentDetailId && parentOutputMap.has(detail.parentDetailId)
      ? Number(parentOutputMap.get(detail.parentDetailId) || 0)
      : Number(quantity || 0);
    // Every direct child follows the parent's net production driver. Using a
    // gross parent for raw material while also netting WIP at prior levels
    // double-counts WIP coverage and understates purchasing.
    const effectiveDemandQty = Number(detail.qty || 0) * parentOutputQty * (planRawMaterialInKg ? kgPerQty : 1);
    const forecastQty = Number(detail.qty || 0)
      * Number(options.forecastDemandQty ?? quantity ?? 0)
      * (planRawMaterialInKg ? kgPerQty : 1);
    const bufferBaseQty = Number(detail.qty || 0)
      * Number(options.parentBufferBaseQty || 0)
      * (planRawMaterialInKg ? kgPerQty : 1);
    const bufferPercent = Number(options.parentBufferPercent || 0);
    const bufferQty = Number(detail.qty || 0)
      * Number(options.parentBufferQty || 0)
      * (planRawMaterialInKg ? kgPerQty : 1);
    const actualSalesOrderQty = Number(detail.qty || 0)
      * Number(options.actualSalesOrderQty || 0)
      * (planRawMaterialInKg ? kgPerQty : 1);
    // Buffer purchase dihitung setelah seluruh bulan selesai diexplode, karena
    // bucket bulan A membutuhkan forecast hasil explosion bulan A+1.
    const grossRequirement = effectiveDemandQty;
    const detailUomCode = planRawMaterialInKg ? "kg" : detail.uomCode || null;
    if (partCode && detailUomCode) {
      uomCodeByPartCode[partCode] = detailUomCode;
    }
    const freeAvailableBefore = Number(projectedAvailableMap[stockKey] || 0);
    const targetCandidates = [...new Set([
      normalizePartCode(detail.part?.partCode),
      normalizePartCode(mbomHeader.part?.partCode),
      normalizePartCode(options.fgPartCode),
    ].filter(Boolean))];
    let targetedReservationKey = null;
    let targetedReservedBefore = 0;
    for (const targetPartCode of targetCandidates) {
      const key = `${stockKey}|${targetPartCode}`;
      const qty = Number(options.targetedReservationPool?.[key] || 0);
      if (qty > 0) {
        targetedReservationKey = key;
        targetedReservedBefore = qty;
        break;
      }
    }
    const availableBefore = freeAvailableBefore + targetedReservedBefore;
    const actualAvailableBefore = projectedActualAvailableMap[stockKey] || 0;
    const onHandQty = actualAvailableBefore;
    const allocatedQty = isRawMaterialPart(detail.part)
      ? targetedReservedBefore
      : targetedReservedBefore || projectedAllocatedMap[stockKey] || 0;
    const netRequirement = evaluateFromSet(options.formulas, "MRP_NET_REQUIREMENT", {
      grossRequirement,
      projectedAvailable: availableBefore,
    });

    // Kurangi projected stock komponen agar demand berikutnya tidak pakai stok awal yang sama.
    const targetedReservedUsed = Math.min(targetedReservedBefore, grossRequirement);
    if (targetedReservationKey) {
      options.targetedReservationPool[targetedReservationKey] = Math.max(targetedReservedBefore - targetedReservedUsed, 0);
    }
    const freeStockUsed = Math.max(grossRequirement - targetedReservedUsed, 0);
    projectedAvailableMap[stockKey] = Math.max(freeAvailableBefore - freeStockUsed, 0);
    projectedActualAvailableMap[stockKey] = Math.max(
      actualAvailableBefore - grossRequirement,
      0,
    );

    const isSubAssembly = isSubAssemblyDetail(detail);
    // MBOM Vendor/inHouse is a production route; only SUB_ASSEMBLY creates separate planned supply.
    const orderType = ["inHouse", "Vendor"].includes(detail.category)
      ? "Production"
      : "Purchase";
    const plannedOrderQty = orderType === "Production" && !isSubAssembly
      ? 0
      : netRequirement;
    // Firm MPP/MO menutup planned supply parent, tetapi produksi tersebut tetap
    // membutuhkan material pada BOM anak. Pisahkan scheduled-production driver
    // dari stock fisik agar net tidak diduplikasi dan explosion tidak berhenti.
    const mppAvailableBefore = orderType === "Production"
      ? Number(projectedMppSupplyMap[partCode] || 0)
      : 0;
    const moAvailableBefore = orderType === "Production"
      ? Number(projectedMoSupplyMap[partCode] || 0)
      : 0;
    const nonProductionDriverAvailableBefore = Math.max(
      availableBefore - mppAvailableBefore - moAvailableBefore,
      0,
    );
    const mppDrivenQty = orderType === "Production"
      ? Math.min(
          mppAvailableBefore,
          Math.max(grossRequirement - nonProductionDriverAvailableBefore, 0),
        )
      : 0;
    const moDrivenQty = orderType === "Production"
      ? Math.min(
          moAvailableBefore,
          Math.max(grossRequirement - nonProductionDriverAvailableBefore - mppDrivenQty, 0),
        )
      : 0;
    const productionNetDriverQty = isSubAssembly ? plannedOrderQty : netRequirement;
    const productionExplosionQty = orderType === "Production"
      ? productionNetDriverQty + mppDrivenQty + moDrivenQty
      : 0;
    projectedMppSupplyMap[partCode] = Math.max(mppAvailableBefore - mppDrivenQty, 0);
    projectedMoSupplyMap[partCode] = Math.max(moAvailableBefore - moDrivenQty, 0);

    // Calculate lead time and order date
    const leadTime = durationToWorkingDays(detail.leadTime, detail.leadTimeUnit);
    const orderDate = new Date(requiredDate);
    orderDate.setDate(orderDate.getDate() - leadTime);
    const vendorLeadTimeDays = (detail.mbomProcesses || [])
      .filter((route) => String(route.routingMode || "").toUpperCase() === "VENDOR"
        || (String(detail.category || "").toUpperCase() === "VENDOR" && Boolean(route.vendorId || route.vendor)))
      .reduce((max, route) => Math.max(max, Number(route.vendor?.leadTimeDays || detail.leadTime || 0)), 0);
    const vendorReturnDate = vendorLeadTimeDays > 0 ? new Date(requiredDate) : null;
    const vendorSendDate = vendorReturnDate ? new Date(vendorReturnDate.getTime() - vendorLeadTimeDays * 86400000) : null;

    // levelMBOM = level rekursi saat ini (ditentukan oleh kedalaman BOM explosion)
    // level=1 → komponen langsung FG, level=2 → sub-komponen dari inHouse, dst
    const absoluteLevel = level;
    const parentRequirementId =
      (detail.parentDetailId && requirementIdByMbomDetailId.get(detail.parentDetailId)) ||
      options.parentRequirementId ||
      null;
    const parentTreePath =
      (detail.parentDetailId && requirements.find(
        (row) => row.id === requirementIdByMbomDetailId.get(detail.parentDetailId),
      )?.treePath) ||
      options.parentTreePath ||
      null;
    const parentSequenceKey = parentRequirementId || "__ROOT__";
    const siblingSequence = Number(childSequenceByParentId.get(parentSequenceKey) || 0) + 1;
    childSequenceByParentId.set(parentSequenceKey, siblingSequence);
    const requirementIdentity = createRequirementIdentity(
      parentRequirementId,
      options.rootRequirementId || parentRequirementId,
    );

    // levelComponent is relative to this MBOM header. The owning sub-assembly
    // supplies the offset for nested headers.
    const componentLevel =
      Number(options.parentComponentLevel || 0) +
      Math.max(Number(detail.levelComponent || 1), 1);

    const requirement = {
      ...requirementIdentity,
      runNumber,
      treePath: buildRequirementTreePath(
        parentTreePath,
        componentLevel,
        siblingSequence,
      ),
      levelMBOM: componentLevel,
      mbomLevelComponent: componentLevel,
      mbomDetailId: detail.id,
      partCode: detail.part.partCode,
      partId: detail.part.id,
      requirementType: "Dependent",
      sourceType: "MBOM",
      sourceNumber: mbomHeader.noReg,
      rootDemandSourceType: options.rootDemandSourceType || null,
      rootDemandSourceNumber: options.rootDemandSourceNumber || null,
      deliveryTargetId: options.deliveryTargetId || null,
      customerCode: options.customerCode || null,
      fgPartCode: options.fgPartCode || null,
      targetDeliveryDate: options.targetDeliveryDate || null,
      parentRequiredDate: options.parentRequiredDate || requiredDate,
      materialRequiredDate: orderType === "Purchase" ? requiredDate : orderDate,
      productionRequiredDate: orderType === "Production" ? requiredDate : null,
      supplierRequiredArrivalDate: orderType === "Purchase" ? requiredDate : null,
      vendorSendDate,
      vendorReturnDate,
      priorityScore: options.priorityScore ?? null,
      priorityClass: options.priorityClass || null,
      customerPegging: options.customerPegging || null,
      requiredDate,
      grossRequirement,
      // Inherit buffer from the parent FG/MPS and scale it using the BOM
      // quantity. This keeps MRP detail consistent with MPS without adding the
      // same buffer a second time to grossRequirement.
      bufferBaseQty,
      bufferPercent,
      bufferQty,
      bufferOverridden: false,
      forecastQty,
      soConsumedQty: actualSalesOrderQty,
      effectiveDemandQty,
      consumptionSources: Array.isArray(options.consumptionSources)
        ? options.consumptionSources
        : [],
      onHandQty,
      allocatedQty,
      netRequirement,
      plannedOrderQty,
      orderType,
      mpsDetailId: options.mpsDetailId || null,
      leadTime,
      orderDate,
      notes: targetedReservedUsed > 0
        ? `Manual stock reservation ${targetedReservedUsed} untuk ${targetedReservationKey?.split("|").pop() || options.fgPartCode || "part"}`
        : null,
      // Seluruh turunan BOM mewarisi buffer master parent/FG. Buffer child
      // tidak boleh mengganti policy demand dari parent plan.
      _partBufferPercent: Number(
        options.parentBufferPercent ?? detail.part?.bufferStock ?? 0,
      ),
      _partItemType: detail.part?.itemType || null,
      // Presence of mpsDetailId is the ownership marker. Customer delivery
      // phases intentionally carry bufferQty=0, but they still originate from
      // an MPS whose ending-stock policy has already been resolved. Checking
      // the numeric buffer alone made MRP add another child-material buffer.
      _bufferFromMps: Boolean(
        options.mpsDetailId || options.parentBufferQty || options.parentBufferBaseQty,
      ),
      _productionScheduleQty: orderType === "Production"
        ? productionExplosionQty
        : 0,
      // Physical stock of this exact output may cover its operation. Stock at
      // a deeper/earlier WIP stage may only stop earlier operations and raw
      // material explosion; it must not erase the transformation from that
      // stage to this output. Example: C002-C004-030 (before painting) still
      // requires the C002-C004-020 PAINT route and final inspection.
      _processScheduleQty: productionProcessScheduleQty({
        orderType,
        grossRequirement,
        onHandQty,
      }),
      _planningStockKey: stockKey,
    };

    if (orderType === "Purchase" && options.initialAvailableMap?.[stockKey] === undefined) {
      options.initialAvailableMap[stockKey] = availableBefore;
      options.initialActualAvailableMap[stockKey] = actualAvailableBefore;
      options.initialAllocatedMap[stockKey] = allocatedQty;
    }

    requirements.push(requirement);
    requirementIdByMbomDetailId.set(detail.id, requirement.id);
    netOutputQtyByMbomDetailId.set(
      detail.id,
      Math.max(Number(
        orderType === "Production"
          ? productionExplosionQty
          : netRequirement,
      ), 0),
    );

    // Inline in-house/vendor tetap harus explode ke MBOM anak agar raw material
    // pada routing berikutnya tidak hilang. Stock WIP/FG yang menutup sebagian
    // output juga harus mengurangi schedule process dan material turunannya;
    // karena itu inline memakai net requirement, bukan gross demand.
    const childExplosionQty = Math.max(productionExplosionQty, 0);
    if (shouldExplodeNestedMbom({
      childExplosionQty,
      forecastQty,
      includeZeroNetForecastTree: options.includeZeroNetForecastTree,
    })) {
      const submBom = await findActiveMbomHeader(tx, detail.part.id, orderDate);
      if (submBom) {
        mbomHeaderByPartCode[detail.part.partCode] = submBom.id;
      }

      if (submBom && !visitedMBomIds.has(submBom.id)) {
        // Guard hanya berlaku pada jalur rekursi aktif. MBOM yang sama tetap boleh
        // dipakai pada sibling lain karena demand-nya memang harus diakumulasi.
        const branchVisitedMbomIds = new Set(visitedMBomIds);
        branchVisitedMbomIds.add(submBom.id);
        const subExploded = await explodeMBOM(
          tx,
          runNumber,
          submBom.id,
          childExplosionQty,
          orderDate,
          absoluteLevel + 1,
          branchVisitedMbomIds,
          projectedAvailableMap,
          projectedActualAvailableMap,
          projectedAllocatedMap,
          mbomHeaderByPartCode,
          uomCodeByPartCode,
          {
            ...options,
            actualSalesOrderQty: Math.min(
              Number(actualSalesOrderQty || 0),
              Number(childExplosionQty || 0),
            ),
            forecastDemandQty: forecastQty,
            parentBufferBaseQty: bufferBaseQty,
            parentBufferQty: bufferQty,
            parentBufferPercent: bufferPercent,
            parentRequirementId: requirement.id,
            rootRequirementId: requirement.rootRequirementId,
            parentTreePath: requirement.treePath,
            parentComponentLevel: requirement.mbomLevelComponent,
            parentRequiredDate: requirement.requiredDate,
          },
        );
        requirements.push(...subExploded.requirements);
      } else if (submBom && visitedMBomIds.has(submBom.id)) {
        console.warn(`[MRP] Circular MBOM reference terdeteksi: mbomHeaderId=${submBom.id} sudah diproses, skip.`);
      }
    }
  }

  return { requirements };
}

// ============================================
// GET REQUIREMENTS
// ============================================
exports.getRequirements = async (req, res, next) => {
  try {
    const { runNumber: runIdentifier } = req.params;
    const { levelMBOM, partCode, orderType, page = 1, limit = 50 } = req.query;
    const runNumber = await resolveCurrentRunNumber(runIdentifier);
    if (!runNumber) {
      return res.status(404).json({ message: "MRP Run tidak ditemukan" });
    }

    const where = {
      runNumber,
      isDeleted: false,
      orderType: "Purchase",
    };

    if (levelMBOM !== undefined) {
      where.levelMBOM = Number(levelMBOM);
    }

    if (partCode) {
      where.partCode = partCode;
    }

    if (orderType && orderType !== "Purchase") {
      return res.json({ items: [], total: 0, page: Number(page), limit: Number(limit) });
    }

    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.mRPRequirement.findMany({
        where,
        include: {
          part: {
            select: {
              partCode: true,
              partNumber: true,
              partName: true,
              itemType: true,
              rawType: true,
              material: { select: { materialCode: true, materialName: true, materialForm: true } },
            },
          },
          mbomDetail: { select: { uomCode: true, grossWeight: true, category: true } },
          mpsDetail: { select: { partCode: true, customerCode: true, startDate: true, endDate: true } },
        },
        orderBy: [{ treePath: "asc" }, { createdAt: "asc" }],
        skip,
        take: Number(limit),
      }),
      prisma.mRPRequirement.count({ where }),
    ]);

    const itemsWithQtyBreakdown = await enrichRequirementQtyBreakdown(prisma, items);
    const itemsWithSupplyBreakdown = await enrichRequirementSupplyBreakdown(prisma, itemsWithQtyBreakdown);
    const groupedItems = enrichRequirementPlanningGroups(itemsWithSupplyBreakdown);

    res.json({
      items: groupedItems.map(mapDoc),
      total,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (e) {
    next(e);
  }
};

exports.procurementView = async (req, res, next) => {
  try { res.json(await procurementView(prisma, req.params.runNumber, parseDate(req.query.asOf) || new Date())); }
  catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.customerPeggingView = async (req, res, next) => {
  try { res.json(await customerPeggingView(prisma, req.params.runNumber)); }
  catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

// Read model lintas header MRP.  Header detail tetap tersedia di /:runNumber;
// endpoint ini hanya mengagregasi kebutuhan aktif per bulan/customer/part.
exports.generalSummary = async (req, res, next) => {
  try {
    const rows = await prisma.mRPRequirement.findMany({
      where: { isDeleted: false, orderType: "Purchase", mrpRun: { isDeleted: false, isCurrentPlan: true } },
      select: {
        partCode: true, requiredDate: true, grossRequirement: true, forecastQty: true,
        soConsumedQty: true, bufferQty: true, netRequirement: true, adjustedOrderQty: true,
        part: { select: { partCode: true, partNumber: true, partName: true, itemType: true, rawType: true, partType: true } },
        mrpRun: { select: { runNumber: true, mpsNumber: true, runDate: true } },
        mpsDetail: { select: { customerCode: true, startDate: true, endDate: true, mps: { select: { forecastNumber: true } } } },
      },
      orderBy: [{ requiredDate: "asc" }, { partCode: "asc" }],
      take: 20000,
    });
    const grouped = new Map();
    for (const row of rows) {
      const month = planningMonthKey(row.mpsDetail?.startDate || row.requiredDate) || "Tanpa Bulan";
      const forecastNumber = row.mpsDetail?.mps?.forecastNumber || "Tanpa Forecast";
      const customerCode = row.mpsDetail?.customerCode || "Tanpa Customer";
      const partCode = row.partCode || row.part?.partCode || "Tanpa Part";
      const key = [month, forecastNumber, customerCode, partCode].join("|");
      const current = grouped.get(key) || {
        month, forecastNumber, customerCode, partCode,
        partNumber: row.part?.partNumber || null, partName: row.part?.partName || null,
        itemType: row.part?.itemType || null, rawType: row.part?.rawType || null, partType: row.part?.partType || null,
        runNumbers: new Set(), mpsNumbers: new Set(), forecastQty: 0, actualSalesOrderQty: 0,
        bufferQty: 0, grossRequirement: 0, netRequirement: 0, adjustedOrderQty: 0,
      };
      if (row.mrpRun?.runNumber) current.runNumbers.add(row.mrpRun.runNumber);
      if (row.mrpRun?.mpsNumber) current.mpsNumbers.add(row.mrpRun.mpsNumber);
      current.forecastQty += Number(row.forecastQty || 0);
      current.actualSalesOrderQty += Number(row.soConsumedQty || 0);
      current.bufferQty += Number(row.bufferQty || 0);
      current.grossRequirement += Number(row.grossRequirement || 0);
      current.netRequirement += Number(row.netRequirement || 0);
      current.adjustedOrderQty += Number(row.adjustedOrderQty ?? row.netRequirement ?? 0);
      grouped.set(key, current);
    }
    res.json([...grouped.values()].map((row) => ({
      ...row,
      runNumbers: [...row.runNumbers],
      mpsNumbers: [...row.mpsNumbers],
    })));
  } catch (error) {
    next(error);
  }
};

exports.updateRequirementBuffer = async (req, res, next) => {
  try {
    const runNumber = await resolveCurrentRunNumber(req.params.runNumber);
    if (!runNumber) return res.status(404).json({ message: "MRP Run tidak ditemukan" });

    const requirementIds = [...new Set(
      (Array.isArray(req.body.requirementIds) ? req.body.requirementIds : [req.body.requirementId])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    )];
    const isOrderPercentUpdate = req.body.orderPercent !== undefined && req.body.orderPercent !== null && req.body.orderPercent !== "";
    const bufferPercent = Number(req.body.bufferPercent);
    const orderPercent = Number(req.body.orderPercent);
    const bufferScope = req.body.scope === "parent" ? "PARENT_FG" : "LINE";
    if (requirementIds.length === 0) {
      return res.status(400).json({ message: "Requirement yang akan diedit wajib dipilih" });
    }
    if (!isOrderPercentUpdate && (!Number.isFinite(bufferPercent) || bufferPercent < 0 || bufferPercent > 100)) {
      return res.status(400).json({ message: "Buffer stock harus di antara 0 sampai 100 persen" });
    }
    if (isOrderPercentUpdate && (!Number.isFinite(orderPercent) || orderPercent < 0 || orderPercent > 100)) {
      return res.status(400).json({ message: "Order forecast harus di antara 0 sampai 100 persen" });
    }

    await prisma.$transaction(async (tx) => {
      const formulas = await getFormulaSet(tx, "planning");
      const run = await tx.mRPRun.findFirst({
        where: { runNumber, isDeleted: false },
        select: { runNumber: true, planNumber: true, cutoffDate: true, status: true },
      });
      if (!run) throw Object.assign(new Error("MRP Run tidak ditemukan"), { status: 404 });
      if (run.status !== "Completed") {
        throw Object.assign(new Error("Adjustment hanya dapat diedit pada MRP yang sudah Completed"), { status: 409 });
      }

      const selected = await tx.mRPRequirement.findMany({
        where: {
          id: { in: requirementIds },
          runNumber,
          isDeleted: false,
          orderType: "Purchase",
        },
        select: { id: true, rootRequirementId: true, partCode: true, bufferBaseQty: true, effectiveDemandQty: true, forecastQty: true, soConsumedQty: true, bufferQty: true },
      });
      if (selected.length !== requirementIds.length) {
        throw Object.assign(new Error("Sebagian requirement purchase tidak ditemukan"), { status: 404 });
      }

      const rootRequirementIds = [...new Set(selected.map((row) => row.rootRequirementId).filter(Boolean))];
      const targets = !isOrderPercentUpdate && bufferScope === "PARENT_FG" && rootRequirementIds.length
        ? await tx.mRPRequirement.findMany({
          where: { runNumber, isDeleted: false, orderType: "Purchase", rootRequirementId: { in: rootRequirementIds } },
          select: { id: true, partCode: true, bufferBaseQty: true, effectiveDemandQty: true, forecastQty: true, soConsumedQty: true, bufferQty: true },
        })
        : selected;

      for (const row of targets) {
        const nextBufferQty = isOrderPercentUpdate
          ? Number(row.bufferQty || 0)
          : roundPlanningQty(Number(row.bufferBaseQty || 0) * bufferPercent / 100);
        const forecastBasis = Number(row.forecastQty || Math.max(Number(row.effectiveDemandQty || 0) - Number(row.bufferQty || 0), 0));
        // PPIC boleh mengurangi/menambah coverage forecast, tetapi SO aktual adalah floor.
        const demandAfterOrderPercent = isOrderPercentUpdate
          ? evaluateFromSet(formulas, "MRP_ADJUSTED_ORDER", {
            netRequirement: forecastBasis,
            orderPercent,
            soConsumedQty: Number(row.soConsumedQty || 0),
          })
          : Number(row.effectiveDemandQty || 0);
        await tx.mRPRequirement.update({
          where: { id: row.id },
          data: {
            ...(isOrderPercentUpdate ? {
              orderPercent,
              grossRequirement: roundPlanningQty(demandAfterOrderPercent + nextBufferQty),
              notes: `Order forecast ${orderPercent}% (minimum SO ${Number(row.soConsumedQty || 0)})`,
            } : {
              bufferPercent,
              bufferQty: nextBufferQty,
              bufferOverridden: true,
              bufferReferenceScope: bufferScope,
              grossRequirement: roundPlanningQty(Number(row.effectiveDemandQty || 0) + nextBufferQty),
              notes: buildBufferStockNote(bufferPercent, nextBufferQty),
            }),
          },
        });
        if (!isSimulation) await tx.mPS.update({ where: { mpsNumber }, data: { lifecycleStatus: "RELEASED", simulationOnly: false, replanRequired: false, replanReason: null } });
      }

      const partCodes = [...new Set(targets.map((row) => normalizePartCode(row.partCode)).filter(Boolean))];
      const requirements = await tx.mRPRequirement.findMany({
        where: {
          runNumber,
          isDeleted: false,
          orderType: "Purchase",
          partCode: { in: partCodes },
        },
        include: {
          part: {
            include: { partBases: { select: { baseOn: true, grossWeight: true } } },
          },
          mbomDetail: { select: { uomCode: true, grossWeight: true, category: true } },
        },
        orderBy: [{ requiredDate: "asc" }, { treePath: "asc" }],
      });
      const materialRules = buildMaterialPlanningRules(
        requirements.map((row) => ({ ...(row.mbomDetail || {}), part: row.part })),
      );
      const stockRows = await tx.stockBalance.findMany({
        where: {
          AND: [
            { partCode: { in: partCodes }, isDeleted: false },
            buildExcludeSpecialRackCondition(),
          ],
        },
        select: {
          partCode: true,
          stockType: true,
          uomCode: true,
          qtyOnHand: true,
          qtyReserved: true,
          qtyQC: true,
          qtyAvailable: true,
        },
      });
      const normalizedStocks = normalizePlanningStockRows(stockRows, materialRules);
      const stockMaps = buildStockPositionMaps(normalizedStocks);
      const supplyMap = await buildOpenSupplyMap(tx, partCodes, run.cutoffDate, {
        excludeRunNumbers: [runNumber],
        ...materialRules,
      });

      for (const partCode of partCodes) {
        let projectedAvailable = Number(stockMaps.available[partCode] || 0) + Number(supplyMap[partCode] || 0);
        let projectedActual = Number(stockMaps.available[partCode] || 0);
        const allocatedQty = Number(stockMaps.allocated[partCode] || 0);
        for (const row of requirements.filter((item) => normalizePartCode(item.partCode) === partCode)) {
          const grossRequirement = Number(row.grossRequirement || 0);
          const netRequirement = roundPlanningQty(Math.max(grossRequirement - projectedAvailable, 0));
          await tx.mRPRequirement.update({
            where: { id: row.id },
            data: {
              onHandQty: projectedActual,
              allocatedQty,
              netRequirement,
              plannedOrderQty: netRequirement,
              adjustedOrderQty: netRequirement,
            },
          });
          projectedAvailable = Math.max(projectedAvailable - grossRequirement, 0);
          projectedActual = Math.max(projectedActual - grossRequirement, 0);
          row.netRequirement = netRequirement;
          row.plannedOrderQty = netRequirement;
        }
      }

      const openOrders = await tx.plannedOrder.findMany({
        where: { runNumber, isDeleted: false, orderType: "Purchase", partCode: { in: partCodes } },
        orderBy: [{ requiredDate: "asc" }, { orderNumber: "asc" }],
      });
      const lockedOrder = openOrders.find((row) => row.status !== "Planned");
      if (lockedOrder) {
        throw Object.assign(
          new Error(`Buffer tidak dapat diubah karena ${lockedOrder.orderNumber} sudah berstatus ${lockedOrder.status}`),
          { status: 409 },
        );
      }

      const dateKey = (value) => new Date(value).toISOString().slice(0, 10);
      const orderGroups = new Map();
      for (const order of openOrders) {
        const key = `${normalizePartCode(order.partCode)}|${dateKey(order.requiredDate)}`;
        if (!orderGroups.has(key)) orderGroups.set(key, []);
        orderGroups.get(key).push(order);
      }
      const requirementGroups = new Map();
      for (const row of requirements) {
        const key = `${normalizePartCode(row.partCode)}|${dateKey(row.requiredDate)}`;
        if (!requirementGroups.has(key)) requirementGroups.set(key, { rows: [], qty: 0 });
        requirementGroups.get(key).rows.push(row);
        requirementGroups.get(key).qty += Number(row.plannedOrderQty || 0);
      }

      const partnerMap = await buildPlannedOrderPartnerMap(tx, partCodes);
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const lastPlo = await tx.plannedOrder.findFirst({
        where: { orderNumber: { startsWith: `PLO-${dateStr}-` } },
        orderBy: { orderNumber: "desc" },
        select: { orderNumber: true },
      });
      let sequence = parseInt(lastPlo?.orderNumber?.match(/-(\d+)$/)?.[1] || "0", 10);
      const allKeys = new Set([...orderGroups.keys(), ...requirementGroups.keys()]);
      for (const key of allKeys) {
        const existing = orderGroups.get(key) || [];
        const target = requirementGroups.get(key);
        const qty = roundPlanningQty(target?.qty || 0);
        if (qty <= 0) {
          if (existing.length > 0) {
            await tx.plannedOrder.updateMany({
              where: { orderNumber: { in: existing.map((row) => row.orderNumber) } },
              data: { isDeleted: true, notes: "Cancelled after MRP buffer override" },
            });
          }
          continue;
        }

        if (existing.length > 0) {
          await tx.plannedOrder.update({ where: { orderNumber: existing[0].orderNumber }, data: { qty } });
          if (existing.length > 1) {
            await tx.plannedOrder.updateMany({
              where: { orderNumber: { in: existing.slice(1).map((row) => row.orderNumber) } },
              data: { isDeleted: true, notes: "Consolidated after MRP buffer override" },
            });
          }
          continue;
        }

        const row = target.rows[0];
        const partCode = normalizePartCode(row.partCode);
        sequence += 1;
        await tx.plannedOrder.create({
          data: {
            orderNumber: `PLO-${dateStr}-${String(sequence).padStart(4, "0")}`,
            runNumber,
            orderType: "Purchase",
            partCode,
            partId: row.partId || null,
            uomCode: materialRules.planningUomByPartCode[partCode] || row.mbomDetail?.uomCode || "pcs",
            qty,
            requiredDate: row.requiredDate,
            orderDate: row.orderDate || row.requiredDate,
            supplierCode: null,
            supplierProposalSource: null,
            vendorCode: partnerMap[partCode]?.vendorCode || null,
            referenceType: "MRP",
            referenceNumber: run.planNumber || runNumber,
            status: "Planned",
            notes: "Created after MRP buffer override",
          },
        });
      }

      const [totalRequirements, totalPlannedOrders] = await Promise.all([
        tx.mRPRequirement.count({ where: { runNumber, isDeleted: false, orderType: "Purchase" } }),
        tx.plannedOrder.count({ where: { runNumber, isDeleted: false, orderType: "Purchase" } }),
      ]);
      await tx.mRPRun.update({
        where: { runNumber },
        data: { totalRequirements, totalPlannedOrders },
      });
    }, { timeout: 120000 });

    res.json({
      message: isOrderPercentUpdate ? "Order percentage MRP berhasil diperbarui" : "Buffer stock MRP berhasil diperbarui",
      runNumber,
      ...(isOrderPercentUpdate ? { orderPercent } : { bufferPercent }),
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
};

async function nextGeneratedPurchaseRequestNumber(tx, procurementGroup) {
  const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  // Raw-material requisitions are Material Master demand documents. MRP is
  // retained in PurchaseRequisitionSource, not exposed as the PR header identity.
  const documentType = procurementGroup === "MATERIAL" ? "MAT" : "MRP";
  const prefix = `PR-${documentType}-${dateKey}-`;
  const latest = await tx.purchaseRequisition.findFirst({
    where: { prNumber: { startsWith: prefix } },
    orderBy: { prNumber: "desc" },
    select: { prNumber: true },
  });
  const sequence = Number(latest?.prNumber?.match(/(\d+)$/)?.[1] || 0) + 1;
  return `${prefix}${String(sequence).padStart(3, "0")}`;
}

function getProcurementRows(body = {}) {
  const candidates = body.orders || body.plannedOrders || body.items || [];
  return Array.isArray(candidates) ? candidates.filter((row) => row && row.orderNumber) : [];
}

function normalizeLotAllocations(value, conversionUomCode = "KG") {
  const rows = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  return rows.map((row, index) => {
    const qty = Number(row.qty ?? row.convertedQty ?? row.qtyKg ?? row.allocatedQtyKg ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw Object.assign(new Error(`Alokasi material baris ${index + 1}: qty harus lebih dari 0.`), { status: 400 });
    }
    const partCode = normalizePartCode(row.partCode || row.childPartCode);
    const fgPartCode = normalizePartCode(row.fgPartCode || row.parentPartCode);
    if (!partCode && !fgPartCode) {
      throw Object.assign(new Error(`Alokasi lot baris ${index + 1}: partCode atau fgPartCode wajib diisi.`), { status: 400 });
    }
    return {
      partCode: partCode || null,
      fgPartCode: fgPartCode || null,
      qty,
      uomCode: String(row.uomCode || conversionUomCode || "").trim().toUpperCase() || null,
      // Keep qtyKg for old API/UI consumers when the conversion result is KG.
      qtyKg: isKgUom(row.uomCode || conversionUomCode) ? qty : undefined,
      sourceType: row.sourceType || row.demandType || null,
      sourceNumber: row.sourceNumber || row.demandNumber || null,
      plannedOrderNumber: row.plannedOrderNumber || null,
      materialCode: row.materialCode || null,
      notes: row.notes || null,
    };
  });
}

const procurementDayKey = (value) => {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : "";
};

/**
 * Raw material demand is purchased by Material Master identity, not by the
 * internal child-part code that happened to consume it. Compatible demands
 * are consolidated while their child part / FG / planned-order pegging stays
 * available in lotAllocations and sourcePlannedOrderNumbers.
 */
function procurementCategoryForPart(part) {
  if (isRawMaterialPart(part)) return "MATERIAL";
  if (String(part?.rawType || "").trim().toUpperCase() === "PURCHASE_PART") {
    return part?.hasDrawing ? "PURCHASE_PART" : "UNIVERSAL_PURCHASE_PART";
  }
  return "NON_PRODUCTION";
}

function buildMrpSourceRows(order, requirementRows = []) {
  const matching = requirementRows.filter((row) =>
    row.partCode === order.partCode
    && procurementDayKey(row.requiredDate) === procurementDayKey(order.requiredDate));
  const candidates = matching.length
    ? matching
    : [{
        runNumber: order.runNumber,
        requiredDate: order.requiredDate,
        sourceType: order.referenceType || "MRP",
        sourceNumber: order.referenceNumber || order.runNumber,
        partCode: order.partCode,
        mpsDetail: null,
        consumptionSources: null,
        adjustedOrderQty: order.qty,
      }];
  const totalBasis = candidates.reduce((sum, row) =>
    sum + Math.max(Number(row.adjustedOrderQty ?? row.plannedOrderQty ?? row.netRequirement ?? row.grossRequirement ?? 0), 0), 0);
  let allocated = 0;
  return candidates.map((row, index) => {
    const basis = Math.max(Number(row.adjustedOrderQty ?? row.plannedOrderQty ?? row.netRequirement ?? row.grossRequirement ?? 0), 0);
    const qty = index === candidates.length - 1
      ? roundPlanningQty(Number(order.qty || 0) - allocated)
      : roundPlanningQty(totalBasis > 0 ? Number(order.qty || 0) * basis / totalBasis : Number(order.qty || 0) / candidates.length);
    allocated = roundPlanningQty(allocated + qty);
    const forecastNumbers = [
      row.mpsDetail?.forecastDetail?.forecastNumber,
      ...((String(row.mpsDetail?.notes || "").match(/forecast\s+(.+?);\s*SO/i)?.[1] || "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value && value !== "-")),
    ].filter(Boolean);
    const distinctForecastNumbers = [...new Set(forecastNumbers)];
    return {
      plannedOrderNumber: order.orderNumber,
      mrpRunNumber: row.runNumber || order.runNumber || null,
      mpsNumber: row.mpsDetail?.mpsNumber || order.mrpRun?.mpsNumber || null,
      mpsDetailId: row.mpsDetailId || null,
      forecastNumber: distinctForecastNumbers.length === 1 ? distinctForecastNumbers[0] : null,
      forecastDetailId: row.mpsDetail?.forecastDetailId || null,
      soNumber: row.mpsDetail?.soNumber || null,
      sourceType: row.sourceType || order.referenceType || "MRP",
      sourceNumber: row.sourceNumber || order.referenceNumber || order.runNumber || null,
      demandMonth: row.mpsDetail?.startDate || row.requiredDate || order.requiredDate,
      requiredDate: row.requiredDate || order.requiredDate,
      partCode: row.partCode || order.partCode,
      fgPartCode: row.mpsDetail?.partCode || null,
      qty,
      uomCode: order.uomCode || null,
      metadata: (row.consumptionSources || distinctForecastNumbers.length)
        ? {
          consumptionSources: row.consumptionSources || [],
          forecastNumbers: distinctForecastNumbers,
        }
        : undefined,
    };
  }).filter((row) => row.qty > 0);
}

function buildMrpPurchaseRequestDetails(orders, partByCode, runNumber, requirementRows = []) {
  const groups = new Map();
  for (const order of orders) {
    const part = partByCode.get(order.partCode);
    if (isRawMaterialPart(part) && !part?.material?.materialCode) {
      throw Object.assign(new Error(`${order.orderNumber}: raw material ${order.partCode} belum terhubung ke Material Master.`), { status: 409 });
    }
    const rawMaterial = isRawMaterialPart(part) && part?.material?.materialCode;
    if (rawMaterial && !isKgUom(order.uomCode)) {
      throw Object.assign(new Error(`${order.orderNumber}: kebutuhan raw material dari PPIC harus dalam KG, tetapi UOM MRP adalah ${order.uomCode || "-"}. Perbaiki konversi kebutuhan BOM/MRP terlebih dahulu.`), { status: 409 });
    }
    const category = procurementCategoryForPart(part);
    const requirement = requirementRows.find((row) => row.partCode === order.partCode && row.mbomDetail);
    const materialForm = requirement?.mbomDetail?.materialScheme === "ALTERNATIVE"
      ? requirement.mbomDetail.alternateMaterialForm
      : requirement?.mbomDetail?.materialForm;
    // The BOM form is only a manufacturing recommendation. Purchasing may buy
    // the same Material Master demand as Coil, Sheet or Pieces, so it must not
    // split the MRP-to-PR consolidation key.
    const key = rawMaterial
      // One PR header is still shared by Material Master + demand month, but
      // each released Planned Order remains an independent PR detail. This
      // preserves the two MRP demand lines and lets Purchasing split supplier,
      // package/form, and ordered quantity per demand without losing pegging.
      ? ["MATERIAL", part.material.id || part.material.materialCode, order.orderNumber, order.uomCode || "KG"].join("|")
      : [category, order.partCode, order.uomCode || "UNIT"].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      order,
      part,
      rawMaterial,
      category,
      materialForm,
      sourceRows: buildMrpSourceRows(order, requirementRows),
    });
  }

  return [...groups.values()].map((entries, index) => {
    const first = entries[0];
    const { order, part } = first;
    const sourceRows = entries.flatMap((entry) => entry.sourceRows);
    if (!first.rawMaterial) {
      const sourceNumbers = entries.map((entry) => entry.order.orderNumber);
      const qty = roundPlanningQty(entries.reduce((sum, entry) => sum + Number(entry.order.qty || 0), 0));
      return {
        lineNumber: index + 1,
        procurementCategory: first.category,
        partCode: order.partCode,
        // Drawing number and internal part code are intentionally separate.
        partNumber: part?.partNumber || null,
        partName: part?.partName || null,
        qty,
        uomCode: order.uomCode || null,
        preferredSupplier: null,
        proposedSupplierCode: null,
        supplierProposalSource: "PURCHASING",
        preferredVendor: order.vendorCode || null,
        plannedOrderNumber: sourceNumbers[0],
        sourcePlannedOrderNumbers: sourceNumbers,
        notes: `MRP ${runNumber}; sumber ${sourceNumbers.join(", ")}; Order % sudah diterapkan pada planned order`,
        sources: { create: sourceRows },
      };
    }

    const material = part.material;
    const recommendedPurchaseForms = [...new Map(entries
      .map((entry) => entry.materialForm)
      .filter(Boolean)
      .map((form) => [form.id || form.formCode || form.symbol, {
        id: form.id || null,
        formCode: form.formCode || null,
        symbol: form.symbol || null,
      }])).values()];
    const sourceNumbers = entries.map((entry) => entry.order.orderNumber);
    const qty = roundPlanningQty(entries.reduce((sum, entry) => sum + Number(entry.order.qty || 0), 0));
    const allocations = entries.flatMap((entry) => {
      const existing = Array.isArray(entry.order.lotAllocations) ? entry.order.lotAllocations : [];
      if (existing.length) {
        return existing.map((allocation) => ({
          ...allocation,
          qty: Number(allocation.qty ?? allocation.qtyKg ?? entry.order.qty ?? 0),
          uomCode: "KG",
          qtyKg: Number(allocation.qty ?? allocation.qtyKg ?? entry.order.qty ?? 0),
          plannedOrderNumber: allocation.plannedOrderNumber || entry.order.orderNumber,
          materialCode: allocation.materialCode || material.materialCode,
          sourcePartCode: allocation.sourcePartCode || entry.order.partCode,
        }));
      }
      const allocationQty = Number(entry.order.qty || 0);
      return allocationQty > 0 ? [{
        partCode: entry.order.partCode,
        fgPartCode: null,
        qty: allocationQty,
        uomCode: "KG",
        qtyKg: allocationQty,
        sourceType: entry.order.referenceType || "MRP",
        sourceNumber: entry.order.referenceNumber || runNumber,
        plannedOrderNumber: entry.order.orderNumber,
        materialCode: material.materialCode,
        sourcePartCode: entry.order.partCode,
        notes: "Auto pegging dari kebutuhan MRP",
      }] : [];
    });
    const materialLabel = material.materialName || material.spec || material.materialCode;
    return {
      lineNumber: index + 1,
      procurementCategory: "MATERIAL",
      // Kept as a legacy trace/fallback. UI/API identity for this line is the
      // explicit Material Master snapshot below.
      partCode: order.partCode,
      partNumber: null,
      partName: materialLabel,
      materialId: material.id,
      materialCode: material.materialCode,
      materialName: materialLabel,
      materialType: material.materialType || null,
      description: [material.materialCode, material.materialType, material.spec].filter(Boolean).join(" - "),
      CSP: null,
      qty,
      uomCode: "KG",
      preferredSupplier: null,
      proposedSupplierCode: null,
      supplierProposalSource: "PURCHASING",
      purchasePackageQty: null,
      purchasePackageUomCode: null,
      conversionUomCode: null,
      conversionFactor: null,
      convertedPurchaseQty: null,
      recommendedPurchaseForms: recommendedPurchaseForms.length ? recommendedPurchaseForms : null,
      lotCount: null,
      kgPerLot: null,
      purchaseQtyKg: null,
      lotAllocations: allocations.length ? allocations : null,
      preferredVendor: order.vendorCode || null,
      plannedOrderNumber: sourceNumbers[0],
      sourcePlannedOrderNumbers: sourceNumbers,
      notes: `MRP ${runNumber}; material ${material.materialCode}; rekomendasi form BOM ${recommendedPurchaseForms.map((form) => form.formCode || form.symbol).filter(Boolean).join("/") || "-"}; sumber ${sourceNumbers.join(", ")}; PPIC request ${qty} KG. Supplier dan form aktual ditentukan Purchasing.`,
      sources: { create: sourceRows },
    };
  });
}

async function applyPlannedOrderProcurement(tx, runNumber, body = {}, username = "system") {
  const rows = getProcurementRows(body);
  if (!rows.length) return [];
  const orderNumbers = [...new Set(rows.map((row) => String(row.orderNumber)))];
  const orders = await tx.plannedOrder.findMany({
    where: { runNumber, orderNumber: { in: orderNumbers }, orderType: "Purchase", isDeleted: false },
    include: {
      part: {
        select: {
          itemType: true,
          rawType: true,
          material: {
            select: {
              materialCode: true,
              materialForm: true,
              defaultPurchaseUomCode: true,
              defaultConversionUomCode: true,
              defaultConversionFactor: true,
            },
          },
        },
      },
    },
  });
  if (orders.length !== orderNumbers.length) {
    const found = new Set(orders.map((row) => row.orderNumber));
    const missing = orderNumbers.filter((number) => !found.has(number));
    throw Object.assign(new Error(`Planned purchase order tidak ditemukan pada MRP ini: ${missing.join(", ")}`), { status: 404 });
  }
  const orderByNumber = new Map(orders.map((order) => [order.orderNumber, order]));
  for (const input of rows) {
    const order = orderByNumber.get(String(input.orderNumber));
    if (!["Planned", "Partially Released"].includes(order.status)) {
      throw Object.assign(new Error(`${order.orderNumber} berstatus ${order.status}; hanya planned order yang belum selesai dapat dipilih untuk PR.`), { status: 409 });
    }
    const hasPurchasingDecision = [
      input.supplierCode,
      input.proposedSupplierCode,
      input.purchasePackageQty,
      input.packageQty,
      input.lotCount,
      input.purchasePackageUomCode,
      input.packageUomCode,
      input.conversionFactor,
      input.kgPerLot,
    ].some((value) => value != null && value !== "");
    if (hasPurchasingDecision) {
      throw Object.assign(new Error(`${order.orderNumber}: supplier dan konversi Sheet/Coil/Pcs hanya boleh ditentukan oleh Purchasing pada PR/PO.`), { status: 400 });
    }
  }
  return orders;
}

exports.updatePlannedOrderProcurement = async (req, res, next) => {
  try {
    const runNumber = await resolveCurrentRunNumber(req.params.runNumber);
    if (!runNumber) return res.status(404).json({ message: "MRP Run tidak ditemukan" });
    const items = await prisma.$transaction((tx) => applyPlannedOrderProcurement(
      tx,
      runNumber,
      req.body || {},
      req.user?.username || req.user?.email || "system",
    ));
    res.json({ message: "Pilihan kebutuhan MRP berhasil divalidasi. Supplier dan konversi ditentukan Purchasing.", items });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
};

// Output MRP purchase-only. Planned order yang sudah menjadi PR tidak dibuat ulang.
const createPurchaseRequestOutputLegacy = async (req, res, next) => {
  try {
    const runNumber = await resolveCurrentRunNumber(req.params.runNumber);
    if (!runNumber) return res.status(404).json({ message: "MRP Run tidak ditemukan" });
    const result = await prisma.$transaction(async (tx) => {
      const run = await tx.mRPRun.findFirst({ where: { runNumber, isDeleted: false }, select: { runNumber: true, status: true, planNumber: true } });
      if (!run) throw Object.assign(new Error("MRP Run tidak ditemukan"), { status: 404 });
      if (run.status !== "Completed") throw Object.assign(new Error("MRP harus Completed sebelum membuat Purchase Request"), { status: 409 });
      await applyPlannedOrderProcurement(tx, runNumber, req.body || {}, req.user?.username || req.user?.email || "system");
      const releaseRows = [
        ...(Array.isArray(req.body?.releaseItems) ? req.body.releaseItems : []),
        ...(Array.isArray(req.body?.items) ? req.body.items : []),
      ].filter((row) => row?.orderNumber);
      const releaseInputByOrder = new Map(
        releaseRows.map((row) => [String(row.orderNumber), row]),
      );
      const selectedOrderNumbers = Array.isArray(req.body?.selectedOrderNumbers)
        ? req.body.selectedOrderNumbers.map(String)
        : releaseRows.length
          ? releaseRows.map((row) => String(row.orderNumber))
          : getProcurementRows(req.body || {}).map((row) => String(row.orderNumber));
      const orders = await tx.plannedOrder.findMany({
        where: {
          runNumber,
          isDeleted: false,
          orderType: "Purchase",
          status: { in: ["Planned", "Partially Released"] },
          qty: { gt: 0 },
          ...(selectedOrderNumbers.length ? { orderNumber: { in: selectedOrderNumbers } } : {}),
        },
        orderBy: [{ requiredDate: "asc" }, { orderNumber: "asc" }],
      });
      if (!orders.length) {
        const existing = await tx.purchaseRequisitionDetail.findMany({ where: { plannedOrderNumber: { not: null }, pr: { notes: { contains: runNumber }, isDeleted: false } }, select: { prNumber: true }, distinct: ["prNumber"] });
        return { created: false, prNumbers: existing.map((row) => row.prNumber), message: "Tidak ada planned purchase order baru untuk dikeluarkan." };
      }
      const releasedOrders = orders.map((order) => {
        const input = releaseInputByOrder.get(order.orderNumber) || {};
        const remainingQty = Math.max(Number(order.qty || 0) - Number(order.qtyReleased || 0), 0);
        let releaseQty = input.releaseQty == null ? remainingQty : Number(input.releaseQty);
        if (!Number.isFinite(releaseQty) || releaseQty <= 0 || releaseQty > remainingQty + 0.000001) {
          throw Object.assign(new Error(`${order.orderNumber}: releaseQty harus lebih dari 0 dan tidak boleh melebihi sisa ${roundPlanningQty(remainingQty)}.`), { status: 400 });
        }

        const allocationRatio = Math.min(releaseQty / Math.max(Number(order.qty || 0), 1), 1);
        const lotAllocations = Array.isArray(order.lotAllocations)
          ? order.lotAllocations.map((allocation) => ({
            ...allocation,
            qty: roundPlanningQty(Number(allocation.qty ?? allocation.qtyKg ?? 0) * allocationRatio),
            uomCode: "KG",
            qtyKg: roundPlanningQty(Number(allocation.qty ?? allocation.qtyKg ?? 0) * allocationRatio),
          })).filter((allocation) => Number(allocation.qty ?? allocation.qtyKg ?? 0) > 0)
          : order.lotAllocations;

        return {
          ...order,
          qty: roundPlanningQty(releaseQty),
          purchasePackageQty: null,
          purchasePackageUomCode: null,
          conversionUomCode: null,
          conversionFactor: null,
          convertedPurchaseQty: null,
          lotCount: null,
          kgPerLot: null,
          purchaseQtyKg: null,
          lotAllocations,
          _sourceQty: Number(order.qty || 0),
          _releasedBefore: Number(order.qtyReleased || 0),
        };
      });
      const partCodes = [...new Set(orders.map((row) => row.partCode))];
      const parts = await tx.part.findMany({
        where: { partCode: { in: partCodes }, isDeleted: false },
        select: {
          partCode: true,
          partName: true,
          partNumber: true,
          hasDrawing: true,
          itemType: true,
          rawType: true,
          material: {
            select: {
              id: true,
              materialCode: true,
              materialName: true,
              materialType: true,
              materialForm: true,
              spec: true,
              defaultPurchaseUomCode: true,
              defaultConversionUomCode: true,
              defaultConversionFactor: true,
            },
          },
        },
      });
      const partByCode = new Map(parts.map((part) => [part.partCode, part]));
      const requirements = await tx.mRPRequirement.findMany({
        where: {
          runNumber,
          isDeleted: false,
          orderType: "Purchase",
          partCode: { in: partCodes },
        },
        select: {
          runNumber: true,
          partCode: true,
          requiredDate: true,
          adjustedOrderQty: true,
          plannedOrderQty: true,
          netRequirement: true,
          grossRequirement: true,
          sourceType: true,
          sourceNumber: true,
          mpsDetailId: true,
          consumptionSources: true,
          mbomDetail: {
            select: {
              materialScheme: true,
              materialForm: { select: { id: true, formCode: true, symbol: true } },
              alternateMaterialForm: { select: { id: true, formCode: true, symbol: true } },
            },
          },
          mpsDetail: {
            select: {
              mpsNumber: true,
              partCode: true,
              soNumber: true,
              notes: true,
              customerCode: true,
              startDate: true,
              forecastDetailId: true,
              forecastDetail: { select: { forecastNumber: true } },
            },
          },
        },
      });
      const groupedOrders = new Map();
      for (const order of releasedOrders) {
        const part = partByCode.get(order.partCode);
        const procurementGroup = procurementCategoryForPart(part);
        const demandBucket = new Date(order.requiredDate).toISOString().slice(0, 7);
        const groupKey = procurementGroup === "MATERIAL"
          ? `MATERIAL|${part?.material?.id || part?.material?.materialCode}|${demandBucket}`
          : procurementGroup;
        if (!groupedOrders.has(groupKey)) {
          groupedOrders.set(groupKey, {
            groupKey,
            procurementGroup,
            demandBucket: procurementGroup === "MATERIAL" ? demandBucket : null,
            material: procurementGroup === "MATERIAL" ? part?.material : null,
            orders: [],
          });
        }
        groupedOrders.get(groupKey).orders.push(order);
      }
      const requestedTargets = req.body?.targetPrNumbers && typeof req.body.targetPrNumbers === "object"
        ? req.body.targetPrNumbers
        : {};
      const autoMerge = req.body?.mergeIntoOpenPr !== false;
      const purchaseRequests = [];
      const prNumberByOrder = new Map();
      for (const group of groupedOrders.values()) {
        const {
          groupKey, procurementGroup, demandBucket, material, orders: categoryOrders,
        } = group;
        const headerSourceType = procurementGroup === "MATERIAL" ? "SYSTEM" : "MRP";
        const requiredDate = categoryOrders.reduce((earliest, order) =>
          !earliest || new Date(order.requiredDate) < earliest ? new Date(order.requiredDate) : earliest, null) || new Date();
        const requestDetails = buildMrpPurchaseRequestDetails(categoryOrders, partByCode, runNumber, requirements);
        const explicitTarget = requestedTargets[groupKey]
          || requestedTargets[material?.materialCode]
          || (procurementGroup !== "MATERIAL" ? requestedTargets[procurementGroup] : null)
          || (procurementGroup !== "MATERIAL" ? requestedTargets[procurementGroup.toLowerCase()] : null)
          || (groupedOrders.size === 1 ? req.body?.targetPrNumber : null);
        if (procurementGroup === "MATERIAL") {
          // pg_advisory_xact_lock returns PostgreSQL `void`. `$queryRaw`
          // attempts to deserialize that value and Prisma rejects the
          // unsupported result type. This statement is side-effect only, so
          // execute it without materialising a result row.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`PR-MATERIAL|${material?.id}|${demandBucket}`}))`;
        }
        let target = explicitTarget
          ? await tx.purchaseRequisition.findFirst({
              where: { prNumber: String(explicitTarget), isDeleted: false },
              include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } },
            })
          : autoMerge
            ? await tx.purchaseRequisition.findFirst({
                where: {
                  sourceType: headerSourceType,
                  procurementGroup,
                  status: "Draft",
                  isDeleted: false,
                  ...(procurementGroup === "MATERIAL" ? {
                    headerMaterialId: material?.id,
                    demandBucket,
                  } : {}),
                },
                orderBy: { createdAt: "desc" },
                include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } },
              })
            : null;
        if (explicitTarget && !target) {
          throw Object.assign(new Error(`Target PR ${explicitTarget} tidak ditemukan.`), { status: 404 });
        }
        if (target && (target.status !== "Draft" || target.sourceType !== headerSourceType || target.procurementGroup !== procurementGroup)) {
          throw Object.assign(new Error(`PR ${target.prNumber} harus Draft, bertipe header ${headerSourceType}, dan kelompoknya ${procurementGroup}.`), { status: 409 });
        }
        if (target && procurementGroup === "MATERIAL"
          && (target.headerMaterialId !== material?.id || target.demandBucket !== demandBucket)) {
          throw Object.assign(new Error(`PR ${target.prNumber} bukan header Material Master ${material?.materialCode} periode ${demandBucket}.`), { status: 409 });
        }

        if (!target) {
          const prNumber = await nextGeneratedPurchaseRequestNumber(tx, procurementGroup);
          target = await tx.purchaseRequisition.create({
            data: {
              prNumber,
              requestedBy: req.user?.username || req.user?.email || "PPIC",
              requiredDate,
              sourceType: headerSourceType,
              procurementGroup,
              headerMaterialId: material?.id || null,
              headerMaterialCode: material?.materialCode || null,
              headerMaterialName: material?.materialName || material?.spec || null,
              demandBucket,
              poType: procurementGroup === "MATERIAL" ? "Material" : "Other",
              status: "Draft",
              notes: procurementGroup === "MATERIAL"
                ? `Material demand ${material?.materialCode} periode ${demandBucket}; generated from MRP ${run.planNumber || runNumber}`
                : `Generated from MRP ${run.planNumber || runNumber}`,
              details: { create: requestDetails },
            },
            include: { details: { where: { isDeleted: false }, include: { sources: { where: { isDeleted: false } } } } },
          });
        } else {
          let nextLine = target.details.reduce((max, row) => Math.max(max, Number(row.lineNumber || 0)), 0) + 1;
          for (const incoming of requestDetails) {
            const identity = incoming.procurementCategory === "MATERIAL"
              ? `MATERIAL|${incoming.materialCode}|${incoming.uomCode || ""}|${incoming.plannedOrderNumber || ""}`
              : `${incoming.procurementCategory}|${incoming.partCode || incoming.description}|${incoming.uomCode || ""}`;
            const existing = target.details.find((row) => {
              const rowIdentity = row.procurementCategory === "MATERIAL"
                ? `MATERIAL|${row.materialCode}|${row.uomCode || ""}|${row.plannedOrderNumber || ""}`
                : `${row.procurementCategory}|${row.partCode || row.description}|${row.uomCode || ""}`;
              return rowIdentity === identity;
            });
            const sourceCreates = incoming.sources?.create || [];
            if (existing) {
              const oldNumbers = Array.isArray(existing.sourcePlannedOrderNumbers) ? existing.sourcePlannedOrderNumbers : [];
              const newNumbers = Array.isArray(incoming.sourcePlannedOrderNumbers) ? incoming.sourcePlannedOrderNumbers : [];
              const oldAllocations = Array.isArray(existing.lotAllocations) ? existing.lotAllocations : [];
              const newAllocations = Array.isArray(incoming.lotAllocations) ? incoming.lotAllocations : [];
              const oldForms = Array.isArray(existing.recommendedPurchaseForms) ? existing.recommendedPurchaseForms : [];
              const newForms = Array.isArray(incoming.recommendedPurchaseForms) ? incoming.recommendedPurchaseForms : [];
              const recommendedPurchaseForms = [...new Map([...oldForms, ...newForms]
                .map((form) => [form.id || form.formCode || form.symbol, form])).values()];
              await tx.purchaseRequisitionDetail.update({
                where: { id: existing.id },
                data: {
                  qty: roundPlanningQty(Number(existing.qty || 0) + Number(incoming.qty || 0)),
                  totalAmount: Number(existing.totalAmount || 0) + Number(incoming.totalAmount || 0),
                  plannedOrderNumber: existing.plannedOrderNumber || incoming.plannedOrderNumber,
                  sourcePlannedOrderNumbers: [...new Set([...oldNumbers, ...newNumbers])],
                  lotAllocations: [...oldAllocations, ...newAllocations],
                  recommendedPurchaseForms: recommendedPurchaseForms.length ? recommendedPurchaseForms : null,
                  notes: [existing.notes, incoming.notes].filter(Boolean).join(" | "),
                  ...(sourceCreates.length ? { sources: { create: sourceCreates } } : {}),
                },
              });
            } else {
              await tx.purchaseRequisitionDetail.create({
                data: { ...incoming, lineNumber: nextLine, prNumber: target.prNumber },
              });
              nextLine += 1;
            }
          }
          target = await tx.purchaseRequisition.update({
            where: { prNumber: target.prNumber },
            data: {
              requiredDate: new Date(target.requiredDate) < requiredDate ? target.requiredDate : requiredDate,
              notes: target.notes?.includes(runNumber)
                ? target.notes
                : [target.notes, `Merged from MRP ${run.planNumber || runNumber}`].filter(Boolean).join(" | "),
            },
            include: { details: { where: { isDeleted: false }, include: { sources: { where: { isDeleted: false } } } } },
          });
        }
        purchaseRequests.push(target);
        for (const order of categoryOrders) prNumberByOrder.set(order.orderNumber, target.prNumber);
      }
      const releases = [];
      for (const order of releasedOrders) {
        const prNumber = prNumberByOrder.get(order.orderNumber);
        const qtyReleased = roundPlanningQty(order._releasedBefore + Number(order.qty || 0));
        const status = qtyReleased + 0.000001 >= order._sourceQty
          ? "Released"
          : "Partially Released";
        releases.push(await tx.plannedOrder.update({
          where: { orderNumber: order.orderNumber },
          data: {
            qtyReleased,
            status,
            notes: [
              orders.find((item) => item.orderNumber === order.orderNumber)?.notes,
              `${Number(order.qty || 0)} released to Purchase Request ${prNumber}`,
            ].filter(Boolean).join(" | "),
          },
          select: {
            orderNumber: true,
            qty: true,
            qtyReleased: true,
            status: true,
          },
        }));
      }
      return {
        created: true,
        purchaseRequest: purchaseRequests.length === 1 ? purchaseRequests[0] : null,
        purchaseRequests,
        releases,
        prNumbers: purchaseRequests.map((row) => row.prNumber),
        message: "Kebutuhan MRP dikonsolidasikan ke Draft PR per kelompok purchasing; setiap source MRP/forecast/SO tetap tersimpan.",
      };
    });
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
};

// Output produksi tetap dikelola Monthly Production Plan, dengan source MPS dari MRP run.
exports.createProductionPlanOutput = async (req, res, next) => {
  try {
    const runNumber = await resolveCurrentRunNumber(req.params.runNumber);
    const run = runNumber && await prisma.mRPRun.findFirst({ where: { runNumber, isDeleted: false } });
    if (!run) return res.status(404).json({ message: "MRP Run tidak ditemukan" });
    assertApprovedCurrentMrp(run, "Production Plan");
    if (!run.mpsNumber) return res.status(409).json({ message: "MRP ini tidak terhubung ke MPS sehingga Production Planning tidak dapat dibuat" });
    const monthlyPlan = require("./MonthlyProductionPlanController");
    const delegatedReq = Object.create(req);
    delegatedReq.body = { ...(req.body || {}), mpsNumber: run.mpsNumber };
    return monthlyPlan.createFromMps(delegatedReq, res, next);
  } catch (error) { next(error); }
};

// ============================================
// GET PLANNED ORDERS
// ============================================
exports.listPlannedOrders = async (req, res, next) => {
  try {
    const { orderType, status, partCode, supplierCode, page = 1, limit = 50 } = req.query;
    const pageNumber = Math.max(1, Number(page));
    const limitNumber = Math.min(200, Math.max(1, Number(limit)));
    const where = { isDeleted: false };
    if (orderType) where.orderType = String(orderType);
    if (status) where.status = parseFilter(status);
    if (partCode) where.partCode = String(partCode);
    if (supplierCode) where.supplierCode = String(supplierCode);
    const q = String(req.query.q || "").trim();
    if (q) where.OR = [{ orderNumber: { contains: q, mode: "insensitive" } }, { partCode: { contains: q, mode: "insensitive" } }, { referenceNumber: { contains: q, mode: "insensitive" } }];
    const [items, total] = await Promise.all([
      prisma.plannedOrder.findMany({ where, include: { mrpRun: { select: { runNumber: true, mpsNumber: true, planNumber: true, runDate: true } }, part: { select: { partCode: true, partNumber: true, partName: true } } }, orderBy: [{ requiredDate: "asc" }, { createdAt: "desc" }], skip: (pageNumber - 1) * limitNumber, take: limitNumber }),
      prisma.plannedOrder.count({ where }),
    ]);
    const enriched = await enrichPlannedOrderDisplay(prisma, items);
    res.json({ items: enriched.map(mapDoc), total, page: pageNumber, limit: limitNumber });
  } catch (error) { next(error); }
};

exports.getPlannedOrder = async (req, res, next) => {
  try {
    const orderNumber = String(req.params.orderNumber || "").trim();
    const order = await prisma.plannedOrder.findFirst({
      where: { orderNumber, isDeleted: false },
      include: {
        mrpRun: {
          select: {
            runNumber: true,
            mpsNumber: true,
            planNumber: true,
            planRevision: true,
            planScope: true,
            runDate: true,
            status: true,
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
          },
        },
      },
    });
    if (!order) return res.status(404).json({ message: "Planned Order tidak ditemukan" });

    const [
      peggings,
      purchaseSources,
      monthlyPlanDetails,
      manufacturingOrders,
    ] = await Promise.all([
      prisma.mRPPegging.findMany({
        where: { supplyType: "PlannedOrder", supplyNumber: orderNumber },
        include: {
          item: {
            select: {
              partCode: true,
              partNumber: true,
              partName: true,
            },
          },
        },
        orderBy: [{ createdAt: "asc" }],
      }),
      prisma.purchaseRequisitionSource.findMany({
        where: { plannedOrderNumber: orderNumber, isDeleted: false },
        include: {
          prDetail: {
            select: {
              id: true,
              prNumber: true,
              lineNumber: true,
              qty: true,
              orderedQty: true,
              uomCode: true,
              materialCode: true,
              partCode: true,
              pr: {
                select: {
                  prNumber: true,
                  status: true,
                  requiredDate: true,
                  headerMaterialCode: true,
                  demandBucket: true,
                  convertedToPO: true,
                },
              },
            },
          },
        },
        orderBy: [{ createdAt: "asc" }],
      }),
      prisma.monthlyProductionPlanDetail.findMany({
        where: { plannedOrderNumber: orderNumber, isDeleted: false },
        include: {
          plan: {
            select: {
              planNumber: true,
              planMonth: true,
              status: true,
            },
          },
        },
        orderBy: [{ createdAt: "asc" }],
      }),
      prisma.manufacturingOrder.findMany({
        where: { plannedOrderNumber: orderNumber, isDeleted: false },
        include: {
          part: {
            select: {
              partCode: true,
              partNumber: true,
              partName: true,
            },
          },
        },
        orderBy: [{ createdAt: "asc" }],
      }),
    ]);

    const withQtyBreakdown = await enrichPlannedOrderQtyBreakdown(prisma, [order]);
    const [displayOrder] = await enrichPlannedOrderDisplay(prisma, withQtyBreakdown);
    const purchaseRequisitions = purchaseSources.map((source) => ({
      prNumber: source.prDetail.pr.prNumber,
      prStatus: source.prDetail.pr.status,
      prLineNumber: source.prDetail.lineNumber,
      requiredDate: source.prDetail.pr.requiredDate,
      materialCode: source.prDetail.materialCode,
      partCode: source.prDetail.partCode,
      sourceQty: source.qty,
      sourceUomCode: source.uomCode,
      requestQty: source.prDetail.qty,
      orderedQty: source.prDetail.orderedQty,
      requestUomCode: source.prDetail.uomCode,
      headerMaterialCode: source.prDetail.pr.headerMaterialCode,
      demandBucket: source.prDetail.pr.demandBucket,
      poNumber: source.prDetail.pr.convertedToPO,
      mrpRunNumber: source.mrpRunNumber,
      mpsNumber: source.mpsNumber,
      forecastNumber: source.forecastNumber,
      soNumber: source.soNumber,
    }));
    const productionPlans = monthlyPlanDetails.map((detail) => ({
      planNumber: detail.plan.planNumber,
      planMonth: detail.plan.planMonth,
      planStatus: detail.plan.status,
      lineNumber: detail.lineNumber,
      partCode: detail.partCode,
      qtyPlanned: detail.qtyPlanned,
      qtyReleased: detail.qtyReleased,
      uomCode: detail.uomCode,
      requiredDate: detail.requiredDate,
      lineStatus: detail.status,
      manufacturingOrderNumber: detail.manufacturingOrderNumber,
    }));

    res.json(mapDoc({
      ...displayOrder,
      mrpPeggings: peggings,
      purchaseRequisitions,
      productionPlans,
      manufacturingOrders,
    }));
  } catch (error) {
    next(error);
  }
};

exports.listNetChangeDirtyItems = async (req, res, next) => {
  try {
    const status = String(req.query?.status || "").trim();
    const reason = String(req.query?.reason || "").trim();
    res.json(await hybridMrpService.listDirtyItems(prisma, {
      page: req.query?.page,
      limit: req.query?.limit,
      where: {
        ...(status ? { status } : {}),
        ...(reason ? { reason } : {}),
      },
    }));
  } catch (error) { next(error); }
};

exports.listNetChangeSnapshots = async (req, res, next) => {
  try {
    res.json(await hybridMrpService.listPartialSnapshots(prisma, {
      page: req.query?.page,
      limit: req.query?.limit,
      where: req.query?.status ? { status: String(req.query.status) } : {},
    }));
  } catch (error) { next(error); }
};

exports.getLatestNetChangeSnapshot = async (_req, res, next) => {
  try {
    res.json({ item: await hybridMrpService.getLatestPartialSnapshot(prisma) });
  } catch (error) { next(error); }
};

exports.runNetChange = async (req, res, next) => {
  try {
    const sourceNumbers = Array.isArray(req.body?.sourceNumbers)
      ? req.body.sourceNumbers.map(String).filter(Boolean)
      : [];
    const result = await hybridMrpService.runPartialNetChangeMrp(prisma, {
      runBy: req.user?.username || req.user?.email || "system",
      limit: Math.min(500, Math.max(1, Number(req.body?.limit || 200))),
      sourceNumbers,
    });
    res.json(result);
  } catch (error) { next(error); }
};

exports.getPlannedOrders = async (req, res, next) => {
  try {
    const { runNumber: runIdentifier } = req.params;
    const { orderType, status, partCode, page = 1, limit = 50 } = req.query;
    const runNumber = await resolveCurrentRunNumber(runIdentifier);
    if (!runNumber) {
      return res.status(404).json({ message: "MRP Run tidak ditemukan" });
    }

    const where = {
      runNumber,
      isDeleted: false,
      orderType: "Purchase",
    };

    if (orderType && orderType !== "Purchase") {
      return res.json({ items: [], total: 0, page: Number(page), limit: Number(limit) });
    }

    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;

    if (partCode) {
      where.partCode = partCode;
    }

    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.plannedOrder.findMany({
        where,
        include: {
          mrpRun: {
            select: {
              runNumber: true,
              planNumber: true,
              planRevision: true,
              planScope: true,
              runDate: true,
            },
          },
          part: {
            select: {
              partCode: true,
              partNumber: true,
              partName: true,
            },
          },
        },
        orderBy: [{ createdAt: "asc" }, { orderDate: "asc" }],
        skip,
        take: Number(limit),
      }),
      prisma.plannedOrder.count({ where }),
    ]);
    const itemsWithQtyBreakdown = await enrichPlannedOrderQtyBreakdown(prisma, items);
    const enrichedItems = await enrichPlannedOrderDisplay(prisma, itemsWithQtyBreakdown);

    res.json({
      items: enrichedItems.map(mapDoc),
      total,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (e) {
    next(e);
  }
};

// ============================================
// DELETE MRP RUN
// ============================================
exports.remove = async (req, res, next) => {
  try {
    const { runNumber: runIdentifier } = req.params;
    const runNumber = await resolveCurrentRunNumber(runIdentifier);

    const existing = runNumber
      ? await prisma.mRPRun.findUnique({
          where: { runNumber },
          select: { id: true, runNumber: true, isDeleted: true },
        })
      : null;

    if (!existing || existing.isDeleted) {
      return res.status(404).json({ message: "MRP Run tidak ditemukan" });
    }

    const lockedPlannedOrderCount = await prisma.plannedOrder.count({
      where: {
        runNumber,
        isDeleted: false,
        status: { in: ["Partially Released", "Released", "Covered"] },
      },
    });

    if (lockedPlannedOrderCount > 0) {
      return res.status(409).json({
        message: "MRP Run tidak bisa dihapus karena sudah memiliki Planned Order yang sudah released/covered.",
      });
    }

    await prisma.$transaction(async (tx) => {
      // Cascade soft delete: requirement dari run ini
      await tx.mRPRequirement.updateMany({
        where: { runNumber, isDeleted: false },
        data: { isDeleted: true },
      });

      // Cascade soft delete: planned order dari run ini (aman karena released sudah di-guard)
      await tx.plannedOrder.updateMany({
        where: {
          runNumber,
          isDeleted: false,
          status: { notIn: ["Partially Released", "Released", "Covered"] },
        },
        data: { isDeleted: true },
      });

      await tx.mRPRun.update({
        where: { runNumber },
        data: { isDeleted: true },
      });
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
};

// ============================================
// BULK SOFT DELETE
// ============================================
exports.bulkRemove = async (req, res, next) => {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        message: "ids array required",
        received: req.body,
      });
    }

    const runs = await prisma.mRPRun.findMany({
      where: { id: { in: ids }, isDeleted: false },
      select: { id: true, runNumber: true },
    });

    const runNumbers = runs.map((r) => r.runNumber);
    const lockedRuns = await prisma.plannedOrder.findMany({
      where: {
        runNumber: { in: runNumbers },
        isDeleted: false,
        status: { in: ["Partially Released", "Released", "Covered"] },
      },
      select: { runNumber: true },
      distinct: ["runNumber"],
    });
    const lockedSet = new Set(lockedRuns.map((x) => x.runNumber));

    const deletable = [];
    const skipped = [];

    for (const r of runs) {
      if (lockedSet.has(r.runNumber)) {
        skipped.push({ id: r.id, runNumber: r.runNumber, reason: "punya planned order yang sudah released/covered" });
        continue;
      }
      deletable.push(r.id);
    }

    if (deletable.length === 0) {
      return res.status(409).json({
        message: "Tidak ada MRP Run yang bisa dihapus",
        deletedCount: 0,
        skipped,
      });
    }

    const deletableRuns = runs.filter((r) => deletable.includes(r.id));
    const deletableRunNumbers = deletableRuns.map((r) => r.runNumber);

    const result = await prisma.$transaction(async (tx) => {
      await tx.mRPRequirement.updateMany({
        where: { runNumber: { in: deletableRunNumbers }, isDeleted: false },
        data: { isDeleted: true },
      });

      await tx.plannedOrder.updateMany({
        where: {
          runNumber: { in: deletableRunNumbers },
          isDeleted: false,
          status: { notIn: ["Partially Released", "Released", "Covered"] },
        },
        data: { isDeleted: true },
      });

      return tx.mRPRun.updateMany({
        where: { id: { in: deletable } },
        data: { isDeleted: true },
      });
    });

    res.json({ deletedCount: result.count, skipped });
  } catch (e) {
    next(e);
  }
};

exports.__test = {
  canonicalMrpLifecycleStatus,
  expandMpsDetailsByDeliveryPhases,
  demandPeggingForPhase,
  planningStockKey,
  explicitSalesOrderNumbersForMpsDetail,
  consumeSalesOrdersAlreadyRepresentedByMps,
  productionProcessScheduleQty,
  buildMPlusOneInventoryNettingItem,
  resolveMPlusOnePreviewBasisQty,
  enrichMPlusOnePreviewDisplayQty,
  shouldExplodeNestedMbom,
  isCurrentMPlusOnePreviewRun,
  mrpApprovalEligibility,
  mrpApprovalTransitionData,
  mrpApprovalCycleMpsNumbers,
  mrpCalculationLifecycle,
  assertApprovedCurrentMrp,
  buildMrpSourceSnapshot,
  mrpSourceSnapshotMatches,
  isEmbeddedStockInputPart,
  filterWipLinesForRequirementPath,
  enrichMPlusOnePreviewRequirements,
  supersedePreviousMrpArtifacts,
};

