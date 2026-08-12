"use strict";

const { consolidateRequirements, procurementWindow } = require("./demandPlanningService");
const { procurementSchedule } = require("./procurementSchedulingService");
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const dateKey = (value) => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toISOString().slice(0, 10) : null;

function resolvePurchaseScheduleForRequirement({ row, suggestionByPartDelivery, requirementsByPartDate, suggestionByRequirementId }) {
  const requirementKey = `${row.partCode}|${dateKey(row.requiredDate)}`;
  return suggestionByPartDelivery.get(requirementKey)
    || (requirementsByPartDate.get(requirementKey) || []).map((requirement) => suggestionByRequirementId.get(requirement.id)).find(Boolean)
    || null;
}

function resolveProcurementMasterIdentity({ row, order, purchaseSchedule, partMaster, supplierByCode = new Map() }) {
  const preferredSupplierItem = partMaster?.supplierItems?.[0] || null;
  const recommendedSupplier = preferredSupplierItem?.supplier || partMaster?.supplier || null;
  const supplierCode = purchaseSchedule?.suggestedSupplierCode
    || order?.supplierCode
    || row?.supplierCode
    || recommendedSupplier?.supplierCode
    || null;
  const supplierName = purchaseSchedule?.suggestedSupplierName
    || supplierByCode.get(supplierCode)?.supplierName
    || (recommendedSupplier?.supplierCode === supplierCode ? recommendedSupplier?.supplierName : null)
    || null;
  const isRawMaterial = partMaster?.itemType === "RAW" && partMaster?.rawType === "MATERIAL";
  const linkedMaterial = isRawMaterial ? partMaster?.material : null;
  return {
    supplierCode,
    supplierName,
    supplierSource: purchaseSchedule?.suggestedSupplierCode
      ? "PURCHASE_SUGGESTION"
      : order?.supplierCode
        ? "PLANNED_ORDER"
        : preferredSupplierItem?.supplier
          ? "SUPPLIER_ITEM_PREFERRED"
          : partMaster?.supplier
            ? "PART_DEFAULT"
            : null,
    materialCode: linkedMaterial?.materialCode || purchaseSchedule?.materialCode || row?.partCode || null,
    materialName: linkedMaterial?.materialName || linkedMaterial?.spec || null,
    isRawMaterial,
    supplierLeadTimeDays: number(
      purchaseSchedule?.purchasingLeadTimeDays
      ?? preferredSupplierItem?.leadTimeDays
      ?? recommendedSupplier?.leadTimeDays
      ?? row?.leadTime
    ),
  };
}

async function resolveRun(prisma, identifier) {
  return prisma.mRPRun.findFirst({
    where: { isDeleted: false, OR: [{ runNumber: identifier }, { planNumber: identifier, isCurrentPlan: true }] },
    orderBy: [{ isCurrentPlan: "desc" }, { planRevision: "desc" }],
    select: { runNumber: true, planNumber: true, planRevision: true, planningMonth: true, cutoffDate: true, status: true },
  });
}

async function procurementView(prisma, identifier, asOf = new Date()) {
  const run = await resolveRun(prisma, identifier);
  if (!run) throw Object.assign(new Error("MRP run tidak ditemukan."), { statusCode: 404 });
  const [requirements, orders, suggestion] = await Promise.all([
    prisma.mRPRequirement.findMany({ where: { runNumber: run.runNumber, isDeleted: false, orderType: "Purchase" }, orderBy: [{ requiredDate: "asc" }, { partCode: "asc" }] }),
    prisma.plannedOrder.findMany({ where: { runNumber: run.runNumber, isDeleted: false, orderType: "Purchase", status: { not: "Cancelled" } }, orderBy: [{ requiredDate: "asc" }, { partCode: "asc" }] }),
    prisma.purchaseSuggestion.findFirst({
      where: { runNumber: run.runNumber, isDeleted: false, status: { not: "Cancelled" } },
      orderBy: { createdAt: "desc" },
      select: {
        suggestionNumber: true,
        items: {
          where: { isDeleted: false },
          select: {
            partCode: true, materialCode: true, customerDeliveryDate: true,
            plannedProductionStart: true, materialRequiredDate: true,
            recommendedOrderDate: true, latestPrDate: true, procurementWindow: true,
            scheduleSource: true, purchasingLeadTimeDays: true,
            productionLeadTimeHours: true, suggestedSupplierCode: true, suggestedSupplierName: true,
            sourceRequirements: true,
          },
        },
      },
    }),
  ]);
  const partCodes = [...new Set([
    ...requirements.map((row) => row.partCode),
    ...orders.map((row) => row.partCode),
    ...(suggestion?.items || []).flatMap((row) => [row.partCode, row.materialCode]),
  ].filter(Boolean))];
  const supplierCodes = [...new Set([
    ...requirements.map((row) => row.supplierCode),
    ...orders.map((row) => row.supplierCode),
    ...(suggestion?.items || []).map((row) => row.suggestedSupplierCode),
  ].filter(Boolean))];
  const [parts, suppliers] = await Promise.all([
    partCodes.length ? prisma.part.findMany({
      where: { partCode: { in: partCodes }, isDeleted: false },
      select: {
        partCode: true, partNumber: true, partName: true, itemType: true, rawType: true,
        material: { select: { materialCode: true, materialName: true, spec: true } },
        supplier: { select: { supplierCode: true, supplierName: true, leadTimeDays: true } },
        supplierItems: {
          where: { isActive: true },
          orderBy: [{ isPreferred: "desc" }, { priority: "asc" }],
          take: 1,
          select: {
            leadTimeDays: true,
            supplier: { select: { supplierCode: true, supplierName: true, leadTimeDays: true } },
          },
        },
      },
    }) : [],
    supplierCodes.length ? prisma.supplier.findMany({
      where: { supplierCode: { in: supplierCodes }, isDeleted: false },
      select: { supplierCode: true, supplierName: true },
    }) : [],
  ]);
  const partByCode = new Map(parts.map((part) => [part.partCode, part]));
  const supplierByCode = new Map(suppliers.map((supplier) => [supplier.supplierCode, supplier]));
  const orderByPartDate = new Map(orders.map((row) => [`${row.partCode}|${new Date(row.requiredDate).toISOString().slice(0, 10)}`, row]));
  const suggestionByPartDelivery = new Map((suggestion?.items || []).map((row) => [`${row.partCode}|${dateKey(row.customerDeliveryDate)}`, row]));
  const suggestionByRequirementId = new Map((suggestion?.items || []).flatMap((item) => (Array.isArray(item.sourceRequirements) ? item.sourceRequirements : []).map((source) => [source.id, item])).filter(([id]) => id));
  const requirementsByPartDate = new Map();
  for (const requirement of requirements) {
    const requirementKey = `${requirement.partCode}|${dateKey(requirement.requiredDate)}`;
    if (!requirementsByPartDate.has(requirementKey)) requirementsByPartDate.set(requirementKey, []);
    requirementsByPartDate.get(requirementKey).push(requirement);
  }
  const grouped = consolidateRequirements(requirements.map((row) => ({ ...row, qty: row.grossRequirement, onHandQty: row.onHandQty, openSupply: (Array.isArray(row.supplyTimeline) ? row.supplyTimeline : []).map((supply) => ({ id: supply.id, sourceType: supply.sourceType, sourceNumber: supply.sourceNumber, qty: supply.qty, arrivalDate: supply.availableDate || supply.arrivalDate || supply.date })), customerCode: row.customerCode, fgPartCode: row.fgPartCode, targetDeliveryDate: row.targetDeliveryDate, deliveryTargetId: row.deliveryTargetId, sourceType: row.rootDemandSourceType, sourceNumber: row.rootDemandSourceNumber })));
  const items = grouped.map((row) => {
    const order = orderByPartDate.get(`${row.partCode}|${new Date(row.requiredDate).toISOString().slice(0, 10)}`) || orders.find((item) => item.partCode === row.partCode);
    const purchaseSchedule = resolvePurchaseScheduleForRequirement({ row, suggestionByPartDelivery, requirementsByPartDate, suggestionByRequirementId });
    const partMaster = partByCode.get(row.partCode) || partByCode.get(purchaseSchedule?.partCode) || null;
    const masterIdentity = resolveProcurementMasterIdentity({ row, order, purchaseSchedule, partMaster, supplierByCode });
    const materialRequiredDate = purchaseSchedule?.materialRequiredDate || row.materialRequiredDate || row.requiredDate;
    const schedule = procurementSchedule({
      materialRequiredDate,
      supplierLeadTimeDays: masterIdentity.supplierLeadTimeDays,
      asOf,
    });
    const latestRequirementPr = requirements
      .filter((item) => item.partCode === row.partCode && dateKey(item.requiredDate) === dateKey(row.requiredDate))
      .map((item) => item.latestPrDate).filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0] || null;
    return {
      supplierCode: masterIdentity.supplierCode,
      supplierName: masterIdentity.supplierName,
      supplierSource: masterIdentity.supplierSource,
      materialCode: masterIdentity.materialCode,
      materialName: masterIdentity.materialName,
      isRawMaterial: masterIdentity.isRawMaterial,
      partCode: row.partCode,
      partNumber: partMaster?.partNumber || null,
      partName: partMaster?.partName || null,
      customerDeliveryDate: row.targetDeliveryDate || purchaseSchedule?.customerDeliveryDate || row.requiredDate,
      productionStartDate: purchaseSchedule?.plannedProductionStart || null,
      materialRequiredDate,
      supplierRequiredArrivalDate: schedule.supplierRequiredArrivalDate,
      requiredArrivalWindow: purchaseSchedule?.procurementWindow || schedule.procurementWindow || procurementWindow(asOf, materialRequiredDate),
      exactRequiredDate: materialRequiredDate,
      latestPoDate: schedule.latestPoDate,
      latestPrDate: purchaseSchedule?.latestPrDate || purchaseSchedule?.recommendedOrderDate || latestRequirementPr || schedule.latestPrDate,
      purchaseSuggestionNumber: suggestion?.suggestionNumber || null,
      scheduleSource: purchaseSchedule?.scheduleSource || row.scheduleSource || "MRP_BACKWARD_SCHEDULE",
      productionLeadTimeHours: number(purchaseSchedule?.productionLeadTimeHours),
      supplierLeadTimeDays: masterIdentity.supplierLeadTimeDays,
      requirementQty: row.qty,
      coveredQty: row.coveredQty,
      shortageQty: row.shortageQty,
      moq: row.moq,
      suggestedOrderQty: number(order?.qty) || row.suggestedOrderQty,
      risk: row.shortageQty > 0 && new Date(schedule.latestPrDate) < asOf ? "EXPEDITE" : row.shortageQty > 0 ? "SHORTAGE" : "COVERED",
      pegging: row.pegging,
    };
  });
  items.sort((left, right) => new Date(left.supplierRequiredArrivalDate) - new Date(right.supplierRequiredArrivalDate)
    || new Date(left.customerDeliveryDate) - new Date(right.customerDeliveryDate)
    || String(left.materialCode || left.partCode).localeCompare(String(right.materialCode || right.partCode)));
  return { run, items };
}

async function customerPeggingView(prisma, identifier) {
  const run = await resolveRun(prisma, identifier);
  if (!run) throw Object.assign(new Error("MRP run tidak ditemukan."), { statusCode: 404 });
  const requirements = await prisma.mRPRequirement.findMany({ where: { runNumber: run.runNumber, isDeleted: false }, orderBy: [{ targetDeliveryDate: "asc" }, { partCode: "asc" }] });
  const items = requirements.flatMap((row) => {
    const pegging = Array.isArray(row.customerPegging) && row.customerPegging.length ? row.customerPegging : [{ customerCode: row.customerCode, sourceType: row.rootDemandSourceType, sourceNumber: row.rootDemandSourceNumber, deliveryTargetId: row.deliveryTargetId, targetDeliveryDate: row.targetDeliveryDate, fgPartCode: row.fgPartCode, qty: row.grossRequirement }];
    return pegging.map((peg) => ({ customerCode: peg.customerCode || row.customerCode || null, targetDeliveryDate: peg.targetDeliveryDate || row.targetDeliveryDate, fgPartCode: peg.fgPartCode || row.fgPartCode, materialOrComponent: row.partCode, requirementQty: number(peg.qty || row.grossRequirement), supplyCoverageQty: Math.min(number(row.onHandQty) + number(row.firmSupplyQty), number(peg.qty || row.grossRequirement)), risk: number(row.netRequirement) > 0 ? "SHORTAGE" : "COVERED", sourceType: peg.sourceType || row.rootDemandSourceType, sourceNumber: peg.sourceNumber || row.rootDemandSourceNumber, deliveryTargetId: peg.deliveryTargetId || row.deliveryTargetId, requiredDate: row.requiredDate }));
  });
  return { run, items };
}

module.exports = { resolveProcurementMasterIdentity, resolvePurchaseScheduleForRequirement, resolveRun, procurementView, customerPeggingView };
