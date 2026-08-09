const DAY_MS = 24 * 60 * 60 * 1000;

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

function dateOnly(value) {
  const parsed = value instanceof Date ? new Date(value) : new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function minuteOfDay(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return minute >= 0 && minute <= 1440 ? minute : null;
}

function plannedInterval(scheduleDate, startTime, endTime) {
  const day = dateOnly(scheduleDate);
  const startMinute = minuteOfDay(startTime);
  const endMinute = minuteOfDay(endTime);
  if (!day || startMinute == null || endMinute == null) return null;
  const start = day.getTime() + startMinute * 60000;
  let end = day.getTime() + endMinute * 60000;
  if (end <= start) end += DAY_MS;
  return { start, end };
}

function intervalsOverlap(left, right) {
  return Boolean(left && right && left.start < right.end && right.start < left.end);
}

function isPressResource(machine, route) {
  if (route?.diesId) return true;
  const values = [
    machine?.machineType,
    machine?.machineFamily,
    machine?.machineTechnology,
    machine?.machineSpecificationCode,
    machine?.machineSpecificationName,
    route?.process?.processCode,
    route?.process?.processName,
  ].filter(Boolean).join(" ").toUpperCase();
  return /(^|[^A-Z])(PRESS|STAMPING|STAMP)([^A-Z]|$)/.test(values);
}

function isDiesTonnageCompatible(dies, machine) {
  return number(dies?.tonnage) <= 0 || number(machine?.tonnage) >= number(dies.tonnage);
}

function maintenanceInterval(maintenance) {
  const startDay = dateOnly(maintenance.startDate || maintenance.maintenanceDate);
  const endDay = dateOnly(maintenance.endDate || maintenance.startDate || maintenance.maintenanceDate);
  if (!startDay || !endDay) return null;
  return { start: startDay.getTime(), end: endDay.getTime() + DAY_MS };
}

function planningError(message, code, details = {}) {
  return Object.assign(new Error(message), { statusCode: 409, code, details });
}

function isDiesCapacityBlockingEnabled() {
  return String(process.env.DIES_CAPACITY_BLOCKING_ENABLED || "false").trim().toLowerCase() === "true";
}

async function resolveDiesAssignment(prisma, {
  route,
  machine,
  diesId,
  scheduleDate,
  plannedStartTime,
  plannedEndTime,
  excludeAllocationId = null,
  excludeScheduleId = null,
  checkConflicts = true,
}) {
  const requiresDies = isDiesCapacityBlockingEnabled() && isPressResource(machine, route);
  let resolvedDiesId = diesId || route?.diesId || null;
  if (!resolvedDiesId && route?.mbomDetail?.partId) {
    const mapping = await prisma.diesPart.findFirst({
      where: {
        partId: route.mbomDetail.partId,
        isActive: true,
        effectiveDate: { lte: dateOnly(scheduleDate) || new Date() },
        OR: [{ expiryDate: null }, { expiryDate: { gte: dateOnly(scheduleDate) || new Date() } }],
        dies: { isDeleted: false, status: "Active" },
      },
      orderBy: [{ isPrimary: "desc" }, { effectiveDate: "desc" }],
      select: { diesId: true },
    });
    resolvedDiesId = mapping?.diesId || null;
  }
  if (!resolvedDiesId) {
    if (requiresDies) throw planningError("Routing Press wajib memiliki Dies aktif sebelum dijadwalkan.", "PLAN_DIES_REQUIRED");
    return { dies: null, requiresDies: false };
  }

  const dies = await prisma.dies.findFirst({
    where: { id: resolvedDiesId, isDeleted: false },
    include: {
      diesParts: { where: { isActive: true }, select: { partId: true, effectiveDate: true, expiryDate: true, isPrimary: true, expectedOutput: true } },
      maintenances: { where: { isDeleted: false }, select: { maintenanceNumber: true, maintenanceDate: true, startDate: true, endDate: true } },
    },
  });
  if (!dies || dies.status !== "Active") {
    throw planningError("Dies tidak aktif atau tidak ditemukan.", "PLAN_DIES_INACTIVE", { diesId: resolvedDiesId });
  }
  if (!isDiesTonnageCompatible(dies, machine)) {
    throw planningError(
      `Tonnage mesin ${number(machine?.tonnage)}T tidak mencukupi kebutuhan Dies ${dies.diesCode} (${number(dies.tonnage)}T).`,
      "PLAN_DIES_MACHINE_TONNAGE_MISMATCH",
      { diesId: dies.id, machineId: machine?.id || null },
    );
  }
  if (!route?.diesId && route?.mbomDetail?.partId) {
    const scheduleDay = dateOnly(scheduleDate) || new Date();
    const compatiblePart = dies.diesParts.some((mapping) => mapping.partId === route.mbomDetail.partId
      && mapping.effectiveDate <= scheduleDay
      && (!mapping.expiryDate || mapping.expiryDate >= scheduleDay));
    if (!compatiblePart) {
      throw planningError(`Dies ${dies.diesCode} tidak terdaftar aktif untuk part routing ini.`, "PLAN_DIES_PART_MISMATCH", { diesId: dies.id });
    }
  }

  const interval = plannedInterval(scheduleDate, plannedStartTime, plannedEndTime);
  if (requiresDies && !interval) {
    throw planningError("Jam mulai dan selesai wajib diisi untuk allocation Press agar kapasitas Dies dapat dikunci.", "PLAN_DIES_TIME_REQUIRED");
  }
  if (!interval || !checkConflicts) return { dies, requiresDies };

  const maintenance = dies.maintenances.find((row) => intervalsOverlap(interval, maintenanceInterval(row)));
  if (maintenance) {
    throw planningError(`Dies ${dies.diesCode} sedang maintenance pada waktu yang dipilih.`, "PLAN_DIES_MAINTENANCE_OVERLAP", { maintenanceNumber: maintenance.maintenanceNumber });
  }

  const intervalStart = new Date(interval.start - DAY_MS);
  const intervalEnd = new Date(interval.end + DAY_MS);
  const [allocations, schedules] = await Promise.all([
    prisma.productionPlanAllocation.findMany({
      where: {
        diesId: dies.id,
        isDeleted: false,
        status: { in: ["Draft", "Published"] },
        scheduleDate: { gte: intervalStart, lte: intervalEnd },
        ...(excludeAllocationId ? { id: { not: excludeAllocationId } } : {}),
      },
      select: { id: true, scheduleDate: true, plannedStartTime: true, plannedEndTime: true, plan: { select: { planNumber: true } } },
    }),
    prisma.dailyProductionSchedule.findMany({
      where: {
        diesId: dies.id,
        isDeleted: false,
        status: { in: ["Draft", "Released", "In Progress"] },
        scheduleDate: { gte: intervalStart, lte: intervalEnd },
        ...(excludeScheduleId ? { id: { not: excludeScheduleId } } : {}),
        ...(excludeAllocationId ? { OR: [{ productionPlanAllocationId: null }, { productionPlanAllocationId: { not: excludeAllocationId } }] } : {}),
      },
      select: { id: true, scheduleNumber: true, scheduleDate: true, plannedStartTime: true, plannedEndTime: true },
    }),
  ]);
  const allocationConflict = allocations.find((row) => intervalsOverlap(interval, plannedInterval(row.scheduleDate, row.plannedStartTime, row.plannedEndTime)));
  if (allocationConflict) {
    throw planningError(`Dies ${dies.diesCode} sudah dipakai oleh ${allocationConflict.plan.planNumber} pada waktu yang sama.`, "PLAN_DIES_TIME_OVERLAP", { relatedAllocationId: allocationConflict.id });
  }
  const scheduleConflict = schedules.find((row) => intervalsOverlap(interval, plannedInterval(row.scheduleDate, row.plannedStartTime, row.plannedEndTime)));
  if (scheduleConflict) {
    throw planningError(`Dies ${dies.diesCode} sudah dipakai oleh ${scheduleConflict.scheduleNumber} pada waktu yang sama.`, "PLAN_DIES_TIME_OVERLAP", { relatedScheduleId: scheduleConflict.id });
  }
  return { dies, requiresDies };
}

module.exports = {
  intervalsOverlap,
  isDiesCapacityBlockingEnabled,
  isDiesTonnageCompatible,
  isPressResource,
  maintenanceInterval,
  plannedInterval,
  resolveDiesAssignment,
};
