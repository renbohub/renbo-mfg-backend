const { generateConfiguredNumber } = require("../../../services/numberingService");

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

const PRODUCTION_SHIFT_VALUES = ["1A", "1B", "2A", "2B", "3A", "3C"];
const WORK_ORDER_STATUSES = [
  "Draft",
  "Released",
  "Material Issued",
  "In Production",
  "QC Pending",
  "Rework",
  "Completed",
  "Cancelled",
];
const LEGACY_WORK_ORDER_STATUSES = ["Planned", "In Progress"];
const WORK_ORDER_STARTABLE_STATUSES = ["Released", "Material Issued", "Rework"];
const WORK_ORDER_PRODUCTION_STATUSES = ["In Production", "In Progress"];

function normalizeShift(value) {
  if (value === undefined || value === null || value === "") return value;
  return String(value).trim().toUpperCase();
}

function assertProductionShift(value, options = {}) {
  const normalized = normalizeShift(value);
  if (!normalized && !options.required) return normalized;
  if (!PRODUCTION_SHIFT_VALUES.includes(normalized)) {
    throw httpError(
      `Shift tidak valid. Gunakan salah satu: ${PRODUCTION_SHIFT_VALUES.join(", ")}.`,
      400,
    );
  }
  return normalized;
}

function toDateTime(value, baseDate = new Date()) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string" && /^\d{2}:\d{2}(:\d{2})?$/.test(value)) {
    const [hours, minutes, seconds = "0"] = value.split(":");
    const date = new Date(baseDate);
    date.setHours(Number(hours), Number(minutes), Number(seconds), 0);
    return date;
  }
  return new Date(value);
}

function calculateDurationMinutes(startTime, endTime, baseDate = new Date()) {
  if (!startTime || !endTime) return null;
  const start = toDateTime(startTime, baseDate).getTime();
  const end = toDateTime(endTime, baseDate).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round(((end - start) / 60000) * 100) / 100;
}

function httpError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function isWorkOrderStartableStatus(status) {
  return WORK_ORDER_STARTABLE_STATUSES.includes(status);
}

function isWorkOrderProductionStatus(status) {
  return WORK_ORDER_PRODUCTION_STATUSES.includes(status);
}

async function generateDailyNumber(db, modelName, fieldName, prefix) {
  const ruleKey = prefix === "MO" ? "MANUFACTURING_ORDER" : prefix === "WO" ? "WORK_ORDER" : "GENERIC_DOCUMENT";
  return generateConfiguredNumber(ruleKey, { db, context: { prefix }, fallback: async () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const datePrefix = `${prefix}-${y}${m}${d}`;

  const last = await db[modelName].findFirst({
    where: { [fieldName]: { startsWith: datePrefix } },
    orderBy: { [fieldName]: "desc" },
    select: { [fieldName]: true },
  });

  let seq = 1;
  if (last?.[fieldName]) {
    const parts = last[fieldName].split("-");
    seq = parseInt(parts[parts.length - 1], 10) + 1;
  }

  return `${datePrefix}-${String(seq).padStart(3, "0")}`;
  } });
}

async function findManufacturingOrderByNumber(tx, moNumber) {
  if (!moNumber) return null;
  const mo = await tx.manufacturingOrder.findFirst({
    where: { moNumber, isDeleted: false },
    select: { id: true, moNumber: true },
  });
  if (!mo) throw httpError("Manufacturing Order tidak ditemukan.", 404);
  return mo;
}

async function findWorkOrder(tx, { woId, woNumber } = {}) {
  if (!woId && !woNumber) return null;
  const where = woNumber ? { woNumber, isDeleted: false } : { id: woId, isDeleted: false };
  const wo = await tx.workOrder.findFirst({
    where,
    include: {
      machine: { select: { machineCode: true } },
      manufacturingOrder: { select: { id: true, moNumber: true } },
    },
  });
  if (!wo) throw httpError("Work Order tidak ditemukan.", 404);
  return wo;
}

async function resolveProductionRefs(tx, data = {}, options = {}) {
  const normalized = { ...data };
  const wo = await findWorkOrder(tx, {
    woId: normalized.woId,
    woNumber: normalized.woNumber,
  });

  if (wo) {
    if (options.requireWorkOrderInProgress && !isWorkOrderProductionStatus(wo.status)) {
      throw httpError(
        `Production Log hanya bisa dibuat untuk WO In Production. Status WO sekarang "${wo.status}".`,
        409,
      );
    }
    if (normalized.moNumber && wo.manufacturingOrder?.moNumber !== normalized.moNumber) {
      throw httpError(
        `WO ${wo.woNumber || normalized.woId} tidak terkait dengan MO ${normalized.moNumber}.`,
        400,
      );
    }

    normalized.woId = wo.id;
    normalized.moId = wo.moId;
    normalized.shift = wo.shift || normalized.shift || (options.defaultShiftFromWorkOrder ? "1A" : null);
    normalized.machineCode = wo.machine?.machineCode || normalized.machineCode || null;
    normalized.operatorName = wo.operatorName || normalized.operatorName || null;

    if (options.copyPlannedQty) normalized.qtyPlanned = wo.plannedQty ?? 0;
  }

  if (!normalized.moId && normalized.moNumber) {
    const mo = await findManufacturingOrderByNumber(tx, normalized.moNumber);
    normalized.moId = mo.id;
  }

  delete normalized.moNumber;
  delete normalized.woNumber;
  return normalized;
}

module.exports = {
  LEGACY_WORK_ORDER_STATUSES,
  PRODUCTION_SHIFT_VALUES,
  WORK_ORDER_STATUSES,
  assertProductionShift,
  calculateDurationMinutes,
  generateDailyNumber,
  httpError,
  isWorkOrderProductionStatus,
  isWorkOrderStartableStatus,
  normalizeShift,
  resolveProductionRefs,
  toDateTime,
  toNumber,
};
