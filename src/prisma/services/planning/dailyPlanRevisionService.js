const { prisma } = require("../../index");
const { validateScheduleItems, summarizeRevision, buildExecutionExceptions } = require("./dailyPlanRevisionDomain");

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
      where: { scheduleDate: { gte: range.start, lte: windowEnd }, status: { in: ["Draft", "Released", "In Progress", "Completed"] }, shift: { not: "VENDOR" }, isDeleted: false },
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
  const revisions = await client.dailyPlanRevision.findMany({
    where: {
      isDeleted: false,
      ...(revisionId ? { id: revisionId } : { planDate: { gte: range.start, lte: range.end }, status: productionMode ? "Released" : { not: "Superseded" } }),
    },
    orderBy: [{ version: "desc" }, { createdAt: "desc" }],
    include: {
      schedules: {
        where: { isDeleted: false },
        include: {
          productionLogs: {
            where: { isDeleted: false },
            select: { id: true, logNumber: true, status: true, qtyProduced: true, qtyGood: true, qtyReject: true, qtyRework: true, startTime: true, endTime: true, downtime: true },
          },
        },
        orderBy: [{ machineId: "asc" }, { plannedStartTime: "asc" }, { sequence: "asc" }],
      },
    },
  });
  const revision = revisionId || productionMode
    ? revisions[0]
    : revisions.find((row) => ["Draft", "Ready"].includes(row.status)) || revisions.find((row) => row.status === "Released") || revisions[0];
  const legacy = revision ? [] : await client.dailyProductionSchedule.findMany({
    where: { scheduleDate: { gte: range.start, lte: range.end }, isDeleted: false, productionPlanId: { not: null }, shift: { not: "VENDOR" } },
    include: { productionLogs: { where: { isDeleted: false }, select: { id: true, logNumber: true, status: true, qtyProduced: true, qtyGood: true, qtyReject: true, qtyRework: true, startTime: true, endTime: true, downtime: true } } },
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
    const existing = await tx.dailyPlanRevision.findFirst({ where: { planDate: { gte: range.start, lte: range.end }, status: { in: ["Draft", "Ready"] }, isDeleted: false }, orderBy: { version: "desc" } });
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
    if (revision.status !== "Draft") throw Object.assign(new Error("Revision Released tidak dapat diubah; buat revision baru."), { statusCode: 409, code: "DAILY_PLAN_IMMUTABLE" });
    if (expectedVersion != null && Number(expectedVersion) !== revision.version) throw Object.assign(new Error("Daily Plan telah berubah. Muat ulang revision terbaru."), { statusCode: 409, code: "REVISION_VERSION_CONFLICT" });
    const data = Object.fromEntries(allowed.filter((key) => changes[key] !== undefined).map((key) => [key, changes[key]]));
    const schedule = await tx.dailyProductionSchedule.update({ where: { id: scheduleId }, data });
    await tx.dailyPlanRevision.update({ where: { id: revisionId }, data: { version: { increment: 1 }, validationSummary: null } });
    return schedule;
  });
}

async function validateRevision(revisionId) {
  const revision = await prisma.dailyPlanRevision.findUnique({ where: { id: revisionId }, include: { schedules: { where: { isDeleted: false } } } });
  if (!revision || revision.isDeleted) throw Object.assign(new Error("Revision Daily Plan tidak ditemukan."), { statusCode: 404 });
  const validation = validateScheduleItems(revision.schedules);
  await prisma.dailyPlanRevision.update({ where: { id: revisionId }, data: { validationSummary: validation, status: validation.blockers.length ? "Draft" : "Ready" } });
  return validation;
}

async function releaseRevision({ revisionId, expectedVersion, warningReason, userId }) {
  return prisma.$transaction(async (tx) => {
    const revision = await tx.dailyPlanRevision.findUnique({ where: { id: revisionId }, include: { schedules: { where: { isDeleted: false } } } });
    if (!revision || revision.isDeleted) throw Object.assign(new Error("Revision Daily Plan tidak ditemukan."), { statusCode: 404 });
    if (!['Draft', 'Ready'].includes(revision.status)) throw Object.assign(new Error("Hanya revision Draft/Ready yang dapat dirilis."), { statusCode: 409 });
    if (expectedVersion != null && Number(expectedVersion) !== revision.version) throw Object.assign(new Error("Daily Plan telah berubah. Validasi ulang sebelum release."), { statusCode: 409, code: "REVISION_VERSION_CONFLICT" });
    const validation = validateScheduleItems(revision.schedules);
    if (validation.blockers.length) throw Object.assign(new Error("Daily Plan masih memiliki blocker."), { statusCode: 409, code: "DAILY_PLAN_VALIDATION_BLOCKED", validation });
    if (validation.warnings.length && !String(warningReason || "").trim()) throw Object.assign(new Error("Alasan acknowledgement wajib diisi untuk warning."), { statusCode: 400, code: "WARNING_REASON_REQUIRED", validation });
    await tx.dailyPlanRevision.updateMany({ where: { planDate: revision.planDate, status: "Released", isDeleted: false, id: { not: revision.id } }, data: { status: "Superseded" } });
    await tx.dailyProductionSchedule.updateMany({ where: { dailyPlanRevisionId: revision.id, isDeleted: false }, data: { status: "Released" } });
    return tx.dailyPlanRevision.update({ where: { id: revision.id }, data: { status: "Released", validationSummary: validation, warningReason: warningReason || null, releasedBy: userId || null, releasedAt: new Date() } });
  });
}

module.exports = { buildRevisionNumber, copyScheduleData, productionHandoffView, getWorkspace, createDraft, updateItem, validateRevision, releaseRevision };
