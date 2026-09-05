const { prisma } = require("../../index");
const { Prisma } = require("@prisma/client");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { parseFilter } = require("../../utils/parseFilter");
const { generateMovementNumber } = require("../../utils/movementNumberGenerator");
const { incrementDiesShotCounter } = require("../../utils/diesShotCounter");
const { createWIPEntry } = require("./WIPController");
const { assertStockBalanceNotFrozen, assertStockIdentityNotFrozen } = require("../inventory/utils/stockOpnameFreezeGuard");
const {
  buildExcludeSpecialRackCondition,
  resolveReservationBalanceWhere,
} = require("../inventory/utils/stockReservationHelpers");
const {
  assertProductionShift,
  calculateDurationMinutes,
  generateDailyNumber,
  isWorkOrderProductionStatus,
  resolveProductionRefs,
  toDateTime,
  toNumber,
} = require("./services/productionIntegrationHelpers");
const {
  getMaterialRequirements,
  syncManufacturingOrderQtyFromWorkOrders,
} = require("./services/productionWorkflowService");
const {
  emitManufacturingOrderUpdate,
} = require("./services/productionRealtimeService");
const { getFormulaSet, evaluateFromSet } = require("../../services/masterFormulaService");
const { submitDocumentForApproval } = require("../../services/approvalRuleService");
const {
  ensureDefaultNumberingRule,
  generateConfiguredNumber,
} = require("../../services/numberingService");
const { assertQuantity } = require("../../utils/uomQuantity");
const { lockStockBalanceIdentity } = require("../../services/inventory/stockBalanceLockService");
const {
  createProductionShortfallCarryover,
  rollbackProductionShortfallCarryover,
} = require("../../services/planning/productionShortfallCarryoverService");

const QUANTITY_TOLERANCE = 0.000001;
const PRODUCTION_APPROVAL_TRANSACTION_OPTIONS = { maxWait: 10000, timeout: 30000 };

function formatRelationList(items) {
  return items.filter(Boolean).join(", ");
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

function getLogDurationMinutes(log = {}) {
  if (toNumber(log.runningMinutes) > 0) return toNumber(log.runningMinutes);
  if (!log.startTime || !log.endTime) return 0;

  const start = new Date(log.startTime).getTime();
  const end = new Date(log.endTime).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, (end - start) / 60000);
}

function getDurationFromInput(startTime, endTime) {
  if (!startTime || !endTime) return null;
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, (end - start) / 60000);
}

function getReservationLineNumber(referenceNumber) {
  const token = String(referenceNumber || "").split("#").pop()?.split("@")[0];
  const lineNumber = Number(token);
  return Number.isFinite(lineNumber) ? lineNumber : null;
}

async function consumeReservedSubAssembliesForProductionLog(tx, log, performedBy = "system") {
  if (!log?.manufacturingOrder?.id || !log?.workOrder?.mbomDetailId) return [];

  const requirements = await getMaterialRequirements(tx, log.manufacturingOrder);
  const subAssemblies = requirements.items.filter(
    (item) => item.isSubAssembly && item.parentDetailId === log.workOrder.mbomDetailId,
  );
  if (subAssemblies.length === 0) return [];
  const issuedAssemblyDetails = await tx.materialIssueDetail.findMany({
    where: {
      isDeleted: false,
      partCode: { in: subAssemblies.map((item) => item.partCode).filter(Boolean) },
      materialIssue: {
        woId: log.workOrder.id,
        isDeleted: false,
        status: { in: ["Issued", "Partially Returned", "Closed"] },
      },
    },
    select: {
      partCode: true,
      qtyIssued: true,
      qtyReturned: true,
    },
  });
  const materialIssuedByPart = new Map();
  for (const detail of issuedAssemblyDetails) {
    const netIssued = Math.max(0, toNumber(detail.qtyIssued) - toNumber(detail.qtyReturned));
    materialIssuedByPart.set(
      detail.partCode,
      toNumber(materialIssuedByPart.get(detail.partCode)) + netIssued,
    );
  }

  const producedQty = toNumber(log.qtyProduced);
  if (producedQty <= QUANTITY_TOLERANCE) return [];
  const approvedOutput = await tx.productionLog.aggregate({
    where: {
      woId: log.workOrder.id,
      status: "Approved",
      isDeleted: false,
    },
    _sum: { qtyProduced: true },
  });
  const cumulativeApprovedQty = Math.max(
    producedQty,
    toNumber(approvedOutput._sum?.qtyProduced),
  );
  const approvedLogNumbers = await tx.productionLog.findMany({
    where: {
      woId: log.workOrder.id,
      status: "Approved",
      isDeleted: false,
    },
    select: { logNumber: true },
  });

  const reservations = await tx.stockReservation.findMany({
    where: {
      referenceType: "MANUFACTURING_ORDER",
      referenceNumber: { startsWith: `${log.manufacturingOrder.moNumber}#` },
      isDeleted: false,
      status: { in: ["Active", "Released"] },
    },
    orderBy: { createdAt: "asc" },
  });
  const movementNumbers = [];

  for (const item of subAssemblies) {
    const requiredForOutput =
      Math.round(toNumber(item.qtyPer) * cumulativeApprovedQty * 1000000) / 1000000;
    const previouslyConsumed = await tx.stockMovement.aggregate({
      where: {
        movementType: "OUT",
        qualityBucket: "SUB_ASSEMBLY",
        referenceType: "PRODUCTION_LOG",
        referenceNumber: {
          in: approvedLogNumbers.map((item) => item.logNumber),
        },
        partCode: item.partCode,
        isDeleted: false,
      },
      _sum: { qty: true },
    });
    // A sub-assembly explicitly posted through Material Issue has already
    // left inventory. Production Log approval must not deduct it a second time.
    let remaining = Math.max(
      0,
      requiredForOutput
        - toNumber(materialIssuedByPart.get(item.partCode))
        - toNumber(previouslyConsumed._sum?.qty),
    );
    if (remaining <= QUANTITY_TOLERANCE) continue;
    const lineReservations = reservations.filter(
      (reservation) => getReservationLineNumber(reservation.referenceNumber) === item.lineNumber,
    );
    const remainingReserved = lineReservations.reduce(
      (sum, reservation) =>
        sum + Math.max(0, toNumber(reservation.qtyReserved) - toNumber(reservation.qtyReleased)),
      0,
    );

    if (remainingReserved + QUANTITY_TOLERANCE < remaining) {
      throw Object.assign(
        new Error(
          `Sub-assembly ${item.partCode} belum cukup untuk approve ${log.logNumber}. ` +
          `Reserved tersisa ${remainingReserved}, dibutuhkan ${remaining} ${item.uomCode || "pcs"}.`,
        ),
        { statusCode: 409 },
      );
    }

    for (const reservation of lineReservations) {
      if (remaining <= QUANTITY_TOLERANCE) break;
      const reservable = Math.max(
        0,
        toNumber(reservation.qtyReserved) - toNumber(reservation.qtyReleased),
      );
      const consumeQty = Math.min(reservable, remaining);
      if (consumeQty <= QUANTITY_TOLERANCE) continue;

      const reservationBalanceWhere = resolveReservationBalanceWhere(reservation);
      await lockStockBalanceIdentity(tx, reservationBalanceWhere);
      const stockBalance = await tx.stockBalance.findFirst({
        where: reservationBalanceWhere,
      });
      if (!stockBalance || toNumber(stockBalance.qtyOnHand) + QUANTITY_TOLERANCE < consumeQty) {
        throw Object.assign(
          new Error(`Stock sub-assembly ${item.partCode} tidak cukup untuk dikonsumsi.`),
          { statusCode: 409 },
        );
      }

      await assertStockBalanceNotFrozen(tx, stockBalance.id);
      const qtyBefore = toNumber(stockBalance.qtyOnHand);
      const qtyAfter = Math.max(0, qtyBefore - consumeQty);
      const reservedAfter = Math.max(0, toNumber(stockBalance.qtyReserved) - consumeQty);
      const movementNumber = await generateMovementNumber("OUT", tx);

      await tx.stockMovement.create({
        data: {
          movementNumber,
          movementDate: new Date(),
          movementType: "OUT",
          direction: "OUT",
          transactionType: "PRODUCTION",
          warehouseCode: stockBalance.warehouseCode,
          rackCode: stockBalance.rackCode || null,
          lotNumber: stockBalance.lotNumber || null,
          partCode: stockBalance.partCode,
          partNumber: stockBalance.partNumber || null,
          partName: stockBalance.partName || null,
          productId: stockBalance.productId || null,
          description: stockBalance.description || null,
          spec: stockBalance.spec || null,
          thickness: stockBalance.thickness ?? null,
          width: stockBalance.width ?? null,
          CSP: stockBalance.CSP || null,
          stockType: stockBalance.stockType || null,
          qty: consumeQty,
          deltaQty: -consumeQty,
          qtyBefore,
          qtyAfter,
          uomCode: stockBalance.uomCode || item.uomCode || null,
          qualityBucket: "SUB_ASSEMBLY",
          referenceType: "PRODUCTION_LOG",
          referenceNumber: log.logNumber,
          notes: `Sub-assembly ${item.partCode} dikonsumsi oleh ${log.workOrder.woNumber}`,
          performedBy,
        },
      });

      await tx.stockBalance.update({
        where: { id: stockBalance.id },
        data: {
          qtyOnHand: qtyAfter,
          qtyReserved: reservedAfter,
          qtyAvailable: Math.max(0, qtyAfter - reservedAfter - toNumber(stockBalance.qtyQC)),
          lastMovement: new Date(),
        },
      });

      const releasedAfter = toNumber(reservation.qtyReleased) + consumeQty;
      await tx.stockReservation.update({
        where: { id: reservation.id },
        data: {
          qtyReleased: releasedAfter,
          status:
            releasedAfter + QUANTITY_TOLERANCE >= toNumber(reservation.qtyReserved)
              ? "Released"
              : "Active",
          notes: `Sub-assembly consumed by ${log.logNumber}`,
        },
      });

      reservation.qtyReleased = releasedAfter;
      movementNumbers.push(movementNumber);
      remaining = Math.max(0, remaining - consumeQty);
    }
  }

  return movementNumbers;
}

async function reconcileApprovedProductionLogSubAssemblies(
  tx,
  logNumber,
  performedBy = "system",
) {
  const log = await tx.productionLog.findFirst({
    where: { logNumber, status: "Approved", isDeleted: false },
    include: {
      manufacturingOrder: true,
      workOrder: {
        select: {
          id: true,
          woNumber: true,
          mbomDetailId: true,
        },
      },
    },
  });
  if (!log) {
    throw Object.assign(new Error(`Approved Production Log ${logNumber} tidak ditemukan.`), {
      statusCode: 404,
    });
  }

  const existingMovementCount = await tx.stockMovement.count({
    where: {
      referenceType: "PRODUCTION_LOG",
      referenceNumber: logNumber,
      qualityBucket: "SUB_ASSEMBLY",
      movementType: "OUT",
      isDeleted: false,
    },
  });
  if (existingMovementCount > 0) return [];

  return consumeReservedSubAssembliesForProductionLog(tx, log, performedBy);
}

async function syncWorkOrderActualsFromApprovedLogs(tx, woId) {
  if (!woId) return null;

  const [wo, approvedLogs] = await Promise.all([
    tx.workOrder.findUnique({
      where: { id: woId },
      select: {
        id: true,
        plannedQty: true,
        machineCostingRate: true,
        machineRateType: true,
      },
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
      },
      orderBy: [{ startTime: "asc" }, { logDate: "asc" }],
    }),
  ]);
  if (!wo) return null;

  const totalQtyProduced = approvedLogs.reduce((sum, log) => sum + toNumber(log.qtyProduced), 0);
  const totalQtyGood = approvedLogs.reduce((sum, log) => sum + toNumber(log.qtyGood), 0);
  const totalQtyReject = approvedLogs.reduce((sum, log) => sum + toNumber(log.qtyReject), 0);
  const totalRunningMinutes = approvedLogs.reduce((sum, log) => sum + getLogDurationMinutes(log), 0);
  const actualProcessCost =
    totalRunningMinutes * 60 * toMachineRatePerSecond(wo.machineCostingRate, wo.machineRateType);
  const firstStartTime = approvedLogs.find((log) => log.startTime)?.startTime || null;
  const lastEndTime = [...approvedLogs].reverse().find((log) => log.endTime)?.endTime || null;

  return tx.workOrder.update({
    where: { id: woId },
    data: {
      qtyProduced: totalQtyProduced,
      qtyGood: totalQtyGood,
      qtyReject: totalQtyReject,
      runningMinutes: totalRunningMinutes || null,
      ...(firstStartTime ? { startTime: firstStartTime } : {}),
      ...(lastEndTime ? { endTime: lastEndTime } : {}),
      actualProcessCost,
    },
  });
}

// Generate nomor Log Produksi otomatis: LOG-YYYYMMDD-001
async function generateLogNumber() {
  return generateDailyNumber(prisma, "productionLog", "logNumber", "LOG");
}

async function generateDowntimeNumber(tx) {
  return generateDailyNumber(tx, "downtimeLog", "downtimeNumber", "DT");
}

async function findDailyProductionSchedule(tx, { dpsId, scheduleNumber } = {}) {
  if (!dpsId && !scheduleNumber) return null;
  const where = scheduleNumber
    ? { scheduleNumber, isDeleted: false }
    : { id: dpsId, isDeleted: false };
  const schedule = await tx.dailyProductionSchedule.findFirst({
    where,
    include: {
      productionPlan: { select: { id: true, planNumber: true, status: true } },
      productionPlanAllocation: { select: { id: true, lineNumber: true, mbomProcessId: true, status: true } },
      mbomProcess: { select: { id: true, processId: true, sequence: true } },
    },
  });
  if (!schedule) {
    throw Object.assign(new Error("Daily Production Schedule tidak ditemukan."), {
      statusCode: 404,
    });
  }
  if (schedule.status !== "In Progress") {
    throw Object.assign(
      new Error(`Production Log hanya dapat dicatat dari Daily Production Plan berstatus In Progress. Status saat ini "${schedule.status}".`),
      { statusCode: 409, code: "DAILY_PLAN_NOT_IN_PROGRESS" },
    );
  }
  return schedule;
}

async function findRelatedDailyProductionSchedule(
  tx,
  { woId, moId, logDate, shift, processCode, machineCode } = {},
) {
  if (!woId && !moId) return null;
  const workOrder = woId
    ? await tx.workOrder.findFirst({
        where: { id: woId, isDeleted: false },
        select: {
          woNumber: true,
          outputPartCode: true,
          processId: true,
          machineId: true,
          process: { select: { processCode: true } },
          machine: { select: { machineCode: true } },
        },
      })
    : null;
  const candidates = await tx.dailyProductionSchedule.findMany({
    where: {
      isDeleted: false,
      status: { in: ["Draft", "Released", "In Progress"] },
      OR: [
        ...(woId ? [{ woId }] : []),
        ...(moId ? [{ moId }] : []),
      ],
    },
    orderBy: [{ scheduleDate: "asc" }, { createdAt: "asc" }],
    take: 100,
  });
  const eligibleCandidates = candidates.filter((row) => !row.woId || row.woId === woId);
  if (!eligibleCandidates.length) return null;
  const wantedDay = logDate ? new Date(logDate).toISOString().slice(0, 10) : null;
  const wantedShift = String(shift || "").trim().toUpperCase();
  return [...eligibleCandidates].sort((left, right) => {
    const score = (row) => {
      let value = 0;
      if (woId && row.woId === woId) value += 100;
      if (moId && row.moId === moId) value += 20;
      if (workOrder?.outputPartCode && row.partCode === workOrder.outputPartCode) value += 60;
      if (workOrder?.processId && row.processId === workOrder.processId) value += 50;
      if (workOrder?.machineId && row.machineId === workOrder.machineId) value += 30;
      if (processCode && workOrder?.process?.processCode === processCode) value += 5;
      if (machineCode && workOrder?.machine?.machineCode === machineCode) value += 3;
      if (wantedDay && new Date(row.scheduleDate).toISOString().slice(0, 10) === wantedDay) value += 10;
      if (wantedShift && String(row.shift || "").trim().toUpperCase() === wantedShift) value += 5;
      if (row.status === "Released") value += 2;
      if (row.status === "In Progress") value += 1;
      return value;
    };
    return score(right) - score(left);
  })[0];
}

function normalizeDowntimeEntry(entry = {}, parentLog = {}) {
  const startTime = entry.startTime || entry.start_time || null;
  const endTime = entry.endTime || entry.end_time || null;
  const duration =
    entry.durationMinutes ?? entry.duration_minutes ?? entry.duration;
  const downtimeDate = parentLog.logDate || new Date();
  const durationFromTime = calculateDurationMinutes(startTime, endTime, downtimeDate);
  const durationMinutes = toNumber(duration ?? durationFromTime ?? 0);
  const reason = entry.reason || entry.downtimeReason || entry.downtime_reason;

  if (!reason) {
    throw Object.assign(new Error("Reason downtime wajib diisi."), {
      statusCode: 400,
    });
  }
  return {
    moId: parentLog.moId,
    woId: parentLog.woId || null,
    productionLogId: parentLog.id,
    downtimeDate,
    shift: assertProductionShift(entry.shift || parentLog.shift || null),
    machineCode: entry.machineCode || entry.machine_code || parentLog.machineCode || null,
    operatorName: entry.operatorName || entry.operator_name || parentLog.operatorName || null,
    startTime: toDateTime(startTime, downtimeDate),
    endTime: toDateTime(endTime, downtimeDate),
    durationMinutes,
    reason,
    category: entry.category || null,
    hmiDowntimeId: Number.isInteger(Number(entry.hmiDowntimeId)) && Number(entry.hmiDowntimeId) > 0 ? Number(entry.hmiDowntimeId) : null,
    hmiDowntimeSubId: Number.isInteger(Number(entry.hmiDowntimeSubId)) && Number(entry.hmiDowntimeSubId) > 0 ? Number(entry.hmiDowntimeSubId) : null,
    notes: entry.notes || null,
    status: entry.status || "Open",
  };
}

exports.hmiReasons = async (req, res, next) => {
  try {
    const requestedAreaId = Number(req.query.areaId);
    const areaFilter = Number.isInteger(requestedAreaId) && requestedAreaId > 0
      ? ` WHERE area_id = ${requestedAreaId}`
      : "";
    const [rejections, rejectionSubs, downtimes, downtimeSubs] = await Promise.all([
      prisma.$queryRawUnsafe(`SELECT rejection_id AS id, rejection_desc AS description, area_id AS \"areaId\" FROM hmi_list_rejection${areaFilter} ORDER BY rejection_desc, rejection_id`),
      prisma.$queryRawUnsafe('SELECT rejection_sub_id AS id, rejection_sub_desc AS description, rejection_id AS "parentId" FROM hmi_list_rejection_sub ORDER BY rejection_sub_desc, rejection_sub_id'),
      prisma.$queryRawUnsafe(`SELECT downtime_id AS id, downtime_desc AS description, area_id AS \"areaId\" FROM hmi_list_downtime${areaFilter} ORDER BY downtime_desc, downtime_id`),
      prisma.$queryRawUnsafe('SELECT downtime_sub_id AS id, downtime_sub_desc AS description, downtime_id AS "parentId" FROM hmi_list_downtime_sub ORDER BY downtime_sub_desc, downtime_sub_id'),
    ]);
    const nest = (parents, children) => parents.map((parent) => ({
      ...parent,
      children: children.filter((child) => Number(child.parentId) === Number(parent.id)),
    }));
    res.json({
      source: "HMI_DATABASE",
      rejections: nest(rejections, rejectionSubs),
      downtimes: nest(downtimes, downtimeSubs),
    });
  } catch (error) {
    next(error);
  }
};

function summarizeDowntimeEntries(entries = [], parentLog = {}) {
  const normalizedEntries = entries.map((entry) => normalizeDowntimeEntry(entry, parentLog));
  return {
    normalizedEntries,
    downtime: normalizedEntries.reduce(
      (total, entry) => total + toNumber(entry.durationMinutes),
      0,
    ),
    downtimeReason: normalizedEntries
      .map((entry) => [entry.category, entry.reason].filter(Boolean).join(": "))
      .filter(Boolean)
      .join("; ") || null,
  };
}

function validateProductionLogQty(data = {}, formulas = null) {
  const qtyProduced = Number(data.qtyProduced || 0);
  const qtyGood = Number(data.qtyGood || 0);
  const qtyReject = Number(data.qtyReject || 0);
  const allocatedQty = formulas
    ? evaluateFromSet(formulas, "PRODUCTION_ALLOCATED_QTY", { qtyGood, qtyReject })
    : qtyGood + qtyReject;

  if (allocatedQty > qtyProduced) {
    throw Object.assign(
      new Error("Qty Good + Qty NG tidak boleh melebihi Qty Produced."),
      { statusCode: 400 },
    );
  }

  if (qtyProduced > 0 && Math.abs(allocatedQty - qtyProduced) > QUANTITY_TOLERANCE) {
    throw Object.assign(
      new Error("Qty Produced harus habis dialokasikan ke Qty Good + Qty NG."),
      { statusCode: 400 },
    );
  }
}

function normalizeApprovalQtyPayload(log = {}, body = {}) {
  const failedRows = Array.isArray(body.failedDestination)
    ? body.failedDestination
    : Array.isArray(body.rejectDestination)
      ? body.rejectDestination
      : [];
  const failedQtyFromRows = failedRows.reduce((sum, row) => sum + toNumber(row?.qty), 0);
  const qtyReject = body.qtyReject !== undefined
    ? toNumber(body.qtyReject)
    : failedQtyFromRows > 0
      ? failedQtyFromRows
      : toNumber(log.qtyReject);
  const consumeFromPassed = body.consumeFromPassed === true || body.consumeFromPassed === "true";

  if (consumeFromPassed) {
    const basePassedQty = body.basePassedQty !== undefined
      ? toNumber(body.basePassedQty)
      : toNumber(log.qtyGood);
    const remainingQtyGood = basePassedQty - qtyReject;

    if (remainingQtyGood < -QUANTITY_TOLERANCE) {
      throw Object.assign(
        new Error("Qty NG tidak boleh melebihi Qty Good."),
        { statusCode: 400 },
      );
    }

    const normalized = {
      qtyProduced: body.qtyProduced !== undefined ? toNumber(body.qtyProduced) : basePassedQty,
      qtyGood: Math.max(0, remainingQtyGood),
      qtyReject,
      qtyRework: toNumber(log.qtyRework),
    };
    validateProductionLogQty(normalized);
    return normalized;
  }

  const qtyGood = body.qtyGood !== undefined
    ? toNumber(body.qtyGood)
    : toNumber(log.qtyGood);
  const qtyRework = toNumber(log.qtyRework);
  const qtyProduced = body.qtyProduced !== undefined
    ? toNumber(body.qtyProduced)
    : qtyGood + qtyReject;

  const normalized = { qtyProduced, qtyGood, qtyReject, qtyRework };
  validateProductionLogQty(normalized);
  return normalized;
}

function getProductionLogQcHoldQty(log = {}) {
  return toNumber(log.qtyGood);
}

function mapProductionLogDoc(log) {
  const doc = mapDoc(log);
  const qcHoldQty = getProductionLogQcHoldQty(log);
  const qcInspectedQty = (log.qualityInspections || []).reduce(
    (sum, inspection) => sum + toNumber(inspection.qtyInspected),
    0,
  );

  return {
    ...doc,
    qcHoldQty,
    qcInspectedQty,
    qcRemainingQty: Math.max(0, qcHoldQty - qcInspectedQty),
  };
}

async function attachProductionOutputParts(logs) {
  const docs = Array.isArray(logs) ? logs : [logs].filter(Boolean);
  if (docs.length === 0) return logs;

  const operationPartCodes = [
    ...new Set(
      docs
        .filter((log) => !log.workOrder?.mbomDetail?.part)
        .map((log) => log.workOrder?.outputPartCode)
        .filter(Boolean),
    ),
  ];
  const parts = operationPartCodes.length
    ? await prisma.part.findMany({
        where: { partCode: { in: operationPartCodes }, isDeleted: false },
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
      })
    : [];
  const byCode = new Map(parts.map((part) => [part.partCode, part]));

  for (const log of docs) {
    const wo = log.workOrder || {};
    let isFinalOperation = true;
    if (wo.moId && wo.sequence !== null && wo.sequence !== undefined) {
      isFinalOperation = !docs.some((other) => (
        other.workOrder?.moId === wo.moId
        && other.workOrder?.sequence !== null
        && other.workOrder?.sequence !== undefined
        && other.workOrder.sequence > wo.sequence
      ));

      if (isFinalOperation) {
        const nextWorkOrder = await prisma.workOrder.findFirst({
          where: {
            moId: wo.moId,
            isDeleted: false,
            status: { not: "Cancelled" },
            sequence: { gt: wo.sequence },
          },
          select: { id: true },
        });
        isFinalOperation = !nextWorkOrder;
      }
    }

    const operationPartCode = wo.outputPartCode || null;
    const operationPart = wo.mbomDetail?.part || (operationPartCode ? byCode.get(operationPartCode) || null : null);
    const hasOperationOutputPart = Boolean(operationPart || operationPartCode);
    log.outputPart = operationPart || log.manufacturingOrder?.part || null;
    log.outputStockType = hasOperationOutputPart || !isFinalOperation ? "WIP" : "Finished Goods";
  }

  return logs;
}

function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}

function normalizeOptionalText(value) {
  return hasText(value) ? value.trim() : null;
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

function resolvePartStockIdentity(part = {}) {
  const partBase = getPreferredPartBase(part);
  return {
    spec: part.material?.spec || null,
    thickness: partBase.thickness ?? null,
    width: partBase.width ?? null,
    CSP: partBase.CSP || null,
  };
}

function normalizeLocationSnapshot(location = null) {
  if (!location?.warehouseCode) return null;
  return {
    warehouseCode: location.warehouseCode || null,
    rackCode: location.rackCode || null,
    lotNumber: location.lotNumber || null,
  };
}

function extractMovementPreferredLocation(movement = null) {
  if (!movement) return null;
  return normalizeLocationSnapshot({
    warehouseCode: movement.destinationWarehouseCode || movement.warehouseCode,
    rackCode: movement.destinationRackCode || movement.rackCode,
    lotNumber: movement.lotNumber || null,
  });
}

function scoreBalanceAgainstPreferredLocation(balance = {}, preferredLocation = null) {
  if (!preferredLocation?.warehouseCode) return 0;

  let score = 0;
  if (balance.warehouseCode === preferredLocation.warehouseCode) score += 100;
  if ((balance.rackCode || null) === (preferredLocation.rackCode || null)) score += 10;
  if ((balance.lotNumber || null) === (preferredLocation.lotNumber || null)) score += 1;
  return score;
}

async function findPreferredPreviousSourceLocation(
  tx,
  {
    previousWorkOrder = null,
    previousVendorProcess = null,
    sourcePartCode = null,
  } = {},
) {
  if (!sourcePartCode) return null;

  if (previousWorkOrder?.id) {
    const completedQc = await tx.qualityInspection.findMany({
      where: {
        woId: previousWorkOrder.id,
        isDeleted: false,
        status: "Completed",
        qtyPassed: { gt: 0 },
      },
      select: { inspectionNumber: true },
      orderBy: { updatedAt: "desc" },
      take: 10,
    });

    if (completedQc.length > 0) {
      const qualityReleaseMovement = await tx.stockMovement.findFirst({
        where: {
          referenceType: "QUALITY_INSPECTION",
          referenceNumber: { in: completedQc.map((row) => row.inspectionNumber) },
          transactionType: "QUALITY_RELEASE",
          partCode: sourcePartCode,
          isDeleted: false,
        },
        select: {
          warehouseCode: true,
          rackCode: true,
          lotNumber: true,
          destinationWarehouseCode: true,
          destinationRackCode: true,
        },
        orderBy: [{ movementDate: "desc" }, { createdAt: "desc" }],
      });
      const preferredFromQc = extractMovementPreferredLocation(qualityReleaseMovement);
      if (preferredFromQc) return preferredFromQc;
    }

    const recentLogs = await tx.productionLog.findMany({
      where: {
        woId: previousWorkOrder.id,
        isDeleted: false,
        status: "Approved",
      },
      select: { logNumber: true },
      orderBy: { updatedAt: "desc" },
      take: 10,
    });

    if (recentLogs.length > 0) {
      const qcHoldMovement = await tx.stockMovement.findFirst({
        where: {
          referenceType: "PRODUCTION_LOG",
          referenceNumber: { in: recentLogs.map((row) => row.logNumber) },
          transactionType: "QC_HOLD",
          partCode: sourcePartCode,
          isDeleted: false,
        },
        select: {
          warehouseCode: true,
          rackCode: true,
          lotNumber: true,
        },
        orderBy: [{ movementDate: "desc" }, { createdAt: "desc" }],
      });
      const preferredFromLog = extractMovementPreferredLocation(qcHoldMovement);
      if (preferredFromLog) return preferredFromLog;
    }
  }

  if (previousVendorProcess?.id) {
    const completedQc = await tx.qualityInspection.findMany({
      where: {
        vendorProcessOrderId: previousVendorProcess.id,
        isDeleted: false,
        status: "Completed",
        qtyPassed: { gt: 0 },
      },
      select: { inspectionNumber: true },
      orderBy: { updatedAt: "desc" },
      take: 10,
    });

    if (completedQc.length > 0) {
      const qualityReleaseMovement = await tx.stockMovement.findFirst({
        where: {
          referenceType: "QUALITY_INSPECTION",
          referenceNumber: { in: completedQc.map((row) => row.inspectionNumber) },
          transactionType: "QUALITY_RELEASE",
          partCode: sourcePartCode,
          isDeleted: false,
        },
        select: {
          warehouseCode: true,
          rackCode: true,
          lotNumber: true,
          destinationWarehouseCode: true,
          destinationRackCode: true,
        },
        orderBy: [{ movementDate: "desc" }, { createdAt: "desc" }],
      });
      const preferredFromQc = extractMovementPreferredLocation(qualityReleaseMovement);
      if (preferredFromQc) return preferredFromQc;
    }

    const vendorQcHoldMovement = await tx.stockMovement.findFirst({
      where: {
        referenceType: "VENDOR_PROCESS_ORDER",
        referenceNumber: previousVendorProcess.orderNumber,
        transactionType: "QC_HOLD",
        partCode: sourcePartCode,
        isDeleted: false,
      },
      select: {
        warehouseCode: true,
        rackCode: true,
        lotNumber: true,
      },
      orderBy: [{ movementDate: "desc" }, { createdAt: "desc" }],
    });
    return extractMovementPreferredLocation(vendorQcHoldMovement);
  }

  return null;
}

async function resolveProductionOutputContext(tx, log) {
  const mo = log.manufacturingOrder;
  const workOrder = log.workOrder;
  const parentPart = mo?.part || null;
  let outputPart = parentPart;
  let stockType = "Finished Goods";
  let isFinalOperation = true;

  if (workOrder?.moId && workOrder.sequence !== null && workOrder.sequence !== undefined) {
    const nextWorkOrder = await tx.workOrder.findFirst({
      where: {
        moId: workOrder.moId,
        isDeleted: false,
        status: { not: "Cancelled" },
        sequence: { gt: workOrder.sequence },
      },
      orderBy: { sequence: "asc" },
      select: { id: true },
    });
    isFinalOperation = !nextWorkOrder;
  }

  const operationPartCode = workOrder?.outputPartCode || null;
  let hasOperationOutputPart = false;
  if (workOrder?.mbomDetail?.part) {
    outputPart = workOrder.mbomDetail.part;
    hasOperationOutputPart = true;
  } else if (operationPartCode) {
    const operationPart = await tx.part.findFirst({
      where: { partCode: operationPartCode, isDeleted: false },
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
    });
    outputPart = operationPart || parentPart;
    hasOperationOutputPart = Boolean(operationPart);
  }

  if (outputPart && (hasOperationOutputPart || operationPartCode || !isFinalOperation)) {
    stockType = "WIP";
  }

  return { outputPart, stockType, isFinalOperation };
}

async function resolveWorkOrderOutputPart(tx, workOrder, fallbackPart = null) {
  if (workOrder?.mbomDetail?.part) return workOrder.mbomDetail.part;

  const operationPartCode = workOrder?.outputPartCode || null;
  if (!operationPartCode) return fallbackPart;

  return tx.part.findFirst({
    where: { partCode: operationPartCode, isDeleted: false },
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
  });
}

async function consumePreviousWipForProductionLog(
  tx,
  log,
  qty,
  performedBy = "system",
) {
  if (qty <= 0) return null;
  if (!log.id) return null;

  const existingConsumption = await tx.wIPEntry.findFirst({
    where: {
      sourceType: "ProductionInput",
      sourceId: log.id,
      isDeleted: false,
    },
    select: { id: true },
  });
  if (existingConsumption) {
    const existingMovement = await tx.stockMovement.findFirst({
      where: {
        referenceType: "PRODUCTION_LOG",
        referenceNumber: log.logNumber,
        movementType: "OUT",
        transactionType: "PRODUCTION",
        isDeleted: false,
      },
      select: { movementNumber: true },
    });
    if (existingMovement) return [];
  }

  const currentWorkOrder = log.workOrder;
  if (
    !currentWorkOrder?.moId
    || currentWorkOrder.sequence === null
    || currentWorkOrder.sequence === undefined
  ) {
    return null;
  }

  const [previousWorkOrder, previousVendorProcess] = await Promise.all([
    tx.workOrder.findFirst({
      where: {
        moId: currentWorkOrder.moId,
        isDeleted: false,
        status: { not: "Cancelled" },
        sequence: { lt: currentWorkOrder.sequence },
      },
      orderBy: { sequence: "desc" },
      select: {
        id: true,
        woNumber: true,
        notes: true,
        uomCode: true,
        sequence: true,
        outputPartId: true,
        outputPartCode: true,
        outputPartNumber: true,
        outputPartName: true,
        mbomDetail: {
          select: {
            levelComponent: true,
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
      },
    }),
    tx.vendorProcessOrder.findFirst({
      where: {
        moId: currentWorkOrder.moId,
        isDeleted: false,
        status: { notIn: ["Cancelled", "Closed"] },
        sequence: { lt: currentWorkOrder.sequence },
      },
      orderBy: { sequence: "desc" },
      select: {
        id: true,
        orderNumber: true,
        outputPartCode: true,
        outputPartNumber: true,
        outputPartName: true,
        spec: true,
        thickness: true,
        width: true,
        CSP: true,
        uomCode: true,
        sequence: true,
      },
    }),
  ]);

  const useVendorSource = Number(previousVendorProcess?.sequence || -1) > Number(previousWorkOrder?.sequence || -1);
  const previousSource = useVendorSource ? previousVendorProcess : previousWorkOrder;
  if (!previousSource) return null;

  let sourcePart = null;
  if (useVendorSource) {
    sourcePart = previousVendorProcess?.outputPartCode
      ? {
          partCode: previousVendorProcess.outputPartCode,
          partNumber: previousVendorProcess.outputPartNumber || null,
          partName: previousVendorProcess.outputPartName || null,
          material: { spec: previousVendorProcess.spec || null },
          partBases: [
            {
              baseOn: "ACTUAL",
              thickness: previousVendorProcess.thickness ?? null,
              width: previousVendorProcess.width ?? null,
              CSP: previousVendorProcess.CSP || null,
            },
          ],
        }
      : null;
  } else {
    sourcePart = await resolveWorkOrderOutputPart(
      tx,
      previousWorkOrder,
      null,
    );
  }
  if (!sourcePart?.partCode) {
    throw Object.assign(
      new Error(
        `Part WIP sumber dari proses sebelumnya ${useVendorSource ? previousVendorProcess.orderNumber : previousWorkOrder.woNumber} tidak ditemukan.`,
      ),
      { statusCode: 400 },
    );
  }

  const sourceIdentity = resolvePartStockIdentity(sourcePart);
  const sourceUomCode = previousSource.uomCode || currentWorkOrder.uomCode || log.manufacturingOrder?.uomCode || null;
  const preferredSourceLocation = await findPreferredPreviousSourceLocation(tx, {
    previousWorkOrder,
    previousVendorProcess,
    sourcePartCode: sourcePart.partCode,
  });
  let balances = await tx.stockBalance.findMany({
    where: {
      AND: [
        {
          partCode: sourcePart.partCode,
          uomCode: sourceUomCode,
          stockType: "WIP",
          isDeleted: false,
          qtyAvailable: { gt: 0 },
        },
        buildExcludeSpecialRackCondition(),
      ],
    },
    orderBy: [{ qtyAvailable: "asc" }, { lastMovement: "asc" }],
    select: {
      id: true,
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
      qtyOnHand: true,
      qtyReserved: true,
      qtyQC: true,
      qtyAvailable: true,
      uomCode: true,
    },
  });
  if (balances.length) {
    const balanceIds = balances.map((row) => row.id).sort();
    await tx.$queryRaw`SELECT id FROM "tbl_stock_balance" WHERE id IN (${Prisma.join(balanceIds)}) ORDER BY id FOR UPDATE`;
    const lockedBalances = await tx.stockBalance.findMany({
      where: { id: { in: balanceIds }, isDeleted: false, qtyAvailable: { gt: 0 } },
      select: {
        id: true, warehouseCode: true, rackCode: true, lotNumber: true,
        partCode: true, partNumber: true, partName: true, productId: true,
        description: true, spec: true, thickness: true, width: true, CSP: true,
        stockType: true, qtyOnHand: true, qtyReserved: true, qtyQC: true,
        qtyAvailable: true, uomCode: true,
      },
    });
    const lockedById = new Map(lockedBalances.map((row) => [row.id, row]));
    balances = balances.map((row) => lockedById.get(row.id)).filter(Boolean);
  }
  balances.sort((left, right) => {
    const scoreDiff =
      scoreBalanceAgainstPreferredLocation(right, preferredSourceLocation)
      - scoreBalanceAgainstPreferredLocation(left, preferredSourceLocation);
    if (scoreDiff !== 0) return scoreDiff;
    return 0;
  });

  const requiredQty = toNumber(qty);
  const availableQty = balances.reduce(
    (sum, balance) => sum + toNumber(balance.qtyAvailable),
    0,
  );
  if (availableQty + 0.000001 < requiredQty) {
    throw Object.assign(
      new Error(
        `Stock WIP ${sourcePart.partCode} dari proses sebelumnya tidak cukup. Tersedia ${availableQty}, dibutuhkan ${requiredQty}.`,
      ),
      { statusCode: 400 },
    );
  }

  let remaining = requiredQty;
  const now = new Date();
  const movementNumbers = [];
  let consumedLocation = null;
  for (const balance of balances) {
    if (remaining <= 0.000001) break;

    const qtyOut = Math.min(toNumber(balance.qtyAvailable), remaining);
    if (qtyOut <= 0) continue;
    consumedLocation ||= balance;

    await assertStockBalanceNotFrozen(tx, balance.id);
    const qtyBefore = toNumber(balance.qtyOnHand);
    const qtyAfter = Math.max(0, qtyBefore - qtyOut);
    const qtyReserved = toNumber(balance.qtyReserved);
    const qtyQC = toNumber(balance.qtyQC);
    const movementNumber = await generateMovementNumber("OUT", tx);

    await tx.stockMovement.create({
      data: {
        movementNumber,
        movementDate: now,
        movementType: "OUT",
        direction: "OUT",
        transactionType: "PRODUCTION",
        warehouseCode: balance.warehouseCode,
        rackCode: balance.rackCode || null,
        lotNumber: balance.lotNumber || null,
        partCode: balance.partCode,
        partNumber: balance.partNumber || sourcePart.partNumber || null,
        partName: balance.partName || sourcePart.partName || null,
        productId: balance.productId || null,
        description: balance.description || null,
        spec: balance.spec || sourceIdentity.spec || null,
        thickness: balance.thickness ?? sourceIdentity.thickness ?? null,
        width: balance.width ?? sourceIdentity.width ?? null,
        CSP: balance.CSP || sourceIdentity.CSP || null,
        stockType: "WIP",
        qty: qtyOut,
        deltaQty: -qtyOut,
        qtyBefore,
        qtyAfter,
        uomCode:
          previousSource.uomCode ||
          currentWorkOrder.uomCode ||
          log.manufacturingOrder?.uomCode ||
          null,
        referenceType: "PRODUCTION_LOG",
        referenceNumber: log.logNumber,
        notes: `Consume WIP ${sourcePart.partCode} dari ${useVendorSource ? previousVendorProcess.orderNumber : previousWorkOrder.woNumber} untuk ${
          currentWorkOrder.woNumber || log.logNumber
        }`,
        performedBy,
      },
    });

    await tx.stockBalance.update({
      where: { id: balance.id },
      data: {
        qtyOnHand: qtyAfter,
        qtyAvailable: Math.max(0, qtyAfter - qtyReserved - qtyQC),
        lastMovement: now,
      },
    });

    movementNumbers.push(movementNumber);
    remaining -= qtyOut;
  }

  await createWIPEntry(tx, {
    entryDate: now,
    moId: currentWorkOrder.moId,
    woId: currentWorkOrder.id || null,
    costType: "Material",
    sourceType: "ProductionInput",
    sourceId: log.id,
    sourceRef: log.logNumber,
    partCode: sourcePart.partCode || null,
    partNumber: sourcePart.partNumber || null,
    partName: sourcePart.partName || null,
    uomCode: previousSource.uomCode || currentWorkOrder.uomCode || log.manufacturingOrder?.uomCode || null,
    warehouseCode: consumedLocation?.warehouseCode || null,
    rackCode: consumedLocation?.rackCode || null,
    lotNumber: consumedLocation?.lotNumber || null,
    stockType: "WIP",
    qty: requiredQty,
    rate: 0,
    amount: 0,
    direction: "OUT",
    notes: `Consume WIP ${sourcePart.partCode} dari ${useVendorSource ? previousVendorProcess.orderNumber : previousWorkOrder.woNumber} untuk ${
      currentWorkOrder.woNumber || log.logNumber
    }`,
    createdBy: performedBy,
  });

  return movementNumbers;
}

function normalizeProductionLogAliases(data = {}) {
  const normalized = { ...data };

  if (
    normalized.runningMinutes === undefined &&
    normalized.runningMunites !== undefined
  ) {
    normalized.runningMinutes = normalized.runningMunites;
  }

  if (normalized.hmiTopic === undefined && normalized.hmi_topic !== undefined) {
    normalized.hmiTopic = normalized.hmi_topic;
  }
  if (normalized.dpsId === undefined) {
    normalized.dpsId =
      normalized.dailyProductionScheduleId ||
      normalized.daily_production_schedule_id ||
      null;
  }
  if (normalized.scheduleNumber === undefined) {
    normalized.scheduleNumber = normalized.schedule_number || null;
  }

  if (normalized.runningMinutes !== undefined) {
    normalized.runningMinutes = toNumber(normalized.runningMinutes);
  }
  if (normalized.hmiTopic !== undefined) {
    normalized.hmiTopic = hasText(normalized.hmiTopic)
      ? normalized.hmiTopic.trim()
      : null;
  }

  delete normalized.runningMunites;
  delete normalized.hmi_topic;
  delete normalized.dailyProductionScheduleId;
  delete normalized.daily_production_schedule_id;
  delete normalized.schedule_number;

  return normalized;
}

async function normalizeProductionLogInput(tx, data = {}, options = {}) {
  const formulas = await getFormulaSet(tx, "production");
  const input = normalizeProductionLogAliases(data);
  let schedule = await findDailyProductionSchedule(tx, {
    dpsId: input.dpsId,
    scheduleNumber: input.scheduleNumber,
  });

  if (!schedule) {
    throw Object.assign(
      new Error("Daily Production Plan wajib dipilih. Production Log tidak boleh dibuat langsung dari MO/WO."),
      { statusCode: 409, code: "PRODUCTION_PLAN_REQUIRED" },
    );
  }
  const scheduleWorkOrder = schedule.woId
    ? await tx.workOrder.findFirst({
        where: { id: schedule.woId, isDeleted: false },
        select: { isReworkOrder: true },
      })
    : null;
  const isReworkSchedule = scheduleWorkOrder?.isReworkOrder === true;
  if (!isReworkSchedule && (!schedule.productionPlanId || !schedule.productionPlanAllocationId || !schedule.mbomProcessId)) {
    throw Object.assign(
      new Error("Daily Production Plan belum memiliki trace MPP, allocation, dan routing yang lengkap. Publikasikan ulang dari Capacity Planning."),
      { statusCode: 409, code: "DAILY_PLAN_TRACE_INCOMPLETE" },
    );
  }
  if (!schedule.moId || !schedule.woId) {
    throw Object.assign(
      new Error("Daily Production Plan proses in-house wajib memiliki MO dan WO reference."),
      { statusCode: 409, code: "DAILY_PLAN_EXECUTION_REFERENCE_INCOMPLETE" },
    );
  }
  if (schedule.productionPlan?.status === "Cancelled") {
    throw Object.assign(
      new Error(`Production Plan ${schedule.productionPlan.planNumber} sudah Cancelled.`),
      { statusCode: 409, code: "PRODUCTION_PLAN_CANCELLED" },
    );
  }

  if (schedule) {
    input.dpsId = schedule.id;
    input.woId = schedule.woId;
    input.woNumber = schedule.woNumber || null;
    input.moId = schedule.moId;
    input.moNumber = schedule.moNumber || null;
    input.shift = schedule.shift;
    input.operatorName = input.operatorName || schedule.operatorName || null;
    input.qtyPlanned = Math.max(toNumber(schedule.plannedQty) - toNumber(schedule.actualQty), 0);
    input.logDate = input.logDate || schedule.scheduleDate || null;
    await tx.workOrder.updateMany({
      where: { id: schedule.woId, isDeleted: false, status: { notIn: ["Completed", "Cancelled"] } },
      data: {
        machineId: schedule.machineId || undefined,
        diesId: schedule.diesId || undefined,
        shift: schedule.shift || undefined,
        operatorName: schedule.operatorName || input.operatorName || undefined,
      },
    });
  }

  const normalized = await resolveProductionRefs(tx, input, {
    copyPlannedQty: true,
    defaultShiftFromWorkOrder: true,
    requireWorkOrderInProgress: true,
    autoStartAfterMaterialIssue: true,
  });
  normalized.dpsId = schedule.id;
  normalized.qtyPlanned = Math.max(toNumber(schedule.plannedQty) - toNumber(schedule.actualQty), 0);
  const plannedDay = new Date(schedule.scheduleDate).toISOString().slice(0, 10);
  const actualDay = new Date(normalized.logDate || schedule.scheduleDate).toISOString().slice(0, 10);
  if (actualDay < plannedDay) {
    throw Object.assign(
      new Error(`Tanggal aktual ${actualDay} tidak boleh sebelum Daily Production Plan ${plannedDay}.`),
      { statusCode: 409, code: "PRODUCTION_BEFORE_PLAN_DATE" },
    );
  }

  if (
    normalized.qtyProduced === undefined ||
    normalized.qtyProduced === null ||
    normalized.qtyProduced === ""
  ) {
    normalized.qtyProduced =
      normalized.qtyGood !== undefined && normalized.qtyGood !== null && normalized.qtyGood !== ""
        ? toNumber(normalized.qtyGood)
        : toNumber(normalized.qtyPlanned);
  }
  if (
    [normalized.qtyGood, normalized.qtyReject].every(
      (value) => value === undefined || value === null || value === "",
    )
  ) {
    normalized.qtyGood = toNumber(normalized.qtyProduced);
    normalized.qtyReject = 0;
  }
  normalized.qtyRework = 0;

  if (options.defaultStatus) normalized.status = options.defaultStatus;
  delete normalized.logNumber;
  delete normalized.scheduleNumber;

  if (!normalized.moId) {
    throw Object.assign(new Error("MO Number wajib diisi."), {
      statusCode: 400,
    });
  }
  if (!normalized.shift) {
    throw Object.assign(new Error("Shift wajib diisi."), { statusCode: 400 });
  }
  normalized.shift = assertProductionShift(normalized.shift, { required: true });
  if (!normalized.operatorName) {
    throw Object.assign(new Error("Operator wajib diisi."), {
      statusCode: 400,
    });
  }
  normalized.qualityCheckMode = String(normalized.qualityCheckMode || "SEPARATE_QC").trim().toUpperCase();
  if (!new Set(["SEPARATE_QC", "OPERATOR_SELF_CHECK"]).has(normalized.qualityCheckMode)) {
    throw Object.assign(new Error("Mode pemeriksaan hasil produksi tidak valid."), { statusCode: 400 });
  }
  normalized.selfCheckNotes = hasText(normalized.selfCheckNotes)
    ? normalized.selfCheckNotes.trim()
    : null;
  if (normalized.qualityCheckMode === "OPERATOR_SELF_CHECK" && !normalized.selfCheckNotes) {
    throw Object.assign(
      new Error("Catatan self-check operator wajib diisi agar skip QC memiliki audit trail."),
      { statusCode: 400 },
    );
  }
  // These audit fields are authoritative and may only be stamped by approval.
  delete normalized.selfCheckedBy;
  delete normalized.selfCheckedAt;

  for (const field of ["qtyPlanned", "qtyProduced", "qtyGood", "qtyReject"]) {
    if (normalized[field] !== undefined && normalized[field] !== null && normalized[field] !== "") {
      assertQuantity(normalized[field], normalized.uomCode, field);
    }
  }
  validateProductionLogQty(normalized, formulas);
  return normalized;
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

async function getProductionLogDeleteBlockers(tx, log) {
  const qualityInspectionCount = await tx.qualityInspection.count({
    where: {
      productionLogId: log.id,
      isDeleted: false,
    },
  });

  return [
    qualityInspectionCount > 0 && `${qualityInspectionCount} QC`,
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

async function findStockBalanceForMovement(tx, movement) {
  if (!movement?.warehouseCode || !movement?.partCode) return null;
  const where = {
    warehouseCode: movement.warehouseCode,
    rackCode: movement.rackCode || null,
    lotNumber: movement.lotNumber || null,
    partCode: movement.partCode,
    ...buildBalanceIdentityFromMovement(movement),
    uomCode: movement.uomCode || null,
    stockType: movement.stockType || null,
    isDeleted: false,
  };
  await lockStockBalanceIdentity(tx, where);
  return tx.stockBalance.findFirst({
    where,
    select: { id: true, qtyOnHand: true, qtyReserved: true, qtyQC: true },
  });
}

async function applyStockBalanceDelta(
  tx,
  balance,
  { qtyOnHandDelta = 0, qtyQcDelta = 0, qtyReservedDelta = 0 },
) {
  if (!balance || (qtyOnHandDelta === 0 && qtyQcDelta === 0 && qtyReservedDelta === 0)) return null;
  await assertStockBalanceNotFrozen(tx, balance.id);
  const qtyOnHand = Math.max(0, toNumber(balance.qtyOnHand) + qtyOnHandDelta);
  const qtyQC = Math.max(0, toNumber(balance.qtyQC) + qtyQcDelta);
  const qtyReserved = Math.max(0, toNumber(balance.qtyReserved) + qtyReservedDelta);
  return tx.stockBalance.update({
    where: { id: balance.id },
    data: {
      qtyOnHand,
      qtyReserved,
      qtyQC,
      qtyAvailable: Math.max(0, qtyOnHand - qtyReserved - qtyQC),
      lastMovement: new Date(),
    },
  });
}

async function restoreSubAssemblyReservation(tx, log, movement, qty) {
  if (!log?.moId || !movement?.partCode || qty <= QUANTITY_TOLERANCE) return;
  const mo = await tx.manufacturingOrder.findUnique({
    where: { id: log.moId },
    select: { moNumber: true },
  });
  if (!mo?.moNumber) return;

  const reservations = await tx.stockReservation.findMany({
    where: {
      referenceType: "MANUFACTURING_ORDER",
      referenceNumber: { startsWith: `${mo.moNumber}#` },
      partCode: movement.partCode,
      warehouseCode: movement.warehouseCode,
      rackCode: movement.rackCode || null,
      lotNumber: movement.lotNumber || null,
      qtyReleased: { gt: 0 },
      isDeleted: false,
      status: { in: ["Active", "Released"] },
    },
    orderBy: { updatedAt: "desc" },
  });

  let remaining = qty;
  for (const reservation of reservations) {
    if (remaining <= QUANTITY_TOLERANCE) break;
    const restoreQty = Math.min(toNumber(reservation.qtyReleased), remaining);
    if (restoreQty <= QUANTITY_TOLERANCE) continue;
    await tx.stockReservation.update({
      where: { id: reservation.id },
      data: {
        qtyReleased: Math.max(0, toNumber(reservation.qtyReleased) - restoreQty),
        status: "Active",
        notes: `Sub-assembly reservation restored karena ${log.logNumber} dihapus`,
      },
    });
    remaining -= restoreQty;
  }

  if (remaining > QUANTITY_TOLERANCE) {
    throw Object.assign(
      new Error(`Reservation sub-assembly ${movement.partCode} tidak bisa dipulihkan penuh.`),
      { statusCode: 409 },
    );
  }
}

async function rollbackProductionLogAutomation(tx, log) {
  await rollbackProductionShortfallCarryover(tx, log.id);
  const movements = await tx.stockMovement.findMany({
    where: {
      referenceType: "PRODUCTION_LOG",
      referenceNumber: log.logNumber,
      isDeleted: false,
    },
    orderBy: [{ createdAt: "desc" }],
  });

  for (const movement of movements) {
    const balance = await findStockBalanceForMovement(tx, movement);
    if (movement.transactionType === "QC_HOLD" && movement.movementType === "IN") {
      await applyStockBalanceDelta(tx, balance, {
        qtyOnHandDelta: -toNumber(movement.qty),
        qtyQcDelta: -toNumber(movement.qty),
      });
    } else if (movement.transactionType === "PRODUCTION" && movement.movementType === "OUT") {
      const isSubAssemblyConsumption = movement.qualityBucket === "SUB_ASSEMBLY";
      await applyStockBalanceDelta(tx, balance, {
        qtyOnHandDelta: toNumber(movement.qty),
        qtyReservedDelta: isSubAssemblyConsumption ? toNumber(movement.qty) : 0,
      });
      if (isSubAssemblyConsumption) {
        await restoreSubAssemblyReservation(tx, log, movement, toNumber(movement.qty));
      }
    }
  }

  await tx.stockMovement.updateMany({
    where: {
      referenceType: "PRODUCTION_LOG",
      referenceNumber: log.logNumber,
      isDeleted: false,
    },
    data: { isDeleted: true },
  });

  await tx.wIPEntry.updateMany({
    where: {
      OR: [
        { sourceId: log.id },
        { sourceRef: log.logNumber },
      ],
      isDeleted: false,
    },
    data: { isDeleted: true },
  });

  await tx.downtimeLog.updateMany({
    where: { productionLogId: log.id, isDeleted: false },
    data: { isDeleted: true },
  });

  await tx.workOrder.updateMany({
    where: {
      isDeleted: false,
      isReworkOrder: true,
      reworkReferenceType: "PRODUCTION_LOG",
      reworkReferenceNumber: log.logNumber,
    },
    data: { isDeleted: true, status: "Cancelled" },
  });
}

async function resyncWorkOrderAfterProductionLogDelete(tx, woId) {
  if (!woId) return null;

  const wo = await tx.workOrder.findFirst({
    where: { id: woId, isDeleted: false },
    select: {
      id: true,
      moId: true,
      woNumber: true,
      plannedQty: true,
      machineCostingRate: true,
      machineRateType: true,
    },
  });
  if (!wo) return null;

  const [approvedLogs, completedInspections, activeMaterialIssueCount] = await Promise.all([
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
    tx.qualityInspection.findMany({
      where: { woId, isDeleted: false, status: "Completed" },
      select: { qtyInspected: true, qtyPassed: true, qtyFailed: true, qtyRework: true },
    }),
    tx.materialIssue.count({
      where: {
        woId,
        isDeleted: false,
        status: { in: ["Issued", "Partially Returned", "Closed"] },
      },
    }),
  ]);

  const totalQtyProduced = approvedLogs.reduce((sum, log) => sum + toNumber(log.qtyProduced), 0);
  const totalQtyGood = approvedLogs.reduce((sum, log) => sum + toNumber(log.qtyGood), 0);
  const totalProductionReject = approvedLogs.reduce((sum, log) => sum + toNumber(log.qtyReject), 0);
  const totalRunningMinutes = approvedLogs.reduce((sum, log) => sum + getLogDurationMinutes(log), 0);
  const totalQcInspected = completedInspections.reduce((sum, qc) => sum + toNumber(qc.qtyInspected), 0);
  const totalQcGood = completedInspections.reduce((sum, qc) => sum + toNumber(qc.qtyPassed), 0);
  const totalQcReject = completedInspections.reduce((sum, qc) => sum + toNumber(qc.qtyFailed), 0);
  const firstStartTime = approvedLogs.find((log) => log.startTime)?.startTime || null;
  const lastEndTime = [...approvedLogs].reverse().find((log) => log.endTime)?.endTime || null;
  const actualProcessCost =
    totalRunningMinutes * 60 * toMachineRatePerSecond(wo.machineCostingRate, wo.machineRateType);

  let status = "In Production";
  if (totalQtyProduced <= QUANTITY_TOLERANCE) {
    status = activeMaterialIssueCount > 0 ? "Material Issued" : "Released";
  } else if (totalQtyProduced + QUANTITY_TOLERANCE < toNumber(wo.plannedQty)) {
    status = "In Production";
  } else if (totalQtyGood > totalQcInspected + QUANTITY_TOLERANCE) {
    status = "QC Pending";
  } else {
    status = "Completed";
  }

  const updated = await tx.workOrder.update({
    where: { id: wo.id },
    data: {
      qtyProduced: totalQtyProduced,
      qtyGood: totalQcGood,
      qtyReject: totalProductionReject + totalQcReject,
      runningMinutes: totalRunningMinutes || null,
      actualProcessCost,
      startTime: firstStartTime,
      endTime: lastEndTime,
      status,
    },
  });

  return {
    woNumber: updated.woNumber,
    status: updated.status,
    manufacturingOrder: await syncManufacturingOrderQtyFromWorkOrders(tx, updated.moId),
  };
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

async function autoCompleteWorkOrderIfReady(tx, woId, performedBy = "system") {
  if (!woId) return null;

  const wo = await tx.workOrder.findUnique({
    where: { id: woId },
    include: {
      machine: { select: { machineCode: true } },
      manufacturingOrder: { select: { partId: true } },
    },
  });
  if (!wo || !isWorkOrderProductionStatus(wo.status)) return null;

  const approvedLogs = await tx.productionLog.findMany({
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
    orderBy: [{ endTime: "desc" }, { logDate: "desc" }],
  });

  const totalQtyProduced = approvedLogs.reduce((sum, log) => sum + toNumber(log.qtyProduced), 0);
  const totalQtyGood = approvedLogs.reduce((sum, log) => sum + toNumber(log.qtyGood), 0);
  const totalQtyReject = approvedLogs.reduce((sum, log) => sum + toNumber(log.qtyReject), 0);
  const totalRunningMinutes = approvedLogs.reduce((sum, log) => sum + getLogDurationMinutes(log), 0);
  const actualProcessCost =
    totalRunningMinutes * 60 * toMachineRatePerSecond(wo.machineCostingRate, wo.machineRateType);
  const plannedQty = toNumber(wo.plannedQty);

  if (plannedQty <= 0 || totalQtyProduced < plannedQty) return null;

  const endTime = approvedLogs[0]?.endTime || approvedLogs[0]?.logDate || new Date();
  const completed = await tx.workOrder.update({
    where: { id: wo.id },
    data: {
      status: "Completed",
      endTime,
      qtyProduced: totalQtyProduced,
      qtyGood: totalQtyGood,
      qtyReject: totalQtyReject,
      runningMinutes: totalRunningMinutes || null,
      actualProcessCost,
    },
    include: {
      machine: { select: { machineCode: true } },
      manufacturingOrder: { select: { partId: true } },
    },
  });

  if (completed.diesId && !completed.diesUsageId) {
    await autoCreateDiesUsage(tx, completed);
  }

  if (totalQtyProduced > 0) {
    await createWIPEntry(tx, {
      entryDate: new Date(),
      moId: completed.moId,
      woId: completed.id,
      costType: "Labor",
      sourceType: "WorkOrder",
      sourceId: completed.id,
      sourceRef: completed.woNumber,
      partCode: completed.outputPartCode || null,
      partNumber: completed.outputPartNumber || null,
      partName: completed.outputPartName || null,
      uomCode: completed.uomCode || null,
      stockType: "WIP",
      qty: totalQtyProduced,
      rate: 0,
      amount: 0,
      direction: "IN",
      notes: `WO ${completed.woNumber} auto completed from approved logs (qty: ${totalQtyProduced})`,
      createdBy: performedBy,
    });
  }

  const closedMaterialIssues = await closeMaterialIssuesIfReady(tx, completed.moId);

  return {
    woNumber: completed.woNumber,
    status: completed.status,
    closedMaterialIssues,
  };
}

async function receiveProductionLogOutputToQc(tx, log, stockTarget, performedBy = "system") {
  const warehouseCode = normalizeOptionalText(stockTarget?.warehouseCode);
  const rackCode = normalizeOptionalText(stockTarget?.rackCode);
  const qtyGood = toNumber(log.qtyGood);
  const qtyQcHold = qtyGood;
  const qtyProduced = toNumber(log.qtyProduced);
  const mo = log.manufacturingOrder;
  // DPP execution already consumes its exact direct BOM inputs through the
  // Material Issue created by Daily Plan consume. The legacy sequence-based
  // fallback is only valid for old logs without DPP lineage; running it again
  // would double-consume WIP and can choose the wrong parallel predecessor.
  const consumedWipMovementNumbers = log.dpsId
    ? []
    : await consumePreviousWipForProductionLog(
        tx,
        log,
        qtyProduced,
        performedBy,
      );
  const { outputPart: part, stockType } = await resolveProductionOutputContext(tx, log);

  if (qtyQcHold <= 0) {
    return consumedWipMovementNumbers
      ? { movementNumber: null, consumedWipMovementNumbers }
      : null;
  }
  if (!warehouseCode) {
    throw Object.assign(new Error("Warehouse wajib diisi saat approve Production Log."), {
      statusCode: 400,
    });
  }
  if (!part?.partCode) {
    throw Object.assign(new Error("Part Code Production Log tidak ditemukan."), {
      statusCode: 400,
    });
  }

  // A production output must never enter QC/inventory without traceable lot
  // identity. Draft coil phases historically use `${logNumber}-PROD` only as a
  // UI placeholder; replace it with the configured WIP/FG numbering rule when
  // the log becomes authoritative (Approved). An explicitly supplied lot is
  // still respected for compatibility with manual production flows.
  let lotNumber = normalizeOptionalText(stockTarget?.lotNumber);
  if (!lotNumber) {
    const priorOutput = await tx.stockMovement.findFirst({
      where: {
        referenceType: "PRODUCTION_LOG",
        referenceNumber: log.logNumber,
        transactionType: "QC_HOLD",
        qualityBucket: "GOOD",
        isDeleted: false,
        lotNumber: { not: null },
      },
      orderBy: { createdAt: "asc" },
      select: { lotNumber: true },
    });
    lotNumber = normalizeOptionalText(priorOutput?.lotNumber);
  }
  if (!lotNumber) {
    const phases = await tx.productionLogCoilPhase.findMany({
      where: { productionLogId: log.id, isDeleted: false },
      orderBy: [{ phaseNumber: "asc" }, { createdAt: "asc" }],
      select: { productionLotNumber: true },
    });
    const draftPlaceholder = `${log.logNumber}-PROD`;
    lotNumber = normalizeOptionalText(
      phases.find((phase) => {
        const candidate = normalizeOptionalText(phase.productionLotNumber);
        return candidate && candidate !== draftPlaceholder;
      })?.productionLotNumber,
    );
  }
  if (!lotNumber) {
    const ruleKey = stockType === "Finished Goods" ? "LOT_PRODUCTION" : "LOT_WIP";
    const prefix = ruleKey === "LOT_PRODUCTION" ? "FGLOT" : "WIPLOT";
    // Lot date follows the actual posting/approval time, not a possibly future
    // planned DPP/log date. This also keeps DAILY numbering buckets monotonic.
    const productionDate = new Date();
    await ensureDefaultNumberingRule(ruleKey, tx);
    lotNumber = await generateConfiguredNumber(ruleKey, {
      db: tx,
      date: productionDate,
      context: { code: part.partCode || "" },
      fallback: () => `${prefix}-${productionDate.toISOString().slice(0, 10).replace(/-/g, "")}-${log.logNumber}`,
    });
  }
  if (!lotNumber) {
    throw Object.assign(new Error("Lot hasil produksi gagal dibuat. Periksa Numbering Rule LOT_WIP/LOT_PRODUCTION."), {
      statusCode: 409,
    });
  }

  await tx.productionLogCoilPhase.updateMany({
    where: { productionLogId: log.id, isDeleted: false },
    data: { productionLotNumber: lotNumber },
  });

  const now = new Date();
  const stockIdentity = resolvePartStockIdentity(part);
  const balanceWhere = {
    warehouseCode,
    rackCode,
    lotNumber,
    partCode: part.partCode,
    partNumber: part.partNumber || null,
    partName: part.partName || null,
    productId: null,
    description: null,
    ...stockIdentity,
    uomCode: mo?.uomCode || log.workOrder?.uomCode || null,
    stockType,
    isDeleted: false,
  };

  await lockStockBalanceIdentity(tx, balanceWhere);

  const existingBalance = await tx.stockBalance.findFirst({
    where: balanceWhere,
    select: { id: true, qtyOnHand: true, qtyReserved: true, qtyQC: true },
  });

  const qtyBefore = toNumber(existingBalance?.qtyOnHand);
  const qtyAfter = qtyBefore + qtyQcHold;
  const qtyReserved = toNumber(existingBalance?.qtyReserved);
  const qtyQCBefore = toNumber(existingBalance?.qtyQC);
  const qtyQCAfter = qtyQCBefore + qtyQcHold;
  const movementNumber = await generateMovementNumber("IN", tx);

  await tx.stockMovement.create({
    data: {
      movementNumber,
      movementDate: now,
      movementType: "IN",
      direction: "IN",
      transactionType: "QC_HOLD",
      warehouseCode,
      rackCode,
      lotNumber,
      partCode: part.partCode,
      partNumber: part.partNumber || null,
      partName: part.partName || null,
      ...stockIdentity,
      stockType,
      qty: qtyQcHold,
      deltaQty: qtyQcHold,
      qtyBefore,
      qtyAfter,
      uomCode: mo?.uomCode || log.workOrder?.uomCode || null,
      qualityBucket: "GOOD",
      referenceType: "PRODUCTION_LOG",
      referenceNumber: log.logNumber,
      notes: `${stockType === "Finished Goods" ? "FG" : "WIP"} good output ${log.logNumber} masuk QC Hold (Good: ${qtyGood})`,
      performedBy,
    },
  });

  let outputBalance;
  if (existingBalance) {
    await assertStockBalanceNotFrozen(tx, existingBalance.id);
    outputBalance = await tx.stockBalance.update({
      where: { id: existingBalance.id },
      data: {
        qtyOnHand: qtyAfter,
        qtyReserved,
        qtyQC: qtyQCAfter,
        qtyAvailable: Math.max(0, qtyAfter - qtyReserved - qtyQCAfter),
        lastMovement: now,
      },
    });
  } else {
    await assertStockIdentityNotFrozen(tx, {
      warehouseCode,
      rackCode,
      lotNumber,
      stockType,
    });
    outputBalance = await tx.stockBalance.create({
      data: {
        warehouseCode,
        rackCode,
        lotNumber,
        partCode: part.partCode,
        partNumber: part.partNumber || null,
        partName: part.partName || null,
        ...stockIdentity,
        uomCode: mo?.uomCode || log.workOrder?.uomCode || null,
        stockType,
        qtyOnHand: qtyQcHold,
        qtyReserved: 0,
        qtyQC: qtyQcHold,
        qtyAvailable: 0,
        lastMovement: now,
      },
    });
  }

  return {
    movementNumber,
    consumedWipMovementNumbers,
    stockBalanceId: outputBalance?.id || null,
    warehouseCode,
    rackCode,
    lotNumber,
    partId: part.id || null,
    partCode: part.partCode,
    stockType,
    uomCode: mo?.uomCode || log.workOrder?.uomCode || null,
  };
}

async function ensureProductionQualityInspection(tx, log, outputMovement, performedBy = "system") {
  const qtyGood = toNumber(log.qtyGood);
  if (qtyGood <= QUANTITY_TOLERANCE || !outputMovement?.movementNumber) return null;

  const existing = await tx.qualityInspection.findFirst({
    where: { productionLogId: log.id, isDeleted: false },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;

  const selfCheck = log.qualityCheckMode === "OPERATOR_SELF_CHECK";
  const now = new Date();
  const inspectionNumber = await generateDailyNumber(
    tx,
    "qualityInspection",
    "inspectionNumber",
    "QC",
  );
  const inspection = await tx.qualityInspection.create({
    data: {
      inspectionNumber,
      inspectionDate: now,
      moId: log.manufacturingOrder.id,
      woId: log.workOrder?.id || null,
      productionLogId: log.id,
      partId: outputMovement.partId || log.manufacturingOrder.partId || null,
      batchNumber: outputMovement.lotNumber || null,
      sampleSize: 1,
      qtyInspected: qtyGood,
      qtyPassed: qtyGood,
      qtyFailed: 0,
      qtyRework: 0,
      decision: selfCheck ? "Accepted" : "Pending",
      inspectedBy: log.operatorName,
      approvedBy: selfCheck ? performedBy : null,
      approvedAt: selfCheck ? now : null,
      status: selfCheck ? "Completed" : "Draft",
      notes: selfCheck
        ? `Operator self-check dari ${log.logNumber}. ${log.selfCheckNotes || ""}`.trim()
        : `QC otomatis dari Production Log ${log.logNumber}; release stock setelah inspeksi selesai.`,
    },
  });

  if (!selfCheck || !outputMovement.stockBalanceId) return inspection;

  const balance = await tx.stockBalance.findUnique({
    where: { id: outputMovement.stockBalanceId },
    select: { id: true, qtyOnHand: true, qtyReserved: true, qtyQC: true },
  });
  if (!balance || toNumber(balance.qtyQC) + QUANTITY_TOLERANCE < qtyGood) {
    throw Object.assign(new Error("Stock QC Hold tidak cukup untuk operator self-check release."), { statusCode: 409 });
  }
  await assertStockBalanceNotFrozen(tx, balance.id);
  const qtyOnHand = toNumber(balance.qtyOnHand);
  const qtyReserved = toNumber(balance.qtyReserved);
  const qtyQCBefore = toNumber(balance.qtyQC);
  const qtyQCAfter = Math.max(0, qtyQCBefore - qtyGood);
  await tx.stockBalance.update({
    where: { id: balance.id },
    data: {
      qtyQC: qtyQCAfter,
      qtyAvailable: Math.max(0, qtyOnHand - qtyReserved - qtyQCAfter),
      lastMovement: now,
    },
  });

  const sourceMovement = await tx.stockMovement.findUnique({
    where: { movementNumber: outputMovement.movementNumber },
  });
  const releaseMovementNumber = await generateMovementNumber("ADJUSTMENT", tx);
  await tx.stockMovement.create({
    data: {
      movementNumber: releaseMovementNumber,
      movementDate: now,
      movementType: "ADJUSTMENT",
      direction: "IN",
      transactionType: "QUALITY_RELEASE",
      warehouseCode: outputMovement.warehouseCode,
      rackCode: outputMovement.rackCode,
      destinationWarehouseCode: outputMovement.warehouseCode,
      destinationRackCode: outputMovement.rackCode,
      lotNumber: outputMovement.lotNumber,
      partCode: outputMovement.partCode,
      partNumber: sourceMovement?.partNumber || null,
      partName: sourceMovement?.partName || null,
      materialId: sourceMovement?.materialId || null,
      materialCode: sourceMovement?.materialCode || null,
      materialName: sourceMovement?.materialName || null,
      materialType: sourceMovement?.materialType || null,
      spec: sourceMovement?.spec || null,
      thickness: sourceMovement?.thickness || null,
      width: sourceMovement?.width || null,
      CSP: sourceMovement?.CSP || null,
      productId: sourceMovement?.productId || null,
      description: sourceMovement?.description || null,
      stockType: outputMovement.stockType,
      qty: qtyGood,
      deltaQty: 0,
      qtyBefore: qtyQCBefore,
      qtyAfter: qtyQCAfter,
      uomCode: outputMovement.uomCode,
      qualityBucket: "GOOD",
      referenceType: "QUALITY_INSPECTION",
      referenceNumber: inspection.inspectionNumber,
      notes: `Operator self-check release ${log.logNumber}; stok tersedia tanpa antrean QC terpisah.`,
      performedBy: log.operatorName || performedBy,
    },
  });

  return { ...inspection, releaseMovementNumber };
}

async function createProductionRejectDisposition(tx, log, stockTarget, performedBy = "system", finalRejectQty = null) {
  const qtyReject = finalRejectQty == null ? toNumber(log.qtyReject) : toNumber(finalRejectQty);
  if (qtyReject <= 0) return null;

  const dispositionRows = Array.isArray(stockTarget)
    ? stockTarget
        .map((row) => ({
          type: "REJECT",
          qty: toNumber(row?.qty),
          warehouseCode: normalizeOptionalText(row?.warehouseCode),
          rackCode: normalizeOptionalText(row?.rackCode),
          lotNumber: normalizeOptionalText(row?.lotNumber),
        }))
        .filter((row) => row.qty > 0)
    : [
        {
          type: "REJECT",
          qty: qtyReject,
          warehouseCode: normalizeOptionalText(stockTarget?.warehouseCode),
          rackCode: normalizeOptionalText(stockTarget?.rackCode),
          lotNumber: normalizeOptionalText(stockTarget?.lotNumber),
        },
      ];

  let normalizedDispositionRows = dispositionRows;
  const allocatedQty = dispositionRows.reduce((sum, row) => sum + row.qty, 0);
  if (Array.isArray(stockTarget) && allocatedQty > qtyReject + QUANTITY_TOLERANCE) {
    let remainingQty = qtyReject;
    normalizedDispositionRows = dispositionRows
      .map((row) => {
        const qty = Math.min(row.qty, remainingQty);
        remainingQty -= qty;
        return { ...row, qty };
      })
      .filter((row) => row.qty > QUANTITY_TOLERANCE);
  }
  const normalizedAllocatedQty = normalizedDispositionRows.reduce((sum, row) => sum + row.qty, 0);
  if (Math.abs(normalizedAllocatedQty - qtyReject) > QUANTITY_TOLERANCE) {
    throw Object.assign(
      new Error("Qty tujuan reject harus sama dengan hasil final reject dari judgment QC."),
      { statusCode: 400 },
    );
  }

  const missingWarehouse = normalizedDispositionRows.find((row) => !row.warehouseCode);
  if (missingWarehouse) {
    throw Object.assign(
      new Error("Warehouse wajib diisi saat approve Production Log dengan Qty NG."),
      { statusCode: 400 },
    );
  }

  const mo = log.manufacturingOrder;
  const { outputPart: part, stockType } = await resolveProductionOutputContext(tx, log);
  if (!part?.partCode) {
    throw Object.assign(new Error("Part Code reject Production Log tidak ditemukan."), {
      statusCode: 400,
    });
  }

  const now = new Date();
  const movementNumbers = [];
  const stockIdentity = resolvePartStockIdentity(part);
  for (const row of normalizedDispositionRows) {
    const balanceWhere = {
      warehouseCode: row.warehouseCode,
      rackCode: row.rackCode,
      lotNumber: row.lotNumber,
      partCode: part.partCode,
      partNumber: part.partNumber || null,
      partName: part.partName || null,
      productId: null,
      description: null,
      ...stockIdentity,
      uomCode: mo?.uomCode || log.workOrder?.uomCode || null,
      stockType,
      isDeleted: false,
    };
    await lockStockBalanceIdentity(tx, balanceWhere);
    const existingBalance = await tx.stockBalance.findFirst({
      where: balanceWhere,
      select: { id: true, qtyOnHand: true, qtyReserved: true, qtyQC: true },
    });

    const qtyBefore = toNumber(existingBalance?.qtyOnHand);
    const qtyAfter = qtyBefore + row.qty;
    const qtyReserved = toNumber(existingBalance?.qtyReserved);
    const qtyQCBefore = toNumber(existingBalance?.qtyQC);
    const qtyQCAfter = qtyQCBefore + row.qty;
    const movementNumber = await generateMovementNumber("IN", tx);
    await tx.stockMovement.create({
      data: {
        movementNumber,
        movementDate: now,
        movementType: "IN",
        direction: "IN",
        transactionType: "QC_HOLD",
        warehouseCode: row.warehouseCode,
        rackCode: row.rackCode,
        lotNumber: row.lotNumber,
        partCode: part.partCode,
        partNumber: part.partNumber || null,
        partName: part.partName || null,
        ...stockIdentity,
        stockType,
        qty: row.qty,
        deltaQty: row.qty,
        qtyBefore,
        qtyAfter,
        uomCode: mo?.uomCode || log.workOrder?.uomCode || null,
        qualityBucket: "NG",
        referenceType: "PRODUCTION_LOG",
        referenceNumber: log.logNumber,
        notes: `Production NG dari ${log.logNumber} masuk QC Hold di rack reject (qty: ${row.qty})`,
        performedBy,
      },
    });

    if (existingBalance) {
      await assertStockBalanceNotFrozen(tx, existingBalance.id);
      await tx.stockBalance.update({
        where: { id: existingBalance.id },
        data: {
          qtyOnHand: qtyAfter,
          qtyReserved,
          qtyQC: qtyQCAfter,
          qtyAvailable: Math.max(0, qtyAfter - qtyReserved - qtyQCAfter),
          lastMovement: now,
        },
      });
    } else {
      await assertStockIdentityNotFrozen(tx, {
        warehouseCode: row.warehouseCode,
        rackCode: row.rackCode,
        lotNumber: row.lotNumber,
        stockType,
      });
      await tx.stockBalance.create({
        data: {
          warehouseCode: row.warehouseCode,
          rackCode: row.rackCode,
          lotNumber: row.lotNumber,
          partCode: part.partCode,
          partNumber: part.partNumber || null,
          partName: part.partName || null,
          ...stockIdentity,
          uomCode: mo?.uomCode || log.workOrder?.uomCode || null,
          stockType,
          qtyOnHand: row.qty,
          qtyReserved: 0,
          qtyQC: row.qty,
          qtyAvailable: 0,
          lastMovement: now,
        },
      });
    }

    await createWIPEntry(tx, {
      entryDate: now,
      moId: log.moId,
      woId: log.woId || null,
      costType: "Scrap",
      sourceType: "ProductionLog",
      sourceId: log.id,
      sourceRef: log.logNumber,
      partCode: part.partCode || null,
      partNumber: part.partNumber || null,
      partName: part.partName || null,
      uomCode: mo?.uomCode || log.workOrder?.uomCode || null,
      warehouseCode: row.warehouseCode || null,
      rackCode: row.rackCode || null,
      lotNumber: row.lotNumber || null,
      stockType,
      qty: row.qty,
      rate: 0,
      amount: 0,
      direction: "OUT",
      notes: `Production NG ${part.partCode} dari ${log.logNumber}`,
      createdBy: performedBy,
    });

    movementNumbers.push(movementNumber);
  }

  return { movementNumbers };
}

async function createProductionReworkWorkOrder(tx, log, performedBy = "system") {
  const qtyRework = toNumber(log.qtyRework);
  if (qtyRework <= 0 || !log.workOrder || !log.manufacturingOrder) return null;

  const sourceWo = log.workOrder;
  const reworkWoNumber = await generateDailyNumber(tx, "workOrder", "woNumber", "WO");
  const now = new Date();

  const created = await tx.workOrder.create({
    data: {
      woNumber: reworkWoNumber,
      woDate: now,
      moId: log.manufacturingOrder.id,
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
        plannedQty: qtyRework,
        uomCode: sourceWo.uomCode || log.manufacturingOrder.uomCode || null,
        status: "Rework",
        isReworkOrder: true,
        reworkSourceType: "PRODUCTION_LOG",
        reworkReferenceType: "PRODUCTION_LOG",
        reworkReferenceNumber: log.logNumber,
        reworkReferenceLabel: log.logNumber,
        notes: null,
      },
      select: { id: true, woNumber: true, status: true, plannedQty: true },
  });

  return created;
}

async function finalizeProductionLogNgDisposition(
  tx,
  productionLogId,
  stockTarget = {},
  performedBy = "system",
) {
  const judgments = await tx.productionLogNgReason.findMany({
    where: { productionLogId, isDeleted: false },
    select: { status: true, qtyNg: true, qtyRework: true, qtyReject: true },
  });
  const pendingCount = judgments.filter((row) => row.status === "PENDING_QC").length;
  const qtyRework = judgments.reduce((sum, row) => sum + toNumber(row.qtyRework), 0);
  const qtyReject = judgments.reduce((sum, row) => sum + toNumber(row.qtyReject), 0);

  await tx.productionLog.update({
    where: { id: productionLogId },
    data: { qtyRework },
  });

  const log = await tx.productionLog.findUnique({
    where: { id: productionLogId },
    include: {
      coilPhases: {
        where: { isDeleted: false },
        orderBy: [{ phaseNumber: "asc" }, { createdAt: "asc" }],
        select: { productionLotNumber: true },
      },
      manufacturingOrder: {
        select: {
          id: true,
          partId: true,
          uomCode: true,
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
        },
      },
      workOrder: {
        select: {
          id: true,
          moId: true,
          mbomDetailId: true,
          machineId: true,
          processId: true,
          sequence: true,
          cycleTime: true,
          machineCostingRate: true,
          machineRateType: true,
          machineCurrency: true,
          uomCode: true,
          outputPartId: true,
          outputPartCode: true,
          outputPartNumber: true,
          outputPartName: true,
          mbomDetail: {
            select: {
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
            },
          },
        },
      },
    },
  });
  if (!log) throw Object.assign(new Error("Production Log untuk judgment NG tidak ditemukan."), { statusCode: 404 });

  if (pendingCount > 0 || log.status !== "Approved") {
    return { pendingCount, qtyRework, qtyReject, finalized: false };
  }

  const existingReject = await tx.stockMovement.aggregate({
    where: {
      referenceType: "PRODUCTION_LOG",
      referenceNumber: log.logNumber,
      transactionType: "QC_HOLD",
      movementType: "IN",
      qualityBucket: "NG",
      isDeleted: false,
    },
    _sum: { qty: true },
  });
  const postedRejectQty = toNumber(existingReject._sum.qty);
  if (postedRejectQty > qtyReject + QUANTITY_TOLERANCE) {
    throw Object.assign(
      new Error(`Disposition reject ${log.logNumber} sudah terposting melebihi hasil judgment QC.`),
      { statusCode: 409 },
    );
  }

  let rejectMovement = null;
  const remainingRejectQty = Math.max(0, qtyReject - postedRejectQty);
  if (remainingRejectQty > QUANTITY_TOLERANCE) {
    const productionLotNumber = log.coilPhases[0]?.productionLotNumber || null;
    const destination = Array.isArray(stockTarget)
      ? stockTarget
      : {
          warehouseCode: normalizeOptionalText(stockTarget?.warehouseCode) || "WH-001",
          rackCode: normalizeOptionalText(stockTarget?.rackCode) || "RACK-REJECT",
          lotNumber: normalizeOptionalText(stockTarget?.lotNumber) || productionLotNumber,
        };
    rejectMovement = await createProductionRejectDisposition(
      tx,
      log,
      destination,
      performedBy,
      remainingRejectQty,
    );
  }

  let reworkWorkOrder = await tx.workOrder.findFirst({
    where: {
      isDeleted: false,
      isReworkOrder: true,
      reworkReferenceType: "PRODUCTION_LOG",
      reworkReferenceNumber: log.logNumber,
    },
    select: { id: true, woNumber: true, status: true, plannedQty: true },
  });
  if (!reworkWorkOrder && qtyRework > QUANTITY_TOLERANCE) {
    reworkWorkOrder = await createProductionReworkWorkOrder(tx, log, performedBy);
  }

  return {
    pendingCount: 0,
    qtyRework,
    qtyReject,
    finalized: true,
    rejectMovement,
    reworkWorkOrder,
  };
}

exports.finalizeProductionLogNgDisposition = finalizeProductionLogNgDisposition;

exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      page = 1,
      limit = 20,
      moId,
      moNumber,
      woId,
      woNumber,
      scheduleNumber,
      shift,
      machineCode,
      status,
      hasQcRemaining,
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
    if (woId) where.woId = woId;
    if (woNumber) where.workOrder = { woNumber };
    if (scheduleNumber) where.dailyProductionSchedule = { scheduleNumber };
    if (shift) where.shift = assertProductionShift(shift);
    if (machineCode)
      where.machineCode = { contains: machineCode, mode: "insensitive" };
    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;

    if (startDate || endDate) {
      where.logDate = {};
      if (startDate) where.logDate.gte = new Date(startDate);
      if (endDate) where.logDate.lte = new Date(endDate);
    }

    if (q) {
      where.OR = [
        { logNumber: { contains: q, mode: "insensitive" } },
        { operatorName: { contains: q, mode: "insensitive" } },
        { machineCode: { contains: q, mode: "insensitive" } },
        { notes: { contains: q, mode: "insensitive" } },
        { dailyProductionSchedule: { scheduleNumber: { contains: q, mode: "insensitive" } } },
        { manufacturingOrder: { moNumber: { contains: q, mode: "insensitive" } } },
        { workOrder: { woNumber: { contains: q, mode: "insensitive" } } },
      ];
    }

    const orderBy = buildSort(req.query, { defaultSort: { logDate: "desc" } });
    const skip = (Number(page) - 1) * Number(limit);
    const filterQcRemaining = hasQcRemaining === "true";

    const [items, total] = await Promise.all([
      prisma.productionLog.findMany({
        where,
        orderBy,
        ...(filterQcRemaining ? {} : { skip, take: Number(limit) }),
        include: {
          dailyProductionSchedule: {
            select: {
              scheduleNumber: true, scheduleDate: true, shift: true, status: true,
              productionPlan: { select: { planNumber: true, status: true } },
              productionPlanAllocation: { select: { id: true, lineNumber: true, mbomProcessId: true } },
            },
          },
          manufacturingOrder: {
            select: {
              moNumber: true,
              status: true,
              part: {
                select: { partCode: true, partNumber: true, partName: true },
              },
            },
          },
          workOrder: {
            select: {
              woNumber: true,
              status: true,
              moId: true,
              sequence: true,
              outputPartId: true,
              outputPartCode: true,
              outputPartNumber: true,
              outputPartName: true,
              notes: true,
              mbomDetail: {
                select: {
                  levelComponent: true,
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
            },
          },
          qualityInspections: {
            where: { isDeleted: false },
            select: { qtyInspected: true },
          },
        },
      }),
      filterQcRemaining ? Promise.resolve(0) : prisma.productionLog.count({ where }),
    ]);

    let filteredItems = items;
    let filteredTotal = total;
    if (filterQcRemaining) {
      filteredItems = items.filter((item) => getProductionLogQcHoldQty(item) > (item.qualityInspections || []).reduce(
        (sum, inspection) => sum + toNumber(inspection.qtyInspected),
        0,
      ));
      filteredTotal = filteredItems.length;
      filteredItems = filteredItems.slice(skip, skip + Number(limit));
    }

    res.json({
      items: (await attachProductionOutputParts(filteredItems)).map(mapProductionLogDoc),
      total: filteredTotal,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (e) {
    next(e);
  }
};

exports.get = async (req, res, next) => {
  try {
    const doc = await prisma.productionLog.findFirst({
      where: { logNumber: req.params.logNumber, isDeleted: false },
      include: {
        carryover: true,
        coilPhases: {
          where: { isDeleted: false },
          orderBy: [{ phaseNumber: "asc" }, { createdAt: "asc" }],
          include: { ngReasons: { where: { isDeleted: false }, orderBy: { createdAt: "asc" } } },
        },
        dailyProductionSchedule: {
          select: {
            scheduleNumber: true,
            scheduleDate: true,
            shift: true,
            status: true,
            plannedQty: true,
            actualQty: true,
            productionPlan: { select: { planNumber: true, status: true } },
            productionPlanAllocation: { select: { id: true, lineNumber: true, mbomProcessId: true } },
          },
        },
        manufacturingOrder: {
          select: {
            moNumber: true,
            status: true,
            qtyPlanned: true,
            qtyProduced: true,
            part: {
              select: { partCode: true, partNumber: true, partName: true },
            },
          },
        },
        workOrder: {
            select: {
              woNumber: true,
              plannedDate: true,
              plannedQty: true,
              status: true,
              moId: true,
              sequence: true,
              outputPartId: true,
              outputPartCode: true,
              outputPartNumber: true,
              outputPartName: true,
              notes: true,
            mbomDetail: {
              select: {
                levelComponent: true,
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
          },
        },
        downtimeLogs: {
          where: { isDeleted: false },
          orderBy: { startTime: "asc" },
          select: {
            id: true,
            downtimeNumber: true,
            startTime: true,
            endTime: true,
            durationMinutes: true,
            reason: true,
            category: true,
            status: true,
            notes: true,
          },
        },
        qualityInspections: {
          where: { isDeleted: false },
          select: {
            id: true,
            inspectionNumber: true,
            decision: true,
            status: true,
            qtyInspected: true,
          },
        },
      },
    });

    if (!doc)
      return res
        .status(404)
        .json({ message: "Data Log Produksi tidak ditemukan." });
    res.json(mapProductionLogDoc(await attachProductionOutputParts(doc)));
  } catch (e) {
    next(e);
  }
};

function normalizeProductionCoilPhases(entries, logNumber) {
  if (!Array.isArray(entries)) throw Object.assign(new Error("coilPhases harus berupa array."), { statusCode: 400 });
  const defaultProductionLot = `${logNumber}-PROD`;
  return entries.map((entry, index) => {
    const inputLotNumber = String(entry?.inputLotNumber || "").trim();
    const qtyInput = Math.max(toNumber(entry?.qtyInput), 0);
    const qtyGood = Math.max(toNumber(entry?.qtyGood), 0);
    const qtyReject = Math.max(toNumber(entry?.qtyReject), 0);
    const ngReasons = (Array.isArray(entry?.ngReasons) ? entry.ngReasons : [])
      .map((reason, reasonIndex) => ({
        hmiRejectionId: Number.isInteger(Number(reason?.hmiRejectionId)) && Number(reason.hmiRejectionId) > 0 ? Number(reason.hmiRejectionId) : null,
        hmiRejectionSubId: Number.isInteger(Number(reason?.hmiRejectionSubId)) && Number(reason.hmiRejectionSubId) > 0 ? Number(reason.hmiRejectionSubId) : null,
        reason: String(reason?.reason || "").trim(),
        subReason: String(reason?.subReason || "").trim() || null,
        qtyNg: Math.max(toNumber(reason?.qtyNg), 0),
        reasonIndex: reasonIndex + 1,
      }))
      .filter((reason) => reason.qtyNg > QUANTITY_TOLERANCE || reason.reason);
    if (!inputLotNumber) throw Object.assign(new Error(`Lot coil/material wajib diisi pada phase ${index + 1}.`), { statusCode: 400 });
    if (qtyGood + qtyReject <= 0) throw Object.assign(new Error(`Qty OK atau reject wajib diisi pada phase ${index + 1}.`), { statusCode: 400 });
    if (qtyInput > 0 && qtyGood + qtyReject > qtyInput + 0.000001) {
      throw Object.assign(new Error(`Total output phase ${index + 1} tidak boleh melebihi qty input.`), { statusCode: 400 });
    }
    if (qtyReject > QUANTITY_TOLERANCE) {
      if (!ngReasons.length || ngReasons.some((reason) => !reason.reason || reason.qtyNg <= QUANTITY_TOLERANCE)) {
        throw Object.assign(new Error(`Setiap Qty NG pada phase ${index + 1} wajib memiliki reason dan qty.`), { statusCode: 400 });
      }
      const allocatedNg = ngReasons.reduce((sum, reason) => sum + reason.qtyNg, 0);
      if (Math.abs(allocatedNg - qtyReject) > QUANTITY_TOLERANCE) {
        throw Object.assign(new Error(`Total qty reason NG phase ${index + 1} harus sama dengan Qty NG (${qtyReject}).`), { statusCode: 400 });
      }
    } else if (ngReasons.length) {
      throw Object.assign(new Error(`Reason NG phase ${index + 1} tidak boleh diisi ketika Qty NG nol.`), { statusCode: 400 });
    }
    const startedAt = entry?.startedAt ? new Date(entry.startedAt) : null;
    const endedAt = entry?.endedAt ? new Date(entry.endedAt) : null;
    if ((startedAt && Number.isNaN(startedAt.getTime())) || (endedAt && Number.isNaN(endedAt.getTime())) || (startedAt && endedAt && endedAt < startedAt)) {
      throw Object.assign(new Error(`Waktu phase ${index + 1} tidak valid.`), { statusCode: 400 });
    }
    return {
      phaseNumber: index + 1,
      coilNumber: String(entry?.coilNumber || "").trim() || null,
      inputLotNumber,
      qtyInput,
      qtyGood,
      qtyReject,
      ngReasons,
      productionLotNumber: String(entry?.productionLotNumber || defaultProductionLot).trim() || defaultProductionLot,
      startedAt,
      endedAt,
      notes: String(entry?.notes || "").trim() || null,
    };
  });
}

exports.create = async (req, res, next) => {
  try {
    const {
      startTime,
      endTime,
      logDate,
      downtimes = [],
      coilPhases = [],
      status: _status,
      logNumber: _logNumber,
      ...data
    } = req.body;

    const logNumber = await generateLogNumber();
    const normalizedCoilPhases = normalizeProductionCoilPhases(coilPhases, logNumber);
    if (normalizedCoilPhases.length) {
      data.qtyGood = normalizedCoilPhases.reduce((sum, row) => sum + row.qtyGood, 0);
      data.qtyReject = normalizedCoilPhases.reduce((sum, row) => sum + row.qtyReject, 0);
      data.qtyProduced = data.qtyGood + data.qtyReject;
      data.rejectReason = normalizedCoilPhases
        .flatMap((row) => row.ngReasons.map((reason) => `${reason.reason}${reason.subReason ? ` / ${reason.subReason}` : ""}: ${reason.qtyNg}`))
        .join("; ") || null;
    }

    const doc = await prisma.$transaction(async (tx) => {
      const normalized = await normalizeProductionLogInput(tx, data, {
        defaultStatus: "Open",
      });
      // HMI telemetry may prefill a log, but material/quantity/approval checks
      // must still run through the explicit submit transition.
      normalized.status = "Open";
      const downtimeSummary = Array.isArray(req.body.downtimes)
        ? summarizeDowntimeEntries(downtimes, {
            ...normalized,
            logDate: logDate ? new Date(logDate) : normalized.logDate || new Date(),
          })
        : null;
      if (downtimeSummary) {
        normalized.downtime = downtimeSummary.downtime;
        normalized.downtimeReason = downtimeSummary.downtimeReason;
      }
      const calculatedRunningMinutes = getDurationFromInput(startTime, endTime);
      if (normalized.runningMinutes === undefined && calculatedRunningMinutes !== null) {
        normalized.runningMinutes = calculatedRunningMinutes;
      }
      // uomCode is a transient planning/validation value on a production log;
      // the legacy production-log table has no persisted UOM column. Keep it
      // available for quantity validation above, but never pass it to Prisma.
      const persisted = { ...normalized };
      delete persisted.uomCode;
      const productionLog = await tx.productionLog.create({
        data: {
          ...persisted,
          logNumber,
          logDate: logDate ? new Date(logDate) : normalized.logDate || new Date(),
          startTime: startTime ? new Date(startTime) : null,
          endTime: endTime ? new Date(endTime) : null,
        },
        include: {
          dailyProductionSchedule: { select: { scheduleNumber: true, productionPlan: { select: { planNumber: true } } } },
          manufacturingOrder: {
            select: {
              moNumber: true,
              part: {
                select: { partCode: true, partNumber: true, partName: true },
              },
            },
          },
          workOrder: {
            select: {
              woNumber: true,
              moId: true,
              sequence: true,
              outputPartId: true,
              outputPartCode: true,
              outputPartNumber: true,
              outputPartName: true,
              notes: true,
              mbomDetail: {
                select: {
                  levelComponent: true,
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
            },
          },
        },
      });

      if (normalizedCoilPhases.length) {
        for (const row of normalizedCoilPhases) {
          const { ngReasons, ...phaseData } = row;
          const phase = await tx.productionLogCoilPhase.create({
            data: { ...phaseData, productionLogId: productionLog.id },
          });
          if (ngReasons.length) {
            await tx.productionLogNgReason.createMany({
              data: ngReasons.map(({ reasonIndex: _reasonIndex, ...reason }) => ({
                ...reason,
                productionLogId: productionLog.id,
                coilPhaseId: phase.id,
                phaseNumber: phase.phaseNumber,
              })),
            });
          }
        }
      }

      if (Array.isArray(downtimes) && downtimes.length > 0) {
        for (const entry of downtimes) {
          const downtimeNumber = await generateDowntimeNumber(tx);
          await tx.downtimeLog.create({
            data: {
              ...normalizeDowntimeEntry(entry, productionLog),
              downtimeNumber,
            },
          });
        }
      }

      const doc = await tx.productionLog.findUnique({
        where: { id: productionLog.id },
        include: {
          coilPhases: {
            where: { isDeleted: false },
            orderBy: [{ phaseNumber: "asc" }, { createdAt: "asc" }],
            include: { ngReasons: { where: { isDeleted: false }, orderBy: { createdAt: "asc" } } },
          },
          dailyProductionSchedule: { select: { scheduleNumber: true, productionPlan: { select: { planNumber: true } } } },
          manufacturingOrder: {
            select: {
              id: true,
              moNumber: true,
              partId: true,
              qtyPlanned: true,
              uomCode: true,
              plannedOrderNumber: true,
              materialRequirementUomMode: true,
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
            },
          },
          workOrder: {
            select: {
              id: true,
              woNumber: true,
              moId: true,
              sequence: true,
              outputPartId: true,
              outputPartCode: true,
              outputPartNumber: true,
              outputPartName: true,
              notes: true,
              uomCode: true,
              mbomDetail: {
                select: {
                  levelComponent: true,
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
            },
          },
          downtimeLogs: {
            where: { isDeleted: false },
            orderBy: { startTime: "asc" },
          },
        },
      });

      return doc;
    });

    res.status(201).json(mapProductionLogDoc(await attachProductionOutputParts(doc)));
  } catch (e) {
    if (e.statusCode)
      return res.status(e.statusCode).json({ message: e.message, code: e.code || null, blockers: e.blockers || [] });
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      return res
        .status(409)
        .json({ message: "Nomor Log Produksi sudah digunakan." });
    }
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const {
      startTime,
      endTime,
      logDate,
      downtimes,
      coilPhases,
      status: _status,
      logNumber: _logNumber,
      ...data
    } = req.body;
    const downtimePayloadSupplied = Object.prototype.hasOwnProperty.call(
      req.body,
      "downtimes",
    );
    const coilPhasePayloadSupplied = Object.prototype.hasOwnProperty.call(req.body, "coilPhases");

    const existing = await prisma.productionLog.findFirst({
      where: { logNumber: req.params.logNumber, isDeleted: false },
      select: { id: true, logNumber: true, status: true },
    });
    if (!existing)
      return res
        .status(404)
        .json({ message: "Data Log Produksi tidak ditemukan." });
    if (existing.status === "Approved") {
      return res
        .status(409)
        .json({
          message: "Log Produksi yang sudah Approved tidak dapat diubah.",
        });
    }

    const doc = await prisma.$transaction(async (tx) => {
      const normalizedCoilPhases = coilPhasePayloadSupplied
        ? normalizeProductionCoilPhases(Array.isArray(coilPhases) ? coilPhases : [], existing.logNumber)
        : null;
      if (normalizedCoilPhases?.length) {
        data.qtyGood = normalizedCoilPhases.reduce((sum, row) => sum + row.qtyGood, 0);
        data.qtyReject = normalizedCoilPhases.reduce((sum, row) => sum + row.qtyReject, 0);
        data.qtyProduced = data.qtyGood + data.qtyReject;
        data.rejectReason = normalizedCoilPhases
          .flatMap((row) => row.ngReasons.map((reason) => `${reason.reason}${reason.subReason ? ` / ${reason.subReason}` : ""}: ${reason.qtyNg}`))
          .join("; ") || null;
      }
      const updateData = await normalizeProductionLogInput(tx, data);
      if (logDate !== undefined)
        updateData.logDate = logDate ? new Date(logDate) : null;
      if (startTime !== undefined)
        updateData.startTime = startTime ? new Date(startTime) : null;
      if (endTime !== undefined)
        updateData.endTime = endTime ? new Date(endTime) : null;
      if (
        updateData.runningMinutes === undefined &&
        (startTime !== undefined || endTime !== undefined)
      ) {
        const calculatedRunningMinutes = getDurationFromInput(startTime, endTime);
        if (calculatedRunningMinutes !== null) updateData.runningMinutes = calculatedRunningMinutes;
      }
      if (downtimePayloadSupplied) {
        const summary = summarizeDowntimeEntries(
          Array.isArray(downtimes) ? downtimes : [],
          {
            ...updateData,
            id: existing.id,
            logDate: updateData.logDate || new Date(),
          },
        );
        updateData.downtime = summary.downtime;
        updateData.downtimeReason = summary.downtimeReason;
      }

      const updated = await tx.productionLog.update({
        where: { id: existing.id },
        data: updateData,
      });

      if (coilPhasePayloadSupplied) {
        await tx.productionLogCoilPhase.deleteMany({ where: { productionLogId: existing.id } });
        if (normalizedCoilPhases.length) {
          for (const row of normalizedCoilPhases) {
            const { ngReasons, ...phaseData } = row;
            const phase = await tx.productionLogCoilPhase.create({ data: { ...phaseData, productionLogId: existing.id } });
            if (ngReasons.length) {
              await tx.productionLogNgReason.createMany({
                data: ngReasons.map(({ reasonIndex: _reasonIndex, ...reason }) => ({
                  ...reason,
                  productionLogId: existing.id,
                  coilPhaseId: phase.id,
                  phaseNumber: phase.phaseNumber,
                })),
              });
            }
          }
        }
      }

      if (downtimePayloadSupplied) {
        await tx.downtimeLog.updateMany({
          where: { productionLogId: existing.id, isDeleted: false },
          data: { isDeleted: true, status: "Replaced" },
        });
        for (const entry of Array.isArray(downtimes) ? downtimes : []) {
          const downtimeNumber = await generateDowntimeNumber(tx);
          await tx.downtimeLog.create({
            data: {
              ...normalizeDowntimeEntry(entry, updated),
              downtimeNumber,
            },
          });
        }
      }

      return tx.productionLog.findUnique({
        where: { id: existing.id },
        include: {
          coilPhases: {
            where: { isDeleted: false },
            orderBy: [{ phaseNumber: "asc" }, { createdAt: "asc" }],
            include: { ngReasons: { where: { isDeleted: false }, orderBy: { createdAt: "asc" } } },
          },
          dailyProductionSchedule: { select: { scheduleNumber: true, productionPlan: { select: { planNumber: true } } } },
          manufacturingOrder: {
            select: {
              moNumber: true,
              part: {
                select: { partCode: true, partNumber: true, partName: true },
              },
            },
          },
          workOrder: {
            select: {
              woNumber: true,
              moId: true,
              sequence: true,
              notes: true,
              mbomDetail: {
                select: {
                  levelComponent: true,
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
                },
              },
            },
          },
          downtimeLogs: {
            where: { isDeleted: false },
            orderBy: { startTime: "asc" },
          },
        },
      });
    });

    res.json(mapProductionLogDoc(await attachProductionOutputParts(doc)));
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2025"
    ) {
      return res
        .status(404)
        .json({ message: "Data Log Produksi tidak ditemukan." });
    }
    if (e.statusCode)
      return res.status(e.statusCode).json({ message: e.message, code: e.code || null, blockers: e.blockers || [] });
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.productionLog.findUnique({
        where: { logNumber: req.params.logNumber },
        select: { id: true, logNumber: true, isDeleted: true, status: true, woId: true, moId: true, dpsId: true },
      });

      if (!existing) {
        throw Object.assign(new Error("Data Log Produksi tidak ditemukan."), { statusCode: 404 });
      }
      if (existing.isDeleted) {
        throw Object.assign(new Error("Data Log Produksi sudah dihapus."), { statusCode: 409 });
      }
      const blockers = await getProductionLogDeleteBlockers(tx, existing);
      if (blockers.length > 0) {
        throw Object.assign(
          new Error(`Log Produksi tidak bisa dihapus karena sudah punya data terkait: ${formatRelationList(blockers)}.`),
          { statusCode: 409 },
        );
      }

      await rollbackProductionLogAutomation(tx, existing);
      await tx.productionLog.updateMany({
        where: { id: existing.id, isDeleted: false },
        data: { isDeleted: true },
      });

      const workOrder = await resyncWorkOrderAfterProductionLogDelete(tx, existing.woId);
      let schedule = null;
      if (existing.dpsId) {
        const approvedScheduleLogs = await tx.productionLog.findMany({
          where: { dpsId: existing.dpsId, isDeleted: false, status: "Approved" },
          select: { qtyProduced: true },
        });
        const actualQty = approvedScheduleLogs.reduce((sum, log) => sum + toNumber(log.qtyProduced), 0);
        const currentSchedule = await tx.dailyProductionSchedule.findUnique({
          where: { id: existing.dpsId },
          select: { plannedQty: true },
        });
        schedule = await tx.dailyProductionSchedule.update({
          where: { id: existing.dpsId },
          data: {
            actualQty,
            status: currentSchedule && actualQty >= toNumber(currentSchedule.plannedQty)
              ? "Completed"
              : "In Progress",
          },
        });
      }

      const manufacturingOrder = workOrder?.manufacturingOrder
        || await syncManufacturingOrderQtyFromWorkOrders(tx, existing.moId);
      return { ok: true, workOrder, manufacturingOrder, schedule };
    });

    if (result.manufacturingOrder) {
      emitManufacturingOrderUpdate(result.manufacturingOrder, "sync", req.user?.username || "system");
    }
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

    const skipped = [];
    let deletedCount = 0;
    const records = await prisma.productionLog.findMany({
      where: { id: { in: ids }, isDeleted: false },
      select: { id: true, logNumber: true },
    });
    for (const log of records) {
      try {
        await prisma.$transaction(async (tx) => {
          const current = await tx.productionLog.findUnique({
            where: { id: log.id },
            select: { id: true, logNumber: true, isDeleted: true, status: true, woId: true, moId: true, dpsId: true },
          });
          if (!current || current.isDeleted) return;
          const blockers = await getProductionLogDeleteBlockers(tx, current);
          if (blockers.length > 0) {
            throw Object.assign(new Error(formatRelationList(blockers)), { statusCode: 409 });
          }
          await rollbackProductionLogAutomation(tx, current);
          await tx.productionLog.updateMany({
            where: { id: current.id, isDeleted: false },
            data: { isDeleted: true },
          });
          const workOrder = await resyncWorkOrderAfterProductionLogDelete(tx, current.woId);
          if (current.dpsId) {
            const approvedScheduleLogs = await tx.productionLog.findMany({
              where: { dpsId: current.dpsId, isDeleted: false, status: "Approved" },
              select: { qtyProduced: true },
            });
            const actualQty = approvedScheduleLogs.reduce((sum, item) => sum + toNumber(item.qtyProduced), 0);
            const schedule = await tx.dailyProductionSchedule.findUnique({
              where: { id: current.dpsId },
              select: { plannedQty: true },
            });
            await tx.dailyProductionSchedule.update({
              where: { id: current.dpsId },
              data: {
                actualQty,
                status: schedule && actualQty >= toNumber(schedule.plannedQty) ? "Completed" : "In Progress",
              },
            });
          }
          await syncManufacturingOrderQtyFromWorkOrders(tx, workOrder?.manufacturingOrder?.id || current.moId);
          deletedCount += 1;
        });
      } catch (error) {
        skipped.push({
          logNumber: log.logNumber,
          reason: error.statusCode ? error.message : error.message || "Rollback failed",
        });
      }
    }

    if (deletedCount === 0) {
      return res.status(409).json({
        message: "Tidak ada Log Produksi yang bisa dihapus. Log yang sudah punya QC tidak bisa dihapus.",
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
    const logNumber = await generateLogNumber();
    res.json({ logNumber });
  } catch (e) {
    next(e);
  }
};

// Open → Submitted
exports.submit = async (req, res, next) => {
  try {
    const existing = await prisma.productionLog.findUnique({
      where: { logNumber: req.params.logNumber },
      select: {
        id: true,
        isDeleted: true,
        status: true,
        dpsId: true,
        woId: true,
        moId: true,
        logDate: true,
        shift: true,
        logNumber: true,
        qtyProduced: true,
      },
    });
    if (!existing || existing.isDeleted)
      return res
        .status(404)
        .json({ message: "Data Log Produksi tidak ditemukan." });
    if (existing.status !== "Open") {
      return res
        .status(409)
        .json({
          message: `Log tidak bisa disubmit dari status "${existing.status}".`,
        });
    }
    const doc = await prisma.$transaction(async (tx) => {
      const schedule = existing.dpsId
        ? await tx.dailyProductionSchedule.findFirst({
            where: { id: existing.dpsId, isDeleted: false },
          })
        : await findRelatedDailyProductionSchedule(tx, existing);
      const relatedIssues = await tx.materialIssue.findMany({
        where: {
          isDeleted: false,
          OR: [
            ...(schedule?.scheduleNumber
              ? [{ notes: { contains: `[DPS-CONSUME:${schedule.scheduleNumber}]` } }]
              : []),
            ...(existing.woId ? [{ woId: existing.woId }] : []),
            ...(!existing.woId && existing.moId ? [{ moId: existing.moId }] : []),
          ],
        },
        select: {
          issueNumber: true,
          status: true,
          details: {
            where: { isDeleted: false },
            select: { id: true },
            take: 1,
          },
        },
      });
      const materialBlockers = relatedIssues
        .filter((issue) => issue.details.length > 0)
        .filter((issue) => !["Issued", "Partially Returned", "Closed"].includes(issue.status))
        .map((issue) => ({
          severity: "BLOCKING",
          code: "MATERIAL_ISSUE_NOT_POSTED",
          title: issue.issueNumber,
          message: `Material Issue ${issue.issueNumber} masih ${issue.status}; Inventory harus melakukan Consume / Issue terlebih dahulu.`,
          issueNumber: issue.issueNumber,
          href: `/modules/inventory/material-issues/${encodeURIComponent(issue.issueNumber)}`,
        }));
      if (materialBlockers.length) {
        throw Object.assign(
          new Error(`${materialBlockers.length} Material Issue belum diposting oleh Inventory.`),
          { statusCode: 409, blockers: materialBlockers },
        );
      }

      const approvalRequest = await submitDocumentForApproval({
        moduleCode: "production",
        pageCode: "production-logs",
        actionCode: "approve",
        documentType: "ProductionLog",
        documentId: existing.id,
        documentNumber: existing.logNumber,
        amount: existing.qtyProduced,
        context: existing,
        requestedByUserId: req.user?.id,
        requestedBy: req.user?.username || req.user?.email || "system",
        tx,
      });

      if (existing.woId) {
        await tx.workOrder.updateMany({
          where: {
            id: existing.woId,
            isDeleted: false,
            status: { in: ["Released", "Material Issued"] },
          },
          data: { status: "In Production", startTime: new Date() },
        });
      }
      if (schedule) {
        await tx.dailyProductionSchedule.updateMany({
          where: {
            id: schedule.id,
            isDeleted: false,
            status: { in: ["Draft", "Released"] },
          },
          data: {
            status: "In Progress",
            ...(!schedule.woId && existing.woId
              ? { woId: existing.woId }
              : {}),
          },
        });
      }
      const document = await tx.productionLog.update({
        where: { id: existing.id },
        data: {
          status: "Submitted",
          ...(schedule ? { dpsId: schedule.id } : {}),
        },
      });
      return { document, approvalRequest };
    });
    res.json({ ...mapDoc(doc.document), approvalRequest: doc.approvalRequest });
  } catch (e) {
    if (e.statusCode)
      return res.status(e.statusCode).json({ message: e.message, blockers: e.blockers || [] });
    next(e);
  }
};

// Submitted → Approved (+ auto sync qty ke WorkOrder terkait)
exports.approve = async (req, res, next) => {
  try {
    const legacyStockTarget = {
      warehouseCode: req.body?.warehouseCode,
      rackCode: req.body?.rackCode,
      lotNumber: req.body?.lotNumber,
    };
    const goodStockTarget = req.body?.goodDestination || legacyStockTarget;
    const rejectStockTarget =
      req.body?.failedDestination || req.body?.rejectDestination || legacyStockTarget;
    const existing = await prisma.productionLog.findUnique({
      where: { logNumber: req.params.logNumber },
      select: {
        id: true,
        isDeleted: true,
        status: true,
        woId: true,
        moId: true,
        dpsId: true,
        logDate: true,
        shift: true,
      },
    });
    if (!existing || existing.isDeleted)
      return res
        .status(404)
        .json({ message: "Data Log Produksi tidak ditemukan." });
    if (existing.status !== "Submitted") {
      return res
        .status(409)
        .json({
          message: `Log tidak bisa disetujui dari status "${existing.status}".`,
        });
    }

    const doc = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "tbl_production_log" WHERE "id" = ${existing.id} FOR UPDATE`;
      const lockedLog = await tx.productionLog.findUnique({
        where: { id: existing.id },
        select: { status: true, isDeleted: true },
      });
      if (!lockedLog || lockedLog.isDeleted || lockedLog.status !== "Submitted") {
        throw Object.assign(new Error(`Log tidak bisa disetujui dari status "${lockedLog?.status || "Tidak ditemukan"}".`), { statusCode: 409 });
      }
      const relatedSchedule = existing.dpsId
        ? await tx.dailyProductionSchedule.findFirst({
            where: { id: existing.dpsId, isDeleted: false },
          })
        : await findRelatedDailyProductionSchedule(tx, existing);
      if (relatedSchedule && !existing.dpsId) existing.dpsId = relatedSchedule.id;
      const currentLog = await tx.productionLog.findUnique({
        where: { id: existing.id },
        select: {
          qtyProduced: true,
          qtyGood: true,
          qtyReject: true,
          qtyRework: true,
          operatorName: true,
          qualityCheckMode: true,
          selfCheckNotes: true,
        },
      });
      const ngJudgments = await tx.productionLogNgReason.findMany({
        where: { productionLogId: existing.id, isDeleted: false },
        select: { status: true, qtyNg: true, qtyRework: true, qtyReject: true },
      });
      const recordedNgQty = ngJudgments.reduce((sum, row) => sum + toNumber(row.qtyNg), 0);
      if (toNumber(currentLog.qtyReject) > QUANTITY_TOLERANCE) {
        if (!ngJudgments.length || Math.abs(recordedNgQty - toNumber(currentLog.qtyReject)) > QUANTITY_TOLERANCE) {
          throw Object.assign(new Error("Detail reason NG belum lengkap. Lengkapi reason per phase sebelum approval."), { statusCode: 409 });
        }
      }
      const judgmentQtyRework = ngJudgments.reduce((sum, row) => sum + toNumber(row.qtyRework), 0);
      currentLog.qtyRework = judgmentQtyRework;
      const approvalPayload = ngJudgments.length
        ? { ...(req.body || {}), qtyReject: currentLog.qtyReject }
        : (req.body || {});
      const approvedQty = normalizeApprovalQtyPayload(currentLog, approvalPayload);

      const updated = await tx.productionLog.update({
        where: { id: existing.id },
        data: {
          ...approvedQty,
          status: "Approved",
          ...(currentLog.qualityCheckMode === "OPERATOR_SELF_CHECK"
            ? {
                selfCheckedBy: currentLog.operatorName,
                selfCheckedAt: new Date(),
              }
            : { selfCheckedBy: null, selfCheckedAt: null }),
          ...(relatedSchedule ? { dpsId: relatedSchedule.id } : {}),
        },
        include: {
          manufacturingOrder: {
            select: {
              id: true,
              moNumber: true,
              partId: true,
              qtyPlanned: true,
              uomCode: true,
              plannedOrderNumber: true,
              materialRequirementUomMode: true,
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
            },
          },
          workOrder: {
            select: {
              id: true,
              woNumber: true,
              moId: true,
              mbomDetailId: true,
              machineId: true,
              processId: true,
              notes: true,
              sequence: true,
              cycleTime: true,
              machineCostingRate: true,
              machineRateType: true,
              machineCurrency: true,
              uomCode: true,
              outputPartId: true,
              outputPartCode: true,
              outputPartNumber: true,
              outputPartName: true,
              mbomDetail: {
                select: {
                  levelComponent: true,
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
                },
              },
            },
          },
        },
      });

      const carryover = toNumber(updated.qtyReject) > QUANTITY_TOLERANCE
        ? null
        : await createProductionShortfallCarryover(tx, {
            log: updated,
            schedule: relatedSchedule,
            actor: req.user?.username || req.user?.email || "system",
          });

      let automation = null;
      const subAssemblyMovementNumbers = await consumeReservedSubAssembliesForProductionLog(
        tx,
        updated,
        req.user?.username || "system",
      );
      const outputMovement = await receiveProductionLogOutputToQc(
        tx,
        updated,
        goodStockTarget,
        req.user?.username || "system",
      );
      const qualityInspection = await ensureProductionQualityInspection(
        tx,
        updated,
        outputMovement,
        req.user?.username || "system",
      );
      const ngDisposition = await finalizeProductionLogNgDisposition(
        tx,
        updated.id,
        rejectStockTarget,
        req.user?.username || "system",
      );
      const rejectMovement = ngDisposition.rejectMovement || null;
      const reworkWorkOrder = ngDisposition.reworkWorkOrder || null;

      // Auto sync akumulasi qty ke WorkOrder (jika log terkait WO)
      if (existing.woId) {
        const syncedWorkOrder = await syncWorkOrderActualsFromApprovedLogs(tx, existing.woId);
        const workOrderRemainingQty = Math.max(
          0,
          toNumber(syncedWorkOrder?.plannedQty) - toNumber(syncedWorkOrder?.qtyProduced),
        );
        if (outputMovement?.movementNumber) {
          await tx.workOrder.updateMany({
            where: {
              id: existing.woId,
              isDeleted: false,
              status: { in: ["In Production", "In Progress", "Rework"] },
            },
            data: {
              status: workOrderRemainingQty > QUANTITY_TOLERANCE ? "In Production" : "QC Pending",
            },
          });
        }
        else if (rejectMovement) {
          await tx.workOrder.updateMany({
            where: {
              id: existing.woId,
              isDeleted: false,
              status: { in: ["In Production", "In Progress", "Rework"] },
            },
            data: { status: "Completed", endTime: updated.endTime || new Date() },
          });
        }

        // WO completion is gated by completed QC, not by log approval.
        automation = { outputMovement, qualityInspection, rejectMovement, reworkWorkOrder, ngDisposition, subAssemblyMovementNumbers };
      }

      const syncedMo = existing.woId
        ? await syncManufacturingOrderQtyFromWorkOrders(
            tx,
            updated.manufacturingOrder?.id,
          )
        : null;

      if (existing.dpsId) {
        const approvedScheduleLogs = await tx.productionLog.findMany({
          where: { dpsId: existing.dpsId, isDeleted: false, status: "Approved" },
          select: { qtyProduced: true },
        });
        const actualQty = approvedScheduleLogs.reduce(
          (sum, log) => sum + Number(log.qtyProduced || 0),
          0,
        );
        const schedule = await tx.dailyProductionSchedule.findUnique({
          where: { id: existing.dpsId },
          select: { plannedQty: true },
        });

        await tx.dailyProductionSchedule.update({
          where: { id: existing.dpsId },
          data: {
            actualQty,
            status:
              schedule && actualQty >= Number(schedule.plannedQty || 0)
                ? "Completed"
                : "In Progress",
          },
        });
      }

      return { updated, carryover, automation, outputMovement, subAssemblyMovementNumbers, syncedMo };
    }, PRODUCTION_APPROVAL_TRANSACTION_OPTIONS);

    if (doc.syncedMo) {
      emitManufacturingOrderUpdate(doc.syncedMo, "sync", req.user?.username || "system");
    }
    res.json({
      ...mapDoc(doc.updated),
      carryover: doc.carryover ? mapDoc(doc.carryover) : null,
      automation: doc.automation,
      stockMovementNumber: doc.outputMovement?.movementNumber || null,
      consumedWipMovementNumbers: doc.outputMovement?.consumedWipMovementNumbers || [],
      consumedSubAssemblyMovementNumbers: doc.subAssemblyMovementNumbers || [],
    });
  } catch (e) {
    if (e.statusCode)
      return res.status(e.statusCode).json({ message: e.message });
    next(e);
  }
};

// Recovery/compatibility action for Approved logs created before automatic QC queueing.
exports.ensureQcRelease = async (req, res, next) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const log = await tx.productionLog.findFirst({
        where: { logNumber: req.params.logNumber, isDeleted: false },
        include: {
          manufacturingOrder: {
            select: { id: true, partId: true, uomCode: true },
          },
          workOrder: {
            select: { id: true, uomCode: true, outputPartId: true },
          },
        },
      });
      if (!log) throw Object.assign(new Error("Production Log tidak ditemukan."), { statusCode: 404 });
      if (log.status !== "Approved") {
        throw Object.assign(new Error("QC Release hanya dapat dibuat dari Production Log Approved."), { statusCode: 409 });
      }
      if (toNumber(log.qtyGood) <= QUANTITY_TOLERANCE) {
        throw Object.assign(new Error("Production Log tidak memiliki Qty Good untuk direlease."), { statusCode: 409 });
      }

      const sourceMovement = await tx.stockMovement.findFirst({
        where: {
          referenceType: "PRODUCTION_LOG",
          referenceNumber: log.logNumber,
          transactionType: "QC_HOLD",
          qualityBucket: "GOOD",
          isDeleted: false,
        },
        orderBy: { createdAt: "asc" },
      });
      if (!sourceMovement) {
        throw Object.assign(new Error("Stock movement QC Hold hasil OK tidak ditemukan."), { statusCode: 409 });
      }
      const balance = await tx.stockBalance.findFirst({
        where: {
          warehouseCode: sourceMovement.warehouseCode,
          rackCode: sourceMovement.rackCode || null,
          lotNumber: sourceMovement.lotNumber || null,
          partCode: sourceMovement.partCode,
          uomCode: sourceMovement.uomCode || null,
          stockType: sourceMovement.stockType,
          isDeleted: false,
        },
        select: { id: true },
      });
      const inspection = await ensureProductionQualityInspection(
        tx,
        log,
        {
          movementNumber: sourceMovement.movementNumber,
          stockBalanceId: balance?.id || null,
          warehouseCode: sourceMovement.warehouseCode,
          rackCode: sourceMovement.rackCode || null,
          lotNumber: sourceMovement.lotNumber || null,
          partId: log.workOrder?.outputPartId || log.manufacturingOrder.partId || null,
          partCode: sourceMovement.partCode,
          stockType: sourceMovement.stockType,
          uomCode: sourceMovement.uomCode || log.workOrder?.uomCode || log.manufacturingOrder.uomCode || null,
        },
        req.user?.username || req.user?.email || "system",
      );
      return inspection;
    });

    res.json({
      message: result.status === "Completed"
        ? "Self-check selesai dan stok hasil OK sudah direlease."
        : "Antrean QC Release Stock berhasil dibuat.",
      inspection: mapDoc(result),
      href: `/modules/qc/quality-inspections/${encodeURIComponent(result.inspectionNumber)}`,
    });
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
    next(e);
  }
};

// Dipakai oleh maintenance/backfill untuk Approved log lama yang belum
// mengonsumsi reservation sub-assembly. Fungsi ini idempotent per log.
exports.reconcileApprovedProductionLogSubAssemblies =
  reconcileApprovedProductionLogSubAssemblies;
