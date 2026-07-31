const { randomUUID } = require("crypto");
const { prisma } = require("../../index");
const {
  buildExcludeSpecialRackCondition,
} = require("../../controllers/inventory/utils/stockReservationHelpers");
const {
  syncOperationalSalesOrderStatus,
} = require("../production/sales-order/soStatusService");
const {
  emitPlanningMrpRunUpdate,
  emitPlanningPlannedOrderBulkUpdate,
} = require("../../controllers/planning/services/planningRealtimeService");
const { isSubAssemblyDetail } = require("../../utils/assemblyPolicy");
const { durationToWorkingDays } = require("../../utils/duration");
const {
  queueDirtyItem,
} = require("../../utils/mrpDirtyQueue");
const { normalizeQuantity } = require("../../utils/uomQuantity");

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

function normalizePartCode(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeUomCode(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizePartBaseOn(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function isKgUom(value) {
  return normalizeUomCode(value) === "kg";
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
  const base = getPreferredPartBase(part);
  const grossWeight = Number(base?.grossWeight || 0);
  return grossWeight > 0 ? grossWeight : null;
}

function normalizePurchasingSupplyQty(row) {
  const qty = Number(row?.qty || 0);
  if (qty <= 0) return 0;
  if (!isKgUom(row?.uomCode)) return qty;

  const kgPerPcs = resolveKgPerPcs(row?.part);
  return kgPerPcs ? qty / kgPerPcs : qty;
}

function normalizeReleaseQtyToPlannedOrderBase(qty, uomCode, plannedOrder) {
  const safeQty = Number(qty || 0);
  if (safeQty <= 0) return 0;
  if (!isKgUom(uomCode)) return safeQty;

  const kgPerPcs = resolveKgPerPcs(plannedOrder?.part);
  return kgPerPcs ? safeQty / kgPerPcs : safeQty;
}

async function buildPartiallyReleasedPlannedOrderRemainingMap(tx, plannedOrders = []) {
  const partialOrders = (plannedOrders || []).filter((row) => row.status === "Partially Released");
  if (partialOrders.length === 0) return {};

  const orderNumbers = uniq(partialOrders.map((row) => row.orderNumber));
  const [manufacturingOrders, monthlyProductionPlanDetails, purchaseRequisitionDetails] = await Promise.all([
    tx.manufacturingOrder.findMany({
      where: {
        plannedOrderNumber: { in: orderNumbers },
        referenceType: "MRPPlannedOrder",
        isDeleted: false,
        status: { not: "Cancelled" },
      },
      select: {
        plannedOrderNumber: true,
        qtyPlanned: true,
        uomCode: true,
        createdAt: true,
      },
    }),
    tx.monthlyProductionPlanDetail.findMany({
      where: {
        plannedOrderNumber: { in: orderNumbers },
        isDeleted: false,
        plan: {
          isDeleted: false,
          status: { not: "Cancelled" },
        },
      },
      select: {
        plannedOrderNumber: true,
        qtyPlanned: true,
        uomCode: true,
        createdAt: true,
      },
    }),
    tx.purchaseRequisitionDetail.findMany({
      where: {
        plannedOrderNumber: { in: orderNumbers },
        isDeleted: false,
        pr: {
          isDeleted: false,
          status: { not: "Rejected" },
        },
      },
      select: {
        plannedOrderNumber: true,
        qty: true,
        uomCode: true,
        createdAt: true,
      },
    }),
  ]);

  const orderByNumber = new Map(partialOrders.map((row) => [row.orderNumber, row]));
  const releasedByOrder = new Map();
  const addReleasedQty = (plannedOrderNumber, qty, uomCode, createdAt) => {
    const plannedOrder = orderByNumber.get(plannedOrderNumber);
    if (!plannedOrder) return;
    if (createdAt && plannedOrder.createdAt && new Date(createdAt) < new Date(plannedOrder.createdAt)) return;

    const normalizedQty = normalizeReleaseQtyToPlannedOrderBase(qty, uomCode, plannedOrder);
    releasedByOrder.set(
      plannedOrderNumber,
      Number(releasedByOrder.get(plannedOrderNumber) || 0) + normalizedQty,
    );
  };

  for (const mo of manufacturingOrders) {
    addReleasedQty(mo.plannedOrderNumber, mo.qtyPlanned, mo.uomCode, mo.createdAt);
  }
  for (const detail of monthlyProductionPlanDetails) {
    addReleasedQty(detail.plannedOrderNumber, detail.qtyPlanned, detail.uomCode, detail.createdAt);
  }
  for (const detail of purchaseRequisitionDetails) {
    addReleasedQty(detail.plannedOrderNumber, detail.qty, detail.uomCode, detail.createdAt);
  }

  const remainingMap = {};
  for (const plannedOrder of partialOrders) {
    const plannedQty = Number(plannedOrder.qty || 0);
    const releasedQty = Number(releasedByOrder.get(plannedOrder.orderNumber) || 0);
    const remainingQty = Math.max(plannedQty - releasedQty, 0);
    upsertQty(remainingMap, plannedOrder.partCode, remainingQty);
  }

  return remainingMap;
}

async function normalizePlanningStockRows(tx, stockRows = []) {
  const partCodes = uniq(stockRows.map((row) => normalizePartCode(row.partCode)));
  if (partCodes.length === 0) return stockRows;

  const parts = await tx.part.findMany({
    where: { partCode: { in: partCodes }, isDeleted: false },
    select: {
      partCode: true,
      partBases: {
        select: { baseOn: true, grossWeight: true },
      },
    },
  });
  const partByCode = new Map(parts.map((part) => [normalizePartCode(part.partCode), part]));

  return stockRows.map((row) => {
    if (String(row.stockType || "").trim().toLowerCase() !== "material") return row;
    const kgPerPcs = resolveKgPerPcs(partByCode.get(normalizePartCode(row.partCode)));
    if (!kgPerPcs) return row;
    return {
      ...row,
      qtyAvailable: Number(row.qtyAvailable || 0) / kgPerPcs,
    };
  });
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

function buildBufferStockNote(bufferPercent, bufferQty) {
  if (!bufferPercent || !bufferQty) return null;
  return `Buffer stock ${bufferPercent}% = ${bufferQty}`;
}

function resolvePlanningPolicy(part) {
  return part?.planningPolicy === "MTS" ? "MTS" : "MTO";
}

function resolveSnapshotDemandQty(mpsQty, soQty, part) {
  if (resolvePlanningPolicy(part) === "MTO") {
    const normalizedSoQty = Number(soQty || 0);
    return normalizedSoQty > 0 ? normalizedSoQty : Number(mpsQty || 0);
  }
  return Math.max(Number(mpsQty || 0), Number(soQty || 0));
}

function uniq(values) {
  return [...new Set((values || []).filter(Boolean))];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toSafeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildSoPlanHorizonDays(soDate, cutoffDate) {
  const start = toSafeDate(soDate);
  const end = toSafeDate(cutoffDate);
  if (!start || !end) return 0;
  return Math.max(Math.ceil((end.getTime() - start.getTime()) / MS_PER_DAY), 0);
}

function upsertQty(map, key, qty) {
  const normalizedKey = normalizePartCode(key);
  if (!normalizedKey) return;
  const safeQty = Number(qty || 0);
  if (safeQty <= 0) return;
  map[normalizedKey] = Number(map[normalizedKey] || 0) + safeQty;
}

function resolveOpenManufacturingSupplyQty(mo) {
  const plannedQty = Number(mo?.qtyPlanned || 0);
  if (plannedQty <= 0) return 0;

  // Fulfillment MO follows the MO header. Historical rows may only have
  // qtyProduced populated, so keep it as a fallback for older data.
  const fulfilledQty = Math.max(
    Number(mo?.qtyGood || 0),
    Number(mo?.qtyProduced || 0),
  );
  const rejectedQty = Number(mo?.qtyReject || 0);

  return Math.max(plannedQty - fulfilledQty - rejectedQty, 0);
}

function extractPlannedOrderSeq(value) {
  return parseInt(String(value || "").match(/-(\d+)$/)?.[1] || "0", 10);
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

function isValidLinkedMppSupply(detail, plannedOrderByNumber = new Map(), currentSoPlanNumber = null) {
  if (!detail?.plannedOrderNumber) return true;
  const plannedOrder = plannedOrderByNumber.get(detail.plannedOrderNumber);
  if (!plannedOrder) return false;
  if (!["Monthly Planned", "Partially Released", "Released"].includes(plannedOrder.status)) return false;
  if (detail.createdAt && plannedOrder.createdAt && new Date(detail.createdAt) < new Date(plannedOrder.createdAt)) {
    return false;
  }
  if (
    currentSoPlanNumber &&
    String(plannedOrder.referenceNumber || "").startsWith("MRP-SO-") &&
    plannedOrder.referenceNumber !== currentSoPlanNumber
  ) {
    return false;
  }
  return true;
}

function isValidLinkedMoSupply(mo, plannedOrderByNumber = new Map(), currentSoPlanNumber = null) {
  if (!mo?.plannedOrderNumber) return true;
  const plannedOrder = plannedOrderByNumber.get(mo.plannedOrderNumber);
  if (!plannedOrder) return false;
  if (!["Partially Released", "Released"].includes(plannedOrder.status)) return false;
  if (mo.createdAt && plannedOrder.createdAt && new Date(mo.createdAt) < new Date(plannedOrder.createdAt)) {
    return false;
  }
  if (
    currentSoPlanNumber &&
    String(plannedOrder.referenceNumber || "").startsWith("MRP-SO-") &&
    plannedOrder.referenceNumber !== currentSoPlanNumber
  ) {
    return false;
  }
  return true;
}

function buildSnapshotPrefix(date = new Date()) {
  const target = new Date(date);
  const year = target.getFullYear();
  const month = String(target.getMonth() + 1).padStart(2, "0");
  const day = String(target.getDate()).padStart(2, "0");
  return `MRP-SNAP-${year}${month}${day}`;
}

async function generateSnapshotNumber(tx = prisma, date = new Date()) {
  const prefix = `${buildSnapshotPrefix(date)}-`;
  const lastSnapshot = await tx.mRPPartialSnapshot.findFirst({
    where: { snapshotNumber: { startsWith: prefix } },
    orderBy: { snapshotNumber: "desc" },
    select: { snapshotNumber: true },
  });

  let nextSeq = 1;
  if (lastSnapshot?.snapshotNumber) {
    const match = lastSnapshot.snapshotNumber.match(/-(\d+)$/);
    if (match) nextSeq = Number(match[1]) + 1;
  }

  return `${prefix}${String(nextSeq).padStart(3, "0")}`;
}

async function loadPartMap(tx, itemIds = []) {
  const ids = uniq(itemIds);
  if (ids.length === 0) return new Map();

  const parts = await tx.part.findMany({
    where: { id: { in: ids }, isDeleted: false },
    select: { id: true, partCode: true, partName: true, bufferStock: true, planningPolicy: true },
  });

  return new Map(parts.map((part) => [part.id, part]));
}

async function buildOpenSupplyMap(tx, partCodes, cutoffDate, options = {}) {
  const normalizedPartCodes = uniq((partCodes || []).map(normalizePartCode));
  if (normalizedPartCodes.length === 0) return {};

  const whereDate = cutoffDate ? new Date(cutoffDate) : null;
  const excludedRunNumbers = uniq(options.excludeRunNumbers || []);
  const currentSoPlanNumber = options.soNumber ? buildSoPlanNumber(options.soNumber) : null;

  const plannedOrderWhere = {
    partCode: { in: normalizedPartCodes },
    isDeleted: false,
    status: { in: ["Planned", "Partially Released", "Covered"] },
  };
  if (whereDate) {
    plannedOrderWhere.requiredDate = { lte: whereDate };
  }

  const [
    plannedOrders,
    manufacturingOrders,
    monthlyProductionPlanDetails,
    purchaseRequisitionDetails,
    purchaseOrderDetails,
  ] = await Promise.all([
    tx.plannedOrder.findMany({
      where: plannedOrderWhere,
      select: {
        orderNumber: true,
        runNumber: true,
        partCode: true,
        qty: true,
        uomCode: true,
        orderType: true,
        status: true,
        referenceNumber: true,
        createdAt: true,
        part: {
          select: {
            partBases: {
              select: { baseOn: true, grossWeight: true },
            },
          },
        },
      },
    }),
    tx.manufacturingOrder.findMany({
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
        part: { partCode: { in: normalizedPartCodes } },
      },
      select: {
        moNumber: true,
        qtyPlanned: true,
        qtyProduced: true,
        qtyGood: true,
        qtyReject: true,
        part: { select: { partCode: true } },
      },
    }),
    tx.monthlyProductionPlanDetail.findMany({
      where: {
        isDeleted: false,
        partCode: { in: normalizedPartCodes },
        status: { in: ["Planned", "Partially Released"] },
        ...(whereDate ? { OR: [{ requiredDate: null }, { requiredDate: { lte: whereDate } }] } : {}),
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
    }),
    tx.purchaseRequisitionDetail.findMany({
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
    }),
    tx.purchaseOrderDetail.findMany({
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
      },
    }),
  ]);

  const supplyPartCodes = uniq([
    ...purchaseRequisitionDetails.map((row) => normalizePartCode(row.partCode)),
    ...purchaseOrderDetails.map((row) => normalizePartCode(row.partCode)),
  ]);
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

  let reservedSupplyNumbers = new Set();
  if (options.soNumber) {
    const supplyNumbers = [
      ...plannedOrders.map((row) => row.orderNumber).filter(Boolean),
      ...manufacturingOrders.map((row) => row.moNumber).filter(Boolean),
    ];
    if (supplyNumbers.length > 0) {
      const peggings = await tx.mRPPegging.findMany({
        where: {
          demandType: "SO",
          demandNumber: { not: options.soNumber },
          status: "Active",
          supplyNumber: { in: supplyNumbers },
        },
        select: { supplyNumber: true },
      });
      reservedSupplyNumbers = new Set(peggings.map((row) => row.supplyNumber).filter(Boolean));
    }
  }

  const eligiblePlannedOrders = plannedOrders.filter((row) => {
    if (reservedSupplyNumbers.has(row.orderNumber)) return false;
    if (row.status === "Planned" && excludedRunNumbers.includes(row.runNumber)) return false;
    if (
      currentSoPlanNumber &&
      String(row.referenceNumber || "").startsWith("MRP-SO-") &&
      row.referenceNumber !== currentSoPlanNumber
    ) {
      return false;
    }
    return true;
  });
  const partialPlannedRemainingMap = await buildPartiallyReleasedPlannedOrderRemainingMap(tx, eligiblePlannedOrders);
  const supplyMap = {};
  for (const row of eligiblePlannedOrders) {
    if (["Planned", "Covered"].includes(row.status)) {
      upsertQty(supplyMap, row.partCode, row.qty);
    }
  }
  for (const [partCode, qty] of Object.entries(partialPlannedRemainingMap)) {
    upsertQty(supplyMap, partCode, qty);
  }

  for (const row of manufacturingOrders) {
    if (reservedSupplyNumbers.has(row.moNumber)) continue;
    const remaining = resolveOpenManufacturingSupplyQty(row);
    upsertQty(supplyMap, row.part?.partCode, remaining);
  }

  const prPlannedOrderNumbers = uniq(purchaseRequisitionDetails.map((row) => row.plannedOrderNumber).filter(Boolean));
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

  const mppPlannedOrderNumbers = uniq(monthlyProductionPlanDetails.map((row) => row.plannedOrderNumber).filter(Boolean));
  const mppPlannedOrders = mppPlannedOrderNumbers.length > 0
    ? await tx.plannedOrder.findMany({
      where: {
        orderNumber: { in: mppPlannedOrderNumbers },
        isDeleted: false,
      },
      select: { orderNumber: true, status: true, referenceNumber: true, createdAt: true },
    })
    : [];
  const mppPlannedOrderByNumber = new Map(mppPlannedOrders.map((order) => [order.orderNumber, order]));

  for (const row of monthlyProductionPlanDetails) {
    if (!isValidLinkedMppSupply(row, mppPlannedOrderByNumber, currentSoPlanNumber)) continue;
    const openQty = Math.max(Number(row.qtyPlanned || 0) - Number(row.qtyReleased || 0), 0);
    upsertQty(supplyMap, row.partCode, openQty);
  }

  for (const row of purchaseRequisitionDetails) {
    if (!isValidLinkedPrSupply(row, prPlannedOrderByNumber)) continue;
    const openQty = Math.max(
      normalizePurchasingSupplyQty({
        ...row,
        qty: Number(row.qty || 0) - Number(row.orderedQty || 0),
        part: supplyPartByCode.get(normalizePartCode(row.partCode)),
      }),
      0,
    );
    upsertQty(supplyMap, row.partCode, openQty);
  }

  for (const row of purchaseOrderDetails) {
    const openQty = Math.max(
      normalizePurchasingSupplyQty({
        ...row,
        qty: Number(row.qty || 0) - Number(row.qtyReceived || 0),
        part: supplyPartByCode.get(normalizePartCode(row.partCode)),
      }),
      0,
    );
    upsertQty(supplyMap, row.partCode, openQty);
  }

  return supplyMap;
}

async function buildOpenMppSupplyMap(tx, partCodes, cutoffDate, options = {}) {
  const normalizedPartCodes = uniq((partCodes || []).map(normalizePartCode));
  if (normalizedPartCodes.length === 0) return {};

  const whereDate = cutoffDate ? new Date(cutoffDate) : null;
  const currentSoPlanNumber = options.soNumber ? buildSoPlanNumber(options.soNumber) : null;

  const monthlyProductionPlanDetails = await tx.monthlyProductionPlanDetail.findMany({
    where: {
      isDeleted: false,
      partCode: { in: normalizedPartCodes },
      status: { in: ["Planned", "Partially Released"] },
      ...(whereDate ? { OR: [{ requiredDate: null }, { requiredDate: { lte: whereDate } }] } : {}),
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

  const plannedOrderNumbers = uniq(monthlyProductionPlanDetails.map((row) => row.plannedOrderNumber).filter(Boolean));
  const plannedOrders = plannedOrderNumbers.length > 0
    ? await tx.plannedOrder.findMany({
      where: {
        orderNumber: { in: plannedOrderNumbers },
        isDeleted: false,
      },
      select: { orderNumber: true, status: true, referenceNumber: true, createdAt: true },
    })
    : [];
  const plannedOrderByNumber = new Map(plannedOrders.map((order) => [order.orderNumber, order]));

  const supplyMap = {};
  for (const row of monthlyProductionPlanDetails) {
    if (!isValidLinkedMppSupply(row, plannedOrderByNumber, currentSoPlanNumber)) continue;
    const openQty = Math.max(Number(row.qtyPlanned || 0) - Number(row.qtyReleased || 0), 0);
    upsertQty(supplyMap, row.partCode, openQty);
  }
  return supplyMap;
}

async function buildOpenPartialPlannedOrderSupplyMap(tx, partCodes, cutoffDate, options = {}) {
  const normalizedPartCodes = uniq((partCodes || []).map(normalizePartCode));
  if (normalizedPartCodes.length === 0) return {};

  const whereDate = cutoffDate ? new Date(cutoffDate) : null;
  const currentSoPlanNumber = options.soNumber ? buildSoPlanNumber(options.soNumber) : null;

  const plannedOrders = await tx.plannedOrder.findMany({
    where: {
      partCode: { in: normalizedPartCodes },
      isDeleted: false,
      status: "Partially Released",
      ...(whereDate ? { requiredDate: { lte: whereDate } } : {}),
    },
    select: {
      orderNumber: true,
      runNumber: true,
      partCode: true,
      qty: true,
      uomCode: true,
      orderType: true,
      status: true,
      referenceNumber: true,
      createdAt: true,
      part: {
        select: {
          partBases: {
            select: { baseOn: true, grossWeight: true },
          },
        },
      },
    },
  });

  const eligiblePlannedOrders = plannedOrders.filter((row) => {
    if (
      currentSoPlanNumber &&
      String(row.referenceNumber || "").startsWith("MRP-SO-") &&
      row.referenceNumber !== currentSoPlanNumber
    ) {
      return false;
    }
    return true;
  });

  return buildPartiallyReleasedPlannedOrderRemainingMap(tx, eligiblePlannedOrders);
}

async function buildOpenMoSupplyMap(tx, partCodes, cutoffDate, options = {}) {
  const normalizedPartCodes = uniq((partCodes || []).map(normalizePartCode));
  if (normalizedPartCodes.length === 0) return {};

  const whereDate = cutoffDate ? new Date(cutoffDate) : null;
  const currentSoPlanNumber = options.soNumber ? buildSoPlanNumber(options.soNumber) : null;

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
      part: { partCode: { in: normalizedPartCodes } },
    },
    select: {
      moNumber: true,
      qtyPlanned: true,
      qtyProduced: true,
      qtyGood: true,
      qtyReject: true,
      plannedOrderNumber: true,
      createdAt: true,
      part: { select: { partCode: true } },
    },
  });

  const plannedOrderNumbers = uniq(manufacturingOrders.map((row) => row.plannedOrderNumber).filter(Boolean));
  const plannedOrders = plannedOrderNumbers.length > 0
    ? await tx.plannedOrder.findMany({
      where: {
        orderNumber: { in: plannedOrderNumbers },
        isDeleted: false,
      },
      select: { orderNumber: true, status: true, referenceNumber: true, createdAt: true },
    })
    : [];
  const plannedOrderByNumber = new Map(plannedOrders.map((order) => [order.orderNumber, order]));

  const supplyMap = {};
  for (const row of manufacturingOrders) {
    if (!isValidLinkedMoSupply(row, plannedOrderByNumber, currentSoPlanNumber)) continue;
    upsertQty(supplyMap, row.part?.partCode, resolveOpenManufacturingSupplyQty(row));
  }
  return supplyMap;
}

async function buildBomImpactTree(tx, dirtyItemIds = []) {
  const partMap = await loadPartMap(tx, dirtyItemIds);
  const queue = uniq(dirtyItemIds);
  const visited = new Set(queue);
  const treeNodes = [];

  for (const itemId of queue) {
    const part = partMap.get(itemId);
    treeNodes.push({
      itemId,
      partCode: part?.partCode || null,
      partName: part?.partName || null,
      level: 0,
      path: part?.partCode ? [part.partCode] : [itemId],
      parentItemId: null,
    });
  }

  while (queue.length > 0) {
    const childItemId = queue.shift();
    const childNode = treeNodes.find((node) => node.itemId === childItemId) || {
      itemId: childItemId,
      level: 0,
      path: [childItemId],
    };

    const parentRelations = await tx.bOMRelation.findMany({
      where: { childItemId, isDeleted: false },
      select: {
        parentItemId: true,
        levelComponent: true,
        mbomHeaderId: true,
      },
    });

    for (const relation of parentRelations) {
      const parentPart = partMap.get(relation.parentItemId);
      const parentLevel = childNode.level + 1;
      const existing = treeNodes.find((node) => node.itemId === relation.parentItemId);
      const parentPath = parentPart?.partCode
        ? [parentPart.partCode, ...(childNode.path || [])]
        : [relation.parentItemId, ...(childNode.path || [])];

      if (!existing) {
        treeNodes.push({
          itemId: relation.parentItemId,
          partCode: parentPart?.partCode || null,
          partName: parentPart?.partName || null,
          level: parentLevel,
          path: parentPath,
          parentItemId: childItemId,
          relationLevelComponent: relation.levelComponent,
          mbomHeaderId: relation.mbomHeaderId || null,
        });
      } else if (parentLevel < existing.level) {
        existing.level = parentLevel;
        existing.path = parentPath;
        existing.parentItemId = childItemId;
        existing.relationLevelComponent = relation.levelComponent;
        existing.mbomHeaderId = relation.mbomHeaderId || existing.mbomHeaderId || null;
      }

      if (!visited.has(relation.parentItemId)) {
        visited.add(relation.parentItemId);
        queue.push(relation.parentItemId);
      }
    }
  }

  treeNodes.sort((a, b) => a.level - b.level || String(a.partCode || a.itemId).localeCompare(String(b.partCode || b.itemId)));
  return treeNodes;
}

async function buildSupplyDemandSnapshot(tx, impactedTree, cutoffDate) {
  const impactedItemIds = uniq((impactedTree || []).map((node) => node.itemId));
  if (impactedItemIds.length === 0) {
    return { items: [], totals: { demand: 0, supply: 0, onHand: 0, net: 0 } };
  }

  const partMap = await loadPartMap(tx, impactedItemIds);
  const partCodes = [...partMap.values()].map((part) => part.partCode).filter(Boolean);
  const onHandRows = await tx.stockBalance.findMany({
    where: {
      AND: [
        { isDeleted: false, partCode: { in: partCodes } },
        buildExcludeSpecialRackCondition(),
      ],
    },
    select: { partCode: true, stockType: true, qtyAvailable: true },
  });
  const normalizedOnHandRows = await normalizePlanningStockRows(tx, onHandRows);
  const onHandMap = normalizedOnHandRows.reduce((acc, row) => {
    acc[row.partCode] = Number(acc[row.partCode] || 0) + Number(row.qtyAvailable || 0);
    return acc;
  }, {});
  const supplyMap = await buildOpenSupplyMap(tx, partCodes, cutoffDate, {});

  const mpsDetails = await tx.mPSDetail.findMany({
    where: {
      isDeleted: false,
      partId: { in: impactedItemIds },
      mps: { isDeleted: false, status: { in: ["Confirmed", "Released"] } },
      ...(cutoffDate ? { endDate: { lte: cutoffDate } } : {}),
    },
    select: {
      partId: true,
      partCode: true,
      qtyPlanned: true,
      mpsNumber: true,
      lineNumber: true,
      startDate: true,
      endDate: true,
      forecastPeriodOffset: true,
    },
    orderBy: [{ endDate: "asc" }, { lineNumber: "asc" }],
  });

  const soDetails = await tx.salesOrderDetail.findMany({
    where: {
      isDeleted: false,
      partCode: { in: partCodes },
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
      qty: true,
      qtyDelivered: true,
      deliveryDate: true,
      soHeader: { select: { soDate: true, deliveryDate: true } },
    },
  });

  const cutoffTime = cutoffDate ? new Date(cutoffDate).getTime() : null;
  const eligibleSoDetails = soDetails.filter((row) => {
    if (cutoffTime == null) return true;
    const demandDate = row.deliveryDate || row.soHeader?.deliveryDate || row.soHeader?.soDate;
    return demandDate && new Date(demandDate).getTime() <= cutoffTime;
  });

  const forecastDemandMap = {};
  const soDemandMap = {};
  for (const row of mpsDetails) {
    const part = partMap.get(row.partId);
    upsertQty(forecastDemandMap, row.partCode || part?.partCode, row.qtyPlanned);
  }
  for (const row of eligibleSoDetails) {
    upsertQty(
      soDemandMap,
      row.partCode,
      Math.max(Number(row.qty || 0) - Number(row.qtyDelivered || 0), 0),
    );
  }

  const demandMap = {};
  for (const node of impactedTree) {
    const part = partMap.get(node.itemId);
    const code = normalizePartCode(node.partCode || part?.partCode);
    if (!code) continue;
    const bufferedDemand = applyBufferStockPercent(
      resolveSnapshotDemandQty(forecastDemandMap[code], soDemandMap[code], part),
      part,
    );
    upsertQty(demandMap, code, bufferedDemand.grossRequirement);
  }

  const items = impactedTree.map((node) => {
    const onHandQty = Number(onHandMap[node.partCode] || 0);
    const openSupplyQty = Number(supplyMap[node.partCode] || 0);
    const grossDemandQty = Number(demandMap[node.partCode] || 0);
    const forecastDemandQty = Number(forecastDemandMap[node.partCode] || 0);
    const soDemandQty = Number(soDemandMap[node.partCode] || 0);
    const effectiveDemandQty = resolveSnapshotDemandQty(
      forecastDemandQty,
      soDemandQty,
      partMap.get(node.itemId),
    );
    const netRequirement = Math.max(grossDemandQty - onHandQty - openSupplyQty, 0);

    return {
      ...node,
      onHandQty,
      openSupplyQty,
      forecastDemandQty,
      soDemandQty,
      effectiveDemandQty,
      grossDemandQty,
      netRequirement,
      sourceMpsNumbers: uniq(
        mpsDetails
          .filter((row) => row.partCode === node.partCode || partMap.get(row.partId)?.partCode === node.partCode)
          .map((row) => row.mpsNumber),
      ),
    };
  });

  const totals = items.reduce(
    (acc, row) => {
      acc.demand += Number(row.grossDemandQty || 0);
      acc.supply += Number(row.openSupplyQty || 0);
      acc.onHand += Number(row.onHandQty || 0);
      acc.net += Number(row.netRequirement || 0);
      return acc;
    },
    { demand: 0, supply: 0, onHand: 0, net: 0 },
  );

  return {
    items,
    totals,
    impactedItemIds,
    mpsDetails,
    soDetails: eligibleSoDetails,
  };
}

function buildDatePrefix(date = new Date()) {
  const target = new Date(date);
  const year = target.getFullYear();
  const month = String(target.getMonth() + 1).padStart(2, "0");
  const day = String(target.getDate()).padStart(2, "0");
  return `MRP-${year}${month}${day}`;
}

function buildSoPlanNumber(soNumber) {
  return soNumber ? `MRP-${soNumber}` : null;
}

async function resolvePlanIdentity(tx, { planNumber, planScope }) {
  if (!planNumber) {
    return {
      planNumber: null,
      planRevision: 1,
      planScope: planScope || "Manual",
      isCurrentPlan: true,
    };
  }

  const latestPlanRun = await tx.mRPRun.findFirst({
    where: { planNumber },
    orderBy: [{ planRevision: "desc" }, { runDate: "desc" }],
    select: { planRevision: true, runNumber: true },
  });

  return {
    planNumber,
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

async function closePeggingsForSupersededPlannedOrders(tx, orderNumbers = [], notes) {
  const numbers = uniq(orderNumbers);
  if (numbers.length === 0) return;

  await tx.mRPPegging.updateMany({
    where: {
      supplyType: "PlannedOrder",
      supplyNumber: { in: numbers },
      status: "Active",
    },
    data: {
      status: "Closed",
      notes: notes || "Superseded planned order",
    },
  });
}

function resolveMrpRetentionOptions(options = {}) {
  const keepRevisions = Number(
    options.keepRevisions ?? process.env.MRP_RETENTION_REVISIONS ?? 5,
  );
  const retentionDays = Number(
    options.retentionDays ?? process.env.MRP_RETENTION_DAYS ?? 30,
  );

  return {
    keepRevisions: Number.isFinite(keepRevisions) && keepRevisions > 0 ? Math.floor(keepRevisions) : 5,
    retentionDays: Number.isFinite(retentionDays) && retentionDays >= 0 ? Math.floor(retentionDays) : 30,
  };
}

async function cleanupSupersededMrpArtifacts(tx = prisma, options = {}) {
  const { keepRevisions, retentionDays } = resolveMrpRetentionOptions(options);
  const cutoffDate = new Date(Date.now() - retentionDays * MS_PER_DAY);

  const supersededRuns = await tx.mRPRun.findMany({
    where: {
      isDeleted: true,
      isCurrentPlan: false,
      planNumber: { not: null },
    },
    select: {
      runNumber: true,
      planNumber: true,
      planRevision: true,
      runDate: true,
      createdAt: true,
    },
    orderBy: [
      { planNumber: "asc" },
      { planRevision: "desc" },
      { runDate: "desc" },
      { createdAt: "desc" },
    ],
  });

  const runsByPlan = new Map();
  for (const run of supersededRuns) {
    const key = run.planNumber;
    if (!runsByPlan.has(key)) runsByPlan.set(key, []);
    runsByPlan.get(key).push(run);
  }

  const candidates = [];
  for (const runs of runsByPlan.values()) {
    candidates.push(
      ...runs
        .slice(keepRevisions)
        .filter((run) => new Date(run.runDate || run.createdAt) <= cutoffDate),
    );
  }

  const summary = {
    retentionDays,
    keepRevisions,
    candidateRuns: candidates.length,
    deletedRuns: 0,
    deletedRequirements: 0,
    deletedPlannedOrders: 0,
    deletedPeggings: 0,
    skippedLinkedRuns: 0,
  };

  for (const run of candidates) {
    const plannedOrders = await tx.plannedOrder.findMany({
      where: { runNumber: run.runNumber },
      select: { orderNumber: true },
    });
    const orderNumbers = plannedOrders.map((order) => order.orderNumber).filter(Boolean);

    let linkedCount = 0;
    if (orderNumbers.length > 0) {
      const [moCount, mppCount, prCount] = await Promise.all([
        tx.manufacturingOrder.count({
          where: { plannedOrderNumber: { in: orderNumbers }, isDeleted: false },
        }),
        tx.monthlyProductionPlanDetail.count({
          where: { plannedOrderNumber: { in: orderNumbers }, isDeleted: false },
        }),
        tx.purchaseRequisitionDetail.count({
          where: { plannedOrderNumber: { in: orderNumbers }, isDeleted: false },
        }),
      ]);
      linkedCount = moCount + mppCount + prCount;
    }

    if (linkedCount > 0) {
      summary.skippedLinkedRuns += 1;
      continue;
    }

    const [requirementCount, plannedOrderCount] = await Promise.all([
      tx.mRPRequirement.count({ where: { runNumber: run.runNumber } }),
      tx.plannedOrder.count({ where: { runNumber: run.runNumber } }),
    ]);

    let deletedPeggings = { count: 0 };
    if (orderNumbers.length > 0) {
      deletedPeggings = await tx.mRPPegging.deleteMany({
        where: {
          supplyType: "PlannedOrder",
          supplyNumber: { in: orderNumbers },
        },
      });
    }

    await tx.mRPRun.delete({ where: { runNumber: run.runNumber } });

    summary.deletedRuns += 1;
    summary.deletedRequirements += requirementCount;
    summary.deletedPlannedOrders += plannedOrderCount;
    summary.deletedPeggings += deletedPeggings.count;
  }

  return summary;
}

async function generateRunNumber(tx = prisma, date = new Date()) {
  const prefix = `${buildDatePrefix(date)}-`;
  const lastRun = await tx.mRPRun.findFirst({
    where: { runNumber: { startsWith: prefix } },
    orderBy: { runNumber: "desc" },
    select: { runNumber: true },
  });

  let nextSeq = 1;
  if (lastRun?.runNumber) {
    const match = lastRun.runNumber.match(/-(\d+)$/);
    if (match) nextSeq = Number(match[1]) + 1;
  }

  return `${prefix}${String(nextSeq).padStart(3, "0")}`;
}

async function generatePlannedOrderNumber(tx = prisma, orderType, date = new Date()) {
  const target = new Date(date);
  const year = target.getFullYear();
  const month = String(target.getMonth() + 1).padStart(2, "0");
  const day = String(target.getDate()).padStart(2, "0");
  const prefix = `${orderType === "Production" ? "PMO" : "PLO"}-${year}${month}${day}-`;

  const [lastOrder, lastPrDetail, lastMo, lastMppDetail] = await Promise.all([
    tx.plannedOrder.findFirst({
      where: { orderNumber: { startsWith: prefix } },
      orderBy: { orderNumber: "desc" },
      select: { orderNumber: true },
    }),
    orderType === "Purchase"
      ? tx.purchaseRequisitionDetail.findFirst({
        where: { plannedOrderNumber: { startsWith: prefix } },
        orderBy: { plannedOrderNumber: "desc" },
        select: { plannedOrderNumber: true },
      })
      : null,
    orderType === "Production"
      ? tx.manufacturingOrder.findFirst({
        where: { plannedOrderNumber: { startsWith: prefix } },
        orderBy: { plannedOrderNumber: "desc" },
        select: { plannedOrderNumber: true },
      })
      : null,
    orderType === "Production"
      ? tx.monthlyProductionPlanDetail.findFirst({
        where: { plannedOrderNumber: { startsWith: prefix } },
        orderBy: { plannedOrderNumber: "desc" },
        select: { plannedOrderNumber: true },
      })
      : null,
  ]);

  const nextSeq = Math.max(
    extractPlannedOrderSeq(lastOrder?.orderNumber),
    extractPlannedOrderSeq(lastPrDetail?.plannedOrderNumber),
    extractPlannedOrderSeq(lastMo?.plannedOrderNumber),
    extractPlannedOrderSeq(lastMppDetail?.plannedOrderNumber),
  ) + 1;

  return `${prefix}${String(nextSeq).padStart(4, "0")}`;
}

async function createPlannedOrderSequencer(tx = prisma, date = new Date()) {
  const target = new Date(date);
  const year = target.getFullYear();
  const month = String(target.getMonth() + 1).padStart(2, "0");
  const day = String(target.getDate()).padStart(2, "0");
  const dateStr = `${year}${month}${day}`;

  const [lastPlo, lastPloPrDetail, lastPmo, lastPmoMo, lastPmoMppDetail] = await Promise.all([
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

  let poSeq = Math.max(
    extractPlannedOrderSeq(lastPlo?.orderNumber),
    extractPlannedOrderSeq(lastPloPrDetail?.plannedOrderNumber),
  );
  let moSeq = Math.max(
    extractPlannedOrderSeq(lastPmo?.orderNumber),
    extractPlannedOrderSeq(lastPmoMo?.plannedOrderNumber),
    extractPlannedOrderSeq(lastPmoMppDetail?.plannedOrderNumber),
  );

  return (orderType) => {
    const isProduction = orderType === "Production";
    const prefix = isProduction ? "PMO" : "PLO";
    if (isProduction) moSeq += 1;
    else poSeq += 1;
    const seq = isProduction ? moSeq : poSeq;
    return `${prefix}-${dateStr}-${String(seq).padStart(4, "0")}`;
  };
}

async function expandImpactedItemIds(tx = prisma, dirtyItemIds = []) {
  const queue = [...new Set(dirtyItemIds.filter(Boolean))];
  const impacted = new Set(queue);

  while (queue.length > 0) {
    const childId = queue.shift();
    const parents = await tx.bOMRelation.findMany({
      where: {
        childItemId: childId,
        isDeleted: false,
      },
      select: { parentItemId: true },
    });

    for (const row of parents) {
      if (!impacted.has(row.parentItemId)) {
        impacted.add(row.parentItemId);
        queue.push(row.parentItemId);
      }
    }
  }

  return [...impacted];
}

async function rebuildPartialSnapshot(tx = prisma, dirtyItemIds = [], cutoffDate = new Date()) {
  const impactedTree = await buildBomImpactTree(tx, dirtyItemIds);
  const snapshot = await buildSupplyDemandSnapshot(tx, impactedTree, cutoffDate);
  return {
    impactedTree,
    snapshot,
  };
}

async function persistPartialSnapshot(tx = prisma, payload = {}) {
  const {
    snapshotDate = new Date(),
    cutoffDate = null,
    dirtyCount = 0,
    impactedCount = 0,
    mpsCount = 0,
    runScope = "Partial",
    status = "Completed",
    snapshotJson,
    resultsJson = null,
    notes = null,
    createdBy = "system",
  } = payload;

  if (!snapshotJson) {
    throw new Error("snapshotJson wajib diisi");
  }

  const snapshotNumber = await generateSnapshotNumber(tx, snapshotDate);

  return tx.mRPPartialSnapshot.create({
    data: {
      snapshotNumber,
      snapshotDate,
      runScope,
      cutoffDate,
      dirtyCount,
      impactedCount,
      mpsCount,
      status,
      snapshotJson,
      resultsJson,
      notes,
      createdBy,
    },
  });
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

async function findImpactedMpsNumbers(tx = prisma, impactedItemIds = []) {
  if (!impactedItemIds || impactedItemIds.length === 0) return [];

  const details = await tx.mPSDetail.findMany({
    where: {
      isDeleted: false,
      partId: { in: impactedItemIds },
      mps: {
        isDeleted: false,
        status: { in: ["Confirmed", "Released"] },
      },
    },
    select: { mpsNumber: true },
    distinct: ["mpsNumber"],
  });

  return details.map((row) => row.mpsNumber);
}

async function findMpsDetailPartCodes(tx = prisma, mpsNumber) {
  if (!mpsNumber) return [];

  const details = await tx.mPSDetail.findMany({
    where: {
      mpsNumber,
      isDeleted: false,
      status: { not: "Cancelled" },
    },
    select: { partCode: true },
  });

  return uniq(details.map((detail) => normalizePartCode(detail.partCode)));
}

async function findActiveMbomForPart(tx = prisma, partId, targetDate = new Date()) {
  if (!partId) return null;
  const validDate = new Date(targetDate);

  return tx.mBOMHeader.findFirst({
    where: {
      partId,
      isDeleted: false,
      AND: [
        { OR: [{ effectiveDate: null }, { effectiveDate: { lte: validDate } }] },
        { OR: [{ expiryDate: null }, { expiryDate: { gte: validDate } }] },
      ],
    },
    orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
    select: { id: true, noReg: true, uomCode: true },
  });
}

async function resolveMbomLeadTimeDays(tx = prisma, mbomNoReg) {
  if (!mbomNoReg) return 0;

  const details = await tx.mBOMDetail.findMany({
    where: {
      noReg: mbomNoReg,
      isDeleted: false,
    },
    select: { leadTime: true, leadTimeUnit: true },
  });
  return details.reduce((maximum, detail) => Math.max(maximum, durationToWorkingDays(detail.leadTime, detail.leadTimeUnit)), 0);
}

async function resolvePartProjectedAvailable(tx, partCode, targetDate, projectedAvailableMap, runNumber, options = {}) {
  const code = normalizePartCode(partCode);
  if (!code) return 0;
  if (projectedAvailableMap[code] !== undefined) {
    return Number(projectedAvailableMap[code] || 0);
  }

  const stockRows = await tx.stockBalance.findMany({
    where: {
      AND: [
        { partCode: code, isDeleted: false },
        buildExcludeSpecialRackCondition(),
      ],
    },
    select: { partCode: true, stockType: true, qtyAvailable: true },
  });
  const normalizedStockRows = await normalizePlanningStockRows(tx, stockRows);
  const supplyMap = await buildOpenSupplyMap(tx, [code], targetDate, {
    excludeRunNumbers: [runNumber],
    soNumber: options.soNumber,
  });

  projectedAvailableMap[code] =
    normalizedStockRows.reduce((sum, row) => sum + Number(row.qtyAvailable || 0), 0) +
    Number(supplyMap[code] || 0);
  return projectedAvailableMap[code];
}

async function resolvePartActualAvailable(tx, partCode, projectedActualAvailableMap) {
  const code = normalizePartCode(partCode);
  if (!code) return 0;
  if (projectedActualAvailableMap[code] !== undefined) {
    return Number(projectedActualAvailableMap[code] || 0);
  }

  const stockRows = await tx.stockBalance.findMany({
    where: {
      AND: [
        { partCode: code, isDeleted: false },
        buildExcludeSpecialRackCondition(),
      ],
    },
    select: { partCode: true, stockType: true, qtyAvailable: true },
  });
  const normalizedStockRows = await normalizePlanningStockRows(tx, stockRows);
  projectedActualAvailableMap[code] = normalizedStockRows.reduce(
    (sum, row) => sum + Number(row.qtyAvailable || 0),
    0,
  );
  return projectedActualAvailableMap[code];
}

async function explodeMbomForSoOnly(
  tx,
  runNumber,
  mbomHeader,
  quantity,
  requiredDate,
  level,
  projectedAvailableMap,
  projectedActualAvailableMap,
  visitedMbomIds = new Set(),
  options = {},
) {
  if (!mbomHeader?.noReg || level > 10 || Number(quantity || 0) <= 0) {
    return [];
  }

  const mbom = await tx.mBOMHeader.findFirst({
    where: { id: mbomHeader.id, isDeleted: false },
    include: {
      details: {
        where: { isDeleted: false },
        include: { part: true },
      },
    },
  });

  if (!mbom?.details?.length) return [];

  const requirements = [];
  const requirementIdByMbomDetailId = new Map();
  const childSequenceByParentId = new Map();
  const projectedMoSupplyMap = options.projectedMoSupplyMap || {};
  const orderedDetails = sortMbomDetailsParentFirst(mbom.details.filter((row) => row.part));
  for (const detail of orderedDetails) {
    const partCode = normalizePartCode(detail.part.partCode);
    if (!partCode) continue;

    const effectiveDemandQty = Number(detail.qty || 0) * Number(quantity || 0);
    const bufferedDemand = applyBufferStockPercent(effectiveDemandQty, detail.part);
    const grossRequirement = bufferedDemand.grossRequirement;
    const availableBefore = await resolvePartProjectedAvailable(
      tx,
      partCode,
      requiredDate,
      projectedAvailableMap,
      runNumber,
      options,
    );
    const actualAvailableBefore = await resolvePartActualAvailable(
      tx,
      partCode,
      projectedActualAvailableMap,
    );
    const netRequirement = Math.max(grossRequirement - availableBefore, 0);
    projectedAvailableMap[partCode] = Math.max(availableBefore - grossRequirement, 0);
    projectedActualAvailableMap[partCode] = Math.max(actualAvailableBefore - grossRequirement, 0);

    const isSubAssembly = isSubAssemblyDetail(detail);
    const orderType = ["inHouse", "Vendor"].includes(detail.category)
      ? "Production"
      : "Purchase";
    const plannedOrderQty = orderType === "Production" && !isSubAssembly
      ? 0
      : netRequirement;
    if (isSubAssembly && projectedMoSupplyMap[partCode] === undefined) {
      const moSupplyMap = await buildOpenMoSupplyMap(tx, [partCode], requiredDate, {
        soNumber: options.soNumber,
      });
      projectedMoSupplyMap[partCode] = Number(moSupplyMap[partCode] || 0);
    }
    const moDrivenQty = isSubAssembly
      ? Math.min(Number(projectedMoSupplyMap[partCode] || 0), grossRequirement)
      : 0;
    const subAssemblyExplosionQty = plannedOrderQty + moDrivenQty;
    if (isSubAssembly) {
      projectedMoSupplyMap[partCode] = Math.max(
        Number(projectedMoSupplyMap[partCode] || 0) - moDrivenQty,
        0,
      );
    }
    const leadTime = durationToWorkingDays(detail.leadTime, detail.leadTimeUnit);
    const orderDate = new Date(requiredDate);
    orderDate.setDate(orderDate.getDate() - leadTime);

    const parentRequirementId =
      (detail.parentDetailId && requirementIdByMbomDetailId.get(detail.parentDetailId)) ||
      options.parentRequirementId ||
      null;
    const parentRequirement = parentRequirementId
      ? requirements.find((row) => row.id === parentRequirementId)
      : null;
    const parentTreePath = parentRequirement?.treePath || options.parentTreePath || null;
    // levelComponent is relative to this MBOM header. Add only the level of the
    // sub-assembly that owns this header, otherwise an internal parent/child
    // chain would count its parent level twice.
    const componentLevel =
      Number(options.parentComponentLevel || 0) +
      Math.max(Number(detail.levelComponent || 1), 1);
    const parentSequenceKey = parentRequirementId || "__ROOT__";
    const siblingSequence = Number(childSequenceByParentId.get(parentSequenceKey) || 0) + 1;
    childSequenceByParentId.set(parentSequenceKey, siblingSequence);
    const requirementIdentity = createRequirementIdentity(
      parentRequirementId,
      options.rootRequirementId || parentRequirementId,
    );

    const requirement = {
      ...requirementIdentity,
      runNumber,
      treePath: buildRequirementTreePath(parentTreePath, componentLevel, siblingSequence),
      levelMBOM: componentLevel,
      mbomLevelComponent: componentLevel,
      mbomDetailId: detail.id,
      partCode,
      partId: detail.part.id,
      requirementType: "Dependent",
      sourceType: "MBOM",
      sourceNumber: mbom.noReg,
      requiredDate,
      grossRequirement,
      forecastQty: 0,
      soConsumedQty: 0,
      effectiveDemandQty,
      consumptionSources: [],
      onHandQty: actualAvailableBefore,
      allocatedQty: 0,
      netRequirement,
      plannedOrderQty,
      orderType,
      leadTime,
      orderDate,
      notes: buildBufferStockNote(
        bufferedDemand.bufferPercent,
        bufferedDemand.bufferQty,
      ),
    };
    requirements.push(requirement);
    requirementIdByMbomDetailId.set(detail.id, requirement.id);

    if (isSubAssembly && subAssemblyExplosionQty > 0) {
      const subMbom = await findActiveMbomForPart(tx, detail.part.id, orderDate);
      if (subMbom && !visitedMbomIds.has(subMbom.id)) {
        visitedMbomIds.add(subMbom.id);
        requirements.push(
          ...(await explodeMbomForSoOnly(
            tx,
            runNumber,
            subMbom,
            subAssemblyExplosionQty,
            orderDate,
            level + 1,
            projectedAvailableMap,
            projectedActualAvailableMap,
            visitedMbomIds,
            {
              ...options,
              parentRequirementId: requirement.id,
              rootRequirementId: requirement.rootRequirementId,
              parentTreePath: requirement.treePath,
              parentComponentLevel: requirement.mbomLevelComponent,
              projectedMoSupplyMap,
            },
          )),
        );
      }
    }
  }

  return requirements;
}

async function runSoOnlyMrp(tx = prisma, soNumber, options = {}) {
  const { runBy = "system", partCodes = [] } = options;
  const scopedPartCodes = new Set((partCodes || []).map(normalizePartCode).filter(Boolean));
  if (!soNumber || scopedPartCodes.size === 0) return null;

  const soHeader = await tx.salesOrderHeader.findFirst({
    where: {
      soNumber,
      isDeleted: false,
      status: { in: OPEN_SO_HEADER_STATUSES },
    },
    include: {
      details: {
        where: {
          isDeleted: false,
          status: { in: OPEN_SO_DETAIL_STATUSES },
        },
        orderBy: { lineNumber: "asc" },
        include: { part: { select: { id: true, partCode: true, category: true, bufferStock: true } } },
      },
    },
  });

  if (!soHeader) return null;

  const targetDetails = soHeader.details.filter((detail) => {
    const partCode = normalizePartCode(detail.partCode);
    const remainingQty = Math.max(Number(detail.qty || 0) - Number(detail.qtyDelivered || 0), 0);
    return partCode && scopedPartCodes.has(partCode) && remainingQty > 0;
  });

  if (targetDetails.length === 0) return null;

  const planNumber = buildSoPlanNumber(soNumber);
  const runNumber = await generateRunNumber(tx);
  const cutoffDate = soHeader.deliveryDate || soHeader.soDate || new Date();
  const planHorizon = buildSoPlanHorizonDays(soHeader.soDate, cutoffDate);
  try {
    const previousPlanRuns = planNumber
      ? await tx.mRPRun.findMany({
          where: { planNumber, isDeleted: false },
          select: { runNumber: true },
        })
      : [];
    const previousPlanRunNumbers = previousPlanRuns.map((run) => run.runNumber).filter(Boolean);
    const partCodesForSupply = uniq(targetDetails.map((detail) => normalizePartCode(detail.partCode)));
    const stockRows = await tx.stockBalance.findMany({
      where: {
        AND: [
          { partCode: { in: partCodesForSupply }, isDeleted: false },
          buildExcludeSpecialRackCondition(),
        ],
      },
      select: { partCode: true, stockType: true, qtyAvailable: true },
    });
    const projectedAvailableMap = {};
    const actualAvailableMap = {};
    const normalizedStockRows = await normalizePlanningStockRows(tx, stockRows);
    for (const row of normalizedStockRows) {
      const partCode = normalizePartCode(row.partCode);
      actualAvailableMap[partCode] =
        Number(actualAvailableMap[partCode] || 0) + Number(row.qtyAvailable || 0);
      projectedAvailableMap[partCode] =
        Number(projectedAvailableMap[partCode] || 0) + Number(row.qtyAvailable || 0);
    }
    const openSupplyMap = await buildOpenSupplyMap(tx, partCodesForSupply, cutoffDate, {
      excludeRunNumbers: [runNumber, ...previousPlanRunNumbers],
      soNumber,
    });
    for (const [partCode, qty] of Object.entries(openSupplyMap)) {
      projectedAvailableMap[partCode] = Number(projectedAvailableMap[partCode] || 0) + Number(qty || 0);
    }
    const projectedMppSupplyMap = await buildOpenMppSupplyMap(tx, partCodesForSupply, cutoffDate, {
      soNumber,
    });
    const projectedPartialPlannedSupplyMap = await buildOpenPartialPlannedOrderSupplyMap(tx, partCodesForSupply, cutoffDate, {
      soNumber,
    });
    const projectedMoSupplyMap = await buildOpenMoSupplyMap(tx, partCodesForSupply, cutoffDate, {
      soNumber,
    });

    await tx.mRPRequirement.updateMany({
      where: { runNumber, isDeleted: false },
      data: { isDeleted: true, notes: `Superseded by SO-only MRP rebuild ${runNumber}` },
    });
    const currentPlannedOrdersToSupersede = await tx.plannedOrder.findMany({
      where: { runNumber, isDeleted: false, status: "Planned" },
      select: { orderNumber: true },
    });
    const currentSupersedeNotes = `Superseded by SO-only MRP rebuild ${runNumber}`;
    await tx.plannedOrder.updateMany({
      where: { runNumber, isDeleted: false, status: "Planned" },
      data: { isDeleted: true, notes: currentSupersedeNotes },
    });
    await closePeggingsForSupersededPlannedOrders(
      tx,
      currentPlannedOrdersToSupersede.map((order) => order.orderNumber),
      currentSupersedeNotes,
    );

    const existingRun = await tx.mRPRun.findUnique({
      where: { runNumber },
      select: { runNumber: true },
    });
    const planIdentity = await resolvePlanIdentity(tx, {
      planNumber,
      planScope: "SO",
    });
    await retirePreviousPlanRevisions(tx, planIdentity.planNumber, runNumber);
    if (previousPlanRunNumbers.length > 0) {
      await tx.mRPRequirement.updateMany({
        where: { runNumber: { in: previousPlanRunNumbers }, isDeleted: false },
        data: { isDeleted: true, notes: `Superseded by SO plan revision ${planIdentity.planRevision}` },
      });
      const previousPlannedOrdersToSupersede = await tx.plannedOrder.findMany({
        where: { runNumber: { in: previousPlanRunNumbers }, isDeleted: false, status: "Planned" },
        select: { orderNumber: true },
      });
      const previousSupersedeNotes = `Superseded by SO plan revision ${planIdentity.planRevision}`;
      await tx.plannedOrder.updateMany({
        where: { runNumber: { in: previousPlanRunNumbers }, isDeleted: false, status: "Planned" },
        data: { isDeleted: true, notes: previousSupersedeNotes },
      });
      await closePeggingsForSupersededPlannedOrders(
        tx,
        previousPlannedOrdersToSupersede.map((order) => order.orderNumber),
        previousSupersedeNotes,
      );
    }

    let runningRun;
    if (!existingRun) {
      runningRun = await tx.mRPRun.create({
        data: {
          runNumber,
          ...planIdentity,
          runDate: new Date(),
          planHorizon,
          cutoffDate,
          status: "Running",
          runBy,
          notes: `SO-only MRP run for ${soNumber}`,
        },
      });
    } else {
      runningRun = await tx.mRPRun.update({
        where: { runNumber },
        data: {
          ...planIdentity,
          runDate: new Date(),
          planHorizon,
          cutoffDate,
          status: "Running",
          errorMessage: null,
          runBy,
        },
      });
    }
    emitPlanningMrpRunUpdate(runningRun, "start", runBy);

    const requirements = [];
    for (const detail of targetDetails) {
      const partCode = normalizePartCode(detail.partCode);
      const requiredDate = detail.deliveryDate || soHeader.deliveryDate || soHeader.soDate || new Date();
      const effectiveDemandQty = Math.max(Number(detail.qty || 0) - Number(detail.qtyDelivered || 0), 0);
      const bufferedDemand = applyBufferStockPercent(effectiveDemandQty, detail.part);
      const grossRequirement = bufferedDemand.grossRequirement;
      const availableBefore = Number(projectedAvailableMap[partCode] || 0);
      const netRequirement = Math.max(grossRequirement - availableBefore, 0);
      const mppAvailableBefore = Number(projectedMppSupplyMap[partCode] || 0);
      const partialPlannedAvailableBefore = Number(projectedPartialPlannedSupplyMap[partCode] || 0);
      const moAvailableBefore = Number(projectedMoSupplyMap[partCode] || 0);
      const nonProductionDriverAvailableBefore = Math.max(
        availableBefore - mppAvailableBefore - partialPlannedAvailableBefore - moAvailableBefore,
        0,
      );
      const mppDrivenQty = Math.min(
        mppAvailableBefore,
        Math.max(grossRequirement - nonProductionDriverAvailableBefore, 0),
      );
      const partialPlannedDrivenQty = Math.min(
        partialPlannedAvailableBefore,
        Math.max(grossRequirement - nonProductionDriverAvailableBefore - mppDrivenQty, 0),
      );
      const moDrivenQty = Math.min(
        moAvailableBefore,
        Math.max(grossRequirement - nonProductionDriverAvailableBefore - mppDrivenQty - partialPlannedDrivenQty, 0),
      );
      const productionExplosionQty = netRequirement + mppDrivenQty + partialPlannedDrivenQty + moDrivenQty;
      projectedAvailableMap[partCode] = Math.max(availableBefore - grossRequirement, 0);
      projectedMppSupplyMap[partCode] = Math.max(mppAvailableBefore - mppDrivenQty, 0);
      projectedPartialPlannedSupplyMap[partCode] = Math.max(partialPlannedAvailableBefore - partialPlannedDrivenQty, 0);
      projectedMoSupplyMap[partCode] = Math.max(moAvailableBefore - moDrivenQty, 0);

      const mbom = await findActiveMbomForPart(tx, detail.part?.id, requiredDate);
      const orderType = mbom ? "Production" : "Purchase";
      const leadTime = mbom ? await resolveMbomLeadTimeDays(tx, mbom.noReg) : 0;
      const orderDate = new Date(requiredDate);
      orderDate.setDate(orderDate.getDate() - leadTime);
      const requirementIdentity = createRequirementIdentity();
      const requirement = {
        ...requirementIdentity,
        runNumber,
        treePath: buildRequirementTreePath(null, 0, requirements.length + 1),
        levelMBOM: 0,
        mbomLevelComponent: 0,
        partCode,
        partId: detail.part?.id || null,
        uomCode: detail.uomCode || detail.part?.uomCode || "pcs",
        requirementType: "Independent",
        sourceType: "SO",
        sourceNumber: `${soNumber}#${detail.lineNumber}`,
        requiredDate,
        grossRequirement,
        forecastQty: 0,
        soConsumedQty: effectiveDemandQty,
        effectiveDemandQty,
        consumptionSources: [`${soNumber}#${detail.lineNumber}:${effectiveDemandQty}`],
        onHandQty: Number(actualAvailableMap[partCode] || 0),
        allocatedQty: 0,
        netRequirement,
        plannedOrderQty: netRequirement,
        orderType,
        leadTime,
        orderDate,
        notes: buildBufferStockNote(
          bufferedDemand.bufferPercent,
          bufferedDemand.bufferQty,
        ),
      };
      requirements.push(requirement);

      if (productionExplosionQty > 0 && mbom) {
        requirements.push(
          ...(await explodeMbomForSoOnly(
            tx,
            runNumber,
            mbom,
            productionExplosionQty,
            requiredDate,
            1,
            projectedAvailableMap,
            actualAvailableMap,
            new Set([mbom.id]),
            {
              soNumber,
              parentRequirementId: requirement.id,
              rootRequirementId: requirement.rootRequirementId,
              parentTreePath: requirement.treePath,
              parentComponentLevel: 0,
              projectedMoSupplyMap,
            },
          )),
        );
      }
    }

    const nextPlannedOrderNumber = await createPlannedOrderSequencer(tx);
    const plannedOrders = [];
    for (const requirement of requirements) {
      if (Number(requirement.plannedOrderQty || 0) <= 0) continue;
      const orderType = requirement.orderType || "Purchase";

      const activeMbom =
        orderType === "Production"
          ? await findActiveMbomForPart(tx, requirement.partId, requirement.requiredDate)
          : null;

      const sourceParts = String(requirement.sourceNumber || "").split("#");
      const demandLineNumber = sourceParts[1] ? Number(sourceParts[1]) : null;
      const plannedOrderUomCode = orderType === "Purchase"
        ? (requirement.uomCode || "pcs")
        : activeMbom?.uomCode || requirement.uomCode || null;
      const plannedOrderQty = normalizeQuantity(requirement.plannedOrderQty, plannedOrderUomCode);

      plannedOrders.push({
        orderNumber: nextPlannedOrderNumber(orderType),
        runNumber,
        orderType,
        partCode: requirement.partCode,
        partId: requirement.partId || null,
        qty: plannedOrderQty,
        uomCode: plannedOrderUomCode,
        requiredDate: requirement.requiredDate,
        orderDate: requirement.orderDate || requirement.requiredDate,
        mbomHeaderId: orderType === "Production" ? activeMbom?.id || null : null,
        referenceType: "MRP",
        referenceNumber: planIdentity.planNumber || runNumber,
        status: "Planned",
        notes:
          requirement.sourceType === "SO"
            ? `SO-only planned order dari ${requirement.sourceNumber}`
            : `SO-only planned order hasil explosion ${runNumber}`,
        mrpPeggings:
          requirement.sourceType === "SO" && requirement.partId
            ? [{
                demandType: "SO",
                demandNumber: sourceParts[0],
                demandLineNumber: Number.isFinite(demandLineNumber) ? demandLineNumber : null,
                supplyType: "PlannedOrder",
                supplyNumber: null,
                supplyLineNumber: null,
                itemId: requirement.partId,
                qtyPegged: plannedOrderQty,
                notes: `MRP ${planIdentity.planNumber || runNumber} pegging ${requirement.sourceNumber}`,
              }]
            : [],
      });
    }

    if (requirements.length > 0) {
      await tx.mRPRequirement.createMany({ data: requirements.map((requirement) => {
        const uomCode = requirement.uomCode || "pcs";
        const { uomCode: _uomCode, ...persistedRequirement } = requirement;
        return {
          ...persistedRequirement,
          grossRequirement: normalizeQuantity(persistedRequirement.grossRequirement, uomCode),
          soConsumedQty: normalizeQuantity(persistedRequirement.soConsumedQty, uomCode),
          effectiveDemandQty: normalizeQuantity(persistedRequirement.effectiveDemandQty, uomCode),
          onHandQty: normalizeQuantity(persistedRequirement.onHandQty, uomCode),
          allocatedQty: normalizeQuantity(persistedRequirement.allocatedQty, uomCode),
          netRequirement: normalizeQuantity(persistedRequirement.netRequirement, uomCode),
          plannedOrderQty: normalizeQuantity(persistedRequirement.plannedOrderQty, uomCode),
        };
      }) });
    }
    let createdPlannedOrders = [];
    if (plannedOrders.length > 0) {
      await tx.plannedOrder.createMany({
        data: plannedOrders.map(({ mrpPeggings, ...plannedOrder }) => plannedOrder),
      });
      for (const plannedOrder of plannedOrders) {
        for (const pegging of plannedOrder.mrpPeggings || []) {
          if (!pegging.demandNumber || !pegging.itemId || Number(pegging.qtyPegged || 0) <= 0) continue;
          await upsertMrpPegging(tx, {
            ...pegging,
            supplyNumber: plannedOrder.orderNumber,
          });
        }
      }
      createdPlannedOrders = await tx.plannedOrder.findMany({
        where: {
          orderNumber: { in: plannedOrders.map((order) => order.orderNumber) },
        },
      });
    }

    const soOnlySummary = {
      soNumber,
      partCodes: partCodesForSupply,
      totalConsumedQty: requirements
        .filter((row) => row.levelMBOM === 0 && row.sourceType === "SO")
        .reduce((sum, row) => sum + Number(row.soConsumedQty || 0), 0),
      impactedMpsLines: 0,
      byPart: requirements
        .filter((row) => row.levelMBOM === 0 && row.sourceType === "SO")
        .map((row) => ({
          partCode: row.partCode,
          consumedQty: Number(row.soConsumedQty || 0),
          sources: row.consumptionSources || [],
        })),
    };

    const completedRun = await tx.mRPRun.update({
      where: { runNumber },
      data: {
        status: "Completed",
        totalRequirements: requirements.length,
        totalPlannedOrders: plannedOrders.length,
        soDemandConsumedQty: soOnlySummary.totalConsumedQty,
        soDemandImpactedLines: soOnlySummary.impactedMpsLines,
        nettingSummary: soOnlySummary,
        executionTime: 0,
        notes: null,
      },
    });

    emitPlanningPlannedOrderBulkUpdate(createdPlannedOrders, "create", runBy);
    emitPlanningMrpRunUpdate(completedRun, "complete", runBy);

    await syncOperationalSalesOrderStatus(tx, soNumber);

    return {
      runNumber,
      soNumber,
      statusCode: 201,
      ok: true,
      payload: completedRun,
      totalRequirements: requirements.length,
      totalPlannedOrders: plannedOrders.length,
    };
  } catch (error) {
    await tx.mRPRun.updateMany({
      where: { runNumber },
      data: {
        status: "Failed",
        errorMessage: error.message,
        notes: null,
      },
    });
    emitPlanningMrpRunUpdate({
      runNumber,
      status: "Failed",
      errorMessage: error.message,
      updatedAt: new Date(),
    }, "fail", runBy);
    throw error;
  }
}

async function buildOpenSoOnlyTargets(tx = prisma) {
  const rows = await tx.salesOrderDetail.findMany({
    where: {
      isDeleted: false,
      status: { in: OPEN_SO_DETAIL_STATUSES },
      soHeader: {
        isDeleted: false,
        status: { in: OPEN_SO_HEADER_STATUSES },
      },
    },
    select: {
      soNumber: true,
      partCode: true,
      qty: true,
      qtyDelivered: true,
    },
    orderBy: [{ soNumber: "asc" }, { lineNumber: "asc" }],
  });

  const targets = new Map();
  for (const row of rows) {
    const partCode = normalizePartCode(row.partCode);
    const remainingQty = Math.max(Number(row.qty || 0) - Number(row.qtyDelivered || 0), 0);
    if (!row.soNumber || !partCode || remainingQty <= 0) continue;
    if (!targets.has(row.soNumber)) targets.set(row.soNumber, new Set());
    targets.get(row.soNumber).add(partCode);
  }

  return targets;
}

async function invokeExistingMrpRun(mpsNumber, runDate = new Date(), runBy = "system", options = {}) {
  const controller = require("../../controllers/planning/MRPController");
  const runNumber = await generateRunNumber(prisma, runDate);
  const soDemandPartCodes = Array.isArray(options.soDemandPartCodes)
    ? uniq(options.soDemandPartCodes.map(normalizePartCode))
    : undefined;

  const req = {
    body: {
      runNumber,
      mpsNumber,
      ...(soDemandPartCodes?.length > 0 ? { soDemandPartCodes } : {}),
    },
    user: { username: runBy },
  };

  let statusCode = 200;
  let payload = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      payload = data;
      return data;
    },
  };

  await controller.runMRP(req, res, (error) => {
    if (error) {
      throw error;
    }
  });

  return {
    runNumber,
    mpsNumber,
    statusCode,
    payload,
    ok: statusCode < 400,
  };
}

async function runFullNightlyMrp(tx = prisma, options = {}) {
  const { runBy = "system", runDate = new Date() } = options;
  const soOnlyTargets = await buildOpenSoOnlyTargets(tx);

  const mpsList = await tx.mPS.findMany({
    where: {
      isDeleted: false,
      status: { in: ["Confirmed", "Released"] },
    },
    select: { mpsNumber: true },
    orderBy: { periodStart: "asc" },
  });

  const results = [];
  for (const [soNumber, partCodeSet] of soOnlyTargets.entries()) {
    try {
      const result = await runSoOnlyMrp(tx, soNumber, {
        runBy,
        partCodes: [...partCodeSet],
      });
      if (result) results.push(result);
    } catch (error) {
      results.push({
        soNumber,
        ok: false,
        error: error.message,
      });
    }
  }

  for (const mps of mpsList) {
    try {
      const result = await invokeExistingMrpRun(mps.mpsNumber, runDate, runBy);
      results.push(result);
    } catch (error) {
      results.push({
        mpsNumber: mps.mpsNumber,
        ok: false,
        error: error.message,
      });
    }
  }

  const successCount = results.filter((r) => r.ok).length;
  const failedCount = results.filter((r) => !r.ok).length;

  let cleanup = null;
  try {
    cleanup = await cleanupSupersededMrpArtifacts(tx, options.retention || {});
  } catch (error) {
    cleanup = { error: error.message };
  }

  await persistPartialSnapshot(tx, {
    snapshotDate: runDate,
    cutoffDate: runDate,
    runScope: "Full",
    status: failedCount > 0 ? "Failed" : "Completed",
    dirtyCount: 0,
    impactedCount: 0,
    mpsCount: mpsList.length,
    snapshotJson: {
      scope: "full",
      runDate,
      soOnlyRuns: [...soOnlyTargets.entries()].map(([soNumber, partCodes]) => ({
        soNumber,
        partCodes: [...partCodes],
      })),
      mpsNumbers: mpsList.map((m) => m.mpsNumber),
      successCount,
      failedCount,
      cleanup,
    },
    resultsJson: results,
    notes: `Full nightly MRP by ${runBy}`,
    createdBy: runBy,
  });

  return {
    scope: "full",
    totalMps: mpsList.length,
    soOnlyCount: soOnlyTargets.size,
    successCount,
    failedCount,
    cleanup,
    results,
  };
}

async function runPartialNetChangeMrp(tx = prisma, options = {}) {
  const { runBy = "system", limit = 200 } = options;
  const sourceNumbers = uniq(options.sourceNumbers || []);

  const dirtyItems = await tx.mRPDirtyItem.findMany({
    where: {
      status: "Pending",
      ...(sourceNumbers.length > 0 ? { sourceNumber: { in: sourceNumbers } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  if (dirtyItems.length === 0) {
    return {
      scope: "partial",
      dirtyCount: 0,
      impactedCount: 0,
      mpsCount: 0,
      results: [],
    };
  }

  await tx.mRPDirtyItem.updateMany({
    where: { id: { in: dirtyItems.map((item) => item.id) } },
    data: { status: "Processing" },
  });

  const dirtyItemIds = dirtyItems.map((item) => item.itemId);
  const impactedTree = await buildBomImpactTree(tx, dirtyItemIds);
  const impactedItemIds = impactedTree.map((node) => node.itemId);
  const snapshot = await buildSupplyDemandSnapshot(tx, impactedTree, new Date());
  const mpsNumbers = await findImpactedMpsNumbers(tx, impactedItemIds);
  const partMap = await loadPartMap(tx, dirtyItemIds);
  const soOnlyPartCodesByNumber = new Map();

  for (const dirtyItem of dirtyItems) {
    if (String(dirtyItem.reason || "").toLowerCase() !== "sales-order-demand" || !dirtyItem.sourceNumber) continue;
    const partCode = normalizePartCode(partMap.get(dirtyItem.itemId)?.partCode);
    if (!partCode) continue;
    if (!soOnlyPartCodesByNumber.has(dirtyItem.sourceNumber)) {
      soOnlyPartCodesByNumber.set(dirtyItem.sourceNumber, new Set());
    }
    soOnlyPartCodesByNumber.get(dirtyItem.sourceNumber).add(partCode);
  }

  const results = [];
  for (const [soNumber, partCodeSet] of soOnlyPartCodesByNumber.entries()) {
    try {
      const result = await runSoOnlyMrp(tx, soNumber, {
        runBy,
        partCodes: [...partCodeSet],
      });
      if (result) results.push(result);
    } catch (error) {
      results.push({
        soNumber,
        ok: false,
        error: error.message,
      });
    }
  }

  for (const mpsNumber of mpsNumbers) {
    try {
      const mpsPartCodes = await findMpsDetailPartCodes(tx, mpsNumber);
      const result = await invokeExistingMrpRun(mpsNumber, new Date(), runBy, {
        soDemandPartCodes: mpsPartCodes,
      });
      results.push(result);
    } catch (error) {
      results.push({
        mpsNumber,
        ok: false,
        error: error.message,
      });
    }
  }

  const failedCount = results.filter((result) => result && result.ok === false).length;
  const partialSnapshot = await persistPartialSnapshot(tx, {
    snapshotDate: new Date(),
    cutoffDate: new Date(),
    status: failedCount > 0 ? "Failed" : "Completed",
    dirtyCount: dirtyItems.length,
    impactedCount: impactedItemIds.length,
    mpsCount: mpsNumbers.length,
    snapshotJson: {
      scope: "partial",
      dirtyItems,
      impactedTree,
      impactedItemIds,
      snapshot,
      mpsNumbers,
      soOnlyRuns: [...soOnlyPartCodesByNumber.entries()].map(([soNumber, partCodes]) => ({
        soNumber,
        partCodes: [...partCodes],
      })),
    },
    resultsJson: results,
    notes: `Partial MRP rebuild by ${runBy}`,
    createdBy: runBy,
  });

  await tx.mRPDirtyItem.updateMany({
    where: { id: { in: dirtyItems.map((item) => item.id) } },
    data: {
      status: "Done",
      processedAt: new Date(),
    },
  });

  return {
    scope: "partial",
    dirtyCount: dirtyItems.length,
    impactedCount: impactedItemIds.length,
    mpsCount: mpsNumbers.length,
    soOnlyCount: soOnlyPartCodesByNumber.size,
    snapshot,
    partialSnapshot,
    results,
  };
}

async function listDirtyItems(tx = prisma, options = {}) {
  const page = Math.max(1, Number(options.page || 1));
  const limit = Math.min(100, Math.max(1, Number(options.limit || 20)));
  const where = options.where || {};
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    tx.mRPDirtyItem.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    tx.mRPDirtyItem.count({ where }),
  ]);

  return {
    items,
    total,
    page,
    limit,
  };
}

async function getLatestPartialSnapshot(tx = prisma) {
  return tx.mRPPartialSnapshot.findFirst({
    select: {
      id: true,
      snapshotNumber: true,
      snapshotDate: true,
      runScope: true,
      cutoffDate: true,
      dirtyCount: true,
      impactedCount: true,
      mpsCount: true,
      status: true,
      notes: true,
      createdBy: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: [{ snapshotDate: "desc" }, { createdAt: "desc" }],
  });
}

async function getPartialSnapshotByNumber(tx = prisma, snapshotNumber) {
  return tx.mRPPartialSnapshot.findUnique({
    where: { snapshotNumber },
  });
}

async function listPartialSnapshots(tx = prisma, options = {}) {
  const page = Math.max(1, Number(options.page || 1));
  const limit = Math.min(100, Math.max(1, Number(options.limit || 20)));
  const where = options.where || {};
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    tx.mRPPartialSnapshot.findMany({
      where,
      select: {
        id: true,
        snapshotNumber: true,
        snapshotDate: true,
        runScope: true,
        cutoffDate: true,
        dirtyCount: true,
        impactedCount: true,
        mpsCount: true,
        status: true,
        notes: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ snapshotDate: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
    }),
    tx.mRPPartialSnapshot.count({ where }),
  ]);

  return {
    items,
    total,
    page,
    limit,
  };
}

module.exports = {
  generateRunNumber,
  queueDirtyItem,
  expandImpactedItemIds,
  buildBomImpactTree,
  buildSupplyDemandSnapshot,
  rebuildPartialSnapshot,
  persistPartialSnapshot,
  cleanupSupersededMrpArtifacts,
  findImpactedMpsNumbers,
  invokeExistingMrpRun,
  runFullNightlyMrp,
  runPartialNetChangeMrp,
  listDirtyItems,
  getLatestPartialSnapshot,
  getPartialSnapshotByNumber,
  listPartialSnapshots,
};

