const { prisma } = require("../../index");
const { Prisma } = require("@prisma/client");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { releaseReservationsForMO } = require("./services/moReservationService");
const { isSubAssemblyDetail } = require("../../utils/assemblyPolicy");
const {
  buildAvailability,
  completeManufacturingOrder,
  coverDependentInHousePlannedOrdersForWorkOrders,
  generateWorkOrdersFromRouting,
  getRoutingOperations,
  releaseManufacturingOrder,
  startManufacturingOrder,
  syncManufacturingOrderQtyFromWorkOrders,
} = require("./services/productionWorkflowService");
const {
  syncOperationalSalesOrderStatus,
} = require("../../services/production/sales-order/soStatusService");
const {
  emitManufacturingOrderUpdate,
  emitManufacturingOrderBulkUpdate,
  emitWorkOrderBulkUpdate,
} = require("./services/productionRealtimeService");
const {
  emitPlanningPlannedOrderBulkUpdate,
} = require("../planning/services/planningRealtimeService");
const {
  generateVendorProcessOrdersFromRouting,
  getVendorRoutingOperations,
} = require("./VendorProcessOrderController");
const { assertQuantity } = require("../../utils/uomQuantity");

// Pesan error standar
const PO_NUMBER_CONFLICT = "Nomor Manufacturing Order sudah digunakan.";
const PO_ALREADY_DELETED = "Data Manufacturing Order sudah dihapus.";
const MO_REFERENCE_TYPES = new Set(["Internal", "MRPPlannedOrder", "MonthlyProductionPlan"]);
const MO_DELETABLE_STATUSES = ["Draft", "Planned", "Released", "Cancelled"];
const MO_CHILD_DELETABLE_WORK_ORDER_STATUSES = ["Draft", "Planned", "Released", "Cancelled"];
const MO_CHILD_DELETABLE_MATERIAL_ISSUE_STATUSES = ["Draft", "Cancelled"];
const MO_CHILD_DELETABLE_VENDOR_ORDER_STATUSES = ["Planned", "Ready to Send", "Cancelled"];
const MO_INPUT_SOURCE_TYPES = new Set(["MBOM", "WIP_STOCK"]);

const sourceStockBalanceSelect = {
  id: true,
  warehouseCode: true,
  rackCode: true,
  lotNumber: true,
  partCode: true,
  partNumber: true,
  partName: true,
  stockType: true,
  qtyAvailable: true,
  qtyOnHand: true,
  qtyQC: true,
  uomCode: true,
};

const sourceWipAllocationSelect = {
  id: true,
  lineNumber: true,
  stockBalanceId: true,
  qty: true,
  warehouseCode: true,
  rackCode: true,
  lotNumber: true,
  partCode: true,
  partNumber: true,
  partName: true,
  stockType: true,
};

function normalizeMoReferenceInput(data = {}) {
  const {
    soNumber: _soNumber,
    // Display-only fields are accepted by the UI payload but are represented
    // by the normalized partId relation in the MO schema. Never pass these
    // denormalized labels into Prisma create/update data.
    partCode: _partCode,
    partNumber: _partNumber,
    partName: _partName,
    monthlyProductionPlanNumber: _monthlyProductionPlanNumber,
    monthlyProductionPlanLineNumber: _monthlyProductionPlanLineNumber,
    ...rest
  } = data;
  const referenceType = data.referenceType || (data.plannedOrderNumber ? "MRPPlannedOrder" : "Internal");

  if (!MO_REFERENCE_TYPES.has(referenceType)) {
    throw Object.assign(
      new Error("MO hanya boleh dibuat dari Planned Order, Monthly Production Plan, atau Internal."),
      { status: 400 },
    );
  }

  if (referenceType === "MRPPlannedOrder" && !data.plannedOrderNumber) {
    throw Object.assign(
      new Error("Planned Order wajib dipilih untuk reference type MRPPlannedOrder."),
      { status: 400 },
    );
  }

  return {
    ...rest,
    referenceType,
    plannedOrderNumber:
      ["MRPPlannedOrder", "MonthlyProductionPlan"].includes(referenceType)
        ? data.plannedOrderNumber || null
        : null,
  };
}

function roundQty(value) {
  const qty = Number(value || 0);
  if (!Number.isFinite(qty)) return 0;
  return Number(qty.toFixed(6));
}

function normalizeUomCode(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isKgUom(value) {
  return normalizeUomCode(value) === "kg";
}

function normalizePartBaseOn(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function resolveKgPerPcs(part) {
  const bases = Array.isArray(part?.partBases) ? part.partBases : [];
  const base =
    bases.find((item) => normalizePartBaseOn(item.baseOn) === "ACTUAL") ||
    bases.find((item) => normalizePartBaseOn(item.baseOn) === "QTN") ||
    bases[0] ||
    null;
  const grossWeight = Number(base?.grossWeight || 0);
  return grossWeight > 0 ? grossWeight : null;
}

function isRootProductionRequirement(requirement) {
  if (!requirement) return false;
  return (
    Number(requirement.levelMBOM || 0) === 0 &&
    requirement.requirementType !== "Dependent" &&
    requirement.sourceType !== "MBOM"
  );
}

function isSubAssemblyRequirement(requirement) {
  if (!requirement) return false;
  return isSubAssemblyDetail({
    ...requirement.mbomDetail,
    part: requirement.mbomDetail?.part || requirement.part,
  });
}

function isMrpPlannedOrder(order) {
  return order?.referenceType === "MRP" || Boolean(order?.runNumber);
}

async function findRequirementForPlannedOrder(tx, plannedOrder) {
  if (!plannedOrder?.runNumber) return null;
  const select = {
    id: true,
    levelMBOM: true,
    requirementType: true,
    sourceType: true,
    part: { select: { id: true, partCode: true, partNumber: true, partName: true, itemType: true, assemblyPolicy: true } },
    mbomDetail: {
      select: {
        id: true,
        category: true,
        assemblyPolicyOverride: true,
        parentDetailId: true,
        part: { select: { id: true, partCode: true, partNumber: true, partName: true, itemType: true, assemblyPolicy: true } },
      },
    },
  };

  const exact = await tx.mRPRequirement.findFirst({
    where: {
      runNumber: plannedOrder.runNumber,
      partCode: plannedOrder.partCode,
      requiredDate: plannedOrder.requiredDate,
      orderDate: plannedOrder.orderDate,
      isDeleted: false,
    },
    orderBy: [{ levelMBOM: "asc" }, { createdAt: "asc" }],
    select,
  });
  if (exact) return exact;

  // A surviving planned order can still point to a requirement soft-deleted by a later MRP run.
  // Read that exact historical snapshot so its effective assembly policy is preserved.
  const historicalExact = await tx.mRPRequirement.findFirst({
    where: {
      runNumber: plannedOrder.runNumber,
      partCode: plannedOrder.partCode,
      requiredDate: plannedOrder.requiredDate,
      orderDate: plannedOrder.orderDate,
    },
    orderBy: [{ createdAt: "asc" }],
    select,
  });
  if (historicalExact) return historicalExact;

  const rootFallback = await tx.mRPRequirement.findFirst({
    where: {
      runNumber: plannedOrder.runNumber,
      partCode: plannedOrder.partCode,
      levelMBOM: 0,
      requirementType: { not: "Dependent" },
      sourceType: { not: "MBOM" },
      isDeleted: false,
    },
    orderBy: [{ createdAt: "asc" }],
    select,
  });
  if (rootFallback) return rootFallback;

  const historicalRootFallback = await tx.mRPRequirement.findFirst({
    where: {
      runNumber: plannedOrder.runNumber,
      partCode: plannedOrder.partCode,
      levelMBOM: 0,
      requirementType: { not: "Dependent" },
      sourceType: { not: "MBOM" },
    },
    orderBy: [{ createdAt: "asc" }],
    select,
  });
  if (historicalRootFallback) return historicalRootFallback;

  return tx.mRPRequirement.findFirst({
    where: {
      runNumber: plannedOrder.runNumber,
      partCode: plannedOrder.partCode,
      isDeleted: false,
    },
    orderBy: [{ levelMBOM: "asc" }, { createdAt: "asc" }],
    select,
  });
}

async function assertPlannedOrderCanConvertToMo(tx, plannedOrder) {
  if (!plannedOrder || plannedOrder.orderType !== "Production") return;
  if (!isMrpPlannedOrder(plannedOrder)) return;

  const requirement = await findRequirementForPlannedOrder(tx, plannedOrder);
  if (!isRootProductionRequirement(requirement) && !isSubAssemblyRequirement(requirement)) {
    throw Object.assign(
      new Error(
        "Planned order hasil explosion MBOM tidak bisa di-release langsung ke MO kecuali item SUB_ASSEMBLY. Release root FG untuk child inHouse inline yang dibuat sebagai Work Order.",
      ),
      { status: 400 },
    );
  }
}

// Generate nomor MO otomatis: MO-YYYYMMDD-001
async function generateMoNumber(client = prisma) {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const datePrefix = `MO-${y}${m}${d}`;

  const last = await client.manufacturingOrder.findFirst({
    where: { moNumber: { startsWith: datePrefix } },
    orderBy: { moNumber: "desc" },
    select: { moNumber: true },
  });

  let seq = 1;
  if (last) {
    const parts = last.moNumber.split("-");
    seq = parseInt(parts[parts.length - 1], 10) + 1;
  }

  return `${datePrefix}-${String(seq).padStart(3, "0")}`;
}

async function lookupPartId(tx, partCode) {
  if (!partCode) return null;
  const part = await tx.part.findFirst({
    where: { partCode, isDeleted: false },
    select: { id: true },
  });
  return part?.id || null;
}

function extractSourceWipAllocations(data = {}) {
  return Array.isArray(data.sourceWipAllocations) ? data.sourceWipAllocations : [];
}

function stripSourceWipAllocationFields(data = {}) {
  const {
    sourceWipAllocations: _sourceWipAllocations,
    sourceWipAllocationsNormalized: _sourceWipAllocationsNormalized,
    currentMoNumber: _currentMoNumber,
    ...rest
  } = data;
  return rest;
}

function parseMoTraceMetadata(source = {}) {
  const sourceMoNumber = source?.parentMoNumber || null;
  const sourceRootMoNumber = source?.rootMoNumber || sourceMoNumber || null;
  const sourceReferenceType = source?.sourceReferenceType || null;
  const sourcePlannedOrderNumber = source?.sourcePlannedOrderNumber || null;
  const sourceMonthlyProductionPlanNumber = source?.sourceMonthlyProductionPlanNumber || null;
  const sourceMonthlyProductionPlanLineNumber = Number(source?.sourceMonthlyProductionPlanLineNumber);

  return {
    sourceMoNumber,
    sourceRootMoNumber,
    sourceReferenceType,
    sourcePlannedOrderNumber,
    sourceMonthlyProductionPlanNumber,
    sourceMonthlyProductionPlanLineNumber:
      Number.isFinite(sourceMonthlyProductionPlanLineNumber)
        ? sourceMonthlyProductionPlanLineNumber
        : null,
  };
}

function readWipDerivedStartSequence(source) {
  const sequence = Number(source?.sourceStartSequence);
  return Number.isFinite(sequence) && sequence > 0 ? sequence : null;
}

function normalizeSourceWipAllocationRecords(allocations = []) {
  return (Array.isArray(allocations) ? allocations : []).map((allocation, index) => ({
    lineNumber: index + 1,
    stockBalanceId: allocation.stockBalanceId || null,
    qty: roundQty(allocation.qty),
    warehouseCode: allocation.warehouseCode || null,
    rackCode: allocation.rackCode || null,
    lotNumber: allocation.lotNumber || null,
    partCode: allocation.partCode || null,
    partNumber: allocation.partNumber || null,
    partName: allocation.partName || null,
    stockType: allocation.stockType || "WIP",
  }));
}

async function syncManufacturingOrderSourceWipAllocations(tx, manufacturingOrder, allocations = []) {
  if (!manufacturingOrder?.id) return;

  await tx.manufacturingOrderSourceWip.updateMany({
    where: {
      manufacturingOrderId: manufacturingOrder.id,
      isDeleted: false,
    },
    data: {
      isDeleted: true,
    },
  });

  const normalizedAllocations = normalizeSourceWipAllocationRecords(allocations).filter(
    allocation => Number(allocation.qty || 0) > 0,
  );
  if (normalizedAllocations.length === 0) return;

  await tx.manufacturingOrderSourceWip.createMany({
    data: normalizedAllocations.map(allocation => ({
      manufacturingOrderId: manufacturingOrder.id,
      moNumber: manufacturingOrder.moNumber,
      ...allocation,
    })),
  });
}

function normalizeSequence(value) {
  const sequence = Number(value);
  return Number.isFinite(sequence) && sequence > 0 ? sequence : null;
}

function findStartSequenceFromCombinedRouting(sourcePartCode, inHouseOperations = [], vendorOperations = []) {
  const normalizedPartCode = String(sourcePartCode || "").trim().toLowerCase();
  if (!normalizedPartCode) return null;

  const vendorMatch = vendorOperations.find((operation) =>
    String(operation?.outputPart?.partCode || operation?.inputPart?.partCode || "").trim().toLowerCase() === normalizedPartCode,
  );
  if (normalizeSequence(vendorMatch?.sequence)) {
    return normalizeSequence(vendorMatch.sequence);
  }

  const inHouseMatch = inHouseOperations.find((operation) =>
    String(operation?.componentPartCode || "").trim().toLowerCase() === normalizedPartCode,
  );
  return normalizeSequence(inHouseMatch?.sequence);
}

async function getOwnWipReservationAllowanceMap(tx, moNumber, stockBalanceIds = []) {
  const normalizedIds = [...new Set(stockBalanceIds.filter(Boolean))];
  if (!moNumber || normalizedIds.length === 0) {
    return new Map();
  }

  const reservations = await tx.stockReservation.findMany({
    where: {
      referenceType: "MANUFACTURING_ORDER",
      referenceNumber: moNumber,
      stockBalanceId: { in: normalizedIds },
      isDeleted: false,
    },
    select: {
      stockBalanceId: true,
      qtyReserved: true,
      qtyReleased: true,
    },
  });

  const allowanceMap = new Map();
  for (const reservation of reservations) {
    const stockBalanceId = reservation.stockBalanceId || null;
    if (!stockBalanceId) continue;

    const remainingReserved = roundQty(
      Number(reservation.qtyReserved || 0) - Number(reservation.qtyReleased || 0),
    );
    if (remainingReserved <= 0) continue;

    const current = allowanceMap.get(stockBalanceId) || 0;
    allowanceMap.set(stockBalanceId, roundQty(current + remainingReserved));
  }

  return allowanceMap;
}

async function enrichManufacturingOrderCoverage(tx, items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const traceMetadataMap = new Map(
    items.map(item => [item.moNumber, parseMoTraceMetadata(item)]),
  );
  const rootTokens = [...new Set(
    items
      .map((item) => {
        const trace = traceMetadataMap.get(item?.moNumber) || {};
        return trace.sourceRootMoNumber || item?.moNumber || null;
      })
      .filter(Boolean),
  )];

  const relatedCandidates = rootTokens.length > 0
    ? await tx.manufacturingOrder.findMany({
        where: {
          isDeleted: false,
          OR: rootTokens.flatMap(rootMoNumber => ([
            { rootMoNumber },
            { parentMoNumber: rootMoNumber },
            { moNumber: rootMoNumber },
          ])),
        },
        select: {
          moNumber: true,
          status: true,
          qtyPlanned: true,
          qtyGood: true,
          parentMoNumber: true,
          rootMoNumber: true,
          sourceReferenceType: true,
          sourcePlannedOrderNumber: true,
          sourceMonthlyProductionPlanNumber: true,
          sourceMonthlyProductionPlanLineNumber: true,
        },
      })
    : [];

  const allRowsByMoNumber = new Map();
  for (const item of items) {
    if (item?.moNumber) allRowsByMoNumber.set(item.moNumber, item);
  }
  for (const item of relatedCandidates) {
    if (!item?.moNumber || allRowsByMoNumber.has(item.moNumber)) continue;
    allRowsByMoNumber.set(item.moNumber, item);
  }

  const allRows = [...allRowsByMoNumber.values()];
  const metadataByMoNumber = new Map(
    allRows.map(item => [item.moNumber, parseMoTraceMetadata(item)]),
  );
  const childMap = new Map();

  for (const item of allRows) {
    const parentMoNumber = metadataByMoNumber.get(item.moNumber)?.sourceMoNumber || null;
    if (!parentMoNumber) continue;

    const current = childMap.get(parentMoNumber) || [];
    current.push(item);
    childMap.set(parentMoNumber, current);
  }

  const fulfillmentMap = new Map();
  function visit(moNumber, visited = new Set()) {
    if (!moNumber) {
      return { ownGood: 0, childGood: 0, totalGood: 0 };
    }
    if (fulfillmentMap.has(moNumber)) {
      return fulfillmentMap.get(moNumber);
    }
    if (visited.has(moNumber)) {
      return { ownGood: 0, childGood: 0, totalGood: 0 };
    }

    const nextVisited = new Set(visited);
    nextVisited.add(moNumber);

    const row = allRowsByMoNumber.get(moNumber);
    const ownGood = Number(row?.qtyGood || 0);
    const children = childMap.get(moNumber) || [];
    const childGood = children.reduce((sum, child) => {
      const result = visit(child.moNumber, nextVisited);
      return sum + Number(result.totalGood || 0);
    }, 0);
    const totalGood = ownGood + childGood;
    const aggregate = { ownGood, childGood, totalGood };
    fulfillmentMap.set(moNumber, aggregate);
    return aggregate;
  }

  for (const moNumber of allRowsByMoNumber.keys()) {
    visit(moNumber);
  }

  return items.map((item) => {
    const trace = metadataByMoNumber.get(item.moNumber) || {};
    const planned = Number(item?.qtyPlanned || 0);
    const aggregate = fulfillmentMap.get(item.moNumber) || {
      ownGood: Number(item?.qtyGood || 0),
      childGood: 0,
      totalGood: Number(item?.qtyGood || 0),
    };
    const good = Number(aggregate.totalGood || 0);
    const percent = planned > 0 ? Math.min(100, Math.round((good / planned) * 100)) : 0;

    let coverageStatus = "Open";
    if (planned > 0 && good >= planned) {
      coverageStatus = "Fully Covered";
    } else if (trace.sourceMoNumber && good > 0) {
      coverageStatus = "Derived Contribution";
    } else if (trace.sourceMoNumber) {
      coverageStatus = "Awaiting Contribution";
    } else if (good > 0) {
      coverageStatus = "Partial Coverage";
    }

    return {
      ...item,
      parentMoNumber: trace.sourceMoNumber || null,
      rootMoNumber: trace.sourceRootMoNumber || item.moNumber || null,
      fulfillment: {
        planned,
        good,
        ownGood: Number(aggregate.ownGood || 0),
        childGood: Number(aggregate.childGood || 0),
        percent,
        remaining: Math.max(0, planned - good),
      },
      coverageStatus,
    };
  });
}

function computeManufacturingOrderNgQueue(mo = {}) {
  const inspections = Array.isArray(mo?.qualityInspections) ? mo.qualityInspections : [];
  return inspections.reduce((sum, inspection) => {
    const decision = String(inspection?.decision || "").trim();
    const status = String(inspection?.status || "").trim();
    const isPendingDecision = !decision || decision === "Pending";
    if (!isPendingDecision) return sum;

    const pendingQty = Number(
      inspection?.qtyFailed
      ?? inspection?.qtyReject
      ?? 0,
    );
    if (!Number.isFinite(pendingQty) || pendingQty <= 0) return sum;

    // Jika inspection masih draft/submitted/pending decision, anggap masih antre keputusan.
    if (!status || ["Draft", "Submitted", "Pending", "Completed"].includes(status)) {
      return sum + pendingQty;
    }

    return sum;
  }, 0);
}

async function normalizeMoInputSource(tx, data = {}) {
  const inputSourceType = data.inputSourceType || "MBOM";
  if (!MO_INPUT_SOURCE_TYPES.has(inputSourceType)) {
    throw Object.assign(new Error("Input source MO hanya boleh MBOM atau WIP_STOCK."), { status: 400 });
  }

  const requestedAllocations = extractSourceWipAllocations(data);

  if (inputSourceType !== "WIP_STOCK") {
    return {
      inputSourceType: "MBOM",
      sourceStockBalanceId: null,
      sourceWarehouseCode: null,
      sourceRackCode: null,
      sourceLotNumber: null,
      sourcePartCode: null,
      sourcePartNumber: null,
      sourcePartName: null,
      sourceStockType: null,
      sourceQtyPlanned: null,
      notes: data.notes || null,
    };
  }

  if (!data.sourceStockBalanceId && requestedAllocations.length === 0) {
    throw Object.assign(new Error("Stock Balance WIP wajib dipilih untuk input source Existing WIP Stock."), {
      status: 400,
    });
  }

  const allocationsInput = requestedAllocations.length > 0
    ? requestedAllocations
    : [{
        stockBalanceId: data.sourceStockBalanceId,
        qty: data.qtyPlanned,
      }];

  const allocationIds = [...new Set(
    allocationsInput.map(allocation => allocation?.stockBalanceId).filter(Boolean),
  )];
  const stockBalances = await tx.stockBalance.findMany({
    where: {
      id: { in: allocationIds },
      ...(data.uomCode ? { uomCode: data.uomCode } : {}),
      isDeleted: false,
      stockType: "WIP",
    },
    select: sourceStockBalanceSelect,
  });
  if (stockBalances.length !== allocationIds.length) {
    throw Object.assign(new Error("Salah satu Stock Balance WIP tidak ditemukan."), { status: 404 });
  }

  const stockBalanceMap = new Map(stockBalances.map(stockBalance => [stockBalance.id, stockBalance]));
  const ownReservationAllowanceMap = await getOwnWipReservationAllowanceMap(
    tx,
    data.currentMoNumber || null,
    allocationIds,
  );
  const normalizedAllocations = allocationsInput.map((allocation) => {
    const stockBalance = stockBalanceMap.get(allocation.stockBalanceId);
    const qty = roundQty(allocation.qty);
    if (!stockBalance) {
      throw Object.assign(new Error("Salah satu Stock Balance WIP tidak ditemukan."), { status: 404 });
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      throw Object.assign(new Error("Qty setiap source WIP harus lebih dari 0."), { status: 400 });
    }
    const ownAllowance = Number(ownReservationAllowanceMap.get(stockBalance.id) || 0);
    const effectiveAvailable = roundQty(Number(stockBalance.qtyAvailable || 0) + ownAllowance);
    if (qty > effectiveAvailable) {
      throw Object.assign(
        new Error(`Qty source WIP melebihi available (${effectiveAvailable}) untuk ${stockBalance.partCode || stockBalance.id}.`),
        { status: 409 },
      );
    }

    return {
      stockBalanceId: stockBalance.id,
      qty,
      warehouseCode: stockBalance.warehouseCode || null,
      rackCode: stockBalance.rackCode || null,
      lotNumber: stockBalance.lotNumber || null,
      partCode: stockBalance.partCode || null,
      partNumber: stockBalance.partNumber || null,
      partName: stockBalance.partName || null,
      stockType: stockBalance.stockType || "WIP",
    };
  });

  const totalAllocatedQty = roundQty(
    normalizedAllocations.reduce((sum, allocation) => sum + Number(allocation.qty || 0), 0),
  );
  const qtyPlanned = roundQty(data.qtyPlanned || 0);
  if (qtyPlanned <= 0) {
    throw Object.assign(new Error("Qty MO harus lebih dari 0."), { status: 400 });
  }
  if (qtyPlanned !== totalAllocatedQty) {
    throw Object.assign(
      new Error(`Qty MO (${qtyPlanned}) harus sama dengan total selected WIP (${totalAllocatedQty}).`),
      { status: 409 },
    );
  }

  const primarySource = stockBalanceMap.get(normalizedAllocations[0].stockBalanceId);
  const partId = data.partId || await lookupPartId(tx, primarySource.partCode);
  return {
    inputSourceType: "WIP_STOCK",
    sourceStockBalanceId: primarySource.id,
    sourceWarehouseCode: primarySource.warehouseCode || null,
    sourceRackCode: primarySource.rackCode || null,
    sourceLotNumber: primarySource.lotNumber || null,
    sourcePartCode: primarySource.partCode || null,
    sourcePartNumber: primarySource.partNumber || null,
    sourcePartName: primarySource.partName || null,
    sourceStockType: primarySource.stockType || "WIP",
    sourceQtyPlanned: totalAllocatedQty,
    notes: data.notes || null,
    partId,
    sourceWipAllocationsNormalized: normalizedAllocations,
  };
}

function hasMoInputSourceChanged(existing = {}, updateData = {}) {
  if (updateData.inputSourceType !== undefined && updateData.inputSourceType !== existing.inputSourceType)
    return true;

  if ((updateData.sourceStockBalanceId || null) !== (existing.sourceStockBalanceId || null))
    return true;
  if ((updateData.sourceWarehouseCode || null) !== (existing.sourceWarehouseCode || null))
    return true;
  if ((updateData.sourceRackCode || null) !== (existing.sourceRackCode || null))
    return true;
  if ((updateData.sourceLotNumber || null) !== (existing.sourceLotNumber || null))
    return true;
  if ((updateData.sourcePartCode || null) !== (existing.sourcePartCode || null))
    return true;
  if ((updateData.sourcePartNumber || null) !== (existing.sourcePartNumber || null))
    return true;
  if ((updateData.sourcePartName || null) !== (existing.sourcePartName || null))
    return true;
  if ((updateData.sourceStockType || null) !== (existing.sourceStockType || null))
    return true;

  if (updateData.qtyPlanned !== undefined && roundQty(updateData.qtyPlanned) !== roundQty(existing.qtyPlanned))
    return true;
  if (updateData.sourceQtyPlanned !== undefined && roundQty(updateData.sourceQtyPlanned) !== roundQty(existing.sourceQtyPlanned))
    return true;

  return false;
}

const moSourceInclude = {
  sourceStockBalance: { select: sourceStockBalanceSelect },
  sourceWipAllocations: {
    where: { isDeleted: false },
    orderBy: { lineNumber: "asc" },
    select: sourceWipAllocationSelect,
  },
};

async function closeMonthlyProductionPlanIfAllMosCompleted(tx, planNumber, username = null) {
  if (!planNumber) return false;

  const [details, activeMos] = await Promise.all([
    tx.monthlyProductionPlanDetail.findMany({
      where: {
        plan: { planNumber },
        isDeleted: false,
      },
      select: { status: true },
    }),
    tx.manufacturingOrder.findMany({
      where: {
        monthlyProductionPlanNumber: planNumber,
        isDeleted: false,
        status: { not: "Cancelled" },
      },
      select: { status: true },
    }),
  ]);
  if (details.length === 0 || activeMos.length === 0) return false;
  if (details.some((detail) => detail.status !== "Completed")) return false;
  if (activeMos.some((mo) => mo.status !== "Completed")) return false;

  const updated = await tx.monthlyProductionPlan.updateMany({
    where: {
      planNumber,
      status: { in: ["Released", "In Progress"] },
      isDeleted: false,
    },
    data: {
      status: "Closed",
      closedBy: username,
      closedAt: new Date(),
    },
  });

  return updated.count > 0;
}

async function updateMonthlyProductionPlanDetailRelease(tx, detail, moNumber, qtyToRelease) {
  const plannedQty = Number(detail?.qtyPlanned || 0);
  const currentReleasedQty = Number(detail?.qtyReleased || 0);
  const releaseQty = Number(qtyToRelease || 0);
  const nextReleasedQty = roundQty(Math.min(plannedQty, currentReleasedQty + releaseQty));
  const status = nextReleasedQty >= plannedQty ? "Released" : "Partially Released";

  await tx.monthlyProductionPlanDetail.update({
    where: { id: detail.id },
    data: {
      status,
      manufacturingOrderNumber: moNumber,
      qtyReleased: nextReleasedQty,
    },
  });

  return { status, qtyReleased: nextReleasedQty };
}

async function syncPlannedOrderFromMonthlyPlanRelease(tx, detail, releaseStatus, releaseNumber = null) {
  if (!detail?.plannedOrderNumber) return;

  const plannedOrderStatus = releaseStatus === "Released" ? "Released" : "Partially Released";
  await tx.plannedOrder.updateMany({
    where: {
      orderNumber: detail.plannedOrderNumber,
      isDeleted: false,
      status: { in: ["Monthly Planned", "Partially Released", "Released"] },
    },
    data: {
      status: plannedOrderStatus,
    },
  });
}

async function getDirectPlannedOrderReleasedQty(tx, plannedOrderNumber, uomCode = null, excludeMoNumber = null) {
  if (!plannedOrderNumber) return 0;
  const result = await tx.manufacturingOrder.aggregate({
    where: {
      plannedOrderNumber,
      referenceType: "MRPPlannedOrder",
      ...(excludeMoNumber ? { moNumber: { not: excludeMoNumber } } : {}),
      ...(uomCode
        ? isKgUom(uomCode)
          ? { uomCode: { equals: "kg", mode: "insensitive" } }
          : { NOT: { uomCode: { equals: "kg", mode: "insensitive" } } }
        : {}),
      isDeleted: false,
      status: { not: "Cancelled" },
    },
    _sum: { qtyPlanned: true },
  });
  return roundQty(result._sum.qtyPlanned || 0);
}

async function getDirectPlannedOrderReleaseSummary(tx, plannedOrderNumber, excludeMoNumber = null) {
  if (!plannedOrderNumber) return { releasedOriginalQty: 0, releasedKgQty: 0 };
  const groups = await tx.manufacturingOrder.groupBy({
    by: ["uomCode"],
    where: {
      plannedOrderNumber,
      referenceType: "MRPPlannedOrder",
      ...(excludeMoNumber ? { moNumber: { not: excludeMoNumber } } : {}),
      isDeleted: false,
      status: { not: "Cancelled" },
    },
    _sum: { qtyPlanned: true },
  });

  return groups.reduce((summary, group) => {
    const qty = Number(group._sum.qtyPlanned || 0);
    if (isKgUom(group.uomCode)) {
      summary.releasedKgQty = roundQty(summary.releasedKgQty + qty);
    } else {
      summary.releasedOriginalQty = roundQty(summary.releasedOriginalQty + qty);
    }
    return summary;
  }, { releasedOriginalQty: 0, releasedKgQty: 0 });
}

async function getLatestDirectPlannedOrderMoNumber(tx, plannedOrderNumber, excludeMoNumber = null) {
  if (!plannedOrderNumber) return null;
  const mo = await tx.manufacturingOrder.findFirst({
    where: {
      plannedOrderNumber,
      referenceType: "MRPPlannedOrder",
      ...(excludeMoNumber ? { moNumber: { not: excludeMoNumber } } : {}),
      isDeleted: false,
      status: { not: "Cancelled" },
    },
    orderBy: { createdAt: "desc" },
    select: { moNumber: true },
  });
  return mo?.moNumber || null;
}

async function syncDirectPlannedOrderRelease(tx, plannedOrderNumber, excludeMoNumber = null) {
  if (!plannedOrderNumber) return null;

  const plannedOrder = await tx.plannedOrder.findUnique({
    where: { orderNumber: plannedOrderNumber },
    select: {
      qty: true,
      part: {
        select: {
          partBases: {
            select: { baseOn: true, grossWeight: true },
          },
        },
      },
    },
  });
  if (!plannedOrder) return null;

  const plannedQty = Number(plannedOrder.qty || 0);
  const kgPerPcs = resolveKgPerPcs(plannedOrder.part);
  const plannedKgQty = kgPerPcs ? roundQty(plannedQty * kgPerPcs) : null;
  const releaseSummary = await getDirectPlannedOrderReleaseSummary(tx, plannedOrderNumber, excludeMoNumber);
  const hasRelease = releaseSummary.releasedOriginalQty > 0 || releaseSummary.releasedKgQty > 0;
  const isFullyReleased =
    releaseSummary.releasedOriginalQty >= plannedQty ||
    (plannedKgQty != null && releaseSummary.releasedKgQty >= plannedKgQty);
  const status = !hasRelease
    ? "Planned"
    : isFullyReleased
      ? "Released"
      : "Partially Released";
  await tx.plannedOrder.updateMany({
    where: {
      orderNumber: plannedOrderNumber,
      isDeleted: false,
      status: { in: ["Planned", "Partially Released", "Released"] },
    },
    data: {
      status,
    },
  });

  return { status, ...releaseSummary };
}

async function syncMonthlyProductionPlanDetailCompletion(tx, mo, username = null) {
  if (!mo?.monthlyProductionPlanNumber || !mo?.monthlyProductionPlanLineNumber) return false;

  const detail = await tx.monthlyProductionPlanDetail.findFirst({
    where: {
      plan: { planNumber: mo.monthlyProductionPlanNumber },
      lineNumber: mo.monthlyProductionPlanLineNumber,
      isDeleted: false,
    },
    select: {
      id: true,
      status: true,
      qtyPlanned: true,
      qtyReleased: true,
      mpsDetailId: true,
    },
  });
  if (!detail) return false;

  const plannedQty = Number(detail.qtyPlanned || 0);
  const releasedQty = Number(detail.qtyReleased || 0);
  if (releasedQty < plannedQty) return false;

  const activeMos = await tx.manufacturingOrder.findMany({
    where: {
      monthlyProductionPlanNumber: mo.monthlyProductionPlanNumber,
      monthlyProductionPlanLineNumber: mo.monthlyProductionPlanLineNumber,
      isDeleted: false,
      status: { not: "Cancelled" },
    },
    select: { status: true },
  });
  if (activeMos.length === 0 || activeMos.some((item) => item.status !== "Completed")) {
    return false;
  }

  await tx.monthlyProductionPlanDetail.update({
    where: { id: detail.id },
    data: { status: "Completed", qtyReleased: plannedQty },
  });

  if (detail.mpsDetailId) {
    const generatedDetails = await tx.monthlyProductionPlanDetail.findMany({
      where: {
        plan: { planNumber: mo.monthlyProductionPlanNumber },
        isDeleted: false,
        notes: { contains: `[MPS-SOURCE:${detail.mpsDetailId}]` },
      },
      select: { id: true, qtyPlanned: true },
    });
    for (const generatedDetail of generatedDetails) {
      await tx.monthlyProductionPlanDetail.update({
        where: { id: generatedDetail.id },
        data: { status: "Completed", qtyReleased: Number(generatedDetail.qtyPlanned || 0) },
      });
    }
  }

  await closeMonthlyProductionPlanIfAllMosCompleted(
    tx,
    mo.monthlyProductionPlanNumber,
    username,
  );

  return true;
}

async function markMonthlyProductionPlanInProgress(tx, planNumber) {
  if (!planNumber) return false;
  const updated = await tx.monthlyProductionPlan.updateMany({
    where: {
      planNumber,
      status: "Released",
      isDeleted: false,
    },
    data: { status: "In Progress" },
  });
  return updated.count > 0;
}

async function findAffectedSoNumbersForMo(tx, mo) {
  const soNumbers = new Set();

  const supplyFilters = [
    { supplyType: "MO", supplyNumber: mo.moNumber },
  ];
  if (mo?.plannedOrderNumber) {
    supplyFilters.push({ supplyType: "PlannedOrder", supplyNumber: mo.plannedOrderNumber });
  }

  if (supplyFilters.length > 0) {
    const peggings = await tx.mRPPegging.findMany({
      where: {
        demandType: "SO",
        status: "Active",
        OR: supplyFilters,
      },
      select: { demandNumber: true },
    });

    for (const pegging of peggings) {
      if (pegging.demandNumber) soNumbers.add(pegging.demandNumber);
    }
  }

  if (mo?.plannedOrderNumber) {
    const plannedOrder = await tx.plannedOrder.findUnique({
      where: { orderNumber: mo.plannedOrderNumber },
      select: { referenceType: true, referenceNumber: true },
    });
    if (plannedOrder?.referenceType === "SO" && plannedOrder.referenceNumber) {
      const soNumber = plannedOrder.referenceNumber.split("#")[0];
      if (soNumber) soNumbers.add(soNumber);
    }
  }

  return [...soNumbers];
}

async function syncAffectedSalesOrdersForMo(tx, mo) {
  const soNumbers = await findAffectedSoNumbersForMo(tx, mo);
  for (const soNumber of soNumbers) {
    await syncOperationalSalesOrderStatus(tx, soNumber);
  }
}

async function createMoPeggingsFromPlannedOrder(tx, plannedOrderNumber, moNumber) {
  if (!plannedOrderNumber) return;

  const peggings = await tx.mRPPegging.findMany({
    where: {
      supplyType: "PlannedOrder",
      supplyNumber: plannedOrderNumber,
      demandType: "SO",
      status: "Active",
    },
    select: {
      demandType: true,
      demandNumber: true,
      demandLineNumber: true,
      itemId: true,
      qtyPegged: true,
    },
  });

  for (const pegging of peggings) {
    const where = {
      demandType: pegging.demandType,
      demandNumber: pegging.demandNumber,
      demandLineNumber: pegging.demandLineNumber,
      supplyType: "MO",
      supplyNumber: moNumber,
      supplyLineNumber: null,
      itemId: pegging.itemId,
    };

    const updated = await tx.mRPPegging.updateMany({
      where,
      data: {
        qtyPegged: pegging.qtyPegged,
        status: "Active",
        notes: `Released from PlannedOrder ${plannedOrderNumber}`,
      },
    });

    if (updated.count === 0) {
      await tx.mRPPegging.create({
        data: {
          ...where,
          qtyPegged: pegging.qtyPegged,
          status: "Active",
          notes: `Released from PlannedOrder ${plannedOrderNumber}`,
        },
      });
    }
  }
}

async function rollbackMonthlyProductionPlanForMo(tx, mo) {
  const details = await tx.monthlyProductionPlanDetail.findMany({
    where: {
      isDeleted: false,
      OR: [
        { manufacturingOrderNumber: mo.moNumber },
        ...(mo.monthlyProductionPlanNumber && mo.monthlyProductionPlanLineNumber
          ? [{
              plan: { planNumber: mo.monthlyProductionPlanNumber },
              lineNumber: mo.monthlyProductionPlanLineNumber,
            }]
          : []),
      ],
    },
    select: {
      id: true,
      lineNumber: true,
      plannedOrderNumber: true,
      qtyPlanned: true,
      qtyReleased: true,
      manufacturingOrderNumber: true,
      plan: { select: { planNumber: true } },
    },
  });

  if (details.length === 0) return false;

  for (const detail of details) {
    const currentReleasedQty = Number(detail.qtyReleased || 0);
    const rollbackQty = Number(mo.qtyPlanned || 0);
    const nextReleasedQty = roundQty(Math.max(0, currentReleasedQty - rollbackQty));
    const plannedQty = Number(detail.qtyPlanned || 0);
    const status = nextReleasedQty <= 0
      ? "Planned"
      : nextReleasedQty >= plannedQty
        ? "Released"
        : "Partially Released";
    await tx.monthlyProductionPlanDetail.update({
      where: { id: detail.id },
      data: {
        status,
        manufacturingOrderNumber: detail.manufacturingOrderNumber === mo.moNumber
          ? null
          : detail.manufacturingOrderNumber,
        qtyReleased: nextReleasedQty,
      },
    });

    if (detail.plannedOrderNumber) {
      const plannedOrderStatus = nextReleasedQty <= 0
        ? "Monthly Planned"
        : nextReleasedQty >= plannedQty
          ? "Released"
          : "Partially Released";

      await tx.plannedOrder.updateMany({
        where: {
          orderNumber: detail.plannedOrderNumber,
          isDeleted: false,
          status: { in: ["Partially Released", "Released"] },
        },
        data: {
          status: plannedOrderStatus,
        },
      });
    }
  }

  const planNumbers = [
    ...new Set([
      mo.monthlyProductionPlanNumber,
      ...details.map((detail) => detail.plan?.planNumber),
    ].filter(Boolean)),
  ];
  for (const planNumber of planNumbers) {
    const [plannedLines, releasedLines] = await Promise.all([
      tx.monthlyProductionPlanDetail.count({
        where: {
          plan: { planNumber },
          isDeleted: false,
          status: "Planned",
        },
      }),
      tx.monthlyProductionPlanDetail.count({
        where: {
          plan: { planNumber },
          isDeleted: false,
        status: { in: ["Partially Released", "Released", "Completed"] },
        },
      }),
    ]);

    if (plannedLines > 0 || releasedLines > 0) {
      const nextStatus = releasedLines > 0 ? "In Progress" : "Released";
      await tx.monthlyProductionPlan.updateMany({
        where: {
          planNumber,
          status: { in: ["Closed", "In Progress"] },
          isDeleted: false,
        },
        data: {
          status: nextStatus,
          closedBy: null,
          closedAt: null,
        },
      });
    }
  }

  return true;
}

async function rollbackPlannedOrderForMo(tx, mo) {
  await tx.plannedOrder.updateMany({
    where: {
      isDeleted: false,
      status: "Covered",
    },
    data: {
      status: "Planned",
    },
  });

  if (!mo.plannedOrderNumber) return;

  await syncDirectPlannedOrderRelease(tx, mo.plannedOrderNumber, mo.moNumber);
}

async function prepareMonthlyProductionPlanMoData(client, rawData, rawDates = {}) {
  let data = normalizeMoReferenceInput(rawData);
  const lineNumber = Number(rawData.monthlyProductionPlanLineNumber);
  if (!rawData.monthlyProductionPlanNumber || !Number.isFinite(lineNumber)) {
    throw Object.assign(new Error("Monthly production plan dan line wajib dikirim."), { status: 400 });
  }

  const plan = await client.monthlyProductionPlan.findUnique({
    where: { planNumber: rawData.monthlyProductionPlanNumber },
    select: {
      id: true,
      planNumber: true,
      status: true,
      isDeleted: true,
      periodStart: true,
      periodEnd: true,
      notes: true,
      details: {
        where: { lineNumber, isDeleted: false },
        take: 1,
        select: {
          id: true,
          status: true,
          lineNumber: true,
          plannedOrderNumber: true,
          manufacturingOrderNumber: true,
          partId: true,
          partCode: true,
          qtyPlanned: true,
          qtyReleased: true,
          uomCode: true,
          requiredDate: true,
          notes: true,
        },
      },
    },
  });

  if (!plan || plan.isDeleted) {
    throw Object.assign(new Error("Monthly production plan tidak ditemukan."), { status: 404 });
  }
  if (!["Released", "In Progress"].includes(plan.status)) {
    throw Object.assign(new Error("Monthly plan harus Released atau In Progress sebelum dibuatkan MO."), { status: 400 });
  }

  const monthlyProductionPlanDetail = plan.details[0] || null;
  if (!monthlyProductionPlanDetail) {
    throw Object.assign(new Error("Line monthly production plan tidak ditemukan."), { status: 404 });
  }
  // Process/WIP/child-FG rows in a monthly plan are routing outputs, not
  // standalone manufacturing orders. Only the non-generated FG parent line
  // may become an MO; WO and Daily Plan execute every child process below it.
  const partWhere = monthlyProductionPlanDetail.partId
    ? { id: monthlyProductionPlanDetail.partId }
    : { partCode: monthlyProductionPlanDetail.partCode };
  const detailPart = await client.part.findFirst({
    where: { ...partWhere, isDeleted: false },
    select: { itemType: true },
  });
  const isParentFgLine = String(detailPart?.itemType || "").toUpperCase() === "FG"
    && !String(monthlyProductionPlanDetail.notes || "").includes("[MRP-PRODUCTION]");
  if (!isParentFgLine) {
    throw Object.assign(new Error(`MPP line ${lineNumber} (${monthlyProductionPlanDetail.partCode}) adalah child/process; MO hanya dibuat untuk FG parent.`), { status: 409, code: "CHILD_MO_NOT_ALLOWED" });
  }
  if (monthlyProductionPlanDetail.status === "Converted") {
    throw Object.assign(new Error("Line monthly production plan sudah fully released ke MO."), { status: 409 });
  }
  if (!["Planned", "Partially Released"].includes(monthlyProductionPlanDetail.status)) {
    throw Object.assign(new Error(`Line monthly production plan status ${monthlyProductionPlanDetail.status} tidak bisa dibuatkan MO.`), { status: 409 });
  }

  const qtyPlanned = Number(monthlyProductionPlanDetail.qtyPlanned || 0);
  const qtyReleased = Number(monthlyProductionPlanDetail.qtyReleased || 0);
  const qtyRemaining = roundQty(qtyPlanned - qtyReleased);
  if (qtyRemaining <= 0) {
    throw Object.assign(new Error("Qty remaining monthly production plan sudah habis."), { status: 409 });
  }
  const requestedQty = data.qtyPlanned == null ? qtyRemaining : Number(data.qtyPlanned || 0);
  if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
    throw Object.assign(new Error("Qty MO harus lebih dari 0."), { status: 400 });
  }
  if (requestedQty > qtyRemaining) {
    throw Object.assign(new Error(`Qty MO melebihi remaining MPP line (${qtyRemaining}).`), { status: 409 });
  }

  data.plannedOrderNumber = data.plannedOrderNumber || monthlyProductionPlanDetail.plannedOrderNumber || null;
  data.partId = data.partId || monthlyProductionPlanDetail.partId || await lookupPartId(client, monthlyProductionPlanDetail.partCode);
  data.qtyPlanned = roundQty(requestedQty);
  data.uomCode = data.uomCode ?? monthlyProductionPlanDetail.uomCode ?? null;
  data.notes = data.notes || monthlyProductionPlanDetail.notes || plan.notes || null;
  data.monthlyProductionPlanNumber = plan.planNumber;
  data.monthlyProductionPlanLineNumber = monthlyProductionPlanDetail.lineNumber;

  return {
    data,
    monthlyProductionPlanDetail,
    plannedStartDate: rawDates.plannedStartDate || plan.periodStart,
    plannedEndDate: rawDates.plannedEndDate || monthlyProductionPlanDetail.requiredDate || plan.periodEnd,
  };
}

function formatRelationList(items) {
  return items.filter(Boolean).join(", ");
}

async function getMoDeleteBlockers(tx, mo) {
  const childStatusWhere = mo.status === "Cancelled" ? { not: "Cancelled" } : undefined;
  const [
    startedWorkOrders,
    activeVendorOrders,
    productionLogCount,
    qualityInspectionCount,
    activeMaterialIssues,
    wipEntryCount,
    stockMovementCount,
  ] = await Promise.all([
    tx.workOrder.findMany({
      where: {
        moId: mo.id,
        isDeleted: false,
        ...(childStatusWhere ? { status: childStatusWhere } : {}),
        OR: [
          { status: { notIn: MO_CHILD_DELETABLE_WORK_ORDER_STATUSES } },
          { qtyProduced: { gt: 0 } },
          { qtyGood: { gt: 0 } },
          { qtyReject: { gt: 0 } },
          { shotCount: { gt: 0 } },
          { startTime: { not: null } },
          { endTime: { not: null } },
        ],
      },
      select: { woNumber: true, status: true },
      orderBy: { sequence: "asc" },
    }),
    tx.vendorProcessOrder.findMany({
      where: {
        moId: mo.id,
        isDeleted: false,
        ...(childStatusWhere ? { status: childStatusWhere } : {}),
        OR: [
          { status: { notIn: MO_CHILD_DELETABLE_VENDOR_ORDER_STATUSES } },
          { qtySent: { gt: 0 } },
          { qtyReceived: { gt: 0 } },
          { qtyAccepted: { gt: 0 } },
          { qtyReject: { gt: 0 } },
          { qtyRework: { gt: 0 } },
          { qtyScrap: { gt: 0 } },
        ],
      },
      select: { orderNumber: true, status: true },
      orderBy: { sequence: "asc" },
    }),
    tx.productionLog.count({ where: { moId: mo.id, isDeleted: false } }),
    tx.qualityInspection.count({ where: { moId: mo.id, isDeleted: false } }),
    tx.materialIssue.findMany({
      where: {
        moId: mo.id,
        isDeleted: false,
        ...(childStatusWhere ? { status: childStatusWhere } : {}),
        status: { notIn: MO_CHILD_DELETABLE_MATERIAL_ISSUE_STATUSES },
      },
      select: { issueNumber: true, status: true },
      orderBy: { issueDate: "asc" },
    }),
    tx.wIPEntry.count({ where: { moId: mo.id, isDeleted: false } }),
    tx.stockMovement.count({
      where: {
        referenceType: "MANUFACTURING_ORDER",
        referenceNumber: mo.moNumber,
        isDeleted: false,
      },
    }),
  ]);

  return [
    startedWorkOrders.length > 0 &&
      `WO sudah berjalan: ${startedWorkOrders.map((wo) => `${wo.woNumber} (${wo.status})`).join(", ")}`,
    activeVendorOrders.length > 0 &&
      `VPO sudah berjalan: ${activeVendorOrders.map((vpo) => `${vpo.orderNumber} (${vpo.status})`).join(", ")}`,
    productionLogCount > 0 && `${productionLogCount} Production Log`,
    qualityInspectionCount > 0 && `${qualityInspectionCount} QC`,
    activeMaterialIssues.length > 0 &&
      `Material Issue sudah diproses: ${activeMaterialIssues.map((mi) => `${mi.issueNumber} (${mi.status})`).join(", ")}`,
    wipEntryCount > 0 && `${wipEntryCount} WIP Entry`,
    stockMovementCount > 0 && `${stockMovementCount} Stock Movement`,
  ].filter(Boolean);
}

async function deleteInactiveMoChildren(tx, mo) {
  await Promise.all([
    tx.workOrder.updateMany({
      where: {
        moId: mo.id,
        isDeleted: false,
        status: { in: MO_CHILD_DELETABLE_WORK_ORDER_STATUSES },
      },
      data: { isDeleted: true },
    }),
    tx.materialIssue.updateMany({
      where: {
        moId: mo.id,
        isDeleted: false,
        status: { in: MO_CHILD_DELETABLE_MATERIAL_ISSUE_STATUSES },
      },
      data: { isDeleted: true },
    }),
    tx.vendorProcessOrder.updateMany({
      where: {
        moId: mo.id,
        isDeleted: false,
        status: { in: MO_CHILD_DELETABLE_VENDOR_ORDER_STATUSES },
      },
      data: { isDeleted: true },
    }),
  ]);
}

async function getMoCancelBlockers(tx, mo) {
  const [
    runningWorkOrders,
    runningVendorOrders,
    materialIssues,
    productionLogCount,
    qualityInspectionCount,
    wipEntryCount,
    stockMovementCount,
  ] = await Promise.all([
    tx.workOrder.findMany({
      where: {
        moId: mo.id,
        isDeleted: false,
        OR: [
          { status: { notIn: MO_CHILD_DELETABLE_WORK_ORDER_STATUSES } },
          { qtyProduced: { gt: 0 } },
          { qtyGood: { gt: 0 } },
          { qtyReject: { gt: 0 } },
          { shotCount: { gt: 0 } },
          { startTime: { not: null } },
          { endTime: { not: null } },
        ],
      },
      select: { woNumber: true, status: true },
      orderBy: { sequence: "asc" },
    }),
    tx.vendorProcessOrder.findMany({
      where: {
        moId: mo.id,
        isDeleted: false,
        OR: [
          { status: { notIn: MO_CHILD_DELETABLE_VENDOR_ORDER_STATUSES } },
          { qtySent: { gt: 0 } },
          { qtyReceived: { gt: 0 } },
          { qtyAccepted: { gt: 0 } },
          { qtyReject: { gt: 0 } },
          { qtyRework: { gt: 0 } },
          { qtyScrap: { gt: 0 } },
        ],
      },
      select: { orderNumber: true, status: true },
      orderBy: { sequence: "asc" },
    }),
    tx.materialIssue.findMany({
      where: {
        moId: mo.id,
        isDeleted: false,
        status: { notIn: ["Draft", "Cancelled"] },
      },
      select: { issueNumber: true, status: true },
      orderBy: { issueDate: "asc" },
    }),
    tx.productionLog.count({ where: { moId: mo.id, isDeleted: false } }),
    tx.qualityInspection.count({ where: { moId: mo.id, isDeleted: false } }),
    tx.wIPEntry.count({ where: { moId: mo.id, isDeleted: false } }),
    tx.stockMovement.count({
      where: {
        referenceType: "MANUFACTURING_ORDER",
        referenceNumber: mo.moNumber,
        isDeleted: false,
      },
    }),
  ]);

  return [
    runningWorkOrders.length > 0 &&
      `WO sudah berjalan/selesai: ${runningWorkOrders.map((wo) => `${wo.woNumber} (${wo.status})`).join(", ")}`,
    runningVendorOrders.length > 0 &&
      `VPO sudah berjalan: ${runningVendorOrders.map((vpo) => `${vpo.orderNumber} (${vpo.status})`).join(", ")}`,
    materialIssues.length > 0 &&
      `Material Issue sudah diproses: ${materialIssues.map((mi) => `${mi.issueNumber} (${mi.status})`).join(", ")}`,
    productionLogCount > 0 && `${productionLogCount} Production Log sudah dibuat`,
    qualityInspectionCount > 0 && `${qualityInspectionCount} QC sudah dibuat`,
    wipEntryCount > 0 && `${wipEntryCount} WIP Entry sudah tercatat`,
    stockMovementCount > 0 && `${stockMovementCount} Stock Movement sudah tercatat`,
  ].filter(Boolean);
}

exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      page = 1,
      limit = 20,
      partId,
      referenceType,
      status,
      startDate,
      endDate,
    } = req.query;

    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    if (partId) where.partId = partId;
    if (referenceType) where.referenceType = referenceType;
    if (status) where.status = status;

    if (startDate || endDate) {
      where.plannedStartDate = {};
      if (startDate) where.plannedStartDate.gte = new Date(startDate);
      if (endDate) where.plannedStartDate.lte = new Date(endDate);
    }

    if (q) {
      where.OR = [
        { moNumber: { contains: q, mode: "insensitive" } },
        { parentMoNumber: { contains: q, mode: "insensitive" } },
        { rootMoNumber: { contains: q, mode: "insensitive" } },
        { part: { partCode: { contains: q, mode: "insensitive" } } },
        { part: { partName: { contains: q, mode: "insensitive" } } },
        { notes: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query, { defaultSort: { moDate: "desc" } });
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.manufacturingOrder.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
        include: {
          part: { select: { partCode: true, partNumber: true, partName: true } },
          uom: { select: { uomCode: true, uomName: true } },
          ...moSourceInclude,
          workOrders: {
            where: { isDeleted: false },
            select: { id: true, woNumber: true, status: true, plannedDate: true, qtyProduced: true },
          },
        },
      }),
      prisma.manufacturingOrder.count({ where }),
    ]);

    const enrichedItems = await enrichManufacturingOrderCoverage(prisma, items);

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

exports.get = async (req, res, next) => {
  try {
    const doc = await prisma.manufacturingOrder.findFirst({
      where: { moNumber: req.params.moNumber, isDeleted: false },
      include: {
        part: { select: { partCode: true, partNumber: true, partName: true } },
        uom: { select: { uomCode: true, uomName: true } },
        ...moSourceInclude,
        workOrders: {
          where: { isDeleted: false },
          orderBy: { createdAt: "asc" },
          include: {
            dies: { select: { diesCode: true, diesName: true } },
          },
        },
        productionLogs: {
          where: { isDeleted: false },
          orderBy: { logDate: "desc" },
          select: {
            id: true, logNumber: true, logDate: true, shift: true,
            machineCode: true, operatorName: true,
            qtyProduced: true, qtyGood: true, qtyReject: true, status: true,
          },
        },
        qualityInspections: {
          where: { isDeleted: false },
          orderBy: { inspectionDate: "desc" },
          select: {
            id: true, inspectionNumber: true, inspectionDate: true,
            qtyInspected: true, qtyPassed: true, qtyFailed: true,
            decision: true, status: true,
          },
        },
        materialIssues: {
          where: { isDeleted: false },
          orderBy: { issueDate: "desc" },
          select: {
            id: true, issueNumber: true, issueDate: true,
            warehouseCode: true, issuedBy: true, status: true,
            _count: { select: { details: true } },
          },
        },
      },
    });

    if (!doc) return res.status(404).json({ message: "Data Manufacturing Order tidak ditemukan." });

    const [enrichedDoc] = await enrichManufacturingOrderCoverage(prisma, [doc]);
    const qtyNgQueue = computeManufacturingOrderNgQueue(doc);
    const fulfillment = enrichedDoc?.fulfillment || null;
    const openMoQty = Math.max(0, Number(fulfillment?.remaining ?? (doc.qtyPlanned || 0) - (doc.qtyGood || 0)));
    const qtyWipRemaining = Math.max(0, openMoQty - qtyNgQueue);

    const responseDoc = {
      ...doc,
      ...enrichedDoc,
      qtyNgQueue,
      openMoQty,
      qtyWipRemaining,
    };

	    emitManufacturingOrderUpdate(responseDoc, "complete", req.user?.username || "system");
	    res.json(mapDoc(responseDoc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    let {
      plannedStartDate,
      plannedEndDate,
      monthlyProductionPlanNumber,
      monthlyProductionPlanLineNumber,
      actualStartDate: _actualStartDate,
      actualEndDate: _actualEndDate,
      qtyProduced: _qtyProduced,
      qtyGood: _qtyGood,
      qtyReject: _qtyReject,
      ...data
    } = req.body;

    data = stripSourceWipAllocationFields(normalizeMoReferenceInput(data));
    if (Array.isArray(req.body?.sourceWipAllocations)) {
      data.sourceWipAllocations = req.body.sourceWipAllocations;
    }
    let monthlyProductionPlanDetail = null;

    if (data.referenceType === "MonthlyProductionPlan") {
      const lineNumber = Number(monthlyProductionPlanLineNumber);
      if (!monthlyProductionPlanNumber || !Number.isFinite(lineNumber)) {
        return res.status(400).json({ message: "Monthly production plan dan line wajib dikirim." });
      }

      const plan = await prisma.monthlyProductionPlan.findUnique({
        where: { planNumber: monthlyProductionPlanNumber },
        select: {
          id: true,
          planNumber: true,
          status: true,
          isDeleted: true,
          periodStart: true,
          periodEnd: true,
          notes: true,
          details: {
            where: { lineNumber, isDeleted: false },
            take: 1,
            select: {
              id: true,
              status: true,
              lineNumber: true,
              plannedOrderNumber: true,
              manufacturingOrderNumber: true,
              partId: true,
              partCode: true,
              qtyPlanned: true,
              qtyReleased: true,
              uomCode: true,
              requiredDate: true,
              notes: true,
            },
          },
        },
      });

      if (!plan || plan.isDeleted) {
        return res.status(404).json({ message: "Monthly production plan tidak ditemukan." });
      }
      if (!["Released", "In Progress"].includes(plan.status)) {
        return res.status(400).json({ message: "Monthly plan harus Released atau In Progress sebelum dibuatkan MO." });
      }

      monthlyProductionPlanDetail = plan.details[0] || null;
      if (!monthlyProductionPlanDetail) {
        return res.status(404).json({ message: "Line monthly production plan tidak ditemukan." });
      }
      const detailPart = await prisma.part.findFirst({
        where: { ...(monthlyProductionPlanDetail.partId ? { id: monthlyProductionPlanDetail.partId } : { partCode: monthlyProductionPlanDetail.partCode }), isDeleted: false },
        select: { itemType: true },
      });
      const isParentFgLine = String(detailPart?.itemType || "").toUpperCase() === "FG"
        && !String(monthlyProductionPlanDetail.notes || "").includes("[MRP-PRODUCTION]");
      if (!isParentFgLine) {
        return res.status(409).json({ message: `MPP line ${lineNumber} (${monthlyProductionPlanDetail.partCode}) adalah child/process; MO hanya dibuat untuk FG parent.`, code: "CHILD_MO_NOT_ALLOWED" });
      }
      if (monthlyProductionPlanDetail.status === "Converted") {
        return res.status(409).json({ message: "Line monthly production plan sudah fully released ke MO." });
      }
      if (!["Planned", "Partially Released"].includes(monthlyProductionPlanDetail.status)) {
        return res.status(409).json({ message: `Line monthly production plan status ${monthlyProductionPlanDetail.status} tidak bisa dibuatkan MO.` });
      }

      const qtyPlanned = Number(monthlyProductionPlanDetail.qtyPlanned || 0);
      const qtyReleased = Number(monthlyProductionPlanDetail.qtyReleased || 0);
      const qtyRemaining = roundQty(qtyPlanned - qtyReleased);
      if (qtyRemaining <= 0) {
        return res.status(409).json({ message: "Qty remaining monthly production plan sudah habis." });
      }
      const requestedQty = data.qtyPlanned == null ? qtyRemaining : Number(data.qtyPlanned || 0);
      if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
        return res.status(400).json({ message: "Qty MO harus lebih dari 0." });
      }
      if (requestedQty > qtyRemaining) {
        return res.status(409).json({ message: `Qty MO melebihi remaining MPP line (${qtyRemaining}).` });
      }

      data.plannedOrderNumber = data.plannedOrderNumber || monthlyProductionPlanDetail.plannedOrderNumber || null;
      data.partId = data.partId || monthlyProductionPlanDetail.partId || await lookupPartId(prisma, monthlyProductionPlanDetail.partCode);
      data.qtyPlanned = roundQty(requestedQty);
      data.uomCode = data.uomCode ?? monthlyProductionPlanDetail.uomCode ?? null;
      data.monthlyProductionPlanNumber = plan.planNumber;
      data.monthlyProductionPlanLineNumber = monthlyProductionPlanDetail.lineNumber;
      plannedStartDate = plannedStartDate || plan.periodStart;
      plannedEndDate = plannedEndDate || monthlyProductionPlanDetail.requiredDate || plan.periodEnd;
      data.notes = data.notes || monthlyProductionPlanDetail.notes || plan.notes || null;
    }

    // Validasi planned order jika disertakan
    if (data.plannedOrderNumber) {
      const po = await prisma.plannedOrder.findUnique({
        where: { orderNumber: data.plannedOrderNumber },
        select: {
          status: true,
          orderType: true,
          qty: true,
          uomCode: true,
          partId: true,
          partCode: true,
          part: {
            select: {
              partBases: {
                select: { baseOn: true, grossWeight: true },
              },
            },
          },
          runNumber: true,
          referenceType: true,
          requiredDate: true,
          orderDate: true,
        },
      });
      if (!po) {
        return res.status(404).json({ message: `Planned Order '${data.plannedOrderNumber}' tidak ditemukan` });
      }
      if (po.orderType !== "Production") {
        return res.status(400).json({ message: `Planned Order '${data.plannedOrderNumber}' bukan tipe Production` });
      }
      await assertPlannedOrderCanConvertToMo(prisma, po);

      if (data.referenceType !== "MonthlyProductionPlan") {
        if (!["Planned", "Partially Released", "Released"].includes(po.status)) {
          return res.status(409).json({ message: `Planned Order '${data.plannedOrderNumber}' status ${po.status} tidak bisa di-release langsung ke MO` });
        }
        const requestedUom = data.uomCode ?? po.uomCode ?? null;
        const plannedQtyForBasis = isKgUom(requestedUom)
          ? roundQty(Number(po.qty || 0) * Number(resolveKgPerPcs(po.part) || 0))
          : Number(po.qty || 0);
        if (plannedQtyForBasis <= 0) {
          return res.status(409).json({ message: `Qty basis ${requestedUom || po.uomCode || "-"} tidak tersedia untuk Planned Order '${data.plannedOrderNumber}'.` });
        }
        const releasedQty = await getDirectPlannedOrderReleasedQty(prisma, data.plannedOrderNumber, requestedUom);
        const remainingQty = roundQty(plannedQtyForBasis - releasedQty);
        if (remainingQty <= 0) {
          return res.status(409).json({ message: `Remaining qty Planned Order '${data.plannedOrderNumber}' sudah habis.` });
        }
        const requestedQty = data.qtyPlanned == null ? remainingQty : Number(data.qtyPlanned || 0);
        if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
          return res.status(400).json({ message: "Qty MO harus lebih dari 0." });
        }
        if (requestedQty > remainingQty) {
          return res.status(409).json({ message: `Qty MO melebihi remaining planned order (${remainingQty}).` });
        }
        data.qtyPlanned = roundQty(requestedQty);
        data.uomCode = requestedUom;
      } else if (po.status === "Released") {
        return res.status(409).json({ message: `Planned Order '${data.plannedOrderNumber}' sudah released` });
      }
      data.partId = data.partId ?? po.partId ?? null;
    }

    if (data.qtyPlanned !== undefined && data.qtyPlanned !== null) {
      assertQuantity(data.qtyPlanned, data.uomCode, "Qty MO");
    }
    const moNumber = await generateMoNumber();

	    const doc = await prisma.$transaction(async (tx) => {
      Object.assign(data, await normalizeMoInputSource(tx, data));
      const normalizedSourceWipAllocations = data.sourceWipAllocationsNormalized || [];
      data = stripSourceWipAllocationFields(data);
      const mo = await tx.manufacturingOrder.create({
        data: {
          ...data,
          moNumber,
          plannedStartDate: plannedStartDate ? new Date(plannedStartDate) : null,
          plannedEndDate: plannedEndDate ? new Date(plannedEndDate) : null,
        },
        include: {
          part: { select: { partCode: true, partNumber: true, partName: true } },
          uom: { select: { uomCode: true, uomName: true } },
          ...moSourceInclude,
        },
      });
      await syncManufacturingOrderSourceWipAllocations(tx, mo, normalizedSourceWipAllocations);

      let monthlyPlanRelease = null;
      if (monthlyProductionPlanDetail) {
        monthlyPlanRelease = await updateMonthlyProductionPlanDetailRelease(
          tx,
          monthlyProductionPlanDetail,
          moNumber,
          data.qtyPlanned,
        );
        await markMonthlyProductionPlanInProgress(tx, data.monthlyProductionPlanNumber);
      }

      if (data.plannedOrderNumber && data.referenceType === "MonthlyProductionPlan" && monthlyPlanRelease) {
        await syncPlannedOrderFromMonthlyPlanRelease(
          tx,
          monthlyProductionPlanDetail,
          monthlyPlanRelease.status,
          moNumber,
        );
        if (monthlyPlanRelease.status === "Released") {
          await createMoPeggingsFromPlannedOrder(tx, data.plannedOrderNumber, moNumber);
        }
      } else if (data.plannedOrderNumber) {
        await syncDirectPlannedOrderRelease(tx, data.plannedOrderNumber);
        await createMoPeggingsFromPlannedOrder(tx, data.plannedOrderNumber, moNumber);
      }

      await syncAffectedSalesOrdersForMo(tx, {
        moNumber,
        plannedOrderNumber: data.plannedOrderNumber || null,
      });

      return tx.manufacturingOrder.findUnique({
        where: { id: mo.id },
        include: {
          part: { select: { partCode: true, partNumber: true, partName: true } },
          uom: { select: { uomCode: true, uomName: true } },
          ...moSourceInclude,
        },
      });
    });

    emitManufacturingOrderUpdate(doc, "create", req.user?.username || "system");
    res.status(201).json(mapDoc(doc));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ message: e.message });
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ message: PO_NUMBER_CONFLICT });
    }
    next(e);
  }
};

async function filterBulkMonthlyPlanMoItems(client, items) {
  const monthlyItems = items.filter((item) =>
    normalizeMoReferenceInput(item).referenceType === "MonthlyProductionPlan"
    && item.monthlyProductionPlanNumber
    && Number.isFinite(Number(item.monthlyProductionPlanLineNumber)));
  if (!monthlyItems.length) return { eligibleItems: items, skippedItems: [] };

  const planNumbers = [...new Set(monthlyItems.map((item) => item.monthlyProductionPlanNumber))];
  const lineNumbers = [...new Set(monthlyItems.map((item) => Number(item.monthlyProductionPlanLineNumber)))];
  const details = await client.monthlyProductionPlanDetail.findMany({
    where: {
      isDeleted: false,
      lineNumber: { in: lineNumbers },
      plan: { planNumber: { in: planNumbers }, isDeleted: false },
    },
    select: {
      lineNumber: true,
      partId: true,
      partCode: true,
      notes: true,
      plan: { select: { planNumber: true } },
    },
  });
  const partIds = [...new Set(details.map((detail) => detail.partId).filter(Boolean))];
  const partCodes = [...new Set(details.map((detail) => detail.partCode).filter(Boolean))];
  const parts = partIds.length || partCodes.length ? await client.part.findMany({
    where: {
      isDeleted: false,
      OR: [
        ...(partIds.length ? [{ id: { in: partIds } }] : []),
        ...(partCodes.length ? [{ partCode: { in: partCodes } }] : []),
      ],
    },
    select: { id: true, partCode: true, partName: true, itemType: true },
  }) : [];
  const detailByReference = new Map(details.map((detail) => [
    `${detail.plan.planNumber}|${detail.lineNumber}`,
    detail,
  ]));
  const partById = new Map(parts.map((part) => [part.id, part]));
  const partByCode = new Map(parts.map((part) => [part.partCode, part]));
  const skippedItems = [];
  const eligibleItems = items.filter((item) => {
    const normalized = normalizeMoReferenceInput(item);
    if (normalized.referenceType !== "MonthlyProductionPlan") return true;
    const detail = detailByReference.get(`${item.monthlyProductionPlanNumber}|${Number(item.monthlyProductionPlanLineNumber)}`);
    if (!detail) return true;
    const part = partById.get(detail.partId) || partByCode.get(detail.partCode) || null;
    const isParentFgLine = String(part?.itemType || "").toUpperCase() === "FG"
      && !String(detail.notes || "").includes("[MRP-PRODUCTION]");
    if (isParentFgLine) return true;
    skippedItems.push({
      monthlyProductionPlanNumber: item.monthlyProductionPlanNumber,
      monthlyProductionPlanLineNumber: Number(item.monthlyProductionPlanLineNumber),
      partCode: detail.partCode,
      partName: part?.partName || null,
      reason: "CHILD_PROCESS_EXECUTED_BY_PARENT_MO",
    });
    return false;
  });
  return { eligibleItems, skippedItems };
}

exports.bulkCreate = async (req, res, next) => {
  try {
    const rawItems = req.body?.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return res.status(400).json({ message: "items array required" });
    }
    const { eligibleItems: items, skippedItems } = await filterBulkMonthlyPlanMoItems(prisma, rawItems);
    if (!items.length) {
      return res.status(409).json({
        message: "Tidak ada FG parent yang dapat dibuat menjadi MO. Child/process akan dieksekusi melalui routing, WO, dan Daily Plan dari MO parent.",
        code: "FG_PARENT_MO_REQUIRED",
        skippedItems,
      });
    }

    const created = await prisma.$transaction(async (tx) => {
      const docs = [];

      for (const item of items) {
        const {
          plannedStartDate,
          plannedEndDate,
          actualStartDate: _actualStartDate,
          actualEndDate: _actualEndDate,
          qtyProduced: _qtyProduced,
          qtyGood: _qtyGood,
          qtyReject: _qtyReject,
          monthlyProductionPlanNumber: _monthlyProductionPlanNumber,
          monthlyProductionPlanLineNumber: _monthlyProductionPlanLineNumber,
          ...rawData
        } = item;

        let data = normalizeMoReferenceInput({
          ...rawData,
          monthlyProductionPlanNumber: item.monthlyProductionPlanNumber,
          monthlyProductionPlanLineNumber: item.monthlyProductionPlanLineNumber,
        });
        let monthlyProductionPlanDetail = null;
        let resolvedPlannedStartDate = plannedStartDate;
        let resolvedPlannedEndDate = plannedEndDate;

        if (data.referenceType === "MonthlyProductionPlan") {
          const prepared = await prepareMonthlyProductionPlanMoData(tx, {
            ...rawData,
            monthlyProductionPlanNumber: item.monthlyProductionPlanNumber,
            monthlyProductionPlanLineNumber: item.monthlyProductionPlanLineNumber,
          }, { plannedStartDate, plannedEndDate });
          data = prepared.data;
          monthlyProductionPlanDetail = prepared.monthlyProductionPlanDetail;
          resolvedPlannedStartDate = prepared.plannedStartDate;
          resolvedPlannedEndDate = prepared.plannedEndDate;
        }

        if (data.plannedOrderNumber) {
          const po = await tx.plannedOrder.findUnique({
            where: { orderNumber: data.plannedOrderNumber },
            select: {
              status: true,
              orderType: true,
              qty: true,
              uomCode: true,
              partId: true,
              partCode: true,
              part: {
                select: {
                  partBases: {
                    select: { baseOn: true, grossWeight: true },
                  },
                },
              },
              runNumber: true,
              referenceType: true,
              requiredDate: true,
              orderDate: true,
            },
          });
          if (!po) {
            throw Object.assign(new Error(`Planned Order '${data.plannedOrderNumber}' tidak ditemukan`), { status: 404 });
          }
          if (po.orderType !== "Production") {
            throw Object.assign(new Error(`Planned Order '${data.plannedOrderNumber}' bukan tipe Production`), { status: 400 });
          }
          await assertPlannedOrderCanConvertToMo(tx, po);

          if (data.referenceType !== "MonthlyProductionPlan") {
            if (!["Planned", "Partially Released", "Released"].includes(po.status)) {
              throw Object.assign(new Error(`Planned Order '${data.plannedOrderNumber}' status ${po.status} tidak bisa di-release langsung ke MO`), { status: 409 });
            }
            const requestedUom = data.uomCode ?? po.uomCode ?? null;
            const plannedQtyForBasis = isKgUom(requestedUom)
              ? roundQty(Number(po.qty || 0) * Number(resolveKgPerPcs(po.part) || 0))
              : Number(po.qty || 0);
            if (plannedQtyForBasis <= 0) {
              throw Object.assign(new Error(`Qty basis ${requestedUom || po.uomCode || "-"} tidak tersedia untuk Planned Order '${data.plannedOrderNumber}'.`), { status: 409 });
            }
            const releasedQty = await getDirectPlannedOrderReleasedQty(tx, data.plannedOrderNumber, requestedUom);
            const remainingQty = roundQty(plannedQtyForBasis - releasedQty);
            if (remainingQty <= 0) {
              throw Object.assign(new Error(`Remaining qty Planned Order '${data.plannedOrderNumber}' sudah habis.`), { status: 409 });
            }
            const requestedQty = data.qtyPlanned == null ? remainingQty : Number(data.qtyPlanned || 0);
            if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
              throw Object.assign(new Error("Qty MO harus lebih dari 0."), { status: 400 });
            }
            if (requestedQty > remainingQty) {
              throw Object.assign(new Error(`Qty MO melebihi remaining planned order (${remainingQty}).`), { status: 409 });
            }
            data.qtyPlanned = roundQty(requestedQty);
            data.uomCode = requestedUom;
          } else if (po.status === "Released") {
            throw Object.assign(new Error(`Planned Order '${data.plannedOrderNumber}' sudah released`), { status: 409 });
          }
          data.partId = data.partId ?? po.partId ?? null;
        }

        Object.assign(data, await normalizeMoInputSource(tx, data));
        const normalizedSourceWipAllocations = data.sourceWipAllocationsNormalized || [];
        data = stripSourceWipAllocationFields(data);
        const moNumber = await generateMoNumber(tx);
        const mo = await tx.manufacturingOrder.create({
          data: {
            ...data,
            moNumber,
            plannedStartDate: resolvedPlannedStartDate ? new Date(resolvedPlannedStartDate) : null,
            plannedEndDate: resolvedPlannedEndDate ? new Date(resolvedPlannedEndDate) : null,
            createdBy: req.user?.username || data.createdBy || null,
          },
          include: {
            part: { select: { partCode: true, partNumber: true, partName: true } },
            uom: { select: { uomCode: true, uomName: true } },
            ...moSourceInclude,
          },
        });
        await syncManufacturingOrderSourceWipAllocations(tx, mo, normalizedSourceWipAllocations);

        let monthlyPlanRelease = null;
        if (monthlyProductionPlanDetail) {
          monthlyPlanRelease = await updateMonthlyProductionPlanDetailRelease(
            tx,
            monthlyProductionPlanDetail,
            moNumber,
            data.qtyPlanned,
          );
          await markMonthlyProductionPlanInProgress(tx, data.monthlyProductionPlanNumber);
        }

        if (data.plannedOrderNumber && data.referenceType === "MonthlyProductionPlan" && monthlyPlanRelease) {
          await syncPlannedOrderFromMonthlyPlanRelease(
            tx,
            monthlyProductionPlanDetail,
            monthlyPlanRelease.status,
            moNumber,
          );
          if (monthlyPlanRelease.status === "Released") {
            await createMoPeggingsFromPlannedOrder(tx, data.plannedOrderNumber, moNumber);
          }
        } else if (data.plannedOrderNumber) {
          await syncDirectPlannedOrderRelease(tx, data.plannedOrderNumber);
          await createMoPeggingsFromPlannedOrder(tx, data.plannedOrderNumber, moNumber);
        }

        await syncAffectedSalesOrdersForMo(tx, {
          moNumber,
          plannedOrderNumber: data.plannedOrderNumber || null,
        });

        docs.push(await tx.manufacturingOrder.findUnique({
          where: { id: mo.id },
          include: {
            part: { select: { partCode: true, partNumber: true, partName: true } },
            uom: { select: { uomCode: true, uomName: true } },
            ...moSourceInclude,
          },
        }));
      }

      return docs;
    });

    emitManufacturingOrderBulkUpdate(created, "create", req.user?.username || "system");
    res.status(201).json({
      items: created.map(mapDoc),
      total: created.length,
      skippedItems,
      skippedCount: skippedItems.length,
      message: skippedItems.length
        ? `${created.length} MO FG parent dibuat; ${skippedItems.length} line child/process dijalankan melalui routing parent.`
        : `${created.length} MO FG parent dibuat.`,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ message: e.message });
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ message: PO_NUMBER_CONFLICT });
    }
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const {
      plannedStartDate,
      plannedEndDate,
      actualStartDate: _actualStartDate,
      actualEndDate: _actualEndDate,
      qtyProduced: _qtyProduced,
      qtyGood: _qtyGood,
      qtyReject: _qtyReject,
      ...data
    } = req.body;

    const updateData = { ...stripSourceWipAllocationFields(data) };
    if (Array.isArray(req.body?.sourceWipAllocations)) {
      updateData.sourceWipAllocations = req.body.sourceWipAllocations;
    }
    if (
      data.referenceType !== undefined ||
      data.plannedOrderNumber !== undefined ||
      data.soNumber !== undefined
    ) {
      Object.assign(updateData, normalizeMoReferenceInput(data));
    }
    delete updateData.soNumber;
    delete updateData.qtyProduced;
    delete updateData.qtyGood;
    delete updateData.qtyReject;
    if (plannedStartDate !== undefined) updateData.plannedStartDate = plannedStartDate ? new Date(plannedStartDate) : null;
    if (plannedEndDate !== undefined) updateData.plannedEndDate = plannedEndDate ? new Date(plannedEndDate) : null;

    const existing = await prisma.manufacturingOrder.findUnique({
      where: { moNumber: req.params.moNumber },
      select: {
        moNumber: true,
        inputSourceType: true,
        sourceStockBalanceId: true,
        sourceWarehouseCode: true,
        sourceRackCode: true,
        sourceLotNumber: true,
        sourcePartCode: true,
        sourcePartNumber: true,
        sourcePartName: true,
        sourceStockType: true,
        sourceQtyPlanned: true,
        qtyPlanned: true,
      },
    });
    if (!existing) {
      return res.status(404).json({ message: "Data Manufacturing Order tidak ditemukan." });
    }

    const doc = await prisma.$transaction(async (tx) => {
      updateData.currentMoNumber = existing.moNumber;
      let normalizedSourceWipAllocations = null;
      if (
        Array.isArray(updateData.sourceWipAllocations)
        || hasMoInputSourceChanged(existing, updateData)
      ) {
        Object.assign(updateData, await normalizeMoInputSource(tx, updateData));
        normalizedSourceWipAllocations = updateData.sourceWipAllocationsNormalized || [];
      } else if (existing.inputSourceType === "WIP_STOCK") {
        Object.assign(updateData, {
          inputSourceType: existing.inputSourceType,
          sourceStockBalanceId: existing.sourceStockBalanceId,
          sourceWarehouseCode: existing.sourceWarehouseCode,
          sourceRackCode: existing.sourceRackCode,
          sourceLotNumber: existing.sourceLotNumber,
          sourcePartCode: existing.sourcePartCode,
          sourcePartNumber: existing.sourcePartNumber,
          sourcePartName: existing.sourcePartName,
          sourceStockType: existing.sourceStockType,
          sourceQtyPlanned: existing.sourceQtyPlanned,
        });
      } else if (
        updateData.inputSourceType !== undefined
        || updateData.sourceWipAllocations !== undefined
      ) {
        Object.assign(updateData, await normalizeMoInputSource(tx, updateData));
        normalizedSourceWipAllocations = updateData.sourceWipAllocationsNormalized || [];
      }
      const sanitizedUpdateData = stripSourceWipAllocationFields(updateData);
      const updated = await tx.manufacturingOrder.update({
        where: { moNumber: req.params.moNumber },
        data: sanitizedUpdateData,
        include: {
          part: { select: { partCode: true, partNumber: true, partName: true } },
          uom: { select: { uomCode: true, uomName: true } },
          ...moSourceInclude,
        },
      });
      if (normalizedSourceWipAllocations) {
        await syncManufacturingOrderSourceWipAllocations(tx, updated, normalizedSourceWipAllocations);
      }
      return tx.manufacturingOrder.findUnique({
        where: { id: updated.id },
        include: {
          part: { select: { partCode: true, partNumber: true, partName: true } },
          uom: { select: { uomCode: true, uomName: true } },
          ...moSourceInclude,
        },
      });
    });

    res.json(mapDoc(doc));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ message: e.message });
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return res.status(404).json({ message: "Data Manufacturing Order tidak ditemukan." });
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ message: PO_NUMBER_CONFLICT });
    }
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const existing = await prisma.manufacturingOrder.findUnique({
      where: { moNumber: req.params.moNumber },
      select: {
        id: true,
        moNumber: true,
        referenceType: true,
        plannedOrderNumber: true,
        monthlyProductionPlanNumber: true,
        monthlyProductionPlanLineNumber: true,
        qtyPlanned: true,
        isDeleted: true,
        status: true,
      },
    });

    if (!existing) return res.status(404).json({ message: "Data Manufacturing Order tidak ditemukan." });
    if (existing.isDeleted) return res.status(409).json({ message: PO_ALREADY_DELETED });
    if (!MO_DELETABLE_STATUSES.includes(existing.status)) {
      return res.status(409).json({
        message: `MO status "${existing.status}" tidak bisa dihapus. Delete hanya untuk Draft, Planned, Released, atau Cancelled tanpa aktivitas produksi.`,
      });
    }

    const blockers = await getMoDeleteBlockers(prisma, existing);
    if (blockers.length > 0) {
      return res.status(409).json({
        message: `MO tidak bisa dihapus karena sudah punya data terkait: ${formatRelationList(blockers)}. Gunakan cancel jika belum ada transaksi produksi.`,
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const rolledBackMonthlyPlan = await rollbackMonthlyProductionPlanForMo(tx, existing);
      if (!rolledBackMonthlyPlan) await rollbackPlannedOrderForMo(tx, existing);
      await releaseReservationsForMO(tx, existing.moNumber, "Cancelled");
      await deleteInactiveMoChildren(tx, existing);

      const deleted = await tx.manufacturingOrder.updateMany({
        where: { id: existing.id, isDeleted: false },
        data: { isDeleted: true },
      });
      await syncAffectedSalesOrdersForMo(tx, existing);
      return deleted;
    });

    if (result.count === 0) return res.status(409).json({ message: PO_ALREADY_DELETED });
    const removedMo = await prisma.manufacturingOrder.findUnique({
      where: { id: existing.id },
    });
    emitManufacturingOrderUpdate(removedMo, "delete", req.user?.username || "system");
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
};

exports.bulkRemove = async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids array required" });
    }

    const candidates = await prisma.manufacturingOrder.findMany({
      where: { id: { in: ids }, isDeleted: false, status: { in: MO_DELETABLE_STATUSES } },
      select: {
        id: true,
        moNumber: true,
        referenceType: true,
        plannedOrderNumber: true,
        monthlyProductionPlanNumber: true,
        monthlyProductionPlanLineNumber: true,
        qtyPlanned: true,
        status: true,
      },
    });

    const deletableMOs = [];
    const skipped = [];
    for (const mo of candidates) {
      const blockers = await getMoDeleteBlockers(prisma, mo);
      if (blockers.length > 0) {
        skipped.push({ moNumber: mo.moNumber, reason: formatRelationList(blockers) });
      } else {
        deletableMOs.push(mo);
      }
    }

    if (deletableMOs.length === 0) {
      return res.status(409).json({
        message: "Tidak ada MO yang bisa dihapus. MO hanya bisa dihapus jika Draft/Planned/Released/Cancelled dan belum punya aktivitas produksi terkait.",
        skipped,
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      for (const mo of deletableMOs) {
        const rolledBackMonthlyPlan = await rollbackMonthlyProductionPlanForMo(tx, mo);
        if (!rolledBackMonthlyPlan) await rollbackPlannedOrderForMo(tx, mo);
        await releaseReservationsForMO(tx, mo.moNumber, "Cancelled");
        await deleteInactiveMoChildren(tx, mo);
      }

      const updated = await tx.manufacturingOrder.updateMany({
        where: { id: { in: deletableMOs.map((m) => m.id) }, isDeleted: false },
        data: { isDeleted: true },
      });
      for (const mo of deletableMOs) {
        await syncAffectedSalesOrdersForMo(tx, mo);
      }
      return updated;
    });

    const removedItems = await prisma.manufacturingOrder.findMany({
      where: { id: { in: deletableMOs.map((mo) => mo.id) } },
    });
    emitManufacturingOrderBulkUpdate(removedItems, "delete", req.user?.username || "system");

    res.json({ deletedCount: result.count, skipped });
  } catch (e) {
    next(e);
  }
};

// ============================================================
// HELPER ROUTES
// ============================================================

exports.generateNumber = async (req, res, next) => {
  try {
    const moNumber = await generateMoNumber();
    res.json({ moNumber });
  } catch (e) {
    next(e);
  }
};

exports.autocomplete = async (req, res, next) => {
  try {
    const { q, status, partId } = req.query;
    const where = { isDeleted: false };
    if (status) where.status = status;
    if (partId) where.partId = partId;
    if (q) {
      where.OR = [
        { moNumber: { contains: q, mode: "insensitive" } },
        { part: { partCode: { contains: q, mode: "insensitive" } } },
      ];
    }
    const items = await prisma.manufacturingOrder.findMany({
      where,
      take: 20,
      orderBy: { moDate: "desc" },
      select: {
        id: true, moNumber: true, status: true,
        qtyPlanned: true, qtyProduced: true,
        part: { select: { partCode: true, partName: true } },
      },
    });
    res.json(items.map(mapDoc));
  } catch (e) {
    next(e);
  }
};

// ============================================================
// GENERATE WORK ORDERS DARI MBOM PROCESS ROUTING
// ============================================================

// POST /:moNumber/generate-work-orders — Buat WO otomatis dari MBOM process routing
exports.generateWorkOrders = async (req, res, next) => {
  try {
    const existing = await prisma.manufacturingOrder.findUnique({
      where: { moNumber: req.params.moNumber },
      include: {
        part: { select: { id: true, partCode: true, partName: true } },
        workOrders: { where: { isDeleted: false }, select: { id: true } },
        sourceStockBalance: { select: sourceStockBalanceSelect },
      },
    });
    if (!existing || existing.isDeleted) return res.status(404).json({ message: "Data Manufacturing Order tidak ditemukan." });
    if (!existing.partId) return res.status(400).json({ message: "MO tidak memiliki part, tidak bisa generate routing." });
    if (existing.status !== "Released") {
      return res.status(409).json({
        message: `MO harus Release dulu sebelum generate Work Orders. Status sekarang "${existing.status}".`,
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      let startSequence = null;
      if (existing.inputSourceType === "WIP_STOCK") {
        const noteSequence = readWipDerivedStartSequence(existing);
        if (normalizeSequence(noteSequence)) {
          startSequence = normalizeSequence(noteSequence);
        } else {
          const [inHouseRouting, vendorRouting] = await Promise.all([
            getRoutingOperations(tx, existing),
            getVendorRoutingOperations(tx, existing),
          ]);
          startSequence = findStartSequenceFromCombinedRouting(
            existing.sourcePartCode || existing.sourceStockBalance?.partCode || null,
            inHouseRouting?.operations || [],
            vendorRouting?.operations || [],
          );
        }
        if (!normalizeSequence(startSequence)) {
          throw new Error("Start sequence untuk MO source WIP tidak dapat ditentukan dari routing MBOM.");
        }
      }
      let workOrders = [];
      try {
        workOrders = await generateWorkOrdersFromRouting(tx, existing, {
          status: "Planned",
          startSequence,
        });
      } catch (err) {
        if (!err.message?.includes("Tidak ada routing process inHouse")) {
          throw err;
        }
      }
      const vendorProcessOrders = await generateVendorProcessOrdersFromRouting(tx, existing, {
        createdBy: req.user?.username || req.user?.email || null,
        startSequence,
      });
      if (workOrders.length === 0 && vendorProcessOrders.created.length === 0 && vendorProcessOrders.existing.length === 0) {
        throw new Error("Tidak ada routing inHouse atau Vendor di MBOM untuk digenerate.");
      }
      const vendorRoutingOrders = [
        ...vendorProcessOrders.created,
        ...vendorProcessOrders.existing,
      ];
      const coveredPlannedOrders = await coverDependentInHousePlannedOrdersForWorkOrders(
        tx,
        existing,
        workOrders,
        vendorRoutingOrders,
      );
      return { workOrders, vendorProcessOrders, coveredPlannedOrders };
    });

    emitWorkOrderBulkUpdate(result.workOrders, "create", req.user?.username || "system");
    if (result.coveredPlannedOrders.length > 0) {
      emitPlanningPlannedOrderBulkUpdate(
        result.coveredPlannedOrders,
        "cover",
        req.user?.username || "system",
      );
    }

    res.status(201).json({
      message: `Berhasil generate ${result.workOrders.length} Work Order dan ${result.vendorProcessOrders.created.length} Vendor Process Order dari MBOM routing. ${result.coveredPlannedOrders.length} child planned order ditandai Covered.`,
      redirectPath: `/production/work-orders?moNumber=${encodeURIComponent(existing.moNumber)}`,
      workOrders: result.workOrders.map(mapDoc),
      coveredPlannedOrders: result.coveredPlannedOrders.map(mapDoc),
      vendorProcessOrders: {
        ...result.vendorProcessOrders,
        created: result.vendorProcessOrders.created.map(mapDoc),
        existing: result.vendorProcessOrders.existing.map(mapDoc),
      },
    });
  } catch (e) {
    if (
      e.message?.includes("MO sudah memiliki Work Order") ||
      e.message?.includes("MBOM aktif tidak ditemukan") ||
      e.message?.includes("Tidak ada routing") ||
      e.message?.includes("Start sequence untuk MO source WIP")
    ) {
      return res.status(409).json({ message: e.message });
    }
    next(e);
  }
};

// ============================================================
// STATUS TRANSITION ACTIONS
// ============================================================

// Draft/Planned → Released (+ availability check, reservation)
exports.release = async (req, res, next) => {
  try {
    const {
      allowShortage = false,
      skipReservation = false,
      allocationStrategy,
      manualAllocations = [],
      requirementUomMode,
    } = req.body || {};
    const existing = await prisma.manufacturingOrder.findUnique({
      where: { moNumber: req.params.moNumber },
      include: {
        part: { select: { id: true, partCode: true } },
      },
    });
    if (!existing || existing.isDeleted) return res.status(404).json({ message: "Data Manufacturing Order tidak ditemukan." });

    const result = await prisma.$transaction(async (tx) => {
      const released = await releaseManufacturingOrder(tx, existing, {
        allowShortage,
        skipReservation,
        allocationStrategy,
        manualAllocations,
        requirementUomMode,
      });
      await syncAffectedSalesOrdersForMo(tx, existing);
	      return released;
	    });

	    emitManufacturingOrderUpdate(result.manufacturingOrder, "release", req.user?.username || "system");

	    res.json({
      manufacturingOrder: mapDoc(result.manufacturingOrder),
      availability: result.availability,
      generatedWorkOrders: result.workOrders.map(mapDoc),
      generatedVendorProcessOrders: { created: [], existing: [] },
      nextAction: "GENERATE_WORK_ORDERS",
    });
  } catch (e) {
    if (
      e.message?.includes("tidak bisa direlease") ||
      e.message?.includes("Material belum cukup") ||
      e.message?.includes("MBOM aktif tidak ditemukan") ||
      e.message?.includes("Tidak ada routing")
    ) {
      return res.status(409).json({ message: e.message });
    }
    next(e);
  }
};

// Released → In Progress
exports.start = async (req, res, next) => {
  try {
    const existing = await prisma.manufacturingOrder.findUnique({
      where: { moNumber: req.params.moNumber },
    });
    if (!existing || existing.isDeleted) return res.status(404).json({ message: "Data Manufacturing Order tidak ditemukan." });

    const doc = await prisma.$transaction(async (tx) => {
      const updated = await startManufacturingOrder(tx, existing);
      await syncAffectedSalesOrdersForMo(tx, existing);
      await syncMonthlyProductionPlanDetailCompletion(
        tx,
        updated,
        req.user?.username || "system",
      );
      await closeMonthlyProductionPlanIfAllMosCompleted(
        tx,
        existing.monthlyProductionPlanNumber,
        req.user?.username || "system",
      );
      return updated;
    });

	    emitManufacturingOrderUpdate(doc, "start", req.user?.username || "system");
    res.json(mapDoc(doc));
  } catch (e) {
    if (
      e.message?.includes("harus Release") ||
      e.message?.includes("belum punya Work Order")
    ) {
      return res.status(409).json({ message: e.message });
    }
    next(e);
  }
};

// In Progress → Completed (validasi WO/material/QC + FG receipt)
exports.complete = async (req, res, next) => {
  try {
    const {
      warehouseCode,
      rackCode,
      lotNumber,
      qtyProduced,
      qtyGood,
      qtyReject,
      allowIncompleteWorkOrders = false,
      allowOpenMaterialIssues = false,
      allowOpenQc = false,
      allowRejectedQc = false,
      allowZeroGood = false,
      allowUnderPlannedQty = false,
      receiveFinishedGoods = false,
    } = req.body || {};
    const existing = await prisma.manufacturingOrder.findUnique({
      where: { moNumber: req.params.moNumber },
      include: {
        part: {
          select: {
            id: true,
            partCode: true,
            partNumber: true,
            partName: true,
            material: { select: { spec: true } },
            partBases: {
              orderBy: { createdAt: "asc" },
              select: { baseOn: true, thickness: true, width: true, CSP: true },
            },
          },
        },
        uom: { select: { uomCode: true, uomName: true } },
      },
    });
    if (!existing || existing.isDeleted) return res.status(404).json({ message: "Data Manufacturing Order tidak ditemukan." });

    const doc = await prisma.$transaction(async (tx) => {
      const updated = await completeManufacturingOrder(tx, existing, {
        qtyProduced,
        qtyGood,
        qtyReject,
        allowIncompleteWorkOrders,
        allowOpenMaterialIssues,
        allowOpenQc,
        allowRejectedQc,
        allowZeroGood,
        allowUnderPlannedQty,
        receiveFinishedGoods,
        stockTarget: { warehouseCode, rackCode, lotNumber },
        performedBy: req.user?.username || "system",
      });
      await syncMonthlyProductionPlanDetailCompletion(
        tx,
        updated,
        req.user?.username || "system",
      );
      if (existing.parentMoNumber) {
        const parentMo = await tx.manufacturingOrder.findUnique({
          where: { moNumber: existing.parentMoNumber },
          select: { id: true, isDeleted: true },
        });
        if (parentMo && !parentMo.isDeleted) {
          await syncManufacturingOrderQtyFromWorkOrders(tx, parentMo.id);
        }
      }
      await syncAffectedSalesOrdersForMo(tx, existing);
      return updated;
    });

    res.json(mapDoc(doc));
  } catch (e) {
    if (
      e.message?.includes("tidak bisa complete") ||
      e.message?.includes("belum punya Work Order") ||
      e.message?.includes("Masih ada") ||
      e.message?.includes("Qty good") ||
      e.message?.includes("Qty OK/FG akhir")
    ) {
      return res.status(409).json({ message: e.message });
    }
    next(e);
  }
};

// ============================================================
// AVAILABILITY CHECK — cek ketersediaan material MBOM vs stok aktual
// GET /:moNumber/availability-check
// Response: { moNumber, qtyPlanned, mbomNumber, isAvailable, summary, items[] }
// ============================================================
exports.availabilityCheck = async (req, res, next) => {
  try {
    const { woId, allocationStrategy, requirementUomMode } = req.query;
    const mo = await prisma.manufacturingOrder.findUnique({
      where: { moNumber: req.params.moNumber },
      select: {
        id: true,
        partId: true,
        qtyPlanned: true,
        status: true,
        moNumber: true,
        plannedOrderNumber: true,
        inputSourceType: true,
        sourceStockBalanceId: true,
        sourceWarehouseCode: true,
        sourceRackCode: true,
        sourceLotNumber: true,
        sourcePartCode: true,
        sourcePartNumber: true,
        sourcePartName: true,
        sourceQtyPlanned: true,
        materialRequirementUomMode: true,
        isDeleted: true,
      },
    });
    if (!mo || mo.isDeleted) return res.status(404).json({ message: "Data Manufacturing Order tidak ditemukan." });
    if (!mo.partId) return res.status(400).json({ message: "MO tidak memiliki part, tidak bisa cek ketersediaan." });

    const availability = await buildAvailability(prisma, mo, {
      allocationStrategy,
      requirementUomMode,
    });
    if (mo.inputSourceType !== "WIP_STOCK" && !availability.mbomHeader) {
      return res.status(404).json({ message: "MBOM aktif tidak ditemukan untuk part ini." });
    }

    let scopedItems = availability.items;
    let scopedWorkOrder = null;
    if (woId) {
      scopedWorkOrder = await prisma.workOrder.findFirst({
        where: {
          id: String(woId),
          moId: mo.id,
          isDeleted: false,
        },
        select: {
          id: true,
          woNumber: true,
          mbomDetail: {
            select: {
              part: {
                select: {
                  partCode: true,
                  partNumber: true,
                  partName: true,
                },
              },
            },
          },
        },
      });
      if (!scopedWorkOrder) {
        return res.status(404).json({ message: "Work Order tidak ditemukan untuk MO ini." });
      }

      const operationPartCode = scopedWorkOrder.mbomDetail?.part?.partCode || null;
      scopedItems = operationPartCode
        ? availability.items.filter((item) => item.consumedByPartCode === operationPartCode)
        : [];
    }

    res.json({
      moNumber: mo.moNumber,
      qtyPlanned: mo.qtyPlanned,
      mbomNumber: availability.mbomHeader?.noReg || null,
      revision: availability.mbomHeader?.revision || null,
      warehouseCode: availability.warehouseCode,
      warehouseCodes: availability.warehouseCodes,
      workOrder: scopedWorkOrder,
      items: scopedItems,
      summary: {
        total: scopedItems.length,
        sufficient: scopedItems.filter((item) => item.isSufficient).length,
        shortage: scopedItems.filter((item) => !item.isSufficient).length,
        ...(availability.summary || {}),
      },
      isAvailable: scopedItems.every((item) => item.isSufficient),
    });
  } catch (e) { next(e); }
};

// Draft / Planned / Released / pre-execution In Progress -> Cancelled
exports.cancel = async (req, res, next) => {
  try {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) {
      return res.status(400).json({ message: "Alasan cancel MO wajib diisi." });
    }

    const existing = await prisma.manufacturingOrder.findUnique({
      where: { moNumber: req.params.moNumber },
      select: {
        id: true,
        isDeleted: true,
        status: true,
        moNumber: true,
        plannedOrderNumber: true,
        monthlyProductionPlanNumber: true,
        monthlyProductionPlanLineNumber: true,
        qtyPlanned: true,
      },
    });
    if (!existing || existing.isDeleted) return res.status(404).json({ message: "Data Manufacturing Order tidak ditemukan." });
    if (existing.status === "Completed") {
      return res.status(409).json({ message: "MO yang sudah selesai tidak bisa dibatalkan." });
    }
    if (existing.status === "Cancelled") {
      return res.status(409).json({ message: "MO sudah berstatus Cancelled." });
    }

    const blockers = await getMoCancelBlockers(prisma, existing);
    if (blockers.length > 0) {
      return res.status(409).json({
        message: `MO tidak bisa dibatalkan otomatis karena sudah ada aktivitas produksi. ${formatRelationList(blockers)}.`,
      });
    }

    const doc = await prisma.$transaction(async (tx) => {
      const cancelledWorkOrders = await tx.workOrder.updateMany({
        where: {
          moId: existing.id,
          isDeleted: false,
          status: { in: ["Draft", "Planned", "Released"] },
        },
        data: { status: "Cancelled", notes: reason },
      });

      const cancelledVendorProcessOrders = await tx.vendorProcessOrder.updateMany({
        where: {
          moId: existing.id,
          isDeleted: false,
          status: { in: MO_CHILD_DELETABLE_VENDOR_ORDER_STATUSES },
        },
        data: { status: "Cancelled", notes: reason },
      });

      const cancelledMaterialIssues = await tx.materialIssue.updateMany({
        where: {
          moId: existing.id,
          isDeleted: false,
          status: "Draft",
        },
        data: { status: "Cancelled", notes: reason },
      });

      const updated = await tx.manufacturingOrder.update({
        where: { id: existing.id },
        data: { status: "Cancelled", notes: reason },
      });

      // Release semua reservasi material yang terkait MO
      await releaseReservationsForMO(tx, existing.moNumber, "Cancelled");

      // Jika MO berasal dari MPP, buka kembali line MPP. Kalau bukan MPP, rollback planned order langsung.
      const rolledBackMonthlyPlan = await rollbackMonthlyProductionPlanForMo(tx, existing);
      if (!rolledBackMonthlyPlan && existing.plannedOrderNumber) {
        await syncDirectPlannedOrderRelease(tx, existing.plannedOrderNumber);
      }

      await syncAffectedSalesOrdersForMo(tx, existing);

	      return { updated, cancelledWorkOrders, cancelledVendorProcessOrders, cancelledMaterialIssues };
	    });

	    const cancelledWorkOrders = await prisma.workOrder.findMany({
	      where: { moId: existing.id, isDeleted: false, status: "Cancelled" },
	    });
	    emitManufacturingOrderUpdate(doc.updated, "cancel", req.user?.username || "system");
	    emitWorkOrderBulkUpdate(cancelledWorkOrders, "cancel", req.user?.username || "system");

	    res.json({
      ...mapDoc(doc.updated),
      automation: {
        cancelledWorkOrders: doc.cancelledWorkOrders.count,
        cancelledVendorProcessOrders: doc.cancelledVendorProcessOrders.count,
        cancelledMaterialIssues: doc.cancelledMaterialIssues.count,
      },
    });
  } catch (e) { next(e); }
};

