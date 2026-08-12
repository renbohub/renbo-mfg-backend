const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_PO_STATUSES = new Set([
  "Approved",
  "Sent",
  "Confirmed",
  "Partial Receipt",
  "Completed",
]);
const CONFIRMED_SUGGESTION_STATUSES = new Set([
  "Available",
  "Partially Available",
  "Alternative Quantity Offered",
  "Alternative Delivery Date",
  "Confirmed",
]);
const { subtractWorkingDays } = require("./procurementSchedulingService");
const { loadDemandPlanningConstraintMap, applyDecisionToRoutingMetric } = require("./demandPlanningConstraintService");

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value, digits = 3) => Number(number(value).toFixed(digits));
const day = (value) => {
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth(),
    parsed.getUTCDate(),
  ));
};
const addDays = (value, days) => new Date(day(value).getTime() + number(days) * DAY_MS);

function sourceNumbers(detail) {
  const values = [
    detail?.plannedOrderNumber,
    ...(Array.isArray(detail?.sourcePlannedOrderNumbers)
      ? detail.sourcePlannedOrderNumbers
      : []),
    ...(Array.isArray(detail?.sources)
      ? detail.sources.map((item) => item?.plannedOrderNumber)
      : []),
  ];
  return new Set(values.filter(Boolean).map(String));
}

function allocatedDetailQty(detail, orderNumber) {
  const structuredSources = Array.isArray(detail?.sources)
    ? detail.sources.filter((item) => !item?.isDeleted)
    : [];
  if (structuredSources.length > 0) {
    return structuredSources
      .filter((item) => String(item?.plannedOrderNumber || "") === orderNumber)
      .reduce((sum, item) => sum + number(item?.qty), 0);
  }
  const allocations = Array.isArray(detail?.lotAllocations)
    ? detail.lotAllocations
    : [];
  const allocated = allocations
    .filter((item) => String(item?.plannedOrderNumber || "") === orderNumber)
    .reduce((sum, item) => sum + number(item?.qtyKg), 0);
  if (allocated > 0) return allocated;
  const sources = [...sourceNumbers(detail)];
  if (!sources.includes(orderNumber)) return 0;
  return number(detail.qty) / Math.max(sources.length, 1);
}

function supplierContext(order) {
  const supplierItems = order.part?.supplierItems || [];
  const selected = supplierItems.find(
    (item) => item.supplier?.supplierCode === order.supplierCode,
  ) || supplierItems.find((item) => item.isPreferred) || supplierItems[0] || null;
  const direct = order.part?.supplier || null;
  const supplier = order.supplierCode
    ? selected?.supplier || (direct?.supplierCode === order.supplierCode ? direct : null)
    : selected?.supplier || direct;
  return {
    supplierCode: order.supplierCode || supplier?.supplierCode || null,
    supplierName: supplier?.supplierName || null,
    leadTimeDays: number(selected?.leadTimeDays ?? supplier?.leadTimeDays),
    source: selected?.leadTimeDays != null
      ? "SUPPLIER_ITEM"
      : supplier?.leadTimeDays != null
        ? "SUPPLIER"
        : null,
  };
}

async function buildMaterialReadinessSnapshot(prisma, planOrNumber) {
  const plan = typeof planOrNumber === "string"
    ? await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber: planOrNumber, isDeleted: false },
      select: {
        id: true,
        planNumber: true,
        sourceType: true,
        periodStart: true,
        periodEnd: true,
      },
    })
    : planOrNumber;
  if (!plan) throw Object.assign(new Error("Monthly Production Plan tidak ditemukan."), { status: 404 });

  const mpsNumber = String(plan.sourceType || "").startsWith("MPS:")
    ? String(plan.sourceType).slice(4)
    : null;
  const run = mpsNumber
    ? await prisma.mRPRun.findFirst({
      where: {
        mpsNumber,
        isDeleted: false,
        isCurrentPlan: true,
        status: "Completed",
      },
      orderBy: { createdAt: "desc" },
      select: { runNumber: true, runDate: true, planNumber: true },
    })
    : null;
  if (!run) {
    return {
      planNumber: plan.planNumber,
      mpsNumber,
      mrpRunNumber: null,
      ready: false,
      summary: { total: 0, blocking: 1, warning: 0, ready: 0 },
      issues: [{
        severity: "BLOCKING",
        code: "MRP_NOT_COMPLETED",
        message: "MRP current dan Completed belum tersedia untuk Production Plan.",
      }],
      items: [],
    };
  }

  // A monthly MRP rerun can net an already released PR/PO to zero and therefore
  // create no PlannedOrder rows in the current revision.  The procurement is
  // still part of this MPS and must remain in the release-readiness check.
  // Follow the structured PR pegging across MRP revisions instead of looking at
  // the current run alone; otherwise an empty rerun incorrectly reports READY.
  const planRevisionRuns = run.planNumber
    ? await prisma.mRPRun.findMany({
      where: { planNumber: run.planNumber, status: "Completed" },
      select: { runNumber: true },
    })
    : [{ runNumber: run.runNumber }];
  const planRevisionRunNumbers = planRevisionRuns.map((row) => row.runNumber);
  const carriedProcurementSources = mpsNumber
    ? await prisma.purchaseRequisitionSource.findMany({
      where: {
        mpsNumber,
        mrpRunNumber: { in: planRevisionRunNumbers },
        isDeleted: false,
        plannedOrderNumber: { not: null },
        prDetail: {
          is: {
            isDeleted: false,
            pr: {
              is: {
                isDeleted: false,
                status: { notIn: ["Cancelled", "Rejected"] },
              },
            },
          },
        },
      },
      select: { plannedOrderNumber: true },
    })
    : [];
  const carriedOrderNumbers = [...new Set(
    carriedProcurementSources.map((row) => row.plannedOrderNumber).filter(Boolean),
  )];

  const orders = await prisma.plannedOrder.findMany({
    where: {
      OR: [
        { runNumber: run.runNumber },
        ...(carriedOrderNumbers.length
          ? [{ orderNumber: { in: carriedOrderNumbers } }]
          : []),
      ],
      orderType: "Purchase",
      isDeleted: false,
      status: { notIn: ["Cancelled"] },
      qty: { gt: 0 },
    },
    include: {
      part: {
        select: {
          id: true,
          partCode: true,
          partNumber: true,
          partName: true,
          itemType: true,
          rawType: true,
          supplier: {
            select: {
              supplierCode: true,
              supplierName: true,
              leadTimeDays: true,
            },
          },
          supplierItems: {
            where: { isActive: true },
            orderBy: [{ isPreferred: "desc" }, { priority: "asc" }],
            select: {
              leadTimeDays: true,
              isPreferred: true,
              priority: true,
              supplier: {
                select: {
                  supplierCode: true,
                  supplierName: true,
                  leadTimeDays: true,
                },
              },
            },
          },
        },
      },
    },
    orderBy: [{ requiredDate: "asc" }, { orderNumber: "asc" }],
  });

  const orderNumbers = orders.map((order) => order.orderNumber);
  const [prDetails, stockRows] = await Promise.all([
    orderNumbers.length
      ? prisma.purchaseRequisitionDetail.findMany({
        where: {
          isDeleted: false,
          OR: [
            { plannedOrderNumber: { in: orderNumbers } },
            {
              sources: {
                some: {
                  plannedOrderNumber: { in: orderNumbers },
                  isDeleted: false,
                },
              },
            },
            { pr: { notes: { contains: run.runNumber }, isDeleted: false } },
          ],
        },
        include: {
          sources: {
            where: { isDeleted: false },
            select: { plannedOrderNumber: true, qty: true, isDeleted: true },
          },
          pr: {
            select: {
              prNumber: true,
              status: true,
              requiredDate: true,
              isDeleted: true,
            },
          },
          poDetails: {
            where: { isDeleted: false },
            include: {
              po: {
                select: {
                  poNumber: true,
                  status: true,
                  deliveryDate: true,
                  supplierCode: true,
                  isDeleted: true,
                },
              },
            },
          },
        },
      })
      : [],
    orders.length
      ? prisma.stockBalance.groupBy({
        by: ["partCode"],
        where: {
          partCode: { in: [...new Set(orders.map((order) => order.partCode))] },
          isDeleted: false,
          warehouse: { availableForProduction: true, isDeleted: false },
        },
        _sum: { qtyAvailable: true },
      })
      : [],
  ]);

  const stockByPartCode = new Map(
    stockRows.map((row) => [row.partCode, number(row._sum?.qtyAvailable)]),
  );
  const procurementSupplierCodes = [...new Set(prDetails.flatMap((detail) => [
    detail.confirmedSupplierCode,
    detail.proposedSupplierCode,
    detail.preferredSupplier,
    ...(detail.poDetails || []).map((poDetail) => poDetail.po?.supplierCode),
  ]).filter(Boolean))];
  const procurementSuppliers = procurementSupplierCodes.length
    ? await prisma.supplier.findMany({
      where: { supplierCode: { in: procurementSupplierCodes }, isDeleted: false },
      select: { supplierCode: true, supplierName: true, leadTimeDays: true },
    })
    : [];
  const procurementSupplierByCode = new Map(
    procurementSuppliers.map((supplier) => [supplier.supplierCode, supplier]),
  );
  const today = day(new Date());
  const issues = [];
  const items = orders.map((order) => {
    const linkedDetails = prDetails.filter((detail) => sourceNumbers(detail).has(order.orderNumber));
    const masterSupplier = supplierContext(order);
    const procurementSupplierCode = linkedDetails.flatMap((detail) => [
      ...(detail.poDetails || []).map((poDetail) => poDetail.po?.supplierCode),
      detail.confirmedSupplierCode,
      detail.proposedSupplierCode,
      detail.preferredSupplier,
    ]).find(Boolean);
    const procurementSupplier = procurementSupplierByCode.get(procurementSupplierCode);
    const supplier = masterSupplier.supplierCode
      ? masterSupplier
      : procurementSupplier
        ? {
          supplierCode: procurementSupplier.supplierCode,
          supplierName: procurementSupplier.supplierName,
          leadTimeDays: number(procurementSupplier.leadTimeDays),
          source: "PURCHASING",
        }
        : masterSupplier;
    const requiredDate = day(order.requiredDate);
    const calculatedOrderDate = supplier.leadTimeDays > 0
      ? addDays(requiredDate, -supplier.leadTimeDays)
      : day(order.orderDate);
    let prQty = 0;
    let poQty = 0;
    let receivedQty = 0;
    let latestDeliveryDate = null;
    const prNumbers = new Set();
    const poNumbers = new Set();

    for (const detail of linkedDetails) {
      const detailShare = allocatedDetailQty(detail, order.orderNumber);
      prQty += detailShare;
      prNumbers.add(detail.pr?.prNumber);
      const detailQty = Math.max(number(detail.qty), 0);
      for (const poDetail of detail.poDetails || []) {
        if (!poDetail.po || poDetail.po.isDeleted || !ACTIVE_PO_STATUSES.has(poDetail.po.status)) continue;
        const ratio = detailQty > 0 ? detailShare / detailQty : 0;
        const usesConvertedDemandQty = poDetail.convertedPurchaseQty != null
          && String(poDetail.conversionUomCode || "").toUpperCase()
            === String(detail.uomCode || "").toUpperCase();
        const orderedInDemandUom = usesConvertedDemandQty
          ? number(poDetail.convertedPurchaseQty)
          : number(poDetail.qty);
        const receivedInDemandUom = usesConvertedDemandQty
          ? number(poDetail.qtyReceived) * number(poDetail.conversionFactor)
          : number(poDetail.qtyReceived);
        poQty += orderedInDemandUom * ratio;
        receivedQty += receivedInDemandUom * ratio;
        poNumbers.add(poDetail.po.poNumber);
        const delivery = day(poDetail.deliveryDate || poDetail.po.deliveryDate);
        if (delivery && (!latestDeliveryDate || delivery > latestDeliveryDate)) latestDeliveryDate = delivery;
      }
    }

    const requiredQty = number(order.qty);
    const stockAvailable = stockByPartCode.get(order.partCode) || 0;
    const remainingToRelease = Math.max(requiredQty - number(order.qtyReleased), 0);
    const lineIssues = [];
    const push = (severity, code, message) => {
      const issue = {
        severity,
        code,
        orderNumber: order.orderNumber,
        partCode: order.partCode,
        message,
      };
      lineIssues.push(issue);
      issues.push(issue);
    };

    if (!supplier.supplierCode) {
      push("BLOCKING", "SUPPLIER_MISSING", `${order.partCode} belum mempunyai supplier pilihan/default.`);
    }
    if (supplier.leadTimeDays <= 0) {
      push("BLOCKING", "SUPPLIER_LEAD_TIME_MISSING", `${order.partCode} belum mempunyai lead time Supplier-Item/Supplier.`);
    }
    if (
      supplier.leadTimeDays > 0 &&
      calculatedOrderDate &&
      calculatedOrderDate < today &&
      poQty + 0.000001 < requiredQty
    ) {
      push("BLOCKING", "MATERIAL_ORDER_LATE", `${order.partCode} melewati tanggal order ${calculatedOrderDate.toISOString().slice(0, 10)} dan supply PO belum mencukupi.`);
    }
    if (latestDeliveryDate && latestDeliveryDate > requiredDate) {
      push("BLOCKING", "PO_DELIVERY_LATE", `${order.partCode} dijadwalkan datang ${latestDeliveryDate.toISOString().slice(0, 10)}, setelah required date ${requiredDate.toISOString().slice(0, 10)}.`);
    }
    if (prQty + 0.000001 < requiredQty) {
      push("WARNING", "PR_RELEASE_PENDING", `${order.partCode} masih memiliki ${round(requiredQty - prQty)} yang belum direlease ke PR.`);
    } else if (poQty + 0.000001 < prQty) {
      push("WARNING", "PO_CONVERSION_PENDING", `${order.partCode} masih memiliki ${round(prQty - poQty)} PR yang belum menjadi PO aktif.`);
    }

    return {
      orderNumber: order.orderNumber,
      partCode: order.partCode,
      partNumber: order.part?.partNumber || null,
      partName: order.part?.partName || null,
      itemType: order.part?.itemType || null,
      rawType: order.part?.rawType || null,
      requiredQty: round(requiredQty),
      releasedToPrQty: round(number(order.qtyReleased)),
      remainingToReleaseQty: round(remainingToRelease),
      prQty: round(prQty),
      poQty: round(poQty),
      receivedQty: round(receivedQty),
      stockAvailableQty: round(stockAvailable),
      stockCoveredQty: round(Math.min(requiredQty, stockAvailable)),
      stockShortageQty: round(Math.max(requiredQty - stockAvailable, 0)),
      stockCheck: stockAvailable + 0.000001 >= requiredQty ? "COVERED" : "PURCHASE_REQUIRED",
      uomCode: order.uomCode || null,
      supplierCode: supplier.supplierCode,
      supplierName: supplier.supplierName,
      leadTimeDays: supplier.leadTimeDays,
      leadTimeSource: supplier.source,
      orderDate: calculatedOrderDate,
      requiredDate,
      latestDeliveryDate,
      prNumbers: [...prNumbers].filter(Boolean),
      poNumbers: [...poNumbers].filter(Boolean),
      ready: !lineIssues.some((issue) => issue.severity === "BLOCKING"),
      issues: lineIssues,
    };
  });

  const blocking = issues.filter((issue) => issue.severity === "BLOCKING").length;
  const warning = issues.filter((issue) => issue.severity === "WARNING").length;
  return {
    planNumber: plan.planNumber,
    mpsNumber,
    mrpRunNumber: run.runNumber,
    generatedAt: new Date(),
    ready: blocking === 0,
    summary: {
      total: items.length,
      blocking,
      warning,
      ready: items.filter((item) => item.ready).length,
      stockCoveredQty: round(items.reduce((sum, item) => sum + number(item.stockCoveredQty), 0)),
      stockShortageQty: round(items.reduce((sum, item) => sum + number(item.stockShortageQty), 0)),
    },
    issues,
    items,
  };
}

function suggestionSources(item) {
  return Array.isArray(item?.sourceRequirements)
    ? item.sourceRequirements.filter((source) => source && typeof source === "object")
    : [];
}

function confirmedSuggestionAllocation(allocation) {
  return allocation?.deliveryDate
    && number(allocation?.confirmedQty) > 0
    && (String(allocation?.status || "").toLowerCase() === "confirmed"
      || CONFIRMED_SUGGESTION_STATUSES.has(String(allocation?.confirmationStatus || "")));
}

/**
 * Resolve the earliest date on which the quantity represented by one Purchase
 * Suggestion line can be treated as available for the first production step.
 * Supplier confirmation is authoritative. An unconfirmed remainder keeps the
 * system-generated material due date as an explicit fallback instead of
 * silently pretending that the whole quantity was confirmed.
 */
function suggestionSystemMaterialDate(item, planningConstraintByTarget = new Map(), routingMetric = null) {
  const stored = item?.materialRequiredDate || item?.plannedProductionStart;
  const delivery = item?.customerDeliveryDate;
  const breakdown = routingMetric || item?.productionLeadTimeBreakdown;
  if (!delivery || !breakdown || typeof breakdown !== "object") return stored ? new Date(stored) : null;
  const targetIds = suggestionSources(item).map((source) => source.deliveryTargetId).filter(Boolean);
  const decision = targetIds.map((targetId) => planningConstraintByTarget.get(targetId)).find(Boolean) || null;
  const adjusted = applyDecisionToRoutingMetric(breakdown, decision).metric || breakdown;
  const queueDays = Math.ceil(number(adjusted.queueBufferHours ?? breakdown.queueBufferHours) / 8);
  const scheduledDays = Math.max(number(adjusted.productionLeadTimeDays) + queueDays, 0);
  if (scheduledDays <= 0) return stored ? new Date(stored) : new Date(delivery);
  return subtractWorkingDays(delivery, scheduledDays);
}

function resolveSuggestionMaterialGate(item, systemDateOverride = null) {
  const systemDate = day(systemDateOverride || item?.materialRequiredDate || item?.plannedProductionStart);
  const requiredQty = Math.max(number(item?.netRequirement), number(item?.recommendedPurchaseQty), 0);
  const allocations = (item?.supplierAllocations || [])
    .filter(confirmedSuggestionAllocation)
    .map((allocation) => ({
      qty: number(allocation.confirmedQty),
      date: day(allocation.deliveryDate),
      supplierCode: allocation.supplierCode || null,
      supplierName: allocation.supplierName || null,
    }))
    .filter((allocation) => allocation.date)
    .sort((left, right) => left.date - right.date || String(left.supplierCode || "").localeCompare(String(right.supplierCode || "")));

  let coveredQty = 0;
  let confirmedReadyDate = null;
  for (const allocation of allocations) {
    coveredQty += allocation.qty;
    confirmedReadyDate = allocation.date;
    if (requiredQty <= 0 || coveredQty + 0.000001 >= requiredQty) break;
  }

  const headerConfirmed = item?.confirmedDeliveryDate
    && CONFIRMED_SUGGESTION_STATUSES.has(String(item?.confirmationStatus || ""));
  if (!confirmedReadyDate && headerConfirmed) {
    confirmedReadyDate = day(item.confirmedDeliveryDate);
    coveredQty = Math.max(coveredQty, number(item.confirmedQty));
  }

  const fullyConfirmed = Boolean(confirmedReadyDate)
    && (requiredQty <= 0 || coveredQty + 0.000001 >= requiredQty || (headerConfirmed && item.confirmedQty == null));
  if (fullyConfirmed) {
    return {
      readyDate: confirmedReadyDate,
      source: "SUPPLIER_CONFIRMED_DELIVERY",
      confirmed: true,
      confirmedQty: round(coveredQty),
      requiredQty: round(requiredQty),
      systemDueDate: systemDate,
      supplierCodes: [...new Set(allocations.map((allocation) => allocation.supplierCode).filter(Boolean))],
      supplierNames: [...new Set(allocations.map((allocation) => allocation.supplierName).filter(Boolean))],
    };
  }

  const readyDate = [confirmedReadyDate, systemDate].filter(Boolean).sort((left, right) => right - left)[0] || null;
  return {
    readyDate,
    source: confirmedReadyDate ? "PARTIAL_CONFIRMATION_SYSTEM_DUE_FALLBACK" : "PURCHASE_SUGGESTION_SYSTEM_DUE",
    confirmed: false,
    confirmedQty: round(coveredQty),
    requiredQty: round(requiredQty),
    systemDueDate: systemDate,
    supplierCodes: [...new Set(allocations.map((allocation) => allocation.supplierCode).filter(Boolean))],
    supplierNames: [...new Set(allocations.map((allocation) => allocation.supplierName).filter(Boolean))],
  };
}

function summarizeMaterialGates(items = [], identity = {}) {
  const dated = items.filter((item) => item.readyDate);
  const latest = dated.sort((left, right) => right.readyDate - left.readyDate)[0] || null;
  const confirmedCount = items.filter((item) => item.confirmed).length;
  return {
    ...identity,
    readyDate: latest?.readyDate || null,
    source: latest?.source || (items.length ? "PURCHASE_SUGGESTION_SYSTEM_DUE" : "NO_PURCHASE_REQUIREMENT"),
    confirmed: items.length > 0 && confirmedCount === items.length,
    itemCount: items.length,
    confirmedItemCount: confirmedCount,
    fallbackItemCount: items.length - confirmedCount,
    criticalItems: latest
      ? items.filter((item) => item.readyDate?.getTime() === latest.readyDate.getTime()).map((item) => ({
        suggestionItemId: item.suggestionItemId,
        partCode: item.partCode,
        materialCode: item.materialCode,
        readyDate: item.readyDate,
        source: item.source,
        confirmed: item.confirmed,
        supplierCodes: item.supplierCodes,
        supplierNames: item.supplierNames,
      }))
      : [],
  };
}

async function buildProductionMaterialGate(prisma, planOrNumber) {
  const plan = typeof planOrNumber === "string"
    ? await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber: planOrNumber, isDeleted: false },
      select: { id: true, planNumber: true, sourceType: true, periodStart: true, periodEnd: true },
    })
    : planOrNumber;
  if (!plan) throw Object.assign(new Error("Monthly Production Plan tidak ditemukan."), { status: 404 });

  const mpsNumber = String(plan.sourceType || "").startsWith("MPS:")
    ? String(plan.sourceType).slice(4)
    : null;
  const empty = (source, extra = {}) => ({
    planNumber: plan.planNumber,
    mpsNumber,
    mrpRunNumber: null,
    suggestionNumber: null,
    readyDate: null,
    source,
    confirmed: false,
    itemCount: 0,
    confirmedItemCount: 0,
    fallbackItemCount: 0,
    criticalItems: [],
    phaseGates: {},
    items: [],
    ...extra,
  });
  if (!mpsNumber || typeof prisma.mRPRun?.findMany !== "function" || typeof prisma.purchaseSuggestion?.findFirst !== "function") {
    return empty("PURCHASE_SUGGESTION_NOT_AVAILABLE");
  }

  const currentRuns = await prisma.mRPRun.findMany({
    where: { isDeleted: false, isCurrentPlan: true, status: "Completed" },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { runNumber: true, mpsNumber: true, scenarioAssumptions: true, createdAt: true },
  });
  const run = currentRuns.find((candidate) => candidate.mpsNumber === mpsNumber
    || (Array.isArray(candidate.scenarioAssumptions?.sourceMpsNumbers)
      && candidate.scenarioAssumptions.sourceMpsNumbers.includes(mpsNumber)));
  if (!run) return empty("MRP_NOT_COMPLETED");

  const suggestion = await prisma.purchaseSuggestion.findFirst({
    where: { runNumber: run.runNumber, isDeleted: false, status: { not: "Cancelled" } },
    orderBy: { createdAt: "desc" },
    select: {
      suggestionNumber: true,
      status: true,
      items: {
        where: { isDeleted: false, status: { not: "Cancelled" }, netRequirement: { gt: 0 } },
        select: {
          id: true,
          mrpRequirementId: true,
          partCode: true,
          materialCode: true,
          sourceRequirements: true,
          customerDeliveryDate: true,
          plannedProductionStart: true,
          materialRequiredDate: true,
          productionLeadTimeBreakdown: true,
          netRequirement: true,
          recommendedPurchaseQty: true,
          confirmationStatus: true,
          confirmedQty: true,
          confirmedDeliveryDate: true,
          supplierAllocations: {
            where: { isDeleted: false },
            select: { supplierCode: true, supplierName: true, confirmationStatus: true, status: true, confirmedQty: true, deliveryDate: true },
          },
        },
      },
    },
  });
  if (!suggestion) return empty("PURCHASE_SUGGESTION_NOT_GENERATED", { mrpRunNumber: run.runNumber });

  const sourceTargetIds = [...new Set(suggestion.items.flatMap((item) =>
    suggestionSources(item).map((source) => source.deliveryTargetId)).filter(Boolean))];
  const planningConstraintByTarget = await loadDemandPlanningConstraintMap(prisma, sourceTargetIds);
  const requirementIds = [...new Set(suggestion.items.flatMap((item) => [
    item.mrpRequirementId,
    ...suggestionSources(item).filter((source) => source.allocationType !== "MOQ_PULL_FORWARD").map((source) => source.id),
  ]).filter(Boolean))];
  const schedulingRequirements = requirementIds.length && typeof prisma.mRPRequirement?.findMany === "function"
    ? await prisma.mRPRequirement.findMany({
      where: { id: { in: requirementIds }, runNumber: run.runNumber, isDeleted: false, mpsDetailId: { not: null } },
      select: { id: true, mpsDetailId: true, mpsDetail: { select: { mbomHeaderId: true, qtyPlanned: true } } },
    })
    : [];
  const schedulingRequirementById = new Map(schedulingRequirements.map((row) => [row.id, row]));
  const routingRequestByItemId = new Map();
  for (const item of suggestion.items) {
    const directSources = suggestionSources(item).filter((source) => source.allocationType !== "MOQ_PULL_FORWARD");
    const sourceRows = directSources.length ? directSources : suggestionSources(item);
    const linked = [...new Set([item.mrpRequirementId, ...sourceRows.map((source) => source.id)].filter(Boolean))]
      .map((id) => schedulingRequirementById.get(id))
      .filter(Boolean);
    const headerId = linked.find((row) => row.mpsDetail?.mbomHeaderId)?.mpsDetail?.mbomHeaderId || null;
    const uniqueDetails = new Map(linked.filter((row) => row.mpsDetailId).map((row) => [row.mpsDetailId, row.mpsDetail]));
    routingRequestByItemId.set(item.id, {
      headerId,
      scheduleQty: round([...uniqueDetails.values()].reduce((sum, detail) => sum + number(detail?.qtyPlanned), 0)),
    });
  }
  let routingMetrics = new Map();
  let routingMetricKey = () => null;
  if (routingRequestByItemId.size) {
    // Use the same qty-aware critical-path calculator as the Purchase
    // Suggestion popup. The lazy import avoids a controller/service load cycle.
    const purchaseSuggestionController = require("../../controllers/purchasing/PurchaseSuggestionController");
    routingMetricKey = purchaseSuggestionController.routingMetricKey;
    routingMetrics = await purchaseSuggestionController.routingMetricsForRequests(prisma, [...routingRequestByItemId.values()]);
  }

  const items = suggestion.items.flatMap((item) => {
    const sources = suggestionSources(item).filter((source) => !source.mpsNumber || source.mpsNumber === mpsNumber);
    if (!sources.length && suggestionSources(item).length) return [];
    const routingRequest = routingRequestByItemId.get(item.id) || {};
    const authoritativeRoutingMetric = routingRequest.headerId
      ? routingMetrics.get(routingMetricKey(routingRequest.headerId, routingRequest.scheduleQty))
      : null;
    const calculatedSystemDate = suggestionSystemMaterialDate(item, planningConstraintByTarget, authoritativeRoutingMetric);
    const gate = resolveSuggestionMaterialGate(item, calculatedSystemDate);
    return [{
      suggestionItemId: item.id,
      partCode: item.partCode,
      materialCode: item.materialCode,
      deliveryTargetIds: [...new Set(sources.map((source) => source.deliveryTargetId).filter(Boolean))],
      storedSystemDueDate: day(item.materialRequiredDate || item.plannedProductionStart),
      calculationSource: calculatedSystemDate ? "PURCHASE_SUGGESTION_BACKWARD_DUE" : "PURCHASE_SUGGESTION_STORED_DUE",
      ...gate,
    }];
  });
  const identity = {
    planNumber: plan.planNumber,
    mpsNumber,
    mrpRunNumber: run.runNumber,
    suggestionNumber: suggestion.suggestionNumber,
    suggestionStatus: suggestion.status,
  };
  const overall = summarizeMaterialGates([...items], identity);
  const targetIds = [...new Set(items.flatMap((item) => item.deliveryTargetIds))];
  const phaseGates = Object.fromEntries(targetIds.map((targetId) => [
    targetId,
    summarizeMaterialGates(items.filter((item) => item.deliveryTargetIds.includes(targetId)), { ...identity, deliveryTargetId: targetId }),
  ]));
  return { ...overall, phaseGates, items };
}

function materialGateForJob(gate, job = {}) {
  const targetId = job.sourceDeliveryTargetId || job.deliveryTargetId || job.id || null;
  return (targetId && gate?.phaseGates?.[targetId]) || gate || null;
}

module.exports = {
  buildMaterialReadinessSnapshot,
  buildProductionMaterialGate,
  materialGateForJob,
  resolveSuggestionMaterialGate,
  suggestionSystemMaterialDate,
};
