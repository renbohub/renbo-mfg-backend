const { prisma } = require("../../index");
const { createAiDraftService } = require("../../services/ai/aiDraftService");
const aiDraftService = createAiDraftService({ prisma });
const { assertApprovedCurrentMrp } = require("../../services/planning/mrpLifecycleService");
const { procurementSchedule } = require("../../services/planning/procurementSchedulingService");
const { resolveProductionRequirementDates } = require("../../services/planning/mrpDueDateService");
const {
  loadDemandPlanningConstraintMap,
  leadTimeControls,
  procurementPolicyFromDecision,
  applyDecisionToRoutingMetric,
} = require("../../services/planning/demandPlanningConstraintService");
const { allocatePurchaseQtyToSources, applyConfirmedMoqPullForward, applyMoqCarryForward, buildMoqAllocationCandidates } = require("../../services/purchasing/purchaseSuggestionAllocationService");
const { resolveEffectiveRecord, legacyPriceValue } = require("../../services/pricing/effectivePriceService");
const {
  resolveBomPurchaseDefaults,
  resolvePurchaseSuggestionSupplierMaster,
  findPricedPurchaseSuggestionSupplierMaster,
} = require("../../services/purchasing/purchaseSuggestionMasterDataService");
const {
  mergePrimaryAndSplitSupplierAllocations,
  sumSupplierAllocationQty,
} = require("../../services/purchasing/purchaseSuggestionSupplierSplitService");

const ACTIVE_PO_STATUSES = [
  "Draft", "Submitted", "Approved", "Sent", "Confirmed", "Partial Receipt",
  "Checking by Operational Manager", "Checking by Engineering Manager", "Checking by Sacho",
];
const CONFIRMED_STATUSES = new Set([
  "Available", "Partially Available", "Alternative Quantity Offered",
  "Alternative Delivery Date", "Confirmed",
]);
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const text = (value) => String(value ?? "").trim() || null;
const optionalNumber = (value) => value === undefined || value === null || String(value).trim() === ""
  ? null
  : number(value);
const date = (value) => value ? new Date(value) : null;
const day = (value) => new Date(value).toISOString().slice(0, 10);
const unique = (values) => [...new Set(values.filter(Boolean))];
const round = (value) => Number(number(value).toFixed(6));
const WORKING_HOURS_PER_DAY = 8;
const PR_CATEGORY = Object.freeze({
  ASSET: { code: "ASSET", label: "PR-Asset", procurementGroup: "ASSET", poType: "Asset" },
  CONSUMABLE: { code: "CONSUMABLE", label: "PR-Consumable", procurementGroup: "CONSUMABLE", poType: "Consumable" },
  MAINTENANCE: { code: "MAINTENANCE", label: "PR-Maintenance", procurementGroup: "MAINTENANCE", poType: "Maintenance" },
  RAW_MATERIAL: { code: "RAW_MATERIAL", label: "PR-Raw_Material", procurementGroup: "MATERIAL", poType: "Material" },
  PURCHASE_PART: { code: "PURCHASE_PART", label: "PR-Purchase-Part", procurementGroup: "PURCHASE_PART", poType: "Part" },
  VENDOR_PROCESS: { code: "VENDOR_PROCESS", label: "PR-Vendor-Proses", procurementGroup: "VENDOR_PROCESS", poType: "Out Process" },
  SERVICES: { code: "SERVICES", label: "PR-Services", procurementGroup: "SERVICES", poType: "Service" },
  OTHER: { code: "OTHER", label: "PR-Other", procurementGroup: "NON_PRODUCTION", poType: "Other" },
});

function resolvePrCategory(item = {}) {
  const hint = String(item.procurementCategory || item.category || item.itemCategory || "")
    .trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (item.materialCode || ["MATERIAL", "RAW", "RAW_MATERIAL"].includes(hint)) return PR_CATEGORY.RAW_MATERIAL;
  if (["ASSET", "FIXED_ASSET"].includes(hint)) return PR_CATEGORY.ASSET;
  if (["CONSUMABLE", "CONSUMABLES"].includes(hint)) return PR_CATEGORY.CONSUMABLE;
  if (["MAINTENANCE", "MRO"].includes(hint)) return PR_CATEGORY.MAINTENANCE;
  if (["VENDOR", "VENDOR_PROCESS", "OUT_PROCESS", "SUBCONTRACT"].includes(hint)) return PR_CATEGORY.VENDOR_PROCESS;
  if (["SERVICE", "SERVICES"].includes(hint)) return PR_CATEGORY.SERVICES;
  if (["PURCHASE_PART", "PURCHASED_PART", "UNIVERSAL_PURCHASE_PART"].includes(hint) || item.partCode) return PR_CATEGORY.PURCHASE_PART;
  return PR_CATEGORY.OTHER;
}

// Shared with demand feasibility so Forecast warning and Purchase Suggestion
// use the exact same MBOM critical-path and per-process rounding logic.
exports.routingMetrics = routingMetrics;
exports.routingMetricsForRequests = routingMetricsForRequests;

function leadTimeHours(detail) {
  const value = number(detail?.leadTime);
  const unit = String(detail?.leadTimeUnit || "HOUR").toUpperCase();
  if (unit === "SECOND") return value / 3600;
  if (unit === "MINUTE") return value / 60;
  if (unit === "DAY") return value * 8;
  return value;
}

function roundedPurchaseQty(netRequirement, moq, orderMultiple) {
  const net = Math.max(number(netRequirement), 0);
  if (net <= 0) return 0;
  const minimum = Math.max(net, number(moq));
  const multiple = number(orderMultiple);
  return round(multiple > 0 ? Math.ceil(minimum / multiple) * multiple : minimum);
}

async function buildCapacityNeedDateMap(tx, run) {
  if (!run?.mpsNumber) return { byPhase: new Map(), byMpsDetail: new Map() };
  const plans = await tx.monthlyProductionPlan.findMany({
    where: {
      isDeleted: false,
      sourceType: `MPS:${run.mpsNumber}`,
      status: { not: "Cancelled" },
    },
    select: {
      details: { where: { isDeleted: false }, select: { lineNumber: true, mpsDetailId: true } },
      manualAllocations: {
        where: { isDeleted: false, status: { in: ["Draft", "Published"] }, planningMode: "PRODUCTION" },
        select: { lineNumber: true, scheduleDate: true, deliveryPhaseId: true },
      },
    },
  });
  const byPhase = new Map();
  const byMpsDetail = new Map();
  for (const plan of plans) {
    const detailIdByLine = new Map(plan.details.map((row) => [row.lineNumber, row.mpsDetailId]));
    for (const allocation of plan.manualAllocations) {
      const scheduleDate = new Date(allocation.scheduleDate);
      if (allocation.deliveryPhaseId) {
        const current = byPhase.get(allocation.deliveryPhaseId);
        if (!current || scheduleDate < current) byPhase.set(allocation.deliveryPhaseId, scheduleDate);
      }
      const mpsDetailId = detailIdByLine.get(allocation.lineNumber);
      if (mpsDetailId) {
        const current = byMpsDetail.get(mpsDetailId);
        if (!current || scheduleDate < current) byMpsDetail.set(mpsDetailId, scheduleDate);
      }
    }
  }
  return { byPhase, byMpsDetail };
}

async function nextSuggestionNumber(tx) {
  const key = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `PS-${key}-`;
  const latest = await tx.purchaseSuggestion.findFirst({
    where: { suggestionNumber: { startsWith: prefix } },
    orderBy: { suggestionNumber: "desc" },
    select: { suggestionNumber: true },
  });
  return `${prefix}${String(number(latest?.suggestionNumber?.match(/(\d+)$/)?.[1]) + 1).padStart(3, "0")}`;
}

async function nextPrNumber(tx) {
  const key = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `PR-PS-${key}-`;
  const latest = await tx.purchaseRequisition.findFirst({
    where: { prNumber: { startsWith: prefix } },
    orderBy: { prNumber: "desc" },
    select: { prNumber: true },
  });
  return `${prefix}${String(number(latest?.prNumber?.match(/(\d+)$/)?.[1]) + 1).padStart(3, "0")}`;
}

async function archiveSupersededSuggestionsForRun(tx, run) {
  const planningHeader = run.mpsNumber
    ? { mpsNumber: run.mpsNumber }
    : run.planNumber
      ? { planNumber: run.planNumber, ...(run.planScope ? { planScope: run.planScope } : {}) }
      : null;
  if (!planningHeader) return [];

  const siblingRuns = await tx.mRPRun.findMany({
    where: {
      ...planningHeader,
      runNumber: { not: run.runNumber },
    },
    select: { runNumber: true },
  });
  const siblingRunNumbers = siblingRuns.map((row) => row.runNumber).filter(Boolean);
  if (!siblingRunNumbers.length) return [];

  await tx.purchaseSuggestion.updateMany({
    where: { isDeleted: false, runNumber: { in: siblingRunNumbers } },
    data: { isDeleted: true },
  });
  return siblingRunNumbers;
}

async function routingMetrics(tx, mbomHeaderIds, qtyByHeader) {
  if (!mbomHeaderIds.length) return new Map();
  const headers = await tx.mBOMHeader.findMany({
    where: { id: { in: mbomHeaderIds }, isDeleted: false },
    select: {
      id: true,
      noReg: true,
      details: {
        where: { isDeleted: false },
        select: {
          id: true,
          parentDetailId: true,
          levelComponent: true,
          qty: true,
          category: true,
          leadTime: true,
          leadTimeUnit: true,
          part: { select: { partCode: true, partName: true } },
          mbomProcesses: {
            where: { isDeleted: false },
            select: {
              sequence: true,
              routingMode: true,
              cycleTime: true,
              process: { select: { processCode: true, processName: true } },
              vendor: { select: { vendorCode: true, vendorName: true, leadTimeDays: true } },
              routingOperation: { select: { sequence: true, setupMinutes: true, cycleSeconds: true, runMinutes: true, isSubcontract: true } },
            },
          },
        },
      },
    },
  });
  return new Map(headers.map((header) => {
    const scheduleQty = Math.max(number(qtyByHeader.get(header.id)), 1);
    const childrenByParent = new Map();
    for (const detail of header.details) {
      const parentKey = detail.parentDetailId || "ROOT";
      if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
      childrenByParent.get(parentKey).push(detail);
    }
    const summedComponentLeadHours = header.details.reduce((sum, detail) => sum + leadTimeHours(detail), 0);
    const evaluateDetail = (detail, parentQty, visiting = new Set()) => {
      if (visiting.has(detail.id)) throw Object.assign(new Error(`Siklus hirarki terdeteksi pada MBOM ${header.noReg}, detail ${detail.part?.partCode || detail.id}.`), { status: 409 });
      const nextVisiting = new Set(visiting).add(detail.id);
      const detailFactor = number(detail.qty) > 0 ? number(detail.qty) : 1;
      const processQty = round(parentQty * detailFactor);
      const childResults = (childrenByParent.get(detail.id) || []).map((child) => evaluateDetail(child, processQty, nextVisiting));
      const criticalChild = childResults.sort((left, right) => right.elapsedDays - left.elapsedDays)[0] || null;
      const own = {
        elapsedHours: 0, elapsedDays: 0, exactElapsedDays: 0, inhouseProcessHours: 0,
        inhouseScheduledDays: 0, vendorLeadTimeDays: 0, vendorScheduledDays: 0,
        setupMinutes: 0, setupHours: 0, cycleTimeSeconds: 0, cycleLoadHours: 0,
        routingRunHours: 0, fixedInhouseLeadHours: 0, processPath: [],
      };
      const processes = [...detail.mbomProcesses].sort((left, right) =>
        number(left.routingOperation?.sequence ?? left.sequence) - number(right.routingOperation?.sequence ?? right.sequence));
      for (const process of processes) {
        const routingMode = String(process.routingMode || "INHOUSE").toUpperCase();
        const vendorProcess = routingMode === "VENDOR" || detail.category === "Vendor" || Boolean(process.routingOperation?.isSubcontract);
        const sequence = number(process.routingOperation?.sequence ?? process.sequence);
        if (vendorProcess) {
          const fallbackVendorDays = String(detail.leadTimeUnit || "").toUpperCase() === "DAY"
            ? number(detail.leadTime)
            : leadTimeHours(detail) / WORKING_HOURS_PER_DAY;
          const vendorDays = Math.max(number(process.vendor?.leadTimeDays) || fallbackVendorDays, 0);
          const scheduledVendorDays = Math.ceil(vendorDays);
          own.vendorLeadTimeDays += vendorDays;
          own.vendorScheduledDays += scheduledVendorDays;
          own.elapsedHours += vendorDays * WORKING_HOURS_PER_DAY;
          own.exactElapsedDays += vendorDays;
          own.elapsedDays += scheduledVendorDays;
          own.processPath.push({
            detailCode: detail.part?.partCode || detail.id, detailName: detail.part?.partName || null,
            level: number(detail.levelComponent), sequence, processCode: process.process?.processCode || null,
            processName: process.process?.processName || "Vendor Process", mode: "VENDOR", qty: processQty,
            vendorCode: process.vendor?.vendorCode || null, vendorName: process.vendor?.vendorName || null,
            vendorLeadTimeDays: round(vendorDays), elapsedHours: round(vendorDays * WORKING_HOURS_PER_DAY),
            rawElapsedDays: round(vendorDays), elapsedDays: scheduledVendorDays,
          });
          continue;
        }
        const setupMinutes = number(process.routingOperation?.setupMinutes);
        const setupHours = setupMinutes / 60;
        const cycleSeconds = number(process.routingOperation?.cycleSeconds) || number(process.cycleTime);
        const cycleLoadHours = cycleSeconds * processQty / 3600;
        const runHours = number(process.routingOperation?.runMinutes) / 60;
        const elapsedHours = setupHours + cycleLoadHours + runHours;
        const rawElapsedDays = elapsedHours / WORKING_HOURS_PER_DAY;
        const scheduledElapsedDays = Math.ceil(rawElapsedDays);
        own.setupMinutes += setupMinutes;
        own.setupHours += setupHours;
        own.cycleTimeSeconds += cycleSeconds;
        own.cycleLoadHours += cycleLoadHours;
        own.routingRunHours += runHours;
        own.inhouseProcessHours += elapsedHours;
        own.inhouseScheduledDays += scheduledElapsedDays;
        own.elapsedHours += elapsedHours;
        own.exactElapsedDays += rawElapsedDays;
        own.elapsedDays += scheduledElapsedDays;
        own.processPath.push({
          detailCode: detail.part?.partCode || detail.id, detailName: detail.part?.partName || null,
          level: number(detail.levelComponent), sequence, processCode: process.process?.processCode || null,
          processName: process.process?.processName || "In-house Process", mode: "INHOUSE", qty: processQty,
          setupMinutes: round(setupMinutes), cycleTimeSeconds: round(cycleSeconds), cycleLoadHours: round(cycleLoadHours),
          runHours: round(runHours), elapsedHours: round(elapsedHours), rawElapsedDays: round(rawElapsedDays), elapsedDays: scheduledElapsedDays,
        });
      }
      if (!processes.length && detail.category !== "Purchase" && detail.category !== "Vendor" && number(detail.leadTime) > 0) {
        const fixedHours = leadTimeHours(detail);
        const rawFixedDays = fixedHours / WORKING_HOURS_PER_DAY;
        const scheduledFixedDays = Math.ceil(rawFixedDays);
        own.fixedInhouseLeadHours += fixedHours;
        own.inhouseProcessHours += fixedHours;
        own.inhouseScheduledDays += scheduledFixedDays;
        own.elapsedHours += fixedHours;
        own.exactElapsedDays += rawFixedDays;
        own.elapsedDays += scheduledFixedDays;
        own.processPath.push({
          detailCode: detail.part?.partCode || detail.id, detailName: detail.part?.partName || null,
          level: number(detail.levelComponent), sequence: 0, processName: "Fixed BOM Lead Time", mode: "INHOUSE",
          qty: processQty, fixedLeadHours: round(fixedHours), elapsedHours: round(fixedHours),
          rawElapsedDays: round(rawFixedDays), elapsedDays: scheduledFixedDays,
        });
      }
      const child = criticalChild || {
        elapsedHours: 0, elapsedDays: 0, exactElapsedDays: 0, inhouseProcessHours: 0,
        inhouseScheduledDays: 0, vendorLeadTimeDays: 0, vendorScheduledDays: 0,
        setupMinutes: 0, setupHours: 0, cycleTimeSeconds: 0, cycleLoadHours: 0,
        routingRunHours: 0, fixedInhouseLeadHours: 0, processPath: [],
      };
      return {
        elapsedHours: child.elapsedHours + own.elapsedHours,
        elapsedDays: child.elapsedDays + own.elapsedDays,
        exactElapsedDays: child.exactElapsedDays + own.exactElapsedDays,
        inhouseProcessHours: child.inhouseProcessHours + own.inhouseProcessHours,
        inhouseScheduledDays: child.inhouseScheduledDays + own.inhouseScheduledDays,
        vendorLeadTimeDays: child.vendorLeadTimeDays + own.vendorLeadTimeDays,
        vendorScheduledDays: child.vendorScheduledDays + own.vendorScheduledDays,
        setupMinutes: child.setupMinutes + own.setupMinutes,
        setupHours: child.setupHours + own.setupHours,
        cycleTimeSeconds: child.cycleTimeSeconds + own.cycleTimeSeconds,
        cycleLoadHours: child.cycleLoadHours + own.cycleLoadHours,
        routingRunHours: child.routingRunHours + own.routingRunHours,
        fixedInhouseLeadHours: child.fixedInhouseLeadHours + own.fixedInhouseLeadHours,
        processPath: [...child.processPath, ...own.processPath],
      };
    };
    const rootResults = (childrenByParent.get("ROOT") || []).map((root) => evaluateDetail(root, scheduleQty));
    const critical = rootResults.sort((left, right) => right.elapsedDays - left.elapsedDays)[0] || {
      elapsedHours: 0, elapsedDays: 0, exactElapsedDays: 0, inhouseProcessHours: 0,
      inhouseScheduledDays: 0, vendorLeadTimeDays: 0, vendorScheduledDays: 0,
      setupMinutes: 0, setupHours: 0, cycleTimeSeconds: 0, cycleLoadHours: 0,
      routingRunHours: 0, fixedInhouseLeadHours: 0, processPath: [],
    };
    const productionLeadTimeHours = critical.elapsedHours;
    const productionLeadTimeDays = critical.elapsedDays;
    return [header.id, {
      mbomNumber: header.noReg,
      scheduleQty,
      setupMinutes: round(critical.setupMinutes),
      setupHours: round(critical.setupHours),
      cycleTimeSeconds: round(critical.cycleTimeSeconds),
      cycleLoadHours: round(critical.cycleLoadHours),
      routingRunHours: round(critical.routingRunHours),
      fixedInhouseLeadHours: round(critical.fixedInhouseLeadHours),
      inhouseProcessHours: round(critical.inhouseProcessHours),
      inhouseScheduledDays: round(critical.inhouseScheduledDays),
      vendorLeadTimeDays: round(critical.vendorLeadTimeDays),
      vendorScheduledDays: round(critical.vendorScheduledDays),
      exactProductionLeadTimeDays: round(critical.exactElapsedDays),
      criticalComponentLeadHours: round(critical.fixedInhouseLeadHours),
      summedComponentLeadHours: round(summedComponentLeadHours),
      productionLeadTimeHours: round(productionLeadTimeHours),
      productionLeadTimeDays: round(productionLeadTimeDays),
      workingHoursPerDay: WORKING_HOURS_PER_DAY,
      processPath: critical.processPath,
      rootBranchCount: rootResults.length,
      calculationMethod: "BOM_CRITICAL_PATH_ROUND_EACH_PROCESS_V4",
    }];
  }));
}

const routingMetricKey = (headerId, qty) => `${headerId}|${round(qty)}`;

async function routingMetricsForRequests(tx, requests = []) {
  const groupedByQty = new Map();
  for (const request of requests) {
    if (!request?.headerId) continue;
    const qty = Math.max(number(request.scheduleQty), 1);
    const qtyKey = String(round(qty));
    if (!groupedByQty.has(qtyKey)) groupedByQty.set(qtyKey, new Map());
    groupedByQty.get(qtyKey).set(request.headerId, qty);
  }
  const metrics = new Map();
  for (const qtyByHeader of groupedByQty.values()) {
    const result = await routingMetrics(tx, [...qtyByHeader.keys()], qtyByHeader);
    for (const [headerId, metric] of result) metrics.set(routingMetricKey(headerId, metric.scheduleQty), metric);
  }
  return metrics;
}

function productionScheduleQty(matched = [], deliveryPlans = []) {
  const uniqueMpsDetails = new Map(matched.filter((row) => row?.mpsDetailId).map((row) => [row.mpsDetailId, row.mpsDetail]));
  const mpsQty = [...uniqueMpsDetails.values()].reduce((sum, detail) => sum + number(detail?.qtyPlanned), 0);
  if (mpsQty > 0) return round(mpsQty);
  const peggedQty = matched.reduce((sum, row) => sum + (Array.isArray(row.customerPegging)
    ? row.customerPegging.reduce((qty, peg) => qty + number(peg.qty), 0)
    : 0), 0);
  if (peggedQty > 0) return round(peggedQty);
  const uniquePlans = new Map(deliveryPlans.filter((plan) => plan?.id).map((plan) => [plan.id, plan]));
  return round([...uniquePlans.values()].reduce((sum, plan) => sum + number(plan.qtyPlanned), 0));
}

Object.assign(exports, { productionScheduleQty, routingMetricKey, routingMetricsForRequests });

async function generateForRun(tx, runNumber, user, options = {}) {
  const run = await tx.mRPRun.findFirst({ where: { runNumber, isDeleted: false } });
  if (!run) throw Object.assign(new Error("MRP Run tidak ditemukan"), { status: 404 });
  assertApprovedCurrentMrp(run, "Purchase Suggestion");
  if (run.mpsNumber) {
    const sourceMps = await tx.mPS.findUnique({ where: { mpsNumber: run.mpsNumber }, select: { replanRequired: true, replanReason: true } });
    if (sourceMps?.replanRequired) throw Object.assign(new Error(sourceMps.replanReason || "Forecast/SO berubah. Hitung ulang MPS dan MRP sebelum membuat Purchase Suggestion."), { status: 409 });
  }

  const existing = await tx.purchaseSuggestion.findFirst({
    where: { runNumber, isDeleted: false, status: { not: "Cancelled" } },
    include: { items: { where: { isDeleted: false }, include: { supplierAllocations: { where: { isDeleted: false } } } } },
  });
  await archiveSupersededSuggestionsForRun(tx, run);
  if (existing && options.force !== true) {
    if (existing.status === "Replan Required") throw Object.assign(new Error("Purchase Suggestion sudah kedaluwarsa karena Forecast/SO berubah. Hitung ulang MPS dan MRP terlebih dahulu."), { status: 409 });
    return existing;
  }
  if (existing && options.force === true) {
    if (existing.status !== "Draft") {
      throw Object.assign(new Error("Purchase Suggestion yang sudah dikonfirmasi tidak boleh direfresh otomatis."), { status: 409 });
    }
    const existingItemIds = existing.items.map((item) => item.id);
    if (existingItemIds.length) {
      await tx.purchaseSuggestionSupplierAllocation.deleteMany({
        where: { suggestionItemId: { in: existingItemIds } },
      });
    }
    await tx.purchaseSuggestionItem.deleteMany({
      where: { suggestionNumber: existing.suggestionNumber },
    });
  }


  const orders = await tx.plannedOrder.findMany({
    where: { runNumber, orderType: "Purchase", isDeleted: false, status: { in: ["Planned", "Partially Released"] }, qty: { gt: 0 } },
    include: {
      part: {
        include: {
          material: true,
          supplier: true,
          supplierItems: {
            where: { isActive: true },
            include: { supplier: true },
            orderBy: [{ isPreferred: "desc" }, { priority: "asc" }],
          },
        },
      },
    },
    orderBy: [{ requiredDate: "asc" }, { orderNumber: "asc" }],
  });
  if (!orders.length) throw Object.assign(new Error("Tidak ada planned purchase order aktif pada MRP ini"), { status: 400 });

  const [partPriceRows, materialPriceRows] = await Promise.all([
    tx.partPriceList.findMany({
      where: { isDeleted: false, partId: { in: unique(orders.map((row) => row.partId)) } },
    }),
    tx.materialPriceList.findMany({
      where: {
        isDeleted: false,
        OR: [
          { materialId: { in: unique(orders.map((row) => row.part?.material?.id)) } },
          {
            materialSubstanceId: { in: unique(orders.map((row) => row.part?.material?.materialSubstanceId)) },
            materialGradeId: { in: unique(orders.map((row) => row.part?.material?.materialGradeId)) },
          },
        ],
      },
    }),
  ]);

  const requirements = await tx.mRPRequirement.findMany({
    where: { runNumber, orderType: "Purchase", isDeleted: false },
    include: {
      part: { select: { partCode: true, partNumber: true, partName: true } },
      mpsDetail: {
        include: {
          demandSources: true,
          mps: { select: { mpsNumber: true, deliveryPlans: { where: { isDeleted: false, targetType: "CUSTOMER", status: { not: "Cancelled" } } } } },
        },
      },
      mbomDetail: {
        select: {
          id: true,
          noReg: true,
          materialScheme: true,
          materialWidth: true,
          materialForm: { select: { formCode: true, symbol: true, defaultPurchaseUomCode: true } },
          alternateMaterialForm: { select: { formCode: true, symbol: true, defaultPurchaseUomCode: true } },
        },
      },
    },
  });
  const requirementsByPartDay = new Map();
  for (const requirement of requirements) {
    const key = `${requirement.partCode}|${day(requirement.requiredDate)}`;
    if (!requirementsByPartDay.has(key)) requirementsByPartDay.set(key, []);
    requirementsByPartDay.get(key).push(requirement);
  }

  const capacityNeedDates = await buildCapacityNeedDateMap(tx, run);

  const routingRequestByOrder = new Map();
  for (const order of orders) {
    const matched = requirementsByPartDay.get(`${order.partCode}|${day(order.requiredDate)}`) || [];
    const matchedMpsDetailIds = new Set(matched.map((row) => row.mpsDetailId).filter(Boolean));
    const deliveryTargetIds = new Set(matched.map((row) => row.deliveryTargetId).filter(Boolean));
    const matchingDeliveryPlans = unique(matched.flatMap((row) => row.mpsDetail?.mps?.deliveryPlans || []).map((plan) => plan.id))
      .map((id) => matched.flatMap((row) => row.mpsDetail?.mps?.deliveryPlans || []).find((plan) => plan.id === id))
      .filter((plan) => plan
        && matchedMpsDetailIds.has(plan.mpsDetailId)
        && (deliveryTargetIds.size === 0 || deliveryTargetIds.has(plan.sourceDeliveryTargetId)));
    const headerId = matched.find((row) => row.mpsDetail?.mbomHeaderId)?.mpsDetail?.mbomHeaderId || null;
    routingRequestByOrder.set(order.orderNumber, {
      headerId,
      scheduleQty: productionScheduleQty(matched, matchingDeliveryPlans),
      matchingDeliveryPlans,
    });
  }
  const metricsByHeaderQuantity = await routingMetricsForRequests(tx, [...routingRequestByOrder.values()]);
  const planningConstraintByTarget = await loadDemandPlanningConstraintMap(
    tx,
    [...routingRequestByOrder.values()].flatMap((request) =>
      (request.matchingDeliveryPlans || []).map((plan) => plan.sourceDeliveryTargetId)),
  );

  const partCodes = unique(orders.map((row) => row.partCode));
  const materialCodes = unique(orders.map((row) => row.part?.material?.materialCode));
  const stockRows = await tx.stockBalance.findMany({
    where: {
      isDeleted: false,
      warehouse: { isDeleted: false, availableForMrp: true },
      OR: [{ partCode: { in: partCodes } }, { materialCode: { in: materialCodes } }],
    },
    select: { partCode: true, materialCode: true, warehouseCode: true, qtyOnHand: true, qtyReserved: true, qtyAvailable: true },
  });
  const stockByIdentity = new Map();
  for (const row of stockRows) {
    // Raw material is purchased and stocked by its shared material identity.
    // Purchase-parts without material master keep using their exact part code.
    const identity = row.materialCode || row.partCode;
    if (!identity) continue;
    const current = stockByIdentity.get(identity) || { onHand: 0, reserved: 0, available: 0, warehouseCode: row.warehouseCode };
    current.onHand += number(row.qtyOnHand);
    current.reserved += number(row.qtyReserved);
    current.available += number(row.qtyAvailable);
    stockByIdentity.set(identity, current);
  }
  const openPoRows = await tx.purchaseOrderDetail.findMany({
    where: {
      isDeleted: false,
      po: { isDeleted: false, status: { in: ACTIVE_PO_STATUSES } },
      OR: [{ partCode: { in: partCodes } }, { materialCode: { in: materialCodes } }],
    },
    select: { partCode: true, materialCode: true, qty: true, qtyReceived: true, deliveryDate: true, po: { select: { deliveryDate: true } } },
  });
  const openPoByIdentity = new Map();
  for (const row of openPoRows) {
    const identity = row.materialCode || row.partCode;
    if (!identity) continue;
    if (!openPoByIdentity.has(identity)) openPoByIdentity.set(identity, []);
    openPoByIdentity.get(identity).push({ qty: Math.max(number(row.qty) - number(row.qtyReceived), 0), deliveryDate: row.deliveryDate || row.po?.deliveryDate });
  }

  const suggestionNumber = existing && options.force === true
    ? existing.suggestionNumber
    : await nextSuggestionNumber(tx);
  const rawItems = await Promise.all(orders.map(async (order) => {
    const matched = requirementsByPartDay.get(`${order.partCode}|${day(order.requiredDate)}`) || [];
    const bomPurchaseDefault = matched
      .map(resolveBomPurchaseDefaults)
      .find((value) => value.form)
      || { form: null, width: null, source: "NOT_FOUND", materialScheme: null };
    const sources = matched.flatMap((row) => row.mpsDetail?.demandSources || []);
    const routingRequest = routingRequestByOrder.get(order.orderNumber) || {};
    const matchingDeliveryPlans = routingRequest.matchingDeliveryPlans || [];
    const deliveryDates = (matchingDeliveryPlans.length
      ? matchingDeliveryPlans.map((plan) => plan.plannedDate)
      : [
          ...sources.map((row) => row.effectiveRequiredDate || row.requiredDate),
          order.requiredDate,
        ]).filter(Boolean).map((value) => new Date(value));
    const customerDeliveryDate = deliveryDates.sort((a, b) => a - b)[0] || new Date(order.requiredDate);
    const fgRequiredDates = matchingDeliveryPlans
      .map((plan) => plan.fgRequiredDate || plan.plannedDate)
      .filter(Boolean)
      .map((value) => new Date(value));
    const fgRequiredDate = fgRequiredDates.sort((a, b) => a - b)[0] || customerDeliveryDate;
    const headerId = routingRequest.headerId || matched.find((row) => row.mpsDetail?.mbomHeaderId)?.mpsDetail?.mbomHeaderId;
    const baseRouting = metricsByHeaderQuantity.get(routingMetricKey(headerId, routingRequest.scheduleQty)) || { setupMinutes: 0, cycleTimeSeconds: 0, productionLeadTimeHours: 0, scheduleQty: routingRequest.scheduleQty || 0 };
    const planningDecision = matchingDeliveryPlans
      .map((plan) => planningConstraintByTarget.get(plan.sourceDeliveryTargetId))
      .find(Boolean) || null;
    const routingDecision = applyDecisionToRoutingMetric(baseRouting, planningDecision);
    const routing = routingDecision.metric || baseRouting;
    const supplierItem = order.part?.supplierItems?.[0];
    const suggestedSupplier = supplierItem?.supplier || order.part?.supplier || null;
    const controls = leadTimeControls(planningDecision);
    const masterPurchasingLeadTimeDays = number(supplierItem?.leadTimeDays ?? suggestedSupplier?.leadTimeDays ?? order.leadTime);
    const purchasingLeadTimeDays = controls.supplierLeadTime ? masterPurchasingLeadTimeDays : 0;
    const queueBufferHours = number(options.queueBufferHours);
    const totalProductionLeadTimeHours = routing.productionLeadTimeHours + queueBufferHours;
    const exactProductionLeadTimeDays = number(routing.exactProductionLeadTimeDays) + queueBufferHours / WORKING_HOURS_PER_DAY;
    const scheduledProductionLeadTimeDays = number(routing.productionLeadTimeDays) + Math.ceil(queueBufferHours / WORKING_HOURS_PER_DAY);
    const capacityProductionStart = matchingDeliveryPlans
      .map((plan) => capacityNeedDates.byPhase.get(plan.id))
      .filter(Boolean)
      .sort((a, b) => a - b)[0]
      || matched.map((row) => capacityNeedDates.byMpsDetail.get(row.mpsDetailId)).filter(Boolean).sort((a, b) => a - b)[0];
    // Purchase Suggestion protects the latest permissible production start.
    // Existing finite-capacity allocations are evidence, not the source of this
    // deadline; otherwise an early allocation turns into an unnecessarily early PR.
    const productionSchedule = await resolveProductionRequirementDates({
      fgRequiredDate,
      customerTargetDate: customerDeliveryDate,
      routingMetric: { ...routing, productionLeadTimeDays: scheduledProductionLeadTimeDays },
    });
    const calculatedProductionStart = productionSchedule.productionLatestStartDate;
    const plannedProductionStart = calculatedProductionStart;
    const materialRequiredDate = plannedProductionStart;
    const scheduleSource = "OR_TOOLS_WASM_CP_SAT";
    const procurementPolicy = procurementPolicyFromDecision(planningDecision, options.procurementPolicy || {});
    const schedule = await procurementSchedule({
      materialRequiredDate,
      supplierLeadTimeDays: purchasingLeadTimeDays,
      ...procurementPolicy,
      asOf: run.planningSnapshotAt || run.runDate || new Date(),
    });
    // recommendedOrderDate is the PO release deadline. latestPrDate remains a
    // separate internal approval milestone and must not be labelled as PO.
    const recommendedOrderDate = schedule.latestPoDate;
    const priceDate = recommendedOrderDate || materialRequiredDate;
    const supplierId = supplierItem?.supplierId || suggestedSupplier?.id || null;
    const effectivePartPrice = resolveEffectiveRecord(
      partPriceRows.filter((row) => row.partId === order.partId && (!supplierId || row.supplierId === supplierId)),
      priceDate,
    );
    const material = order.part?.material;
    const effectiveMaterialPrice = resolveEffectiveRecord(
      materialPriceRows.filter((row) => {
        if (supplierId && row.supplierId !== supplierId) return false;
        if (bomPurchaseDefault.form) {
          const priceForm = String(row.purchasePackageUomCode || row.CSP || "").trim().toUpperCase();
          const normalizedPriceForm = ({ C: "COIL", S: "SHEET", P: "PCS" })[priceForm] || priceForm;
          if (normalizedPriceForm !== bomPurchaseDefault.form) return false;
        }
        if (row.materialId) return row.materialId === material?.id;
        return row.materialSubstanceId === material?.materialSubstanceId
          && row.materialGradeId === material?.materialGradeId
          && (!row.thickness || number(row.thickness) === number(material?.thickness));
      }),
      priceDate,
    );
    const effectivePurchasePrice = effectivePartPrice || effectiveMaterialPrice;
    const identity = order.part?.material?.materialCode || order.partCode;
    const stock = stockByIdentity.get(identity) || { onHand: 0, reserved: 0, available: 0, warehouseCode: options.warehouseCode || null };
    const grossRequirement = round(matched.reduce((sum, row) => sum + number(row.grossRequirement), 0) || order.qty);
    const openPoQty = round((openPoByIdentity.get(identity) || []).filter((row) => !row.deliveryDate || new Date(row.deliveryDate) <= materialRequiredDate).reduce((sum, row) => sum + row.qty, 0));
    // MRP is the single source of truth for netting. It already considers the
    // full compatible supply graph (generic material, WIP and existing open
    // supply). Re-netting gross demand here double counts the shortage.
    const netRequirement = round(Math.max(number(order.qty) - number(order.qtyReleased), 0));
    const configuredMoq = number(effectiveMaterialPrice?.moq ?? supplierItem?.moq);
    const rawMaterialPurchase = Boolean(material) || String(order.uomCode || "").trim().toLowerCase() === "kg";
    const fallbackMoq = rawMaterialPurchase ? 200 : 1000;
    const moq = configuredMoq > 0 ? configuredMoq : fallbackMoq;
    const moqSource = configuredMoq > 0 ? "PURCHASING_MASTER" : rawMaterialPurchase ? "SYSTEM_DEFAULT_RAW_200_KG" : "SYSTEM_DEFAULT_PART_1000_PCS";
    const orderMultiple = number(effectiveMaterialPrice?.orderMultiple ?? supplierItem?.orderMultiple);
    const recommendedPurchaseQty = roundedPurchaseQty(netRequirement, moq, orderMultiple);
    const excessQty = round(Math.max(recommendedPurchaseQty - netRequirement, 0));
    return {
      plannedOrderNumber: order.orderNumber,
      mrpRequirementId: matched[0]?.id || null,
      partId: order.partId,
      partCode: order.partCode,
      partNumber: order.part?.partNumber || null,
      partName: order.part?.partName || null,
      materialId: order.part?.material?.id || null,
      materialCode: order.part?.material?.materialCode || null,
      materialDescription: order.part?.material?.materialName || order.part?.material?.spec || order.part?.partName || null,
      uomCode: order.uomCode,
      purchasePackageUomCode: bomPurchaseDefault.form
        || effectiveMaterialPrice?.purchasePackageUomCode
        || material?.materialForm
        || supplierItem?.purchaseUomCode
        || null,
      warehouseCode: options.warehouseCode || stock.warehouseCode || null,
      sourceRequirements: matched.map((row) => {
        const matchedNetTotal = matched.reduce((sum, candidate) => sum + number(candidate.adjustedOrderQty ?? candidate.plannedOrderQty ?? candidate.netRequirement), 0);
        const rowBasis = number(row.adjustedOrderQty ?? row.plannedOrderQty ?? row.netRequirement);
        return {
          id: row.id,
          plannedOrderNumber: order.orderNumber,
          plannedOrderNumbers: [order.orderNumber],
          sourceType: row.sourceType,
          sourceNumber: row.sourceNumber,
          partCode: row.partCode,
          partNumber: row.part?.partNumber || null,
          partName: row.part?.partName || null,
          deliveryTargetId: row.deliveryTargetId || null,
          customerCode: row.customerCode || row.mpsDetail?.customerCode || null,
          fgPartCode: row.fgPartCode || null,
          targetDeliveryDate: row.targetDeliveryDate || customerDeliveryDate,
          qty: round(matchedNetTotal > 0 ? netRequirement * rowBasis / matchedNetTotal : netRequirement / Math.max(matched.length, 1)),
          grossQty: number(row.grossRequirement),
          requiredDate: row.requiredDate,
          mpsNumber: row.mpsDetail?.mpsNumber || null,
        };
      }),
      customerCodes: unique(sources.map((row) => row.customerCode).concat(matched.map((row) => row.mpsDetail?.customerCode))),
      salesOrderNumbers: unique(sources.filter((row) => row.sourceType === "SALES_ORDER").map((row) => row.sourceNumber).concat(matched.flatMap((row) => String(row.mpsDetail?.soNumber || "").split(",")))),
      forecastNumbers: unique(sources.filter((row) => row.sourceType === "FORECAST").map((row) => row.sourceNumber)),
      productionOrderNumbers: [],
      customerDeliveryDate,
      plannedProductionStart,
      materialRequiredDate,
      recommendedOrderDate,
      latestPrDate: schedule.latestPrDate,
      procurementWindow: schedule.procurementWindow,
      scheduleSource,
      productionLeadTimeHours: round(totalProductionLeadTimeHours),
      productionLeadTimeBreakdown: {
        ...routing,
        queueBufferHours,
        totalProductionLeadTimeHours: round(totalProductionLeadTimeHours),
        totalProductionLeadTimeDays: scheduledProductionLeadTimeDays,
        exactProductionLeadTimeDays: round(exactProductionLeadTimeDays),
        scheduledProductionLeadTimeDays,
        planningEvidence: routingDecision.planningEvidence,
        fgRequiredDate,
        procurementSchedule: schedule,
        procurementPolicy,
        masterPurchasingLeadTimeDays,
        effectivePurchasingLeadTimeDays: purchasingLeadTimeDays,
        capacityReferenceStartDate: capacityProductionStart || null,
        lotSizing: { netRequirement, moq, orderMultiple, recommendedPurchaseQty, excessQty, moqSource },
      },
      purchasingLeadTimeDays,
      setupTimeMinutes: round(routing.setupMinutes),
      cycleTimeSeconds: round(routing.cycleTimeSeconds),
      queueBufferHours,
      grossRequirement,
      onHandStock: round(stock.onHand),
      reservedStock: round(stock.reserved),
      availableStock: round(stock.available),
      openPoQty,
      atRiskSupplyQty: round(matched.reduce((sum, row) => sum + number(row.atRiskSupplyQty), 0)),
      netRequirement,
      recommendedPurchaseQty,
      moq,
      orderMultiple,
      excessQty,
      projectedStockAfterOrder: round(stock.available + openPoQty + recommendedPurchaseQty - grossRequirement),
      suggestedSupplierCode: suggestedSupplier?.supplierCode || null,
      suggestedSupplierName: suggestedSupplier?.supplierName || null,
      estimatedUnitPrice: effectivePurchasePrice ? legacyPriceValue(effectivePurchasePrice, priceDate) : supplierItem?.price ?? null,
      currencyCode: effectivePurchasePrice?.currencyCode || supplierItem?.currencyCode || null,
      priceSource: effectivePurchasePrice ? "MASTER_PRICE_EFFECTIVE_DATE" : supplierItem?.price != null ? "SUPPLIER_ITEM_FALLBACK" : "PRICE_NOT_FOUND",
      priceEffectiveFrom: effectivePurchasePrice?.effectiveFrom || null,
      priceEffectiveUntil: effectivePurchasePrice?.effectiveUntil || null,
      status: "Draft",
    };
  }));
  const groupedItems = new Map();
  for (const item of rawItems) {
    const identity = item.materialCode || item.partCode;
    const key = [identity, day(item.materialRequiredDate), item.suggestedSupplierCode || "", item.warehouseCode || "", item.uomCode || ""].join("|");
    const current = groupedItems.get(key);
    if (!current) {
      groupedItems.set(key, { ...item, _rawGrossRequirement: item.grossRequirement, _rawNetRequirement: item.netRequirement });
      continue;
    }
    const sourceMap = new Map(current.sourceRequirements.map((source) => [source.id || `${source.sourceType}|${source.sourceNumber}|${source.requiredDate}`, source]));
    for (const source of item.sourceRequirements) {
      const sourceKey = source.id || `${source.sourceType}|${source.sourceNumber}|${source.requiredDate}`;
      const existingSource = sourceMap.get(sourceKey);
      if (existingSource) {
        existingSource.plannedOrderNumbers = unique([...(existingSource.plannedOrderNumbers || [existingSource.plannedOrderNumber]), ...(source.plannedOrderNumbers || [source.plannedOrderNumber])]);
        existingSource.qty = round(number(existingSource.qty) + number(source.qty));
        // grossQty represents one MRP requirement and must not be duplicated
        // when that requirement is fulfilled by several planned orders.
        existingSource.grossQty = Math.max(number(existingSource.grossQty), number(source.grossQty));
      }
      else sourceMap.set(sourceKey, source);
    }
    current.sourceRequirements = [...sourceMap.values()];
    current.customerCodes = unique([...current.customerCodes, ...item.customerCodes]);
    current.salesOrderNumbers = unique([...current.salesOrderNumbers, ...item.salesOrderNumbers]);
    current.forecastNumbers = unique([...current.forecastNumbers, ...item.forecastNumbers]);
    current.productionOrderNumbers = unique([...current.productionOrderNumbers, ...item.productionOrderNumbers]);
    current._rawGrossRequirement = round(current._rawGrossRequirement + item.grossRequirement);
    current._rawNetRequirement = round(current._rawNetRequirement + item.netRequirement);
    current.moq = Math.max(number(current.moq), number(item.moq));
    current.orderMultiple = Math.max(number(current.orderMultiple), number(item.orderMultiple));
    current.customerDeliveryDate = new Date(Math.min(new Date(current.customerDeliveryDate), new Date(item.customerDeliveryDate)));
    current.plannedProductionStart = new Date(Math.min(new Date(current.plannedProductionStart), new Date(item.plannedProductionStart)));
    current.materialRequiredDate = new Date(Math.min(new Date(current.materialRequiredDate), new Date(item.materialRequiredDate)));
    current.recommendedOrderDate = new Date(Math.min(new Date(current.recommendedOrderDate), new Date(item.recommendedOrderDate)));
    current.latestPrDate = new Date(Math.min(new Date(current.latestPrDate || current.recommendedOrderDate), new Date(item.latestPrDate || item.recommendedOrderDate)));
    if (item.scheduleSource) current.scheduleSource = item.scheduleSource;
    const windowPriority = ["EXPEDITE", "CURRENT_MONTH", "DELIVERY_1_15", "DELIVERY_16_EOM", "EARLY_FOLLOWING_MONTH", "FUTURE"];
    if (windowPriority.indexOf(item.procurementWindow) < windowPriority.indexOf(current.procurementWindow)) current.procurementWindow = item.procurementWindow;
    current.atRiskSupplyQty = round(number(current.atRiskSupplyQty) + number(item.atRiskSupplyQty));
    if (item.productionLeadTimeHours > current.productionLeadTimeHours) current.productionLeadTimeBreakdown = item.productionLeadTimeBreakdown;
    current.productionLeadTimeHours = Math.max(current.productionLeadTimeHours, item.productionLeadTimeHours);
    current.setupTimeMinutes = Math.max(current.setupTimeMinutes, item.setupTimeMinutes);
    current.cycleTimeSeconds = Math.max(current.cycleTimeSeconds, item.cycleTimeSeconds);
  }
  const datedItems = [...groupedItems.values()]
    .sort((a, b) => new Date(a.materialRequiredDate) - new Date(b.materialRequiredDate))
    .map((item) => {
      const uniqueSourceGross = item.sourceRequirements.reduce((sum, source) => sum + number(source.grossQty), 0);
      item.grossRequirement = round(uniqueSourceGross || item._rawGrossRequirement);
      item.netRequirement = round(item._rawNetRequirement);
      item.recommendedPurchaseQty = roundedPurchaseQty(item.netRequirement, item.moq, item.orderMultiple);
      item.excessQty = round(Math.max(item.recommendedPurchaseQty - item.netRequirement, 0));
      item.projectedStockAfterOrder = round(item.availableStock + item.openPoQty + item.recommendedPurchaseQty - item.grossRequirement);
      delete item._rawGrossRequirement;
      delete item._rawNetRequirement;
      return item;
    });
  const items = applyMoqCarryForward(datedItems);
  const suggestionData = {
      suggestionNumber,
      runNumber,
      warehouseCode: options.warehouseCode || null,
      status: "Draft",
      generatedBy: user,
      notes: "Generated by backward scheduling from customer delivery, routing time, purchasing lead time, stock, open PO, MOQ and order multiple.",
      items: { create: items },
  };
  return existing && options.force === true
    ? tx.purchaseSuggestion.update({
      where: { suggestionNumber },
      data: { ...suggestionData, suggestionNumber: undefined, isDeleted: false },
      include: { items: { where: { isDeleted: false }, include: { supplierAllocations: { where: { isDeleted: false } } } } },
    })
    : tx.purchaseSuggestion.create({
    data: suggestionData,
    include: { items: { where: { isDeleted: false }, include: { supplierAllocations: { where: { isDeleted: false } } } } },
  });
}

async function refreshHeaderStatus(tx, suggestionNumber) {
  const items = await tx.purchaseSuggestionItem.findMany({ where: { suggestionNumber, isDeleted: false }, select: { status: true } });
  const readyStatuses = ["Ready for PR", "Partially Converted to PR", "Converted to PR", "Covered by MOQ"];
  let status = "Draft";
  if (items.length && items.every((row) => ["Converted to PR", "Covered by MOQ"].includes(row.status)) && items.some((row) => row.status === "Converted to PR")) status = "Converted to PR";
  else if (items.some((row) => [...readyStatuses, "Partially Ready"].includes(row.status)) && items.some((row) => !readyStatuses.includes(row.status))) status = "Partially Confirmed";
  else if (items.length && items.every((row) => readyStatuses.includes(row.status))) status = "Confirmed";
  else if (items.some((row) => row.status === "Waiting Supplier Confirmation")) status = "Waiting Supplier Confirmation";
  return tx.purchaseSuggestion.update({ where: { suggestionNumber }, data: { status } });
}

function autoConfirmationResult(item, status, reasonCode = null, message = null) {
  return {
    itemId: item.id,
    identity: item.materialCode || item.partCode || item.plannedOrderNumber,
    supplierCode: item.alternativeSupplierCode || item.suggestedSupplierCode || null,
    status,
    reasonCode,
    message,
  };
}

async function autoConfirmSupplierItem(tx, item, actor, asOf) {
  if (number(item.qtyConvertedToPr) > 0 || /converted/i.test(item.status || "")) {
    return autoConfirmationResult(item, "SKIPPED", "ALREADY_CONVERTED", "Item sudah pernah dibuat menjadi PR.");
  }
  if (item.status === "Covered by MOQ") {
    return autoConfirmationResult(item, "SKIPPED", "ALREADY_COVERED", "Kebutuhan item sudah dicakup oleh kelebihan MOQ item sebelumnya.");
  }
  if (CONFIRMED_STATUSES.has(item.confirmationStatus) || ["Ready for PR", "Partially Ready"].includes(item.status)) {
    return autoConfirmationResult(item, "SKIPPED", "ALREADY_CONFIRMED", "Konfirmasi supplier sudah terisi.");
  }
  if (Array.isArray(item.supplierAllocations) && item.supplierAllocations.length) {
    return autoConfirmationResult(item, "SKIPPED", "SUPPLIER_ALLOCATION_EXISTS", "Item memiliki split supplier/delivery dan perlu dilanjutkan manual.");
  }
  const pricedSupplier = await findPricedPurchaseSuggestionSupplierMaster(tx, item, { asOf });
  const master = pricedSupplier.master;
  if (!master) {
    const checkedSuppliers = pricedSupplier.supplierCodes.length ? pricedSupplier.supplierCodes.join(", ") : "supplier terkait";
    return autoConfirmationResult(item, "SKIPPED", "PRICE_NOT_FOUND", `Harga aktif tidak tersedia dari ${checkedSuppliers}; status tidak dikonfirmasi.`);
  }

  const confirmedQty = number(item.recommendedPurchaseQty);
  if (!(confirmedQty > 0)) {
    return autoConfirmationResult(item, "SKIPPED", "SUGGESTION_QTY_NOT_FOUND", "Qty Purchase Suggestion tidak tersedia.");
  }
  const purchasePackageUomCode = String(master.purchasePackageUomCode || item.purchasePackageUomCode || "").trim().toUpperCase() || null;
  const materialWidth = optionalNumber(master.materialWidth) ?? optionalNumber(item.confirmedMaterialWidth);
  const materialLength = optionalNumber(item.confirmedMaterialLength);
  if (item.materialCode && !["SHEET", "COIL", "PCS"].includes(purchasePackageUomCode)) {
    return autoConfirmationResult(item, "SKIPPED", "PURCHASE_FORM_NOT_FOUND", "Bentuk pembelian material belum tersedia di BOM/master.");
  }
  if (item.materialCode && !(number(materialWidth) > 0)) {
    return autoConfirmationResult(item, "SKIPPED", "MATERIAL_WIDTH_NOT_FOUND", "Lebar material belum tersedia di BOM/master.");
  }
  if (item.materialCode && purchasePackageUomCode === "SHEET" && !(number(materialLength) > 0)) {
    return autoConfirmationResult(item, "SKIPPED", "SHEET_LENGTH_NOT_FOUND", "Panjang sheet belum tersedia dan perlu dikonfirmasi manual.");
  }

  const effectiveLeadTimeDays = 2;
  const recalculatedSchedule = await procurementSchedule({
    materialRequiredDate: item.materialRequiredDate,
    supplierLeadTimeDays: effectiveLeadTimeDays,
    ...(item.productionLeadTimeBreakdown?.procurementPolicy || {}),
  });
  const shortageQty = round(Math.max(number(item.netRequirement) - confirmedQty, 0));
  const row = await tx.purchaseSuggestionItem.update({
    where: { id: item.id },
    data: {
      confirmationStatus: "Confirmed",
      confirmedQty,
      confirmedDeliveryDate: item.materialRequiredDate,
      confirmedMoq: optionalNumber(master.moq) ?? number(item.moq),
      confirmedLeadTimeDays: effectiveLeadTimeDays,
      orderMultiple: optionalNumber(master.orderMultiple) ?? number(item.orderMultiple),
      recommendedOrderDate: recalculatedSchedule.latestPoDate,
      latestPrDate: recalculatedSchedule.latestPrDate,
      procurementWindow: recalculatedSchedule.procurementWindow,
      confirmedMaterialWidth: item.materialCode ? materialWidth : null,
      confirmedMaterialLength: item.materialCode && purchasePackageUomCode === "SHEET" ? materialLength : null,
      purchasePackageUomCode: item.materialCode ? purchasePackageUomCode : null,
      estimatedUnitPrice: master.unitPrice,
      currencyCode: master.currencyCode || item.currencyCode || null,
      priceSource: master.sources?.price || item.priceSource,
      priceEffectiveFrom: master.priceEffectiveFrom || null,
      priceEffectiveUntil: master.priceEffectiveUntil || null,
      productionLeadTimeBreakdown: {
        ...(item.productionLeadTimeBreakdown || {}),
        procurementSchedule: recalculatedSchedule,
        effectivePurchasingLeadTimeDays: effectiveLeadTimeDays,
        supplierConfirmationMaster: {
          supplierCode: master.supplierCode,
          supplierName: master.supplierName,
          lookupDate: master.lookupDate,
          moq: master.moq,
          orderMultiple: master.orderMultiple,
          unitPrice: master.unitPrice,
          currencyCode: master.currencyCode,
          leadTimeDays: master.leadTimeDays,
          purchasePackageUomCode: master.purchasePackageUomCode,
          materialWidth: master.materialWidth,
          sources: master.sources,
          priceListId: master.priceListId,
          priceEffectiveFrom: master.priceEffectiveFrom,
          priceEffectiveUntil: master.priceEffectiveUntil,
          bom: master.bom,
          autoConfirmed: true,
          autoConfirmedBy: actor,
          autoConfirmedAt: asOf,
        },
      },
      alternativeSupplierCode: master.supplierCode,
      shortageQty,
      status: shortageQty > 0 ? "Partially Ready" : "Ready for PR",
    },
  });
  return {
    ...autoConfirmationResult(item, "CONFIRMED"),
    supplierCode: master.supplierCode,
    confirmedQty: row.confirmedQty,
    unitPrice: row.estimatedUnitPrice,
    currencyCode: row.currencyCode,
  };
}

async function refreshDraftForMps(tx, mpsNumber, user) {
  if (!mpsNumber) return null;
  const run = await tx.mRPRun.findFirst({
    where: { mpsNumber, isDeleted: false, isCurrentPlan: true, status: "Completed", scenarioStatus: "APPROVED" },
    orderBy: [{ planRevision: "desc" }, { runDate: "desc" }],
    select: { runNumber: true },
  });
  if (!run) return null;
  const suggestion = await tx.purchaseSuggestion.findFirst({
    where: { runNumber: run.runNumber, isDeleted: false, status: "Draft" },
    select: { suggestionNumber: true },
  });
  if (!suggestion) return null;
  return generateForRun(tx, run.runNumber, user, { force: true });
}

exports.generateForRun = generateForRun;
exports.refreshDraftForMps = refreshDraftForMps;

exports.generate = async (req, res, next) => {
  try {
    const result = await prisma.$transaction((tx) => generateForRun(tx, req.params.runNumber, req.user?.username || req.user?.email || "system", req.body || {}));
    res.status(201).json(result);
  } catch (error) { if (error.status) return res.status(error.status).json({ message: error.message }); next(error); }
};

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(number(req.query.limit || req.query.length) || 20, 1), 500);
    const q = text(req.query.q || req.query.search);
    const showHistory = String(req.query.history || "").toLowerCase() === "true";
    const currentRuns = showHistory ? [] : await prisma.mRPRun.findMany({
      where: { isDeleted: false, isCurrentPlan: true },
      select: { runNumber: true },
    });
    const where = {
      isDeleted: false,
      ...(!showHistory ? { runNumber: { in: currentRuns.map((row) => row.runNumber) } } : {}),
      ...(req.query.status ? { status: req.query.status } : {}),
      ...(q ? { OR: [{ suggestionNumber: { contains: q, mode: "insensitive" } }, { runNumber: { contains: q, mode: "insensitive" } }, { status: { contains: q, mode: "insensitive" } }] } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.purchaseSuggestion.findMany({ where, include: { items: { where: { isDeleted: false }, select: { materialRequiredDate: true, recommendedPurchaseQty: true, netRequirement: true, excessQty: true, status: true } } }, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
      prisma.purchaseSuggestion.count({ where }),
    ]);
    res.json({ items: items.map((row) => ({
      ...row,
      dueDate: row.items.reduce((earliest, item) => {
        if (!item.materialRequiredDate) return earliest;
        return !earliest || item.materialRequiredDate < earliest ? item.materialRequiredDate : earliest;
      }, null),
      itemCount: row.items.length,
      netRequirement: row.items.reduce((sum, item) => sum + item.netRequirement, 0),
      recommendedPurchaseQty: row.items.reduce((sum, item) => sum + item.recommendedPurchaseQty, 0),
      excessQty: row.items.reduce((sum, item) => sum + item.excessQty, 0),
    })), total, page, limit });
  } catch (error) { next(error); }
};

exports.get = async (req, res, next) => {
  try {
    const item = await prisma.purchaseSuggestion.findFirst({ where: { suggestionNumber: req.params.suggestionNumber, isDeleted: false }, include: { items: { where: { isDeleted: false }, orderBy: [{ materialRequiredDate: "asc" }, { materialCode: "asc" }, { partCode: "asc" }], include: { supplierAllocations: { where: { isDeleted: false }, orderBy: { deliveryDate: "asc" } } } } } });
    if (!item) return res.status(404).json({ message: "Purchase Suggestion tidak ditemukan" });
    const materialIds = unique(item.items.map((row) => row.materialId));
    const itemPartCodes = unique(item.items.map((row) => row.partCode));
    const requirementIds = unique(item.items.flatMap((row) => [
      row.mrpRequirementId,
      ...(Array.isArray(row.sourceRequirements) ? row.sourceRequirements.map((source) => source.id) : []),
      ...(Array.isArray(row.productionLeadTimeBreakdown?.moqAllocation?.allocationPool) ? row.productionLeadTimeBreakdown.moqAllocation.allocationPool.map((source) => source.id) : []),
    ]));
    const [materials, requirements, schedulingRequirements] = await Promise.all([
      materialIds.length ? prisma.material.findMany({ where: { id: { in: materialIds }, isDeleted: false }, select: { id: true, width: true, thickness: true, materialForm: true } }) : [],
      requirementIds.length ? prisma.mRPRequirement.findMany({ where: { id: { in: requirementIds }, isDeleted: false }, select: { id: true, deliveryTargetId: true, targetDeliveryDate: true, part: { select: { partCode: true, partNumber: true, partName: true } }, mbomDetail: { select: { materialScheme: true, materialWidth: true, materialForm: { select: { id: true, formCode: true, symbol: true } }, alternateMaterialForm: { select: { id: true, formCode: true, symbol: true } } } } } }) : [],
      prisma.mRPRequirement.findMany({
        where: { runNumber: item.runNumber, orderType: "Purchase", isDeleted: false, mpsDetailId: { not: null } },
        select: { id: true, mpsDetailId: true, mpsDetail: { select: { mbomHeaderId: true, qtyPlanned: true } } },
      }),
    ]);
    const materialById = new Map(materials.map((row) => [row.id, row]));
    const requirementById = new Map(requirements.map((row) => [row.id, row]));
    const schedulingRequirementById = new Map(schedulingRequirements.map((row) => [row.id, row]));
    const itemRoutingRequestById = new Map();
    for (const row of item.items) {
      const directSources = (Array.isArray(row.sourceRequirements) ? row.sourceRequirements : [])
        .filter((source) => source.allocationType !== "MOQ_PULL_FORWARD");
      const sourceRows = directSources.length ? directSources : (Array.isArray(row.sourceRequirements) ? row.sourceRequirements : []);
      const linkedRequirements = unique([row.mrpRequirementId, ...sourceRows.map((source) => source.id)])
        .map((id) => schedulingRequirementById.get(id))
        .filter(Boolean);
      const headerId = linkedRequirements.find((requirement) => requirement.mpsDetail?.mbomHeaderId)?.mpsDetail?.mbomHeaderId || null;
      const uniqueDetails = new Map(linkedRequirements.filter((requirement) => requirement.mpsDetailId).map((requirement) => [requirement.mpsDetailId, requirement.mpsDetail]));
      itemRoutingRequestById.set(row.id, {
        headerId,
        scheduleQty: round([...uniqueDetails.values()].reduce((sum, detail) => sum + number(detail?.qtyPlanned), 0)),
      });
    }
    const uniqueQtyByHeader = new Map();
    const legacyQtyByHeader = new Map();
    const requirementCountByHeader = new Map();
    const countedMpsDetailsByHeader = new Map();
    for (const requirement of schedulingRequirements) {
      const headerId = requirement.mpsDetail?.mbomHeaderId;
      if (!headerId) continue;
      legacyQtyByHeader.set(headerId, number(legacyQtyByHeader.get(headerId)) + number(requirement.mpsDetail?.qtyPlanned));
      requirementCountByHeader.set(headerId, number(requirementCountByHeader.get(headerId)) + 1);
      if (!countedMpsDetailsByHeader.has(headerId)) countedMpsDetailsByHeader.set(headerId, new Set());
      const countedDetails = countedMpsDetailsByHeader.get(headerId);
      if (countedDetails.has(requirement.mpsDetailId)) continue;
      countedDetails.add(requirement.mpsDetailId);
      uniqueQtyByHeader.set(headerId, number(uniqueQtyByHeader.get(headerId)) + number(requirement.mpsDetail?.qtyPlanned));
    }
    const schedulingMetrics = await routingMetricsForRequests(prisma, [...itemRoutingRequestById.values()]);
    const planningConstraintByTarget = await loadDemandPlanningConstraintMap(prisma, unique([
      ...requirements.map((row) => row.deliveryTargetId),
      ...item.items.flatMap((row) => (Array.isArray(row.sourceRequirements) ? row.sourceRequirements : []).map((source) => source.deliveryTargetId)),
    ]));
    const [relatedParts, currentRuns, latestReviewedDemand] = await Promise.all([
      prisma.part.findMany({
        where: { isDeleted: false, OR: [
          ...(materialIds.length ? [{ materialId: { in: materialIds } }] : []),
          ...(itemPartCodes.length ? [{ partCode: { in: itemPartCodes } }] : []),
        ] },
        select: { partCode: true, partNumber: true, partName: true, material: { select: { materialCode: true } } },
      }),
      prisma.mRPRun.findMany({ where: { isDeleted: false, isCurrentPlan: true, status: "Completed", scenarioStatus: "APPROVED" }, select: { runNumber: true } }),
      prisma.demandPlanningDecision.findFirst({ where: { isDeleted: false, status: { in: ["REVIEWED", "APPROVED", "LOCKED"] } }, orderBy: { targetDeliveryDate: "desc" }, select: { targetDeliveryDate: true } }),
    ]);
    const relatedPartByCode = new Map(relatedParts.map((part) => [part.partCode, part]));
    const externalRequirements = relatedParts.length && currentRuns.length
      ? await prisma.mRPRequirement.findMany({
          where: {
            isDeleted: false,
            orderType: "Purchase",
            runNumber: { in: currentRuns.map((run) => run.runNumber) },
            partCode: { in: relatedParts.map((part) => part.partCode) },
            adjustedOrderQty: { gt: 0 },
          },
          select: {
            id: true, partCode: true, sourceType: true, sourceNumber: true, deliveryTargetId: true, customerCode: true, fgPartCode: true,
            targetDeliveryDate: true, requiredDate: true, materialRequiredDate: true, adjustedOrderQty: true, plannedOrderQty: true, netRequirement: true,
          },
          orderBy: { targetDeliveryDate: "asc" },
        })
      : [];
    const presentationItems = item.items.map((row) => {
      const enrichSource = (source) => {
        const requirement = requirementById.get(source.id);
        return {
          ...source,
          partCode: source.partCode || requirement?.part?.partCode || null,
          partNumber: source.partNumber || requirement?.part?.partNumber || null,
          partName: source.partName || requirement?.part?.partName || null,
          deliveryTargetId: source.deliveryTargetId || requirement?.deliveryTargetId || null,
          targetDeliveryDate: source.targetDeliveryDate || requirement?.targetDeliveryDate || null,
        };
      };
      const productionLeadTimeBreakdown = row.productionLeadTimeBreakdown && typeof row.productionLeadTimeBreakdown === "object"
        ? {
            ...row.productionLeadTimeBreakdown,
            ...(row.productionLeadTimeBreakdown.moqAllocation ? {
              moqAllocation: {
                ...row.productionLeadTimeBreakdown.moqAllocation,
                allocationPool: (Array.isArray(row.productionLeadTimeBreakdown.moqAllocation.allocationPool) ? row.productionLeadTimeBreakdown.moqAllocation.allocationPool : []).map(enrichSource),
              },
            } : {}),
          }
        : row.productionLeadTimeBreakdown;
      return {
        ...row,
        productionLeadTimeBreakdown,
        sourceRequirements: (Array.isArray(row.sourceRequirements) ? row.sourceRequirements : []).map(enrichSource),
      };
    });
    const responseItems = await Promise.all(presentationItems.map(async (row) => {
      const routingRequest = itemRoutingRequestById.get(row.id) || {};
      const headerId = routingRequest.headerId || schedulingRequirementById.get(row.mrpRequirementId)?.mpsDetail?.mbomHeaderId;
      const baseMetric = schedulingMetrics.get(routingMetricKey(headerId, routingRequest.scheduleQty));
      const planningDecision = (Array.isArray(row.sourceRequirements) ? row.sourceRequirements : [])
        .map((source) => planningConstraintByTarget.get(source.deliveryTargetId || requirementById.get(source.id)?.deliveryTargetId))
        .find(Boolean)
        || planningConstraintByTarget.get(requirementById.get(row.mrpRequirementId)?.deliveryTargetId)
        || null;
      const routingDecision = applyDecisionToRoutingMetric(baseMetric, planningDecision);
      const metric = routingDecision.metric || baseMetric;
      const legacyQty = number(legacyQtyByHeader.get(headerId));
      const legacyCycleLoadHours = metric ? round(metric.cycleTimeSeconds * legacyQty / 3600) : 0;
      const legacyTotalHours = metric
        ? round(metric.summedComponentLeadHours + metric.routingRunHours + metric.setupHours + legacyCycleLoadHours + number(row.queueBufferHours))
        : number(row.productionLeadTimeHours);
      const currentTotalHours = metric ? round(metric.productionLeadTimeHours + number(row.queueBufferHours)) : number(row.productionLeadTimeHours);
      const currentTotalDays = metric
        ? round(metric.productionLeadTimeDays + Math.ceil(number(row.queueBufferHours) / WORKING_HOURS_PER_DAY))
        : round(number(row.productionLeadTimeHours) / WORKING_HOURS_PER_DAY);
      const scheduledProductionLeadTimeDays = Math.ceil(currentTotalDays);
      const calculatedLeadTimeBreakdown = metric ? {
        ...metric,
        queueBufferHours: number(row.queueBufferHours),
        totalProductionLeadTimeHours: currentTotalHours,
        totalProductionLeadTimeDays: currentTotalDays,
        exactProductionLeadTimeDays: round(metric.exactProductionLeadTimeDays + number(row.queueBufferHours) / WORKING_HOURS_PER_DAY),
        scheduledProductionLeadTimeDays,
        storedProductionLeadTimeHours: number(row.productionLeadTimeHours),
        legacyDetected: Math.abs(number(row.productionLeadTimeHours) - legacyTotalHours) <= 0.001 && Math.abs(legacyQty - metric.scheduleQty) > 0.001,
        legacyRequirementCount: number(requirementCountByHeader.get(headerId)),
        legacyAccumulatedQty: legacyQty,
        legacyCycleLoadHours,
        legacyTotalHours,
        planningEvidence: routingDecision.planningEvidence || row.productionLeadTimeBreakdown?.planningEvidence || null,
        ...(row.productionLeadTimeBreakdown?.moqAllocation ? { moqAllocation: row.productionLeadTimeBreakdown.moqAllocation } : {}),
      } : row.productionLeadTimeBreakdown;
      const fgRequiredDate = row.productionLeadTimeBreakdown?.fgRequiredDate || row.customerDeliveryDate;
      const productionDates = metric && fgRequiredDate
        ? await resolveProductionRequirementDates({ fgRequiredDate, customerTargetDate: row.customerDeliveryDate, routingMetric: { ...metric, productionLeadTimeDays: scheduledProductionLeadTimeDays } })
        : null;
      const calculatedProductionDueDate = productionDates?.productionLatestStartDate || row.materialRequiredDate;
      const controls = leadTimeControls(planningDecision);
      const masterSupplierLeadTimeDays = number(row.confirmedLeadTimeDays ?? row.purchasingLeadTimeDays);
      const effectiveSupplierLeadTimeDays = controls.supplierLeadTime ? masterSupplierLeadTimeDays : 0;
      const procurementPolicy = procurementPolicyFromDecision(planningDecision, row.productionLeadTimeBreakdown?.procurementPolicy || {});
      const calculatedProcurementSchedule = calculatedProductionDueDate
        ? await procurementSchedule({ materialRequiredDate: calculatedProductionDueDate, supplierLeadTimeDays: effectiveSupplierLeadTimeDays, ...procurementPolicy })
        : null;
      const calculatedPurchaseDueDate = calculatedProcurementSchedule?.latestPoDate || row.recommendedOrderDate;
      const allocatedRequirementIds = new Set(presentationItems.flatMap((candidate) => (Array.isArray(candidate.sourceRequirements) ? candidate.sourceRequirements : []).map((source) => String(source.id))));
      const externalCandidates = externalRequirements.filter((requirement) => {
        const relatedPart = relatedPartByCode.get(requirement.partCode);
        const sameIdentity = row.materialCode
          ? relatedPart?.material?.materialCode === row.materialCode
          : requirement.partCode === row.partCode;
        return sameIdentity
          && !allocatedRequirementIds.has(String(requirement.id))
          && new Date(requirement.targetDeliveryDate || requirement.requiredDate) > new Date(row.customerDeliveryDate || row.materialRequiredDate);
      }).map((requirement) => {
        const relatedPart = relatedPartByCode.get(requirement.partCode);
        return {
          sourceItemId: `MRP:${requirement.id}`,
          sourceRequirementId: requirement.id,
          sourceKind: "MRP_REQUIREMENT",
          availableQty: number(requirement.adjustedOrderQty || requirement.plannedOrderQty || requirement.netRequirement),
          partCode: requirement.partCode,
          partNumber: relatedPart?.partNumber || null,
          customerCode: requirement.customerCode || null,
          sourceType: requirement.sourceType || "MRP",
          sourceNumber: requirement.sourceNumber || null,
          deliveryTargetId: requirement.deliveryTargetId || null,
          targetDeliveryDate: requirement.targetDeliveryDate || requirement.requiredDate,
          requiredDate: requirement.requiredDate,
          materialRequiredDate: requirement.materialRequiredDate || requirement.requiredDate,
          uomCode: row.uomCode || null,
        };
      }).filter((candidate) => candidate.availableQty > 0);
      const candidateRows = buildMoqAllocationCandidates(presentationItems, row.id, externalCandidates);
      const planningHorizonDate = latestReviewedDemand?.targetDeliveryDate || row.customerDeliveryDate;
      const bomPurchaseDefault = unique([
        row.mrpRequirementId,
        ...(Array.isArray(row.sourceRequirements) ? row.sourceRequirements.map((source) => source.id) : []),
      ])
        .map((id) => resolveBomPurchaseDefaults(requirementById.get(id)))
        .find((value) => value.form)
        || { form: null, width: null, source: "NOT_FOUND", materialScheme: null };
      return {
        ...row,
        scheduleSource: "OR_TOOLS_WASM_CP_SAT",
        calculatedProductionDueDate,
        calculatedPurchaseDueDate,
        supplierRequiredArrivalDate: calculatedProcurementSchedule?.supplierRequiredArrivalDate || row.productionLeadTimeBreakdown?.procurementSchedule?.supplierRequiredArrivalDate || null,
        latestPoDate: calculatedProcurementSchedule?.latestPoDate || row.recommendedOrderDate,
        calculatedLatestPrDate: calculatedProcurementSchedule?.latestPrDate || row.latestPrDate,
        productionLeadTimeBreakdown: calculatedLeadTimeBreakdown ? {
          ...calculatedLeadTimeBreakdown,
          procurementSchedule: calculatedProcurementSchedule || calculatedLeadTimeBreakdown.procurementSchedule || null,
          procurementPolicy,
          masterPurchasingLeadTimeDays: masterSupplierLeadTimeDays,
          effectivePurchasingLeadTimeDays: effectiveSupplierLeadTimeDays,
        } : calculatedLeadTimeBreakdown,
        masterMaterialWidth: materialById.get(row.materialId)?.width ?? null,
        masterMaterialThickness: materialById.get(row.materialId)?.thickness ?? null,
        masterMaterialForm: materialById.get(row.materialId)?.materialForm ?? null,
        bomDefaultPurchaseForm: bomPurchaseDefault.form,
        bomDefaultMaterialWidth: bomPurchaseDefault.width,
        bomMaterialScheme: bomPurchaseDefault.materialScheme,
        bomPurchaseFormSource: bomPurchaseDefault.source,
        recommendedPurchaseForms: unique([
          requirementById.get(row.mrpRequirementId)?.mbomDetail?.materialForm,
          requirementById.get(row.mrpRequirementId)?.mbomDetail?.alternateMaterialForm,
        ]),
        moqAllocationCandidates: candidateRows,
        moqAllocationSearch: {
          searchedAfterDate: row.customerDeliveryDate || row.materialRequiredDate,
          planningHorizonDate,
          candidateCount: candidateRows.length,
          reason: candidateRows.length
            ? "CANDIDATES_AVAILABLE"
            : new Date(planningHorizonDate) <= new Date(row.customerDeliveryDate || row.materialRequiredDate)
              ? "NO_LATER_DELIVERY_REQUEST"
              : "NO_MATCHING_MATERIAL_IN_LATER_DELIVERY",
        },
      };
    }));
    res.json({
      ...item,
      items: responseItems,
    });
  } catch (error) { next(error); }
};

exports.getSupplierMaster = async (req, res, next) => {
  try {
    const item = await prisma.purchaseSuggestionItem.findFirst({
      where: {
        id: req.params.itemId,
        suggestionNumber: req.params.suggestionNumber,
        isDeleted: false,
      },
    });
    if (!item) return res.status(404).json({ message: "Item Purchase Suggestion tidak ditemukan" });
    const supplierCode = text(req.query.supplierCode)
      || item.alternativeSupplierCode
      || item.suggestedSupplierCode;
    if (!supplierCode) return res.status(400).json({ message: "Pilih supplier untuk mengambil MOQ dan harga master." });
    const master = await resolvePurchaseSuggestionSupplierMaster(prisma, item, supplierCode, {
      asOf: req.query.asOf || new Date(),
    });
    res.json(master);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
};

exports.autoConfirmSuppliers = async (req, res, next) => {
  try {
    const asOf = new Date();
    const actor = req.user?.username || req.user?.email || "system";
    const result = await prisma.$transaction(async (tx) => {
      const suggestion = await tx.purchaseSuggestion.findFirst({
        where: { suggestionNumber: req.params.suggestionNumber, isDeleted: false },
        include: {
          items: {
            where: { isDeleted: false },
            orderBy: [{ materialRequiredDate: "asc" }, { materialCode: "asc" }, { partCode: "asc" }],
            include: { supplierAllocations: { where: { isDeleted: false }, select: { id: true } } },
          },
        },
      });
      if (!suggestion) throw Object.assign(new Error("Purchase Suggestion tidak ditemukan"), { status: 404 });
      if (suggestion.status === "Replan Required") {
        throw Object.assign(new Error("Purchase Suggestion sudah kedaluwarsa. Hitung ulang MPS dan MRP sebelum auto konfirmasi supplier."), { status: 409 });
      }

      const results = [];
      for (const item of suggestion.items) {
        results.push(await autoConfirmSupplierItem(tx, item, actor, asOf));
      }
      const header = await refreshHeaderStatus(tx, suggestion.suggestionNumber);
      const confirmedCount = results.filter((row) => row.status === "CONFIRMED").length;
      const skipped = results.filter((row) => row.status === "SKIPPED");
      return {
        suggestionNumber: suggestion.suggestionNumber,
        status: header.status,
        confirmedCount,
        skippedCount: skipped.length,
        skippedWithoutPriceCount: skipped.filter((row) => row.reasonCode === "PRICE_NOT_FOUND").length,
        results,
      };
    }, { timeout: 60000 });
    res.json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
};

exports.updateItem = async (req, res, next) => {
  try {
    if (req.body?.aiDraftId) await aiDraftService.validateDraftForOfficial({ draftId: req.body.aiDraftId, actor: req.user, draftType: "PURCHASING_RECOVERY", moduleCode: "purchasing", pageCode: "purchase-suggestions" });
    let item = await prisma.purchaseSuggestionItem.findFirst({ where: { id: req.params.itemId, suggestionNumber: req.params.suggestionNumber, isDeleted: false } });
    if (!item) return res.status(404).json({ message: "Item Purchase Suggestion tidak ditemukan" });
    const confirmationStatus = text(req.body.confirmationStatus) || item.confirmationStatus;
    const confirmedQty = req.body.confirmedQty == null ? item.confirmedQty : number(req.body.confirmedQty);
    const bypassConfirmationReason = text(req.body.bypassConfirmationReason);
    const ready = CONFIRMED_STATUSES.has(confirmationStatus) || Boolean(bypassConfirmationReason);
    const updated = await prisma.$transaction(async (tx) => {
      const previousSupplierCode = item.alternativeSupplierCode || item.suggestedSupplierCode || null;
      const selectedSupplierCode = text(req.body.alternativeSupplierCode) || previousSupplierCode;
      const supplierChanged = Boolean(selectedSupplierCode && selectedSupplierCode !== previousSupplierCode);
      const supplierMaster = selectedSupplierCode
        ? await resolvePurchaseSuggestionSupplierMaster(tx, item, selectedSupplierCode, { asOf: new Date() })
        : null;
      const requestedMoq = optionalNumber(req.body.confirmedMoq);
      const confirmedMoq = requestedMoq
        ?? (supplierChanged ? supplierMaster?.moq : optionalNumber(item.confirmedMoq))
        ?? supplierMaster?.moq
        ?? number(item.moq);
      const effectiveOrderMultiple = supplierMaster?.orderMultiple ?? number(item.orderMultiple);
      const normalizedConfirmedQty = roundedPurchaseQty(confirmedQty, confirmedMoq, effectiveOrderMultiple);
      if (Array.isArray(req.body.supplierAllocations)) {
        if (number(item.qtyConvertedToPr) > 0) {
          throw Object.assign(new Error("Alokasi supplier tidak dapat diubah setelah sebagian qty dibuat menjadi PR."), { status: 409 });
        }
        await tx.purchaseSuggestionSupplierAllocation.updateMany({ where: { suggestionItemId: item.id, isDeleted: false }, data: { isDeleted: true } });
        for (const allocation of req.body.supplierAllocations) {
          const allocationStatus = text(allocation.confirmationStatus) || "Not Confirmed";
          const allocationSupplierCode = text(allocation.supplierCode);
          const allocationMaster = allocationSupplierCode
            ? await resolvePurchaseSuggestionSupplierMaster(tx, item, allocationSupplierCode, { asOf: new Date() })
            : null;
          const allocationMoq = optionalNumber(allocation.moq) ?? allocationMaster?.moq;
          const allocationOrderMultiple = optionalNumber(allocation.orderMultiple) ?? allocationMaster?.orderMultiple;
          const allocationConfirmedQty = roundedPurchaseQty(allocation.confirmedQty, allocationMoq, allocationOrderMultiple);
          const purchasePackageUomCode = String(allocation.purchasePackageUomCode || allocationMaster?.purchasePackageUomCode || "").trim().toUpperCase() || null;
          const materialWidth = optionalNumber(allocation.materialWidth) ?? allocationMaster?.materialWidth ?? 0;
          const materialLength = number(allocation.materialLength);
          if (item.materialCode && CONFIRMED_STATUSES.has(allocationStatus)) {
            if (!["SHEET", "COIL", "PCS"].includes(purchasePackageUomCode)) throw Object.assign(new Error("Bentuk material supplier wajib SHEET, COIL, atau PCS."), { status: 400 });
            if (materialWidth <= 0) throw Object.assign(new Error("Lebar material yang tersedia wajib lebih dari 0."), { status: 400 });
            if (purchasePackageUomCode === "SHEET" && materialLength <= 0) throw Object.assign(new Error("Panjang sheet wajib lebih dari 0 mm."), { status: 400 });
          }
          await tx.purchaseSuggestionSupplierAllocation.create({ data: {
            suggestionItemId: item.id,
            supplierCode: allocationSupplierCode, supplierName: text(allocation.supplierName) || allocationMaster?.supplierName || null, confirmationStatus: allocationStatus,
            offeredQty: number(allocation.offeredQty ?? allocation.confirmedQty), confirmedQty: allocationConfirmedQty, deliveryDate: date(allocation.deliveryDate),
            moq: allocationMoq, orderMultiple: allocationOrderMultiple, leadTimeDays: optionalNumber(allocation.leadTimeDays) ?? allocationMaster?.leadTimeDays,
            unitPrice: optionalNumber(allocation.unitPrice) ?? allocationMaster?.unitPrice, currencyCode: text(allocation.currencyCode) || allocationMaster?.currencyCode || null, alternativeMaterialCode: text(allocation.alternativeMaterialCode), supplierRemark: text(allocation.supplierRemark),
            materialWidth: item.materialCode ? materialWidth || null : null,
            materialLength: item.materialCode && purchasePackageUomCode === "SHEET" ? materialLength : null,
            purchasePackageUomCode: item.materialCode ? purchasePackageUomCode : null,
            confirmedBy: CONFIRMED_STATUSES.has(allocationStatus) ? req.user?.username || req.user?.email : null, confirmedAt: CONFIRMED_STATUSES.has(allocationStatus) ? new Date() : null, status: CONFIRMED_STATUSES.has(allocationStatus) ? "Confirmed" : "Draft",
          } });
        }
      }
      const allocations = await tx.purchaseSuggestionSupplierAllocation.findMany({ where: { suggestionItemId: item.id, isDeleted: false } });
      const allConfirmedSupplierAllocations = mergePrimaryAndSplitSupplierAllocations({
        primaryAllocation: CONFIRMED_STATUSES.has(confirmationStatus) || bypassConfirmationReason
          ? {
              supplierCode: selectedSupplierCode,
              confirmedQty: normalizedConfirmedQty,
              deliveryDate: date(req.body.confirmedDeliveryDate) || item.confirmedDeliveryDate,
            }
          : null,
        splitAllocations: allocations.filter((allocation) => CONFIRMED_STATUSES.has(allocation.confirmationStatus)),
      });
      const effectiveConfirmedQty = sumSupplierAllocationQty(allConfirmedSupplierAllocations);
      if (req.body.moqAllocationEdited === true && Array.isArray(req.body.moqDemandAllocations)) {
        const suggestionItems = await tx.purchaseSuggestionItem.findMany({
          where: { suggestionNumber: item.suggestionNumber, isDeleted: false },
        });
        const externalRequirementIds = unique(req.body.moqDemandAllocations
          .filter((allocation) => String(allocation.sourceItemId || "").startsWith("MRP:"))
          .map((allocation) => String(allocation.sourceItemId).slice(4)));
        if (externalRequirementIds.length) {
          const externalRequirements = await tx.mRPRequirement.findMany({
            where: { id: { in: externalRequirementIds }, isDeleted: false, orderType: "Purchase" },
            select: {
              id: true, partCode: true, sourceType: true, sourceNumber: true, deliveryTargetId: true, customerCode: true, fgPartCode: true,
              targetDeliveryDate: true, requiredDate: true, materialRequiredDate: true, adjustedOrderQty: true, plannedOrderQty: true, netRequirement: true,
              part: { select: { partNumber: true, partName: true, material: { select: { materialCode: true } } } },
            },
          });
          if (externalRequirements.length !== externalRequirementIds.length) throw Object.assign(new Error("Kebutuhan MRP berikutnya sudah berubah. Muat ulang Purchase Suggestion."), { status: 409 });
          for (const requirement of externalRequirements) {
            const sameIdentity = item.materialCode
              ? requirement.part?.material?.materialCode === item.materialCode
              : requirement.partCode === item.partCode;
            if (!sameIdentity || new Date(requirement.targetDeliveryDate || requirement.requiredDate) <= new Date(item.customerDeliveryDate || item.materialRequiredDate)) {
              throw Object.assign(new Error("Kebutuhan MRP yang dipilih bukan delivery berikutnya untuk material yang sama."), { status: 400 });
            }
            const externalQty = number(requirement.adjustedOrderQty || requirement.plannedOrderQty || requirement.netRequirement);
            suggestionItems.push({
              ...item,
              id: `MRP:${requirement.id}`,
              materialRequiredDate: requirement.materialRequiredDate || requirement.requiredDate,
              customerDeliveryDate: requirement.targetDeliveryDate || requirement.requiredDate,
              netRequirement: externalQty,
              grossRequirement: externalQty,
              status: "Draft",
              sourceRequirements: [{
                id: requirement.id,
                qty: externalQty,
                grossQty: externalQty,
                originalDemandQty: externalQty,
                partCode: requirement.partCode,
                partNumber: requirement.part?.partNumber || null,
                partName: requirement.part?.partName || null,
                sourceType: requirement.sourceType || "MRP",
                sourceNumber: requirement.sourceNumber,
                deliveryTargetId: requirement.deliveryTargetId,
                customerCode: requirement.customerCode,
                fgPartCode: requirement.fgPartCode,
                targetDeliveryDate: requirement.targetDeliveryDate || requirement.requiredDate,
                requiredDate: requirement.requiredDate,
                plannedOrderNumber: null,
              }],
            });
          }
        }
        const reallocation = applyConfirmedMoqPullForward({
          items: suggestionItems,
          currentItemId: item.id,
          confirmedPurchaseQty: effectiveConfirmedQty,
          selections: req.body.moqDemandAllocations,
        });
        for (const changedItem of reallocation.changed.filter((candidate) => String(candidate.id) !== String(item.id) && !String(candidate.id).startsWith("MRP:"))) {
          await tx.purchaseSuggestionItem.update({ where: { id: changedItem.id }, data: {
            sourceRequirements: changedItem.sourceRequirements,
            grossRequirement: changedItem.grossRequirement,
            netRequirement: changedItem.netRequirement,
            recommendedPurchaseQty: changedItem.recommendedPurchaseQty,
            excessQty: changedItem.excessQty,
            projectedStockAfterOrder: changedItem.projectedStockAfterOrder,
            confirmedQty: changedItem.confirmedQty,
            shortageQty: changedItem.shortageQty,
            status: changedItem.status,
          } });
        }
        item = { ...item, ...reallocation.current };
      }
      const confirmedAllocationLeadTimes = allocations
        .filter((allocation) => CONFIRMED_STATUSES.has(allocation.confirmationStatus) && number(allocation.confirmedQty) > 0)
        .map((allocation) => number(allocation.leadTimeDays));
      const effectiveLeadTimeDays = confirmedAllocationLeadTimes.length
        ? Math.max(...confirmedAllocationLeadTimes)
        : optionalNumber(req.body.confirmedLeadTimeDays)
          ?? (supplierChanged ? supplierMaster?.leadTimeDays : optionalNumber(item.confirmedLeadTimeDays))
          ?? supplierMaster?.leadTimeDays
          ?? number(item.purchasingLeadTimeDays);
      const recalculatedSchedule = await procurementSchedule({
        materialRequiredDate: item.materialRequiredDate,
        supplierLeadTimeDays: effectiveLeadTimeDays,
        ...(item.productionLeadTimeBreakdown?.procurementPolicy || {}),
      });
      const recalculatedOrderDate = recalculatedSchedule.latestPoDate;
      const headerPurchasePackageUomCode = String(
        req.body.purchasePackageUomCode
          || (supplierChanged ? supplierMaster?.purchasePackageUomCode : item.purchasePackageUomCode)
          || supplierMaster?.purchasePackageUomCode
          || "",
      ).trim().toUpperCase() || null;
      const headerMaterialWidth = optionalNumber(req.body.confirmedMaterialWidth)
        ?? (supplierChanged ? supplierMaster?.materialWidth : optionalNumber(item.confirmedMaterialWidth))
        ?? supplierMaster?.materialWidth
        ?? 0;
      const headerMaterialLength = number(req.body.confirmedMaterialLength ?? item.confirmedMaterialLength);
      const confirmedUnitPrice = optionalNumber(req.body.confirmedUnitPrice)
        ?? (supplierChanged ? supplierMaster?.unitPrice : optionalNumber(item.estimatedUnitPrice))
        ?? supplierMaster?.unitPrice;
      const confirmedCurrencyCode = text(req.body.currencyCode)
        || (supplierChanged ? supplierMaster?.currencyCode : item.currencyCode)
        || supplierMaster?.currencyCode
        || null;
      if (item.materialCode && ready && !allocations.length) {
        if (!["SHEET", "COIL", "PCS"].includes(headerPurchasePackageUomCode)) throw Object.assign(new Error("Bentuk material supplier wajib SHEET, COIL, atau PCS."), { status: 400 });
        if (headerMaterialWidth <= 0) throw Object.assign(new Error("Lebar material yang tersedia wajib lebih dari 0."), { status: 400 });
        if (headerPurchasePackageUomCode === "SHEET" && headerMaterialLength <= 0) throw Object.assign(new Error("Panjang sheet wajib lebih dari 0 mm."), { status: 400 });
      }
      if (effectiveConfirmedQty + 0.000001 < number(item.qtyConvertedToPr)) {
        throw Object.assign(new Error(`Qty confirmed tidak boleh lebih kecil dari qty yang sudah menjadi PR (${number(item.qtyConvertedToPr)}).`), { status: 409 });
      }
      const shortageQty = round(Math.max(item.netRequirement - effectiveConfirmedQty, 0));
      const nextStatus = number(item.qtyConvertedToPr) > 0
        ? (number(item.qtyConvertedToPr) + 0.000001 >= effectiveConfirmedQty ? "Converted to PR" : "Partially Converted to PR")
        : (ready || allocations.some((allocation) => CONFIRMED_STATUSES.has(allocation.confirmationStatus)) ? (shortageQty > 0 ? "Partially Ready" : "Ready for PR") : "Waiting Supplier Confirmation");
      const row = await tx.purchaseSuggestionItem.update({ where: { id: item.id }, data: {
        confirmationStatus, confirmedQty: normalizedConfirmedQty || null, confirmedDeliveryDate: date(req.body.confirmedDeliveryDate) || item.confirmedDeliveryDate,
        confirmedMoq, confirmedLeadTimeDays: effectiveLeadTimeDays,
        orderMultiple: effectiveOrderMultiple,
        recommendedOrderDate: recalculatedOrderDate,
        latestPrDate: recalculatedSchedule.latestPrDate,
        procurementWindow: recalculatedSchedule.procurementWindow,
        confirmedMaterialWidth: item.materialCode ? headerMaterialWidth || null : null,
        confirmedMaterialLength: item.materialCode && headerPurchasePackageUomCode === "SHEET" ? headerMaterialLength : null,
        purchasePackageUomCode: item.materialCode ? headerPurchasePackageUomCode : null,
        estimatedUnitPrice: confirmedUnitPrice, currencyCode: confirmedCurrencyCode,
        priceSource: supplierMaster?.sources?.price || item.priceSource,
        priceEffectiveFrom: supplierMaster?.priceEffectiveFrom || item.priceEffectiveFrom,
        priceEffectiveUntil: supplierMaster?.priceEffectiveUntil || item.priceEffectiveUntil,
        sourceRequirements: item.sourceRequirements,
        productionLeadTimeBreakdown: {
          ...(item.productionLeadTimeBreakdown || {}),
          procurementSchedule: recalculatedSchedule,
          effectivePurchasingLeadTimeDays: effectiveLeadTimeDays,
          supplierConfirmationMaster: supplierMaster ? {
            supplierCode: supplierMaster.supplierCode,
            supplierName: supplierMaster.supplierName,
            lookupDate: supplierMaster.lookupDate,
            moq: supplierMaster.moq,
            orderMultiple: supplierMaster.orderMultiple,
            unitPrice: supplierMaster.unitPrice,
            currencyCode: supplierMaster.currencyCode,
            leadTimeDays: supplierMaster.leadTimeDays,
            purchasePackageUomCode: supplierMaster.purchasePackageUomCode,
            materialWidth: supplierMaster.materialWidth,
            sources: supplierMaster.sources,
            priceListId: supplierMaster.priceListId,
            priceEffectiveFrom: supplierMaster.priceEffectiveFrom,
            priceEffectiveUntil: supplierMaster.priceEffectiveUntil,
            bom: supplierMaster.bom,
          } : null,
        },
        grossRequirement: item.grossRequirement,
        netRequirement: item.netRequirement,
        excessQty: item.excessQty,
        projectedStockAfterOrder: item.projectedStockAfterOrder,
        supplierRemark: text(req.body.supplierRemark), alternativeSupplierCode: selectedSupplierCode, alternativeMaterialCode: text(req.body.alternativeMaterialCode), bypassConfirmationReason, shortageQty,
        status: nextStatus,
      }, include: { supplierAllocations: { where: { isDeleted: false } } } });
      await refreshHeaderStatus(tx, item.suggestionNumber);
      return row;
    });
    if (req.body?.aiDraftId) await aiDraftService.markAiDraftConfirmed({ draftId: req.body.aiDraftId, userId: req.user?.id, officialEntityType: "PURCHASE_SUGGESTION_ITEM", officialEntityId: updated.id });
    res.json(updated);
  } catch (error) { if (error.status) return res.status(error.status).json({ message: error.message }); next(error); }
};

exports.convertToPr = async (req, res, next) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const suggestion = await tx.purchaseSuggestion.findFirst({ where: { suggestionNumber: req.params.suggestionNumber, isDeleted: false }, include: { items: { where: { isDeleted: false, status: { in: ["Ready for PR", "Partially Ready", "Partially Converted to PR"] } }, include: { supplierAllocations: { where: { isDeleted: false, status: "Confirmed" } } } } } });
      if (!suggestion) throw Object.assign(new Error("Purchase Suggestion tidak ditemukan"), { status: 404 });
      if (suggestion.status === "Replan Required") throw Object.assign(new Error("Purchase Suggestion sudah kedaluwarsa karena Forecast/SO berubah. Hitung ulang MPS dan MRP terlebih dahulu."), { status: 409 });
      const sourceRun = await tx.mRPRun.findFirst({ where: { runNumber: suggestion.runNumber, isDeleted: false } });
      if (!sourceRun) throw Object.assign(new Error("Source MRP Purchase Suggestion tidak ditemukan."), { status: 409 });
      assertApprovedCurrentMrp(sourceRun, "Purchase Requisition");
      if (sourceRun.mpsNumber) {
        const sourceMps = await tx.mPS.findUnique({ where: { mpsNumber: sourceRun.mpsNumber }, select: { replanRequired: true, replanReason: true } });
        if (sourceMps?.replanRequired) throw Object.assign(new Error(sourceMps.replanReason || "Forecast/SO berubah. Hitung ulang MPS dan MRP terlebih dahulu."), { status: 409 });
      }
      const requestedItems = Array.isArray(req.body.items) ? req.body.items : [];
      const requestedQtyById = new Map(requestedItems.map((item) => [String(item.itemId || item.id || ""), number(item.qty)]));
      const selectedIds = requestedItems.length
        ? new Set(requestedQtyById.keys())
        : Array.isArray(req.body.itemIds) ? new Set(req.body.itemIds.map(String)) : null;
      const selected = suggestion.items.filter((item) => !selectedIds || selectedIds.has(item.id));
      if (!selected.length) throw Object.assign(new Error("Tidak ada item yang siap dibuat menjadi PR"), { status: 409 });
      for (const item of selected) {
        if (!CONFIRMED_STATUSES.has(item.confirmationStatus) && !item.bypassConfirmationReason && !item.supplierAllocations.length) throw Object.assign(new Error(`${item.materialCode || item.partCode}: konfirmasi supplier atau alasan bypass wajib diisi.`), { status: 409 });
      }
      const groups = new Map();
      const totalConfirmedQtyById = new Map();
      for (const item of selected) {
        const prCategory = resolvePrCategory(item);
        const primarySupplierAllocation = CONFIRMED_STATUSES.has(item.confirmationStatus) || item.bypassConfirmationReason
          ? {
              supplierCode: item.alternativeSupplierCode || item.suggestedSupplierCode,
              confirmedQty: roundedPurchaseQty(item.confirmedQty || item.recommendedPurchaseQty, item.confirmedMoq ?? item.moq, item.orderMultiple),
              moq: item.confirmedMoq ?? item.moq,
              orderMultiple: item.orderMultiple,
              deliveryDate: item.confirmedDeliveryDate || item.materialRequiredDate,
              unitPrice: item.estimatedUnitPrice,
              currencyCode: item.currencyCode,
              materialWidth: item.confirmedMaterialWidth,
              materialLength: item.confirmedMaterialLength,
              purchasePackageUomCode: item.purchasePackageUomCode,
              alternativeMaterialCode: item.alternativeMaterialCode,
              supplierRemark: item.supplierRemark,
            }
          : null;
        const allConfirmedSupplierAllocations = mergePrimaryAndSplitSupplierAllocations({
          primaryAllocation: primarySupplierAllocation,
          splitAllocations: item.supplierAllocations.map((allocation) => ({
            ...allocation,
            confirmedQty: roundedPurchaseQty(allocation.confirmedQty, allocation.moq, allocation.orderMultiple),
          })),
        });
        const totalConfirmedQty = sumSupplierAllocationQty(allConfirmedSupplierAllocations);
        totalConfirmedQtyById.set(item.id, totalConfirmedQty);
        const alreadyConvertedQty = number(item.qtyConvertedToPr);
        const availableQty = round(Math.max(totalConfirmedQty - alreadyConvertedQty, 0));
        const requestedQty = requestedQtyById.has(item.id) ? requestedQtyById.get(item.id) : availableQty;
        if (requestedQty <= 0 || requestedQty > availableQty + 0.000001) {
          throw Object.assign(new Error(`${item.materialCode || item.partCode}: qty PR harus lebih dari 0 dan maksimal ${availableQty} sesuai ketersediaan supplier.`), { status: 409 });
        }
        const baseAllocations = allConfirmedSupplierAllocations;
        let remainingQty = requestedQty;
        let qtyToSkip = alreadyConvertedQty;
        const allocations = baseAllocations.map((allocation) => {
          const allocationConfirmedQty = roundedPurchaseQty(allocation.confirmedQty, allocation.moq, allocation.orderMultiple);
          const skippedQty = Math.min(allocationConfirmedQty, qtyToSkip);
          qtyToSkip = round(Math.max(qtyToSkip - skippedQty, 0));
          const allocationAvailableQty = round(allocationConfirmedQty - skippedQty);
          const requestedAllocationQty = Math.min(allocationAvailableQty, remainingQty);
          const allocationQty = requestedAllocationQty > 0
            ? Math.min(allocationAvailableQty, roundedPurchaseQty(requestedAllocationQty, allocation.moq, allocation.orderMultiple))
            : 0;
          remainingQty = round(Math.max(remainingQty - allocationQty, 0));
          return { ...allocation, confirmedQty: allocationQty };
        }).filter((allocation) => allocation.confirmedQty > 0);
        for (const allocation of allocations) {
          // Explicit table selection is consolidated into one PR per procurement
          // category. Material and purchase part use different downstream forms.
          // Supplier remains a line-level proposal so the downstream PO process
          // can still split orders per supplier when required.
          // Raw material and purchase part use different PR/PO forms and must
          // never share one header, even when the operator selects both in one
          // conversion action.
          const supplierCode = allocation.supplierCode || item.alternativeSupplierCode || item.suggestedSupplierCode || null;
          if (!supplierCode) {
            throw Object.assign(new Error(`${item.materialCode || item.partCode}: supplier wajib dipilih sebelum Draft PR dibuat.`), { status: 409 });
          }
          const key = `${prCategory.code}|${supplierCode}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push({ item, allocation: { ...allocation, supplierCode }, prCategory });
        }
      }
      const prNumbers = [];
      const purchaseRequisitions = [];
      const convertedThisRequest = new Map();
      for (const entries of groups.values()) {
        const prCategory = entries[0].prCategory;
        const supplierCode = entries[0].allocation.supplierCode;
        if (!entries.every((entry) => entry.prCategory.code === prCategory.code && entry.allocation.supplierCode === supplierCode)) {
          throw Object.assign(new Error("Satu Draft PR hanya boleh memiliki satu kategori dan satu supplier."), { status: 409 });
        }
        const prNumber = await nextPrNumber(tx);
        const requiredDate = entries.map((row) => new Date(row.allocation.deliveryDate || row.item.materialRequiredDate)).sort((a, b) => a - b)[0];
        const pr = await tx.purchaseRequisition.create({ data: {
          prNumber, requestedBy: req.user?.username || req.user?.email || "Purchasing", requiredDate, priority: "Normal",
          poType: prCategory.poType,
          sourceType: "PURCHASE_SUGGESTION", procurementGroup: prCategory.procurementGroup,
          warehouseCode: entries[0].item.warehouseCode, status: "Draft",
          // Header is auditable as one PR category x one supplier.
          // Supplier also remains snapshotted on every detail/allocation.
          notes: `Generated from Purchase Suggestion ${suggestion.suggestionNumber} · ${prCategory.label} · Supplier ${supplierCode}`,
          details: { create: entries.map(({ item, allocation }, index) => {
            const qty = number(allocation.confirmedQty || item.confirmedQty || item.recommendedPurchaseQty);
            const supplierCode = allocation.supplierCode || item.alternativeSupplierCode || item.suggestedSupplierCode || null;
            const rawMaterial = Boolean(item.materialCode);
            const purchasePackageUomCode = rawMaterial ? String(allocation.purchasePackageUomCode || "").toUpperCase() : null;
            const materialWidth = rawMaterial ? number(allocation.materialWidth || item.confirmedMaterialWidth) : null;
            const materialLength = rawMaterial && purchasePackageUomCode === "SHEET" ? number(allocation.materialLength || item.confirmedMaterialLength) : null;
            if (rawMaterial && (!["SHEET", "COIL", "PCS"].includes(purchasePackageUomCode) || materialWidth <= 0)) {
              throw Object.assign(new Error(`${item.materialCode}: bentuk dan lebar material harus dikonfirmasi sebelum PR dibuat.`), { status: 409 });
            }
            if (rawMaterial && purchasePackageUomCode === "SHEET" && materialLength <= 0) {
              throw Object.assign(new Error(`${item.materialCode}: panjang sheet harus diisi sebelum PR dibuat.`), { status: 409 });
            }
            const sourceRows = Array.isArray(item.sourceRequirements) ? item.sourceRequirements : [];
            const sourceAllocation = allocatePurchaseQtyToSources(sourceRows, qty);
            const sourceDemandCoveredQty = sourceAllocation.demandCoveredQty;
            const moqBufferQty = sourceAllocation.moqBufferQty;
            const customReserveAllocationQty = round(sourceRows.reduce((sum, source) => sum + number(source.reservedAllocationQty), 0));
            const plannedOrderNumbers = unique(sourceRows.flatMap((source) => source.plannedOrderNumbers || [source.plannedOrderNumber]).concat(item.plannedOrderNumber));
            return {
              lineNumber: index + 1, procurementCategory: prCategory.procurementGroup, partCode: item.partCode, partNumber: item.partNumber, partName: item.partName || item.materialDescription, materialId: item.materialId, materialCode: item.materialCode, materialName: item.materialDescription, width: materialWidth || null, materialLength, CSP: ({ COIL: "C", SHEET: "S", PCS: "P" })[purchasePackageUomCode] || null, qty, uomCode: item.uomCode,
              estimatedPrice: number(allocation.unitPrice ?? item.estimatedUnitPrice), totalAmount: round(qty * number(allocation.unitPrice ?? item.estimatedUnitPrice)), proposedSupplierCode: supplierCode, confirmedSupplierCode: supplierCode, supplierConfirmedBy: req.user?.username || req.user?.email || "Purchasing", supplierConfirmedAt: new Date(), supplierProposalSource: "PURCHASE_SUGGESTION",
              purchasePackageQty: null, purchasePackageUomCode, conversionUomCode: null, conversionFactor: null, convertedPurchaseQty: null,
              lotCount: null, kgPerLot: null, purchaseQtyKg: rawMaterial ? qty : null,
              plannedOrderNumber: plannedOrderNumbers[0] || item.plannedOrderNumber, sourcePlannedOrderNumbers: plannedOrderNumbers,
              notes: [item.supplierRemark, customReserveAllocationQty > 0 ? `Custom reserve allocation ${customReserveAllocationQty} ${item.uomCode || ""}` : null, moqBufferQty > 0 ? `MOQ buffer bebas ${moqBufferQty} ${item.uomCode || ""}` : null, item.bypassConfirmationReason ? `Bypass confirmation: ${item.bypassConfirmationReason}` : null].filter(Boolean).join(" | ") || null,
              sources: sourceAllocation.allocations.length ? { create: sourceAllocation.allocations.map((source) => ({
                plannedOrderNumber: (source.plannedOrderNumbers || [source.plannedOrderNumber]).filter(Boolean)[0] || null,
                mrpRunNumber: suggestion.runNumber, mpsNumber: source.mpsNumber || null,
                forecastNumber: source.sourceType === "FORECAST" ? source.sourceNumber : null,
                soNumber: source.sourceType === "SALES_ORDER" ? source.sourceNumber : null,
                sourceType: source.sourceType || "MRP", sourceNumber: source.sourceNumber || null,
                requiredDate: date(source.requiredDate), partCode: source.partCode || item.partCode,
                qty: source.allocatedPrQty, uomCode: item.uomCode,
                metadata: { purchaseSuggestionNumber: suggestion.suggestionNumber, purchaseSuggestionItemId: item.id, plannedOrderNumbers: source.plannedOrderNumbers || [source.plannedOrderNumber].filter(Boolean), allocationType: source.allocationType || "DIRECT_DEMAND", originalDemandQty: source.originalDemandQty ?? source.qty, demandCoveredQty: source.demandCoveredQty ?? source.qty, reservedAllocationQty: source.reservedAllocationQty || 0, customReserveAllocationQty, moqBufferQty },
              })) } : undefined,
              sourcingAllocations: supplierCode ? { create: [{
                supplierCode, demandCoveredQty: sourceDemandCoveredQty, commercialQty: qty, demandUomCode: item.uomCode,
                materialWidth: materialWidth || null, materialLength, purchasePackageQty: null, purchasePackageUomCode,
                conversionUomCode: null, conversionFactor: null, convertedPurchaseQty: null,
                deliveryDate: date(allocation.deliveryDate || item.materialRequiredDate), currencyCode: allocation.currencyCode || item.currencyCode || "IDR",
                unitPrice: number(allocation.unitPrice ?? item.estimatedUnitPrice), totalAmount: round(number(allocation.unitPrice ?? item.estimatedUnitPrice) * qty),
                status: "Confirmed", confirmedBy: req.user?.username || req.user?.email || "Purchasing", confirmedAt: new Date(), notes: allocation.supplierRemark || item.supplierRemark || null,
              }] } : undefined,
            };
          }) },
        } });
        prNumbers.push(pr.prNumber);
        purchaseRequisitions.push({
          prNumber: pr.prNumber,
          prCategory: prCategory.code,
          prCategoryLabel: prCategory.label,
          procurementCategory: prCategory.procurementGroup,
          procurementGroup: prCategory.procurementGroup,
          poType: prCategory.poType,
          supplierCode,
          itemCount: entries.length,
        });
        for (const { item, allocation } of entries) {
          const qty = number(allocation.confirmedQty || item.confirmedQty || item.recommendedPurchaseQty);
          const convertedQty = round(number(item.qtyConvertedToPr) + number(convertedThisRequest.get(item.id)) + qty);
          convertedThisRequest.set(item.id, round(number(convertedThisRequest.get(item.id)) + qty));
          const totalConfirmedQty = number(totalConfirmedQtyById.get(item.id));
          await tx.purchaseSuggestionItem.update({ where: { id: item.id }, data: {
            prNumber: pr.prNumber,
            qtyConvertedToPr: convertedQty,
            status: convertedQty + 0.000001 >= totalConfirmedQty ? "Converted to PR" : "Partially Converted to PR",
          } });
          const plannedOrderNumbers = unique((Array.isArray(item.sourceRequirements) ? item.sourceRequirements : []).flatMap((source) => source.plannedOrderNumbers || [source.plannedOrderNumber]).concat(item.plannedOrderNumber));
          let qtyToRelease = qty;
          for (const orderNumber of plannedOrderNumbers) {
            if (qtyToRelease <= 0) break;
            const planned = await tx.plannedOrder.findUnique({ where: { orderNumber } });
            if (!planned) continue;
            const outstanding = Math.max(number(planned.qty) - number(planned.qtyReleased), 0);
            const releaseQty = Math.min(outstanding, qtyToRelease);
            const qtyReleased = round(number(planned.qtyReleased) + releaseQty);
            await tx.plannedOrder.update({ where: { orderNumber: planned.orderNumber }, data: { qtyReleased, status: qtyReleased + 0.000001 >= number(planned.qty) ? "Released" : "Partially Released" } });
            qtyToRelease = round(qtyToRelease - releaseQty);
          }
        }
      }
      await refreshHeaderStatus(tx, suggestion.suggestionNumber);
      return { suggestionNumber: suggestion.suggestionNumber, prNumbers, purchaseRequisitions, message: `${prNumbers.length} Draft PR dibuat terpisah berdasarkan Material dan Purchase Part. PR tetap mengikuti approval workflow.` };
    });
    res.status(201).json(result);
  } catch (error) { if (error.status) return res.status(error.status).json({ message: error.message }); next(error); }
};

exports.remove = async (req, res, next) => {
  try {
    const item = await prisma.purchaseSuggestion.findFirst({ where: { suggestionNumber: req.params.suggestionNumber, isDeleted: false } });
    if (!item) return res.status(404).json({ message: "Purchase Suggestion tidak ditemukan" });
    if (item.status === "Converted to PR") return res.status(409).json({ message: "Purchase Suggestion yang sudah menjadi PR tidak dapat dihapus" });
    await prisma.purchaseSuggestion.update({ where: { suggestionNumber: item.suggestionNumber }, data: { isDeleted: true, status: "Cancelled" } });
    res.json({ ok: true });
  } catch (error) { next(error); }
};
