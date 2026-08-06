const { prisma } = require("../../index");
const { Prisma } = require("@prisma/client");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { generateMovementNumber } = require("../../utils/movementNumberGenerator");
const { parseFilter } = require("../../utils/parseFilter");
const { incrementDiesShotCounter } = require("../../utils/diesShotCounter");
const { createWIPEntry } = require("./WIPController");
const { assertStockBalanceNotFrozen } = require("../inventory/utils/stockOpnameFreezeGuard");
const {
  syncManufacturingOrderQtyFromWorkOrders,
} = require("./services/productionWorkflowService");
const {
  emitManufacturingOrderUpdate,
} = require("./services/productionRealtimeService");
const {
  syncOperationalSalesOrderStatus,
} = require("../../services/production/sales-order/soStatusService");
const { generateDailyNumber } = require("./services/productionIntegrationHelpers");
const { assertQuantity } = require("../../utils/uomQuantity");

// Generate nomor Inspeksi QC otomatis: QC-YYYYMMDD-001
async function generateQcNumber() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const datePrefix = `QC-${y}${m}${d}`;

  const last = await prisma.qualityInspection.findFirst({
    where: { inspectionNumber: { startsWith: datePrefix } },
    orderBy: { inspectionNumber: "desc" },
    select: { inspectionNumber: true },
  });

  let seq = 1;
  if (last) {
    const parts = last.inspectionNumber.split("-");
    seq = parseInt(parts[parts.length - 1], 10) + 1;
  }

  return `${datePrefix}-${String(seq).padStart(3, "0")}`;
}

function formatRelationList(items) {
  return items.filter(Boolean).join(", ");
}

function formatQtyWithUom(qty, uomCode) {
  return [qty, uomCode].filter((value) => value !== null && value !== undefined && value !== "").join(" ");
}

function parseSoNumberFromLineReference(referenceNumber) {
  const match = String(referenceNumber || "").match(/^(.*)#\d+$/);
  return match?.[1] || null;
}

async function syncSalesOrdersForManufacturingOrder(tx, moLike = {}) {
  const moNumberSet = new Set(
    [
      moLike?.moNumber,
      moLike?.parentMoNumber,
      moLike?.rootMoNumber,
    ].filter(Boolean),
  );
  const plannedOrderNumberSet = new Set(
    [
      moLike?.plannedOrderNumber,
      moLike?.sourcePlannedOrderNumber,
    ].filter(Boolean),
  );
  const impactedSalesOrderNumbers = new Set();

  for (let i = 0; i < 5; i += 1) {
    const moNumbers = [...moNumberSet];
    const plannedOrderNumbers = [...plannedOrderNumberSet];
    if (moNumbers.length === 0 && plannedOrderNumbers.length === 0) break;

    const relatedMos = await tx.manufacturingOrder.findMany({
      where: {
        isDeleted: false,
        OR: [
          ...(moNumbers.length > 0
            ? [
                { moNumber: { in: moNumbers } },
                { parentMoNumber: { in: moNumbers } },
                { rootMoNumber: { in: moNumbers } },
              ]
            : []),
          ...(plannedOrderNumbers.length > 0
            ? [{ plannedOrderNumber: { in: plannedOrderNumbers } }]
            : []),
        ],
      },
      select: {
        moNumber: true,
        parentMoNumber: true,
        rootMoNumber: true,
        plannedOrderNumber: true,
      },
    });

    let changed = false;
    for (const mo of relatedMos) {
      for (const moNumber of [mo.moNumber, mo.parentMoNumber, mo.rootMoNumber].filter(Boolean)) {
        if (!moNumberSet.has(moNumber)) {
          moNumberSet.add(moNumber);
          changed = true;
        }
      }
      if (mo.plannedOrderNumber && !plannedOrderNumberSet.has(mo.plannedOrderNumber)) {
        plannedOrderNumberSet.add(mo.plannedOrderNumber);
        changed = true;
      }
    }

    if (!changed) break;
  }

  const moNumbers = [...moNumberSet];
  const plannedOrderNumbers = [...plannedOrderNumberSet];

  if (moNumbers.length > 0 || plannedOrderNumbers.length > 0) {
    const peggings = await tx.mRPPegging.findMany({
      where: {
        demandType: "SO",
        status: "Active",
        OR: [
          ...(moNumbers.length > 0
            ? [{ supplyType: "MO", supplyNumber: { in: moNumbers } }]
            : []),
          ...(plannedOrderNumbers.length > 0
            ? [{ supplyType: "PlannedOrder", supplyNumber: { in: plannedOrderNumbers } }]
            : []),
        ],
      },
      select: { demandNumber: true },
    });

    for (const pegging of peggings) {
      if (pegging.demandNumber) impactedSalesOrderNumbers.add(pegging.demandNumber);
    }
  }

  if (plannedOrderNumbers.length > 0) {
    const plannedOrders = await tx.plannedOrder.findMany({
      where: {
        orderNumber: { in: plannedOrderNumbers },
        isDeleted: false,
        referenceType: "SO",
      },
      select: { referenceNumber: true },
    });

    for (const plannedOrder of plannedOrders) {
      const soNumber = parseSoNumberFromLineReference(plannedOrder.referenceNumber);
      if (soNumber) impactedSalesOrderNumbers.add(soNumber);
    }
  }

  const syncedSalesOrders = [];
  for (const soNumber of impactedSalesOrderNumbers) {
    const syncedSo = await syncOperationalSalesOrderStatus(tx, soNumber);
    if (syncedSo) syncedSalesOrders.push(syncedSo);
  }

  return syncedSalesOrders;
}

function getProductionLogQcHoldQty(log = {}) {
  return Number(log.qtyGood || 0);
}

function getProductionLogNgQty(log = {}) {
  return Number(log.qtyReject || 0);
}

function getQualityInspectionTotalNgQty(inspection = {}) {
  return getProductionLogNgQty(inspection.productionLog || {}) + Number(inspection.qtyFailed || 0);
}

async function getVendorProcessRemainingQcQty(tx, vendorProcessOrderId, excludeInspectionId = null) {
  if (!vendorProcessOrderId) return 0;

  const order = await tx.vendorProcessOrder.findFirst({
    where: { id: vendorProcessOrderId, isDeleted: false },
    select: { qtyReceived: true },
  });
  if (!order) return 0;

  const inspected = await tx.qualityInspection.aggregate({
    where: {
      vendorProcessOrderId,
      isDeleted: false,
      ...(excludeInspectionId ? { id: { not: excludeInspectionId } } : {}),
    },
    _sum: { qtyInspected: true },
  });

  return Math.max(0, Number(order.qtyReceived || 0) - Number(inspected._sum.qtyInspected || 0));
}

async function getProductionLogRemainingQcQty(tx, productionLogId, excludeInspectionId = null) {
  if (!productionLogId) return 0;

  const log = await tx.productionLog.findFirst({
    where: { id: productionLogId, isDeleted: false },
    select: { qtyGood: true, qtyReject: true, qtyRework: true },
  });
  if (!log) return 0;

  const inspected = await tx.qualityInspection.aggregate({
    where: {
      productionLogId,
      isDeleted: false,
      ...(excludeInspectionId ? { id: { not: excludeInspectionId } } : {}),
    },
    _sum: { qtyInspected: true },
  });

  const qcHoldQty = getProductionLogQcHoldQty(log);
  const inspectedQty = Number(inspected._sum.qtyInspected || 0);
  return Math.max(0, qcHoldQty - inspectedQty);
}

function validateQualityInspectionQty(data, options = {}) {
  const qtyInspected = Number(data.qtyInspected || 0);
  const qtyPassed = Number(data.qtyPassed || 0);
  const qtyFailed = Number(data.qtyFailed || 0);
  const sampleSize = Number(data.sampleSize || 0);
  const sourceQty = Number(options.sourceQty || 0);
  const hasSourceQty = Boolean(options.hasSourceQty) || sourceQty > 0;
  const uomCode = options.uomCode || null;

  if (qtyInspected > 0 && qtyPassed + qtyFailed !== qtyInspected) {
    const classifiedQty = qtyPassed + qtyFailed;
    const remaining = qtyInspected - classifiedQty;
    const remainingText = remaining > 0
      ? `Masih ada ${formatQtyWithUom(remaining, uomCode)} yang belum diklasifikasikan.`
      : `OK + NG kelebihan ${formatQtyWithUom(Math.abs(remaining), uomCode)}.`;
    const error = new Error(
      `Qty inspeksi harus dibagi ke OK dan NG. Total inspected ${qtyInspected}, OK ${qtyPassed}, NG ${qtyFailed}. ${remainingText}`
    );
    error.statusCode = 400;
    throw error;
  }

  if (sampleSize > 0 && qtyInspected > 0 && sampleSize > qtyInspected) {
    const error = new Error(`Sample size tidak boleh lebih besar dari qty yang diinspeksi. Sample ${sampleSize}, inspected ${qtyInspected}.`);
    error.statusCode = 400;
    throw error;
  }

  if (qtyInspected > 0 && hasSourceQty && qtyInspected > sourceQty) {
    const error = new Error(`Qty inspected tidak boleh lebih besar dari sisa QC Hold. Maksimal ${sourceQty}.`);
    error.statusCode = 400;
    throw error;
  }
}

function calculateDecision(data = {}) {
  const qtyInspected = Number(data.qtyInspected || 0);
  const qtyPassed = Number(data.qtyPassed || 0);
  const qtyFailed = Number(data.qtyFailed || 0);

  if (qtyInspected <= 0) return "Pending";
  if (qtyFailed <= 0 && qtyPassed > 0) return "Accepted";
  if (qtyFailed > 0 && qtyPassed <= 0) return "Rejected";
  if (qtyPassed > 0 && qtyFailed > 0) return "Conditional Accept";
  return "Pending";
}

function roundCost(value) {
  return Math.round(Number(value || 0) * 1000000) / 1000000;
}

function normalizeRateType(value) {
  return String(value || "PER_HOUR").trim().toUpperCase();
}

function toMachineRatePerSecond(rate, rateType) {
  const numericRate = Number(rate || 0);
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

function getLogDurationMinutes(log = {}) {
  if (Number(log.runningMinutes || 0) > 0)
    return Number(log.runningMinutes || 0);
  if (!log.startTime || !log.endTime)
    return 0;

  const start = new Date(log.startTime).getTime();
  const end = new Date(log.endTime).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end))
    return 0;
  return Math.max(0, (end - start) / 60000);
}

async function getQualityInspectionDeleteBlockers(tx, inspection) {
  const fgReceiptCount = await tx.stockMovement.count({
    where: {
      referenceType: "QUALITY_INSPECTION",
      referenceNumber: inspection.inspectionNumber,
      transactionType: "PRODUCTION",
      movementType: "IN",
      stockType: "Finished Goods",
      isDeleted: false,
    },
  });

  return [
    fgReceiptCount > 0 && "FG Receipt",
  ].filter(Boolean);
}

function buildBalanceIdentityFromMovement(movement = {}) {
  return {
    partNumber: movement.partNumber || null,
    partName: movement.partName || null,
    productId: movement.productId || null,
    description: movement.description || null,
    spec: movement.spec || null,
    thickness: movement.thickness ?? null,
    width: movement.width ?? null,
    CSP: movement.CSP || null,
  };
}

async function findStockBalanceForMovement(tx, movement, location = {}) {
  if (!movement?.partCode || !location.warehouseCode) return null;
  return tx.stockBalance.findFirst({
    where: {
      warehouseCode: location.warehouseCode,
      rackCode: location.rackCode || null,
      lotNumber: location.lotNumber || null,
      partCode: movement.partCode,
      ...buildBalanceIdentityFromMovement(movement),
      uomCode: movement.uomCode || null,
      stockType: movement.stockType || null,
      isDeleted: false,
    },
    select: { id: true, qtyOnHand: true, qtyReserved: true, qtyQC: true },
  });
}

async function applyStockBalanceDelta(tx, balance, { qtyOnHandDelta = 0, qtyQcDelta = 0 }) {
  if (!balance || (qtyOnHandDelta === 0 && qtyQcDelta === 0)) return null;
  await assertStockBalanceNotFrozen(tx, balance.id);
  const qtyOnHand = Math.max(0, Number(balance.qtyOnHand || 0) + qtyOnHandDelta);
  const qtyQC = Math.max(0, Number(balance.qtyQC || 0) + qtyQcDelta);
  const qtyReserved = Number(balance.qtyReserved || 0);
  return tx.stockBalance.update({
    where: { id: balance.id },
    data: {
      qtyOnHand,
      qtyQC,
      qtyAvailable: Math.max(0, qtyOnHand - qtyReserved - qtyQC),
      lastMovement: new Date(),
    },
  });
}

async function rollbackQualityInspectionStock(tx, inspection) {
  const movements = await tx.stockMovement.findMany({
    where: {
      referenceType: "QUALITY_INSPECTION",
      referenceNumber: inspection.inspectionNumber,
      isDeleted: false,
    },
    orderBy: [{ createdAt: "desc" }],
  });

  const fgReceipt = movements.find(
    (movement) =>
      movement.transactionType === "PRODUCTION" &&
      movement.movementType === "IN" &&
      movement.stockType === "Finished Goods",
  );
  if (fgReceipt) {
    throw Object.assign(new Error("QC sudah punya FG Receipt, tidak bisa dihapus."), { statusCode: 409 });
  }

  const sourceReference = inspection.productionLog?.logNumber
    ? { referenceType: "PRODUCTION_LOG", referenceNumber: inspection.productionLog.logNumber }
    : inspection.vendorProcessOrder?.orderNumber
      ? { referenceType: "VENDOR_PROCESS_ORDER", referenceNumber: inspection.vendorProcessOrder.orderNumber }
      : null;
  const sourceMovement = sourceReference
    ? await tx.stockMovement.findFirst({
        where: {
          ...sourceReference,
          transactionType: "QC_HOLD",
          isDeleted: false,
        },
        orderBy: { createdAt: "desc" },
      })
    : null;
  const sourceBalance = sourceMovement
    ? await findStockBalanceForMovement(tx, sourceMovement, {
        warehouseCode: sourceMovement.warehouseCode,
        rackCode: sourceMovement.rackCode,
        lotNumber: sourceMovement.lotNumber,
      })
    : null;

  let sourceQtyOnHandDelta = 0;
  let sourceQtyQcDelta = 0;
  for (const movement of movements) {
    if (movement.transactionType === "PRODUCTION") continue;
    const qty = Number(movement.qty || 0);
    const deltaQty = Number(movement.deltaQty || 0);

    if (["QUALITY_RELEASE", "REJECT", "SCRAP", "REWORK"].includes(movement.transactionType)) {
      sourceQtyQcDelta += qty;
      if (deltaQty < 0) sourceQtyOnHandDelta += Math.abs(deltaQty);
    }

    if (
      ["QUALITY_RELEASE", "REJECT", "SCRAP"].includes(movement.transactionType) &&
      movement.destinationWarehouseCode &&
      deltaQty < 0
    ) {
      const targetBalance = await findStockBalanceForMovement(tx, movement, {
        warehouseCode: movement.destinationWarehouseCode,
        rackCode: movement.destinationRackCode,
        lotNumber: movement.lotNumber,
      });
      await applyStockBalanceDelta(tx, targetBalance, { qtyOnHandDelta: -qty });
    }
  }

  await applyStockBalanceDelta(tx, sourceBalance, {
    qtyOnHandDelta: sourceQtyOnHandDelta,
    qtyQcDelta: sourceQtyQcDelta,
  });

  if (movements.length > 0) {
    await tx.stockMovement.updateMany({
      where: { id: { in: movements.map((movement) => movement.id) } },
      data: { isDeleted: true },
    });
  }

  return { movementCount: movements.length };
}

function normalizeLocation(value = {}) {
  return {
    warehouseCode: typeof value.warehouseCode === "string" && value.warehouseCode.trim()
      ? value.warehouseCode.trim()
      : null,
    rackCode: typeof value.rackCode === "string" && value.rackCode.trim()
      ? value.rackCode.trim()
      : null,
    lotNumber: typeof value.lotNumber === "string" && value.lotNumber.trim()
      ? value.lotNumber.trim()
      : null,
  };
}

function isSameLocation(source, target) {
  return (
    (source?.warehouseCode || null) === (target?.warehouseCode || null) &&
    (source?.rackCode || null) === (target?.rackCode || null) &&
    (source?.lotNumber || null) === (target?.lotNumber || null)
  );
}

function buildDispositionTarget(source, value = {}) {
  const normalized = normalizeLocation(value);
  return {
    warehouseCode: normalized.warehouseCode || source.warehouseCode,
    rackCode: normalized.rackCode ?? source.rackCode ?? null,
    lotNumber: normalized.lotNumber ?? source.lotNumber ?? null,
  };
}

function hasExplicitQty(value) {
  return value && value.qty !== undefined && value.qty !== null && value.qty !== "";
}

function assertDispositionQtyMatches(label, allocatedQty, expectedQty) {
  if (Math.abs(Number(allocatedQty || 0) - Number(expectedQty || 0)) <= 0.000001) return;
  throw Object.assign(
    new Error(`${label} destination quantity must equal QC quantity.`),
    { statusCode: 400 }
  );
}

function buildMovementStockIdentity(source = {}) {
  return {
    partNumber: source.partNumber || null,
    partName: source.partName || null,
    productId: source.productId || null,
    description: source.description || null,
    spec: source.spec || null,
    thickness: source.thickness ?? null,
    width: source.width ?? null,
    CSP: source.CSP || null,
  };
}

function normalizePartBaseOn(value) {
  return String(value || "").trim().toUpperCase();
}

function getPreferredPartBase(part = {}) {
  const bases = Array.isArray(part.partBases) ? part.partBases : [];
  return (
    bases.find((base) => normalizePartBaseOn(base.baseOn) === "ACTUAL") ||
    bases.find((base) => ["QTN", "QUOTATION"].includes(normalizePartBaseOn(base.baseOn))) ||
    bases[0] ||
    {}
  );
}

function buildPartStockIdentity(part = {}) {
  const partBase = getPreferredPartBase(part);
  return {
    partNumber: part.partNumber || null,
    partName: part.partName || null,
    productId: null,
    description: null,
    spec: part.material?.spec || null,
    thickness: partBase.thickness ?? null,
    width: partBase.width ?? null,
    CSP: partBase.CSP || null,
  };
}

function buildMovementFromPart(sourceMovement, part) {
  if (!part?.partCode) return sourceMovement;
  return {
    ...sourceMovement,
    partCode: part.partCode,
    ...buildPartStockIdentity(part),
  };
}

async function isFinalProductionWorkOrder(tx, workOrder = {}, productionLog = {}) {
  if (!workOrder?.moId || workOrder.sequence === null || workOrder.sequence === undefined) {
    return false;
  }

  // MPP can publish parallel child routes whose local MBOM sequence is the
  // same. The allocation dependency graph, carried by the originating DPP,
  // is the authoritative way to identify the terminal output for FG receipt.
  let dpsId = productionLog?.dpsId || null;
  if (!dpsId && (productionLog?.id || productionLog?.logNumber)) {
    const persistedLog = await tx.productionLog.findFirst({
      where: productionLog.id ? { id: productionLog.id } : { logNumber: productionLog.logNumber },
      select: { dpsId: true },
    });
    dpsId = persistedLog?.dpsId || null;
  }
  if (dpsId) {
    const schedule = await tx.dailyProductionSchedule.findUnique({
      where: { id: dpsId },
      select: { productionPlanAllocationId: true },
    });
    if (schedule?.productionPlanAllocationId) {
      const allocation = await tx.productionPlanAllocation.findUnique({
        where: { id: schedule.productionPlanAllocationId },
        select: { id: true, planId: true },
      });
      if (allocation?.planId) {
        const siblings = await tx.productionPlanAllocation.findMany({
          where: { planId: allocation.planId, isDeleted: false, status: { not: "Cancelled" } },
          select: { predecessorAllocationIds: true },
        });
        return !siblings.some((candidate) =>
          Array.isArray(candidate.predecessorAllocationIds)
          && candidate.predecessorAllocationIds.includes(allocation.id));
      }
    }
  }

  const nextWorkOrder = await tx.workOrder.findFirst({
    where: {
      moId: workOrder.moId,
      isDeleted: false,
      status: { not: "Cancelled" },
      sequence: { gt: workOrder.sequence },
    },
    select: { id: true },
  });

  return !nextWorkOrder;
}

async function resolvePassedOutputTarget(tx, inspection = {}, sourceMovement = {}) {
  if (!inspection.productionLogId || !inspection.workOrder || !inspection.manufacturingOrder?.part) {
    return null;
  }

  const isFinalOperation = await isFinalProductionWorkOrder(tx, inspection.workOrder, inspection.productionLog);
  if (!isFinalOperation) return null;

  return {
    movementSource: sourceMovement,
    stockType: sourceMovement.stockType || "WIP",
    notes: `Release QC final operation ${inspection.inspectionNumber}; menunggu FG Receipt`,
  };
}

async function upsertDispositionTargetBalance(tx, sourceMovement, target, qty, stockType, options = {}) {
  if (!target.warehouseCode || qty <= 0) return null;
  const targetMovement = options.targetMovement || sourceMovement;
  const stockIdentity = buildMovementStockIdentity(targetMovement);

  const existing = await tx.stockBalance.findFirst({
    where: {
      warehouseCode: target.warehouseCode,
      rackCode: target.rackCode || null,
      lotNumber: target.lotNumber || targetMovement.lotNumber || null,
      partCode: targetMovement.partCode,
      ...stockIdentity,
      uomCode: targetMovement.uomCode || sourceMovement.uomCode || null,
      stockType,
      isDeleted: false,
    },
    select: { id: true, qtyOnHand: true, qtyReserved: true, qtyQC: true },
  });

  if (existing) {
    await assertStockBalanceNotFrozen(tx, existing.id);
    const qtyBefore = Number(existing.qtyOnHand || 0);
    const qtyOnHand = qtyBefore + qty;
    const qtyReserved = Number(existing.qtyReserved || 0);
    const qtyQC = Number(existing.qtyQC || 0);
    const balance = await tx.stockBalance.update({
      where: { id: existing.id },
      data: {
        stockType,
        qtyOnHand,
        qtyAvailable: Math.max(0, qtyOnHand - qtyReserved - qtyQC),
        lastMovement: new Date(),
      },
    });
    return { ...balance, qtyBefore, qtyAfter: qtyOnHand };
  }

  const balance = await tx.stockBalance.create({
    data: {
      warehouseCode: target.warehouseCode,
      rackCode: target.rackCode || null,
      lotNumber: target.lotNumber || targetMovement.lotNumber || null,
      partCode: targetMovement.partCode,
      ...stockIdentity,
      uomCode: targetMovement.uomCode || sourceMovement.uomCode || null,
      stockType,
      qtyOnHand: qty,
      qtyReserved: 0,
      qtyQC: 0,
      qtyAvailable: qty,
      lastMovement: new Date(),
    },
  });
  return { ...balance, qtyBefore: 0, qtyAfter: qty };
}

async function applyProductionLogQcDisposition(tx, inspection, dispositions = {}, performedBy = "system") {
  const { goodSource, rejectSource } = await getQualityInspectionSourceMovements(tx, inspection);
  const primarySource = goodSource || rejectSource;
  if (!primarySource?.warehouseCode || !primarySource.partCode) return null;

  const qtyPassed = Number(inspection.qtyPassed || 0);
  const qtyFailed = Number(inspection.qtyFailed || 0);
  const productionLogNgQty = getProductionLogNgQty(inspection.productionLog || {});
  const totalNgQty = productionLogNgQty + qtyFailed;
  if (hasExplicitQty(dispositions.passed)) {
    assertDispositionQtyMatches("Passed", dispositions.passed.qty, qtyPassed);
  }

  const sourceLocation = toLocationSnapshot(primarySource) || { warehouseCode: "WH-001", rackCode: null, lotNumber: null };
  const passedTarget = buildDispositionTarget(sourceLocation, dispositions.passed || {});
  const passedOutputTarget = await resolvePassedOutputTarget(tx, inspection, primarySource);
  const movements = [];

  const releasedPassed = await releaseQcHoldToTarget(tx, {
    inspection,
    sourceMovement: primarySource,
    qty: qtyPassed,
    target: passedTarget,
    transactionType: "QUALITY_RELEASE",
    stockType: primarySource.stockType || "Finished Goods",
    notes: passedOutputTarget
      ? `Release QC final operation ${inspection.inspectionNumber}; menunggu FG Receipt`
      : `Release QC dari ${inspection.inspectionNumber}`,
    performedBy,
  });
  movements.push(...releasedPassed.map(item => item.movementNumber));

  if (totalNgQty <= 0) {
    return movements;
  }

  const ngDisposition = dispositions.ng || {};
  const ngMode = String(ngDisposition.mode || "LATER").trim().toUpperCase() === "NOW"
    ? "NOW"
    : "LATER";

  const rejectTarget = buildDispositionTarget(
    toLocationSnapshot(rejectSource) || sourceLocation,
    ngDisposition.rejectDestination || { warehouseCode: "WH-001", rackCode: "RACK-REJECT" },
  );
  const scrapTarget = buildDispositionTarget(
    toLocationSnapshot(rejectSource) || sourceLocation,
    ngDisposition.scrapDestination || { warehouseCode: "WH-001", rackCode: "RACK-SCRAP" },
  );
  const reworkTarget = buildDispositionTarget(
    toLocationSnapshot(rejectSource) || sourceLocation,
    ngDisposition.reworkDestination || { warehouseCode: "WH-001", rackCode: "RACK-REWORK" },
  );

  const scrapQty = ngMode === "NOW"
    ? Math.max(0, Number(ngDisposition.scrapDestination?.qty || 0))
    : 0;
  const reworkQty = ngMode === "NOW"
    ? Math.max(0, Number(ngDisposition.reworkDestination?.qty || 0))
    : 0;
  const rejectQty = ngMode === "LATER"
    ? totalNgQty
    : 0;

  if (ngMode === "NOW" && Math.abs(scrapQty + reworkQty + rejectQty - totalNgQty) > 0.000001) {
    throw Object.assign(
      new Error("Qty NG disposition harus sama dengan total Qty NG Production Log + Qty Failed QC."),
      { statusCode: 400 },
    );
  }
  if (ngMode === "LATER" && Math.abs(rejectQty - totalNgQty) > 0.000001) {
    throw Object.assign(
      new Error("Qty Reject Hold harus sama dengan total Qty NG Production Log + Qty Failed QC."),
      { statusCode: 400 },
    );
  }

  const pools = [
    { sourceMovement: rejectSource, remainingQty: Math.max(0, productionLogNgQty) },
    { sourceMovement: goodSource || primarySource, remainingQty: Math.max(0, qtyFailed) },
  ].filter(pool => pool.sourceMovement?.warehouseCode && pool.remainingQty > 0);

  async function releaseFromPools(totalQty, target, transactionType, notes) {
    let remainingQty = Math.max(0, Number(totalQty || 0));
    for (const pool of pools) {
      if (remainingQty <= 0) break;
      const allocatedQty = Math.min(pool.remainingQty, remainingQty);
      if (allocatedQty <= 0) continue;
      const releasedRows = await releaseQcHoldToTarget(tx, {
        inspection,
        sourceMovement: pool.sourceMovement,
        qty: allocatedQty,
        target,
        transactionType,
        stockType: pool.sourceMovement.stockType || primarySource.stockType || "Finished Goods",
        notes,
        performedBy,
      });
      movements.push(...releasedRows.map(item => item.movementNumber));
      pool.remainingQty -= allocatedQty;
      remainingQty -= allocatedQty;
    }

    if (remainingQty > 0.000001) {
      throw Object.assign(
        new Error("Qty QC Hold tidak mencukupi untuk disposition NG."),
        { statusCode: 409 },
      );
    }
  }

  if (ngMode === "LATER") {
    await releaseFromPools(
      totalNgQty,
      rejectTarget,
      "REJECT",
      `NG QC dari ${inspection.inspectionNumber} dipindahkan ke rack reject untuk diputuskan nanti`,
    );
    return movements;
  }

  if (scrapQty > 0) {
    await releaseFromPools(
      scrapQty,
      scrapTarget,
      "SCRAP",
      `Scrap QC dari ${inspection.inspectionNumber}`,
    );
  }
  if (rejectQty > 0) {
    await releaseFromPools(
      rejectQty,
      rejectTarget,
      "REJECT",
      `Reject QC dari ${inspection.inspectionNumber}`,
    );
  }
  if (reworkQty > 0) {
    await releaseFromPools(
      reworkQty,
      reworkTarget,
      "REWORK",
      `Rework QC dari ${inspection.inspectionNumber}`,
    );
  }

  return movements;
}

async function getReceivedFgQty(tx, inspectionNumber) {
  const received = await tx.stockMovement.aggregate({
    where: {
      referenceType: "QUALITY_INSPECTION",
      referenceNumber: inspectionNumber,
      transactionType: "PRODUCTION",
      movementType: "IN",
      stockType: "Finished Goods",
      isDeleted: false,
    },
    _sum: { qty: true },
  });

  return Number(received._sum.qty || 0);
}

async function getProductionLogQcHoldMovement(tx, productionLogNumber) {
  if (!productionLogNumber) return null;
  return tx.stockMovement.findFirst({
    where: {
      referenceType: "PRODUCTION_LOG",
      referenceNumber: productionLogNumber,
      transactionType: "QC_HOLD",
      isDeleted: false,
    },
    orderBy: { createdAt: "desc" },
    select: {
      warehouseCode: true,
      rackCode: true,
      lotNumber: true,
      partCode: true,
      partNumber: true,
      partName: true,
      productId: true,
      description: true,
      spec: true,
      thickness: true,
      width: true,
      CSP: true,
      stockType: true,
      uomCode: true,
    },
  });
}

async function getQualityInspectionSourceMovements(tx, inspection = {}) {
  if (inspection.productionLog?.logNumber) {
    const [goodSourceByNote, rejectSource, fallbackGoodSource] = await Promise.all([
      tx.stockMovement.findFirst({
        where: {
          referenceType: "PRODUCTION_LOG",
          referenceNumber: inspection.productionLog.logNumber,
          transactionType: "QC_HOLD",
          isDeleted: false,
          qualityBucket: "GOOD",
        },
        orderBy: { createdAt: "desc" },
        select: {
          warehouseCode: true,
          rackCode: true,
          lotNumber: true,
          partCode: true,
          partNumber: true,
          partName: true,
          productId: true,
          description: true,
          spec: true,
          thickness: true,
          width: true,
          CSP: true,
          stockType: true,
          uomCode: true,
        },
      }),
      tx.stockMovement.findFirst({
        where: {
          referenceType: "PRODUCTION_LOG",
          referenceNumber: inspection.productionLog.logNumber,
          transactionType: "QC_HOLD",
          isDeleted: false,
          qualityBucket: "NG",
        },
        orderBy: { createdAt: "desc" },
        select: {
          warehouseCode: true,
          rackCode: true,
          lotNumber: true,
          partCode: true,
          partNumber: true,
          partName: true,
          productId: true,
          description: true,
          spec: true,
          thickness: true,
          width: true,
          CSP: true,
          stockType: true,
          uomCode: true,
        },
      }),
      tx.stockMovement.findFirst({
        where: {
          referenceType: "PRODUCTION_LOG",
          referenceNumber: inspection.productionLog.logNumber,
          transactionType: "QC_HOLD",
          isDeleted: false,
          qualityBucket: "GOOD",
        },
        orderBy: { createdAt: "desc" },
        select: {
          warehouseCode: true,
          rackCode: true,
          lotNumber: true,
          partCode: true,
          partNumber: true,
          partName: true,
          productId: true,
          description: true,
          spec: true,
          thickness: true,
          width: true,
          CSP: true,
          stockType: true,
          uomCode: true,
        },
      }),
    ]);
    return { goodSource: goodSourceByNote || fallbackGoodSource, rejectSource };
  }

  if (inspection.vendorProcessOrder?.orderNumber) {
    const vendorSource = await tx.stockMovement.findFirst({
      where: {
        referenceType: "VENDOR_PROCESS_ORDER",
        referenceNumber: inspection.vendorProcessOrder.orderNumber,
        transactionType: "QC_HOLD",
        isDeleted: false,
      },
      orderBy: { createdAt: "desc" },
      select: {
        warehouseCode: true,
        rackCode: true,
        lotNumber: true,
        partCode: true,
        partNumber: true,
        partName: true,
        productId: true,
        description: true,
        spec: true,
        thickness: true,
        width: true,
        CSP: true,
        stockType: true,
        uomCode: true,
      },
    });
    return { goodSource: vendorSource, rejectSource: null };
  }

  return { goodSource: null, rejectSource: null };
}

function toLocationSnapshot(movement = null) {
  if (!movement?.warehouseCode) return null;
  return {
    warehouseCode: movement.warehouseCode || null,
    rackCode: movement.rackCode || null,
    lotNumber: movement.lotNumber || null,
  };
}

async function getFgReceiptSourceMovement(tx, inspection = {}) {
  if (!inspection?.inspectionNumber) return null;

  const releaseMovement = await tx.stockMovement.findFirst({
    where: {
      referenceType: "QUALITY_INSPECTION",
      referenceNumber: inspection.inspectionNumber,
      transactionType: "QUALITY_RELEASE",
      isDeleted: false,
    },
    orderBy: [{ movementDate: "desc" }, { createdAt: "desc" }],
    select: {
      warehouseCode: true,
      rackCode: true,
      destinationWarehouseCode: true,
      destinationRackCode: true,
      lotNumber: true,
      partCode: true,
      partNumber: true,
      partName: true,
      productId: true,
      description: true,
      spec: true,
      thickness: true,
      width: true,
      CSP: true,
      stockType: true,
      uomCode: true,
    },
  });

  if (releaseMovement?.destinationWarehouseCode) {
    return {
      ...releaseMovement,
      warehouseCode: releaseMovement.destinationWarehouseCode,
      rackCode: releaseMovement.destinationRackCode || null,
      lotNumber: releaseMovement.lotNumber || null,
    };
  }

  if (inspection.productionLog?.logNumber) {
    return getProductionLogQcHoldMovement(tx, inspection.productionLog.logNumber);
  }

  return null;
}

async function releaseQcHoldToTarget(tx, {
  inspection,
  sourceMovement,
  qty,
  target,
  transactionType,
  stockType,
  notes,
  performedBy = "system",
}) {
  const normalizedQty = Math.max(0, Number(qty || 0));
  if (normalizedQty <= 0 || !sourceMovement?.warehouseCode || !sourceMovement?.partCode) {
    return [];
  }

  const source = {
    warehouseCode: sourceMovement.warehouseCode,
    rackCode: sourceMovement.rackCode || null,
    lotNumber: sourceMovement.lotNumber || null,
  };
  const movementStockIdentity = buildMovementStockIdentity(sourceMovement);
  const balance = await tx.stockBalance.findFirst({
    where: {
      warehouseCode: source.warehouseCode,
      rackCode: source.rackCode,
      lotNumber: source.lotNumber,
      partCode: sourceMovement.partCode,
      ...movementStockIdentity,
      uomCode: sourceMovement.uomCode || inspection.manufacturingOrder?.uomCode || null,
      stockType: sourceMovement.stockType || "Finished Goods",
      isDeleted: false,
    },
    select: { id: true, qtyOnHand: true, qtyReserved: true, qtyQC: true },
  });
  if (!balance) return [];

  await assertStockBalanceNotFrozen(tx, balance.id);

  const qtyOnHandBefore = Number(balance.qtyOnHand || 0);
  const qtyReserved = Number(balance.qtyReserved || 0);
  const qtyQCBefore = Number(balance.qtyQC || 0);
  const releasableQty = Math.min(normalizedQty, qtyQCBefore);
  if (releasableQty <= 0) return [];

  const normalizedTarget = buildDispositionTarget(source, target || {});
  const sameLocation = isSameLocation(source, normalizedTarget);
  let targetBalance = null;
  if (!sameLocation) {
    targetBalance = await upsertDispositionTargetBalance(
      tx,
      sourceMovement,
      normalizedTarget,
      releasableQty,
      stockType || sourceMovement.stockType || "Finished Goods",
    );
  }

  const qtyOnHandAfter = Math.max(0, qtyOnHandBefore - (sameLocation ? 0 : releasableQty));
  const qtyQCAfter = Math.max(0, qtyQCBefore - releasableQty);
  await tx.stockBalance.update({
    where: { id: balance.id },
    data: {
      qtyOnHand: qtyOnHandAfter,
      qtyQC: qtyQCAfter,
      qtyAvailable: Math.max(0, qtyOnHandAfter - qtyReserved - qtyQCAfter),
      lastMovement: new Date(),
    },
  });

  const movementNumber = await generateMovementNumber(
    sameLocation ? "ADJUSTMENT" : "TRANSFER",
    tx,
  );
  await tx.stockMovement.create({
    data: {
      movementNumber,
      movementDate: new Date(),
      movementType: sameLocation ? "ADJUSTMENT" : "TRANSFER",
      direction: sameLocation ? "IN" : "OUT",
      transactionType,
      warehouseCode: source.warehouseCode,
      rackCode: source.rackCode,
      destinationWarehouseCode: normalizedTarget.warehouseCode,
      destinationRackCode: normalizedTarget.rackCode,
      lotNumber: sourceMovement.lotNumber || normalizedTarget.lotNumber || null,
      partCode: sourceMovement.partCode,
      ...movementStockIdentity,
      stockType: stockType || sourceMovement.stockType || "Finished Goods",
      qty: releasableQty,
      deltaQty: sameLocation ? 0 : -releasableQty,
      qtyBefore: sameLocation ? qtyQCBefore : qtyOnHandBefore,
      qtyAfter: sameLocation ? qtyQCAfter : qtyOnHandAfter,
      uomCode: sourceMovement.uomCode || inspection.manufacturingOrder?.uomCode || null,
      qualityBucket:
        transactionType === "QUALITY_RELEASE"
          ? "GOOD"
          : ["REJECT", "SCRAP", "REWORK"].includes(transactionType)
            ? "NG"
            : null,
      referenceType: "QUALITY_INSPECTION",
      referenceNumber: inspection.inspectionNumber,
      notes,
      performedBy,
    },
  });

  return [{ movementNumber, targetBalance }];
}

async function getMoQcHoldWipSources(tx, inspection) {
  if (!inspection?.workOrder?.moId) return [];

  const [logs, vendorOrders] = await Promise.all([
    tx.productionLog.findMany({
      where: {
        moId: inspection.workOrder.moId,
        isDeleted: false,
      },
      select: {
        logNumber: true,
        workOrder: {
          select: {
            woNumber: true,
            sequence: true,
          },
        },
      },
    }),
    tx.vendorProcessOrder.findMany({
      where: {
        moId: inspection.workOrder.moId,
        isDeleted: false,
      },
      select: {
        orderNumber: true,
        sequence: true,
      },
    }),
  ]);

  const logNumbers = logs.map((log) => log.logNumber).filter(Boolean);
  const vendorOrderNumbers = vendorOrders.map((order) => order.orderNumber).filter(Boolean);
  if (logNumbers.length === 0 && vendorOrderNumbers.length === 0) return [];

  const logByNumber = new Map(logs.map((log) => [log.logNumber, log]));
  const vendorByNumber = new Map(vendorOrders.map((order) => [order.orderNumber, order]));
  const relatedInspections = await tx.qualityInspection.findMany({
    where: {
      isDeleted: false,
      status: "Completed",
      OR: [
        ...(logNumbers.length > 0 ? [{ productionLog: { logNumber: { in: logNumbers } } }] : []),
        ...(vendorOrderNumbers.length > 0 ? [{ vendorProcessOrder: { orderNumber: { in: vendorOrderNumbers } } }] : []),
      ],
    },
    select: {
      inspectionNumber: true,
      productionLog: { select: { logNumber: true } },
      vendorProcessOrder: { select: { orderNumber: true } },
    },
  });
  const inspectionByNumber = new Map(relatedInspections.map((row) => [row.inspectionNumber, row]));
  const inspectionNumbers = relatedInspections.map((row) => row.inspectionNumber).filter(Boolean);
  const qualityReleaseMovements = inspectionNumbers.length > 0
    ? await tx.stockMovement.findMany({
        where: {
          referenceType: "QUALITY_INSPECTION",
          referenceNumber: { in: inspectionNumbers },
          transactionType: "QUALITY_RELEASE",
          isDeleted: false,
        },
        orderBy: [{ movementDate: "desc" }, { createdAt: "desc" }],
        select: {
          referenceNumber: true,
          partCode: true,
          warehouseCode: true,
          rackCode: true,
          lotNumber: true,
          destinationWarehouseCode: true,
          destinationRackCode: true,
        },
      })
    : [];
  const effectiveLocationBySourceKey = new Map();
  for (const movement of qualityReleaseMovements) {
    const relatedInspection = inspectionByNumber.get(movement.referenceNumber);
    if (!relatedInspection?.inspectionNumber) continue;

    const sourceKey = relatedInspection.productionLog?.logNumber
      ? `PRODUCTION_LOG:${relatedInspection.productionLog.logNumber}:${movement.partCode || ""}`
      : relatedInspection.vendorProcessOrder?.orderNumber
        ? `VENDOR_PROCESS_ORDER:${relatedInspection.vendorProcessOrder.orderNumber}:${movement.partCode || ""}`
        : null;
    if (!sourceKey || effectiveLocationBySourceKey.has(sourceKey)) continue;

    effectiveLocationBySourceKey.set(sourceKey, {
      warehouseCode: movement.destinationWarehouseCode || movement.warehouseCode || null,
      rackCode: movement.destinationRackCode || movement.rackCode || null,
      lotNumber: movement.lotNumber || null,
    });
  }

  const movements = await tx.stockMovement.findMany({
    where: {
      OR: [
        ...(logNumbers.length > 0
          ? [{
              referenceType: "PRODUCTION_LOG",
              referenceNumber: { in: logNumbers },
            }]
          : []),
        ...(vendorOrderNumbers.length > 0
          ? [{
              referenceType: "VENDOR_PROCESS_ORDER",
              referenceNumber: { in: vendorOrderNumbers },
            }]
          : []),
      ],
      transactionType: "QC_HOLD",
      stockType: "WIP",
      isDeleted: false,
    },
    orderBy: [{ movementDate: "asc" }, { createdAt: "asc" }],
    select: {
      movementNumber: true,
      movementDate: true,
      referenceType: true,
      referenceNumber: true,
      warehouseCode: true,
      rackCode: true,
      lotNumber: true,
      partCode: true,
      partNumber: true,
      partName: true,
      stockType: true,
      qty: true,
      uomCode: true,
      notes: true,
    },
  });

  return movements.map((movement) => {
    const log = movement.referenceType === "PRODUCTION_LOG"
      ? logByNumber.get(movement.referenceNumber) || {}
      : null;
    const vendorOrder = movement.referenceType === "VENDOR_PROCESS_ORDER"
      ? vendorByNumber.get(movement.referenceNumber) || {}
      : null;
    const sourceKey = `${movement.referenceType}:${movement.referenceNumber}:${movement.partCode || ""}`;
    const effectiveLocation = effectiveLocationBySourceKey.get(sourceKey);

    return {
      movementNumber: movement.movementNumber,
      movementDate: movement.movementDate,
      productionLogNumber: movement.referenceType === "PRODUCTION_LOG" ? movement.referenceNumber : null,
      vendorProcessOrderNumber: movement.referenceType === "VENDOR_PROCESS_ORDER" ? movement.referenceNumber : null,
      woNumber: log?.workOrder?.woNumber || null,
      sequence: log?.workOrder?.sequence ?? vendorOrder?.sequence ?? null,
      routingType: movement.referenceType === "VENDOR_PROCESS_ORDER" ? "Vendor" : "In House",
      partCode: movement.partCode,
      partNumber: movement.partNumber,
      partName: movement.partName,
      stockType: movement.stockType,
      qty: Number(movement.qty || 0),
      uomCode: movement.uomCode || inspection.manufacturingOrder?.uomCode || null,
      location: {
        warehouseCode: effectiveLocation?.warehouseCode || movement.warehouseCode || null,
        rackCode: effectiveLocation?.rackCode || movement.rackCode || null,
        lotNumber: effectiveLocation?.lotNumber || movement.lotNumber || null,
      },
      notes: movement.notes || null,
    };
  });
}

async function buildFgReceiptRow(tx, inspection) {
  if (!inspection?.productionLog?.logNumber || !inspection.workOrder) return null;
  const isFinalOperation = await isFinalProductionWorkOrder(tx, inspection.workOrder, inspection.productionLog);
  if (!isFinalOperation) return null;

  const sourceMovement = await getProductionLogQcHoldMovement(tx, inspection.productionLog.logNumber);
  if (!sourceMovement?.warehouseCode || !sourceMovement.partCode) return null;
  const sourceWips = await getMoQcHoldWipSources(tx, inspection);

  const receivedQty = await getReceivedFgQty(tx, inspection.inspectionNumber);
  const passedQty = Number(inspection.qtyPassed || 0);
  const pendingQty = Math.max(0, passedQty - receivedQty);
  if (pendingQty <= 0) return null;

  return {
    id: inspection.id,
    moId: inspection.manufacturingOrder?.id || inspection.workOrder?.moId || null,
    inspectionNumber: inspection.inspectionNumber,
    inspectionDate: inspection.inspectionDate,
    moNumber: inspection.manufacturingOrder?.moNumber || null,
    woNumber: inspection.workOrder?.woNumber || null,
    productionLogNumber: inspection.productionLog.logNumber,
    sourcePart: {
      partCode: sourceMovement.partCode,
      partNumber: sourceMovement.partNumber,
      partName: sourceMovement.partName,
      stockType: sourceMovement.stockType,
    },
    sourceWips,
    fgPart: inspection.manufacturingOrder?.part || null,
    qtyPassed: passedQty,
    qtyReceived: receivedQty,
    qtyPending: pendingQty,
    uomCode: sourceMovement.uomCode || inspection.manufacturingOrder?.uomCode || null,
    sourceLocation: {
      warehouseCode: sourceMovement.warehouseCode,
      rackCode: sourceMovement.rackCode || null,
      lotNumber: sourceMovement.lotNumber || null,
    },
    receiptState: "READY_TO_RECEIVE",
    actionable: true,
    blockers: [],
  };
}

async function buildNonComponentFgTrackingRows(tx, options = {}) {
  const query = String(options.q || "").trim();
  const manufacturingOrders = await tx.manufacturingOrder.findMany({
    where: {
      isDeleted: false,
      status: { not: "Cancelled" },
      qtyPlanned: { gt: 0 },
      monthlyProductionPlanNumber: { not: null },
      ...(options.moId ? { id: options.moId } : {}),
      part: {
        isDeleted: false,
        itemType: "FG",
        partType: { not: "COMP" },
      },
      ...(query
        ? {
            OR: [
              { moNumber: { contains: query, mode: "insensitive" } },
              { monthlyProductionPlanNumber: { contains: query, mode: "insensitive" } },
              { part: { partCode: { contains: query, mode: "insensitive" } } },
              { part: { partName: { contains: query, mode: "insensitive" } } },
              { workOrders: { some: { woNumber: { contains: query, mode: "insensitive" } } } },
              { productionLogs: { some: { logNumber: { contains: query, mode: "insensitive" } } } },
              { qualityInspections: { some: { inspectionNumber: { contains: query, mode: "insensitive" } } } },
            ],
          }
        : {}),
    },
    orderBy: [{ plannedEndDate: "asc" }, { moNumber: "asc" }],
    select: {
      id: true,
      moNumber: true,
      monthlyProductionPlanNumber: true,
      monthlyProductionPlanLineNumber: true,
      plannedEndDate: true,
      qtyPlanned: true,
      uomCode: true,
      status: true,
      part: {
        select: {
          partCode: true,
          partNumber: true,
          partName: true,
          itemType: true,
          partType: true,
        },
      },
      workOrders: {
        where: { isDeleted: false, status: { not: "Cancelled" } },
        orderBy: [{ sequence: "desc" }, { woNumber: "desc" }],
        select: {
          woNumber: true,
          sequence: true,
          status: true,
          outputPartCode: true,
          outputPartNumber: true,
          outputPartName: true,
          productionLogs: {
            where: { isDeleted: false },
            orderBy: [{ logDate: "desc" }, { createdAt: "desc" }],
            select: { logNumber: true, status: true, qtyGood: true },
          },
        },
      },
      qualityInspections: {
        where: { isDeleted: false },
        orderBy: [{ inspectionDate: "desc" }, { createdAt: "desc" }],
        select: { inspectionNumber: true, status: true, decision: true, qtyPassed: true },
      },
    },
  });

  const inspectionNumbers = manufacturingOrders.flatMap((mo) => mo.qualityInspections.map((inspection) => inspection.inspectionNumber));
  const receivedMovements = inspectionNumbers.length
    ? await tx.stockMovement.findMany({
        where: {
          referenceType: "QUALITY_INSPECTION",
          referenceNumber: { in: inspectionNumbers },
          transactionType: "PRODUCTION",
          movementType: "IN",
          stockType: "Finished Goods",
          isDeleted: false,
        },
        select: { referenceNumber: true, qty: true },
      })
    : [];
  const receivedByInspection = new Map();
  receivedMovements.forEach((movement) => receivedByInspection.set(
    movement.referenceNumber,
    Number(receivedByInspection.get(movement.referenceNumber) || 0) + Number(movement.qty || 0),
  ));

  return manufacturingOrders.map((mo) => {
    const receivedQty = mo.qualityInspections.reduce(
      (sum, inspection) => sum + Number(receivedByInspection.get(inspection.inspectionNumber) || 0),
      0,
    );
    const pendingQty = Math.max(0, Number(mo.qtyPlanned || 0) - receivedQty);
    if (pendingQty <= 0.000001) return null;

    const finalWorkOrder = mo.workOrders[0] || null;
    const latestLog = finalWorkOrder?.productionLogs?.[0] || null;
    const completedAcceptedQcs = mo.qualityInspections.filter((inspection) =>
      inspection.status === "Completed"
      && ["ACCEPTED", "CONDITIONAL ACCEPT", "CONDITIONAL_ACCEPT"].includes(String(inspection.decision || "").trim().toUpperCase()));
    let receiptState = "WAITING_PRODUCTION";
    let blockerCode = "FG_NONCOMP_PRODUCTION_PENDING";
    let blockerMessage = "FG non-component tidak memiliki proses langsung; receipt menunggu output WIP terakhir dari proses in-house.";
    const references = [
      { type: "MO", label: mo.moNumber, href: `/modules/production/manufacturing-orders/${encodeURIComponent(mo.moNumber)}` },
      mo.monthlyProductionPlanNumber
        ? { type: "MPP", label: mo.monthlyProductionPlanNumber, href: `/modules/planning-ppic/monthly-production-plans/${encodeURIComponent(mo.monthlyProductionPlanNumber)}` }
        : null,
      { type: "PART", label: mo.part.partCode, href: `/master-data/parts/${encodeURIComponent(mo.part.partCode)}/edit?key=${encodeURIComponent(mo.part.partCode)}` },
    ].filter(Boolean);

    if (!finalWorkOrder) {
      receiptState = "WAITING_FINAL_OUTPUT";
      blockerCode = "FG_NONCOMP_FINAL_OUTPUT_MISSING";
      blockerMessage = "Belum ada Work Order penghasil WIP terakhir. Periksa BOM/routing child lalu generate Work Order dari MO.";
    } else {
      references.push({ type: "WO", label: finalWorkOrder.woNumber, href: `/modules/production/work-orders/${encodeURIComponent(finalWorkOrder.woNumber)}` });
      if (!latestLog || latestLog.status !== "Approved") {
        receiptState = "WAITING_PRODUCTION";
        blockerCode = "FG_NONCOMP_PRODUCTION_LOG_PENDING";
        blockerMessage = "Output proses in-house terakhir belum memiliki Production Log Approved.";
        if (latestLog) references.push({ type: "LOG", label: latestLog.logNumber, href: `/modules/production/production-logs/${encodeURIComponent(latestLog.logNumber)}` });
      } else if (!completedAcceptedQcs.length) {
        receiptState = "WAITING_QC";
        blockerCode = "FG_NONCOMP_QC_PENDING";
        blockerMessage = "Output WIP terakhir sudah diproduksi tetapi belum memiliki QC Completed dan Accepted.";
        references.push({ type: "LOG", label: latestLog.logNumber, href: `/modules/production/production-logs/${encodeURIComponent(latestLog.logNumber)}` });
        references.push({ type: "QC", label: "Buat / selesaikan QC", href: `/modules/production/quality-inspections/new?productionLogNumber=${encodeURIComponent(latestLog.logNumber)}` });
      } else {
        receiptState = "WAITING_RECEIPT_RECONCILIATION";
        blockerCode = "FG_NONCOMP_RECEIPT_QTY_GAP";
        blockerMessage = "QC Accepted sudah ada, tetapi seluruh outstanding belum menjadi baris receipt siap posting. Periksa qty QC dan source WIP release.";
        const latestQc = completedAcceptedQcs[0];
        references.push({ type: "QC", label: latestQc.inspectionNumber, href: `/modules/production/quality-inspections/${encodeURIComponent(latestQc.inspectionNumber)}` });
      }
    }

    return {
      id: `MO:${mo.id}`,
      moId: mo.id,
      trackingKey: `MO:${mo.moNumber}`,
      inspectionNumber: null,
      inspectionDate: null,
      moNumber: mo.moNumber,
      monthlyProductionPlanNumber: mo.monthlyProductionPlanNumber,
      monthlyProductionPlanLineNumber: mo.monthlyProductionPlanLineNumber,
      dueDate: mo.plannedEndDate,
      woNumber: finalWorkOrder?.woNumber || null,
      productionLogNumber: latestLog?.logNumber || null,
      sourcePart: finalWorkOrder
        ? { partCode: finalWorkOrder.outputPartCode, partNumber: finalWorkOrder.outputPartNumber, partName: finalWorkOrder.outputPartName, stockType: "WIP" }
        : null,
      sourceWips: [],
      fgPart: mo.part,
      qtyPassed: completedAcceptedQcs.reduce((sum, inspection) => sum + Number(inspection.qtyPassed || 0), 0),
      qtyReceived: receivedQty,
      qtyPending: pendingQty,
      uomCode: mo.uomCode,
      sourceLocation: null,
      receiptState,
      actionable: false,
      blockers: [{ severity: "BLOCKING", code: blockerCode, message: blockerMessage, references }],
    };
  }).filter(Boolean);
}

function buildAutoCompletionData(data = {}) {
  const decision = calculateDecision(data);
  return {
    status: "Draft",
    decision: data.decision || decision || "Pending",
  };
}

async function autoCreateDiesUsage(tx, wo) {
  const usage = await tx.diesUsage.create({
    data: {
      diesId: wo.diesId,
      partId: wo.manufacturingOrder?.partId || null,
      usageDate: wo.endTime || new Date(),
      referenceType: "Work Order",
      referenceNumber: wo.woNumber,
      shotCount: wo.shotCount,
      qtyProduced: wo.qtyProduced,
      qtyGood: wo.qtyGood,
      qtyReject: wo.qtyReject,
      machineCode: wo.machine?.machineCode || null,
      operatorName: wo.operatorName || null,
      shift: wo.shift || null,
      startTime: wo.startTime || null,
      endTime: wo.endTime || null,
      runningMinutes: wo.runningMinutes || null,
    },
  });

  await incrementDiesShotCounter(tx, wo.diesId, wo.shotCount);
  await tx.workOrder.update({
    where: { id: wo.id },
    data: { diesUsageId: usage.id },
  });

  return usage;
}

async function closeMaterialIssuesIfReady(tx, moId) {
  const openWorkOrderCount = await tx.workOrder.count({
    where: {
      moId,
      isDeleted: false,
      status: { notIn: ["Completed", "Cancelled"] },
    },
  });
  if (openWorkOrderCount > 0) return [];

  const materialIssues = await tx.materialIssue.findMany({
    where: {
      moId,
      isDeleted: false,
      status: { in: ["Issued", "Partially Returned"] },
    },
    include: {
      details: {
        where: { isDeleted: false },
        select: { qtyReturned: true },
      },
    },
  });

  const closed = [];
  for (const issue of materialIssues) {
    const hasReturnedQty = issue.details.some((detail) => Number(detail.qtyReturned || 0) > 0);
    if (issue.status !== "Issued" || hasReturnedQty) continue;

    const updated = await tx.materialIssue.update({
      where: { id: issue.id },
      data: { status: "Closed" },
      select: { issueNumber: true },
    });
    closed.push(updated.issueNumber);
  }

  return closed;
}

async function syncNextWorkOrderPlannedQtyFromSequence(tx, completedWo) {
  const capacityDailyPlan = completedWo?.id
    ? await tx.dailyProductionSchedule.findFirst({
        where: {
          woId: completedWo.id,
          productionPlanAllocationId: { not: null },
          isDeleted: false,
        },
        select: { productionPlanAllocationId: true },
      })
    : null;
  if (capacityDailyPlan) {
    // The capacity allocation graph already defines exact qty per branch and
    // delivery batch. A legacy raw-sequence propagation would sum parallel
    // parts together and overwrite every downstream WO with an unrelated qty.
    return {
      mode: "CAPACITY_GRAPH",
      sourceAllocationId: capacityDailyPlan.productionPlanAllocationId,
      plannedQty: Number(completedWo.qtyGood || 0),
      updatedCount: 0,
      workOrderUpdatedCount: 0,
      vendorProcessUpdatedCount: 0,
    };
  }

  if (
    !completedWo?.moId
    || completedWo.sequence === null
    || completedWo.sequence === undefined
  ) {
    return null;
  }

  const sourceSequenceWorkOrders = await tx.workOrder.findMany({
    where: {
      moId: completedWo.moId,
      isDeleted: false,
      sequence: completedWo.sequence,
    },
    select: { id: true },
  });
  const sourceWoIds = sourceSequenceWorkOrders.map((wo) => wo.id);
  if (sourceWoIds.length === 0) return null;

  const accepted = await tx.qualityInspection.aggregate({
    where: {
      woId: { in: sourceWoIds },
      isDeleted: false,
      status: "Completed",
    },
    _sum: { qtyPassed: true },
  });
  const nextPlannedQty = Math.max(0, Number(accepted._sum.qtyPassed || 0));

  const [workOrderResult, vendorProcessResult] = await Promise.all([
    tx.workOrder.updateMany({
      where: {
        moId: completedWo.moId,
        isDeleted: false,
        sequence: { gt: completedWo.sequence },
        status: { in: ["Draft", "Planned", "Released", "Material Issued"] },
      },
      data: { plannedQty: nextPlannedQty },
    }),
    tx.vendorProcessOrder.updateMany({
      where: {
        moId: completedWo.moId,
        isDeleted: false,
        sequence: { gt: completedWo.sequence },
        status: { in: ["Planned", "Ready to Send"] },
      },
      data: { qtyPlanned: nextPlannedQty },
    }),
  ]);

  return {
    fromSequence: completedWo.sequence,
    plannedQty: nextPlannedQty,
    updatedCount: workOrderResult.count + vendorProcessResult.count,
    workOrderUpdatedCount: workOrderResult.count,
    vendorProcessUpdatedCount: vendorProcessResult.count,
  };
}

async function syncNextOperationPlannedQtyFromVendorSequence(tx, completedVendorOrder) {
  const capacityAllocationId = String(completedVendorOrder?.notes || "").match(/\[CAPACITY-VENDOR:([^\]]+)\]/)?.[1] || null;
  if (capacityAllocationId) {
    // Capacity Planning already owns exact transfer-batch quantities for every
    // graph successor. A raw sequence update would overwrite unrelated
    // branches (and the second delivery phase) with this phase's accepted qty.
    return {
      mode: "CAPACITY_GRAPH",
      sourceAllocationId: capacityAllocationId,
      plannedQty: Number(completedVendorOrder.qtyAccepted || 0),
      updatedCount: 0,
      workOrderUpdatedCount: 0,
      vendorProcessUpdatedCount: 0,
    };
  }

  if (
    !completedVendorOrder?.moId
    || completedVendorOrder.sequence === null
    || completedVendorOrder.sequence === undefined
  ) {
    return null;
  }

  const sourceVendorOrders = await tx.vendorProcessOrder.findMany({
    where: {
      moId: completedVendorOrder.moId,
      isDeleted: false,
      sequence: completedVendorOrder.sequence,
    },
    select: { id: true },
  });
  const sourceVendorOrderIds = sourceVendorOrders.map((order) => order.id);
  if (sourceVendorOrderIds.length === 0) return null;

  const accepted = await tx.qualityInspection.aggregate({
    where: {
      vendorProcessOrderId: { in: sourceVendorOrderIds },
      isDeleted: false,
      status: "Completed",
    },
    _sum: { qtyPassed: true },
  });
  const nextPlannedQty = Math.max(0, Number(accepted._sum.qtyPassed || 0));

  const [workOrderResult, vendorProcessResult] = await Promise.all([
    tx.workOrder.updateMany({
      where: {
        moId: completedVendorOrder.moId,
        isDeleted: false,
        sequence: { gt: completedVendorOrder.sequence },
        status: { in: ["Draft", "Planned", "Released", "Material Issued"] },
      },
      data: { plannedQty: nextPlannedQty },
    }),
    tx.vendorProcessOrder.updateMany({
      where: {
        moId: completedVendorOrder.moId,
        isDeleted: false,
        sequence: { gt: completedVendorOrder.sequence },
        status: { in: ["Planned", "Ready to Send"] },
      },
      data: { qtyPlanned: nextPlannedQty },
    }),
  ]);

  return {
    fromSequence: completedVendorOrder.sequence,
    plannedQty: nextPlannedQty,
    updatedCount: workOrderResult.count + vendorProcessResult.count,
    workOrderUpdatedCount: workOrderResult.count,
    vendorProcessUpdatedCount: vendorProcessResult.count,
  };
}

async function syncWorkOrderFromCompletedQc(tx, woId, performedBy = "system") {
  if (!woId) return null;

  const wo = await tx.workOrder.findFirst({
    where: { id: woId, isDeleted: false },
    include: {
      machine: { select: { machineCode: true } },
      manufacturingOrder: { select: { partId: true } },
    },
  });
  if (!wo) return null;

  const completedInspections = await tx.qualityInspection.findMany({
    where: { woId, isDeleted: false, status: "Completed" },
    select: {
      qtyInspected: true,
      qtyPassed: true,
      qtyFailed: true,
      qtyRework: true,
      approvedAt: true,
      inspectionDate: true,
    },
    orderBy: [{ approvedAt: "desc" }, { inspectionDate: "desc" }],
  });
  if (completedInspections.length === 0) return null;

  const approvedLogs = await tx.productionLog.findMany({
    where: { woId, isDeleted: false, status: "Approved" },
    select: {
      qtyProduced: true,
      qtyGood: true,
      qtyReject: true,
      qtyRework: true,
      endTime: true,
      logDate: true,
    },
    orderBy: [{ endTime: "desc" }, { logDate: "desc" }],
  });

  const totalInspected = completedInspections.reduce((sum, inspection) => sum + Number(inspection.qtyInspected || 0), 0);
  const totalQcGood = completedInspections.reduce((sum, inspection) => sum + Number(inspection.qtyPassed || 0), 0);
  const totalQcReject = completedInspections.reduce((sum, inspection) => sum + Number(inspection.qtyFailed || 0), 0);
  const totalQcRework = completedInspections.reduce((sum, inspection) => sum + Number(inspection.qtyRework || 0), 0);
  const totalProducedFromLogs = approvedLogs.reduce((sum, log) => sum + Number(log.qtyProduced || 0), 0);
  const totalQcHoldFromLogs = approvedLogs.reduce((sum, log) => sum + Number(log.qtyGood || 0), 0);
  const totalProductionReject = approvedLogs.reduce((sum, log) => sum + Number(log.qtyReject || 0), 0);
  const totalProductionRework = approvedLogs.reduce((sum, log) => sum + Number(log.qtyRework || 0), 0);
  const totalProduced = totalProducedFromLogs || totalInspected;

  const updateData = {
    qtyProduced: totalProduced,
    qtyGood: totalQcGood,
    qtyReject: totalProductionReject + totalQcReject,
  };

  const qcHoldQty = totalQcHoldFromLogs || totalProduced;
  // A partial DPP/production log must not complete the WO early.  Previously
  // the first approved QC batch could mark a WO Completed even when only a
  // fraction of its planned quantity had been produced, blocking the
  // remaining DPP schedules and allowing the next sequence to start.
  const plannedQty = Number(wo.plannedQty || 0);
  const productionComplete = totalProduced + 0.000001 >= plannedQty;
  const canComplete = ["QC Pending", "In Production", "In Progress"].includes(wo.status)
    && qcHoldQty > 0
    && totalInspected >= qcHoldQty
    && productionComplete;
  const needsRework = (totalProductionRework + totalQcRework) > 0 && !["Completed", "Cancelled"].includes(wo.status);
  if (needsRework && !canComplete) {
    updateData.status = "Rework";
  }
  if (canComplete) {
    updateData.status = "Completed";
    updateData.endTime =
      completedInspections[0]?.approvedAt ||
      completedInspections[0]?.inspectionDate ||
      approvedLogs[0]?.endTime ||
      approvedLogs[0]?.logDate ||
      new Date();
  }

  const updated = await tx.workOrder.update({
    where: { id: wo.id },
    data: updateData,
    include: {
      machine: { select: { machineCode: true } },
      manufacturingOrder: { select: { partId: true } },
    },
  });

  if (canComplete && updated.diesId && !updated.diesUsageId) {
    await autoCreateDiesUsage(tx, updated);
  }

  if (canComplete && totalProduced > 0) {
    const existingWipCount = await tx.wIPEntry.count({
      where: { woId: updated.id, sourceType: "WorkOrder", sourceId: updated.id, isDeleted: false },
    });
    if (existingWipCount === 0) {
      await createWIPEntry(tx, {
        entryDate: new Date(),
        moId: updated.moId,
        woId: updated.id,
        costType: "Labor",
        sourceType: "WorkOrder",
        sourceId: updated.id,
        sourceRef: updated.woNumber,
        partCode: updated.outputPartCode || null,
        partNumber: updated.outputPartNumber || null,
        partName: updated.outputPartName || null,
        uomCode: updated.uomCode || null,
        stockType: "WIP",
        qty: totalProduced,
        rate: 0,
        amount: 0,
        direction: "IN",
        notes: `WO ${updated.woNumber} auto completed from completed QC (qty: ${totalProduced})`,
        createdBy: performedBy,
      });
    }
  }

  const closedMaterialIssues = canComplete ? await closeMaterialIssuesIfReady(tx, updated.moId) : [];
  const nextWorkOrderPlan = canComplete
    ? await syncNextWorkOrderPlannedQtyFromSequence(tx, updated)
    : null;
  const syncedMo = await syncManufacturingOrderQtyFromWorkOrders(tx, updated.moId);

  return {
    woNumber: updated.woNumber,
    status: updated.status,
    qtyProduced: updated.qtyProduced,
    qtyGood: updated.qtyGood,
    qtyReject: updated.qtyReject,
    completed: canComplete,
    closedMaterialIssues,
    nextWorkOrderPlan,
    manufacturingOrder: syncedMo,
  };
}

async function syncVendorProcessFromCompletedQc(tx, vendorProcessOrderId) {
  if (!vendorProcessOrderId) return null;

  const order = await tx.vendorProcessOrder.findFirst({
    where: { id: vendorProcessOrderId, isDeleted: false },
    select: {
      id: true,
      orderNumber: true,
      moId: true,
      sequence: true,
      qtyPlanned: true,
      qtySent: true,
      qtyReceived: true,
      vendorCode: true,
      vendorRate: true,
      notes: true,
    },
  });
  if (!order) return null;

  const completedQc = await tx.qualityInspection.findMany({
    where: {
      vendorProcessOrderId,
      isDeleted: false,
      status: "Completed",
    },
    select: {
      qtyInspected: true,
      qtyPassed: true,
      qtyFailed: true,
      qtyRework: true,
    },
  });

  const qtyInspected = completedQc.reduce((sum, qc) => sum + Number(qc.qtyInspected || 0), 0);
  const qtyAccepted = completedQc.reduce((sum, qc) => sum + Number(qc.qtyPassed || 0), 0);
  const qtyReject = completedQc.reduce((sum, qc) => sum + Number(qc.qtyFailed || 0), 0);
  const qtyRework = completedQc.reduce((sum, qc) => sum + Number(qc.qtyRework || 0), 0);
  const expectedQty = Math.max(Number(order.qtySent || 0), Number(order.qtyReceived || 0));
  const isCompleted = expectedQty > 0 && qtyInspected + 0.005 >= expectedQty;
  const costQty = qtyAccepted > 0 ? qtyAccepted : Number(order.qtyReceived || 0);
  let rollbackStatus = order.vendorCode ? "Ready to Send" : "Planned";
  if (Number(order.qtySent || 0) > 0) {
    rollbackStatus = "Sent";
  }
  if (Number(order.qtyReceived || 0) > 0) {
    rollbackStatus = Number(order.qtyReceived || 0) + 0.005 >= Math.max(Number(order.qtySent || 0), Number(order.qtyReceived || 0))
      ? "QC Hold"
      : "Partial Received";
  }

  const updated = await tx.vendorProcessOrder.update({
    where: { id: order.id },
    data: {
      qtyAccepted,
      qtyReject,
      qtyRework,
      actualVendorCost: roundCost(costQty * Number(order.vendorRate || 0)),
      status: isCompleted ? "Completed" : rollbackStatus,
      closedAt: isCompleted ? new Date() : null,
    },
  });

  // Capacity-driven vendor work is published as one DPP per transfer batch.
  // Keep that daily source as the execution truth when vendor QC completes or
  // is rolled back, just like an in-house Production Log updates its DPP.
  const capacityAllocationId = String(order.notes || "").match(/\[CAPACITY-VENDOR:([^\]]+)\]/)?.[1] || null;
  let dailyPlan = null;
  if (capacityAllocationId) {
    const linkedPlan = await tx.dailyProductionSchedule.findFirst({
      where: {
        moId: order.moId,
        productionPlanAllocationId: capacityAllocationId,
        isDeleted: false,
      },
      select: { id: true, scheduleNumber: true, plannedQty: true },
    });
    if (linkedPlan) {
      const actualQty = Math.min(qtyAccepted, Number(linkedPlan.plannedQty || 0));
      const status = isCompleted ? "Completed" : Number(order.qtySent || 0) > 0 ? "In Progress" : "Draft";
      const synced = await tx.dailyProductionSchedule.update({
        where: { id: linkedPlan.id },
        data: { actualQty, status },
        select: { scheduleNumber: true, status: true, actualQty: true, plannedQty: true },
      });
      dailyPlan = synced;
    }
  }

  const nextOperationPlan = await syncNextOperationPlannedQtyFromVendorSequence(tx, updated);
  const syncedMo = await syncManufacturingOrderQtyFromWorkOrders(tx, updated.moId);
  return {
    orderNumber: updated.orderNumber,
    status: updated.status,
    qtyAccepted: updated.qtyAccepted,
    qtyReject: updated.qtyReject,
    qtyRework: updated.qtyRework,
    dailyPlan,
    nextOperationPlan,
    manufacturingOrder: syncedMo,
  };
}

async function resyncWorkOrderAfterQualityInspectionDelete(tx, woId) {
  if (!woId) return null;

  const wo = await tx.workOrder.findFirst({
    where: { id: woId, isDeleted: false },
    select: {
      id: true,
      woNumber: true,
      moId: true,
      plannedQty: true,
      status: true,
      machineCostingRate: true,
      machineRateType: true,
    },
  });
  if (!wo) return null;

  const [completedInspections, approvedLogs, activeMaterialIssueCount] = await Promise.all([
    tx.qualityInspection.findMany({
      where: { woId, isDeleted: false, status: "Completed" },
      select: { qtyInspected: true, qtyPassed: true, qtyFailed: true, qtyRework: true },
    }),
    tx.productionLog.findMany({
      where: { woId, isDeleted: false, status: "Approved" },
      select: {
        qtyProduced: true,
        qtyGood: true,
        qtyReject: true,
        startTime: true,
        endTime: true,
        runningMinutes: true,
        logDate: true,
      },
      orderBy: [{ startTime: "asc" }, { logDate: "asc" }],
    }),
    tx.materialIssue.count({
      where: {
        woId,
        isDeleted: false,
        status: { in: ["Issued", "Partially Returned", "Closed"] },
      },
    }),
  ]);

  const totalProducedFromLogs = approvedLogs.reduce((sum, log) => sum + Number(log.qtyProduced || 0), 0);
  const totalQcHoldFromLogs = approvedLogs.reduce((sum, log) => sum + Number(log.qtyGood || 0), 0);
  const totalProductionReject = approvedLogs.reduce((sum, log) => sum + Number(log.qtyReject || 0), 0);
  const totalRunningMinutes = approvedLogs.reduce((sum, log) => sum + getLogDurationMinutes(log), 0);
  const totalQcInspected = completedInspections.reduce((sum, qc) => sum + Number(qc.qtyInspected || 0), 0);
  const totalQcGood = completedInspections.reduce((sum, qc) => sum + Number(qc.qtyPassed || 0), 0);
  const totalQcReject = completedInspections.reduce((sum, qc) => sum + Number(qc.qtyFailed || 0), 0);
  const totalQcRework = completedInspections.reduce((sum, qc) => sum + Number(qc.qtyRework || 0), 0);
  const firstStartTime = approvedLogs.find((log) => log.startTime)?.startTime || null;
  const lastEndTime = [...approvedLogs].reverse().find((log) => log.endTime)?.endTime || null;
  const actualProcessCost =
    totalRunningMinutes * 60 * toMachineRatePerSecond(wo.machineCostingRate, wo.machineRateType);

  const updateData = {
    qtyProduced: totalProducedFromLogs,
    qtyGood: totalQcGood,
    qtyReject: totalProductionReject + totalQcReject,
    runningMinutes: totalRunningMinutes || null,
    actualProcessCost,
    ...(firstStartTime ? { startTime: firstStartTime } : { startTime: null }),
    ...(lastEndTime ? { endTime: lastEndTime } : { endTime: null }),
  };

  if (approvedLogs.length > 0) {
    const qcHoldQty = totalQcHoldFromLogs || totalProducedFromLogs;
    const isFullyInspected = qcHoldQty > 0 && totalQcInspected >= qcHoldQty;
    const hasRework = totalQcRework > 0;
    updateData.status = isFullyInspected
      ? "Completed"
      : hasRework
        ? "Rework"
        : "QC Pending";
  } else {
    updateData.status = activeMaterialIssueCount > 0 ? "Material Issued" : "Released";
  }

  if (completedInspections.length === 0) {
    await tx.wIPEntry.updateMany({
      where: {
        woId: wo.id,
        sourceType: "WorkOrder",
        sourceId: wo.id,
        isDeleted: false,
      },
      data: { isDeleted: true },
    });
  }

  const updated = await tx.workOrder.update({
    where: { id: wo.id },
    data: updateData,
  });
  return {
    woNumber: updated.woNumber,
    status: updated.status,
    manufacturingOrder: await syncManufacturingOrderQtyFromWorkOrders(tx, updated.moId),
  };
}

async function rollbackQualityInspectionAutomation(tx, inspection) {
  await tx.workOrder.updateMany({
    where: {
      isDeleted: false,
      isReworkOrder: true,
      reworkReferenceType: "QUALITY_INSPECTION",
      reworkReferenceNumber: inspection.inspectionNumber,
    },
    data: { isDeleted: true, status: "Cancelled" },
  });
  await tx.vendorProcessOrder.updateMany({
    where: {
      isDeleted: false,
      isReworkOrder: true,
      reworkReferenceType: "QUALITY_INSPECTION",
      reworkReferenceNumber: inspection.inspectionNumber,
    },
    data: { isDeleted: true, status: "Cancelled" },
  });

  const workOrder = inspection.woId
    ? await resyncWorkOrderAfterQualityInspectionDelete(tx, inspection.woId)
    : null;
  const vendorProcessOrder = inspection.vendorProcessOrderId
    ? await syncVendorProcessFromCompletedQc(tx, inspection.vendorProcessOrderId)
    : null;
  const manufacturingOrder = workOrder?.manufacturingOrder
    || vendorProcessOrder?.manufacturingOrder
    || await syncManufacturingOrderQtyFromWorkOrders(tx, inspection.moId);

  return { workOrder, vendorProcessOrder, manufacturingOrder };
}

async function createQualityInspectionReworkAutomation(tx, inspection, qtyRework, performedBy = "system") {
  const normalizedQty = Math.max(0, Number(qtyRework || 0));
  if (normalizedQty <= 0) return null;

  if (inspection.productionLogId && inspection.manufacturingOrder) {
    const sourceWo = inspection.workOrder;
    const reworkWoNumber = await generateDailyNumber(tx, "workOrder", "woNumber", "WO");
    const now = new Date();

    const createdWorkOrder = await tx.workOrder.create({
      data: {
        woNumber: reworkWoNumber,
        woDate: now,
        moId: inspection.manufacturingOrder.id,
        mbomDetailId: sourceWo?.mbomDetailId || null,
        machineId: sourceWo?.machineId || null,
        processId: sourceWo?.processId || null,
        sequence: sourceWo?.sequence || 0,
        cycleTime: sourceWo?.cycleTime || 0,
        machineCostingRate: sourceWo?.machineCostingRate ?? null,
        machineRateType: sourceWo?.machineRateType || null,
        machineCurrency: sourceWo?.machineCurrency || null,
        outputPartId: sourceWo?.outputPartId || null,
        outputPartCode: sourceWo?.outputPartCode || null,
        outputPartNumber: sourceWo?.outputPartNumber || null,
        outputPartName: sourceWo?.outputPartName || null,
        plannedDate: now,
        plannedQty: normalizedQty,
        uomCode: sourceWo?.uomCode || inspection.manufacturingOrder.uomCode || null,
        status: "Rework",
        isReworkOrder: true,
        reworkSourceType: "QUALITY_INSPECTION",
        reworkReferenceType: "QUALITY_INSPECTION",
        reworkReferenceNumber: inspection.inspectionNumber,
        reworkReferenceLabel: inspection.inspectionNumber,
        notes: null,
      },
      select: { id: true, woNumber: true, status: true, plannedQty: true },
    });

    return {
      type: "WORK_ORDER",
      workOrder: createdWorkOrder,
      reworkWoNumber,
    };
  }

  if (inspection.vendorProcessOrderId && inspection.vendorProcessOrder) {
    const sourceOrder = inspection.vendorProcessOrder;
    const reworkOrderNumber = await generateDailyNumber(tx, "vendorProcessOrder", "orderNumber", "VPO");
    const now = new Date();
    const createdVendorProcessOrder = await tx.vendorProcessOrder.create({
      data: {
        orderNumber: reworkOrderNumber,
        orderDate: now,
        moId: sourceOrder.moId,
        moNumber: sourceOrder.moNumber || inspection.manufacturingOrder?.moNumber || "",
        mbomHeaderId: sourceOrder.mbomHeaderId || null,
        mbomNoReg: sourceOrder.mbomNoReg || null,
        mbomDetailId: sourceOrder.mbomDetailId || null,
        mbomProcessId: sourceOrder.mbomProcessId || null,
        processId: sourceOrder.processId || null,
        processCode: sourceOrder.processCode || null,
        processName: sourceOrder.processName || null,
        sequence: sourceOrder.sequence || 0,
        vendorCode: sourceOrder.vendorCode || null,
        vendorName: sourceOrder.vendorName || null,
        inputPartId: sourceOrder.inputPartId || null,
        inputPartCode: sourceOrder.inputPartCode || null,
        inputPartNumber: sourceOrder.inputPartNumber || null,
        inputPartName: sourceOrder.inputPartName || null,
        outputPartId: sourceOrder.outputPartId || null,
        outputPartCode: sourceOrder.outputPartCode || null,
        outputPartNumber: sourceOrder.outputPartNumber || null,
        outputPartName: sourceOrder.outputPartName || null,
        spec: sourceOrder.spec || null,
        thickness: sourceOrder.thickness ?? null,
        width: sourceOrder.width ?? null,
        CSP: sourceOrder.CSP || null,
        stockType: sourceOrder.stockType || "WIP",
        qtyPlanned: normalizedQty,
        qtySent: 0,
        qtyReceived: 0,
        qtyAccepted: 0,
        qtyReject: 0,
        qtyRework: 0,
        qtyScrap: 0,
        uomCode: sourceOrder.uomCode || null,
        vendorPriceListId: sourceOrder.vendorPriceListId || null,
        vendorRate: sourceOrder.vendorRate || 0,
        vendorCurrency: sourceOrder.vendorCurrency || null,
        plannedVendorCost: Number(sourceOrder.vendorRate || 0) * normalizedQty,
        actualVendorCost: 0,
        sourceWarehouseCode: sourceOrder.sourceWarehouseCode || null,
        sourceRackCode: sourceOrder.sourceRackCode || null,
        sourceLotNumber: sourceOrder.sourceLotNumber || null,
        vendorWarehouseCode: sourceOrder.vendorWarehouseCode || null,
        vendorRackCode: sourceOrder.vendorRackCode || null,
        vendorLotNumber: sourceOrder.vendorLotNumber || null,
        receiveWarehouseCode: sourceOrder.receiveWarehouseCode || null,
        receiveRackCode: sourceOrder.receiveRackCode || null,
        receiveLotNumber: sourceOrder.receiveLotNumber || null,
        dueDate: sourceOrder.dueDate || null,
        status: "Planned",
        isReworkOrder: true,
        reworkSourceType: "QUALITY_INSPECTION",
        reworkReferenceType: "QUALITY_INSPECTION",
        reworkReferenceNumber: inspection.inspectionNumber,
        reworkReferenceLabel: inspection.inspectionNumber,
        notes: null,
        createdBy: performedBy,
      },
      select: { id: true, orderNumber: true, status: true, qtyPlanned: true },
    });

    return {
      type: "VENDOR_PROCESS_ORDER",
      vendorProcessOrder: createdVendorProcessOrder,
      reworkOrderNumber,
    };
  }

  return null;
}

async function normalizeQualityInspectionInput(tx, data, options = {}) {
  const normalized = { ...data };
  normalized.qtyRework = 0;
  let sourceQty = 0;
  let sourceUomCode = null;
  let hasSourceQty = false;

  for (const field of ["woId", "productionLogId", "vendorProcessOrderId", "partId", "batchNumber", "notes"]) {
    if (normalized[field] === "") normalized[field] = null;
  }

  if (normalized.productionLogId && normalized.vendorProcessOrderId) {
    const error = new Error("QC hanya boleh pilih salah satu sumber: Production Log atau Vendor Process Order.");
    error.statusCode = 400;
    throw error;
  }

  if (normalized.woId) {
    const wo = await tx.workOrder.findFirst({
      where: { id: normalized.woId, isDeleted: false },
      select: {
        moId: true,
        outputPartId: true,
        qtyProduced: true,
        qtyGood: true,
        uomCode: true,
        manufacturingOrder: { select: { partId: true, uomCode: true } },
      },
    });

    if (!wo) {
      const error = new Error("Work Order tidak ditemukan.");
      error.statusCode = 404;
      throw error;
    }

    normalized.moId = wo.moId;
    normalized.partId = normalized.partId || wo.outputPartId || wo.manufacturingOrder?.partId || null;

    if (options.defaultQtyFromWo && !Number(normalized.qtyInspected || 0)) {
      normalized.qtyInspected = Number(wo.qtyGood || wo.qtyProduced || 0);
    }
    sourceQty = Number(wo.qtyGood || wo.qtyProduced || 0);
    hasSourceQty = sourceQty > 0;
    sourceUomCode = wo.uomCode || wo.manufacturingOrder?.uomCode || sourceUomCode;
  }

  if (normalized.productionLogId) {
    const log = await tx.productionLog.findFirst({
      where: { id: normalized.productionLogId, isDeleted: false },
      select: {
        moId: true,
        woId: true,
        qtyProduced: true,
        qtyGood: true,
        qtyReject: true,
        qtyRework: true,
        status: true,
        workOrder: { select: { outputPartId: true, uomCode: true } },
        manufacturingOrder: { select: { partId: true, uomCode: true } },
      },
    });

    if (!log) {
      const error = new Error("Production Log tidak ditemukan.");
      error.statusCode = 404;
      throw error;
    }
    if (log.status !== "Approved") {
      const error = new Error(`Quality Inspection hanya bisa dibuat untuk Production Log Approved. Status Log sekarang "${log.status}".`);
      error.statusCode = 409;
      throw error;
    }

    normalized.moId = log.moId || normalized.moId;
    normalized.woId = log.woId || normalized.woId || null;
    normalized.partId = normalized.partId || log.workOrder?.outputPartId || log.manufacturingOrder?.partId || null;

    const remainingQcQty = await getProductionLogRemainingQcQty(
      tx,
      normalized.productionLogId,
      options.excludeInspectionId || null,
    );
    if (options.defaultQtyFromLog && !Number(normalized.qtyInspected || 0)) {
      normalized.qtyInspected = remainingQcQty;
    }
    sourceQty = remainingQcQty;
    hasSourceQty = true;
    sourceUomCode = log.workOrder?.uomCode || log.manufacturingOrder?.uomCode || sourceUomCode;
  }

  if (normalized.vendorProcessOrderId) {
    const vendorOrder = await tx.vendorProcessOrder.findFirst({
      where: { id: normalized.vendorProcessOrderId, isDeleted: false },
      select: {
        id: true,
        moId: true,
        qtyReceived: true,
        status: true,
        outputPartId: true,
        uomCode: true,
      },
    });

    if (!vendorOrder) {
      const error = new Error("Vendor Process Order tidak ditemukan.");
      error.statusCode = 404;
      throw error;
    }
    if (!["QC Hold", "Partial Received", "Completed"].includes(vendorOrder.status)) {
      const error = new Error(`Quality Inspection vendor hanya bisa dibuat setelah barang diterima. Status sekarang "${vendorOrder.status}".`);
      error.statusCode = 409;
      throw error;
    }

    normalized.moId = vendorOrder.moId || normalized.moId;
    normalized.woId = normalized.woId || null;
    normalized.partId = vendorOrder.outputPartId || normalized.partId || null;

    const remainingQcQty = await getVendorProcessRemainingQcQty(
      tx,
      normalized.vendorProcessOrderId,
      options.excludeInspectionId || null,
    );
    if (options.defaultQtyFromVendorProcess && !Number(normalized.qtyInspected || 0)) {
      normalized.qtyInspected = remainingQcQty;
    }
    sourceQty = remainingQcQty;
    hasSourceQty = true;
    sourceUomCode = vendorOrder.uomCode || sourceUomCode;
  }

  delete normalized.inspectionNumber;
  delete normalized.status;
  delete normalized.approvedBy;
  delete normalized.approvedAt;

  if (!normalized.moId) {
    const error = new Error("MO Number wajib diisi.");
    error.statusCode = 400;
    throw error;
  }

  for (const field of ["qtyInspected", "qtyPassed", "qtyFailed"]) {
    if (normalized[field] !== undefined && normalized[field] !== null && normalized[field] !== "") {
      assertQuantity(normalized[field], normalized.uomCode || sourceUomCode, field);
    }
  }
  validateQualityInspectionQty(normalized, { sourceQty, hasSourceQty, uomCode: sourceUomCode });
  normalized.decision = calculateDecision(normalized);
  normalized.qtyRework = 0;

  return normalized;
}

exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      page = 1,
      limit = 20,
      moId,
      woId,
      productionLogId,
      vendorProcessOrderId,
      partId,
      decision,
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

    if (moId) where.moId = moId;
    if (woId) where.woId = woId;
    if (productionLogId) where.productionLogId = productionLogId;
    if (vendorProcessOrderId) where.vendorProcessOrderId = vendorProcessOrderId;
    if (partId) where.partId = partId;
    if (decision) where.decision = decision;
    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;

    if (startDate || endDate) {
      where.inspectionDate = {};
      if (startDate) where.inspectionDate.gte = new Date(startDate);
      if (endDate) where.inspectionDate.lte = new Date(endDate);
    }

    if (q) {
      where.OR = [
        { inspectionNumber: { contains: q, mode: "insensitive" } },
        { inspectedBy: { contains: q, mode: "insensitive" } },
        { batchNumber: { contains: q, mode: "insensitive" } },
        { notes: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query, { defaultSort: { inspectionDate: "desc" } });
    const skip = (Number(page) - 1) * Number(limit);

    const [items, total] = await Promise.all([
      prisma.qualityInspection.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
        include: {
          manufacturingOrder: {
            select: {
              moNumber: true,
              status: true,
              uomCode: true,
              part: { select: { partCode: true, partNumber: true, partName: true } },
            },
          },
          workOrder: { select: { woNumber: true, uomCode: true } },
          productionLog: {
            select: {
              logNumber: true,
              shift: true,
              qtyProduced: true,
              qtyGood: true,
              qtyReject: true,
            },
          },
          vendorProcessOrder: {
            select: {
              orderNumber: true,
              vendorCode: true,
              vendorName: true,
              processCode: true,
              processName: true,
              stockType: true,
              uomCode: true,
            },
          },
          part: {
            select: {
              partCode: true,
              partNumber: true,
              partName: true,
              material: { select: { materialCode: true, materialType: true, spec: true } },
              partBases: {
                select: { baseOn: true, CSP: true, thickness: true, width: true },
                orderBy: { createdAt: "desc" },
              },
            },
          },
          _count: { select: { details: true } },
        },
      }),
      prisma.qualityInspection.count({ where }),
    ]);

    const sourceReferences = [
      ...items
        .map((item) => item.productionLog?.logNumber
          ? { type: "PRODUCTION_LOG", number: item.productionLog.logNumber }
          : null)
        .filter(Boolean),
      ...items
        .map((item) => item.vendorProcessOrder?.orderNumber
          ? { type: "VENDOR_PROCESS_ORDER", number: item.vendorProcessOrder.orderNumber }
          : null)
        .filter(Boolean),
    ];
    const qcHoldMovements = sourceReferences.length > 0
      ? await prisma.stockMovement.findMany({
          where: {
            OR: sourceReferences.map((source) => ({
              referenceType: source.type,
              referenceNumber: source.number,
            })),
            transactionType: "QC_HOLD",
            isDeleted: false,
          },
          orderBy: { createdAt: "desc" },
          select: {
            referenceType: true,
            referenceNumber: true,
            warehouseCode: true,
            rackCode: true,
            lotNumber: true,
            notes: true,
          },
        })
      : [];
    const qcHoldByLogNumber = new Map();
    const qcRejectHoldByLogNumber = new Map();
    for (const movement of qcHoldMovements) {
      const key = `${movement.referenceType}:${movement.referenceNumber}`;
      const location = {
        warehouseCode: movement.warehouseCode,
        rackCode: movement.rackCode,
        lotNumber: movement.lotNumber,
      };
      const isRejectMovement = movement.referenceType === "PRODUCTION_LOG"
        && (
          movement.rackCode === "RACK-REJECT"
          || movement.qualityBucket === "NG"
        );
      if (isRejectMovement && !qcRejectHoldByLogNumber.has(key)) {
        qcRejectHoldByLogNumber.set(key, location);
      }
      if (!isRejectMovement && !qcHoldByLogNumber.has(key)) {
        qcHoldByLogNumber.set(key, {
          ...location,
        });
      }
    }

    res.json({
      items: items.map((item) => ({
        ...mapDoc(item),
        qcSourceLocation: qcHoldByLogNumber.get(
          item.productionLog?.logNumber
            ? `PRODUCTION_LOG:${item.productionLog.logNumber}`
            : item.vendorProcessOrder?.orderNumber
              ? `VENDOR_PROCESS_ORDER:${item.vendorProcessOrder.orderNumber}`
              : "",
        ) || null,
        qcRejectSourceLocation: qcRejectHoldByLogNumber.get(
          item.productionLog?.logNumber
            ? `PRODUCTION_LOG:${item.productionLog.logNumber}`
            : "",
        ) || null,
      })),
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
    const doc = await prisma.qualityInspection.findFirst({
      where: { inspectionNumber: req.params.inspectionNumber, isDeleted: false },
      include: {
        manufacturingOrder: {
          select: {
            moNumber: true,
            status: true,
            qtyPlanned: true,
            uomCode: true,
            part: { select: { partCode: true, partNumber: true, partName: true } },
          },
        },
        workOrder: { select: { woNumber: true, machineId: true, shift: true, uomCode: true, machine: { select: { machineCode: true, machineName: true } } } },
        productionLog: {
          select: {
            id: true,
            logNumber: true,
            shift: true,
            machineCode: true,
            qtyProduced: true,
            qtyGood: true,
            qtyReject: true,
          },
        },
        vendorProcessOrder: {
          select: {
            orderNumber: true,
            vendorCode: true,
            vendorName: true,
            processCode: true,
            processName: true,
            stockType: true,
            uomCode: true,
          },
        },
        part: {
          select: {
            partCode: true,
            partNumber: true,
            partName: true,
            material: { select: { materialCode: true, materialType: true, spec: true } },
            partBases: {
              select: { baseOn: true, CSP: true, thickness: true, width: true },
              orderBy: { createdAt: "desc" },
            },
          },
        },
        details: { orderBy: { lineNumber: "asc" } },
      },
    });

    if (!doc) return res.status(404).json({ message: "Data Inspeksi QC tidak ditemukan." });

    const sourceMovements = await getQualityInspectionSourceMovements(prisma, doc);
    const mappedDoc = mapDoc(doc);
    if (mappedDoc.productionLogId && mappedDoc.productionLog) {
      mappedDoc.productionLog.qcRemainingQty = await getProductionLogRemainingQcQty(
        prisma,
        mappedDoc.productionLogId,
        mappedDoc.id,
      );
    }
    mappedDoc.qcSourceLocation = toLocationSnapshot(sourceMovements.goodSource);
    mappedDoc.qcRejectSourceLocation = toLocationSnapshot(sourceMovements.rejectSource);

    res.json(mappedDoc);
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { details = [], inspectionDate, ...data } = req.body;

    const inspectionNumber = await generateQcNumber();

    const doc = await prisma.$transaction(async (tx) => {
      const normalized = await normalizeQualityInspectionInput(tx, data, {
        defaultQtyFromLog: true,
        defaultQtyFromWo: true,
        defaultQtyFromVendorProcess: true,
      });

      const created = await tx.qualityInspection.create({
        data: {
          ...normalized,
          inspectionNumber,
          inspectionDate: inspectionDate ? new Date(inspectionDate) : new Date(),
          ...buildAutoCompletionData(normalized),
        },
      });

      if (details.length > 0) {
        await tx.qualityInspectionDetail.createMany({
          data: details.map((d, idx) => ({
            inspectionId: created.id,
            lineNumber: d.lineNumber ?? idx + 1,
            parameterName: d.parameterName,
            standard: d.standard ?? null,
            actualValue: d.actualValue ?? null,
            unit: d.unit ?? null,
            isPass: d.isPass !== undefined ? d.isPass : true,
            notes: d.notes ?? null,
          })),
        });
      }

      const automation = { workOrder: null, vendorProcessOrder: null };
      if (created.status === "Completed" && created.woId) {
        automation.workOrder = await syncWorkOrderFromCompletedQc(
          tx,
          created.woId,
          req.user?.username || "system",
        );
      }
      if (created.status === "Completed" && created.vendorProcessOrderId) {
        automation.vendorProcessOrder = await syncVendorProcessFromCompletedQc(
          tx,
          created.vendorProcessOrderId,
        );
      }

      const doc = await tx.qualityInspection.findUnique({
        where: { id: created.id },
        include: {
          manufacturingOrder: {
            select: { moNumber: true, part: { select: { partCode: true, partName: true } } },
          },
          workOrder: { select: { woNumber: true, uomCode: true } },
          vendorProcessOrder: {
            select: {
              orderNumber: true,
              vendorCode: true,
              vendorName: true,
              processCode: true,
              processName: true,
              stockType: true,
              uomCode: true,
            },
          },
          details: { orderBy: { lineNumber: "asc" } },
        },
      });
      doc.automation = automation;
      return doc;
    });

    const syncedMo = doc.automation?.workOrder?.manufacturingOrder
      || doc.automation?.vendorProcessOrder?.manufacturingOrder;
    if (syncedMo) {
      emitManufacturingOrderUpdate(
        syncedMo,
        "sync",
        req.user?.username || "system",
      );
    }
    res.status(201).json(mapDoc(doc));
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ message: "Nomor Inspeksi QC sudah digunakan." });
    }
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const { details, inspectionDate, ...data } = req.body;

    const updateData = { ...data };
    if (inspectionDate !== undefined) updateData.inspectionDate = inspectionDate ? new Date(inspectionDate) : null;

    const existing = await prisma.qualityInspection.findFirst({
      where: { inspectionNumber: req.params.inspectionNumber, isDeleted: false },
      select: { id: true, status: true },
    });
    if (!existing) return res.status(404).json({ message: "Data Inspeksi QC tidak ditemukan." });
    if (existing.status === "Completed") {
      return res.status(409).json({ message: "Inspeksi QC yang sudah selesai tidak bisa diedit." });
    }

    const doc = await prisma.$transaction(async (tx) => {
      const normalized = await normalizeQualityInspectionInput(tx, updateData, {
        defaultQtyFromLog: false,
        defaultQtyFromWo: false,
        defaultQtyFromVendorProcess: false,
        excludeInspectionId: existing.id,
      });

      const updated = await tx.qualityInspection.update({
        where: { id: existing.id },
        data: {
          ...normalized,
          ...buildAutoCompletionData(normalized),
        },
      });

      // Jika details dikirim, hapus yang lama dan buat ulang
      if (Array.isArray(details)) {
        await tx.qualityInspectionDetail.deleteMany({ where: { inspectionId: existing.id } });
        if (details.length > 0) {
          await tx.qualityInspectionDetail.createMany({
            data: details.map((d, idx) => ({
              inspectionId: existing.id,
              lineNumber: d.lineNumber ?? idx + 1,
              parameterName: d.parameterName,
              standard: d.standard ?? null,
              actualValue: d.actualValue ?? null,
              unit: d.unit ?? null,
              isPass: d.isPass !== undefined ? d.isPass : true,
              notes: d.notes ?? null,
            })),
          });
        }
      }

      let automation = null;
      if (updated.status === "Completed" && updated.woId) {
        automation = await syncWorkOrderFromCompletedQc(
          tx,
          updated.woId,
          req.user?.username || "system",
        );
      }

      const doc = await tx.qualityInspection.findUnique({
        where: { id: updated.id },
        include: {
          manufacturingOrder: {
            select: { moNumber: true, part: { select: { partCode: true, partName: true } } },
          },
          workOrder: { select: { woNumber: true, uomCode: true } },
          details: { orderBy: { lineNumber: "asc" } },
        },
      });
      doc.automation = { workOrder: automation };
      return doc;
    });

    res.json(mapDoc(doc));
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return res.status(404).json({ message: "Data Inspeksi QC tidak ditemukan." });
    }
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.qualityInspection.findUnique({
        where: { inspectionNumber: req.params.inspectionNumber },
        include: {
          productionLog: { select: { logNumber: true } },
          vendorProcessOrder: { select: { orderNumber: true } },
        },
      });

      if (!existing) {
        throw Object.assign(new Error("Data Inspeksi QC tidak ditemukan."), { statusCode: 404 });
      }
      if (existing.isDeleted) {
        throw Object.assign(new Error("Data Inspeksi QC sudah dihapus."), { statusCode: 409 });
      }

      const blockers = await getQualityInspectionDeleteBlockers(tx, existing);
      if (blockers.length > 0) {
        throw Object.assign(
          new Error(`Inspeksi QC tidak bisa dihapus karena sudah punya data terkait: ${formatRelationList(blockers)}.`),
          { statusCode: 409 },
        );
      }

      const rollback = await rollbackQualityInspectionStock(tx, existing);
      await tx.qualityInspection.updateMany({
        where: { id: existing.id, isDeleted: false },
        data: { isDeleted: true },
      });
      const automation = await rollbackQualityInspectionAutomation(tx, existing);
      return { ok: true, rollback, automation };
    });

    res.json(result);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
    next(e);
  }
};

exports.bulkRemove = async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids array required" });
    }

    const records = await prisma.qualityInspection.findMany({
      where: { id: { in: ids }, isDeleted: false },
      select: { id: true, inspectionNumber: true },
    });

    let deletedCount = 0;
    const skipped = [];
    for (const inspection of records) {
      try {
        await prisma.$transaction(async (tx) => {
          const current = await tx.qualityInspection.findUnique({
            where: { id: inspection.id },
            include: {
              productionLog: { select: { logNumber: true } },
              vendorProcessOrder: { select: { orderNumber: true } },
            },
          });
          if (!current || current.isDeleted) return;
          const blockers = await getQualityInspectionDeleteBlockers(tx, current);
          if (blockers.length > 0) {
            throw Object.assign(new Error(formatRelationList(blockers)), { statusCode: 409 });
          }
          await rollbackQualityInspectionStock(tx, current);
          await tx.qualityInspection.updateMany({
            where: { id: current.id, isDeleted: false },
            data: { isDeleted: true },
          });
          await rollbackQualityInspectionAutomation(tx, current);
          deletedCount += 1;
        });
      } catch (error) {
        skipped.push({
          inspectionNumber: inspection.inspectionNumber,
          reason: error.statusCode ? error.message : error.message || "Rollback failed",
        });
      }
    }

    if (deletedCount === 0) {
      const reasonMessage = skipped.length > 0
        ? skipped.map(item => `${item.inspectionNumber}: ${item.reason}`).join("; ")
        : "Tidak ada QC yang bisa dihapus.";
      return res.status(409).json({
        message: `Tidak ada QC yang bisa dihapus. ${reasonMessage}`,
        skipped,
      });
    }

    res.json({ deletedCount, skipped });
  } catch (e) {
    next(e);
  }
};

// ============================================================
// HELPER ROUTES & STATUS TRANSITIONS
// ============================================================

exports.generateNumber = async (req, res, next) => {
  try {
    const inspectionNumber = await generateQcNumber();
    res.json({ inspectionNumber });
  } catch (e) { next(e); }
};

// Draft → Completed (+ auto scrap disposition & rework loop)
exports.complete = async (req, res, next) => {
  try {
    const {
      approvedBy,
      decision,
      warehouseCode,
      rackCode,
      passedDestination,
      failedDestination,
      reworkDestination,
      ngDisposition,
    } = req.body || {};
    const existing = await prisma.qualityInspection.findUnique({
      where: { inspectionNumber: req.params.inspectionNumber },
      include: {
        manufacturingOrder: {
          select: {
            id: true, moNumber: true, partId: true, uomCode: true,
            part: {
              select: {
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
          },
        },
        workOrder: {
          select: {
            id: true,
            woNumber: true,
            machineId: true,
            processId: true,
            mbomDetailId: true,
            moId: true,
            sequence: true,
            cycleTime: true,
            machineCostingRate: true,
            machineRateType: true,
            machineCurrency: true,
            outputPartId: true,
            outputPartCode: true,
            outputPartNumber: true,
            outputPartName: true,
            notes: true,
            uomCode: true,
          },
        },
        productionLog: { select: { id: true, logNumber: true, qtyReject: true } },
        vendorProcessOrder: {
          select: {
            id: true,
            orderNumber: true,
            moId: true,
            moNumber: true,
            mbomHeaderId: true,
            mbomNoReg: true,
            mbomDetailId: true,
            mbomProcessId: true,
            processId: true,
            sequence: true,
            qtyPlanned: true,
            qtyReceived: true,
            qtyAccepted: true,
            qtyReject: true,
            qtyRework: true,
            qtyScrap: true,
            status: true,
            processCode: true,
            processName: true,
            vendorCode: true,
            vendorName: true,
            inputPartId: true,
            inputPartCode: true,
            inputPartNumber: true,
            inputPartName: true,
            outputPartId: true,
            outputPartCode: true,
            outputPartNumber: true,
            outputPartName: true,
            spec: true,
            thickness: true,
            width: true,
            CSP: true,
            stockType: true,
            uomCode: true,
            vendorPriceListId: true,
            vendorRate: true,
            vendorCurrency: true,
            sourceWarehouseCode: true,
            sourceRackCode: true,
            sourceLotNumber: true,
            vendorWarehouseCode: true,
            vendorRackCode: true,
            vendorLotNumber: true,
            receiveWarehouseCode: true,
            receiveRackCode: true,
            receiveLotNumber: true,
            dueDate: true,
          },
        },
      },
    });
    if (!existing || existing.isDeleted) return res.status(404).json({ message: "Data Inspeksi QC tidak ditemukan." });
    if (existing.status === "Completed") {
      const automation = await prisma.$transaction(async (tx) => ({
        workOrder: await syncWorkOrderFromCompletedQc(tx, existing.woId, req.user?.username || "system"),
        vendorProcessOrder: await syncVendorProcessFromCompletedQc(tx, existing.vendorProcessOrderId),
      }));
      const syncedMo = automation.workOrder?.manufacturingOrder
        || automation.vendorProcessOrder?.manufacturingOrder;
      if (syncedMo) {
        emitManufacturingOrderUpdate(
          syncedMo,
          "sync",
          req.user?.username || "system",
        );
      }
      existing.automation = automation;
      return res.json(mapDoc(existing));
    }

    const finalDecision = decision || calculateDecision(existing) || existing.decision || "Pending";
    const qtyFailed = Number(existing.qtyFailed || 0);
    const productionLogNgQty = Number(existing.productionLog?.qtyReject || 0);
    const totalNgQty = productionLogNgQty + qtyFailed;
    const requestedNgDisposition = ngDisposition || {};
    const normalizedNgMode = String(requestedNgDisposition.mode || "LATER").trim().toUpperCase() === "NOW"
      ? "NOW"
      : "LATER";
    const requestedReworkQty = normalizedNgMode === "NOW"
      ? Math.max(0, Number(requestedNgDisposition.reworkDestination?.qty || 0))
      : 0;
    const reworkAction = String(requestedNgDisposition.reworkAction || "RACK_ONLY").trim().toUpperCase() === "AUTO_ORDER"
      ? "AUTO_ORDER"
      : "RACK_ONLY";

    const doc = await prisma.$transaction(async (tx) => {
      const updated = await tx.qualityInspection.update({
        where: { id: existing.id },
        data: {
          status: "Completed",
          approvedBy: approvedBy || req.user?.username || "system",
          approvedAt: new Date(),
          decision: finalDecision,
        },
        include: {
          details: { orderBy: { lineNumber: "asc" } },
          manufacturingOrder: { select: { moNumber: true, uomCode: true, part: { select: { partCode: true, partName: true } } } },
        },
      });

      const now = new Date();
      const mo = existing.manufacturingOrder;
      const part = mo?.part;
      const stockIdentity = part ? buildPartStockIdentity(part) : {};
      const qcMovements = await applyProductionLogQcDisposition(
        tx,
        { ...existing, decision: finalDecision },
        {
          passed: passedDestination || {
            warehouseCode,
            rackCode,
          },
          failed: failedDestination || {},
          rework: reworkDestination || {},
          ng: {
            mode: normalizedNgMode,
            rejectDestination: requestedNgDisposition.rejectDestination || failedDestination || {
              warehouseCode: "WH-001",
              rackCode: "RACK-REJECT",
              qty: totalNgQty,
            },
            scrapDestination: requestedNgDisposition.scrapDestination || {
              warehouseCode: "WH-001",
              rackCode: "RACK-SCRAP",
              qty: 0,
            },
            reworkDestination: requestedNgDisposition.reworkDestination || {
              warehouseCode: "WH-001",
              rackCode: "RACK-REWORK",
              qty: 0,
            },
            reworkAction,
          },
        },
        req.user?.username || "system",
      );

      // ── REJECT DISPOSITION ──
      // Jika decision Rejected dan ada qty gagal, buat StockMovement REJECT
      if (!existing.productionLogId && finalDecision === "Rejected" && qtyFailed > 0 && part && warehouseCode) {
        const rejectMovementNumber = await generateMovementNumber("OUT", tx);
        await tx.stockMovement.create({
          data: {
            movementNumber: rejectMovementNumber,
            movementDate: now,
            movementType: "OUT",
            direction: "OUT",
            transactionType: "REJECT",
            warehouseCode,
            rackCode: rackCode || null,
            partCode: part.partCode,
            partNumber: part.partNumber || null,
            partName: part.partName || null,
            ...stockIdentity,
            stockType: "Finished Goods",
            qty: qtyFailed,
            deltaQty: -qtyFailed,
            qtyBefore: 0,
            qtyAfter: 0,
            uomCode: mo?.uomCode || null,
            qualityBucket: "NG",
            referenceType: "QUALITY_INSPECTION",
            referenceNumber: existing.inspectionNumber,
            notes: `Reject disposition dari QI ${existing.inspectionNumber}`,
            performedBy: req.user?.username || "system",
          },
        });
      }

      if (requestedReworkQty > 0 && reworkAction === "AUTO_ORDER") {
        const automationResult = await createQualityInspectionReworkAutomation(
          tx,
          existing,
          requestedReworkQty,
          req.user?.username || "system",
        );
        if (automationResult?.reworkWoNumber) {
          updated.reworkWoNumber = automationResult.reworkWoNumber;
        }
        if (automationResult?.reworkOrderNumber) {
          updated.reworkOrderNumber = automationResult.reworkOrderNumber;
        }
      }

      updated.automation = {
        workOrder: await syncWorkOrderFromCompletedQc(
          tx,
          existing.woId,
          req.user?.username || "system",
        ),
        vendorProcessOrder: await syncVendorProcessFromCompletedQc(
          tx,
          existing.vendorProcessOrderId,
        ),
      };

      return { ...updated, qcMovements };
    });

    if (doc.automation?.workOrder?.manufacturingOrder) {
      emitManufacturingOrderUpdate(
        doc.automation.workOrder.manufacturingOrder,
        "sync",
        req.user?.username || "system",
      );
    }
    res.json(mapDoc(doc));
  } catch (e) { next(e); }
};

exports.pendingFgReceipts = async (req, res, next) => {
  try {
    const { q, moId, page = 1, limit = 50 } = req.query;
    const where = {
      isDeleted: false,
      status: "Completed",
      productionLogId: { not: null },
      qtyPassed: { gt: 0 },
      ...(moId ? { moId } : {}),
    };

    if (q && String(q).trim()) {
      const query = String(q).trim();
      where.OR = [
        { inspectionNumber: { contains: query, mode: "insensitive" } },
        { manufacturingOrder: { moNumber: { contains: query, mode: "insensitive" } } },
        { workOrder: { woNumber: { contains: query, mode: "insensitive" } } },
        { productionLog: { logNumber: { contains: query, mode: "insensitive" } } },
      ];
    }

    const candidates = await prisma.qualityInspection.findMany({
      where,
      orderBy: [{ approvedAt: "desc" }, { inspectionDate: "desc" }],
      include: {
        manufacturingOrder: {
          select: {
            id: true,
            moNumber: true,
            uomCode: true,
            part: {
              select: {
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
          },
        },
        workOrder: {
          select: {
            id: true,
            woNumber: true,
            moId: true,
            sequence: true,
            uomCode: true,
          },
        },
        productionLog: { select: { logNumber: true } },
      },
    });

    const rows = [];
    const pendingMoIds = new Set();
    for (const inspection of candidates) {
      const row = await buildFgReceiptRow(prisma, inspection);
      if (row) {
        rows.push(row);
        if (inspection.manufacturingOrder?.id) {
          pendingMoIds.add(inspection.manufacturingOrder.id);
        }
      }
    }

    // Non-component FG is an in-house receipt milestone and intentionally has
    // no routing process of its own. Keep it visible in FG Receipt while its
    // child/final WIP, Production Log, and QC are still being completed.
    const readyQtyByMoId = new Map();
    rows.forEach((row) => {
      if (!row.moId) return;
      readyQtyByMoId.set(row.moId, Number(readyQtyByMoId.get(row.moId) || 0) + Number(row.qtyPending || 0));
    });
    const trackingRows = await buildNonComponentFgTrackingRows(prisma, { q, moId });
    trackingRows.forEach((row) => {
      const waitingQty = Math.max(0, Number(row.qtyPending || 0) - Number(readyQtyByMoId.get(row.moId) || 0));
      if (waitingQty > 0.000001) rows.push({ ...row, qtyPending: waitingQty });
    });
    rows.sort((left, right) => {
      const leftReady = left.actionable ? 0 : 1;
      const rightReady = right.actionable ? 0 : 1;
      if (leftReady !== rightReady) return leftReady - rightReady;
      return new Date(left.inspectionDate || left.dueDate || 0) - new Date(right.inspectionDate || right.dueDate || 0);
    });

    for (const pendingMoId of pendingMoIds) {
      const syncedMo = await syncManufacturingOrderQtyFromWorkOrders(prisma, pendingMoId);
      if (syncedMo) {
        emitManufacturingOrderUpdate(
          syncedMo,
          "sync",
          req.user?.username || "system",
        );
      }
    }

    const start = (Number(page) - 1) * Number(limit);
    const items = rows.slice(start, start + Number(limit));

    res.json({
      items,
      total: rows.length,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (e) {
    next(e);
  }
};

exports.fgReceiptHistory = async (req, res, next) => {
  try {
    const { q, page = 1, limit = 50 } = req.query;
    const where = {
      referenceType: "QUALITY_INSPECTION",
      transactionType: "PRODUCTION",
      movementType: "IN",
      stockType: "Finished Goods",
      isDeleted: false,
    };

    if (q && String(q).trim()) {
      const query = String(q).trim();
      const matchedInspections = await prisma.qualityInspection.findMany({
        where: {
          isDeleted: false,
          OR: [
            { inspectionNumber: { contains: query, mode: "insensitive" } },
            { manufacturingOrder: { moNumber: { contains: query, mode: "insensitive" } } },
            { workOrder: { woNumber: { contains: query, mode: "insensitive" } } },
            { productionLog: { logNumber: { contains: query, mode: "insensitive" } } },
          ],
        },
        select: { inspectionNumber: true },
        take: 1000,
      });
      const matchedInspectionNumbers = matchedInspections.map((inspection) => inspection.inspectionNumber);
      where.OR = [
        { movementNumber: { contains: query, mode: "insensitive" } },
        { referenceNumber: { contains: query, mode: "insensitive" } },
        ...(matchedInspectionNumbers.length > 0
          ? [{ referenceNumber: { in: matchedInspectionNumbers } }]
          : []),
        { partCode: { contains: query, mode: "insensitive" } },
        { partNumber: { contains: query, mode: "insensitive" } },
        { partName: { contains: query, mode: "insensitive" } },
        { warehouseCode: { contains: query, mode: "insensitive" } },
        { rackCode: { contains: query, mode: "insensitive" } },
        { lotNumber: { contains: query, mode: "insensitive" } },
        { notes: { contains: query, mode: "insensitive" } },
      ];
    }

    const currentPage = Math.max(1, Number(page) || 1);
    const take = Math.max(1, Number(limit) || 50);
    const skip = (currentPage - 1) * take;

    const [movements, total] = await Promise.all([
      prisma.stockMovement.findMany({
        where,
        orderBy: [{ movementDate: "desc" }, { createdAt: "desc" }],
        skip,
        take,
        select: {
          id: true,
          movementNumber: true,
          movementDate: true,
          referenceNumber: true,
          warehouseCode: true,
          rackCode: true,
          lotNumber: true,
          partCode: true,
          partNumber: true,
          partName: true,
          stockType: true,
          qty: true,
          uomCode: true,
          notes: true,
          performedBy: true,
        },
      }),
      prisma.stockMovement.count({ where }),
    ]);

    const inspectionNumbers = [...new Set(movements.map((movement) => movement.referenceNumber).filter(Boolean))];
    const inspections = inspectionNumbers.length > 0
      ? await prisma.qualityInspection.findMany({
          where: { inspectionNumber: { in: inspectionNumbers } },
          select: {
            inspectionNumber: true,
            qtyPassed: true,
            manufacturingOrder: { select: { moNumber: true, uomCode: true } },
            workOrder: { select: { woNumber: true, moId: true } },
            productionLog: { select: { logNumber: true } },
          },
        })
      : [];
    const inspectionByNumber = new Map(inspections.map((inspection) => [inspection.inspectionNumber, inspection]));
    const sourceWipsByInspectionNumber = new Map(
      await Promise.all(
        inspections.map(async (inspection) => [
          inspection.inspectionNumber,
          await getMoQcHoldWipSources(prisma, inspection),
        ]),
      ),
    );

    const items = movements.map((movement) => {
      const inspection = inspectionByNumber.get(movement.referenceNumber) || {};
      return {
        id: movement.id,
        movementNumber: movement.movementNumber,
        receivedAt: movement.movementDate,
        inspectionNumber: movement.referenceNumber,
        moNumber: inspection.manufacturingOrder?.moNumber || null,
        woNumber: inspection.workOrder?.woNumber || null,
        productionLogNumber: inspection.productionLog?.logNumber || null,
        sourcePart: null,
        sourceWips: sourceWipsByInspectionNumber.get(movement.referenceNumber) || [],
        fgPart: {
          partCode: movement.partCode,
          partNumber: movement.partNumber,
          partName: movement.partName,
          stockType: movement.stockType,
        },
        qtyPassed: Number(inspection.qtyPassed || 0),
        qtyReceived: Number(movement.qty || 0),
        qtyPending: 0,
        uomCode: movement.uomCode || null,
        sourceLocation: null,
        targetLocation: {
          warehouseCode: movement.warehouseCode || null,
          rackCode: movement.rackCode || null,
          lotNumber: movement.lotNumber || null,
        },
        notes: movement.notes || null,
        performedBy: movement.performedBy || null,
      };
    });

    res.json({
      items,
      total,
      page: currentPage,
      limit: take,
    });
  } catch (e) {
    next(e);
  }
};

exports.fgReceiptDetail = async (req, res, next) => {
  try {
    const movement = await prisma.stockMovement.findFirst({ where: { movementNumber: req.params.movementNumber, referenceType: "QUALITY_INSPECTION", transactionType: "PRODUCTION", movementType: "IN", stockType: "Finished Goods", isDeleted: false } });
    if (!movement) return res.status(404).json({ message: "FG Receipt tidak ditemukan." });
    res.json(mapDoc({ ...movement, qtyReceived: movement.qty, receivedAt: movement.movementDate, targetLocation: { warehouseCode: movement.warehouseCode, rackCode: movement.rackCode, lotNumber: movement.lotNumber }, fgPart: { partCode: movement.partCode, partNumber: movement.partNumber, partName: movement.partName, stockType: movement.stockType } }));
  } catch (error) { next(error); }
};

exports.receiveFg = async (req, res, next) => {
  try {
    const {
      qty,
      warehouseCode,
      rackCode,
      lotNumber,
      notes,
    } = req.body || {};

    const targetWarehouseCode = typeof warehouseCode === "string" ? warehouseCode.trim() : "";
    if (!targetWarehouseCode) {
      return res.status(400).json({ message: "warehouseCode wajib untuk FG Receipt." });
    }

    const result = await prisma.$transaction(async (tx) => {
      const inspection = await tx.qualityInspection.findUnique({
        where: { inspectionNumber: req.params.inspectionNumber },
        include: {
          manufacturingOrder: {
            select: {
              id: true,
              moNumber: true,
              plannedOrderNumber: true,
              parentMoNumber: true,
              rootMoNumber: true,
              uomCode: true,
              part: {
                select: {
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
            },
          },
          workOrder: {
            select: {
              id: true,
              woNumber: true,
              moId: true,
              sequence: true,
              uomCode: true,
            },
          },
          productionLog: { select: { logNumber: true } },
        },
      });

      if (!inspection || inspection.isDeleted) {
        throw Object.assign(new Error("Data Inspeksi QC tidak ditemukan."), { statusCode: 404 });
      }
      if (inspection.status !== "Completed") {
        throw Object.assign(new Error("FG Receipt hanya bisa dari QC Completed."), { statusCode: 409 });
      }

      const pendingRow = await buildFgReceiptRow(tx, inspection);
      if (!pendingRow) {
        throw Object.assign(new Error("Tidak ada qty FG yang pending receipt untuk QC ini."), {
          statusCode: 409,
        });
      }

      const receiptQty = qty === undefined || qty === null || qty === ""
        ? pendingRow.qtyPending
        : Number(qty);
      if (!Number.isFinite(receiptQty) || receiptQty <= 0) {
        throw Object.assign(new Error("qty receipt harus lebih dari 0."), { statusCode: 400 });
      }
      assertQuantity(receiptQty, pendingRow.uomCode, "Qty FG Receipt");
      if (receiptQty - pendingRow.qtyPending > 0.000001) {
        throw Object.assign(
          new Error(`qty receipt melebihi pending FG. Pending: ${pendingRow.qtyPending}.`),
          { statusCode: 400 },
        );
      }

      const sourceMovement = await getFgReceiptSourceMovement(tx, inspection);
      if (!sourceMovement?.warehouseCode || !sourceMovement?.partCode) {
        throw Object.assign(new Error("Movement source WIP release untuk FG Receipt tidak ditemukan."), {
          statusCode: 409,
        });
      }
      const sourceIdentity = buildMovementStockIdentity(sourceMovement);
      const sourceBalance = await tx.stockBalance.findFirst({
        where: {
          warehouseCode: sourceMovement.warehouseCode,
          rackCode: sourceMovement.rackCode || null,
          lotNumber: sourceMovement.lotNumber || null,
          partCode: sourceMovement.partCode,
          ...sourceIdentity,
          uomCode: sourceMovement.uomCode || inspection.manufacturingOrder?.uomCode || null,
          stockType: sourceMovement.stockType || "WIP",
          isDeleted: false,
        },
        select: { id: true, qtyOnHand: true, qtyReserved: true, qtyQC: true, qtyAvailable: true },
      });

      if (!sourceBalance) {
        throw Object.assign(new Error("Stock QC Hold sumber tidak ditemukan."), { statusCode: 409 });
      }
      if (Number(sourceBalance.qtyAvailable || 0) + 0.000001 < receiptQty) {
        throw Object.assign(
          new Error(`Qty WIP release belum cukup untuk FG Receipt. Tersedia: ${sourceBalance.qtyAvailable || 0}.`),
          { statusCode: 409 },
        );
      }

      await assertStockBalanceNotFrozen(tx, sourceBalance.id);
      const now = new Date();
      const sourceQtyBefore = Number(sourceBalance.qtyOnHand || 0);
      const sourceQtyAfter = Math.max(0, sourceQtyBefore - receiptQty);
      const sourceQtyQC = Number(sourceBalance.qtyQC || 0);
      const sourceQtyReserved = Number(sourceBalance.qtyReserved || 0);

      await tx.stockBalance.update({
        where: { id: sourceBalance.id },
        data: {
          qtyOnHand: sourceQtyAfter,
          qtyQC: sourceQtyQC,
          qtyAvailable: Math.max(0, sourceQtyAfter - sourceQtyReserved - sourceQtyQC),
          lastMovement: now,
        },
      });

      const fgMovementSource = buildMovementFromPart(sourceMovement, inspection.manufacturingOrder.part);
      const fgTarget = {
        warehouseCode: targetWarehouseCode,
        rackCode: typeof rackCode === "string" && rackCode.trim() ? rackCode.trim() : null,
        lotNumber: typeof lotNumber === "string" && lotNumber.trim()
          ? lotNumber.trim()
          : sourceMovement.lotNumber || null,
      };
      const targetBalance = await upsertDispositionTargetBalance(
        tx,
        sourceMovement,
        fgTarget,
        receiptQty,
        "Finished Goods",
        { targetMovement: fgMovementSource },
      );

      const performedBy = req.user?.username || "system";
      const sourceMovementNumber = await generateMovementNumber("OUT", tx);
      await tx.stockMovement.create({
        data: {
          movementNumber: sourceMovementNumber,
          movementDate: now,
          movementType: "OUT",
          direction: "OUT",
          transactionType: "PRODUCTION",
          warehouseCode: sourceMovement.warehouseCode,
          rackCode: sourceMovement.rackCode || null,
          lotNumber: sourceMovement.lotNumber || null,
          partCode: sourceMovement.partCode,
          ...sourceIdentity,
          stockType: sourceMovement.stockType || "WIP",
          qty: receiptQty,
          deltaQty: -receiptQty,
          qtyBefore: sourceQtyBefore,
          qtyAfter: sourceQtyAfter,
          uomCode: sourceMovement.uomCode || inspection.manufacturingOrder?.uomCode || null,
          qualityBucket: "GOOD",
          referenceType: "QUALITY_INSPECTION",
          referenceNumber: inspection.inspectionNumber,
          notes: notes || `FG Receipt consume ${sourceMovement.partCode} dari QC ${inspection.inspectionNumber}`,
          performedBy,
        },
      });

      const fgIdentity = buildMovementStockIdentity(fgMovementSource);
      const fgMovementNumber = await generateMovementNumber("IN", tx);
      await tx.stockMovement.create({
        data: {
          movementNumber: fgMovementNumber,
          movementDate: now,
          movementType: "IN",
          direction: "IN",
          transactionType: "PRODUCTION",
          warehouseCode: fgTarget.warehouseCode,
          rackCode: fgTarget.rackCode,
          lotNumber: fgTarget.lotNumber,
          partCode: fgMovementSource.partCode,
          ...fgIdentity,
          stockType: "Finished Goods",
          qty: receiptQty,
          deltaQty: receiptQty,
          qtyBefore: Number(targetBalance?.qtyBefore || 0),
          qtyAfter: Number(targetBalance?.qtyAfter || receiptQty),
          uomCode: sourceMovement.uomCode || inspection.manufacturingOrder?.uomCode || null,
          qualityBucket: "GOOD",
          referenceType: "QUALITY_INSPECTION",
          referenceNumber: inspection.inspectionNumber,
          notes: notes || `FG Receipt ${inspection.manufacturingOrder.moNumber} dari QC ${inspection.inspectionNumber}`,
          performedBy,
        },
      });

      const syncedMo = await syncManufacturingOrderQtyFromWorkOrders(
        tx,
        inspection.manufacturingOrder.id,
      );
      const syncedSalesOrders = await syncSalesOrdersForManufacturingOrder(
        tx,
        syncedMo || inspection.manufacturingOrder,
      );

      return {
        inspectionNumber: inspection.inspectionNumber,
        qtyReceived: receiptQty,
        sourceMovementNumber,
        fgMovementNumber,
        pendingQty: Math.max(0, pendingRow.qtyPending - receiptQty),
        manufacturingOrder: syncedMo,
        salesOrders: syncedSalesOrders,
      };
    });

    res.status(201).json(result);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
    next(e);
  }
};

exports.rollbackFgReceipt = async (req, res, next) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const fgMovement = await tx.stockMovement.findFirst({
        where: {
          movementNumber: req.params.movementNumber,
          referenceType: "QUALITY_INSPECTION",
          transactionType: "PRODUCTION",
          movementType: "IN",
          stockType: "Finished Goods",
          isDeleted: false,
        },
        include: {
          warehouse: { select: { warehouseCode: true } },
        },
      });

      if (!fgMovement) {
        throw Object.assign(new Error("FG Receipt history tidak ditemukan."), { statusCode: 404 });
      }

      const inspection = await tx.qualityInspection.findUnique({
        where: { inspectionNumber: fgMovement.referenceNumber },
        include: {
          manufacturingOrder: {
            select: {
              id: true,
              moNumber: true,
              plannedOrderNumber: true,
              parentMoNumber: true,
              rootMoNumber: true,
              uomCode: true,
              part: {
                select: {
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
            },
          },
          workOrder: { select: { woNumber: true } },
          productionLog: { select: { logNumber: true } },
        },
      });

      if (!inspection || inspection.isDeleted) {
        throw Object.assign(new Error("Data Inspeksi QC sumber FG Receipt tidak ditemukan."), { statusCode: 404 });
      }

      const targetIdentity = buildMovementStockIdentity(fgMovement);
      const targetBalance = await tx.stockBalance.findFirst({
        where: {
          warehouseCode: fgMovement.warehouseCode,
          rackCode: fgMovement.rackCode || null,
          lotNumber: fgMovement.lotNumber || null,
          partCode: fgMovement.partCode,
          ...targetIdentity,
          uomCode: fgMovement.uomCode || null,
          stockType: "Finished Goods",
          isDeleted: false,
        },
        select: { id: true, qtyOnHand: true, qtyReserved: true, qtyQC: true },
      });

      if (!targetBalance) {
        throw Object.assign(new Error("Stock Finished Goods target tidak ditemukan untuk rollback."), { statusCode: 409 });
      }
      if (Number(targetBalance.qtyOnHand || 0) + 0.000001 < Number(fgMovement.qty || 0)) {
        throw Object.assign(
          new Error(`Stock FG target tidak cukup untuk rollback. On hand: ${targetBalance.qtyOnHand || 0}, rollback: ${fgMovement.qty || 0}.`),
          { statusCode: 409 },
        );
      }

      const sourceOutMovement = await tx.stockMovement.findFirst({
        where: {
          referenceType: "QUALITY_INSPECTION",
          referenceNumber: fgMovement.referenceNumber,
          transactionType: "PRODUCTION",
          movementType: "OUT",
          isDeleted: false,
          qty: Number(fgMovement.qty || 0),
          createdAt: { lte: fgMovement.createdAt },
        },
        orderBy: [{ createdAt: "desc" }, { movementDate: "desc" }],
      });

      if (!sourceOutMovement) {
        throw Object.assign(new Error("Movement source WIP untuk FG Receipt ini tidak ditemukan."), { statusCode: 409 });
      }

      const sourceIdentity = buildMovementStockIdentity(sourceOutMovement);
      let sourceBalance = await tx.stockBalance.findFirst({
        where: {
          warehouseCode: sourceOutMovement.warehouseCode,
          rackCode: sourceOutMovement.rackCode || null,
          lotNumber: sourceOutMovement.lotNumber || null,
          partCode: sourceOutMovement.partCode,
          ...sourceIdentity,
          uomCode: sourceOutMovement.uomCode || null,
          stockType: sourceOutMovement.stockType || "WIP",
          isDeleted: false,
        },
        select: { id: true, qtyOnHand: true, qtyReserved: true, qtyQC: true },
      });

      const rollbackQty = Number(fgMovement.qty || 0);
      const now = new Date();
      const performedBy = req.user?.username || "system";

      await assertStockBalanceNotFrozen(tx, targetBalance.id);
      const targetQtyBefore = Number(targetBalance.qtyOnHand || 0);
      const targetQtyAfter = Math.max(0, targetQtyBefore - rollbackQty);
      await tx.stockBalance.update({
        where: { id: targetBalance.id },
        data: {
          qtyOnHand: targetQtyAfter,
          qtyAvailable: Math.max(0, targetQtyAfter - Number(targetBalance.qtyReserved || 0) - Number(targetBalance.qtyQC || 0)),
          lastMovement: now,
        },
      });

      if (sourceBalance) {
        await assertStockBalanceNotFrozen(tx, sourceBalance.id);
        const sourceQtyBefore = Number(sourceBalance.qtyOnHand || 0);
        const sourceQtyAfter = sourceQtyBefore + rollbackQty;
        sourceBalance = await tx.stockBalance.update({
          where: { id: sourceBalance.id },
          data: {
            qtyOnHand: sourceQtyAfter,
            qtyAvailable: Math.max(0, sourceQtyAfter - Number(sourceBalance.qtyReserved || 0) - Number(sourceBalance.qtyQC || 0)),
            lastMovement: now,
          },
          select: { id: true, qtyOnHand: true, qtyReserved: true, qtyQC: true },
        });
      } else {
        sourceBalance = await tx.stockBalance.create({
          data: {
            warehouseCode: sourceOutMovement.warehouseCode,
            rackCode: sourceOutMovement.rackCode || null,
            lotNumber: sourceOutMovement.lotNumber || null,
            partCode: sourceOutMovement.partCode,
            ...sourceIdentity,
            uomCode: sourceOutMovement.uomCode || null,
            stockType: sourceOutMovement.stockType || "WIP",
            qtyOnHand: rollbackQty,
            qtyReserved: 0,
            qtyQC: 0,
            qtyAvailable: rollbackQty,
            lastMovement: now,
          },
          select: { id: true, qtyOnHand: true, qtyReserved: true, qtyQC: true },
        });
      }

      await tx.stockMovement.updateMany({
        where: {
          id: { in: [fgMovement.id, sourceOutMovement.id] },
        },
        data: {
          isDeleted: true,
          notes: `${fgMovement.notes || sourceOutMovement.notes || ""} [ROLLED BACK ${performedBy} ${now.toISOString()}]`.trim(),
        },
      });

      const syncedMo = inspection.manufacturingOrder?.id
        ? await syncManufacturingOrderQtyFromWorkOrders(tx, inspection.manufacturingOrder.id)
        : null;
      const syncedSalesOrders = await syncSalesOrdersForManufacturingOrder(
        tx,
        syncedMo || inspection.manufacturingOrder,
      );

      return {
        movementNumber: fgMovement.movementNumber,
        inspectionNumber: inspection.inspectionNumber,
        moNumber: inspection.manufacturingOrder?.moNumber || null,
        woNumber: inspection.workOrder?.woNumber || null,
        rolledBackQty: rollbackQty,
        manufacturingOrder: syncedMo,
        salesOrders: syncedSalesOrders,
      };
    });

    if (result?.manufacturingOrder) {
      emitManufacturingOrderUpdate(
        result.manufacturingOrder,
        "sync",
        req.user?.username || "system",
      );
    }

    res.json(result);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
    next(e);
  }
};

