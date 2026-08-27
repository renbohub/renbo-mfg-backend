"use strict";

const { planningMonthKey } = require("../../utils/planningMonth");
const { getMpsWorkbench, demandPhases } = require("./mpsWorkbenchService");
const {
  utcDate,
  dateKey,
  backwardOffsetPhase,
  weekStart,
  weeklyBuckets,
  allocateWeeklyLoad,
  capacityOffsetStatus,
  findEarlierFeasibleStart,
  resolvedCalendarId,
} = require("./rccpOffsetService");

const EPSILON = 0.000001;
const RECEIPT_PREFIX = "[FG-RECEIPT]";
const GENERATED_PREFIX = "[MRP-PRODUCTION]";
const VALID_RESULT_STATUSES = ["FEASIBLE", "WARNING", "OVERLOAD", "OVERRIDDEN"];
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value, digits = 6) => {
  const factor = 10 ** digits;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
};
const actor = (value) => value || "system";
const isReceipt = (row) => String(row?.notes || "").startsWith(RECEIPT_PREFIX)
  || !String(row?.notes || "").startsWith(GENERATED_PREFIX);

function capacityStatusForLoad(loadPercentage, thresholds = {}) {
  const warning = number(thresholds.warningThreshold ?? 90);
  const overload = number(thresholds.overloadThreshold ?? 100);
  const load = number(loadPercentage);
  if (load > overload) return "OVERLOAD";
  if (load > warning) return "WARNING";
  return "FEASIBLE";
}

function worstCapacityStatus(statuses = []) {
  const rank = { NOT_CHECKED: 0, FEASIBLE: 1, WARNING: 2, OVERLOAD: 3, OVERRIDDEN: 3 };
  return statuses.reduce((worst, status) => (number(rank[status]) > number(rank[worst]) ? status : worst), "FEASIBLE");
}

function workingDaysInPeriod(periodStart, periodEnd, options = {}) {
  const start = new Date(periodStart);
  const end = new Date(periodEnd);
  const calendarMode = String(options.calendarMode || "WEEKDAY").toUpperCase();
  const overrides = new Map((options.overrides || []).map((row) => [new Date(row.scheduleDate).toISOString().slice(0, 10), row]));
  let count = 0;
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cursor <= last) {
    const key = cursor.toISOString().slice(0, 10);
    const override = overrides.get(key);
    const day = cursor.getUTCDay();
    const defaultWorking = calendarMode === "ALL_DAYS" || (day !== 0 && day !== 6);
    const working = override
      ? String(override.dayStatus || "WORKING").toUpperCase() !== "HOLIDAY" && number(override.shiftsPerDay ?? options.shiftsPerDay) > 0
      : defaultWorking;
    if (working) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

function availableCapacityHours(profile, workingDays) {
  return round(Math.max(
    number(workingDays)
      * number(profile.shiftsPerDay)
      * number(profile.effectiveHoursPerShift)
      * number(profile.resourceCount)
      * number(profile.efficiencyPercent) / 100
      - number(profile.plannedDowntimeHours),
    0,
  ));
}

function capacityForProfilesAcrossBuckets(profiles = [], horizonStart, horizonEnd, calendarOverrides = []) {
  const uniqueProfiles = [...new Map(profiles.filter(Boolean).map((profile) => [
    profile.id || `${profile.partId || "PART"}|${profile.resourceCode || "RESOURCE"}|${profile.machineId || "MACHINE"}`,
    profile,
  ])).values()];
  if (!uniqueProfiles.length) return Number.NaN;
  return round(weeklyBuckets(horizonStart, horizonEnd).reduce((total, bucket) => {
    const profileCapacities = uniqueProfiles.map((profile) => {
      if (!profile.isCapacityConstrained) return Number.POSITIVE_INFINITY;
      const overrides = calendarOverrides.filter((row) => row.machineId === profile.machineId);
      const workingDays = workingDaysInPeriod(bucket.start, bucket.end, {
        calendarMode: profile.calendarMode,
        shiftsPerDay: profile.shiftsPerDay,
        overrides,
      });
      return availableCapacityHours(profile, workingDays);
    });
    const finiteCapacities = profileCapacities.filter(Number.isFinite);
    return total + (finiteCapacities.length ? Math.min(...finiteCapacities) : 0);
  }, 0));
}

function calculateRccpLoad(input = {}) {
  const currentMpsLoad = round(number(input.mpsQty) * number(input.standardTimeHours) + number(input.setupTimeHours));
  const existingLoad = round(input.existingLoad);
  const availableCapacity = round(input.availableCapacity);
  const totalLoad = round(existingLoad + currentMpsLoad);
  const loadPercentage = availableCapacity > EPSILON ? round(totalLoad / availableCapacity * 100, 4) : 0;
  return {
    currentMpsLoad,
    existingLoad,
    availableCapacity,
    totalLoad,
    loadPercentage,
    status: capacityStatusForLoad(loadPercentage, input),
  };
}

async function settings(tx) {
  const rows = await tx.systemSetting.findMany({
    where: { settingKey: { in: ["RCCP_WARNING_THRESHOLD", "RCCP_OVERLOAD_THRESHOLD", "RCCP_DEFAULT_SETUP_HOURS", "RCCP_PREVIOUS_SEARCH_WINDOW_DAYS"] }, isDeleted: false },
    select: { settingKey: true, settingValue: true },
  });
  const values = new Map(rows.map((row) => [row.settingKey, number(row.settingValue)]));
  const warningThreshold = values.get("RCCP_WARNING_THRESHOLD") || 90;
  const overloadThreshold = values.get("RCCP_OVERLOAD_THRESHOLD") || 100;
  if (warningThreshold < 0 || overloadThreshold <= warningThreshold) {
    throw Object.assign(new Error("Konfigurasi threshold RCCP tidak valid."), { statusCode: 409, code: "RCCP_THRESHOLD_INVALID" });
  }
  return {
    warningThreshold,
    overloadThreshold,
    defaultSetupHours: values.get("RCCP_DEFAULT_SETUP_HOURS") || 0.25,
    previousSearchWindowDays: Math.max(Math.trunc(values.get("RCCP_PREVIOUS_SEARCH_WINDOW_DAYS") || 10), 0),
  };
}

function profileResource(process = {}) {
  return String(process.machineSpecificationCode || process.machineFamily || process.processCode || "")
    .trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
}

async function bootstrapProfilesFromRouting(tx, doc, details, runBy, configuration) {
  const missingPartIds = details.filter((row) => !(row.part?.rccpResourceProfiles || []).length).map((row) => row.partId).filter(Boolean);
  if (!missingPartIds.length) return;
  const workbench = await getMpsWorkbench(tx, { month: planningMonthKey(doc.periodStart), page: 1, pageSize: 500, includeSimulation: false });
  for (const item of workbench.items || []) {
    const detail = details.find((row) => row.id === item.id || row.partCode === item.partCode);
    if (!detail?.partId || !missingPartIds.includes(detail.partId)) continue;
    const grouped = new Map();
    for (const component of item.components || []) {
      for (const process of component.processes || []) {
        if (process.isVendor || number(process.cycleTimeSeconds) <= 0) continue;
        const resourceCode = profileResource(process);
        if (!resourceCode) continue;
        const current = grouped.get(resourceCode) || {
          resourceCode,
          resourceName: process.machineSpecificationName || process.machineFamily || process.processName || process.processCode || resourceCode,
          machineId: process.machineId || null,
          standardTimeHours: 0,
        };
        current.standardTimeHours += number(component.qtyPerFg) * number(process.cycleTimeSeconds) / 3600;
        grouped.set(resourceCode, current);
      }
    }
    for (const profile of grouped.values()) {
      await tx.rccpResourceProfile.upsert({
        where: { partId_resourceCode: { partId: detail.partId, resourceCode: profile.resourceCode } },
        create: {
          partId: detail.partId,
          resourceCode: profile.resourceCode,
          resourceName: profile.resourceName,
          machineId: profile.machineId,
          standardTimeHours: round(profile.standardTimeHours),
          setupTimeHours: configuration.defaultSetupHours,
          source: "MBOM_BOOTSTRAP",
          notes: `Generated from active MBOM for ${detail.partCode}; review as governed RCCP master.`,
          createdBy: actor(runBy),
          updatedBy: actor(runBy),
        },
        update: {},
      });
    }
  }
}

async function latestRccpForMps(tx, mpsId) {
  const run = await tx.rccpRun.findFirst({
    where: { mpsId, invalidatedAt: null },
    include: {
      loads: { orderBy: { loadPercentage: "desc" } },
      overrides: { orderBy: { approvedAt: "desc" } },
      timeBuckets: { orderBy: [{ bucketStart: "asc" }, { resourceCode: "asc" }] },
      offsetDetails: { orderBy: [{ requiredDate: "asc" }, { sequence: "asc" }] },
      recommendations: { orderBy: { createdAt: "asc" } },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!run) return null;
  return {
    ...run,
    approvalAllowed: run.status === "FEASIBLE"
      || (run.status === "WARNING" && Boolean(run.acknowledgedAt))
      || (run.status === "OVERRIDDEN" && run.overrides.length > 0),
  };
}

async function existingLoadByResource(tx, mpsId, planningPeriod) {
  const runs = await tx.rccpRun.findMany({
    where: { mpsId: { not: mpsId }, planningPeriod, invalidatedAt: null, status: { in: VALID_RESULT_STATUSES } },
    include: { loads: true },
    orderBy: { createdAt: "desc" },
  });
  const latestByMps = new Map();
  runs.forEach((run) => { if (!latestByMps.has(run.mpsId)) latestByMps.set(run.mpsId, run); });
  const result = new Map();
  for (const run of latestByMps.values()) {
    for (const load of run.loads) result.set(load.resourceCode, round(number(result.get(load.resourceCode)) + number(load.currentMpsLoad)));
  }
  return result;
}

async function existingLoadByWeeklyBucket(tx, mpsId, horizonStart, horizonEnd) {
  const rows = await tx.rccpRun.findMany({
    where: {
      mpsId: { not: mpsId }, invalidatedAt: null, status: { in: VALID_RESULT_STATUSES },
      capacityHorizonStart: { lte: horizonEnd }, capacityHorizonEnd: { gte: horizonStart },
    },
    include: { timeBuckets: { where: { bucketEnd: { gte: horizonStart }, bucketStart: { lte: horizonEnd } } } },
    orderBy: { createdAt: "desc" },
  });
  const latestByMps = new Map();
  rows.forEach((run) => { if (!latestByMps.has(run.mpsId)) latestByMps.set(run.mpsId, run); });
  const loads = new Map();
  for (const run of latestByMps.values()) {
    for (const bucket of run.timeBuckets) {
      const key = `${bucket.resourceCode}|${dateKey(bucket.bucketStart)}`;
      loads.set(key, round(number(loads.get(key)) + number(bucket.currentMpsLoad)));
    }
  }
  return loads;
}

function normalizedRunOptions(options = {}) {
  return {
    includePreviousMonth: options.includePreviousMonth ?? options.include_previous_month ?? true,
    useWorkingCalendar: options.useWorkingCalendar ?? options.use_working_calendar ?? true,
    includeVendorLeadTime: options.includeVendorLeadTime ?? options.include_vendor_lead_time ?? true,
    searchAlternativeStart: options.searchAlternativeStart ?? options.search_alternative_start ?? true,
    requiredDateSource: String(options.requiredDateSource || options.required_date_source || "DELIVERY_PHASE").toUpperCase(),
    manualRequiredDate: options.manualRequiredDate || options.manual_required_date || null,
  };
}

function phasesForDetail(detail, doc, runOptions, workbenchItem = null) {
  if (runOptions.requiredDateSource === "MANUAL") {
    const requiredDate = utcDate(runOptions.manualRequiredDate);
    if (!requiredDate) throw validationError([{ code: "RCCP_REQUIRED_DATE_INVALID", partCode: detail.partCode, message: "Manual Preliminary Date wajib diisi." }]);
    return [{ id: `MANUAL:${detail.id}`, phaseNumber: 1, qty: round(detail.qtyPlanned), fgRequiredDate: requiredDate, sourceType: "MANUAL" }];
  }
  const nettedPhases = [
    ...(Array.isArray(workbenchItem?.phases) ? workbenchItem.phases : []),
    ...(workbenchItem?.bufferPhase ? [workbenchItem.bufferPhase] : []),
  ];
  if (nettedPhases.length) {
    return nettedPhases.map((phase, index) => ({
      ...phase,
      phaseNumber: index + 1,
      deliveryPhaseNumber: phase.phaseNumber || null,
      demandQty: round(phase.qty),
      qty: round(phase.plannedProductionQty),
      fgRequiredDate: utcDate(phase.fgRequiredDate || phase.targetDeliveryDate),
      sourceType: phase.sourceType || "MPS",
      isBuffer: String(phase.sourceType || "").toUpperCase() === "BUFFER",
    })).filter((phase) => phase.qty > EPSILON && phase.fgRequiredDate);
  }
  const raw = demandPhases(detail).filter((phase) => utcDate(phase.fgRequiredDate));
  if (!raw.length) {
    const fallback = utcDate(detail.fgRequiredDate || detail.endDate || doc.periodEnd);
    return [{ id: `MPS:${detail.id}`, phaseNumber: 1, qty: round(detail.qtyPlanned), fgRequiredDate: fallback, sourceType: "MPS" }];
  }
  const totalSourceQty = raw.reduce((sum, phase) => sum + number(phase.qty), 0);
  const target = number(detail.qtyPlanned);
  let allocated = 0;
  return raw.map((phase, index) => {
    const qty = index === raw.length - 1
      ? round(target - allocated)
      : round(totalSourceQty > EPSILON ? target * number(phase.qty) / totalSourceQty : target / raw.length);
    allocated += qty;
    return { ...phase, qty, fgRequiredDate: utcDate(phase.fgRequiredDate) };
  }).filter((phase) => phase.qty > EPSILON);
}

function resourceFamily(value) {
  const token = String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
  if (!token) return "";
  if (token.includes("STAMP") || token.includes("PROGRESSIVE") || token === "PRG") return "STAMPING";
  if (token.includes("WELD")) return "WELDING";
  if (token.includes("PAINT")) return "PAINTING";
  if (token.includes("PACK") || token.includes("INSPECT")) return "PACKING";
  return token;
}

function profileMatchesProcess(profile = {}, process = {}) {
  const profileFamilies = [profile.resourceCode, profile.resourceName].map(resourceFamily).filter(Boolean);
  const processFamilies = [process.processCode, process.processName].map(resourceFamily).filter(Boolean);
  return profileFamilies.some((profileFamily) => processFamilies.includes(profileFamily));
}

function resourceRequirementForPhase(profile, workbenchItem, phase) {
  if (!workbenchItem || phase.sourceType === "MANUAL") {
    return { qty: round(phase.qty), source: "PROFILE_FALLBACK", trace: [] };
  }
  const matchedComponents = (workbenchItem.components || []).filter((component) =>
    (component.processes || []).some((process) => profileMatchesProcess(profile, process)));
  if (!matchedComponents.length) {
    return { qty: round(phase.qty), source: "PROFILE_FALLBACK", trace: [] };
  }
  const matchedNettings = matchedComponents.map((component) => {
    const netting = (component.phaseNetting || []).find((row) => row.phaseId === phase.id);
    if (!netting) return null;
    const qtyPerFg = number(component.qtyPerFg) > EPSILON ? number(component.qtyPerFg) : 1;
    return {
      partCode: component.partCode,
      level: component.level,
      processCodes: [...new Set((component.processes || [])
        .filter((process) => profileMatchesProcess(profile, process))
        .map((process) => process.processCode)
        .filter(Boolean))],
      qtyPerFg: round(qtyPerFg),
      grossRequirementQty: round(netting.grossRequirementQty),
      stockUsedQty: round(netting.stockUsedQty),
      firmReceiptUsedQty: round(netting.firmReceiptUsedQty),
      netRequirementQty: round(netting.netRequirementQty),
      plannedOrderQty: round(netting.plannedOrderQty),
      equivalentFgQty: round(number(netting.plannedOrderQty) / qtyPerFg),
      processLeadTimeHours: round(Math.max(
        number(netting.leadTime?.totalHours) - number(netting.leadTime?.parentHours),
        0,
      )),
    };
  }).filter(Boolean);
  if (!matchedNettings.length) {
    return { qty: round(phase.qty), source: "PROFILE_FALLBACK", trace: [] };
  }
  const trace = matchedNettings.filter((row) => [
    row.grossRequirementQty,
    row.stockUsedQty,
    row.firmReceiptUsedQty,
    row.netRequirementQty,
    row.plannedOrderQty,
  ].some((value) => number(value) > EPSILON));
  const equivalentFgQty = Math.max(0, ...matchedNettings.map((row) => number(row.equivalentFgQty)));
  const processLeadTimeHours = Math.max(0, ...matchedNettings
    .filter((row) => number(row.plannedOrderQty) > EPSILON)
    .map((row) => number(row.processLeadTimeHours)));
  return {
    qty: round(Math.min(number(phase.qty), equivalentFgQty)),
    source: "WIP_PHASE_NETTING",
    trace,
    processLeadTimeHours: round(processLeadTimeHours),
  };
}

function validationError(exceptions) {
  return Object.assign(new Error(exceptions[0]?.message || "RCCP tidak dapat dijalankan karena master capacity belum lengkap."), {
    statusCode: 409,
    code: "RCCP_VALIDATION_FAILED",
    exceptions,
  });
}

async function runRccpMonthlyLegacy(prisma, mpsNumber, options = {}) {
  return prisma.$transaction(async (tx) => {
    const doc = await tx.mPS.findFirst({
      where: { mpsNumber, isDeleted: false },
      include: {
        details: {
          where: { isDeleted: false },
          include: {
            part: { include: { rccpResourceProfiles: { where: { isActive: true, isCritical: true }, include: { machine: true } } } },
          },
        },
      },
    });
    if (!doc) throw Object.assign(new Error("MPS tidak ditemukan."), { statusCode: 404, code: "MPS_NOT_FOUND" });
    if (["Released", "Completed", "Superseded", "Cancelled"].includes(doc.status)) {
      throw Object.assign(new Error(`MPS status ${doc.status} tidak dapat menjalankan RCCP.`), { statusCode: 409, code: "MPS_RCCP_STATUS_BLOCKED" });
    }
    const configuration = await settings(tx);
    let details = doc.details.filter(isReceipt);
    await bootstrapProfilesFromRouting(tx, doc, details, options.runBy, configuration);
    details = await tx.mPSDetail.findMany({
      where: { id: { in: details.map((row) => row.id) }, isDeleted: false },
      include: { part: { include: { rccpResourceProfiles: { where: { isActive: true, isCritical: true }, include: { machine: true } } } } },
      orderBy: { lineNumber: "asc" },
    });
    const exceptions = [];
    if (!doc.periodStart || !doc.periodEnd) exceptions.push({ code: "NO_CAPACITY_CALENDAR", message: "Planning Period MPS belum tersedia." });
    const positiveDetails = details.filter((row) => number(row.qtyPlanned) > EPSILON);
    if (!positiveDetails.length) exceptions.push({ code: "MPS_QTY_INVALID", message: "MPS Qty harus lebih besar dari 0 sebelum RCCP dijalankan." });
    for (const detail of positiveDetails) {
      if (!detail.partId || !detail.part) {
        exceptions.push({ code: "MPS_PART_MISSING", partCode: detail.partCode, message: `${detail.partCode}: Part master belum tersedia.` });
        continue;
      }
      const profiles = detail.part.rccpResourceProfiles || [];
      if (!profiles.length) exceptions.push({ code: "NO_RCCP_PROFILE", partCode: detail.partCode, message: `${detail.partCode}: belum memiliki RCCP Resource Profile.` });
      for (const profile of profiles) {
        if (number(profile.standardTimeHours) <= 0) exceptions.push({ code: "NO_STANDARD_TIME", partCode: detail.partCode, resourceCode: profile.resourceCode, message: `${detail.partCode} · ${profile.resourceCode}: Standard Time harus lebih besar dari 0.` });
        if (number(profile.shiftsPerDay) <= 0 || number(profile.effectiveHoursPerShift) <= 0 || number(profile.resourceCount) <= 0 || number(profile.efficiencyPercent) <= 0) {
          exceptions.push({ code: "NO_CAPACITY_CALENDAR", partCode: detail.partCode, resourceCode: profile.resourceCode, message: `${profile.resourceCode}: calendar/shift capacity belum lengkap.` });
        }
      }
    }
    if (exceptions.length) throw validationError(exceptions);

    const allProfiles = positiveDetails.flatMap((detail) => (detail.part.rccpResourceProfiles || []).map((profile) => ({ detail, profile })));
    const machineIds = [...new Set(allProfiles.map(({ profile }) => profile.machineId).filter(Boolean))];
    const calendarOverrides = machineIds.length ? await tx.capacityCalendarOverride.findMany({
      where: { machineId: { in: machineIds }, scheduleDate: { gte: doc.periodStart, lte: doc.periodEnd }, isDeleted: false },
      select: { machineId: true, scheduleDate: true, dayStatus: true, shiftsPerDay: true },
    }) : [];
    const existingLoads = await existingLoadByResource(tx, doc.id, doc.periodStart);
    const resources = new Map();
    for (const { detail, profile } of allProfiles) {
      const overrides = calendarOverrides.filter((row) => row.machineId === profile.machineId);
      const workingDays = workingDaysInPeriod(doc.periodStart, doc.periodEnd, { calendarMode: profile.calendarMode, shiftsPerDay: profile.shiftsPerDay, overrides });
      const capacity = availableCapacityHours(profile, workingDays);
      if (capacity <= EPSILON) exceptions.push({ code: "NO_AVAILABLE_CAPACITY", partCode: detail.partCode, resourceCode: profile.resourceCode, message: `${profile.resourceCode}: available capacity periode ini 0 jam.` });
      const current = resources.get(profile.resourceCode) || {
        resourceCode: profile.resourceCode,
        resourceName: profile.resourceName || profile.resourceCode,
        profile,
        workingDays,
        availableCapacity: capacity,
        standardTimeHours: 0,
        setupTimeHours: 0,
        currentMpsLoad: 0,
        partBreakdown: [],
      };
      const partLoad = round(number(detail.qtyPlanned) * number(profile.standardTimeHours) + number(profile.setupTimeHours));
      current.standardTimeHours += number(profile.standardTimeHours);
      current.setupTimeHours += number(profile.setupTimeHours);
      current.currentMpsLoad += partLoad;
      current.availableCapacity = Math.min(number(current.availableCapacity), capacity);
      current.workingDays = Math.min(number(current.workingDays), workingDays);
      current.partBreakdown.push({
        mpsDetailId: detail.id,
        partId: detail.partId,
        partCode: detail.partCode,
        partNumber: detail.part?.partNumber || detail.partCode,
        partName: detail.part?.partName || detail.partCode,
        mpsQty: round(detail.qtyPlanned),
        standardTimeHours: round(profile.standardTimeHours),
        setupTimeHours: round(profile.setupTimeHours),
        requiredCapacityHours: partLoad,
      });
      resources.set(profile.resourceCode, current);
    }
    if (exceptions.length) throw validationError(exceptions);

    await tx.rccpRun.updateMany({
      where: { mpsId: doc.id, invalidatedAt: null },
      data: { status: "INVALID", invalidatedAt: new Date(), invalidationReason: "Digantikan RCCP run terbaru." },
    });
    const totalMpsQty = round(positiveDetails.reduce((sum, row) => sum + number(row.qtyPlanned), 0));
    const run = await tx.rccpRun.create({
      data: {
        mpsId: doc.id,
        mpsRevision: doc.revision,
        planningPeriod: doc.periodStart,
        status: "RUNNING",
        overallLoadStatus: "RUNNING",
        warningThreshold: configuration.warningThreshold,
        overloadThreshold: configuration.overloadThreshold,
        mpsQtySnapshot: totalMpsQty,
        calculatedBy: actor(options.runBy),
      },
    });
    const calculatedLoads = [];
    for (const resource of resources.values()) {
      const calculation = calculateRccpLoad({
        mpsQty: 1,
        standardTimeHours: resource.currentMpsLoad,
        setupTimeHours: 0,
        existingLoad: existingLoads.get(resource.resourceCode) || 0,
        availableCapacity: resource.availableCapacity,
        warningThreshold: configuration.warningThreshold,
        overloadThreshold: configuration.overloadThreshold,
      });
      const saved = await tx.rccpLoad.create({
        data: {
          rccpRunId: run.id,
          resourceProfileId: resource.profile.id,
          resourceCode: resource.resourceCode,
          resourceName: resource.resourceName,
          standardTimeHours: round(resource.standardTimeHours),
          setupTimeHours: round(resource.setupTimeHours),
          currentMpsLoad: calculation.currentMpsLoad,
          existingLoad: calculation.existingLoad,
          availableCapacity: calculation.availableCapacity,
          totalLoad: calculation.totalLoad,
          loadPercentage: calculation.loadPercentage,
          status: calculation.status,
          workingDays: resource.workingDays,
          shiftsPerDay: resource.profile.shiftsPerDay,
          effectiveHoursPerShift: resource.profile.effectiveHoursPerShift,
          resourceCount: resource.profile.resourceCount,
          efficiencyPercent: resource.profile.efficiencyPercent,
          plannedDowntimeHours: resource.profile.plannedDowntimeHours,
          partBreakdown: resource.partBreakdown,
        },
      });
      calculatedLoads.push(saved);
    }
    const overall = worstCapacityStatus(calculatedLoads.map((load) => load.status));
    const capacityExceptions = calculatedLoads
      .filter((load) => ["WARNING", "OVERLOAD"].includes(load.status))
      .map((load) => ({
        code: load.status === "OVERLOAD" ? "CAPACITY_OVERLOAD" : "CAPACITY_WARNING",
        resourceCode: load.resourceCode,
        loadPercentage: load.loadPercentage,
        message: `${load.resourceCode}: load ${load.loadPercentage}% dari available capacity ${load.availableCapacity} jam.`,
      }));
    const partSummaryMap = new Map(positiveDetails.map((detail) => [detail.partCode, {
      partCode: detail.partCode,
      partNumber: detail.part?.partNumber || detail.partCode,
      partName: detail.part?.partName || detail.partCode,
      mpsQty: round(detail.qtyPlanned),
      capacityStatus: "FEASIBLE",
      maxLoadPercentage: 0,
      resourceCodes: [],
    }]));
    for (const load of calculatedLoads) {
      for (const part of Array.isArray(load.partBreakdown) ? load.partBreakdown : []) {
        const summary = partSummaryMap.get(part.partCode);
        if (!summary) continue;
        summary.capacityStatus = worstCapacityStatus([summary.capacityStatus, load.status]);
        summary.maxLoadPercentage = Math.max(summary.maxLoadPercentage, number(load.loadPercentage));
        summary.resourceCodes.push(load.resourceCode);
      }
    }
    const partSummaries = [...partSummaryMap.values()].map((summary) => ({ ...summary, maxLoadPercentage: round(summary.maxLoadPercentage, 4), resourceCodes: [...new Set(summary.resourceCodes)] }));
    const completed = await tx.rccpRun.update({
      where: { id: run.id },
      data: { status: overall, overallLoadStatus: overall, partSummaries, exceptions: capacityExceptions, completedAt: new Date() },
      include: { loads: { orderBy: { loadPercentage: "desc" } }, overrides: true },
    });
    await tx.mPS.update({
      where: { id: doc.id },
      data: {
        capacityStatus: overall,
        capacityCheckedAt: new Date(),
        capacityCheckedBy: actor(options.runBy),
        rccpInvalidatedAt: null,
        rccpInvalidationReason: null,
        lifecycleStatus: overall === "FEASIBLE" ? "CAPACITY_CHECKED" : "CALCULATED",
      },
    });
    return { ...completed, approvalAllowed: overall === "FEASIBLE" };
  });
}

async function runRccp(prisma, mpsNumber, options = {}) {
  return prisma.$transaction(async (tx) => {
    const runOptions = normalizedRunOptions(options);
    const doc = await tx.mPS.findFirst({
      where: { mpsNumber, isDeleted: false },
      include: {
        details: {
          where: { isDeleted: false },
          include: {
            demandSources: { orderBy: [{ effectiveRequiredDate: "asc" }, { sourceNumber: "asc" }] },
            part: { include: { rccpResourceProfiles: { where: { isActive: true, isCritical: true }, include: { machine: true }, orderBy: { sequence: "asc" } } } },
          },
        },
      },
    });
    if (!doc) throw Object.assign(new Error("MPS tidak ditemukan."), { statusCode: 404, code: "MPS_NOT_FOUND" });
    if (["Released", "Completed", "Superseded", "Cancelled"].includes(doc.status)) {
      throw Object.assign(new Error(`MPS status ${doc.status} tidak dapat menjalankan RCCP.`), { statusCode: 409, code: "MPS_RCCP_STATUS_BLOCKED" });
    }

    const configuration = await settings(tx);
    let details = doc.details.filter(isReceipt);
    await bootstrapProfilesFromRouting(tx, doc, details, options.runBy, configuration);
    details = await tx.mPSDetail.findMany({
      where: { id: { in: details.map((row) => row.id) }, isDeleted: false },
      include: {
        demandSources: { orderBy: [{ effectiveRequiredDate: "asc" }, { sourceNumber: "asc" }] },
        part: { include: { rccpResourceProfiles: { where: { isActive: true, isCritical: true }, include: { machine: true }, orderBy: { sequence: "asc" } } } },
      },
      orderBy: { lineNumber: "asc" },
    });

    const exceptions = [];
    if (!doc.periodStart || !doc.periodEnd) exceptions.push({ code: "NO_CAPACITY_CALENDAR", message: "Planning Period MPS belum tersedia." });
    const positiveDetails = details.filter((row) => number(row.qtyPlanned) > EPSILON);
    if (!positiveDetails.length) exceptions.push({ code: "MPS_QTY_INVALID", message: "MPS Qty harus lebih besar dari 0 sebelum RCCP dijalankan." });
    for (const detail of positiveDetails) {
      if (!detail.partId || !detail.part) {
        exceptions.push({ code: "MPS_PART_MISSING", partCode: detail.partCode, message: `${detail.partCode}: Part master belum tersedia.` });
        continue;
      }
      const profiles = detail.part.rccpResourceProfiles || [];
      if (!profiles.length) exceptions.push({ code: "NO_RCCP_PROFILE", partCode: detail.partCode, message: `${detail.partCode}: belum memiliki RCCP Resource Profile.` });
      for (const profile of profiles) {
        if (number(profile.standardTimeHours) <= 0 && profile.isCapacityConstrained) exceptions.push({ code: "NO_STANDARD_TIME", partCode: detail.partCode, resourceCode: profile.resourceCode, message: `${detail.partCode} · ${profile.resourceCode}: Standard Time harus lebih besar dari 0.` });
        if (number(profile.leadTimeValue) < 0) exceptions.push({ code: "NO_LEAD_TIME", partCode: detail.partCode, resourceCode: profile.resourceCode, message: `${profile.resourceCode}: Lead Time tidak valid.` });
        if (profile.isCapacityConstrained && (number(profile.shiftsPerDay) <= 0 || number(profile.effectiveHoursPerShift) <= 0 || number(profile.resourceCount) <= 0 || number(profile.efficiencyPercent) <= 0)) {
          exceptions.push({ code: "NO_CAPACITY_CALENDAR", partCode: detail.partCode, resourceCode: profile.resourceCode, message: `${profile.resourceCode}: calendar/shift capacity belum lengkap.` });
        }
      }
    }
    if (exceptions.length) throw validationError(exceptions);

    const workbench = await getMpsWorkbench(tx, {
      month: planningMonthKey(doc.periodStart),
      page: 1,
      pageSize: 100,
      includeSimulation: true,
    });
    const workbenchByDetail = new Map((workbench.items || []).map((item) => [item.id, item]));
    const phaseRows = positiveDetails.flatMap((detail) => {
      const workbenchItem = workbenchByDetail.get(detail.id)
        || (workbench.items || []).find((item) => item.partCode === detail.partCode);
      return phasesForDetail(detail, doc, runOptions, workbenchItem).map((phase) => ({
        detail,
        phase,
        workbenchItem,
        resourceRequirements: (detail.part.rccpResourceProfiles || []).map((profile) => ({
          profile,
          ...resourceRequirementForPhase(profile, workbenchItem, phase),
        })),
      }));
    });
    const phaseQtyByDetail = new Map();
    phaseRows.forEach(({ detail, phase }) => phaseQtyByDetail.set(detail.id, round(number(phaseQtyByDetail.get(detail.id)) + number(phase.qty))));
    for (const detail of positiveDetails) {
      if (Math.abs(number(phaseQtyByDetail.get(detail.id)) - number(detail.qtyPlanned)) > EPSILON) {
        exceptions.push({ code: "RCCP_PHASE_QTY_MISMATCH", partCode: detail.partCode, message: `${detail.partCode}: total Delivery Phase harus sama dengan MPS Qty.` });
      }
    }
    if (exceptions.length) throw validationError(exceptions);

    const earliestDue = phaseRows.reduce((min, row) => !min || row.phase.fgRequiredDate < min ? row.phase.fgRequiredDate : min, null);
    const latestRequiredDate = phaseRows.reduce((max, row) => !max || row.phase.fgRequiredDate > max ? row.phase.fgRequiredDate : max, null);
    const calendarScanStart = new Date(earliestDue);
    calendarScanStart.setUTCDate(calendarScanStart.getUTCDate() - 180);
    const machineIds = [...new Set(positiveDetails.flatMap((detail) => detail.part.rccpResourceProfiles.map((profile) => profile.machineId)).filter(Boolean))];
    const calendarOverrides = machineIds.length ? await tx.capacityCalendarOverride.findMany({
      where: { machineId: { in: machineIds }, scheduleDate: { gte: calendarScanStart, lte: latestRequiredDate }, isDeleted: false },
      select: { machineId: true, scheduleDate: true, dayStatus: true, shiftsPerDay: true },
    }) : [];
    const overridesByMachine = new Map();
    for (const override of calendarOverrides) {
      const list = overridesByMachine.get(override.machineId) || [];
      list.push(override);
      overridesByMachine.set(override.machineId, list);
    }

    const offsetRows = [];
    for (const { detail, phase, resourceRequirements } of phaseRows) {
      const activeRequirements = resourceRequirements.filter((requirement) => number(requirement.qty) > EPSILON);
      const timeline = backwardOffsetPhase({
        requiredDate: phase.fgRequiredDate,
        profiles: activeRequirements.map((requirement) => ({
          ...requirement.profile,
          allowUpstreamSameDay: String(requirement.profile.resourceType || "INTERNAL").toUpperCase() !== "OUTSOURCE"
            && number(requirement.processLeadTimeHours) > EPSILON
            && number(requirement.processLeadTimeHours) < 14,
        })),
        includeVendorLeadTime: runOptions.includeVendorLeadTime,
        useWorkingCalendar: runOptions.useWorkingCalendar,
        overridesByMachine,
      });
      for (const timing of timeline.details) {
        const requirement = activeRequirements.find((row) => row.profile.id === timing.profile.id);
        const resourceRequirementQty = number(requirement?.qty);
        const requiredCapacityHours = round(resourceRequirementQty * number(timing.profile.standardTimeHours) + number(timing.profile.setupTimeHours));
        offsetRows.push({
          detail,
          phase,
          ...timing,
          resourceRequirementQty,
          nettingSource: requirement?.source || "PROFILE_FALLBACK",
          nettingTrace: requirement?.trace || [],
          requiredCapacityHours,
          bucketAllocations: allocateWeeklyLoad({
            startDate: timing.calculatedStartDate,
            finishDate: timing.calculatedFinishDate,
            totalHours: requiredCapacityHours,
            calendar: {
              calendarMode: timing.profile.calendarMode,
              shiftsPerDay: timing.profile.shiftsPerDay,
              useWorkingCalendar: runOptions.useWorkingCalendar,
              overrides: overridesByMachine.get(timing.profile.machineId) || [],
            },
          }),
        });
      }
    }
    const earliestStartDate = offsetRows.reduce((min, row) => !min || row.calculatedStartDate < min ? row.calculatedStartDate : min, latestRequiredDate);
    const mpsMonthStart = utcDate(doc.periodStart);
    const hasPreviousMonthLoad = Boolean(earliestStartDate && earliestStartDate < mpsMonthStart);
    const capacityHorizonStart = hasPreviousMonthLoad && runOptions.includePreviousMonth ? earliestStartDate : mpsMonthStart;
    const capacityHorizonEnd = latestRequiredDate;
    const bucketRanges = weeklyBuckets(capacityHorizonStart, capacityHorizonEnd);
    const existingBucketLoads = await existingLoadByWeeklyBucket(tx, doc.id, capacityHorizonStart, capacityHorizonEnd);

    const resources = new Map();
    for (const detail of positiveDetails) {
      for (const profile of detail.part.rccpResourceProfiles) {
        const resource = resources.get(profile.resourceCode) || {
          resourceCode: profile.resourceCode,
          resourceName: profile.resourceName || profile.resourceCode,
          resourceType: String(profile.resourceType || "INTERNAL").toUpperCase(),
          profile,
          profiles: [],
          partBreakdown: [],
        };
        resource.profiles.push(profile);
        resources.set(profile.resourceCode, resource);
      }
    }

    const currentByBucket = new Map();
    for (const row of offsetRows) {
      if (!row.profile.isCapacityConstrained) continue;
      for (const allocation of row.bucketAllocations) {
        const key = `${row.resourceCode}|${dateKey(allocation.bucketStart)}`;
        currentByBucket.set(key, round(number(currentByBucket.get(key)) + number(allocation.hours)));
      }
    }

    const calculatedBuckets = [];
    for (const resource of resources.values()) {
      for (const range of bucketRanges) {
        const key = `${resource.resourceCode}|${dateKey(range.start)}`;
        const profileCapacities = resource.profiles.map((profile) => {
          if (!profile.isCapacityConstrained) return Number.POSITIVE_INFINITY;
          const overrides = overridesByMachine.get(profile.machineId) || [];
          const days = workingDaysInPeriod(range.start, range.end, { calendarMode: profile.calendarMode, shiftsPerDay: profile.shiftsPerDay, overrides });
          return availableCapacityHours(profile, days);
        });
        const finiteCapacities = profileCapacities.filter(Number.isFinite);
        const availableCapacity = finiteCapacities.length ? Math.min(...finiteCapacities) : 0;
        const currentMpsLoad = number(currentByBucket.get(key));
        const existingLoad = number(existingBucketLoads.get(key));
        const calculation = calculateRccpLoad({
          mpsQty: 1, standardTimeHours: currentMpsLoad, existingLoad, availableCapacity,
          warningThreshold: configuration.warningThreshold, overloadThreshold: configuration.overloadThreshold,
        });
        calculatedBuckets.push({
          resourceCode: resource.resourceCode,
          resourceName: resource.resourceName,
          resourceType: resource.resourceType,
          bucketStart: range.start,
          bucketEnd: range.end,
          ...calculation,
          isPreviousMonth: range.start < mpsMonthStart,
        });
      }
    }

    for (const row of offsetRows) {
      const impactedBuckets = calculatedBuckets.filter((item) => item.resourceCode === row.resourceCode
        && row.bucketAllocations.some((allocation) => dateKey(allocation.bucketStart) === dateKey(item.bucketStart)));
      row.loadPercentage = Math.max(0, ...impactedBuckets.map((bucket) => number(bucket.loadPercentage)));
      row.status = worstCapacityStatus(impactedBuckets.map((bucket) => bucket.status));
    }

    await tx.rccpRun.updateMany({
      where: { mpsId: doc.id, invalidatedAt: null },
      data: { status: "INVALID", invalidatedAt: new Date(), invalidationReason: "Digantikan RCCP time-phased run terbaru." },
    });
    const totalMpsQty = round(positiveDetails.reduce((sum, row) => sum + number(row.qtyPlanned), 0));
    const phaseSummary = phaseRows.map(({ detail, phase, resourceRequirements }) => ({
      mpsDetailId: detail.id, partCode: detail.partCode, phaseId: phase.id, phaseNumber: phase.phaseNumber,
      qty: phase.qty, requiredDate: phase.fgRequiredDate, sourceType: phase.sourceType, sourceNumber: phase.sourceNumber || null,
      demandQty: phase.demandQty ?? phase.qty,
      customerProductionQty: phase.customerProductionQty ?? null,
      bufferAllocatedQty: phase.bufferAllocatedQty ?? null,
      isBuffer: Boolean(phase.isBuffer),
      resourceRequirements: resourceRequirements.map((requirement) => ({
        resourceCode: requirement.profile.resourceCode,
        qty: requirement.qty,
        source: requirement.source,
        trace: requirement.trace,
      })),
    }));
    const run = await tx.rccpRun.create({
      data: {
        mpsId: doc.id, mpsRevision: doc.revision, planningPeriod: doc.periodStart,
        status: "RUNNING", overallLoadStatus: "RUNNING",
        warningThreshold: configuration.warningThreshold, overloadThreshold: configuration.overloadThreshold,
        mpsQtySnapshot: totalMpsQty, calculatedBy: actor(options.runBy), earliestStartDate, latestRequiredDate,
        capacityHorizonStart, capacityHorizonEnd, hasPreviousMonthLoad, offsetStatus: hasPreviousMonthLoad ? "PREVIOUS_MONTH_REQUIRED" : "SAME_MONTH",
        requestOptions: { ...runOptions, searchWindowDays: configuration.previousSearchWindowDays }, phaseSummary,
      },
    });

    await tx.rccpTimeBucket.createMany({
      data: calculatedBuckets.map((bucket) => ({
        rccpRunId: run.id, resourceCode: bucket.resourceCode, resourceName: bucket.resourceName,
        resourceType: bucket.resourceType, bucketType: "WEEKLY", bucketStart: bucket.bucketStart, bucketEnd: bucket.bucketEnd,
        currentMpsLoad: bucket.currentMpsLoad, existingLoad: bucket.existingLoad, availableCapacity: bucket.availableCapacity,
        totalLoad: bucket.totalLoad, loadPercentage: bucket.loadPercentage, status: bucket.status, isPreviousMonth: bucket.isPreviousMonth,
      })),
    });

    await tx.rccpOffsetDetail.createMany({
      data: offsetRows.map((row) => ({
        rccpRunId: run.id, mpsDetailId: row.detail.id, mpsPhaseId: row.phase.id, partCode: row.detail.partCode,
        phaseQty: row.phase.qty, resourceProfileId: row.profile.id, resourceCode: row.resourceCode, resourceName: row.resourceName,
        sequence: row.sequence, resourceType: row.resourceType, requiredDate: row.requiredDate,
        calculatedStartDate: row.calculatedStartDate, calculatedFinishDate: row.calculatedFinishDate,
        leadTimeValue: row.profile.leadTimeValue, leadTimeUnit: row.profile.leadTimeUnit,
        calendarId: row.calendarId, requiredCapacityHours: row.requiredCapacityHours,
        loadPercentage: row.loadPercentage, status: row.status,
      })),
    });

    const calculatedLoads = [];
    for (const resource of resources.values()) {
      const buckets = calculatedBuckets.filter((bucket) => bucket.resourceCode === resource.resourceCode);
      const resourceOffsets = offsetRows.filter((row) => row.resourceCode === resource.resourceCode);
      const currentMpsLoad = round(buckets.reduce((sum, row) => sum + row.currentMpsLoad, 0));
      const existingLoad = round(buckets.reduce((sum, row) => sum + row.existingLoad, 0));
      const availableCapacity = round(buckets.reduce((sum, row) => sum + row.availableCapacity, 0));
      const totalLoad = round(currentMpsLoad + existingLoad);
      const loadPercentage = availableCapacity > EPSILON ? round(totalLoad / availableCapacity * 100, 4) : 0;
      const status = worstCapacityStatus(buckets.filter((bucket) => bucket.currentMpsLoad > EPSILON).map((bucket) => bucket.status));
      const partBreakdown = resourceOffsets.map((row) => ({
        mpsDetailId: row.detail.id, partId: row.detail.partId, partCode: row.detail.partCode,
        partNumber: row.detail.part?.partNumber || row.detail.partCode, partName: row.detail.part?.partName || row.detail.partCode,
        mpsPhaseId: row.phase.id, phaseQty: row.phase.qty, resourceRequirementQty: row.resourceRequirementQty,
        phaseNumber: row.phase.phaseNumber, sourceType: row.phase.sourceType,
        sourceNumber: row.phase.sourceNumber || null,
        nettingSource: row.nettingSource, nettingTrace: row.nettingTrace, requiredDate: row.requiredDate,
        bucketAllocations: row.bucketAllocations,
        calculatedStartDate: row.calculatedStartDate, calculatedFinishDate: row.calculatedFinishDate,
        standardTimeHours: row.profile.standardTimeHours, setupTimeHours: row.profile.setupTimeHours,
        leadTimeValue: row.profile.leadTimeValue, leadTimeUnit: row.profile.leadTimeUnit,
        sequence: row.profile.sequence, resourceType: row.resourceType, calendarId: row.calendarId,
        requiredCapacityHours: row.requiredCapacityHours,
      }));
      const saved = await tx.rccpLoad.create({
        data: {
          rccpRunId: run.id, resourceProfileId: resource.profile.id, resourceCode: resource.resourceCode,
          resourceName: resource.resourceName, resourceType: resource.resourceType,
          standardTimeHours: round(resource.profiles.reduce((sum, profile) => sum + number(profile.standardTimeHours), 0)),
          setupTimeHours: round(resource.profiles.reduce((sum, profile) => sum + number(profile.setupTimeHours), 0)),
          currentMpsLoad, existingLoad, availableCapacity, totalLoad, loadPercentage, status,
          workingDays: workingDaysInPeriod(capacityHorizonStart, capacityHorizonEnd, { calendarMode: resource.profile.calendarMode, shiftsPerDay: resource.profile.shiftsPerDay, overrides: overridesByMachine.get(resource.profile.machineId) || [] }),
          shiftsPerDay: resource.profile.shiftsPerDay, effectiveHoursPerShift: resource.profile.effectiveHoursPerShift,
          resourceCount: resource.profile.resourceCount, efficiencyPercent: resource.profile.efficiencyPercent,
          plannedDowntimeHours: resource.profile.plannedDowntimeHours, partBreakdown,
          loadDate: resourceOffsets.reduce((min, row) => !min || row.calculatedStartDate < min ? row.calculatedStartDate : min, null),
          bucketType: "WEEKLY", bucketStart: buckets[0]?.bucketStart || null, bucketEnd: buckets.at(-1)?.bucketEnd || null,
        },
      });
      calculatedLoads.push(saved);
    }

    const recommendationRows = [];
    if (runOptions.searchAlternativeStart) {
      for (const row of offsetRows.filter((item) => item.status === "OVERLOAD" && item.bucketAllocations.length === 1)) {
        const originalBucketKey = dateKey(weekStart(row.calculatedStartDate));
        const resource = resources.get(row.resourceCode);
        const recommendation = findEarlierFeasibleStart({
          originalStartDate: row.calculatedStartDate,
          currentRequirement: row.requiredCapacityHours,
          searchWindowDays: configuration.previousSearchWindowDays,
          overloadThreshold: configuration.overloadThreshold,
          calendar: { calendarMode: row.profile.calendarMode, shiftsPerDay: row.profile.shiftsPerDay, useWorkingCalendar: runOptions.useWorkingCalendar, overrides: overridesByMachine.get(row.profile.machineId) || [] },
          capacityAt: (candidate) => {
            const candidateStart = weekStart(candidate);
            const candidateKey = dateKey(candidateStart);
            if (candidateKey === originalBucketKey) return { availableCapacity: 0, existingLoad: 0 };
            const rangeEnd = new Date(candidateStart); rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 6);
            const days = workingDaysInPeriod(candidateStart, rangeEnd, { calendarMode: resource.profile.calendarMode, shiftsPerDay: resource.profile.shiftsPerDay, overrides: overridesByMachine.get(resource.profile.machineId) || [] });
            return {
              availableCapacity: availableCapacityHours(resource.profile, days),
              existingLoad: number(existingBucketLoads.get(`${row.resourceCode}|${candidateKey}`)) + number(currentByBucket.get(`${row.resourceCode}|${candidateKey}`)),
            };
          },
        });
        if (recommendation) recommendationRows.push({ row, recommendation });
      }
    }
    if (recommendationRows.length) {
      await tx.rccpRecommendation.createMany({
        data: recommendationRows.map(({ row, recommendation }) => ({
          rccpRunId: run.id, mpsDetailId: row.detail.id, mpsPhaseId: row.phase.id,
          resourceCode: row.resourceCode, alternateResourceCode: row.profile.alternateResourceCode,
          originalStartDate: row.calculatedStartDate, recommendedStartDate: recommendation.recommendedStartDate,
          originalLoadPercentage: row.loadPercentage, recommendedLoadPercentage: recommendation.recommendedLoadPercentage,
          recommendationType: "EARLIER_START",
          reason: `Bucket ${row.resourceCode} pada ${dateKey(row.calculatedStartDate)} overload. Produksi tetap memenuhi FG ${dateKey(row.requiredDate)} jika load dialokasikan mulai ${dateKey(recommendation.recommendedStartDate)}.`,
        })),
      });
    }

    const overall = worstCapacityStatus(calculatedLoads.map((load) => load.status));
    const previousStatuses = calculatedBuckets.filter((bucket) => bucket.isPreviousMonth && bucket.currentMpsLoad > EPSILON).map((bucket) => bucket.status);
    const offsetStatus = capacityOffsetStatus(hasPreviousMonthLoad, previousStatuses);
    const capacityExceptions = calculatedBuckets
      .filter((bucket) => bucket.currentMpsLoad > EPSILON && ["WARNING", "OVERLOAD"].includes(bucket.status))
      .map((bucket) => ({
        code: bucket.status === "OVERLOAD" ? "CAPACITY_OVERLOAD" : "CAPACITY_WARNING",
        resourceCode: bucket.resourceCode, bucketStart: bucket.bucketStart, bucketEnd: bucket.bucketEnd,
        loadPercentage: bucket.loadPercentage,
        message: `${bucket.resourceCode} · minggu ${dateKey(bucket.bucketStart)}: load ${bucket.loadPercentage}% dari ${bucket.availableCapacity} jam.`,
      }));
    const partSummaries = positiveDetails.map((detail) => {
      const rows = offsetRows.filter((row) => row.detail.id === detail.id);
      return {
        partCode: detail.partCode, partNumber: detail.part?.partNumber || detail.partCode,
        partName: detail.part?.partName || detail.partCode, mpsQty: round(detail.qtyPlanned),
        capacityStatus: worstCapacityStatus(rows.map((row) => row.status)),
        maxLoadPercentage: round(Math.max(0, ...rows.map((row) => number(row.loadPercentage))), 4),
        resourceCodes: [...new Set(rows.map((row) => row.resourceCode))],
        earliestStartDate: rows.reduce((min, row) => !min || row.calculatedStartDate < min ? row.calculatedStartDate : min, null),
        latestRequiredDate: rows.reduce((max, row) => !max || row.requiredDate > max ? row.requiredDate : max, null),
      };
    });
    const completed = await tx.rccpRun.update({
      where: { id: run.id },
      data: { status: overall, overallLoadStatus: overall, offsetStatus, partSummaries, exceptions: capacityExceptions, completedAt: new Date() },
      include: {
        loads: { orderBy: { loadPercentage: "desc" } }, overrides: true,
        timeBuckets: { orderBy: [{ bucketStart: "asc" }, { resourceCode: "asc" }] },
        offsetDetails: { orderBy: [{ requiredDate: "asc" }, { sequence: "asc" }] },
        recommendations: { orderBy: { createdAt: "asc" } },
      },
    });
    await tx.mPS.update({
      where: { id: doc.id },
      data: {
        capacityStatus: overall, capacityCheckedAt: new Date(), capacityCheckedBy: actor(options.runBy),
        rccpInvalidatedAt: null, rccpInvalidationReason: null,
        lifecycleStatus: overall === "FEASIBLE" ? "CAPACITY_CHECKED" : "CALCULATED",
      },
    });
    return { ...completed, approvalAllowed: overall === "FEASIBLE" };
  }, { timeout: 60000 });
}

async function acknowledgeWarning(prisma, runId, input = {}) {
  const reason = String(input.reason || "").trim();
  if (reason.length < 5) throw Object.assign(new Error("Alasan acknowledgement minimal 5 karakter."), { statusCode: 400, code: "RCCP_REASON_REQUIRED" });
  return prisma.$transaction(async (tx) => {
    const run = await tx.rccpRun.findFirst({ where: { id: runId, invalidatedAt: null }, include: { mps: true } });
    if (!run) throw Object.assign(new Error("RCCP run tidak ditemukan atau sudah invalid."), { statusCode: 404, code: "RCCP_NOT_FOUND" });
    if (run.status !== "WARNING") throw Object.assign(new Error(`RCCP ${run.status} tidak memerlukan acknowledgement warning.`), { statusCode: 409, code: "RCCP_ACK_NOT_ALLOWED" });
    if (run.mpsRevision !== run.mps.revision) throw validationError([{ code: "MPS_CHANGED_AFTER_RCCP", message: "MPS berubah setelah RCCP; jalankan capacity check ulang." }]);
    await tx.rccpRun.update({ where: { id: run.id }, data: { acknowledgedBy: actor(input.runBy), acknowledgedAt: new Date(), acknowledgedReason: reason } });
    await tx.mPS.update({ where: { id: run.mpsId }, data: { capacityStatus: "WARNING", lifecycleStatus: "CAPACITY_CHECKED", capacityCheckedBy: actor(input.runBy), capacityCheckedAt: new Date() } });
    return latestRccpForMps(tx, run.mpsId);
  });
}

async function overrideOverload(prisma, runId, input = {}) {
  const reason = String(input.reason || "").trim();
  if (reason.length < 5) throw Object.assign(new Error("Alasan authorized override minimal 5 karakter."), { statusCode: 400, code: "RCCP_REASON_REQUIRED" });
  return prisma.$transaction(async (tx) => {
    const run = await tx.rccpRun.findFirst({ where: { id: runId, invalidatedAt: null }, include: { mps: true } });
    if (!run) throw Object.assign(new Error("RCCP run tidak ditemukan atau sudah invalid."), { statusCode: 404, code: "RCCP_NOT_FOUND" });
    if (run.status !== "OVERLOAD") throw Object.assign(new Error(`RCCP ${run.status} tidak dapat dioverride.`), { statusCode: 409, code: "RCCP_OVERRIDE_NOT_ALLOWED" });
    if (run.mpsRevision !== run.mps.revision) throw validationError([{ code: "MPS_CHANGED_AFTER_RCCP", message: "MPS berubah setelah RCCP; jalankan capacity check ulang." }]);
    await tx.rccpOverride.create({ data: { rccpRunId: run.id, reason, approvedBy: actor(input.runBy) } });
    await tx.rccpRun.update({ where: { id: run.id }, data: { status: "OVERRIDDEN" } });
    await tx.mPS.update({ where: { id: run.mpsId }, data: { capacityStatus: "OVERRIDDEN", lifecycleStatus: "CAPACITY_CHECKED", capacityCheckedBy: actor(input.runBy), capacityCheckedAt: new Date() } });
    return latestRccpForMps(tx, run.mpsId);
  });
}

async function applyRecommendation(prisma, runId, recommendationId, input = {}) {
  return prisma.$transaction(async (tx) => {
    const recommendation = await tx.rccpRecommendation.findFirst({
      where: { id: recommendationId, rccpRunId: runId },
      include: { run: { include: { mps: true } } },
    });
    if (!recommendation) throw Object.assign(new Error("Recommendation RCCP tidak ditemukan."), { statusCode: 404, code: "RCCP_RECOMMENDATION_NOT_FOUND" });
    if (recommendation.status !== "PROPOSED") throw Object.assign(new Error("Recommendation sudah diproses."), { statusCode: 409, code: "RCCP_RECOMMENDATION_ALREADY_APPLIED" });
    if (recommendation.run.invalidatedAt) throw Object.assign(new Error("RCCP run sudah invalid."), { statusCode: 409, code: "RCCP_INVALID" });

    const detail = await tx.rccpOffsetDetail.findFirst({
      where: {
        rccpRunId: runId, mpsDetailId: recommendation.mpsDetailId,
        mpsPhaseId: recommendation.mpsPhaseId, resourceCode: recommendation.resourceCode,
        calculatedStartDate: recommendation.originalStartDate,
      },
    });
    if (!detail) throw Object.assign(new Error("Offset detail untuk recommendation tidak ditemukan."), { statusCode: 409, code: "RCCP_OFFSET_DETAIL_NOT_FOUND" });
    const oldBucketStart = weekStart(detail.calculatedStartDate);
    const newBucketStart = weekStart(recommendation.recommendedStartDate);
    const buckets = await tx.rccpTimeBucket.findMany({
      where: { rccpRunId: runId, resourceCode: detail.resourceCode, bucketStart: { in: [oldBucketStart, newBucketStart] } },
    });
    const oldBucket = buckets.find((row) => dateKey(row.bucketStart) === dateKey(oldBucketStart));
    let newBucket = buckets.find((row) => dateKey(row.bucketStart) === dateKey(newBucketStart));
    if (!oldBucket) throw Object.assign(new Error("Bucket asal recommendation tidak ditemukan. Jalankan RCCP ulang."), { statusCode: 409, code: "RCCP_RECOMMENDATION_SOURCE_BUCKET_MISSING" });
    if (!newBucket) {
      const profile = detail.resourceProfileId ? await tx.rccpResourceProfile.findFirst({ where: { id: detail.resourceProfileId } }) : null;
      if (!profile) throw Object.assign(new Error("Resource profile recommendation tidak ditemukan."), { statusCode: 409, code: "RCCP_RECOMMENDATION_PROFILE_MISSING" });
      const newBucketEnd = new Date(newBucketStart); newBucketEnd.setUTCDate(newBucketEnd.getUTCDate() + 6);
      const calendarOverrides = profile.machineId ? await tx.capacityCalendarOverride.findMany({
        where: { machineId: profile.machineId, scheduleDate: { gte: newBucketStart, lte: newBucketEnd }, isDeleted: false },
        select: { scheduleDate: true, dayStatus: true, shiftsPerDay: true },
      }) : [];
      const days = workingDaysInPeriod(newBucketStart, newBucketEnd, { calendarMode: profile.calendarMode, shiftsPerDay: profile.shiftsPerDay, overrides: calendarOverrides });
      const availableCapacity = availableCapacityHours(profile, days);
      const otherRuns = await tx.rccpRun.findMany({
        where: { id: { not: runId }, mpsId: { not: recommendation.run.mpsId }, invalidatedAt: null, status: { in: VALID_RESULT_STATUSES } },
        include: { timeBuckets: { where: { resourceCode: detail.resourceCode, bucketStart: newBucketStart } } },
        orderBy: { createdAt: "desc" },
      });
      const latestByMps = new Map();
      otherRuns.forEach((row) => { if (!latestByMps.has(row.mpsId)) latestByMps.set(row.mpsId, row); });
      const existingLoad = round([...latestByMps.values()].reduce((sum, row) => sum + number(row.timeBuckets[0]?.currentMpsLoad), 0));
      const existingPercentage = availableCapacity > EPSILON ? round(existingLoad / availableCapacity * 100, 4) : 0;
      newBucket = await tx.rccpTimeBucket.create({
        data: {
          rccpRunId: runId, resourceCode: detail.resourceCode, resourceName: detail.resourceName,
          resourceType: detail.resourceType, bucketType: "WEEKLY", bucketStart: newBucketStart, bucketEnd: newBucketEnd,
          currentMpsLoad: 0, existingLoad, availableCapacity, totalLoad: existingLoad,
          loadPercentage: existingPercentage, status: capacityStatusForLoad(existingPercentage, recommendation.run),
          isPreviousMonth: newBucketStart < utcDate(recommendation.run.planningPeriod),
        },
      });
    }

    const updateBucket = async (bucket, delta) => {
      const currentMpsLoad = round(Math.max(number(bucket.currentMpsLoad) + delta, 0));
      const totalLoad = round(number(bucket.existingLoad) + currentMpsLoad);
      const loadPercentage = number(bucket.availableCapacity) > EPSILON ? round(totalLoad / number(bucket.availableCapacity) * 100, 4) : 0;
      const status = capacityStatusForLoad(loadPercentage, recommendation.run);
      return tx.rccpTimeBucket.update({ where: { id: bucket.id }, data: { currentMpsLoad, totalLoad, loadPercentage, status } });
    };
    await updateBucket(oldBucket, -number(detail.requiredCapacityHours));
    await updateBucket(newBucket, number(detail.requiredCapacityHours));
    const calendarDelta = utcDate(recommendation.recommendedStartDate).getTime() - utcDate(detail.calculatedStartDate).getTime();
    const shiftedFinish = new Date(utcDate(detail.calculatedFinishDate).getTime() + calendarDelta);
    await tx.rccpOffsetDetail.update({
      where: { id: detail.id },
      data: {
        calculatedStartDate: recommendation.recommendedStartDate,
        calculatedFinishDate: shiftedFinish,
        loadPercentage: recommendation.recommendedLoadPercentage,
        status: capacityStatusForLoad(recommendation.recommendedLoadPercentage, recommendation.run),
      },
    });
    await tx.rccpRecommendation.update({
      where: { id: recommendation.id },
      data: { status: "APPLIED", appliedBy: actor(input.runBy), appliedAt: new Date() },
    });

    const resourceBuckets = await tx.rccpTimeBucket.findMany({ where: { rccpRunId: runId, resourceCode: detail.resourceCode } });
    const resourceStatus = worstCapacityStatus(resourceBuckets.filter((row) => row.currentMpsLoad > EPSILON).map((row) => row.status));
    const resourceCurrent = round(resourceBuckets.reduce((sum, row) => sum + number(row.currentMpsLoad), 0));
    const resourceExisting = round(resourceBuckets.reduce((sum, row) => sum + number(row.existingLoad), 0));
    const resourceCapacity = round(resourceBuckets.reduce((sum, row) => sum + number(row.availableCapacity), 0));
    await tx.rccpLoad.updateMany({
      where: { rccpRunId: runId, resourceCode: detail.resourceCode },
      data: {
        currentMpsLoad: resourceCurrent, existingLoad: resourceExisting,
        availableCapacity: resourceCapacity, totalLoad: round(resourceCurrent + resourceExisting),
        loadPercentage: resourceCapacity > EPSILON ? round((resourceCurrent + resourceExisting) / resourceCapacity * 100, 4) : 0,
        status: resourceStatus, loadDate: recommendation.recommendedStartDate,
      },
    });
    const allBuckets = await tx.rccpTimeBucket.findMany({ where: { rccpRunId: runId } });
    const overall = worstCapacityStatus(allBuckets.filter((row) => row.currentMpsLoad > EPSILON).map((row) => row.status));
    const previousStatuses = allBuckets.filter((row) => row.isPreviousMonth && row.currentMpsLoad > EPSILON).map((row) => row.status);
    const hasPreviousMonthLoad = recommendation.run.hasPreviousMonthLoad || recommendation.recommendedStartDate < utcDate(recommendation.run.planningPeriod);
    await tx.rccpRun.update({
      where: { id: runId },
      data: {
        status: overall, overallLoadStatus: overall,
        hasPreviousMonthLoad,
        offsetStatus: capacityOffsetStatus(hasPreviousMonthLoad, previousStatuses),
        earliestStartDate: recommendation.recommendedStartDate < recommendation.run.earliestStartDate ? recommendation.recommendedStartDate : recommendation.run.earliestStartDate,
        capacityHorizonStart: recommendation.recommendedStartDate < recommendation.run.capacityHorizonStart ? recommendation.recommendedStartDate : recommendation.run.capacityHorizonStart,
      },
    });
    await tx.mPS.update({
      where: { id: recommendation.run.mpsId },
      data: { capacityStatus: overall, lifecycleStatus: overall === "FEASIBLE" ? "CAPACITY_CHECKED" : "CALCULATED", capacityCheckedAt: new Date(), capacityCheckedBy: actor(input.runBy) },
    });
    return latestRccpForMps(tx, recommendation.run.mpsId);
  });
}

async function assertMpsApprovalAllowed(tx, doc) {
  const latest = await latestRccpForMps(tx, doc.id);
  if (!latest) throw Object.assign(new Error("Approve MPS diblokir: jalankan RCCP terlebih dahulu."), { statusCode: 409, code: "RCCP_REQUIRED" });
  if (latest.mpsRevision !== doc.revision) throw validationError([{ code: "MPS_CHANGED_AFTER_RCCP", message: "MPS berubah setelah RCCP; jalankan capacity check ulang." }]);
  const partIds = [...new Set(latest.loads.flatMap((load) => (Array.isArray(load.partBreakdown) ? load.partBreakdown : []).map((part) => part.partId)).filter(Boolean))];
  const resourceCodes = [...new Set(latest.loads.map((load) => load.resourceCode))];
  const profiles = partIds.length ? await tx.rccpResourceProfile.findMany({
    where: { partId: { in: partIds }, resourceCode: { in: resourceCodes } },
  }) : [];
  const machineIds = [...new Set(profiles.map((profile) => profile.machineId).filter(Boolean))];
  const freshnessStart = latest.capacityHorizonStart || doc.periodStart;
  const freshnessEnd = latest.capacityHorizonEnd || doc.periodEnd;
  const calendarOverrides = machineIds.length ? await tx.capacityCalendarOverride.findMany({
    where: { machineId: { in: machineIds }, scheduleDate: { gte: freshnessStart, lte: freshnessEnd }, isDeleted: false },
    select: { machineId: true, scheduleDate: true, dayStatus: true, shiftsPerDay: true },
  }) : [];
  let capacityChanged = false;
  for (const load of latest.loads) {
    const breakdown = Array.isArray(load.partBreakdown) ? load.partBreakdown : [];
    const loadProfiles = breakdown.map((part) => profiles.find((profile) => profile.partId === part.partId && profile.resourceCode === load.resourceCode));
    if (loadProfiles.some((profile) => !profile || !profile.isActive || !profile.isCritical)) { capacityChanged = true; break; }
    if (breakdown.some((part, index) => Math.abs(number(loadProfiles[index].standardTimeHours) - number(part.standardTimeHours)) > EPSILON
      || Math.abs(number(loadProfiles[index].setupTimeHours) - number(part.setupTimeHours)) > EPSILON
      || number(loadProfiles[index].sequence) !== number(part.sequence)
      || String(loadProfiles[index].resourceType || "INTERNAL") !== String(part.resourceType || "INTERNAL")
      || Math.abs(number(loadProfiles[index].leadTimeValue) - number(part.leadTimeValue)) > EPSILON
      || String(loadProfiles[index].leadTimeUnit || "WORKING_DAY") !== String(part.leadTimeUnit || "WORKING_DAY")
      || resolvedCalendarId(loadProfiles[index]) !== String(part.calendarId || ""))) { capacityChanged = true; break; }
    const currentAvailable = capacityForProfilesAcrossBuckets(loadProfiles, freshnessStart, freshnessEnd, calendarOverrides);
    if (!Number.isFinite(currentAvailable) || Math.abs(currentAvailable - number(load.availableCapacity)) > EPSILON) { capacityChanged = true; break; }
  }
  const currentSettings = await settings(tx);
  const thresholdChanged = Math.abs(currentSettings.warningThreshold - number(latest.warningThreshold)) > EPSILON
    || Math.abs(currentSettings.overloadThreshold - number(latest.overloadThreshold)) > EPSILON;
  if (capacityChanged || thresholdChanged) {
    await invalidateRccp(tx, doc.id, "Capacity profile/calendar/threshold berubah setelah RCCP; capacity check wajib diulang.", { incrementRevision: false });
    throw validationError([{ code: "CAPACITY_CHANGED_AFTER_RCCP", message: "Master capacity berubah setelah RCCP; jalankan capacity check ulang sebelum approve MPS." }]);
  }
  if (!latest.approvalAllowed) {
    const message = latest.status === "WARNING"
      ? "RCCP WARNING wajib di-acknowledge sebelum MPS di-approve."
      : "RCCP OVERLOAD memblokir approval. Revisi MPS atau lakukan authorized override.";
    throw Object.assign(new Error(message), { statusCode: 409, code: "RCCP_APPROVAL_BLOCKED", rccp: latest });
  }
  return latest;
}

async function invalidateRccp(tx, mpsId, reason, options = {}) {
  const now = new Date();
  await tx.rccpRun.updateMany({
    where: { mpsId, invalidatedAt: null },
    data: { status: "INVALID", invalidatedAt: now, invalidationReason: reason },
  });
  return tx.mPS.update({
    where: { id: mpsId },
    data: {
      ...(options.incrementRevision === false ? {} : { revision: { increment: 1 } }),
      capacityStatus: "NOT_CHECKED",
      capacityCheckedAt: null,
      capacityCheckedBy: null,
      rccpInvalidatedAt: now,
      rccpInvalidationReason: reason,
      lifecycleStatus: "CALCULATED",
      approvedBy: null,
      approvedDate: null,
    },
  });
}

async function invalidateRccpByMachineCalendar(tx, machineId, scheduleDate) {
  const profiles = await tx.rccpResourceProfile.findMany({ where: { machineId, isActive: true }, select: { id: true } });
  if (!profiles.length) return 0;
  const runs = await tx.rccpRun.findMany({
    where: {
      invalidatedAt: null,
      capacityHorizonStart: { lte: scheduleDate }, capacityHorizonEnd: { gte: scheduleDate },
      loads: { some: { resourceProfileId: { in: profiles.map((row) => row.id) } } },
    },
    select: { mpsId: true },
  });
  const mpsIds = [...new Set(runs.map((row) => row.mpsId))];
  for (const mpsId of mpsIds) await invalidateRccp(tx, mpsId, "RCCP_INVALID_CAPACITY_CHANGED", { incrementRevision: false });
  return mpsIds.length;
}

module.exports = {
  capacityStatusForLoad,
  worstCapacityStatus,
  workingDaysInPeriod,
  availableCapacityHours,
  capacityForProfilesAcrossBuckets,
  calculateRccpLoad,
  profileMatchesProcess,
  resourceRequirementForPhase,
  runRccp,
  latestRccpForMps,
  acknowledgeWarning,
  overrideOverload,
  applyRecommendation,
  assertMpsApprovalAllowed,
  invalidateRccp,
  invalidateRccpByMachineCalendar,
};
