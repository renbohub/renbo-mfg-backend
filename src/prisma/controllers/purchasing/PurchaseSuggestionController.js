const { prisma } = require("../../index");
const { procurementSchedule } = require("../../services/planning/procurementSchedulingService");

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
const date = (value) => value ? new Date(value) : null;
const day = (value) => new Date(value).toISOString().slice(0, 10);
const unique = (values) => [...new Set(values.filter(Boolean))];
const round = (value) => Number(number(value).toFixed(6));
const WORKING_HOURS_PER_DAY = 8;

function subtractDays(value, days) {
  return new Date(new Date(value).getTime() - Math.max(number(days), 0) * 24 * 60 * 60 * 1000);
}

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

async function generateForRun(tx, runNumber, user, options = {}) {
  const run = await tx.mRPRun.findFirst({ where: { runNumber, isDeleted: false } });
  if (!run) throw Object.assign(new Error("MRP Run tidak ditemukan"), { status: 404 });
  if (run.status !== "Completed") throw Object.assign(new Error("MRP harus Completed sebelum Purchase Suggestion dibuat"), { status: 409 });
  if (!run.isCurrentPlan) throw Object.assign(new Error("MRP ini bukan plan terbaru. Jalankan ulang MPS dan MRP agar Purchase Suggestion memakai Forecast/SO terbaru."), { status: 409 });
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
    await tx.purchaseSuggestion.update({ where: { suggestionNumber: existing.suggestionNumber }, data: { isDeleted: true } });
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

  const requirements = await tx.mRPRequirement.findMany({
    where: { runNumber, orderType: "Purchase", isDeleted: false },
    include: {
      mpsDetail: {
        include: {
          demandSources: true,
          mps: { select: { mpsNumber: true, deliveryPlans: { where: { isDeleted: false, targetType: "CUSTOMER", status: { not: "Cancelled" } } } } },
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

  const headerIds = unique(requirements.map((row) => row.mpsDetail?.mbomHeaderId));
  const qtyByHeader = new Map();
  const countedMpsDetailsByHeader = new Map();
  requirements.forEach((row) => {
    const id = row.mpsDetail?.mbomHeaderId;
    if (!id || !row.mpsDetailId) return;
    if (!countedMpsDetailsByHeader.has(id)) countedMpsDetailsByHeader.set(id, new Set());
    const countedDetails = countedMpsDetailsByHeader.get(id);
    if (countedDetails.has(row.mpsDetailId)) return;
    countedDetails.add(row.mpsDetailId);
    qtyByHeader.set(id, number(qtyByHeader.get(id)) + number(row.mpsDetail?.qtyPlanned));
  });
  const metricsByHeader = await routingMetrics(tx, headerIds, qtyByHeader);

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

  const suggestionNumber = await nextSuggestionNumber(tx);
  const rawItems = orders.map((order) => {
    const matched = requirementsByPartDay.get(`${order.partCode}|${day(order.requiredDate)}`) || [];
    const sources = matched.flatMap((row) => row.mpsDetail?.demandSources || []);
    const requirementDays = new Set(matched.map((row) => day(row.requiredDate)).filter(Boolean));
    const matchingDeliveryPlans = matched
      .flatMap((row) => row.mpsDetail?.mps?.deliveryPlans || [])
      .filter((plan) => requirementDays.has(day(plan.plannedDate)));
    const deliveryDates = (matchingDeliveryPlans.length
      ? matchingDeliveryPlans.map((plan) => plan.plannedDate)
      : [
          ...sources.map((row) => row.effectiveRequiredDate || row.requiredDate),
          order.requiredDate,
        ]).filter(Boolean).map((value) => new Date(value));
    const customerDeliveryDate = deliveryDates.sort((a, b) => a - b)[0] || new Date(order.requiredDate);
    const headerId = matched.find((row) => row.mpsDetail?.mbomHeaderId)?.mpsDetail?.mbomHeaderId;
    const routing = metricsByHeader.get(headerId) || { setupMinutes: 0, cycleTimeSeconds: 0, productionLeadTimeHours: 0 };
    const supplierItem = order.part?.supplierItems?.[0];
    const suggestedSupplier = supplierItem?.supplier || order.part?.supplier || null;
    const purchasingLeadTimeDays = number(supplierItem?.leadTimeDays ?? suggestedSupplier?.leadTimeDays ?? order.leadTime);
    const queueBufferHours = number(options.queueBufferHours);
    const totalProductionLeadTimeHours = routing.productionLeadTimeHours + queueBufferHours;
    const exactProductionLeadTimeDays = number(routing.exactProductionLeadTimeDays) + queueBufferHours / WORKING_HOURS_PER_DAY;
    const scheduledProductionLeadTimeDays = number(routing.productionLeadTimeDays) + Math.ceil(queueBufferHours / WORKING_HOURS_PER_DAY);
    const capacityProductionStart = matchingDeliveryPlans
      .map((plan) => capacityNeedDates.byPhase.get(plan.id))
      .filter(Boolean)
      .sort((a, b) => a - b)[0]
      || matched.map((row) => capacityNeedDates.byMpsDetail.get(row.mpsDetailId)).filter(Boolean).sort((a, b) => a - b)[0];
    const calculatedProductionStart = subtractDays(customerDeliveryDate, scheduledProductionLeadTimeDays);
    const plannedProductionStart = capacityProductionStart || calculatedProductionStart;
    const materialRequiredDate = plannedProductionStart;
    const scheduleSource = capacityProductionStart ? "FINITE_CAPACITY" : "MRP_BACKWARD_SCHEDULE";
    const schedule = procurementSchedule({
      materialRequiredDate,
      supplierLeadTimeDays: purchasingLeadTimeDays,
      ...(options.procurementPolicy || {}),
      asOf: run.planningSnapshotAt || run.runDate || new Date(),
    });
    const recommendedOrderDate = schedule.latestPrDate;
    const identity = order.part?.material?.materialCode || order.partCode;
    const stock = stockByIdentity.get(identity) || { onHand: 0, reserved: 0, available: 0, warehouseCode: options.warehouseCode || null };
    const grossRequirement = round(matched.reduce((sum, row) => sum + number(row.grossRequirement), 0) || order.qty);
    const openPoQty = round((openPoByIdentity.get(identity) || []).filter((row) => !row.deliveryDate || new Date(row.deliveryDate) <= materialRequiredDate).reduce((sum, row) => sum + row.qty, 0));
    // MRP is the single source of truth for netting. It already considers the
    // full compatible supply graph (generic material, WIP and existing open
    // supply). Re-netting gross demand here double counts the shortage.
    const netRequirement = round(Math.max(number(order.qty) - number(order.qtyReleased), 0));
    const moq = number(supplierItem?.moq);
    const orderMultiple = number(supplierItem?.orderMultiple);
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
      estimatedUnitPrice: supplierItem?.price ?? null,
      currencyCode: supplierItem?.currencyCode || null,
      status: "Draft",
    };
  });
  const groupedItems = new Map();
  for (const item of rawItems) {
    const identity = item.materialCode || item.partCode;
    const key = [identity, day(item.materialRequiredDate), item.suggestedSupplierCode || "", item.warehouseCode || "", item.moq, item.orderMultiple, item.uomCode || ""].join("|");
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
    current.customerDeliveryDate = new Date(Math.min(new Date(current.customerDeliveryDate), new Date(item.customerDeliveryDate)));
    current.plannedProductionStart = new Date(Math.min(new Date(current.plannedProductionStart), new Date(item.plannedProductionStart)));
    current.materialRequiredDate = new Date(Math.min(new Date(current.materialRequiredDate), new Date(item.materialRequiredDate)));
    current.recommendedOrderDate = new Date(Math.min(new Date(current.recommendedOrderDate), new Date(item.recommendedOrderDate)));
    current.latestPrDate = new Date(Math.min(new Date(current.latestPrDate || current.recommendedOrderDate), new Date(item.latestPrDate || item.recommendedOrderDate)));
    if (item.scheduleSource === "FINITE_CAPACITY") current.scheduleSource = "FINITE_CAPACITY";
    const windowPriority = ["EXPEDITE", "CURRENT_MONTH", "DELIVERY_1_15", "DELIVERY_16_EOM", "EARLY_FOLLOWING_MONTH", "FUTURE"];
    if (windowPriority.indexOf(item.procurementWindow) < windowPriority.indexOf(current.procurementWindow)) current.procurementWindow = item.procurementWindow;
    current.atRiskSupplyQty = round(number(current.atRiskSupplyQty) + number(item.atRiskSupplyQty));
    if (item.productionLeadTimeHours > current.productionLeadTimeHours) current.productionLeadTimeBreakdown = item.productionLeadTimeBreakdown;
    current.productionLeadTimeHours = Math.max(current.productionLeadTimeHours, item.productionLeadTimeHours);
    current.setupTimeMinutes = Math.max(current.setupTimeMinutes, item.setupTimeMinutes);
    current.cycleTimeSeconds = Math.max(current.cycleTimeSeconds, item.cycleTimeSeconds);
  }
  const items = [...groupedItems.values()]
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
  return tx.purchaseSuggestion.create({
    data: {
      suggestionNumber,
      runNumber,
      warehouseCode: options.warehouseCode || null,
      status: "Draft",
      generatedBy: user,
      notes: "Generated by backward scheduling from customer delivery, routing time, purchasing lead time, stock, open PO, MOQ and order multiple.",
      items: { create: items },
    },
    include: { items: { where: { isDeleted: false }, include: { supplierAllocations: { where: { isDeleted: false } } } } },
  });
}

async function refreshHeaderStatus(tx, suggestionNumber) {
  const items = await tx.purchaseSuggestionItem.findMany({ where: { suggestionNumber, isDeleted: false }, select: { status: true } });
  let status = "Draft";
  if (items.length && items.every((row) => row.status === "Converted to PR")) status = "Converted to PR";
  else if (items.some((row) => ["Ready for PR", "Partially Ready", "Partially Converted to PR", "Converted to PR"].includes(row.status)) && items.some((row) => !["Ready for PR", "Partially Converted to PR", "Converted to PR"].includes(row.status))) status = "Partially Confirmed";
  else if (items.length && items.every((row) => ["Ready for PR", "Partially Converted to PR", "Converted to PR"].includes(row.status))) status = "Confirmed";
  else if (items.some((row) => row.status === "Waiting Supplier Confirmation")) status = "Waiting Supplier Confirmation";
  return tx.purchaseSuggestion.update({ where: { suggestionNumber }, data: { status } });
}

async function refreshDraftForMps(tx, mpsNumber, user) {
  if (!mpsNumber) return null;
  const run = await tx.mRPRun.findFirst({
    where: { mpsNumber, isDeleted: false, isCurrentPlan: true, status: "Completed" },
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
    const requirementIds = unique(item.items.map((row) => row.mrpRequirementId));
    const [materials, requirements, schedulingRequirements] = await Promise.all([
      materialIds.length ? prisma.material.findMany({ where: { id: { in: materialIds }, isDeleted: false }, select: { id: true, width: true, thickness: true, materialForm: true } }) : [],
      requirementIds.length ? prisma.mRPRequirement.findMany({ where: { id: { in: requirementIds }, isDeleted: false }, select: { id: true, mbomDetail: { select: { materialScheme: true, materialWidth: true, materialForm: { select: { id: true, formCode: true, symbol: true } }, alternateMaterialForm: { select: { id: true, formCode: true, symbol: true } } } } } }) : [],
      prisma.mRPRequirement.findMany({
        where: { runNumber: item.runNumber, orderType: "Purchase", isDeleted: false, mpsDetailId: { not: null } },
        select: { id: true, mpsDetailId: true, mpsDetail: { select: { mbomHeaderId: true, qtyPlanned: true } } },
      }),
    ]);
    const materialById = new Map(materials.map((row) => [row.id, row]));
    const requirementById = new Map(requirements.map((row) => [row.id, row]));
    const schedulingRequirementById = new Map(schedulingRequirements.map((row) => [row.id, row]));
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
    const schedulingMetrics = await routingMetrics(prisma, [...uniqueQtyByHeader.keys()], uniqueQtyByHeader);
    res.json({
      ...item,
      items: item.items.map((row) => {
        const headerId = schedulingRequirementById.get(row.mrpRequirementId)?.mpsDetail?.mbomHeaderId;
        const metric = schedulingMetrics.get(headerId);
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
        const calculatedProductionDueDate = row.scheduleSource === "FINITE_CAPACITY"
          ? row.materialRequiredDate
          : metric && row.customerDeliveryDate
          ? subtractDays(row.customerDeliveryDate, scheduledProductionLeadTimeDays)
          : row.materialRequiredDate;
        const calculatedPurchaseDueDate = row.latestPrDate || (calculatedProductionDueDate
          ? procurementSchedule({ materialRequiredDate: calculatedProductionDueDate, supplierLeadTimeDays: number(row.confirmedLeadTimeDays ?? row.purchasingLeadTimeDays) }).latestPrDate
          : row.recommendedOrderDate);
        return {
          ...row,
          calculatedProductionDueDate,
          calculatedPurchaseDueDate,
          productionLeadTimeBreakdown: row.productionLeadTimeBreakdown || (metric ? {
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
          } : null),
          masterMaterialWidth: materialById.get(row.materialId)?.width ?? null,
          masterMaterialThickness: materialById.get(row.materialId)?.thickness ?? null,
          masterMaterialForm: materialById.get(row.materialId)?.materialForm ?? null,
          recommendedPurchaseForms: unique([
            requirementById.get(row.mrpRequirementId)?.mbomDetail?.materialForm,
            requirementById.get(row.mrpRequirementId)?.mbomDetail?.alternateMaterialForm,
          ]),
        };
      }),
    });
  } catch (error) { next(error); }
};

exports.updateItem = async (req, res, next) => {
  try {
    const item = await prisma.purchaseSuggestionItem.findFirst({ where: { id: req.params.itemId, suggestionNumber: req.params.suggestionNumber, isDeleted: false } });
    if (!item) return res.status(404).json({ message: "Item Purchase Suggestion tidak ditemukan" });
    const confirmationStatus = text(req.body.confirmationStatus) || item.confirmationStatus;
    const confirmedQty = req.body.confirmedQty == null ? item.confirmedQty : number(req.body.confirmedQty);
    const confirmedMoq = req.body.confirmedMoq == null ? number(item.confirmedMoq ?? item.moq) : number(req.body.confirmedMoq);
    const normalizedConfirmedQty = roundedPurchaseQty(confirmedQty, confirmedMoq, item.orderMultiple);
    const bypassConfirmationReason = text(req.body.bypassConfirmationReason);
    const ready = CONFIRMED_STATUSES.has(confirmationStatus) || Boolean(bypassConfirmationReason);
    const updated = await prisma.$transaction(async (tx) => {
      if (Array.isArray(req.body.supplierAllocations)) {
        if (number(item.qtyConvertedToPr) > 0) {
          throw Object.assign(new Error("Alokasi supplier tidak dapat diubah setelah sebagian qty dibuat menjadi PR."), { status: 409 });
        }
        await tx.purchaseSuggestionSupplierAllocation.updateMany({ where: { suggestionItemId: item.id, isDeleted: false }, data: { isDeleted: true } });
        for (const allocation of req.body.supplierAllocations) {
          const allocationStatus = text(allocation.confirmationStatus) || "Not Confirmed";
          const allocationConfirmedQty = roundedPurchaseQty(allocation.confirmedQty, allocation.moq, allocation.orderMultiple);
          const purchasePackageUomCode = String(allocation.purchasePackageUomCode || "").trim().toUpperCase() || null;
          const materialWidth = number(allocation.materialWidth);
          const materialLength = number(allocation.materialLength);
          if (item.materialCode && CONFIRMED_STATUSES.has(allocationStatus)) {
            if (!["SHEET", "COIL", "PCS"].includes(purchasePackageUomCode)) throw Object.assign(new Error("Bentuk material supplier wajib SHEET, COIL, atau PCS."), { status: 400 });
            if (materialWidth <= 0) throw Object.assign(new Error("Lebar material yang tersedia wajib lebih dari 0."), { status: 400 });
            if (purchasePackageUomCode === "SHEET" && materialLength <= 0) throw Object.assign(new Error("Panjang sheet wajib lebih dari 0 mm."), { status: 400 });
          }
          await tx.purchaseSuggestionSupplierAllocation.create({ data: {
            suggestionItemId: item.id,
            supplierCode: text(allocation.supplierCode), supplierName: text(allocation.supplierName), confirmationStatus: allocationStatus,
            offeredQty: number(allocation.offeredQty ?? allocation.confirmedQty), confirmedQty: allocationConfirmedQty, deliveryDate: date(allocation.deliveryDate),
            moq: allocation.moq == null ? null : number(allocation.moq), orderMultiple: allocation.orderMultiple == null ? null : number(allocation.orderMultiple), leadTimeDays: allocation.leadTimeDays == null ? null : number(allocation.leadTimeDays),
            unitPrice: allocation.unitPrice == null ? null : number(allocation.unitPrice), currencyCode: text(allocation.currencyCode), alternativeMaterialCode: text(allocation.alternativeMaterialCode), supplierRemark: text(allocation.supplierRemark),
            materialWidth: item.materialCode ? materialWidth || null : null,
            materialLength: item.materialCode && purchasePackageUomCode === "SHEET" ? materialLength : null,
            purchasePackageUomCode: item.materialCode ? purchasePackageUomCode : null,
            confirmedBy: CONFIRMED_STATUSES.has(allocationStatus) ? req.user?.username || req.user?.email : null, confirmedAt: CONFIRMED_STATUSES.has(allocationStatus) ? new Date() : null, status: CONFIRMED_STATUSES.has(allocationStatus) ? "Confirmed" : "Draft",
          } });
        }
      }
      const allocations = await tx.purchaseSuggestionSupplierAllocation.findMany({ where: { suggestionItemId: item.id, isDeleted: false } });
      const allocatedQty = allocations.reduce((sum, row) => sum + number(row.confirmedQty), 0);
      const effectiveConfirmedQty = allocatedQty > 0 ? allocatedQty : normalizedConfirmedQty;
      const confirmedAllocationLeadTimes = allocations
        .filter((allocation) => CONFIRMED_STATUSES.has(allocation.confirmationStatus) && number(allocation.confirmedQty) > 0)
        .map((allocation) => number(allocation.leadTimeDays));
      const effectiveLeadTimeDays = confirmedAllocationLeadTimes.length
        ? Math.max(...confirmedAllocationLeadTimes)
        : req.body.confirmedLeadTimeDays == null
          ? number(item.confirmedLeadTimeDays ?? item.purchasingLeadTimeDays)
          : number(req.body.confirmedLeadTimeDays);
      const recalculatedSchedule = procurementSchedule({
        materialRequiredDate: item.materialRequiredDate,
        supplierLeadTimeDays: effectiveLeadTimeDays,
      });
      const recalculatedOrderDate = recalculatedSchedule.latestPrDate;
      const headerPurchasePackageUomCode = String(req.body.purchasePackageUomCode || item.purchasePackageUomCode || "").trim().toUpperCase() || null;
      const headerMaterialWidth = number(req.body.confirmedMaterialWidth ?? item.confirmedMaterialWidth);
      const headerMaterialLength = number(req.body.confirmedMaterialLength ?? item.confirmedMaterialLength);
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
        confirmationStatus, confirmedQty: effectiveConfirmedQty || null, confirmedDeliveryDate: date(req.body.confirmedDeliveryDate) || item.confirmedDeliveryDate,
        confirmedMoq, confirmedLeadTimeDays: effectiveLeadTimeDays,
        recommendedOrderDate: recalculatedOrderDate,
        latestPrDate: recalculatedSchedule.latestPrDate,
        procurementWindow: recalculatedSchedule.procurementWindow,
        confirmedMaterialWidth: item.materialCode ? headerMaterialWidth || null : null,
        confirmedMaterialLength: item.materialCode && headerPurchasePackageUomCode === "SHEET" ? headerMaterialLength : null,
        purchasePackageUomCode: item.materialCode ? headerPurchasePackageUomCode : null,
        estimatedUnitPrice: req.body.confirmedUnitPrice == null ? item.estimatedUnitPrice : number(req.body.confirmedUnitPrice), currencyCode: text(req.body.currencyCode) || item.currencyCode,
        supplierRemark: text(req.body.supplierRemark), alternativeSupplierCode: text(req.body.alternativeSupplierCode), alternativeMaterialCode: text(req.body.alternativeMaterialCode), bypassConfirmationReason, shortageQty,
        status: nextStatus,
      }, include: { supplierAllocations: { where: { isDeleted: false } } } });
      await refreshHeaderStatus(tx, item.suggestionNumber);
      return row;
    });
    res.json(updated);
  } catch (error) { if (error.status) return res.status(error.status).json({ message: error.message }); next(error); }
};

exports.convertToPr = async (req, res, next) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const suggestion = await tx.purchaseSuggestion.findFirst({ where: { suggestionNumber: req.params.suggestionNumber, isDeleted: false }, include: { items: { where: { isDeleted: false, status: { in: ["Ready for PR", "Partially Ready", "Partially Converted to PR"] } }, include: { supplierAllocations: { where: { isDeleted: false, status: "Confirmed" } } } } } });
      if (!suggestion) throw Object.assign(new Error("Purchase Suggestion tidak ditemukan"), { status: 404 });
      if (suggestion.status === "Replan Required") throw Object.assign(new Error("Purchase Suggestion sudah kedaluwarsa karena Forecast/SO berubah. Hitung ulang MPS dan MRP terlebih dahulu."), { status: 409 });
      const sourceRun = await tx.mRPRun.findFirst({ where: { runNumber: suggestion.runNumber, isDeleted: false }, select: { isCurrentPlan: true, mpsNumber: true } });
      if (!sourceRun?.isCurrentPlan) throw Object.assign(new Error("Purchase Suggestion bukan hasil MRP terbaru dan tidak dapat dibuat menjadi PR."), { status: 409 });
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
      for (const item of selected) {
        const procurementCategory = item.materialCode ? "MATERIAL" : "PURCHASE_PART";
        const totalConfirmedQty = item.supplierAllocations.length
          ? item.supplierAllocations.reduce((sum, allocation) => sum + roundedPurchaseQty(allocation.confirmedQty, allocation.moq, allocation.orderMultiple), 0)
          : roundedPurchaseQty(item.confirmedQty || item.recommendedPurchaseQty, item.confirmedMoq ?? item.moq, item.orderMultiple);
        const alreadyConvertedQty = number(item.qtyConvertedToPr);
        const availableQty = round(Math.max(totalConfirmedQty - alreadyConvertedQty, 0));
        const requestedQty = requestedQtyById.has(item.id) ? requestedQtyById.get(item.id) : availableQty;
        if (requestedQty <= 0 || requestedQty > availableQty + 0.000001) {
          throw Object.assign(new Error(`${item.materialCode || item.partCode}: qty PR harus lebih dari 0 dan maksimal ${availableQty} sesuai ketersediaan supplier.`), { status: 409 });
        }
        const baseAllocations = item.supplierAllocations.length ? item.supplierAllocations : [{
          supplierCode: item.alternativeSupplierCode || item.suggestedSupplierCode,
          confirmedQty: totalConfirmedQty, moq: item.confirmedMoq ?? item.moq, orderMultiple: item.orderMultiple,
          deliveryDate: item.confirmedDeliveryDate || item.materialRequiredDate, unitPrice: item.estimatedUnitPrice,
          materialWidth: item.confirmedMaterialWidth, materialLength: item.confirmedMaterialLength, purchasePackageUomCode: item.purchasePackageUomCode,
        }];
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
          const key = requestedItems.length
            ? `SELECTED_ITEMS|${procurementCategory}`
            : `${procurementCategory}|${allocation.supplierCode || "UNCONFIRMED"}|${item.warehouseCode || ""}|${new Date(allocation.deliveryDate || item.materialRequiredDate).toISOString().slice(0, 7)}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push({ item, allocation, procurementCategory });
        }
      }
      const prNumbers = [];
      const purchaseRequisitions = [];
      const convertedThisRequest = new Map();
      for (const entries of groups.values()) {
        const procurementCategory = entries[0].procurementCategory;
        if (!entries.every((entry) => entry.procurementCategory === procurementCategory)) {
          throw Object.assign(new Error("Material dan Purchase Part tidak boleh berada dalam satu PR."), { status: 409 });
        }
        const prNumber = await nextPrNumber(tx);
        const requiredDate = entries.map((row) => new Date(row.allocation.deliveryDate || row.item.materialRequiredDate)).sort((a, b) => a - b)[0];
        const pr = await tx.purchaseRequisition.create({ data: {
          prNumber, requestedBy: req.user?.username || req.user?.email || "Purchasing", requiredDate, priority: "Normal",
          poType: procurementCategory === "MATERIAL" ? "Material" : "Part",
          sourceType: "PURCHASE_SUGGESTION", procurementGroup: procurementCategory,
          warehouseCode: entries[0].item.warehouseCode, status: "Draft",
          notes: `Generated from Purchase Suggestion ${suggestion.suggestionNumber} · ${procurementCategory === "MATERIAL" ? "Material" : "Purchase Part"}`,
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
            const sourceTotal = sourceRows.reduce((sum, source) => sum + number(source.qty), 0) || qty;
            const plannedOrderNumbers = unique(sourceRows.flatMap((source) => source.plannedOrderNumbers || [source.plannedOrderNumber]).concat(item.plannedOrderNumber));
            return {
              lineNumber: index + 1, procurementCategory: item.materialCode ? "MATERIAL" : "PURCHASE_PART", partCode: item.partCode, partNumber: item.partNumber, partName: item.partName || item.materialDescription, materialId: item.materialId, materialCode: item.materialCode, materialName: item.materialDescription, width: materialWidth || null, materialLength, CSP: ({ COIL: "C", SHEET: "S", PCS: "P" })[purchasePackageUomCode] || null, qty, uomCode: item.uomCode,
              estimatedPrice: number(allocation.unitPrice ?? item.estimatedUnitPrice), totalAmount: round(qty * number(allocation.unitPrice ?? item.estimatedUnitPrice)), proposedSupplierCode: supplierCode, confirmedSupplierCode: supplierCode, supplierConfirmedBy: req.user?.username || req.user?.email || "Purchasing", supplierConfirmedAt: new Date(), supplierProposalSource: "PURCHASE_SUGGESTION",
              purchasePackageQty: null, purchasePackageUomCode, conversionUomCode: null, conversionFactor: null, convertedPurchaseQty: null,
              lotCount: null, kgPerLot: null, purchaseQtyKg: rawMaterial ? qty : null,
              plannedOrderNumber: plannedOrderNumbers[0] || item.plannedOrderNumber, sourcePlannedOrderNumbers: plannedOrderNumbers,
              notes: [item.supplierRemark, item.bypassConfirmationReason ? `Bypass confirmation: ${item.bypassConfirmationReason}` : null].filter(Boolean).join(" | ") || null,
              sources: sourceRows.length ? { create: sourceRows.map((source) => ({
                plannedOrderNumber: (source.plannedOrderNumbers || [source.plannedOrderNumber]).filter(Boolean)[0] || null,
                mrpRunNumber: suggestion.runNumber, mpsNumber: source.mpsNumber || null,
                forecastNumber: source.sourceType === "FORECAST" ? source.sourceNumber : null,
                soNumber: source.sourceType === "SALES_ORDER" ? source.sourceNumber : null,
                sourceType: source.sourceType || "MRP", sourceNumber: source.sourceNumber || null,
                requiredDate: date(source.requiredDate), partCode: item.partCode,
                qty: round(qty * number(source.qty) / sourceTotal), uomCode: item.uomCode,
                metadata: { purchaseSuggestionNumber: suggestion.suggestionNumber, purchaseSuggestionItemId: item.id, plannedOrderNumbers: source.plannedOrderNumbers || [source.plannedOrderNumber].filter(Boolean) },
              })) } : undefined,
              sourcingAllocations: supplierCode ? { create: [{
                supplierCode, demandCoveredQty: qty, demandUomCode: item.uomCode,
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
          procurementCategory,
          procurementGroup: procurementCategory,
          poType: procurementCategory === "MATERIAL" ? "Material" : "Part",
          itemCount: entries.length,
        });
        for (const { item, allocation } of entries) {
          const qty = number(allocation.confirmedQty || item.confirmedQty || item.recommendedPurchaseQty);
          const convertedQty = round(number(item.qtyConvertedToPr) + number(convertedThisRequest.get(item.id)) + qty);
          convertedThisRequest.set(item.id, round(number(convertedThisRequest.get(item.id)) + qty));
          const totalConfirmedQty = item.supplierAllocations.length
            ? item.supplierAllocations.reduce((sum, row) => sum + roundedPurchaseQty(row.confirmedQty, row.moq, row.orderMultiple), 0)
            : roundedPurchaseQty(item.confirmedQty || item.recommendedPurchaseQty, item.confirmedMoq ?? item.moq, item.orderMultiple);
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
