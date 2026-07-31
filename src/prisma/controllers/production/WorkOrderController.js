const { prisma } = require("../../index");
const { Prisma } = require("@prisma/client");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { parseFilter } = require("../../utils/parseFilter");
const {
  incrementDiesShotCounter,
  adjustDiesShotCounter,
  decrementDiesShotCounter,
} = require("../../utils/diesShotCounter");
const { createWIPEntry } = require("./WIPController");
const {
  emitManufacturingOrderUpdate,
  emitWorkOrderUpdate,
} = require("./services/productionRealtimeService");
const {
  assertProductionShift,
  isWorkOrderProductionStatus,
  isWorkOrderStartableStatus,
} = require("./services/productionIntegrationHelpers");
const {
  getMaterialRequirements,
  syncManufacturingOrderQtyFromWorkOrders,
} = require("./services/productionWorkflowService");
const { assertQuantity } = require("../../utils/uomQuantity");
const {
  emitPlanningPlannedOrderBulkUpdate,
} = require("../planning/services/planningRealtimeService");

const WO_ALREADY_DELETED = "Data Work Order sudah dihapus.";
const WO_COMPLETED_LOCKED = "Work Order yang sudah selesai tidak bisa dihapus.";
const MATERIAL_READY_STATUSES = ["Issued", "Partially Returned", "Closed"];

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
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

function getActualProcessCost(workOrder) {
  const runtimeSeconds = toNumber(workOrder.runningMinutes) > 0
    ? toNumber(workOrder.runningMinutes) * 60
    : workOrder.startTime && workOrder.endTime
      ? Math.max(0, (new Date(workOrder.endTime).getTime() - new Date(workOrder.startTime).getTime()) / 1000)
      : 0;
  return runtimeSeconds * toMachineRatePerSecond(workOrder.machineCostingRate, workOrder.machineRateType);
}

async function buildMachineCostSnapshot(tx, machineId, cycleTime) {
  if (!machineId) {
    return {
      machineCostingRate: null,
      machineRateType: null,
      machineCurrency: null,
      plannedProcessCost: 0,
    };
  }

  const machine = await tx.machine.findUnique({
    where: { id: machineId },
    select: {
      costingRate: true,
      costingRateType: true,
      currencyCode: true,
    },
  });
  if (!machine) return {};

  return {
    machineCostingRate: machine.costingRate ?? null,
    machineRateType: machine.costingRateType || null,
    machineCurrency: machine.currencyCode || null,
    plannedProcessCost: getPlannedProcessCost(cycleTime, machine),
  };
}

async function buildWorkOrderOutputPartSnapshot(tx, mbomDetailId) {
  if (!mbomDetailId) return {};

  const detail = await tx.mBOMDetail.findUnique({
    where: { id: mbomDetailId },
    select: {
      part: {
        select: {
          id: true,
          partCode: true,
          partNumber: true,
          partName: true,
        },
      },
    },
  });
  if (!detail?.part?.partCode) return {};

  return {
    outputPartId: detail.part.id || null,
    outputPartCode: detail.part.partCode || null,
    outputPartNumber: detail.part.partNumber || null,
    outputPartName: detail.part.partName || null,
  };
}

function formatRelationList(items) {
  return items.filter(Boolean).join(", ");
}

function hasSetupValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function isSetupComplete(workOrder = {}) {
  return (
    hasSetupValue(workOrder.machineId) &&
    hasSetupValue(workOrder.diesId) &&
    hasSetupValue(workOrder.shift) &&
    hasSetupValue(workOrder.operatorName)
  );
}

function getProjectedSetup(current, updateData) {
  return {
    machineId: updateData.machineId !== undefined ? updateData.machineId : current.machineId,
    diesId: updateData.diesId !== undefined ? updateData.diesId : current.diesId,
    shift: updateData.shift !== undefined ? updateData.shift : current.shift,
    operatorName: updateData.operatorName !== undefined ? updateData.operatorName : current.operatorName,
  };
}

function resolveWorkOrderOutputPartCode(workOrder = {}) {
  return workOrder?.mbomDetail?.part?.partCode || workOrder?.outputPartCode || null;
}

function readWipDerivedStartSequence(source) {
  const sequence = Number(source?.sourceStartSequence);
  return Number.isFinite(sequence) && sequence > 0 ? sequence : null;
}

async function inferWipStartSequenceForMo(moId, sourcePartCode) {
  const normalizedPartCode = String(sourcePartCode || "").trim().toLowerCase();
  if (!moId || !normalizedPartCode) return null;

  const [matchedVendorProcess, workOrders] = await Promise.all([
    prisma.vendorProcessOrder.findFirst({
      where: {
        moId,
        isDeleted: false,
        outputPartCode: { equals: sourcePartCode, mode: "insensitive" },
      },
      select: { sequence: true },
      orderBy: { sequence: "asc" },
    }),
    prisma.workOrder.findMany({
      where: {
        moId,
        isDeleted: false,
      },
      select: {
        sequence: true,
        outputPartCode: true,
      },
      orderBy: { sequence: "asc" },
    }),
  ]);

  const vendorSequence = Number(matchedVendorProcess?.sequence || 0);
  if (vendorSequence > 0) {
    return vendorSequence;
  }

  const matchedWorkOrder = workOrders.find((candidate) =>
    String(candidate?.outputPartCode || "").trim().toLowerCase() === normalizedPartCode,
  );
  const workOrderSequence = Number(matchedWorkOrder?.sequence || 0);
  return workOrderSequence > 0 ? workOrderSequence : null;
}

async function restoreCoveredPlannedOrdersIfNoActiveWorkOrders(tx, moId) {
  if (!moId) return [];

  const mo = await tx.manufacturingOrder.findUnique({
    where: { id: moId },
    select: { moNumber: true, plannedOrderNumber: true },
  });
  if (!mo?.moNumber) return [];

  const activeWorkOrderCount = await tx.workOrder.count({
    where: {
      moId,
      isDeleted: false,
      status: { not: "Cancelled" },
    },
  });
  if (activeWorkOrderCount > 0) return [];

  if (!mo.plannedOrderNumber) return [];

  const rootPlannedOrder = await tx.plannedOrder.findUnique({
    where: { orderNumber: mo.plannedOrderNumber },
    select: {
      runNumber: true,
      partCode: true,
      requiredDate: true,
      orderDate: true,
    },
  });
  if (!rootPlannedOrder?.runNumber) return [];

  const rootRequirement = await tx.mRPRequirement.findFirst({
    where: {
      runNumber: rootPlannedOrder.runNumber,
      partCode: rootPlannedOrder.partCode,
      requiredDate: rootPlannedOrder.requiredDate,
      orderDate: rootPlannedOrder.orderDate,
      levelMBOM: 0,
      plannedOrderQty: { gt: 0 },
      isDeleted: false,
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  const dependentRequirements = await tx.mRPRequirement.findMany({
    where: {
      runNumber: rootPlannedOrder.runNumber,
      requirementType: "Dependent",
      sourceType: "MBOM",
      orderType: "Production",
      plannedOrderQty: { gt: 0 },
      isDeleted: false,
      ...(rootRequirement
        ? { rootRequirementId: rootRequirement.id }
        : { levelMBOM: { gt: 0 } }),
    },
    select: {
      partCode: true,
      requiredDate: true,
      orderDate: true,
    },
  });
  if (dependentRequirements.length === 0) return [];

  const where = {
    OR: dependentRequirements.map((requirement) => ({
      runNumber: rootPlannedOrder.runNumber,
      orderType: "Production",
      status: "Covered",
      isDeleted: false,
      partCode: requirement.partCode,
      requiredDate: requirement.requiredDate,
      orderDate: requirement.orderDate,
    })),
  };

  const affectedOrders = await tx.plannedOrder.findMany({
    where,
    orderBy: { orderNumber: "asc" },
  });
  if (affectedOrders.length === 0) return [];

  await tx.plannedOrder.updateMany({
    where: { id: { in: affectedOrders.map((order) => order.id) } },
    data: {
      status: "Planned",
    },
  });

  return affectedOrders.map((order) => ({
    ...order,
    status: "Planned",
  }));
}

async function attachOperationItems(workOrders) {
  const docs = Array.isArray(workOrders) ? workOrders : [workOrders].filter(Boolean);
  if (docs.length === 0) return workOrders;

  for (const wo of docs) {
    if (wo.mbomDetail?.part) {
      wo.operationItem = wo.mbomDetail.part;
      wo.operationParentItem = wo.mbomDetail.parentDetail?.part || null;
      wo.operationLevelComponent = wo.mbomDetail.levelComponent ?? null;
    }
  }

  const partCodes = [
    ...new Set(
      docs
        .filter((wo) => !wo.operationItem)
        .map((wo) => resolveWorkOrderOutputPartCode(wo))
        .filter(Boolean)
    ),
  ];
  if (partCodes.length === 0) return workOrders;

  const parts = await prisma.part.findMany({
    where: { partCode: { in: partCodes }, isDeleted: false },
    select: {
      id: true,
      partCode: true,
      partNumber: true,
      partName: true,
      material: {
        select: {
          materialCode: true,
          materialType: true,
          spec: true,
        },
      },
      partBases: {
        select: {
          baseOn: true,
          CSP: true,
          thickness: true,
          width: true,
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  const byCode = new Map(parts.map((part) => [part.partCode, part]));

  for (const wo of docs) {
    if (wo.operationItem) continue;
    const partCode = resolveWorkOrderOutputPartCode(wo);
    wo.operationItem = partCode ? byCode.get(partCode) || null : null;
  }

  return workOrders;
}

async function attachOutputLocations(workOrders) {
  const docs = Array.isArray(workOrders) ? workOrders : [workOrders].filter(Boolean);
  if (docs.length === 0) return workOrders;

  const woIds = [...new Set(docs.map((wo) => wo.id).filter(Boolean))];
  if (woIds.length === 0) return workOrders;

  const logs = await prisma.productionLog.findMany({
    where: {
      woId: { in: woIds },
      isDeleted: false,
      status: { in: ["Submitted", "Approved"] },
    },
    select: {
      id: true,
      woId: true,
      logNumber: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const logNumbers = [...new Set(logs.map((log) => log.logNumber).filter(Boolean))];
  const movements = logNumbers.length
    ? await prisma.stockMovement.findMany({
        where: {
          transactionType: "QC_HOLD",
          referenceType: "PRODUCTION_LOG",
          referenceNumber: { in: logNumbers },
          isDeleted: false,
        },
        select: {
          referenceNumber: true,
          warehouseCode: true,
          rackCode: true,
          lotNumber: true,
          movementDate: true,
        },
        orderBy: { movementDate: "desc" },
      })
    : [];

  const movementByLogNumber = new Map();
  for (const movement of movements) {
    const current = movementByLogNumber.get(movement.referenceNumber);
    const rackCode = String(movement.rackCode || "").toUpperCase();
    const isRejectRack = rackCode.startsWith("RACK-REJECT");
    const currentRackCode = String(current?.rackCode || "").toUpperCase();
    const currentIsRejectRack = currentRackCode.startsWith("RACK-REJECT");

    if (!current) {
      movementByLogNumber.set(movement.referenceNumber, movement);
      continue;
    }

    if (currentIsRejectRack && !isRejectRack) {
      movementByLogNumber.set(movement.referenceNumber, movement);
    }
  }

  for (const wo of docs) {
    const log = logs.find((item) => item.woId === wo.id && movementByLogNumber.has(item.logNumber));
    const movement = log ? movementByLogNumber.get(log.logNumber) : null;
    wo.outputLocation = movement
      ? {
          warehouseCode: movement.warehouseCode || null,
          rackCode: movement.rackCode || null,
          lotNumber: movement.lotNumber || null,
          referenceType: "PRODUCTION_LOG",
          referenceNumber: log.logNumber,
          movementDate: movement.movementDate,
        }
      : null;
  }

  return workOrders;
}

// Generate nomor WO otomatis: WO-YYYYMMDD-001
async function generateWoNumber() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const datePrefix = `WO-${y}${m}${d}`;

  const last = await prisma.workOrder.findFirst({
    where: { woNumber: { startsWith: datePrefix } },
    orderBy: { woNumber: "desc" },
    select: { woNumber: true },
  });

  let seq = 1;
  if (last) {
    const parts = last.woNumber.split("-");
    seq = parseInt(parts[parts.length - 1], 10) + 1;
  }

  return `${datePrefix}-${String(seq).padStart(3, "0")}`;
}

// Buat DiesUsage otomatis dari WorkOrder (dipanggil saat WO selesai)
async function autoCreateDiesUsage(tx, wo, poPartId) {
  const usage = await tx.diesUsage.create({
    data: {
      diesId: wo.diesId,
      partId: poPartId || null,
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

  // Increment shot counter
  await incrementDiesShotCounter(tx, wo.diesId, wo.shotCount);

  // Link diesUsageId ke WorkOrder
  await tx.workOrder.update({
    where: { id: wo.id },
    data: { diesUsageId: usage.id },
  });

  return usage;
}

async function validateMaterialReadyForWorkOrder(workOrder) {
  const moId = workOrder?.moId;
  const mo = await prisma.manufacturingOrder.findUnique({
    where: { id: moId },
    select: {
      id: true,
      moNumber: true,
      partId: true,
      qtyPlanned: true,
      materialRequirementUomMode: true,
      inputSourceType: true,
      sourcePartCode: true,
      sourceStockBalanceId: true,
      sourceQtyPlanned: true,
      sourceStartSequence: true,
      notes: true,
    },
  });

  if (mo?.inputSourceType === "WIP_STOCK") {
    const currentSequence = Number(workOrder?.sequence || 0);
    const sourceStartSequence =
      readWipDerivedStartSequence(mo) ||
      await inferWipStartSequenceForMo(mo.id, mo.sourcePartCode);
    const isContinuationAfterSource =
      Number.isFinite(currentSequence) &&
      currentSequence > 0 &&
      sourceStartSequence &&
      currentSequence > sourceStartSequence;

    if (isContinuationAfterSource) {
      return { ok: true };
    }

    const reservation = await prisma.stockReservation.findFirst({
      where: {
        referenceType: "MANUFACTURING_ORDER",
        referenceNumber: mo.moNumber,
        stockBalanceId: mo.sourceStockBalanceId || undefined,
        isDeleted: false,
        status: "Active",
      },
      select: {
        qtyReserved: true,
        qtyReleased: true,
      },
    });

    const reservedQty = Math.max(
      0,
      Number(reservation?.qtyReserved || 0) - Number(reservation?.qtyReleased || 0),
    );
    const requiredQty = Number(mo.sourceQtyPlanned || mo.qtyPlanned || 0);
    if (requiredQty > 0 && reservedQty + 0.005 < requiredQty) {
      return {
        ok: false,
        message: `WO belum bisa dimulai. Source WIP untuk MO ${mo.moNumber} belum di-reserve penuh (reserved: ${reservedQty}, required: ${requiredQty}).`,
      };
    }

    return { ok: true };
  }

  if (mo?.partId) {
    const requirements = await getMaterialRequirements(prisma, mo);
    if (requirements.mbomHeader) {
      const operationPartCode = resolveWorkOrderOutputPartCode(workOrder);
      const scopedRequirements = requirements.items.filter((item) =>
        (workOrder?.mbomDetailId && item.parentDetailId === workOrder.mbomDetailId) ||
        (operationPartCode && item.consumedByPartCode === operationPartCode)
      );
      if (scopedRequirements.length === 0) {
        return { ok: true };
      }

      const subAssemblyRequirements = scopedRequirements.filter((item) => item.isSubAssembly);
      if (subAssemblyRequirements.length > 0) {
        const reservations = await prisma.stockReservation.findMany({
          where: {
            referenceType: "MANUFACTURING_ORDER",
            referenceNumber: { startsWith: `${mo.moNumber}#` },
            isDeleted: false,
            status: { in: ["Active", "Released"] },
          },
          select: { referenceNumber: true, qtyReserved: true, qtyReleased: true },
        });

        for (const requirement of subAssemblyRequirements) {
          const reservedRemaining = reservations
            .filter((reservation) => {
              const lineToken = String(reservation.referenceNumber || "")
                .split("#").pop()?.split("@")[0];
              return Number(lineToken) === Number(requirement.lineNumber);
            })
            .reduce(
              (sum, reservation) =>
                sum + Math.max(
                  0,
                  Number(reservation.qtyReserved || 0) - Number(reservation.qtyReleased || 0),
                ),
              0,
            );

          if (reservedRemaining + 0.005 < Number(requirement.qtyRequired || 0)) {
            return {
              ok: false,
              message:
                `WO belum bisa dimulai. Sub-assembly ${requirement.partCode} belum ter-reserve penuh ` +
                `(reserved: ${reservedRemaining}, required: ${requirement.qtyRequired} ${requirement.uomCode || "pcs"}).`,
            };
          }
        }
      }

      if (scopedRequirements.every((item) => item.isSubAssembly)) {
        return { ok: true };
      }
    }

    if (requirements.mbomHeader && requirements.items.length === 0) {
      return { ok: true };
    }
  }

  const materialIssues = await prisma.materialIssue.findMany({
    where: {
      moId,
      woId: workOrder?.id,
      isDeleted: false,
    },
    select: {
      issueNumber: true,
      status: true,
      details: {
        where: { isDeleted: false },
        select: {
          lineNumber: true,
          partCode: true,
          description: true,
          qtyRequired: true,
          qtyIssued: true,
          qtyReturned: true,
        },
        orderBy: { lineNumber: "asc" },
      },
    },
    orderBy: { issueDate: "asc" },
  });

  if (materialIssues.length === 0) {
    return {
      ok: false,
      message: `Material belum di-issue untuk WO ${workOrder?.woNumber || ""}.`,
    };
  }

  const readyIssues = materialIssues.filter((issue) => MATERIAL_READY_STATUSES.includes(issue.status));
  if (readyIssues.length === 0) {
    const draftNumbers = materialIssues
      .filter((issue) => issue.status === "Draft")
      .map((issue) => issue.issueNumber)
      .join(", ");
    return {
      ok: false,
      message: draftNumbers
        ? `Material Issue masih Draft: ${draftNumbers}.`
        : "Material belum di-issue untuk WO ini.",
    };
  }

  const readyDetails = readyIssues.flatMap((issue) =>
    issue.details.map((detail) => ({ ...detail, issueNumber: issue.issueNumber }))
  );
  if (readyDetails.length === 0) {
    return {
      ok: false,
      message: "Material Issue belum memiliki detail material.",
    };
  }

  const insufficient = readyDetails.find((detail) => {
    const required = Number(detail.qtyRequired || 0);
    const netIssued = Number(detail.qtyIssued || 0) - Number(detail.qtyReturned || 0);
    return required > 0 && netIssued < required;
  });
  if (insufficient) {
    const materialName = insufficient.partCode || insufficient.description || `line ${insufficient.lineNumber}`;
    const required = Number(insufficient.qtyRequired || 0);
    const netIssued = Number(insufficient.qtyIssued || 0) - Number(insufficient.qtyReturned || 0);
    return {
      ok: false,
      message:
        `WO belum bisa dimulai. Material ${materialName} pada ${insufficient.issueNumber} belum cukup ` +
        `(issued net: ${netIssued}, required: ${required}).`,
    };
  }

  return { ok: true };
}

async function getWorkOrderActivityBlockers(tx, wo) {
  const [
    productionLogCount,
    qualityInspectionCount,
    wipEntryCount,
    stockMovementCount,
  ] = await Promise.all([
    tx.productionLog.count({ where: { woId: wo.id, isDeleted: false } }),
    tx.qualityInspection.count({ where: { woId: wo.id, isDeleted: false } }),
    tx.wIPEntry.count({ where: { woId: wo.id } }),
    tx.stockMovement.count({
      where: {
        referenceNumber: wo.woNumber,
        isDeleted: false,
      },
    }),
  ]);

  return [
    productionLogCount > 0 && `${productionLogCount} Production Log`,
    qualityInspectionCount > 0 && `${qualityInspectionCount} QC`,
    wipEntryCount > 0 && `${wipEntryCount} WIP Entry`,
    wo.diesUsageId && "Dies Usage",
    stockMovementCount > 0 && `${stockMovementCount} Stock Movement`,
  ].filter(Boolean);
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
    const hasReturnedQty = issue.details.some((detail) => toNumber(detail.qtyReturned) > 0);
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

exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      page = 1,
      limit = 20,
      moId,
      moNumber,
      diesId,
      status,
      shift,
      machineId,
      processId,
      processCode,
      sequenceLt,
      sequenceLte,
      sequenceGt,
      sequenceGte,
      latestBeforeSequence,
      availableForProductionLog,
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
    if (moNumber) where.manufacturingOrder = { moNumber };
    if (diesId) where.diesId = diesId;
    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;
    if (shift) where.shift = assertProductionShift(shift);
    if (machineId) where.machineId = machineId;
    if (processId) where.processId = processId;
    if (processCode) where.process = { processCode: { contains: processCode, mode: "insensitive" } };
    const sequenceFilter = {};
    if (sequenceLt !== undefined) sequenceFilter.lt = Number(sequenceLt);
    if (sequenceLte !== undefined) sequenceFilter.lte = Number(sequenceLte);
    if (sequenceGt !== undefined) sequenceFilter.gt = Number(sequenceGt);
    if (sequenceGte !== undefined) sequenceFilter.gte = Number(sequenceGte);
    if (Object.keys(sequenceFilter).length > 0) where.sequence = sequenceFilter;
    if (latestBeforeSequence === "true" && sequenceLt !== undefined) {
      const latestPrevious = await prisma.workOrder.findFirst({
        where: {
          ...where,
          sequence: { lt: Number(sequenceLt) },
        },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      where.sequence = latestPrevious ? latestPrevious.sequence : -1;
    }
    if (availableForProductionLog === "true") {
      where.productionLogs = {
        none: {
          isDeleted: false,
          status: { in: ["Open", "Submitted"] },
        },
      };
    }

    if (startDate || endDate) {
      where.plannedDate = {};
      if (startDate) where.plannedDate.gte = new Date(startDate);
      if (endDate) where.plannedDate.lte = new Date(endDate);
    }

    if (q) {
      where.OR = [
        { woNumber: { contains: q, mode: "insensitive" } },
        { machine: { machineCode: { contains: q, mode: "insensitive" } } },
        { operatorName: { contains: q, mode: "insensitive" } },
        { manufacturingOrder: { moNumber: { contains: q, mode: "insensitive" } } },
      ];
    }

    const orderBy = buildSort(req.query, { defaultSort: { plannedDate: "asc" } });
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.workOrder.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
        include: {
          manufacturingOrder: {
            select: {
              moNumber: true,
              status: true,
              qtyPlanned: true,
              uomCode: true,
              part: {
                select: {
                  partCode: true,
                  partNumber: true,
                  partName: true,
                  material: {
                    select: {
                      materialCode: true,
                      materialType: true,
                      spec: true,
                    },
                  },
                  partBases: {
                    select: {
                      baseOn: true,
                      CSP: true,
                      thickness: true,
                      width: true,
                    },
                    orderBy: { createdAt: "desc" },
                  },
                },
              },
            },
          },
          dies: { select: { diesCode: true, diesName: true } },
          mbomDetail: {
            include: {
              part: {
                select: {
                  id: true,
                  partCode: true,
                  partNumber: true,
                  partName: true,
                  material: {
                    select: {
                      materialCode: true,
                      materialType: true,
                      spec: true,
                    },
                  },
                  partBases: {
                    select: {
                      baseOn: true,
                      CSP: true,
                      thickness: true,
                      width: true,
                    },
                    orderBy: { createdAt: "desc" },
                  },
                },
              },
              parentDetail: {
                include: {
                  part: {
                    select: {
                      id: true,
                      partCode: true,
                      partNumber: true,
                      partName: true,
                    },
                  },
                },
              },
            },
          },
          process: { select: { processCode: true, processName: true } },
          machine: { select: { machineCode: true, machineName: true, costingRate: true, costingRateType: true, currencyCode: true } },
          uom: { select: { uomCode: true, uomName: true } },
          productionLogs: {
            where: {
              isDeleted: false,
              status: { in: ["Draft", "Open", "Submitted"] },
            },
            select: {
              id: true,
              logNumber: true,
              status: true,
              createdAt: true,
            },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      }),
      prisma.workOrder.count({ where }),
    ]);

    await attachOperationItems(items);
    await attachOutputLocations(items);

    res.json({
      items: items.map((item) => {
        const mapped = mapDoc(item);
        const activeLog = mapped.productionLogs?.[0] || null;
        return {
          ...mapped,
          activeProductionLog: activeLog,
          hasActiveProductionLog: Boolean(activeLog),
        };
      }),
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
    const doc = await prisma.workOrder.findFirst({
      where: { woNumber: req.params.woNumber, isDeleted: false },
      include: {
        manufacturingOrder: {
          select: {
            moNumber: true,
            status: true,
            qtyPlanned: true,
            uomCode: true,
            part: {
              select: {
                partCode: true,
                partNumber: true,
                partName: true,
                notes: true,
                material: {
                  select: {
                    materialCode: true,
                    materialType: true,
                    spec: true,
                  },
                },
                partBases: {
                  select: {
                    baseOn: true,
                    CSP: true,
                    thickness: true,
                    width: true,
                    length: true,
                    cavity: true,
                  },
                  orderBy: { createdAt: "desc" },
                },
              },
            },
          },
        },
        dies: { select: { diesCode: true, diesName: true, shotCounter: true } },
        mbomDetail: {
          include: {
            part: {
              select: {
                id: true,
                partCode: true,
                partNumber: true,
                partName: true,
                notes: true,
                material: {
                  select: {
                    materialCode: true,
                    materialType: true,
                    spec: true,
                  },
                },
                partBases: {
                  select: {
                    baseOn: true,
                    CSP: true,
                    thickness: true,
                    width: true,
                    length: true,
                    cavity: true,
                  },
                  orderBy: { createdAt: "desc" },
                },
              },
            },
            parentDetail: {
              include: {
                part: {
                  select: {
                    id: true,
                    partCode: true,
                    partNumber: true,
                    partName: true,
                  },
                },
              },
            },
            children: {
              where: { isDeleted: false },
              include: {
                part: {
                  select: {
                    id: true,
                    partCode: true,
                    partNumber: true,
                    partName: true,
                  },
                },
              },
              orderBy: [{ levelComponent: "asc" }, { createdAt: "asc" }],
            },
          },
        },
        process: { select: { processCode: true, processName: true } },
        machine: { select: { machineCode: true, machineName: true, costingRate: true, costingRateType: true, currencyCode: true } },
        uom: { select: { uomCode: true, uomName: true } },
        diesUsage: {
          select: {
            id: true,
            shotCount: true,
            qtyProduced: true,
            qtyGood: true,
            qtyReject: true,
            usageDate: true,
          },
        },
      },
    });

    if (!doc) return res.status(404).json({ message: "Data Work Order tidak ditemukan." });
    await attachOperationItems(doc);
    await attachOutputLocations(doc);
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { plannedDate, startTime, endTime, ...data } = req.body;
    if (data.shift !== undefined) data.shift = assertProductionShift(data.shift);

    const woNumber = await generateWoNumber();
    if (!data.uomCode && data.moId) {
      const mo = await prisma.manufacturingOrder.findUnique({
        where: { id: data.moId },
        select: { uomCode: true },
      });
      data.uomCode = mo?.uomCode || null;
    }
    assertQuantity(data.plannedQty, data.uomCode, "Planned Qty");
    Object.assign(
      data,
      await buildMachineCostSnapshot(prisma, data.machineId, data.cycleTime),
    );
    if (!data.outputPartCode && data.mbomDetailId) {
      Object.assign(data, await buildWorkOrderOutputPartSnapshot(prisma, data.mbomDetailId));
    }
    if (
      (!data.status || ["Draft", "Planned"].includes(data.status)) &&
      isSetupComplete(data)
    ) {
      data.status = "Released";
    }

    const doc = await prisma.workOrder.create({
      data: {
        ...data,
        woNumber,
        plannedDate: plannedDate ? new Date(plannedDate) : new Date(),
        startTime: startTime ? new Date(startTime) : null,
        endTime: endTime ? new Date(endTime) : null,
      },
      include: {
        manufacturingOrder: {
          select: {
            moNumber: true,
            uomCode: true,
            part: { select: { partCode: true, partName: true } },
          },
        },
        dies: { select: { diesCode: true, diesName: true } },
        mbomDetail: {
          include: {
            part: { select: { id: true, partCode: true, partNumber: true, partName: true } },
            parentDetail: {
              include: {
                part: { select: { id: true, partCode: true, partNumber: true, partName: true } },
              },
            },
          },
        },
        uom: { select: { uomCode: true, uomName: true } },
      },
    });

    await attachOperationItems(doc);
    res.status(201).json(mapDoc(doc));
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return res.status(404).json({ message: "Manufacturing Order tidak ditemukan." });
    }
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const { startTime, endTime, plannedDate, status, shotCount, qtyProduced, qtyGood, qtyReject, ...data } = req.body;

    // Ambil state WO saat ini
    const current = await prisma.workOrder.findUnique({
      where: { woNumber: req.params.woNumber },
      include: {
        manufacturingOrder: { select: { partId: true, uomCode: true } },
      },
    });

    if (!current) return res.status(404).json({ message: "Data Work Order tidak ditemukan." });
    if (current.isDeleted) return res.status(409).json({ message: WO_ALREADY_DELETED });
    if (shotCount !== undefined && Number(shotCount) < 0) {
      return res.status(400).json({ message: "Shot Count tidak boleh minus." });
    }

    const updateData = { ...data };
    if (updateData.plannedQty !== undefined) assertQuantity(updateData.plannedQty, current.uomCode || current.manufacturingOrder?.uomCode, "Planned Qty");
    if (updateData.shift !== undefined) updateData.shift = assertProductionShift(updateData.shift);
    if (plannedDate !== undefined) updateData.plannedDate = new Date(plannedDate);
    if (startTime !== undefined) updateData.startTime = startTime ? new Date(startTime) : null;
    if (endTime !== undefined) updateData.endTime = endTime ? new Date(endTime) : null;
    if (status !== undefined) updateData.status = status;
    if (shotCount !== undefined) updateData.shotCount = shotCount;
    if (qtyProduced !== undefined) updateData.qtyProduced = qtyProduced;
    if (qtyGood !== undefined) updateData.qtyGood = qtyGood;
    if (qtyReject !== undefined) updateData.qtyReject = qtyReject;
    if (data.machineId !== undefined || data.cycleTime !== undefined) {
      Object.assign(
        updateData,
        await buildMachineCostSnapshot(
          prisma,
          data.machineId !== undefined ? data.machineId : current.machineId,
          data.cycleTime !== undefined ? data.cycleTime : current.cycleTime,
        ),
      );
    }
    if (
      (!updateData.outputPartCode || data.mbomDetailId !== undefined) &&
      (data.mbomDetailId !== undefined ? data.mbomDetailId : current.mbomDetailId)
    ) {
      Object.assign(
        updateData,
        await buildWorkOrderOutputPartSnapshot(
          prisma,
          data.mbomDetailId !== undefined ? data.mbomDetailId : current.mbomDetailId,
        ),
      );
    }

    if (
      (status === undefined || ["Draft", "Planned"].includes(status)) &&
      ["Draft", "Planned"].includes(current.status) &&
      isSetupComplete(getProjectedSetup(current, updateData))
    ) {
      updateData.status = "Released";
    }

    // Cek apakah WO selesai DAN ada dies → auto DiesUsage
    const isCompletingNow = status === "Completed" && current.status !== "Completed";
    const newShotCount = shotCount ?? current.shotCount;
    const diesId = data.diesId ?? current.diesId;

    let result;

    if (isCompletingNow && diesId) {
      // Selesai + ada dies → buat/update DiesUsage dalam transaction
      result = await prisma.$transaction(async (tx) => {
        // Update WO dulu
        const wo = await tx.workOrder.update({
          where: { id: current.id },
          data: updateData,
        });

        const woSaved = await tx.workOrder.findUnique({
          where: { id: current.id },
          include: { machine: { select: { machineCode: true } } },
        });

        if (current.diesUsageId) {
          // DiesUsage sudah ada (WO pernah di-complete lalu di-reopen?) → adjust counter
          const oldUsage = await tx.diesUsage.findUnique({
            where: { id: current.diesUsageId },
            select: { shotCount: true },
          });
          const shotDiff = newShotCount - (oldUsage?.shotCount ?? 0);

          await tx.diesUsage.update({
            where: { id: current.diesUsageId },
            data: {
              shotCount: newShotCount,
              qtyProduced: qtyProduced ?? woSaved.qtyProduced,
              qtyGood: qtyGood ?? woSaved.qtyGood,
              qtyReject: qtyReject ?? woSaved.qtyReject,
              endTime: endTime ? new Date(endTime) : woSaved.endTime,
              runningMinutes: woSaved.runningMinutes,
            },
          });
          await adjustDiesShotCounter(tx, diesId, shotDiff);
        } else {
          // Buat DiesUsage baru
          await autoCreateDiesUsage(tx, { ...woSaved, diesId, woNumber: current.woNumber }, current.manufacturingOrder?.partId);
        }

        return wo;
      });
    } else if (current.diesUsageId && shotCount !== undefined && shotCount !== current.shotCount) {
      // Sudah ada DiesUsage dan shotCount berubah → adjust counter
      result = await prisma.$transaction(async (tx) => {
        const wo = await tx.workOrder.update({
          where: { id: current.id },
          data: updateData,
        });
        const shotDiff = shotCount - current.shotCount;
        await adjustDiesShotCounter(tx, current.diesId, shotDiff);
        await tx.diesUsage.update({
          where: { id: current.diesUsageId },
          data: {
            shotCount,
            qtyProduced: qtyProduced ?? wo.qtyProduced,
            qtyGood: qtyGood ?? wo.qtyGood,
            qtyReject: qtyReject ?? wo.qtyReject,
          },
        });
        return wo;
      });
    } else {
      // Update biasa tanpa perubahan shot counter
      result = await prisma.workOrder.update({
        where: { id: current.id },
        data: updateData,
      });
    }

    const shouldSyncMoQty =
      qtyProduced !== undefined ||
      qtyGood !== undefined ||
      qtyReject !== undefined ||
      status !== undefined;
    const syncedMo = shouldSyncMoQty
      ? await prisma.$transaction((tx) =>
          syncManufacturingOrderQtyFromWorkOrders(tx, current.moId),
        )
      : null;

    // Kembalikan data dengan relasi
    const doc = await prisma.workOrder.findUnique({
      where: { id: current.id },
      include: {
        manufacturingOrder: {
          select: {
            moNumber: true,
            part: { select: { partCode: true, partName: true } },
          },
        },
        dies: { select: { diesCode: true, diesName: true, shotCounter: true } },
        mbomDetail: {
          include: {
            part: { select: { id: true, partCode: true, partNumber: true, partName: true } },
            parentDetail: {
              include: {
                part: { select: { id: true, partCode: true, partNumber: true, partName: true } },
              },
            },
          },
        },
        diesUsage: {
          select: { id: true, shotCount: true, qtyProduced: true, qtyGood: true, qtyReject: true },
        },
      },
    });

    if (syncedMo) {
      emitManufacturingOrderUpdate(syncedMo, "sync", req.user?.username || "system");
    }
    await attachOperationItems(doc);
    res.json(mapDoc(doc));
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return res.status(404).json({ message: "Data Work Order tidak ditemukan." });
    }
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const existing = await prisma.workOrder.findUnique({
      where: { woNumber: req.params.woNumber },
      select: { id: true, woNumber: true, moId: true, isDeleted: true, status: true, diesId: true, diesUsageId: true },
    });

    if (!existing) return res.status(404).json({ message: "Data Work Order tidak ditemukan." });
    if (existing.isDeleted) return res.status(409).json({ message: WO_ALREADY_DELETED });
    if (!["Draft", "Planned", "Released"].includes(existing.status)) {
      return res.status(409).json({
        message: existing.status === "Completed"
          ? WO_COMPLETED_LOCKED
          : `WO status "${existing.status}" tidak bisa dihapus. Gunakan cancel jika masih memungkinkan.`,
      });
    }

    const blockers = await getWorkOrderActivityBlockers(prisma, existing);
    if (blockers.length > 0) {
      return res.status(409).json({
        message: `WO tidak bisa dihapus karena sudah punya data terkait: ${formatRelationList(blockers)}. Gunakan cancel jika belum ada transaksi produksi.`,
      });
    }

    const txResult = await prisma.$transaction(async (tx) => {
      const deleted = await tx.workOrder.updateMany({
        where: { id: existing.id, isDeleted: false },
        data: { isDeleted: true },
      });
      const restoredPlannedOrders = await restoreCoveredPlannedOrdersIfNoActiveWorkOrders(tx, existing.moId);
      const syncedMo = await syncManufacturingOrderQtyFromWorkOrders(tx, existing.moId);
      return { deleted, restoredPlannedOrders, syncedMo };
    });

    if (txResult.deleted.count === 0) return res.status(409).json({ message: WO_ALREADY_DELETED });
    if (txResult.syncedMo) {
      emitManufacturingOrderUpdate(txResult.syncedMo, "sync", req.user?.username || "system");
    }
    if (txResult.restoredPlannedOrders.length > 0) {
      emitPlanningPlannedOrderBulkUpdate(
        txResult.restoredPlannedOrders,
        "restore",
        req.user?.username || "system",
      );
    }
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

    const records = await prisma.workOrder.findMany({
      where: { id: { in: ids }, isDeleted: false },
      select: { id: true, woNumber: true, moId: true, status: true, diesUsageId: true },
    });

    const deletable = [];
    const skipped = [];
    for (const wo of records) {
      if (!["Draft", "Planned", "Released"].includes(wo.status)) {
        skipped.push({ woNumber: wo.woNumber, reason: `status ${wo.status}` });
        continue;
      }

      const blockers = await getWorkOrderActivityBlockers(prisma, wo);
      if (blockers.length > 0) {
        skipped.push({ woNumber: wo.woNumber, reason: formatRelationList(blockers) });
      } else {
        deletable.push(wo);
      }
    }

    if (deletable.length === 0) {
      return res.status(409).json({
        message: "Tidak ada WO yang bisa dihapus. WO hanya bisa dihapus jika Draft/Planned/Released dan belum punya aktivitas produksi terkait.",
        skipped,
      });
    }

    const moIds = [...new Set(deletable.map((wo) => wo.moId).filter(Boolean))];
    const syncedMos = await prisma.$transaction(async (tx) => {
      const items = [];
      const restoredPlannedOrders = [];
      const result = await tx.workOrder.updateMany({
        where: { id: { in: deletable.map((wo) => wo.id) }, isDeleted: false },
        data: { isDeleted: true },
      });
      for (const moId of moIds) {
        restoredPlannedOrders.push(...await restoreCoveredPlannedOrdersIfNoActiveWorkOrders(tx, moId));
        items.push(await syncManufacturingOrderQtyFromWorkOrders(tx, moId));
      }
      return { items, restoredPlannedOrders, result };
    });
    for (const mo of syncedMos.items.filter(Boolean)) {
      emitManufacturingOrderUpdate(mo, "sync", req.user?.username || "system");
    }
    if (syncedMos.restoredPlannedOrders.length > 0) {
      emitPlanningPlannedOrderBulkUpdate(
        syncedMos.restoredPlannedOrders,
        "restore",
        req.user?.username || "system",
      );
    }

    res.json({ deletedCount: syncedMos.result.count, skipped });
  } catch (e) {
    next(e);
  }
};

// ============================================================
// HELPER ROUTES
// ============================================================

exports.generateNumber = async (req, res, next) => {
  try {
    const woNumber = await generateWoNumber();
    res.json({ woNumber });
  } catch (e) { next(e); }
};

exports.autocomplete = async (req, res, next) => {
  try {
    const { q, moId, status } = req.query;
    const where = { isDeleted: false };
    if (moId) where.moId = moId;
    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;
    if (q) {
      where.OR = [
        { woNumber: { contains: q, mode: "insensitive" } },
        { machine: { machineCode: { contains: q, mode: "insensitive" } } },
        { manufacturingOrder: { moNumber: { contains: q, mode: "insensitive" } } },
      ];
    }
    const items = await prisma.workOrder.findMany({
      where,
      take: 20,
      orderBy: { plannedDate: "asc" },
      select: {
        id: true, woNumber: true, status: true, machineId: true, shift: true,
        plannedDate: true, plannedQty: true, qtyProduced: true, uomCode: true,
        machine: { select: { machineCode: true } },
        manufacturingOrder: { select: { moNumber: true, uomCode: true } },
        uom: { select: { uomCode: true, uomName: true } },
      },
    });
    res.json(items.map(mapDoc));
  } catch (e) { next(e); }
};

// ============================================================
// STATUS TRANSITION ACTIONS
// ============================================================

// Released/Material Issued/Rework → In Production
exports.start = async (req, res, next) => {
  try {
    const existing = await prisma.workOrder.findUnique({
      where: { woNumber: req.params.woNumber },
      select: {
        id: true,
        moId: true,
        mbomDetailId: true,
        sequence: true,
        isDeleted: true,
        status: true,
        woNumber: true,
        machineId: true,
        diesId: true,
        shift: true,
        operatorName: true,
        notes: true,
        mbomDetail: {
          select: {
            part: {
              select: { partCode: true },
            },
          },
        },
      },
    });
    if (!existing || existing.isDeleted) return res.status(404).json({ message: "Data Work Order tidak ditemukan." });
    if (!isWorkOrderStartableStatus(existing.status)) {
      return res.status(409).json({ message: `WO tidak bisa dimulai dari status "${existing.status}".` });
    }

    const previousOpen = await prisma.workOrder.findFirst({
      where: {
        moId: existing.moId,
        isDeleted: false,
        status: { notIn: ["Completed", "Cancelled"] },
        sequence: { lt: existing.sequence },
      },
      orderBy: { sequence: "asc" },
      select: { woNumber: true, sequence: true, status: true },
    });
    if (previousOpen) {
      return res.status(409).json({
        message: `WO sebelumnya belum selesai: ${previousOpen.woNumber} (seq ${previousOpen.sequence}, ${previousOpen.status}).`,
      });
    }

    if (existing.status !== "Rework") {
      const materialReady = await validateMaterialReadyForWorkOrder(existing);
      if (!materialReady.ok) {
        return res.status(409).json({ message: materialReady.message });
      }
    }
    const missingSetup = [];
    if (!existing.machineId) missingSetup.push("Machine");
    if (!existing.diesId) missingSetup.push("Dies");
    if (!existing.shift) missingSetup.push("Shift");
    if (!existing.operatorName) missingSetup.push("Operator");
    if (missingSetup.length > 0) {
      return res.status(409).json({
        message: `WO belum bisa dimulai. ${missingSetup.join(", ")} belum dipilih.`,
      });
    }

    const doc = await prisma.$transaction(async (tx) => {
      const updated = await tx.workOrder.update({
        where: { id: existing.id },
        data: { status: "In Production", startTime: new Date() },
      });

      await tx.manufacturingOrder.updateMany({
        where: { id: existing.moId, status: { in: ["Released"] } },
        data: { status: "In Progress", actualStartDate: new Date() },
      });

      return updated;
    });
    const updatedMo = await prisma.manufacturingOrder.findUnique({
      where: { id: existing.moId },
    });
    emitWorkOrderUpdate(doc, "start", req.user?.username || "system");
    emitManufacturingOrderUpdate(updatedMo, "start", req.user?.username || "system");
    res.json(mapDoc(doc));
  } catch (e) { next(e); }
};

// In Progress → Completed (auto DiesUsage jika ada dies + shotCount)
exports.complete = async (req, res, next) => {
  try {
    const { shotCount, qtyProduced, qtyGood, qtyReject, endTime, runningMinutes } = req.body;

    const current = await prisma.workOrder.findUnique({
      where: { woNumber: req.params.woNumber },
      include: { manufacturingOrder: { select: { partId: true } } },
    });
    if (!current || current.isDeleted) return res.status(404).json({ message: "Data Work Order tidak ditemukan." });
    if (!isWorkOrderProductionStatus(current.status)) {
      return res.status(409).json({ message: `WO tidak bisa diselesaikan dari status "${current.status}".` });
    }
    if (shotCount !== undefined && Number(shotCount) < 0) {
      return res.status(400).json({ message: "Shot Count tidak boleh minus." });
    }

    const newShotCount = shotCount ?? current.shotCount;

    const updateData = {
      status: "Completed",
      endTime: endTime ? new Date(endTime) : new Date(),
      shotCount: newShotCount,
    };
    if (qtyProduced !== undefined) updateData.qtyProduced = qtyProduced;
    if (qtyGood     !== undefined) updateData.qtyGood     = qtyGood;
    if (qtyReject   !== undefined) updateData.qtyReject   = qtyReject;
    if (runningMinutes !== undefined) updateData.runningMinutes = runningMinutes;
    updateData.actualProcessCost = getActualProcessCost({ ...current, ...updateData });

    let result;
    if (current.diesId) {
      result = await prisma.$transaction(async (tx) => {
        const wo = await tx.workOrder.update({ where: { id: current.id }, data: updateData });
        const woSaved = await tx.workOrder.findUnique({
          where: { id: current.id },
          include: { machine: { select: { machineCode: true } } },
        });
        if (current.diesUsageId) {
          const oldUsage = await tx.diesUsage.findUnique({
            where: { id: current.diesUsageId }, select: { shotCount: true },
          });
          const shotDiff = newShotCount - (oldUsage?.shotCount ?? 0);
          await tx.diesUsage.update({
            where: { id: current.diesUsageId },
            data: { shotCount: newShotCount, qtyProduced: woSaved.qtyProduced, qtyGood: woSaved.qtyGood, qtyReject: woSaved.qtyReject, endTime: woSaved.endTime, runningMinutes: woSaved.runningMinutes },
          });
          await adjustDiesShotCounter(tx, current.diesId, shotDiff);
        } else {
          await autoCreateDiesUsage(tx, { ...woSaved, diesId: current.diesId, woNumber: current.woNumber }, current.manufacturingOrder?.partId);
        }

        // Catat WIP Entry — actual machine/process cost masuk WIP.
        const finalQtyProduced = woSaved.qtyProduced || 0;
        if (finalQtyProduced > 0) {
          const actualProcessCost = toNumber(woSaved.actualProcessCost);
          await createWIPEntry(tx, {
            entryDate: new Date(),
            moId: current.moId,
            woId: current.id,
            costType: "Overhead",
            sourceType: "WorkOrder",
            sourceId: current.id,
            sourceRef: current.woNumber,
            partCode: current.outputPartCode || null,
            partNumber: current.outputPartNumber || null,
            partName: current.outputPartName || null,
            uomCode: current.uomCode || null,
            stockType: "WIP",
            qty: finalQtyProduced,
            rate: finalQtyProduced > 0 ? actualProcessCost / finalQtyProduced : 0,
            amount: actualProcessCost,
            direction: "IN",
            notes: `WO ${current.woNumber} actual machine cost (qty: ${finalQtyProduced})`,
            createdBy: req.user?.username || "system",
          });
        }

        const closedMaterialIssues = await closeMaterialIssuesIfReady(tx, current.moId);
        const syncedMo = await syncManufacturingOrderQtyFromWorkOrders(tx, current.moId);
        wo.automation = { closedMaterialIssues, manufacturingOrder: syncedMo };
        return wo;
      });
    } else {
      result = await prisma.$transaction(async (tx) => {
        const wo = await tx.workOrder.update({ where: { id: current.id }, data: updateData });
        const woSaved = await tx.workOrder.findUnique({ where: { id: current.id } });

        // Catat WIP Entry — actual machine/process cost masuk WIP.
        const finalQtyProduced = woSaved.qtyProduced || 0;
        if (finalQtyProduced > 0) {
          const actualProcessCost = toNumber(woSaved.actualProcessCost);
          await createWIPEntry(tx, {
            entryDate: new Date(),
            moId: current.moId,
            woId: current.id,
            costType: "Overhead",
            sourceType: "WorkOrder",
            sourceId: current.id,
            sourceRef: current.woNumber,
            partCode: current.outputPartCode || null,
            partNumber: current.outputPartNumber || null,
            partName: current.outputPartName || null,
            uomCode: current.uomCode || null,
            stockType: "WIP",
            qty: finalQtyProduced,
            rate: finalQtyProduced > 0 ? actualProcessCost / finalQtyProduced : 0,
            amount: actualProcessCost,
            direction: "IN",
            notes: `WO ${current.woNumber} actual machine cost (qty: ${finalQtyProduced})`,
            createdBy: req.user?.username || "system",
          });
        }

        const closedMaterialIssues = await closeMaterialIssuesIfReady(tx, current.moId);
        const syncedMo = await syncManufacturingOrderQtyFromWorkOrders(tx, current.moId);
        wo.automation = { closedMaterialIssues, manufacturingOrder: syncedMo };
        return wo;
      });
    }

    const doc = await prisma.workOrder.findUnique({
      where: { id: current.id },
      include: {
        manufacturingOrder: { select: { moNumber: true, part: { select: { partCode: true, partName: true } } } },
        dies: { select: { diesCode: true, diesName: true, shotCounter: true } },
        diesUsage: { select: { id: true, shotCount: true, qtyProduced: true, qtyGood: true, qtyReject: true } },
      },
    });
    emitWorkOrderUpdate(doc, "complete", req.user?.username || "system");
    if (result?.automation?.manufacturingOrder) {
      emitManufacturingOrderUpdate(
        result.automation.manufacturingOrder,
        "sync",
        req.user?.username || "system",
      );
    }
    res.json({
      ...mapDoc(doc),
      automation: result?.automation || null,
    });
  } catch (e) { next(e); }
};

// ============================================================
// DISPATCH LIST — daftar WO per process untuk operator lantai
// GET /dispatch?processId=X&date=2026-04-06
// Response: WO urut by sequence, dilengkapi info MO + part + dies + mesin
// ============================================================
exports.dispatch = async (req, res, next) => {
  try {
    const { processId, processCode, date, status } = req.query;

    // Filter tanggal: default hari ini
    const targetDate = date ? new Date(date) : new Date();
    const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
    const endOfDay   = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);

    const where = { isDeleted: false };

    if (processId) {
      where.processId = processId;
    } else if (processCode) {
      where.process = { processCode: { equals: processCode, mode: "insensitive" } };
    }

    // Default tampilkan WO yang Planned atau In Progress pada tanggal tsb
    const statusFilter = parseFilter(status);
    if (statusFilter) {
      where.status = statusFilter;
    } else {
      where.status = { in: ["Planned", "In Progress"] };
    }

    where.plannedDate = { gte: startOfDay, lte: endOfDay };

    const workOrders = await prisma.workOrder.findMany({
      where,
      orderBy: [{ sequence: "asc" }, { plannedDate: "asc" }],
      include: {
        manufacturingOrder: {
          select: {
            moNumber: true,
            status: true,
            qtyPlanned: true,
            uomCode: true,
            qtyProduced: true,
            qtyGood: true,
            plannedEndDate: true,
            part: { select: { partCode: true, partNumber: true, partName: true } },
          },
        },
        process: { select: { processCode: true, processName: true } },
        machine: { select: { machineCode: true, machineName: true, status: true } },
        dies: { select: { diesCode: true, diesName: true, shotCounter: true, maxShotLifetime: true, status: true } },
      },
    });

    // Hitung summary
    const summary = {
      total:      workOrders.length,
      planned:    workOrders.filter(w => w.status === "Planned").length,
      inProgress: workOrders.filter(w => w.status === "In Progress").length,
      totalQtyPlanned:  workOrders.reduce((s, w) => s + (w.plannedQty || 0), 0),
      totalQtyProduced: workOrders.reduce((s, w) => s + (w.qtyProduced || 0), 0),
    };

    res.json({
      date: startOfDay.toISOString().split("T")[0],
      processId: processId || null,
      processCode: processCode || workOrders[0]?.process?.processCode || null,
      summary,
      items: workOrders.map(mapDoc),
    });
  } catch (e) { next(e); }
};

// Draft/Planned/In Progress → Cancelled
exports.cancel = async (req, res, next) => {
  try {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) {
      return res.status(400).json({ message: "Alasan cancel WO wajib diisi." });
    }

    const existing = await prisma.workOrder.findUnique({
      where: { woNumber: req.params.woNumber },
      select: { id: true, woNumber: true, moId: true, isDeleted: true, status: true, diesUsageId: true },
    });
    if (!existing || existing.isDeleted) return res.status(404).json({ message: "Data Work Order tidak ditemukan." });
    if (existing.status === "Completed") {
      return res.status(409).json({ message: "WO yang sudah selesai tidak bisa dibatalkan." });
    }
    if (existing.status === "Cancelled") {
      return res.status(409).json({ message: "WO sudah berstatus Cancelled." });
    }

    const blockers = await getWorkOrderActivityBlockers(prisma, existing);
    if (blockers.length > 0) {
      return res.status(409).json({
        message: `WO tidak bisa dibatalkan otomatis karena sudah ada aktivitas produksi: ${formatRelationList(blockers)}.`,
      });
    }

    const doc = await prisma.$transaction(async (tx) => {
      const updated = await tx.workOrder.update({
        where: { id: existing.id },
        data: { status: "Cancelled", notes: reason },
      });

      await tx.dailyProductionSchedule.updateMany({
        where: {
          woId: existing.id,
          isDeleted: false,
          status: { in: ["Draft", "Released", "In Progress"] },
        },
        data: {
          status: "Cancelled",
          notes: reason,
        },
      });

      const syncedMo = await syncManufacturingOrderQtyFromWorkOrders(tx, existing.moId);
      const restoredPlannedOrders = await restoreCoveredPlannedOrdersIfNoActiveWorkOrders(tx, existing.moId);
      updated.automation = { manufacturingOrder: syncedMo };
      updated.restoredPlannedOrders = restoredPlannedOrders;
      return updated;
    });
    emitWorkOrderUpdate(doc, "cancel", req.user?.username || "system");
    if (doc.automation?.manufacturingOrder) {
      emitManufacturingOrderUpdate(
        doc.automation.manufacturingOrder,
        "sync",
        req.user?.username || "system",
      );
    }
    if (doc.restoredPlannedOrders?.length > 0) {
      emitPlanningPlannedOrderBulkUpdate(
        doc.restoredPlannedOrders,
        "restore",
        req.user?.username || "system",
      );
    }
    res.json(mapDoc(doc));
  } catch (e) { next(e); }
};


