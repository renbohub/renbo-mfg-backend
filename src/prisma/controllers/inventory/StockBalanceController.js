const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { generateMovementNumber } = require("../../utils/movementNumberGenerator");
const { generateDailyNumber } = require("../production/services/productionIntegrationHelpers");
const {
  releaseManufacturingOrder,
  generateWorkOrdersFromRouting,
} = require("../production/services/productionWorkflowService");
const {
  generateVendorProcessOrdersFromRouting,
} = require("../production/VendorProcessOrderController");
const {
  emitManufacturingOrderUpdate,
  emitWorkOrderBulkUpdate,
} = require("../production/services/productionRealtimeService");
const {
  buildExcludeSpecialRackCondition,
} = require("./utils/stockReservationHelpers");
const {
  IDENTITY_REQUIRED_MESSAGE,
  normalizeText,
  sanitizeItemIdentityFields,
  resolveItemIdentity,
  resolveItemIdentityInput,
  hasItemIdentity,
  buildIdentityWhere,
  buildIdentityKey,
} = require("./utils/itemIdentity");
const {
  assertStockBalanceNotFrozen,
  assertWarehouseNotFrozen,
} = require("./utils/stockOpnameFreezeGuard");
const { assertQuantity } = require("../../utils/uomQuantity");

const SPECIAL_RACK_PREFIXES = ["RACK-SCRAP", "RACK-REJECT", "RACK-REWORK"];

const buildOnlySpecialRackCondition = () => ({
  OR: SPECIAL_RACK_PREFIXES.map((prefix) => ({
    rackCode: { startsWith: prefix, mode: "insensitive" },
  })),
});

const omitIdentityPayloadFields = ({
  partId,
  partCode,
  productCode,
  productId,
  description,
  partNumber,
  spec,
  thickness,
  width,
  CSP,
  csp,
  product,
  ...rest
} = {}) => rest;

const mapStockBalanceDoc = (stockBalance) =>
  mapDoc(sanitizeItemIdentityFields(stockBalance));

const throwHttpError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
};

const toPositiveQty = (value, label) => {
  const qty = Number(value);
  if (!Number.isFinite(qty) || qty < 0) {
    throwHttpError(`${label} harus berupa angka >= 0`, 400);
  }
  return qty;
};

const normalizeLotValue = (value) => normalizeText(value) || null;

const buildStockIdentityFilter = (stockBalance) => {
  const identity = resolveItemIdentity(stockBalance || {});
  return buildIdentityWhere(identity);
};

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
  if (last?.moNumber) {
    const parts = last.moNumber.split("-");
    seq = parseInt(parts[parts.length - 1], 10) + 1;
  }

  return `${datePrefix}-${String(seq).padStart(3, "0")}`;
}

async function upsertDispositionTargetBalance(tx, stockBalance, target, qty) {
  if (!target.warehouseCode || qty <= 0) return null;

  const where = {
    warehouseCode: target.warehouseCode,
    rackCode: normalizeText(target.rackCode),
    lotNumber: normalizeLotValue(target.lotNumber) || normalizeLotValue(stockBalance.lotNumber),
    partCode: stockBalance.partCode,
    ...buildStockIdentityFilter(stockBalance),
    uomCode: stockBalance.uomCode || null,
    stockType: stockBalance.stockType,
    isDeleted: false,
  };

  const existing = await tx.stockBalance.findFirst({
    where,
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
        qtyOnHand,
        qtyAvailable: Math.max(0, qtyOnHand - qtyReserved - qtyQC),
        lastMovement: new Date(),
      },
    });
    return { ...balance, qtyBefore, qtyAfter: qtyOnHand };
  }

  await assertWarehouseNotFrozen(tx, target.warehouseCode);
  const balance = await tx.stockBalance.create({
    data: {
      warehouseCode: target.warehouseCode,
      rackCode: normalizeText(target.rackCode),
      lotNumber: normalizeLotValue(target.lotNumber) || normalizeLotValue(stockBalance.lotNumber),
      partCode: stockBalance.partCode,
      partNumber: stockBalance.partNumber || null,
      partName: stockBalance.partName || null,
      productId: stockBalance.productId || null,
      description: stockBalance.description || null,
      spec: stockBalance.spec || null,
      thickness: stockBalance.thickness ?? null,
      width: stockBalance.width ?? null,
      CSP: stockBalance.CSP || null,
      uomCode: stockBalance.uomCode || null,
      stockType: stockBalance.stockType || null,
      qtyOnHand: qty,
      qtyReserved: 0,
      qtyQC: 0,
      qtyAvailable: qty,
      lastMovement: new Date(),
    },
  });

  return { ...balance, qtyBefore: 0, qtyAfter: qty };
}

async function inferRejectSourceContext(tx, stockBalance) {
  const identityWhere = buildStockIdentityFilter(stockBalance);
  const lotNumber = normalizeLotValue(stockBalance.lotNumber);
  const rackCode = normalizeText(stockBalance.rackCode);
  const warehouseCode = normalizeText(stockBalance.warehouseCode);

  const movements = await tx.stockMovement.findMany({
    where: {
      partCode: stockBalance.partCode,
      ...identityWhere,
      isDeleted: false,
      OR: [
        {
          transactionType: "QC_HOLD",
          referenceType: "PRODUCTION_LOG",
          direction: "IN",
          warehouseCode,
          rackCode,
          lotNumber,
        },
        {
          transactionType: "REJECT",
          referenceType: "QUALITY_INSPECTION",
          destinationWarehouseCode: warehouseCode,
          destinationRackCode: rackCode,
          lotNumber,
        },
      ],
    },
    orderBy: [{ movementDate: "desc" }, { createdAt: "desc" }],
    select: {
      referenceType: true,
      referenceNumber: true,
    },
  });

  const uniqueSources = [
    ...new Map(
      movements
        .filter(movement => movement.referenceType && movement.referenceNumber)
        .map(movement => [`${movement.referenceType}:${movement.referenceNumber}`, movement]),
    ).values(),
  ];

  if (uniqueSources.length !== 1) {
    return {
      canAutoCreateOrder: false,
      reason: uniqueSources.length === 0
        ? "Source reject tidak bisa ditrace otomatis."
        : "Reject stock berasal dari lebih dari satu sumber, auto create order tidak diizinkan.",
    };
  }

  const [source] = uniqueSources;
  return {
    canAutoCreateOrder: true,
    referenceType: source.referenceType,
    referenceNumber: source.referenceNumber,
  };
}

async function createProductionLogReworkAutomation(tx, productionLog, qtyRework) {
  const normalizedQty = Math.max(0, Number(qtyRework || 0));
  if (normalizedQty <= 0 || !productionLog?.workOrder || !productionLog?.manufacturingOrder) {
    return null;
  }

  const sourceWo = productionLog.workOrder;
  const reworkWoNumber = await generateDailyNumber(tx, "workOrder", "woNumber", "WO");
  const now = new Date();

  const createdWorkOrder = await tx.workOrder.create({
    data: {
      woNumber: reworkWoNumber,
      woDate: now,
      moId: productionLog.manufacturingOrder.id,
      mbomDetailId: sourceWo.mbomDetailId || null,
      machineId: sourceWo.machineId || null,
      processId: sourceWo.processId || null,
      sequence: sourceWo.sequence || 0,
      cycleTime: sourceWo.cycleTime || 0,
      machineCostingRate: sourceWo.machineCostingRate ?? null,
      machineRateType: sourceWo.machineRateType || null,
      machineCurrency: sourceWo.machineCurrency || null,
      outputPartId: sourceWo.outputPartId || null,
      outputPartCode: sourceWo.outputPartCode || null,
      outputPartNumber: sourceWo.outputPartNumber || null,
      outputPartName: sourceWo.outputPartName || null,
      plannedDate: now,
      plannedQty: normalizedQty,
      uomCode: sourceWo.uomCode || productionLog.manufacturingOrder.uomCode || null,
      status: "Rework",
      isReworkOrder: true,
      reworkSourceType: "PRODUCTION_LOG",
      reworkReferenceType: "PRODUCTION_LOG",
      reworkReferenceNumber: productionLog.logNumber,
      reworkReferenceLabel: productionLog.logNumber,
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

async function createRejectReworkAutomation(tx, stockBalance, qtyRework, performedBy = "system") {
  const sourceContext = await inferRejectSourceContext(tx, stockBalance);
  if (!sourceContext.canAutoCreateOrder) {
    throwHttpError(sourceContext.reason || "Auto create order tidak bisa dilakukan untuk reject stock ini.", 400);
  }

  if (sourceContext.referenceType === "PRODUCTION_LOG") {
    const productionLog = await tx.productionLog.findFirst({
      where: {
        logNumber: sourceContext.referenceNumber,
        isDeleted: false,
      },
      include: {
        workOrder: true,
        manufacturingOrder: true,
      },
    });

    if (!productionLog) {
      throwHttpError("Production Log sumber reject tidak ditemukan.", 404);
    }

    return createProductionLogReworkAutomation(tx, productionLog, qtyRework);
  }

  if (sourceContext.referenceType === "QUALITY_INSPECTION") {
    const inspection = await tx.qualityInspection.findFirst({
      where: {
        inspectionNumber: sourceContext.referenceNumber,
        isDeleted: false,
      },
      include: {
        workOrder: true,
        vendorProcessOrder: true,
        manufacturingOrder: true,
      },
    });

    if (!inspection) {
      throwHttpError("Quality Inspection sumber reject tidak ditemukan.", 404);
    }

    return createQualityInspectionReworkAutomation(tx, inspection, qtyRework, performedBy);
  }

  throwHttpError("Source reject tidak didukung untuk auto create order.", 400);
}

async function createWorkOrderFromQualityInspection(tx, inspection, qtyRework) {
  const normalizedQty = Math.max(0, Number(qtyRework || 0));
  if (normalizedQty <= 0 || !inspection?.manufacturingOrder) {
    return null;
  }

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
      reworkSourceType: "STOCK_REWORK",
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

async function createVendorProcessOrderFromQualityInspection(tx, inspection, qtyRework, performedBy = "system") {
  const normalizedQty = Math.max(0, Number(qtyRework || 0));
  if (normalizedQty <= 0 || !inspection?.vendorProcessOrder) {
    return null;
  }

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
      reworkSourceType: "STOCK_REWORK",
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

async function inferReworkSourceContext(tx, stockBalance) {
  const identityWhere = buildStockIdentityFilter(stockBalance);
  const lotNumber = normalizeLotValue(stockBalance.lotNumber);
  const rackCode = normalizeText(stockBalance.rackCode);
  const warehouseCode = normalizeText(stockBalance.warehouseCode);

  const movements = await tx.stockMovement.findMany({
    where: {
      partCode: stockBalance.partCode,
      ...identityWhere,
      isDeleted: false,
      transactionType: "REWORK",
      OR: [
        {
          destinationWarehouseCode: warehouseCode,
          destinationRackCode: rackCode,
          lotNumber,
        },
        {
          warehouseCode,
          rackCode,
          lotNumber,
          direction: "IN",
        },
      ],
    },
    orderBy: [{ movementDate: "desc" }, { createdAt: "desc" }],
    select: {
      referenceType: true,
      referenceNumber: true,
    },
  });

  const uniqueSources = [
    ...new Map(
      movements
        .filter(movement => movement.referenceType && movement.referenceNumber)
        .map(movement => [`${movement.referenceType}:${movement.referenceNumber}`, movement]),
    ).values(),
  ];

  if (uniqueSources.length !== 1) {
    return {
      canCreateOrder: false,
      reason: uniqueSources.length === 0
        ? "Source rework tidak bisa ditrace otomatis."
        : "Stock rework berasal dari lebih dari satu sumber, auto create order tidak diizinkan.",
    };
  }

  const [source] = uniqueSources;
  if (source.referenceType === "STOCK_REJECT") {
    const rejectBalance = await tx.stockBalance.findUnique({
      where: { id: source.referenceNumber },
    });
    if (!rejectBalance) {
      return {
        canCreateOrder: false,
        reason: "Reject stock sumber rework tidak ditemukan.",
      };
    }
    return inferRejectSourceContext(tx, rejectBalance);
  }

  return {
    canCreateOrder: true,
    referenceType: source.referenceType,
    referenceNumber: source.referenceNumber,
  };
}

async function createReworkOrderAutomation(tx, stockBalance, qtyRework, requestedType, performedBy = "system") {
  const sourceContext = await inferReworkSourceContext(tx, stockBalance);
  if (!sourceContext.canCreateOrder) {
    throwHttpError(sourceContext.reason || "Auto create order tidak bisa dilakukan untuk stock rework ini.", 400);
  }

  const normalizedType = String(requestedType || "").trim().toUpperCase();

  if (sourceContext.referenceType === "PRODUCTION_LOG") {
    if (normalizedType !== "WORK_ORDER") {
      throwHttpError("Stock rework dari Production Log hanya bisa dibuatkan Work Order.", 400);
    }

    const productionLog = await tx.productionLog.findFirst({
      where: {
        logNumber: sourceContext.referenceNumber,
        isDeleted: false,
      },
      include: {
        workOrder: true,
        manufacturingOrder: true,
      },
    });

    if (!productionLog) {
      throwHttpError("Production Log sumber rework tidak ditemukan.", 404);
    }

    return createProductionLogReworkAutomation(tx, productionLog, qtyRework);
  }

  if (sourceContext.referenceType === "QUALITY_INSPECTION") {
    const inspection = await tx.qualityInspection.findFirst({
      where: {
        inspectionNumber: sourceContext.referenceNumber,
        isDeleted: false,
      },
      include: {
        workOrder: true,
        vendorProcessOrder: true,
        manufacturingOrder: true,
      },
    });

    if (!inspection) {
      throwHttpError("Quality Inspection sumber rework tidak ditemukan.", 404);
    }

    if (normalizedType === "WORK_ORDER") {
      return createWorkOrderFromQualityInspection(tx, inspection, qtyRework);
    }

    if (normalizedType === "VENDOR_PROCESS_ORDER") {
      return createVendorProcessOrderFromQualityInspection(tx, inspection, qtyRework, performedBy);
    }
  }

  throwHttpError("Source rework tidak didukung untuk tipe proses yang dipilih.", 400);
}

async function createChildManufacturingOrderFromRework(tx, stockBalance, qtyRework, performedBy = "system", userNotes = null) {
  const normalizedQty = Math.max(0, Number(qtyRework || 0));
  if (normalizedQty <= 0) {
    throwHttpError("Qty rework child MO harus lebih dari 0.", 400);
  }

  const sourceContext = await inferReworkSourceContext(tx, stockBalance);
  if (!sourceContext.canCreateOrder) {
    throwHttpError(sourceContext.reason || "Source rework tidak bisa ditrace untuk child MO.", 400);
  }

  let sourceManufacturingOrder = null;
  let sourceSequence = null;
  let sourceProcessLabel = null;
  let sourceReferenceLabel = "Stock Rework";

  if (sourceContext.referenceType === "PRODUCTION_LOG") {
    const productionLog = await tx.productionLog.findFirst({
      where: {
        logNumber: sourceContext.referenceNumber,
        isDeleted: false,
      },
      select: {
        logNumber: true,
        workOrder: {
          select: {
            sequence: true,
            woNumber: true,
            process: {
              select: {
                processCode: true,
                processName: true,
              },
            },
          },
        },
        manufacturingOrder: {
          select: {
            id: true,
            moNumber: true,
            referenceType: true,
            plannedOrderNumber: true,
            monthlyProductionPlanNumber: true,
            monthlyProductionPlanLineNumber: true,
            partId: true,
            qtyPlanned: true,
            uomCode: true,
            notes: true,
          },
        },
      },
    });

    if (!productionLog?.manufacturingOrder?.id) {
      throwHttpError("MO sumber Production Log rework tidak ditemukan.", 404);
    }

    sourceManufacturingOrder = productionLog.manufacturingOrder;
    sourceSequence = Number(productionLog.workOrder?.sequence || 0) || null;
    sourceProcessLabel =
      productionLog.workOrder?.process?.processName
      || productionLog.workOrder?.process?.processCode
      || productionLog.workOrder?.woNumber
      || null;
    sourceReferenceLabel = productionLog.logNumber || sourceReferenceLabel;
  } else if (sourceContext.referenceType === "QUALITY_INSPECTION") {
    const inspection = await tx.qualityInspection.findFirst({
      where: {
        inspectionNumber: sourceContext.referenceNumber,
        isDeleted: false,
      },
      select: {
        inspectionNumber: true,
        workOrder: {
          select: {
            sequence: true,
            woNumber: true,
            process: {
              select: {
                processCode: true,
                processName: true,
              },
            },
          },
        },
        vendorProcessOrder: {
          select: {
            sequence: true,
            orderNumber: true,
            processCode: true,
            processName: true,
          },
        },
        manufacturingOrder: {
          select: {
            id: true,
            moNumber: true,
            referenceType: true,
            plannedOrderNumber: true,
            monthlyProductionPlanNumber: true,
            monthlyProductionPlanLineNumber: true,
            partId: true,
            qtyPlanned: true,
            uomCode: true,
            notes: true,
          },
        },
      },
    });

    if (!inspection?.manufacturingOrder?.id) {
      throwHttpError("MO sumber Quality Inspection rework tidak ditemukan.", 404);
    }

    sourceManufacturingOrder = inspection.manufacturingOrder;

    if (inspection.vendorProcessOrder?.sequence) {
      sourceSequence = Number(inspection.vendorProcessOrder.sequence || 0) || null;
      sourceProcessLabel =
        inspection.vendorProcessOrder.processName
        || inspection.vendorProcessOrder.processCode
        || inspection.vendorProcessOrder.orderNumber
        || null;
    } else {
      sourceSequence = Number(inspection.workOrder?.sequence || 0) || null;
      sourceProcessLabel =
        inspection.workOrder?.process?.processName
        || inspection.workOrder?.process?.processCode
        || inspection.workOrder?.woNumber
        || null;
    }

    sourceReferenceLabel = inspection.inspectionNumber || sourceReferenceLabel;
  }

  if (!sourceManufacturingOrder?.partId) {
    throwHttpError("Part FG pada MO sumber rework tidak ditemukan.", 400);
  }
  if (!sourceSequence) {
    throwHttpError("Sequence source rework tidak dapat ditentukan untuk child MO.", 400);
  }

  const sourceRootMoNumber =
    sourceManufacturingOrder.rootMoNumber
    || sourceManufacturingOrder.parentMoNumber
    || sourceManufacturingOrder.moNumber;

  const moNumber = await generateMoNumber(tx);
  const notes = String(userNotes || "").trim() || null;

  const createdMo = await tx.manufacturingOrder.create({
    data: {
      moNumber,
      moDate: new Date(),
      referenceType: "Internal",
      partId: sourceManufacturingOrder.partId,
      qtyPlanned: normalizedQty,
      uomCode: sourceManufacturingOrder.uomCode || null,
      status: "Draft",
      inputSourceType: "WIP_STOCK",
      sourceStockBalanceId: stockBalance.id,
      sourceWarehouseCode: stockBalance.warehouseCode || null,
      sourceRackCode: stockBalance.rackCode || null,
      sourceLotNumber: stockBalance.lotNumber || null,
      sourcePartCode: stockBalance.partCode || null,
      sourcePartNumber: stockBalance.partNumber || null,
      sourcePartName: stockBalance.partName || null,
      sourceStockType: stockBalance.stockType || "WIP",
      sourceQtyPlanned: normalizedQty,
      parentMoNumber: sourceManufacturingOrder.moNumber,
      rootMoNumber: sourceRootMoNumber,
      sourceReferenceType: sourceManufacturingOrder.referenceType || "Internal",
      sourcePlannedOrderNumber: sourceManufacturingOrder.plannedOrderNumber || null,
      sourceMonthlyProductionPlanNumber: sourceManufacturingOrder.monthlyProductionPlanNumber || null,
      sourceMonthlyProductionPlanLineNumber: sourceManufacturingOrder.monthlyProductionPlanLineNumber || null,
      sourceStartSequence: sourceSequence,
      sourceStartProcessLabel: sourceProcessLabel || null,
      sourceReworkTraceType: "STOCK_REWORK",
      sourceReworkReferenceType: sourceContext.referenceType || null,
      sourceReworkReferenceNumber: sourceContext.referenceNumber || null,
      sourceReworkReferenceLabel: sourceReferenceLabel || null,
      isReworkChild: true,
      notes,
    },
  });

  const releaseResult = await releaseManufacturingOrder(tx, createdMo);
  const releasedMo = {
    ...createdMo,
    status: releaseResult.manufacturingOrder?.status || "Released",
  };

  let workOrders = [];
  try {
    workOrders = await generateWorkOrdersFromRouting(tx, releasedMo, {
      status: "Planned",
      startSequence: sourceSequence,
    });
  } catch (error) {
    if (!String(error?.message || "").includes("Tidak ada routing process inHouse")) {
      throw error;
    }
  }

  const vendorProcessOrders = await generateVendorProcessOrdersFromRouting(tx, releasedMo, {
    createdBy: performedBy,
    startSequence: sourceSequence,
  });

  const manufacturingOrder = await tx.manufacturingOrder.findUnique({
    where: { id: createdMo.id },
    include: {
      part: { select: { partCode: true, partNumber: true, partName: true } },
      uom: { select: { uomCode: true, uomName: true } },
      sourceStockBalance: {
        select: {
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
        },
      },
    },
  });

  return {
    type: "CHILD_MANUFACTURING_ORDER",
    manufacturingOrder,
    startSequence: sourceSequence,
    sourceReferenceLabel,
    workOrders,
    vendorProcessOrders: [
      ...(vendorProcessOrders?.created || []),
      ...(vendorProcessOrders?.existing || []),
    ],
  };
}

const validateStockPolicy = (data = {}) => {
  const parseField = (value, fieldName) => {
    if (value === undefined || value === null || value === "") return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return `${fieldName} harus berupa angka`;
    if (parsed < 0) return `${fieldName} tidak boleh negatif`;
    return parsed;
  };

  const minStock = parseField(data.minStock, "minStock");
  if (typeof minStock === "string") return minStock;

  const maxStock = parseField(data.maxStock, "maxStock");
  if (typeof maxStock === "string") return maxStock;

  const reorderPoint = parseField(data.reorderPoint, "reorderPoint");
  if (typeof reorderPoint === "string") return reorderPoint;

  if (minStock !== undefined && maxStock !== undefined && minStock > maxStock) {
    return "minStock tidak boleh lebih besar dari maxStock";
  }

  if (
    reorderPoint !== undefined &&
    minStock !== undefined &&
    reorderPoint < minStock
  ) {
    return "reorderPoint tidak boleh lebih kecil dari minStock";
  }

  if (
    reorderPoint !== undefined &&
    maxStock !== undefined &&
    reorderPoint > maxStock
  ) {
    return "reorderPoint tidak boleh lebih besar dari maxStock";
  }

  return null;
};

// ============================================
// LIST STOCK BALANCES
// ============================================
exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      warehouseCode,
      rackCode,
      rackCodePrefix,
      lotNumber,
      materialCode,
      partCode,
      productId,
      description,
      category,
      lowStock,
      stockType,
      uomCode,
      excludeSpecialRacks,
      page = 1,
      limit = 20,
    } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    if (stockType) {
      where.stockType = stockType;
    }

    if (uomCode) {
      where.uomCode = uomCode;
    }

    if (warehouseCode) {
      where.warehouseCode = warehouseCode;
    }

    if (rackCode) {
      where.rackCode = rackCode;
    }
    else if (rackCodePrefix) {
      where.rackCode = { startsWith: rackCodePrefix, mode: "insensitive" };
    }

    if (excludeSpecialRacks === "true") {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        buildExcludeSpecialRackCondition(),
      ];
    }

    if (lotNumber) {
      where.lotNumber = lotNumber;
    }

    if (partCode) {
      where.partCode = { contains: partCode, mode: "insensitive" };
    }
    if (materialCode) {
      where.materialCode = { contains: materialCode, mode: "insensitive" };
    }

    if (productId) {
      where.productId = productId;
    }

    if (description) {
      where.description = { contains: description, mode: "insensitive" };
    }

    // Filter low stock: qtyAvailable < minStock (perlu raw query karena compare dua kolom)
    if (lowStock === "true") {
      const lowStockIds = await prisma.$queryRaw`
        SELECT id FROM "tbl_stock_balance"
        WHERE "min_stock" > 0 AND "qty_available" < "min_stock" AND "is_deleted" = false
      `;
      where.id = { in: lowStockIds.map((r) => r.id) };
    }

    if (q) {
      where.OR = [
        { materialCode: { contains: q, mode: "insensitive" } },
        { materialName: { contains: q, mode: "insensitive" } },
        { materialType: { contains: q, mode: "insensitive" } },
        { partCode: { contains: q, mode: "insensitive" } },
        { partNumber: { contains: q, mode: "insensitive" } },
        { partName: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
        { spec: { contains: q, mode: "insensitive" } },
        { CSP: { contains: q, mode: "insensitive" } },
        { warehouseCode: { contains: q, mode: "insensitive" } },
        { rackCode: { contains: q, mode: "insensitive" } },
        { lotNumber: { contains: q, mode: "insensitive" } },
        { warehouse: { warehouseName: { contains: q, mode: "insensitive" } } },
        { rack: { rackName: { contains: q, mode: "insensitive" } } },
        { product: { productCode: { contains: q, mode: "insensitive" } } },
        { product: { productName: { contains: q, mode: "insensitive" } } },
      ];
    }

    const orderBy = buildSort(req.query) || { partCode: "asc" };
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.stockBalance.findMany({
        where,
        include: {
          warehouse: {
            select: { warehouseCode: true, warehouseName: true, type: true },
          },
          rack: {
            select: {
              rackCode: true,
              rackName: true,
              zone: true,
              row: true,
              level: true,
            },
          },
          product: {
            select: { productCode: true, productName: true, description: true },
          },
          material: {
            select: { materialCode: true, materialName: true, materialType: true },
          },
        },
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.stockBalance.count({ where }),
    ]);

    const normalizedItems = items.map(sanitizeItemIdentityFields);

    // Kumpulkan partCodes unik untuk lookup Part data (skip null/empty)
    const partCodes = [
      ...new Set(
        normalizedItems
          .map((b) => (typeof b.partCode === "string" ? b.partCode.trim() : ""))
          .filter((code) => code.length > 0),
      ),
    ];

    // Lookup Part info (partNumber, partName, category, uomCode)
    const parts = partCodes.length
      ? await prisma.part.findMany({
          where: { partCode: { in: partCodes }, isDeleted: false },
          select: {
            partCode: true,
            partNumber: true,
            partName: true,
            category: true,
            process: { select: { processName: true } },
            mbomDetails: {
              where: { isDeleted: false, mbomHeader: { isDeleted: false } },
              select: {
                mbomHeader: { select: { revision: true } },
                mbomProcesses: {
                  where: { isDeleted: false },
                  orderBy: { sequence: "asc" },
                  select: { sequence: true, occurrenceCode: true, process: { select: { processName: true } } },
                },
              },
            },
          },
        })
      : [];
    const partMap = new Map(parts.map((p) => [p.partCode, p]));

    // Filter by category (post-join karena Part terpisah dari StockBalance)
    let filteredItems = normalizedItems;
    if (category) {
      filteredItems = normalizedItems.filter((b) => {
        const itemCategory = partMap.get(b.partCode)?.category ?? b.product?.category;
        return itemCategory === category;
      });
    }

    // Hitung qtyIncoming sebagai sisa yang BELUM datang fisik.
    // Catatan alur delayed QC saat ini:
    // - PO.qtyReceived bertambah saat GR receive (penerimaan fisik).
    // - Incoming inspection mengatur keputusan kualitas + perpindahan stok lanjutan.
    // Karena itu, outstanding per detail = qty PO - qty yang sudah tercatat datang fisik.
    // Support key stock item berbasis partCode | productId | description | spec/thickness/width/CSP.
    const identityClauseMap = new Map();
    for (const item of normalizedItems) {
      const identity = resolveItemIdentity(item);
      if (!hasItemIdentity(identity)) continue;

      const clause = buildIdentityWhere(identity);
      identityClauseMap.set(JSON.stringify(clause), clause);
    }
    const identityClauses = [...identityClauseMap.values()];

    const incomingMap = new Map();

    if (identityClauses.length) {
      const poDetails = await prisma.purchaseOrderDetail.findMany({
        where: {
          isDeleted: false,
          po: { status: { in: ["Sent", "Confirmed", "Partial Receipt"] } },
          OR: identityClauses,
        },
        select: {
          id: true,
          qty: true,
          qtyReceived: true,
          partCode: true,
          productId: true,
          description: true,
          partNumber: true,
          spec: true,
          thickness: true,
          width: true,
          CSP: true,
        },
      });

      const poDetailIds = poDetails.map((d) => d.id);

      // Penerimaan fisik dihitung dari GR non-Draft (sudah receive/processed).
      const grReceivedAgg = poDetailIds.length
        ? await prisma.goodsReceiptDetail.groupBy({
            by: ["poDetailId"],
            where: {
              isDeleted: false,
              poDetailId: { in: poDetailIds },
              gr: {
                isDeleted: false,
                status: {
                  in: [
                    "Received Pending Inspection",
                    "Partially Inspected",
                    "Completed",
                  ],
                },
              },
            },
            _sum: { qtyReceived: true },
          })
        : [];

      const grReceivedMap = new Map(
        grReceivedAgg.map((r) => [r.poDetailId, Number(r._sum.qtyReceived || 0)]),
      );

      for (const d of poDetails) {
        const qtyOrder = Number(d.qty || 0);
        const qtyAcceptedFinal = Number(d.qtyReceived || 0);
        const qtyPhysicalReceived = Number(grReceivedMap.get(d.id) || 0);
        const qtyAlreadyArrived = Math.max(qtyAcceptedFinal, qtyPhysicalReceived);
        const qtyIncoming = Math.max(0, qtyOrder - qtyAlreadyArrived);

        const key = buildIdentityKey(sanitizeItemIdentityFields(d));

        incomingMap.set(key, Number(incomingMap.get(key) || 0) + qtyIncoming);
      }
    }

    const result = filteredItems.map((b) => {
      const part = partMap.get(b.partCode);
      const identityKey = buildIdentityKey(b);
      const bomProcesses = (part?.mbomDetails || []).flatMap((detail) => (detail.mbomProcesses || []).map((item) => ({ ...item, revision: detail.mbomHeader?.revision || 0 })))
        .sort((left, right) => Number(right.revision || 0) - Number(left.revision || 0) || Number(left.sequence || 0) - Number(right.sequence || 0));
      return {
        ...mapStockBalanceDoc(b),
        partNumber: part?.partNumber || b.partNumber || null,
        partName: b.partName ?? part?.partName ?? null,
        category: part?.category ?? b.product?.category ?? null,
        mbomProcessName: (() => { const process = bomProcesses.find((item) => item.process?.processName || item.occurrenceCode); return process?.occurrenceCode || process?.process?.processName || part?.process?.processName || null; })(),
        qtyIncoming: incomingMap.get(identityKey) ?? 0,
      };
    });

    res.json({
      items: result,
      total: category ? filteredItems.length : total,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (e) {
    next(e);
  }
};

// ============================================
// GET STOCK BALANCE BY ID
// ============================================
exports.get = async (req, res, next) => {
  try {
    const { id } = req.params;

    const stockBalance = await prisma.stockBalance.findUnique({
      where: { id },
      include: {
        warehouse: true,
        rack: {
          select: {
            rackCode: true,
            rackName: true,
            zone: true,
            row: true,
            level: true,
          },
        },
        product: {
          select: { productCode: true, productName: true, description: true },
        },
        stockReservations: {
          where: { isDeleted: false },
          orderBy: [{ status: "asc" }, { reservationDate: "desc" }],
          take: 200,
        },
      },
    });

    if (!stockBalance) {
      return res.status(404).json({ message: "Stock balance tidak ditemukan" });
    }

    const movementIdentity = {
      warehouseCode: stockBalance.warehouseCode,
      rackCode: stockBalance.rackCode,
      lotNumber: stockBalance.lotNumber,
      partCode: stockBalance.partCode,
      partNumber: stockBalance.partNumber,
      materialCode: stockBalance.materialCode,
      materialId: stockBalance.materialId,
      productId: stockBalance.productId,
      description: stockBalance.description,
      spec: stockBalance.spec,
      thickness: stockBalance.thickness,
      width: stockBalance.width,
      CSP: stockBalance.CSP,
      uomCode: stockBalance.uomCode,
      isDeleted: false,
    };
    const currentPart = stockBalance.partCode ? await prisma.part.findFirst({
      where: { partCode: stockBalance.partCode, isDeleted: false },
      select: {
        partNumber: true,
        process: { select: { processName: true } },
        mbomDetails: {
          where: { isDeleted: false, mbomHeader: { isDeleted: false } },
          select: {
            mbomHeader: { select: { revision: true } },
            mbomProcesses: { where: { isDeleted: false }, orderBy: { sequence: "asc" }, select: { sequence: true, occurrenceCode: true, process: { select: { processName: true } } } },
          },
        },
      },
    }) : null;
    const currentBomProcesses = (currentPart?.mbomDetails || []).flatMap((detail) => (detail.mbomProcesses || []).map((item) => ({ ...item, revision: detail.mbomHeader?.revision || 0 })))
      .sort((left, right) => Number(right.revision || 0) - Number(left.revision || 0) || Number(left.sequence || 0) - Number(right.sequence || 0));
    const currentProcessName = (() => { const process = currentBomProcesses.find((item) => item.process?.processName || item.occurrenceCode); return process?.occurrenceCode || process?.process?.processName || currentPart?.process?.processName || null; })();
    const stockMovements = await prisma.stockMovement.findMany({
      where: movementIdentity,
      orderBy: [{ movementDate: "desc" }, { createdAt: "desc" }],
      take: 200,
    });
    const stockReservations = (stockBalance.stockReservations || []).map((reservation) => {
      const sourceDocumentNumber = String(reservation.referenceNumber || "").split("#")[0] || null;
      const referenceType = String(reservation.referenceType || "").toUpperCase();
      return {
        ...mapDoc(reservation),
        sourceDocumentNumber,
        sourceLineNumber: Number(String(reservation.referenceNumber || "").match(/#(\d+)$/)?.[1] || 0) || null,
        qtyOpen: Math.max(Number(reservation.qtyReserved || 0) - Number(reservation.qtyReleased || 0), 0),
        ...(referenceType === "SO" ? { soNumber: sourceDocumentNumber } : {}),
        ...(referenceType === "MANUFACTURING_ORDER" || referenceType === "MO" ? { moNumber: sourceDocumentNumber } : {}),
        ...(referenceType === "MPS" ? { mpsNumber: sourceDocumentNumber } : {}),
      };
    });
    res.json({ ...mapStockBalanceDoc({ ...stockBalance, stockReservations: undefined, partNumber: currentPart?.partNumber || stockBalance.partNumber }), mbomProcessName: currentProcessName, stockReservations, stockMovements: stockMovements.map((movement) => ({ ...mapDoc(movement), partNumber: currentPart?.partNumber || movement.partNumber || null, mbomProcessName: currentProcessName })) });
  } catch (e) {
    next(e);
  }
};

// ============================================
// GET STOCK BY WAREHOUSE & PART
// ============================================
exports.getByWarehousePart = async (req, res, next) => {
  try {
    const { warehouseCode, partCode } = req.params;

    const stockBalance = await prisma.stockBalance.findFirst({
      where: {
        warehouseCode,
        partCode,
        isDeleted: false,
      },
      include: {
        warehouse: true,
        rack: {
          select: {
            rackCode: true,
            rackName: true,
            zone: true,
            row: true,
            level: true,
          },
        },
        product: {
          select: { productCode: true, productName: true, description: true },
        },
      },
    });

    if (!stockBalance) {
      return res.status(404).json({ message: "Stock balance tidak ditemukan" });
    }

    res.json(mapStockBalanceDoc(stockBalance));
  } catch (e) {
    next(e);
  }
};

// ============================================
// GET STOCK BY ITEM IDENTITY
// ============================================
exports.getByItem = async (req, res, next) => {
  try {
    const { warehouseCode, rackCode, lotNumber, uomCode } = req.query;
    const identity = await resolveItemIdentityInput(prisma, req.query);

    if (!warehouseCode) {
      return res.status(400).json({ message: "warehouseCode wajib diisi" });
    }

    if (!hasItemIdentity(identity)) {
      return res.status(400).json({
        message: IDENTITY_REQUIRED_MESSAGE,
      });
    }

    const stockBalance = await prisma.stockBalance.findFirst({
      where: {
        warehouseCode,
        ...(rackCode ? { rackCode } : {}),
        ...(lotNumber ? { lotNumber } : {}),
        ...buildIdentityWhere(identity),
        ...(uomCode ? { uomCode: normalizeText(uomCode) } : {}),
        isDeleted: false,
      },
      include: {
        warehouse: true,
        rack: {
          select: {
            rackCode: true,
            rackName: true,
            zone: true,
            row: true,
            level: true,
          },
        },
        product: {
          select: { productCode: true, productName: true, description: true },
        },
      },
    });

    if (!stockBalance) {
      return res.status(404).json({ message: "Stock balance tidak ditemukan" });
    }

    res.json(mapStockBalanceDoc(stockBalance));
  } catch (e) {
    next(e);
  }
};

// ============================================
// CREATE OR UPDATE STOCK BALANCE
// ============================================
exports.upsert = async (req, res, next) => {
  try {
    const {
      warehouseCode,
      rackCode,
      lotNumber,
      // Notes belongs to the stock movement/audit trail, not StockBalance.
      // Ignore it here so API clients can reuse adjustment-shaped payloads
      // without Prisma receiving an unsupported column.
      notes: _notes,
      ...rawData
    } = req.body;
    const data = omitIdentityPayloadFields(rawData);
    const identity = await resolveItemIdentityInput(prisma, req.body || {}, {
      enrichPartSnapshot: true,
    });
    const normalizedRackCode = normalizeText(rackCode);
    const normalizedLotNumber = normalizeText(lotNumber);
    const uomCode = normalizeText(data.uomCode);

    if (!warehouseCode) {
      return res.status(400).json({
        message: "warehouseCode wajib diisi",
      });
    }

    if (!hasItemIdentity(identity)) {
      return res.status(400).json({
        message: IDENTITY_REQUIRED_MESSAGE,
      });
    }

    if (data.qtyOnHand != null) assertQuantity(data.qtyOnHand, uomCode, "Qty On Hand");
    if (data.qtyReserved != null) assertQuantity(data.qtyReserved, uomCode, "Qty Reserved");
    if (data.qtyQC != null) assertQuantity(data.qtyQC, uomCode, "Qty QC");

    const stockPolicyError = validateStockPolicy(data);
    if (stockPolicyError) {
      return res.status(400).json({ message: stockPolicyError });
    }

    const existing = await prisma.stockBalance.findFirst({
      where: {
        warehouseCode,
        rackCode: normalizedRackCode,
        lotNumber: normalizedLotNumber,
        ...buildIdentityWhere(identity),
        uomCode: normalizeText(data.uomCode),
      },
      select: { id: true, qtyReserved: true, qtyQC: true },
    });

    const qtyReserved = Number(data.qtyReserved ?? existing?.qtyReserved ?? 0);
    const qtyQC = Number(data.qtyQC ?? existing?.qtyQC ?? 0);
    const qtyAvailable = Number(data.qtyOnHand || 0) - qtyReserved - qtyQC;

    let stockBalance;
    if (existing) {
      await assertStockBalanceNotFrozen(prisma, existing.id);
      stockBalance = await prisma.stockBalance.update({
        where: { id: existing.id },
        data: {
          qtyAvailable,
          ...data,
          ...(identity.partCode !== undefined && identity.partCode !== null
            ? { partCode: identity.partCode }
            : {}),
          ...(identity.productId !== undefined && identity.productId !== null
            ? { productId: identity.productId }
            : {}),
          ...(identity.description !== undefined && identity.description !== null
            ? { description: identity.description }
            : {}),
          ...(identity.partNumber !== undefined && identity.partNumber !== null
            ? { partNumber: identity.partNumber }
            : {}),
          ...(identity.spec !== undefined && identity.spec !== null
            ? { spec: identity.spec }
            : {}),
          ...(identity.thickness !== undefined && identity.thickness !== null
            ? { thickness: identity.thickness }
            : {}),
          ...(identity.width !== undefined && identity.width !== null
            ? { width: identity.width }
            : {}),
          ...(identity.CSP !== undefined && identity.CSP !== null
            ? { CSP: identity.CSP }
            : {}),
        },
      });
    } else {
      await assertWarehouseNotFrozen(prisma, warehouseCode);
      stockBalance = await prisma.stockBalance.create({
        data: {
          warehouseCode,
          rackCode: normalizedRackCode,
          lotNumber: normalizedLotNumber,
          qtyAvailable,
          ...data,
          ...(identity.partCode !== undefined && identity.partCode !== null
            ? { partCode: identity.partCode }
            : {}),
          ...(identity.productId !== undefined && identity.productId !== null
            ? { productId: identity.productId }
            : {}),
          ...(identity.description !== undefined && identity.description !== null
            ? { description: identity.description }
            : {}),
          ...(identity.partNumber !== undefined && identity.partNumber !== null
            ? { partNumber: identity.partNumber }
            : {}),
          ...(identity.spec !== undefined && identity.spec !== null
            ? { spec: identity.spec }
            : {}),
          ...(identity.thickness !== undefined && identity.thickness !== null
            ? { thickness: identity.thickness }
            : {}),
          ...(identity.width !== undefined && identity.width !== null
            ? { width: identity.width }
            : {}),
          ...(identity.CSP !== undefined && identity.CSP !== null
            ? { CSP: identity.CSP }
            : {}),
        },
      });
    }

    res.json(mapStockBalanceDoc(stockBalance));
  } catch (e) {
    next(e);
  }
};

// ============================================
// ADJUST STOCK (Manual Adjustment)
// ============================================
exports.adjust = async (req, res, next) => {
  try {
    const {
      warehouseCode,
      rackCode,
      lotNumber,
      qtyOnHand,
      notes,
      ...rawData
    } = req.body;
    const data = omitIdentityPayloadFields(rawData);
    const identity = await resolveItemIdentityInput(prisma, req.body || {}, {
      enrichPartSnapshot: true,
    });
    const normalizedRackCode = normalizeText(rackCode);
    const normalizedLotNumber = normalizeText(lotNumber);
    const uomCode = normalizeText(data.uomCode);

    if (!warehouseCode || qtyOnHand === undefined) {
      return res.status(400).json({
        message: "warehouseCode dan qtyOnHand wajib diisi",
      });
    }

    if (!hasItemIdentity(identity)) {
      return res.status(400).json({
        message: IDENTITY_REQUIRED_MESSAGE,
      });
    }

    assertQuantity(qtyOnHand, uomCode, "Qty On Hand");

    const existing = await prisma.stockBalance.findFirst({
      where: {
        warehouseCode,
        rackCode: normalizedRackCode,
        lotNumber: normalizedLotNumber,
        ...buildIdentityWhere(identity),
        uomCode: normalizeText(data.uomCode),
      },
      select: { id: true, qtyReserved: true, qtyQC: true },
    });

    const qtyReserved = Number(existing?.qtyReserved || 0);
    const qtyQC = Number(existing?.qtyQC || 0);

    let stockBalance;
    if (existing) {
      await assertStockBalanceNotFrozen(prisma, existing.id);
      stockBalance = await prisma.stockBalance.update({
        where: { id: existing.id },
        data: {
          qtyOnHand: Number(qtyOnHand),
          qtyAvailable:
            Number(qtyOnHand) -
            qtyReserved -
            qtyQC,
          lastMovement: new Date(),
          ...data,
          ...(identity.partCode !== undefined && identity.partCode !== null
            ? { partCode: identity.partCode }
            : {}),
          ...(identity.productId !== undefined && identity.productId !== null
            ? { productId: identity.productId }
            : {}),
          ...(identity.description !== undefined && identity.description !== null
            ? { description: identity.description }
            : {}),
          ...(identity.partNumber !== undefined && identity.partNumber !== null
            ? { partNumber: identity.partNumber }
            : {}),
          ...(identity.spec !== undefined && identity.spec !== null
            ? { spec: identity.spec }
            : {}),
          ...(identity.thickness !== undefined && identity.thickness !== null
            ? { thickness: identity.thickness }
            : {}),
          ...(identity.width !== undefined && identity.width !== null
            ? { width: identity.width }
            : {}),
          ...(identity.CSP !== undefined && identity.CSP !== null
            ? { CSP: identity.CSP }
            : {}),
        },
      });
    } else {
      await assertWarehouseNotFrozen(prisma, warehouseCode);
      stockBalance = await prisma.stockBalance.create({
        data: {
          warehouseCode,
          rackCode: normalizedRackCode,
          lotNumber: normalizedLotNumber,
          qtyOnHand: Number(qtyOnHand),
          qtyReserved: 0,
          qtyQC: 0,
          qtyAvailable: Number(qtyOnHand),
          lastMovement: new Date(),
          partCode: identity.partCode,
          productId: identity.productId,
          description: identity.description,
          partNumber: identity.partNumber,
          spec: identity.spec,
          thickness: identity.thickness,
          width: identity.width,
          CSP: identity.CSP,
          uomCode: normalizeText(data.uomCode),
        },
      });
    }

    res.json(mapStockBalanceDoc(stockBalance));
  } catch (e) {
    next(e);
  }
};

// ============================================
// DECIDE REJECT STOCK
// ============================================
exports.decideReject = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      qtyScrap = 0,
      qtyRework = 0,
      scrapDestination = {},
      reworkDestination = {},
      reworkAction = "RACK_ONLY",
      notes,
    } = req.body || {};

    const normalizedQtyScrap = toPositiveQty(qtyScrap, "qtyScrap");
    const normalizedQtyRework = toPositiveQty(qtyRework, "qtyRework");
    const totalDecisionQty = normalizedQtyScrap + normalizedQtyRework;
    const normalizedReworkAction = String(reworkAction || "RACK_ONLY").trim().toUpperCase();
    const performedBy = req.user?.username || req.user?.email || "system";

    if (totalDecisionQty <= 0) {
      return res.status(400).json({
        message: "Minimal salah satu qty scrap atau qty rework harus lebih dari 0.",
      });
    }

    if (!["RACK_ONLY", "AUTO_ORDER"].includes(normalizedReworkAction)) {
      return res.status(400).json({
        message: "reworkAction wajib salah satu: RACK_ONLY atau AUTO_ORDER.",
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const stockBalance = await tx.stockBalance.findUnique({
        where: { id },
      });

      if (!stockBalance || stockBalance.isDeleted) {
        throwHttpError("Stock reject tidak ditemukan.", 404);
      }

      if (!String(stockBalance.rackCode || "").toUpperCase().startsWith("RACK-REJECT")) {
        throwHttpError("Decision hanya bisa dilakukan dari stock reject.", 400);
      }

      await assertStockBalanceNotFrozen(tx, stockBalance.id);

      const qtyOnHandBefore = Number(stockBalance.qtyOnHand || 0);
      const qtyReserved = Number(stockBalance.qtyReserved || 0);
      const qtyQCBefore = Number(stockBalance.qtyQC || 0);
      const qtyAvailableBefore = Number(stockBalance.qtyAvailable || 0);
      const decidableQty = Math.max(0, qtyAvailableBefore);

      if (totalDecisionQty > decidableQty + 0.000001) {
        throwHttpError("Qty decision melebihi qty available reject yang tersedia.", 400);
      }

      const qtyQCAfter = qtyQCBefore;
      const qtyOnHandAfter = Math.max(0, qtyOnHandBefore - totalDecisionQty);
      const qtyAvailableAfter = Math.max(0, qtyOnHandAfter - qtyReserved - qtyQCAfter);
      let currentSourceQty = qtyOnHandBefore;

      await tx.stockBalance.update({
        where: { id: stockBalance.id },
        data: {
          qtyOnHand: qtyOnHandAfter,
          qtyQC: qtyQCAfter,
          qtyAvailable: qtyAvailableAfter,
          lastMovement: new Date(),
        },
      });

      const movementResults = [];
      const baseNotes = normalizeText(notes) || `Reject decision dari ${stockBalance.partCode || "item"}`;

      const createDecisionMovement = async (target, qty, transactionType, defaultRackCode) => {
        if (qty <= 0) return null;

        const normalizedTarget = {
          warehouseCode: normalizeText(target?.warehouseCode) || stockBalance.warehouseCode || "WH-001",
          rackCode: normalizeText(target?.rackCode) || defaultRackCode,
          lotNumber: normalizeLotValue(target?.lotNumber) || normalizeLotValue(stockBalance.lotNumber),
        };

        const targetBalance = await upsertDispositionTargetBalance(
          tx,
          stockBalance,
          normalizedTarget,
          qty,
        );

        const movementNumber = await generateMovementNumber("TRANSFER", tx);
        const qtyBefore = currentSourceQty;
        const qtyAfter = Math.max(0, qtyBefore - qty);
        await tx.stockMovement.create({
          data: {
            movementNumber,
            movementDate: new Date(),
            movementType: "TRANSFER",
            direction: "OUT",
            transactionType,
            warehouseCode: stockBalance.warehouseCode,
            rackCode: stockBalance.rackCode || null,
            destinationWarehouseCode: normalizedTarget.warehouseCode,
            destinationRackCode: normalizedTarget.rackCode,
            lotNumber: normalizeLotValue(stockBalance.lotNumber) || normalizedTarget.lotNumber,
            partCode: stockBalance.partCode,
            partNumber: stockBalance.partNumber || null,
            productId: stockBalance.productId || null,
            description: stockBalance.description || null,
            spec: stockBalance.spec || null,
            thickness: stockBalance.thickness ?? null,
            width: stockBalance.width ?? null,
            CSP: stockBalance.CSP || null,
            stockType: stockBalance.stockType || null,
            uomCode: stockBalance.uomCode || null,
            qty,
            deltaQty: -qty,
            qtyBefore,
            qtyAfter,
            referenceType: "STOCK_REJECT",
            referenceNumber: stockBalance.id,
            notes: `${baseNotes} -> ${transactionType}`,
            performedBy,
          },
        });
        currentSourceQty = qtyAfter;

        return {
          movementNumber,
          transactionType,
          qty,
          target: normalizedTarget,
          targetBalance,
        };
      };

      const scrapResult = await createDecisionMovement(
        scrapDestination,
        normalizedQtyScrap,
        "SCRAP",
        "RACK-SCRAP",
      );
      if (scrapResult) movementResults.push(scrapResult);

      const reworkResult = await createDecisionMovement(
        reworkDestination,
        normalizedQtyRework,
        "REWORK",
        "RACK-REWORK",
      );
      if (reworkResult) movementResults.push(reworkResult);

      let automation = null;
      if (normalizedQtyRework > 0 && normalizedReworkAction === "AUTO_ORDER") {
        automation = await createRejectReworkAutomation(
          tx,
          stockBalance,
          normalizedQtyRework,
          performedBy,
        );
      }

      return {
        stockBalanceId: stockBalance.id,
        qtyDecided: totalDecisionQty,
        qtyRemaining: qtyOnHandAfter,
        qtyQCRemaining: qtyQCAfter,
        qtyAvailableRemaining: qtyAvailableAfter,
        movements: movementResults,
        automation,
      };
    });

    if (result?.automation?.type === "CHILD_MANUFACTURING_ORDER") {
      if (result.automation.manufacturingOrder) {
        emitManufacturingOrderUpdate(
          result.automation.manufacturingOrder,
          "create",
          performedBy,
        );
      }
      if (Array.isArray(result.automation.workOrders) && result.automation.workOrders.length > 0) {
        emitWorkOrderBulkUpdate(
          result.automation.workOrders,
          "create",
          performedBy,
        );
      }
    }

    return res.json(result);
  }
  catch (e) {
    next(e);
  }
};

// ============================================
// PROCESS REWORK STOCK
// ============================================
exports.processRework = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      qty = 0,
      actionType = "TRANSFER_ONLY",
      destination = {},
      notes,
    } = req.body || {};

    const normalizedQty = toPositiveQty(qty, "qty");
    const normalizedActionType = String(actionType || "TRANSFER_ONLY").trim().toUpperCase();
    const allowedActionTypes = ["TRANSFER_ONLY", "WORK_ORDER", "VENDOR_PROCESS_ORDER", "CHILD_MANUFACTURING_ORDER"];
    const performedBy = req.user?.username || req.user?.email || "system";

    if (normalizedQty <= 0) {
      return res.status(400).json({
        message: "qty harus lebih dari 0.",
      });
    }

    if (!allowedActionTypes.includes(normalizedActionType)) {
      return res.status(400).json({
        message: "actionType wajib salah satu: TRANSFER_ONLY, WORK_ORDER, VENDOR_PROCESS_ORDER, CHILD_MANUFACTURING_ORDER.",
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const stockBalance = await tx.stockBalance.findUnique({
        where: { id },
      });

      if (!stockBalance || stockBalance.isDeleted) {
        throwHttpError("Stock rework tidak ditemukan.", 404);
      }

      if (!String(stockBalance.rackCode || "").toUpperCase().startsWith("RACK-REWORK")) {
        throwHttpError("Process hanya bisa dilakukan dari stock rework.", 400);
      }

      await assertStockBalanceNotFrozen(tx, stockBalance.id);

      const qtyOnHandBefore = Number(stockBalance.qtyOnHand || 0);
      const qtyReserved = Number(stockBalance.qtyReserved || 0);
      const qtyQCBefore = Number(stockBalance.qtyQC || 0);
      const qtyAvailableBefore = Number(stockBalance.qtyAvailable || 0);

      if (normalizedQty > qtyAvailableBefore + 0.000001) {
        throwHttpError("Qty proses melebihi qty available rework.", 400);
      }

      if (normalizedActionType === "CHILD_MANUFACTURING_ORDER") {
        const automation = await createChildManufacturingOrderFromRework(
          tx,
          stockBalance,
          normalizedQty,
          performedBy,
          notes,
        );
        const refreshedBalance = await tx.stockBalance.findUnique({
          where: { id: stockBalance.id },
          select: {
            qtyOnHand: true,
            qtyAvailable: true,
          },
        });

        return {
          actionType: normalizedActionType,
          qtyProcessed: normalizedQty,
          qtyRemaining: Number(refreshedBalance?.qtyOnHand || 0),
          qtyAvailableRemaining: Number(refreshedBalance?.qtyAvailable || 0),
          movementNumber: null,
          automation,
        };
      }

      const qtyOnHandAfter = Math.max(0, qtyOnHandBefore - normalizedQty);
      const qtyAvailableAfter = Math.max(0, qtyOnHandAfter - qtyReserved - qtyQCBefore);

      await tx.stockBalance.update({
        where: { id: stockBalance.id },
        data: {
          qtyOnHand: qtyOnHandAfter,
          qtyAvailable: qtyAvailableAfter,
          lastMovement: new Date(),
        },
      });

      const baseNotes = normalizeText(notes) || `Process rework dari ${stockBalance.partCode || "item"}`;

      if (normalizedActionType === "TRANSFER_ONLY") {
        const normalizedTarget = {
          warehouseCode: normalizeText(destination?.warehouseCode),
          rackCode: normalizeText(destination?.rackCode),
          lotNumber: normalizeLotValue(destination?.lotNumber) || normalizeLotValue(stockBalance.lotNumber),
        };

        if (!normalizedTarget.warehouseCode) {
          throwHttpError("destination.warehouseCode wajib diisi untuk TRANSFER_ONLY.", 400);
        }

        if (
          normalizedTarget.warehouseCode === normalizeText(stockBalance.warehouseCode)
          && normalizedTarget.rackCode === normalizeText(stockBalance.rackCode)
        ) {
          throwHttpError("Destination transfer tidak boleh sama dengan source rework.", 400);
        }

        const targetBalance = await upsertDispositionTargetBalance(
          tx,
          stockBalance,
          normalizedTarget,
          normalizedQty,
        );

        const movementNumber = await generateMovementNumber("TRANSFER", tx);
        await tx.stockMovement.create({
          data: {
            movementNumber,
            movementDate: new Date(),
            movementType: "TRANSFER",
            direction: "OUT",
            transactionType: "REWORK",
            warehouseCode: stockBalance.warehouseCode,
            rackCode: stockBalance.rackCode || null,
            destinationWarehouseCode: normalizedTarget.warehouseCode,
            destinationRackCode: normalizedTarget.rackCode,
            lotNumber: normalizeLotValue(stockBalance.lotNumber) || normalizedTarget.lotNumber,
            partCode: stockBalance.partCode,
            partNumber: stockBalance.partNumber || null,
            productId: stockBalance.productId || null,
            description: stockBalance.description || null,
            spec: stockBalance.spec || null,
            thickness: stockBalance.thickness ?? null,
            width: stockBalance.width ?? null,
            CSP: stockBalance.CSP || null,
            stockType: stockBalance.stockType || null,
            uomCode: stockBalance.uomCode || null,
            qty: normalizedQty,
            deltaQty: -normalizedQty,
            qtyBefore: qtyOnHandBefore,
            qtyAfter: qtyOnHandAfter,
            referenceType: "STOCK_REWORK",
            referenceNumber: stockBalance.id,
            notes: `${baseNotes} -> Transfer`,
            performedBy,
          },
        });

        return {
          actionType: normalizedActionType,
          qtyProcessed: normalizedQty,
          qtyRemaining: qtyOnHandAfter,
          qtyAvailableRemaining: qtyAvailableAfter,
          movementNumber,
          targetBalance,
        };
      }

      const automation = await createReworkOrderAutomation(
        tx,
        stockBalance,
        normalizedQty,
        normalizedActionType,
        performedBy,
      );

      const referenceType = normalizedActionType === "WORK_ORDER" ? "WORK_ORDER" : "VENDOR_PROCESS_ORDER";
      const referenceNumber = normalizedActionType === "WORK_ORDER"
        ? automation?.reworkWoNumber || automation?.workOrder?.woNumber
        : automation?.reworkOrderNumber || automation?.vendorProcessOrder?.orderNumber;
      const movementNumber = await generateMovementNumber("OUT", tx);
      await tx.stockMovement.create({
        data: {
          movementNumber,
          movementDate: new Date(),
          movementType: "OUT",
          direction: "OUT",
          transactionType: "REWORK",
          warehouseCode: stockBalance.warehouseCode,
          rackCode: stockBalance.rackCode || null,
          lotNumber: normalizeLotValue(stockBalance.lotNumber),
          partCode: stockBalance.partCode,
          partNumber: stockBalance.partNumber || null,
          productId: stockBalance.productId || null,
          description: stockBalance.description || null,
          spec: stockBalance.spec || null,
          thickness: stockBalance.thickness ?? null,
          width: stockBalance.width ?? null,
          CSP: stockBalance.CSP || null,
          stockType: stockBalance.stockType || null,
          uomCode: stockBalance.uomCode || null,
          qty: normalizedQty,
          deltaQty: -normalizedQty,
          qtyBefore: qtyOnHandBefore,
          qtyAfter: qtyOnHandAfter,
          referenceType,
          referenceNumber,
          notes: `${baseNotes} -> ${normalizedActionType}`,
          performedBy,
        },
      });

      return {
        actionType: normalizedActionType,
        qtyProcessed: normalizedQty,
        qtyRemaining: qtyOnHandAfter,
        qtyAvailableRemaining: qtyAvailableAfter,
        movementNumber,
        automation,
      };
    });

    return res.json(result);
  }
  catch (e) {
    next(e);
  }
};

// ============================================
// DELETE STOCK BALANCE
// ============================================
exports.remove = async (req, res, next) => {
  try {
    const { id } = req.params;

    await assertStockBalanceNotFrozen(prisma, id);
    await prisma.stockBalance.update({
      where: { id },
      data: { isDeleted: true },
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
};

// ============================================
// GET STOCK SUMMARY BY ITEM
// ============================================
exports.summaryByItem = async (req, res, next) => {
  try {
    const identity = await resolveItemIdentityInput(prisma, req.query);

    if (!hasItemIdentity(identity)) {
      return res.status(400).json({
        message: IDENTITY_REQUIRED_MESSAGE,
      });
    }

    const balances = await prisma.stockBalance.findMany({
      where: {
        ...buildIdentityWhere(identity),
        isDeleted: false,
        AND: [buildExcludeSpecialRackCondition()],
      },
      include: {
        warehouse: {
          select: {
            warehouseCode: true,
            warehouseName: true,
            type: true,
          },
        },
        rack: {
          select: {
            rackCode: true,
            rackName: true,
            zone: true,
            row: true,
            level: true,
          },
        },
        product: {
          select: { productCode: true, productName: true, description: true },
        },
      },
      orderBy: { warehouseCode: "asc" },
    });

    const summary = {
      identity,
      totalOnHand: balances.reduce((sum, b) => sum + b.qtyOnHand, 0),
      totalReserved: balances.reduce((sum, b) => sum + b.qtyReserved, 0),
      totalQC: balances.reduce((sum, b) => sum + Number(b.qtyQC || 0), 0),
      totalAvailable: balances.reduce((sum, b) => sum + b.qtyAvailable, 0),
      byWarehouse: balances.map(mapStockBalanceDoc),
    };

    res.json(summary);
  } catch (e) {
    next(e);
  }
};

// ============================================
// GET STOCK SUMMARY BY ITEM FOR SPECIAL RACKS
// ============================================
exports.summarySpecialByItem = async (req, res, next) => {
  try {
    const identity = await resolveItemIdentityInput(prisma, req.query);

    if (!hasItemIdentity(identity)) {
      return res.status(400).json({
        message: IDENTITY_REQUIRED_MESSAGE,
      });
    }

    const balances = await prisma.stockBalance.findMany({
      where: {
        ...buildIdentityWhere(identity),
        isDeleted: false,
        AND: [buildOnlySpecialRackCondition()],
      },
      include: {
        warehouse: {
          select: {
            warehouseCode: true,
            warehouseName: true,
            type: true,
          },
        },
        rack: {
          select: {
            rackCode: true,
            rackName: true,
            zone: true,
            row: true,
            level: true,
          },
        },
        product: {
          select: { productCode: true, productName: true, description: true },
        },
      },
      orderBy: { warehouseCode: "asc" },
    });

    const summary = {
      identity,
      totalOnHand: balances.reduce((sum, b) => sum + b.qtyOnHand, 0),
      totalReserved: balances.reduce((sum, b) => sum + b.qtyReserved, 0),
      totalQC: balances.reduce((sum, b) => sum + Number(b.qtyQC || 0), 0),
      totalAvailable: balances.reduce((sum, b) => sum + b.qtyAvailable, 0),
      byWarehouse: balances.map(mapStockBalanceDoc),
    };

    res.json(summary);
  } catch (e) {
    next(e);
  }
};

// Backward compatibility alias
exports.summaryByPart = exports.summaryByItem;
exports.summarySpecialByPart = exports.summarySpecialByItem;

// ============================================
// LOW STOCK ALERT
// ============================================
exports.lowStockAlert = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, warehouseCode, rackCode, lotNumber } = req.query;
    const skip = (page - 1) * limit;
    const where = {
      isDeleted: false,
      minStock: { gt: 0 },
      qtyAvailable: { lt: prisma.stockBalance.fields.minStock },
      ...(warehouseCode ? { warehouseCode } : {}),
      ...(rackCode ? { rackCode } : {}),
      ...(lotNumber ? { lotNumber } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.stockBalance.findMany({
        where,
        skip,
        take: Number(limit),
        include: {
          warehouse: true,
          rack: {
            select: {
              rackCode: true,
              rackName: true,
              zone: true,
              row: true,
              level: true,
            },
          },
          product: {
            select: {
              productCode: true,
              productName: true,
              description: true,
              category: true,
            },
          },
        },
        orderBy: [
          { qtyAvailable: "asc" },
          { minStock: "desc" },
        ],
      }),
      prisma.stockBalance.count({ where }),
    ]);

    res.json({
      items: items.map(mapStockBalanceDoc),
      total,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (e) {
    next(e);
  }
};
