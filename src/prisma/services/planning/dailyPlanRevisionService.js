const { prisma } = require("../../index");
const { validateScheduleItems, summarizeRevision, buildExecutionExceptions } = require("./dailyPlanRevisionDomain");
const { createProductionShortfallCarryover } = require("./productionShortfallCarryoverService");
const { autoCorrectWorkPlacements } = require("./dailyReleaseSchedulingService");
const { ensureMaterialIssueDraft } = require("../../controllers/production/DailyProductionScheduleController");

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw Object.assign(new Error("Tanggal Daily Plan tidak valid."), { statusCode: 400 });
  return date.toISOString().slice(0, 10);
}

function dayRange(value) {
  const key = dateKey(value);
  return {
    key,
    start: new Date(`${key}T00:00:00.000Z`),
    end: new Date(`${key}T23:59:59.999Z`),
  };
}

function monthKey(value) {
  return dateKey(value).slice(0, 7);
}

function productionHandoffView({ plan, moCount = 0, upcomingRevision, upcomingSchedule } = {}) {
  if (upcomingSchedule) {
    const nextDate = dateKey(upcomingSchedule.scheduleDate);
    return {
      code: "DAILY_SCHEDULE_AVAILABLE",
      title: `${upcomingSchedule.scheduleNumber} sudah tersedia`,
      message: `Schedule ${upcomingSchedule.status} berada pada ${nextDate}. Buka detail schedule untuk melihat mesin, proses, qty, dan planning trace.`,
      actionLabel: `Buka ${upcomingSchedule.scheduleNumber}`,
      actionUrl: `/modules/production/daily-production-schedules/${encodeURIComponent(upcomingSchedule.scheduleNumber)}`,
      nextDate,
      scheduleNumber: upcomingSchedule.scheduleNumber,
      scheduleStatus: upcomingSchedule.status,
      planNumber: upcomingSchedule.mppNumber || null,
    };
  }
  if (upcomingRevision) {
    const nextDate = dateKey(upcomingRevision.planDate);
    const released = upcomingRevision.status === "Released";
    return {
      code: released ? "RELEASED_ON_OTHER_DATE" : "DAILY_REVISION_PENDING_RELEASE",
      title: released ? `Jadwal Released tersedia ${nextDate}` : `Daily Plan ${upcomingRevision.status} belum masuk Production`,
      message: released
        ? "Tanggal yang sedang dibuka tidak memiliki jadwal. Buka tanggal Released terdekat."
        : "PPIC sudah membentuk Daily Plan, tetapi revision masih harus divalidasi dan direlease.",
      actionLabel: released ? "Buka Jadwal Released" : "Review & Release Daily Plan",
      actionUrl: released
        ? `/modules/production/daily-production-schedules?date=${encodeURIComponent(nextDate)}`
        : `/modules/planning-ppic/daily-production-plans?date=${encodeURIComponent(nextDate)}`,
      nextDate,
      revisionNumber: upcomingRevision.revisionNumber,
      revisionStatus: upcomingRevision.status,
      planNumber: upcomingRevision.sourcePlanNumber || null,
    };
  }
  if (!plan) {
    return {
      code: "NO_SOURCE_PLAN",
      title: "Belum ada plan yang siap diturunkan",
      message: "Production hanya menerima Daily Plan Released. Periksa Monthly Production Plan dan pilih periode yang akan dieksekusi.",
      actionLabel: "Buka Monthly Production Plan",
      actionUrl: "/modules/planning-ppic/monthly-production-plans",
    };
  }

  const planMonth = monthKey(plan.periodStart);
  const planUrl = `/modules/planning-ppic/monthly-production-plans?month=${encodeURIComponent(planMonth)}&planNumber=${encodeURIComponent(plan.planNumber)}`;
  let code = "PUBLISH_DAILY_PLAN";
  let title = "Allocation belum dipublish ke Daily Plan";
  let message = "Monthly Plan sudah mempunyai MO, tetapi Daily Plan per tanggal belum dibentuk.";
  let actionLabel = "Publish Daily Plan";
  if (plan.status === "Draft") {
    code = "CONFIRM_MONTHLY_PLAN";
    title = "Monthly Plan masih Draft";
    message = "Review allocation lalu Confirm Monthly Plan sebelum handoff berikutnya.";
    actionLabel = "Review & Confirm Plan";
  } else if (plan.status === "Confirmed") {
    code = "RELEASE_MONTHLY_PLAN";
    title = "Monthly Plan baru Confirmed";
    message = "Capacity sudah direview, tetapi plan belum Released sehingga MO dan Daily Plan belum dapat dibuat.";
    actionLabel = "Release Monthly Plan";
  } else if (["Released", "In Progress"].includes(plan.status) && moCount <= 0) {
    code = "CREATE_MO_REFERENCE";
    title = "MO reference belum dibuat";
    message = "Monthly Plan sudah Released. Bentuk MO reference sebelum allocation dipublish menjadi Daily Plan.";
    actionLabel = "Buat MO Reference";
  }
  return {
    code,
    title,
    message,
    actionLabel,
    actionUrl: planUrl,
    planNumber: plan.planNumber,
    planStatus: plan.status,
    planMonth,
    allocationCount: Number(plan._count?.manualAllocations || 0),
    dailyScheduleCount: Number(plan._count?.dailyProductionSchedules || 0),
    moCount: Number(moCount || 0),
  };
}

async function getProductionHandoff(client, range) {
  const windowEnd = new Date(range.start);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 62);
  const [upcomingSchedule, upcomingRevision, plan] = await Promise.all([
    client.dailyProductionSchedule.findFirst({
      where: { scheduleDate: { gte: range.start, lte: windowEnd }, status: { in: ["Released", "In Progress", "Completed"] }, shift: { not: "VENDOR" }, isDeleted: false },
      orderBy: [{ scheduleDate: "asc" }, { sequence: "asc" }, { scheduleNumber: "asc" }],
      select: { scheduleNumber: true, scheduleDate: true, status: true, mppNumber: true },
    }),
    client.dailyPlanRevision.findFirst({
      where: { planDate: { gte: range.start, lte: windowEnd }, status: { in: ["Draft", "Ready", "Released"] }, isDeleted: false, schedules: { some: { isDeleted: false } } },
      orderBy: [{ planDate: "asc" }, { version: "desc" }],
      select: { revisionNumber: true, planDate: true, status: true, sourcePlanNumber: true },
    }),
    client.monthlyProductionPlan.findFirst({
      where: { periodEnd: { gte: range.start }, periodStart: { lte: windowEnd }, status: { in: ["Draft", "Confirmed", "Released", "In Progress"] }, isDeleted: false },
      orderBy: [{ periodStart: "asc" }, { createdAt: "desc" }],
      select: { planNumber: true, status: true, periodStart: true, periodEnd: true, _count: { select: { manualAllocations: true, dailyProductionSchedules: true } } },
    }),
  ]);
  const moCount = plan ? await client.manufacturingOrder.count({ where: { monthlyProductionPlanNumber: plan.planNumber, isDeleted: false, status: { not: "Cancelled" } } }) : 0;
  return productionHandoffView({ plan, moCount, upcomingRevision, upcomingSchedule });
}

function buildRevisionNumber(value, sequence) {
  return `DPR-${dateKey(value).replace(/-/g, "")}-R${String(sequence).padStart(3, "0")}`;
}

const SCHEDULE_COPY_FIELDS = [
  "scheduleDate", "shift", "plannedStartTime", "plannedEndTime", "moId", "moNumber", "woId", "woNumber",
  "partId", "partCode", "processId", "machineId", "diesId", "productionPlanId", "productionPlanAllocationId",
  "mbomProcessId", "plannedQty", "uomCode", "operatorName", "sequence", "schedulePriority", "deliveryPhaseId",
  "deliveryPhaseNumber", "transferBatchNumber", "predecessorAllocationIds", "demandSourceType", "demandSourceNumber",
  "customerCode", "customerTargetDate", "fgRequiredDate", "priorityScore", "priorityClass", "materialReadinessStatus",
  "predecessorStatus", "vendorStatus", "lateRisk", "mrpRunNumber", "mpsNumber", "mppNumber", "manualException",
  "manualExceptionReason", "notes", "createdBy", "vendorId",
];

function copyScheduleData(schedule, { revisionId, revisionSequence }) {
  const data = {};
  SCHEDULE_COPY_FIELDS.forEach((field) => {
    if (schedule[field] !== undefined) data[field] = schedule[field];
  });
  data.scheduleNumber = `${schedule.scheduleNumber}-R${String(revisionSequence).padStart(3, "0")}`;
  data.dailyPlanRevisionId = revisionId;
  data.status = "Draft";
  data.actualQty = 0;
  data.isDeleted = false;
  return data;
}

async function hydrateSchedules(client, schedules = []) {
  const machineIds = [...new Set(schedules.map((item) => item.machineId).filter(Boolean))];
  const processIds = [...new Set(schedules.map((item) => item.processId).filter(Boolean))];
  const partCodes = [...new Set(schedules.map((item) => item.partCode).filter(Boolean))];
  const moIds = [...new Set(schedules.map((item) => item.moId).filter(Boolean))];
  const moNumbers = [...new Set(schedules.filter((item) => !item.moId).map((item) => item.moNumber).filter(Boolean))];
  const [machines, processes, parts, manufacturingOrders] = await Promise.all([
    machineIds.length ? client.machine.findMany({ where: { id: { in: machineIds }, isDeleted: false }, select: { id: true, machineCode: true, machineName: true, lineCode: true, location: true } }) : [],
    processIds.length ? client.process.findMany({ where: { id: { in: processIds }, isDeleted: false }, select: { id: true, processCode: true, processName: true } }) : [],
    partCodes.length ? client.part.findMany({ where: { partCode: { in: partCodes }, isDeleted: false }, select: { partCode: true, partNumber: true, partName: true } }) : [],
    moIds.length || moNumbers.length ? client.manufacturingOrder.findMany({
      where: { isDeleted: false, OR: [...(moIds.length ? [{ id: { in: moIds } }] : []), ...(moNumbers.length ? [{ moNumber: { in: moNumbers } }] : [])] },
      select: { id: true, moNumber: true, part: { select: { partCode: true, partNumber: true, partName: true } } },
    }) : [],
  ]);
  const machineById = new Map(machines.map((row) => [row.id, row]));
  const processById = new Map(processes.map((row) => [row.id, row]));
  const partByCode = new Map(parts.map((row) => [row.partCode, row]));
  const moById = new Map(manufacturingOrders.map((row) => [row.id, row]));
  const moByNumber = new Map(manufacturingOrders.map((row) => [row.moNumber, row]));
  return schedules.map((item) => ({
    ...item,
    machineCode: machineById.get(item.machineId)?.machineCode || null,
    machineName: machineById.get(item.machineId)?.machineName || null,
    lineCode: machineById.get(item.machineId)?.lineCode || null,
    machineLocation: machineById.get(item.machineId)?.location || null,
    processCode: processById.get(item.processId)?.processCode || null,
    processName: processById.get(item.processId)?.processName || null,
    partNumber: partByCode.get(item.partCode)?.partNumber || null,
    partName: partByCode.get(item.partCode)?.partName || null,
    fgParentCode: (moById.get(item.moId) || moByNumber.get(item.moNumber))?.part?.partCode || null,
    fgParentNumber: (moById.get(item.moId) || moByNumber.get(item.moNumber))?.part?.partNumber || null,
    fgParentName: (moById.get(item.moId) || moByNumber.get(item.moNumber))?.part?.partName || null,
  }));
}

async function getWorkspace({ date, revisionId, mode } = {}, client = prisma) {
  const range = dayRange(date || new Date());
  const productionMode = String(mode || "").toUpperCase() === "PRODUCTION";
  const executionStatuses = ["Released", "In Progress", "Completed"];
  const revisions = await client.dailyPlanRevision.findMany({
    where: {
      isDeleted: false,
      ...(revisionId
        ? { id: revisionId }
        : productionMode
          ? { planDate: { gte: range.start, lte: range.end }, schedules: { some: { isDeleted: false, status: { in: executionStatuses } } } }
          : { planDate: { gte: range.start, lte: range.end }, status: { not: "Superseded" } }),
    },
    orderBy: [{ version: "desc" }, { createdAt: "desc" }],
    include: {
      schedules: {
        where: { isDeleted: false, ...(productionMode ? { status: { in: executionStatuses } } : {}) },
        include: {
          productionLogs: {
            where: { isDeleted: false },
            select: { id: true, logNumber: true, status: true, qtyPlanned: true, qtyProduced: true, qtyGood: true, qtyReject: true, qtyRework: true, startTime: true, endTime: true, downtime: true, ngReasons: { where: { isDeleted: false }, select: { status: true, qtyNg: true, qtyRework: true, qtyReject: true } }, carryover: true },
          },
        },
        orderBy: [{ machineId: "asc" }, { plannedStartTime: "asc" }, { sequence: "asc" }],
      },
    },
  });
  const revision = revisionId || productionMode
    ? revisions[0]
    : revisions.find((row) => ["Draft", "Ready", "Partially Released"].includes(row.status)) || revisions.find((row) => row.status === "Released") || revisions[0];
  const legacy = revision ? [] : await client.dailyProductionSchedule.findMany({
    where: { scheduleDate: { gte: range.start, lte: range.end }, isDeleted: false, productionPlanId: { not: null }, shift: { not: "VENDOR" }, ...(productionMode ? { status: { in: executionStatuses } } : {}) },
    include: { productionLogs: { where: { isDeleted: false }, select: { id: true, logNumber: true, status: true, qtyPlanned: true, qtyProduced: true, qtyGood: true, qtyReject: true, qtyRework: true, startTime: true, endTime: true, downtime: true, ngReasons: { where: { isDeleted: false }, select: { status: true, qtyNg: true, qtyRework: true, qtyReject: true } }, carryover: true } } },
    orderBy: [{ machineId: "asc" }, { plannedStartTime: "asc" }, { sequence: "asc" }],
  });
  let sourceSchedules = revision?.schedules || legacy;
  let allocationPreview = false;
  if (!sourceSchedules.length && !productionMode) {
    const allocations = await client.productionPlanAllocation.findMany({
      where: { scheduleDate: { gte: range.start, lte: range.end }, isDeleted: false, planningMode: "PRODUCTION", status: { in: ["Draft", "Published"] }, routingMode: "INHOUSE" },
      include: {
        plan: { select: { id: true, planNumber: true, status: true } },
        mbomProcess: { select: { processId: true, sequence: true, process: { select: { processCode: true, processName: true } }, mbomDetail: { select: { partId: true, part: { select: { partCode: true, partNumber: true, partName: true } } } } } },
        machine: { select: { id: true, machineCode: true, machineName: true, lineCode: true } },
      },
      orderBy: [{ machineId: "asc" }, { plannedStartTime: "asc" }, { lineNumber: "asc" }],
    });
    sourceSchedules = allocations.map((row) => ({
      id: row.id,
      scheduleNumber: `ALLOC-${row.id.slice(0, 8).toUpperCase()}`,
      scheduleDate: row.scheduleDate,
      shift: row.shift,
      plannedStartTime: row.plannedStartTime,
      plannedEndTime: row.plannedEndTime,
      partId: row.mbomProcess?.mbomDetail?.partId || null,
      partCode: row.mbomProcess?.mbomDetail?.part?.partCode || null,
      partNumber: row.mbomProcess?.mbomDetail?.part?.partNumber || null,
      partName: row.mbomProcess?.mbomDetail?.part?.partName || null,
      processId: row.mbomProcess?.processId || null,
      processCode: row.mbomProcess?.process?.processCode || null,
      processName: row.mbomProcess?.process?.processName || null,
      machineId: row.machineId,
      diesId: row.diesId,
      machineCode: row.machine?.machineCode || null,
      machineName: row.machine?.machineName || null,
      lineCode: row.machine?.lineCode || null,
      productionPlanId: row.planId,
      productionPlanAllocationId: row.id,
      plannedQty: row.plannedQty,
      actualQty: 0,
      uomCode: row.uomCode,
      sequence: row.mbomProcess?.sequence || row.lineNumber,
      fgRequiredDate: row.fgRequiredDate,
      status: "Preview",
      sourceAllocationStatus: row.status,
      sourceAllocationEditable: row.status === "Draft" && row.plan?.status === "Draft",
      routingMode: row.routingMode,
      planningMode: row.planningMode,
      notes: row.notes,
      productionLogs: [],
      sourceAllocationPreview: true,
      monthlyProductionPlanNumber: row.plan?.planNumber || null,
      monthlyProductionPlanStatus: row.plan?.status || null,
    }));
    allocationPreview = sourceSchedules.length > 0;
  }
  const schedules = allocationPreview ? sourceSchedules : await hydrateSchedules(client, sourceSchedules);
  const status = revision?.status || (schedules.length && schedules.every((row) => ["Released", "In Progress", "Completed"].includes(row.status)) ? "Released" : "Draft");
  const [exceptions, machineEvents, handoff] = await Promise.all([
    client.dailyPlanningException.findMany({ where: { planDate: { gte: range.start, lte: range.end }, isDeleted: false, state: { in: ["OPEN", "APPLIED"] } }, orderBy: [{ severity: "asc" }, { createdAt: "asc" }] }),
    client.machineAvailabilityEvent.findMany({ where: { startedAt: { lte: range.end }, OR: [{ endedAt: null }, { endedAt: { gte: range.start } }], isDeleted: false }, orderBy: { startedAt: "asc" } }),
    productionMode && !schedules.some((row) => ["Released", "In Progress", "Completed"].includes(row.status)) ? getProductionHandoff(client, range) : null,
  ]);
  const validation = validateScheduleItems(schedules);
  const revisionDoc = revision || { id: null, revisionNumber: null, planDate: range.start, version: 0, status, schedules };
  const derivedExceptions = buildExecutionExceptions(schedules);
  return { date: range.key, revision: { ...revisionDoc, schedules: undefined, ...summarizeRevision({ ...revisionDoc, status, schedules }), allocationPreview }, schedules, validation, exceptions: [...exceptions, ...derivedExceptions], machineEvents, handoff };
}

async function createDraft({ date, sourcePlanNumber, userId } = {}) {
  const range = dayRange(date);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.dailyPlanRevision.findFirst({ where: { planDate: { gte: range.start, lte: range.end }, status: { in: ["Draft", "Ready", "Partially Released"] }, isDeleted: false }, orderBy: { version: "desc" } });
    if (existing) {
      await tx.dailyProductionSchedule.updateMany({ where: { scheduleDate: { gte: range.start, lte: range.end }, productionPlanId: { not: null }, dailyPlanRevisionId: null, isDeleted: false }, data: { dailyPlanRevisionId: existing.id } });
      return existing;
    }
    const latest = await tx.dailyPlanRevision.findFirst({ where: { planDate: { gte: range.start, lte: range.end }, isDeleted: false }, orderBy: { version: "desc" } });
    const version = Number(latest?.version || 0) + 1;
    const revision = await tx.dailyPlanRevision.create({ data: { revisionNumber: buildRevisionNumber(range.key, version), planDate: range.start, version, status: "Draft", sourcePlanNumber: sourcePlanNumber || null, supersedesId: latest?.status === "Released" ? latest.id : null, preparedBy: userId || null, preparedAt: new Date() } });
    if (!latest) await tx.dailyProductionSchedule.updateMany({ where: { scheduleDate: { gte: range.start, lte: range.end }, productionPlanId: { not: null }, dailyPlanRevisionId: null, isDeleted: false }, data: { dailyPlanRevisionId: revision.id } });
    if (latest?.status === "Released") {
      const schedules = await tx.dailyProductionSchedule.findMany({ where: { dailyPlanRevisionId: latest.id, isDeleted: false } });
      for (const schedule of schedules) await tx.dailyProductionSchedule.create({ data: copyScheduleData(schedule, { revisionId: revision.id, revisionSequence: version }) });
    }
    return revision;
  });
}

async function updateItem({ revisionId, scheduleId, expectedVersion, changes = {} }) {
  const allowed = ["machineId", "shift", "plannedStartTime", "plannedEndTime", "plannedQty", "sequence", "operatorName", "notes"];
  return prisma.$transaction(async (tx) => {
    const revision = await tx.dailyPlanRevision.findUnique({ where: { id: revisionId } });
    if (!revision || revision.isDeleted) throw Object.assign(new Error("Revision Daily Plan tidak ditemukan."), { statusCode: 404 });
    if (!["Draft", "Ready", "Partially Released"].includes(revision.status)) throw Object.assign(new Error("Revision Released tidak dapat diubah; buat revision baru."), { statusCode: 409, code: "DAILY_PLAN_IMMUTABLE" });
    if (expectedVersion != null && Number(expectedVersion) !== revision.version) throw Object.assign(new Error("Daily Plan telah berubah. Muat ulang revision terbaru."), { statusCode: 409, code: "REVISION_VERSION_CONFLICT" });
    const existingSchedule = await tx.dailyProductionSchedule.findFirst({ where: { id: scheduleId, dailyPlanRevisionId: revisionId, isDeleted: false } });
    if (!existingSchedule) throw Object.assign(new Error("Operation Daily Plan tidak ditemukan."), { statusCode: 404 });
    if (existingSchedule.status !== "Draft") throw Object.assign(new Error("Operation yang sudah direlease tidak dapat diubah."), { statusCode: 409, code: "DAILY_PLAN_ITEM_IMMUTABLE" });
    const data = Object.fromEntries(allowed.filter((key) => changes[key] !== undefined).map((key) => [key, changes[key]]));
    const schedule = await tx.dailyProductionSchedule.update({ where: { id: scheduleId }, data });
    const releasedCount = await tx.dailyProductionSchedule.count({ where: { dailyPlanRevisionId: revisionId, isDeleted: false, status: { in: ["Released", "In Progress", "Completed"] } } });
    await tx.dailyPlanRevision.update({ where: { id: revisionId }, data: { version: { increment: 1 }, validationSummary: null, status: releasedCount ? "Partially Released" : "Draft" } });
    return schedule;
  });
}

async function validateRevision(revisionId) {
  const revision = await prisma.dailyPlanRevision.findUnique({ where: { id: revisionId }, include: { schedules: { where: { isDeleted: false } } } });
  if (!revision || revision.isDeleted) throw Object.assign(new Error("Revision Daily Plan tidak ditemukan."), { statusCode: 404 });
  const validation = validateScheduleItems(revision.schedules);
  const releasedCount = revision.schedules.filter((item) => ["Released", "In Progress", "Completed"].includes(item.status)).length;
  await prisma.dailyPlanRevision.update({ where: { id: revisionId }, data: { validationSummary: validation, status: releasedCount ? "Partially Released" : validation.blockers.length ? "Draft" : "Ready" } });
  return validation;
}

function placementHorizon(value, days = 31) {
  const range = dayRange(value);
  const end = new Date(range.end);
  end.setUTCDate(end.getUTCDate() + Math.max(Number(days) || 0, 0));
  return { ...range, end };
}

async function autoCorrectPlacement({ date, revisionId, expectedVersion, userId } = {}) {
  const range = dayRange(date || new Date());
  const revision = revisionId
    ? await prisma.dailyPlanRevision.findFirst({ where: { id: revisionId, isDeleted: false }, include: { schedules: { where: { isDeleted: false }, orderBy: [{ machineId: "asc" }, { plannedStartTime: "asc" }, { sequence: "asc" }] } } })
    : await prisma.dailyPlanRevision.findFirst({ where: { planDate: { gte: range.start, lte: range.end }, status: { in: ["Draft", "Ready", "Partially Released"] }, isDeleted: false }, orderBy: { version: "desc" }, include: { schedules: { where: { isDeleted: false }, orderBy: [{ machineId: "asc" }, { plannedStartTime: "asc" }, { sequence: "asc" }] } } });

  if (revision) {
    if (!["Draft", "Ready", "Partially Released"].includes(revision.status)) throw Object.assign(new Error("Daily Plan Released tidak dapat dikoreksi otomatis."), { statusCode: 409, code: "DAILY_PLAN_IMMUTABLE" });
    if (expectedVersion != null && Number(expectedVersion) !== revision.version) throw Object.assign(new Error("Daily Plan telah berubah. Muat ulang sebelum Auto Correct."), { statusCode: 409, code: "REVISION_VERSION_CONFLICT" });
    // Auto Correct must be able to roll long operations into the following
    // working day. Limiting work windows to the selected date leaves valid
    // successors in their old (and dependency-invalid) positions.
    const windowsByMachine = await placementWindowsByMachine(prisma, placementHorizon(range.start), revision.schedules);
    const result = await autoCorrectWorkPlacements(revision.schedules.map((item) => ({ ...item, movable: item.status === "Draft" })), { prisma, windowsByMachine, dayStart: "07:00", dependencyGapMinutes: 120, referenceType: "DAILY_PLAN_REVISION", referenceNumber: revision.revisionNumber || revision.id, actor: userId });
    if (!result.changes.length) return { scope: "DAILY_REVISION", changedCount: 0, warnings: result.warnings, revisionId: revision.id };
    const correctedById = new Map(result.items.map((item) => [item.id, item]));
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.dailyPlanRevision.findUnique({ where: { id: revision.id } });
      if (!current || current.version !== revision.version) throw Object.assign(new Error("Daily Plan telah berubah. Muat ulang sebelum Auto Correct."), { statusCode: 409, code: "REVISION_VERSION_CONFLICT" });
      for (const change of result.changes) {
        const corrected = correctedById.get(change.id);
        await tx.dailyProductionSchedule.updateMany({
          where: { id: change.id, dailyPlanRevisionId: revision.id, status: "Draft", isDeleted: false },
          data: { scheduleDate: corrected.scheduleDate, plannedStartTime: corrected.plannedStartTime, plannedEndTime: corrected.plannedEndTime, shift: corrected.shift, notes: [change.notes, `[AUTO-CORRECT:${userId || "system"}]`].filter(Boolean).join("; ") },
        });
      }
      return tx.dailyPlanRevision.update({ where: { id: revision.id }, data: { version: { increment: 1 }, validationSummary: null, status: revision.schedules.some((item) => ["Released", "In Progress", "Completed"].includes(item.status)) ? "Partially Released" : "Draft" } });
    });
    return { scope: "DAILY_REVISION", changedCount: result.changes.length, warnings: result.warnings, revisionId: revision.id, version: updated.version };
  }

  const horizon = placementHorizon(range.start);
  const legacySchedules = await prisma.dailyProductionSchedule.findMany({
    where: { scheduleDate: { gte: horizon.start, lte: horizon.end }, isDeleted: false, productionPlanId: { not: null }, shift: { not: "VENDOR" }, status: { in: ["Draft", "Released", "In Progress", "Completed"] } },
    orderBy: [{ machineId: "asc" }, { plannedStartTime: "asc" }, { sequence: "asc" }],
  });
  const currentLegacySchedules = legacySchedules.filter((item) => dateKey(item.scheduleDate) === range.key);
  if (currentLegacySchedules.length) {
    const windowsByMachine = await placementWindowsByMachine(prisma, horizon, legacySchedules);
    const result = await autoCorrectWorkPlacements(legacySchedules.map((item) => ({ ...item, movable: dateKey(item.scheduleDate) === range.key && item.status === "Draft" })), { prisma, windowsByMachine, dayStart: "07:00", dependencyGapMinutes: 120, referenceType: "LEGACY_DAILY_PLAN", referenceNumber: range.key, actor: userId });
    if (!result.changes.length) return { scope: "LEGACY_DAILY_PLAN", changedCount: 0, warnings: result.warnings };
    const correctedById = new Map(result.items.map((item) => [item.id, item]));
    await prisma.$transaction(async (tx) => {
      for (const change of result.changes) {
        const corrected = correctedById.get(change.id);
        await tx.dailyProductionSchedule.updateMany({
          where: { id: change.id, status: "Draft", isDeleted: false },
          data: { scheduleDate: corrected.scheduleDate, plannedStartTime: corrected.plannedStartTime, plannedEndTime: corrected.plannedEndTime, shift: corrected.shift, notes: [change.notes, `[AUTO-CORRECT:${userId || "system"}]`].filter(Boolean).join("; ") },
        });
      }
    });
    return { scope: "LEGACY_DAILY_PLAN", changedCount: result.changes.length, warnings: result.warnings };
  }

  const allocations = await prisma.productionPlanAllocation.findMany({
    where: { scheduleDate: { gte: range.start, lte: range.end }, isDeleted: false, planningMode: "PRODUCTION", routingMode: "INHOUSE", status: "Draft" },
    include: { plan: { select: { id: true, planNumber: true, status: true } }, mbomProcess: { select: { sequence: true, mbomDetail: { select: { part: { select: { partCode: true } } } } } } },
    orderBy: [{ machineId: "asc" }, { plannedStartTime: "asc" }, { lineNumber: "asc" }],
  });
  if (!allocations.length) throw Object.assign(new Error("Tidak ada allocation Draft yang dapat dikoreksi pada tanggal ini."), { statusCode: 404, code: "DAILY_PLACEMENT_NOT_FOUND" });
  const lockedPlan = allocations.find((item) => !["Draft", "Confirmed"].includes(item.plan?.status));
  if (lockedPlan) throw Object.assign(new Error(`${lockedPlan.plan?.planNumber || "Monthly Plan"} ${lockedPlan.plan?.status || "terkunci"}; placement tidak dapat diubah.`), { statusCode: 409, code: "MONTHLY_PLAN_IMMUTABLE" });
  const prepared = allocations.map((item) => ({
    ...item,
    partCode: item.mbomProcess?.mbomDetail?.part?.partCode || null,
    sequence: item.mbomProcess?.sequence || item.lineNumber,
    movable: true,
  }));
  const windowsByMachine = await placementWindowsByMachine(prisma, range, prepared);
  const result = await autoCorrectWorkPlacements(prepared, { prisma, windowsByMachine, dayStart: "07:00", dependencyGapMinutes: 120, referenceType: "MONTHLY_PLAN_ALLOCATION", referenceNumber: [...new Set(allocations.map((item) => item.plan.planNumber))].join(","), actor: userId });
  if (!result.changes.length) return { scope: "ALLOCATION_PREVIEW", changedCount: 0, warnings: result.warnings, planNumbers: [...new Set(allocations.map((item) => item.plan.planNumber))] };
  const correctedById = new Map(result.items.map((item) => [item.id, item]));
  await prisma.$transaction(async (tx) => {
    for (const change of result.changes) {
      const corrected = correctedById.get(change.id);
      await tx.productionPlanAllocation.updateMany({
        where: { id: change.id, status: "Draft", isDeleted: false },
        data: { scheduleDate: corrected.scheduleDate, plannedStartTime: corrected.plannedStartTime, plannedEndTime: corrected.plannedEndTime, shift: corrected.shift, allocationSource: "MANUAL", recommendationReason: `Placement dikoreksi otomatis dari Daily Plan oleh ${userId || "system"}.`, recommendationScore: null, recommendationScoreBreakdown: null },
      });
    }
  });
  return { scope: "ALLOCATION_PREVIEW", changedCount: result.changes.length, warnings: result.warnings, planNumbers: [...new Set(allocations.map((item) => item.plan.planNumber))] };
}

function placementWindowsForMachine(machine = {}, override = null, scheduleDate = new Date()) {
  if (["HOLIDAY", "CLOSED", "UNAVAILABLE", "OFF"].includes(String(override?.dayStatus || "WORKING").toUpperCase())) return [];
  const day = new Date(scheduleDate).getUTCDay() || 7;
  const profileRules = (machine.workingHourProfile?.rules || [])
    .filter((rule) => Number(rule.dayOfWeek) === day && rule.isEnabled !== false)
    .sort((left, right) => Number(left.shift?.sequence || 0) - Number(right.shift?.sequence || 0));
  const machineShifts = [1, 2, 3].map((shift) => ({ shift: String(shift), startTime: machine[`shift${shift}Start`], endTime: machine[`shift${shift}End`] })).filter((row) => row.startTime && row.endTime);
  const fallbackShifts = [
    { shift: "1", startTime: "08:00", endTime: "16:00" },
    { shift: "2", startTime: "16:00", endTime: "00:00" },
    { shift: "3", startTime: "00:00", endTime: "08:00" },
  ];
  const overrideShifts = Array.isArray(override?.shiftOverrides) ? override.shiftOverrides : [];
  const hasWorkingProfileRules = Boolean(machine.workingHourProfile?.rules?.length);
  if (!overrideShifts.length && hasWorkingProfileRules && !profileRules.length) return [];
  const usingFallback = !overrideShifts.length && !profileRules.length && !machineShifts.length;
  if (usingFallback && [6, 7].includes(day)) return [];
  const base = overrideShifts.length
    ? overrideShifts.map((row, index) => ({ ...row, shift: String(index + 1) }))
    : profileRules.length
      ? profileRules.map((rule, index) => ({ shift: String(index + 1), startTime: rule.startTime, endTime: rule.endTime }))
      : machineShifts.length ? machineShifts : fallbackShifts;
  const shiftCount = Math.min(Math.max(Number(override?.shiftsPerDay ?? (usingFallback ? 2 : base.length)) || 1, 1), 3);
  const windows = [];
  base.slice(0, shiftCount).forEach((row, index) => {
    const shift = String(row.shift || index + 1);
    if (row.overtimeBeforeStart && row.overtimeBeforeEnd) windows.push({ shift, startTime: row.overtimeBeforeStart, endTime: row.overtimeBeforeEnd });
    if (row.startTime && row.endTime) windows.push({ shift, startTime: row.startTime, endTime: row.endTime });
    if (row.overtimeAfterStart && row.overtimeAfterEnd) windows.push({ shift, startTime: row.overtimeAfterStart, endTime: row.overtimeAfterEnd });
  });
  if (override?.overtimeStart && override?.overtimeEnd) windows.push({ shift: String(shiftCount), startTime: override.overtimeStart, endTime: override.overtimeEnd });
  return windows.filter((row, index, rows) => rows.findIndex((candidate) => candidate.shift === row.shift && candidate.startTime === row.startTime && candidate.endTime === row.endTime) === index);
}

async function placementWindowsByMachine(client, range, items) {
  const machineIds = [...new Set(items.map((item) => item.machineId).filter(Boolean))];
  const planIds = [...new Set(items.map((item) => item.planId || item.productionPlanId).filter(Boolean))];
  const [machines, planOverrides, globalOverrides] = await Promise.all([
    machineIds.length ? client.machine.findMany({
      where: { id: { in: machineIds }, isDeleted: false },
      select: { id: true, shift1Start: true, shift1End: true, shift2Start: true, shift2End: true, shift3Start: true, shift3End: true, workingHourProfile: { select: { rules: { include: { shift: true } } } } },
    }) : [],
    planIds.length ? client.capacityDayOverride.findMany({ where: { planId: { in: planIds }, scheduleDate: { gte: range.start, lte: range.end }, isDeleted: false } }) : [],
    machineIds.length ? client.capacityCalendarOverride.findMany({ where: { machineId: { in: machineIds }, scheduleDate: { gte: range.start, lte: range.end }, isDeleted: false } }) : [],
  ]);
  const machineById = new Map(machines.map((row) => [row.id, row]));
  const globalByMachine = new Map(globalOverrides.map((row) => [`${dateKey(row.scheduleDate)}|${row.machineId}`, row]));
  const contextByMachine = new Map();
  items.forEach((item) => {
    if (!item.machineId || contextByMachine.has(item.machineId)) return;
    contextByMachine.set(item.machineId, { planId: item.planId || item.productionPlanId || null });
  });
  const windows = new Map();
  for (let cursor = new Date(range.start); cursor <= range.end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const scheduleDate = new Date(cursor);
    const scheduleKey = dateKey(scheduleDate);
    contextByMachine.forEach((context, machineId) => {
      const planOverride = planOverrides.find((row) => dateKey(row.scheduleDate) === scheduleKey && row.planId === context.planId && row.machineId === machineId)
        || planOverrides.find((row) => dateKey(row.scheduleDate) === scheduleKey && row.planId === context.planId && !row.machineId)
        || null;
      const key = `${scheduleKey}|${machineId}`;
      windows.set(key, placementWindowsForMachine(machineById.get(machineId), planOverride || globalByMachine.get(key), scheduleDate));
    });
  }
  return windows;
}

function validationForSchedule(schedule, schedules) {
  const fullValidation = validateScheduleItems(schedules);
  const belongsToSchedule = (issue) => issue.scheduleNumber === schedule.scheduleNumber || issue.conflictScheduleNumber === schedule.scheduleNumber;
  return {
    blockers: fullValidation.blockers.filter(belongsToSchedule),
    warnings: fullValidation.warnings.filter((issue) => issue.scheduleNumber === schedule.scheduleNumber),
  };
}

async function releaseSchedule({ revisionId, scheduleId, expectedVersion, warningReason, userId }) {
  return prisma.$transaction(async (tx) => {
    const revision = await tx.dailyPlanRevision.findUnique({ where: { id: revisionId }, include: { schedules: { where: { isDeleted: false } } } });
    if (!revision || revision.isDeleted) throw Object.assign(new Error("Revision Daily Plan tidak ditemukan."), { statusCode: 404 });
    if (!["Draft", "Ready", "Partially Released"].includes(revision.status)) throw Object.assign(new Error("Revision ini tidak menerima release operation baru."), { statusCode: 409 });
    if (expectedVersion != null && Number(expectedVersion) !== revision.version) throw Object.assign(new Error("Daily Plan telah berubah. Muat ulang sebelum release operation."), { statusCode: 409, code: "REVISION_VERSION_CONFLICT" });
    const schedule = revision.schedules.find((item) => item.id === scheduleId);
    if (!schedule) throw Object.assign(new Error("Operation Daily Plan tidak ditemukan."), { statusCode: 404 });
    if (schedule.status !== "Draft") throw Object.assign(new Error("Operation ini sudah direlease ke Production."), { statusCode: 409, code: "DAILY_PLAN_ITEM_ALREADY_RELEASED" });
    const validation = validationForSchedule(schedule, revision.schedules);
    if (validation.blockers.length) throw Object.assign(new Error("Operation masih memiliki blocker."), { statusCode: 409, code: "DAILY_PLAN_ITEM_VALIDATION_BLOCKED", validation });
    if (validation.warnings.length && !String(warningReason || "").trim()) throw Object.assign(new Error("Alasan acknowledgement wajib diisi untuk warning operation ini."), { statusCode: 400, code: "WARNING_REASON_REQUIRED", validation });

    await tx.dailyPlanRevision.updateMany({ where: { planDate: revision.planDate, status: "Released", isDeleted: false, id: { not: revision.id } }, data: { status: "Superseded" } });
    const releasedSchedule = await tx.dailyProductionSchedule.update({ where: { id: schedule.id }, data: { status: "Released" } });
    if (releasedSchedule.woId) {
      await tx.workOrder.updateMany({
        where: { id: releasedSchedule.woId, isDeleted: false, status: { in: ["Draft", "Planned"] } },
        data: { status: "Released" },
      });
      await ensureMaterialIssueDraft(tx, releasedSchedule, userId || "system", { allowShortage: true });
    }
    const remainingCount = revision.schedules.filter((item) => item.id !== schedule.id && item.status === "Draft").length;
    const nextStatus = remainingCount ? "Partially Released" : "Released";
    const updatedRevision = await tx.dailyPlanRevision.update({
      where: { id: revision.id },
      data: {
        status: nextStatus,
        version: { increment: 1 },
        validationSummary: validateScheduleItems(revision.schedules.map((item) => item.id === schedule.id ? { ...item, status: "Released" } : item)),
        warningReason: warningReason || revision.warningReason || null,
        releasedBy: userId || revision.releasedBy || null,
        releasedAt: nextStatus === "Released" ? new Date() : revision.releasedAt,
      },
    });
    return { revision: updatedRevision, schedule: releasedSchedule, validation };
  });
}

async function releaseRevision({ revisionId, expectedVersion, warningReason, userId }) {
  return prisma.$transaction(async (tx) => {
    const revision = await tx.dailyPlanRevision.findUnique({ where: { id: revisionId }, include: { schedules: { where: { isDeleted: false } } } });
    if (!revision || revision.isDeleted) throw Object.assign(new Error("Revision Daily Plan tidak ditemukan."), { statusCode: 404 });
    if (!["Draft", "Ready", "Partially Released"].includes(revision.status)) throw Object.assign(new Error("Revision ini tidak menerima release baru."), { statusCode: 409, code: "DAILY_PLAN_IMMUTABLE" });
    if (expectedVersion != null && Number(expectedVersion) !== revision.version) throw Object.assign(new Error("Daily Plan telah berubah. Muat ulang sebelum Release Semua."), { statusCode: 409, code: "REVISION_VERSION_CONFLICT" });
    const draftSchedules = revision.schedules.filter((item) => item.status === "Draft");
    if (!draftSchedules.length) throw Object.assign(new Error("Tidak ada operation Draft yang perlu direlease."), { statusCode: 409, code: "DAILY_PLAN_NOTHING_TO_RELEASE" });
    const validation = validateScheduleItems(revision.schedules);
    if (validation.blockers.length) throw Object.assign(new Error("Daily Plan masih memiliki blocker. Jalankan Cek Kesiapan dan perbaiki blocker sebelum release."), { statusCode: 409, code: "DAILY_PLAN_VALIDATION_BLOCKED", validation });
    if (validation.warnings.length && !String(warningReason || "").trim()) throw Object.assign(new Error("Acknowledgement wajib diisi untuk release Daily Plan yang memiliki warning."), { statusCode: 400, code: "WARNING_REASON_REQUIRED", validation });

    await tx.dailyPlanRevision.updateMany({ where: { planDate: revision.planDate, status: "Released", isDeleted: false, id: { not: revision.id } }, data: { status: "Superseded" } });
    const draftIds = draftSchedules.map((item) => item.id);
    await tx.dailyProductionSchedule.updateMany({ where: { id: { in: draftIds }, status: "Draft", isDeleted: false }, data: { status: "Released" } });
    const woIds = [...new Set(draftSchedules.map((item) => item.woId).filter(Boolean))];
    if (woIds.length) await tx.workOrder.updateMany({ where: { id: { in: woIds }, isDeleted: false, status: { in: ["Draft", "Planned"] } }, data: { status: "Released" } });
    for (const schedule of draftSchedules) {
      if (!schedule.woId) continue;
      await ensureMaterialIssueDraft(tx, { ...schedule, status: "Released" }, userId || "system", { allowShortage: true });
    }
    const releasedSchedules = revision.schedules.map((item) => item.status === "Draft" ? { ...item, status: "Released" } : item);
    const updatedRevision = await tx.dailyPlanRevision.update({
      where: { id: revision.id },
      data: {
        status: "Released",
        version: { increment: 1 },
        validationSummary: validateScheduleItems(releasedSchedules),
        warningReason: warningReason || revision.warningReason || null,
        releasedBy: userId || revision.releasedBy || null,
        releasedAt: new Date(),
      },
    });
    return { revision: updatedRevision, releasedCount: draftSchedules.length, validation };
  });
}

async function allocateExecutionShortfall({ sourceLogId, targetDate, userId } = {}) {
  if (!sourceLogId || !targetDate) throw Object.assign(new Error("Source Production Log dan tanggal tujuan wajib diisi."), { statusCode: 400 });
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "tbl_production_log" WHERE "id" = ${sourceLogId} FOR UPDATE`;
    const log = await tx.productionLog.findFirst({
      where: { id: sourceLogId, isDeleted: false, status: "Approved" },
      include: {
        dailyProductionSchedule: true,
        ngReasons: { where: { isDeleted: false }, select: { status: true, qtyNg: true, qtyReject: true, qtyRework: true } },
        carryover: true,
      },
    });
    if (!log || !log.dailyProductionSchedule) throw Object.assign(new Error("Production Log atau Daily Schedule sumber tidak ditemukan."), { statusCode: 404 });
    if (log.ngReasons.some((row) => row.status === "PENDING_QC")) throw Object.assign(new Error("Disposition QC belum selesai."), { statusCode: 409 });
    if (log.carryover && log.carryover.status !== "REVERSED") throw Object.assign(new Error("Shortfall Production Log ini sudah dialokasikan."), { statusCode: 409 });
    const destination = new Date(`${String(targetDate).slice(0, 10)}T00:00:00.000Z`);
    if (Number.isNaN(destination.getTime())) throw Object.assign(new Error("Tanggal tujuan tidak valid."), { statusCode: 400 });
    if (destination <= new Date(log.dailyProductionSchedule.scheduleDate)) throw Object.assign(new Error("Tanggal tujuan harus setelah tanggal produksi sumber."), { statusCode: 400 });
    const scrapQty = log.ngReasons.reduce((sum, row) => sum + Number(row.qtyReject || 0), 0);
    const shortfallQty = Math.max(Number(log.qtyPlanned || 0) - Number(log.qtyProduced || 0) + scrapQty, 0);
    if (shortfallQty <= 0.000001) throw Object.assign(new Error("Tidak ada shortfall yang perlu dialokasikan."), { statusCode: 409 });
    return createProductionShortfallCarryover(tx, { log, schedule: log.dailyProductionSchedule, actor: userId || "system", targetDate: destination, shortfallQty });
  });
}

module.exports = { buildRevisionNumber, copyScheduleData, productionHandoffView, placementWindowsForMachine, placementWindowsByMachine, getWorkspace, createDraft, autoCorrectPlacement, updateItem, validateRevision, validationForSchedule, releaseSchedule, releaseRevision, allocateExecutionShortfall };
