const TRANSACTIONAL_DELEGATES = [
  // Sales Order is upstream demand and must remain intact for an MRP-to-delivery reset.
  "deliveryScheduleDetail", "deliverySchedule",
  "stockOpnameDetail", "stockOpnameHeader",
  "incomingInspectionDetail", "incomingInspection", "purchaseInvoicePayment", "purchaseInvoiceDetail", "purchaseInvoicePO", "purchaseInvoice",
  "goodsReceiptDetail", "goodsReceipt", "purchaseOrderComment", "purchaseOrderPR", "purchaseOrderDetail", "purchaseOrder",
  "purchaseRequisitionDetail", "purchaseRequisition",
  "qualityInspectionDetail", "qualityInspection", "downtimeLog", "materialIssueDetail", "materialIssue", "productionLog", "dailyProductionSchedule", "wIPEntry", "vendorProcessOrder", "manufacturingOrderSourceWip", "workOrder", "manufacturingOrder", "diesUsage",
  "dailyPlanningException", "dailyPlanRevision",
  "purchaseSuggestionSupplierAllocation", "purchaseSuggestionItem", "purchaseSuggestion",
  "monthlyPlanRecommendationItem", "monthlyPlanRecommendationScenario", "capacityEditChange", "capacityQueueItem", "capacityEditSession", "productionPlanAllocation",
  "capacityMachineOverride", "capacityDayOverride", "monthlyProductionPlanDetail", "monthlyProductionPlan",
  "planningAdjustmentLine", "planningAdjustment", "additionalDemandCoverage", "planningBaselineLock",
  "rccpRecommendation", "rccpOverride", "rccpOffsetDetail", "rccpTimeBucket", "rccpLoad", "rccpRun", "mPSDeliveryFeasibilitySnapshot", "mPSDeliveryPlan",
  "mRPPegging", "mRPDirtyItem", "mRPPartialSnapshot", "plannedOrder", "mRPRequirement", "mRPRun", "mPSDetail", "mPS",
  "approvalAction", "approvalRequest", "notification",
];

const RESETTABLE_STOCK_REFERENCE_TYPES = [
  "GR", "GOODS_RECEIPT", "INCOMING_INSPECTION", "QUALITY_INSPECTION",
  "PRODUCTION_LOG", "WORK_ORDER", "MANUFACTURING_ORDER", "DELIVERY_SCHEDULE",
];

function stockIdentityWhere(movement) {
  const identity = movement.partCode
    ? { partCode: movement.partCode }
    : movement.materialCode
      ? { materialCode: movement.materialCode }
      : movement.materialId
        ? { materialId: movement.materialId }
        : movement.productId
          ? { productId: movement.productId }
          : { description: movement.description || null };
  return {
    warehouseCode: movement.warehouseCode,
    rackCode: movement.rackCode || null,
    lotNumber: null,
    isDeleted: false,
    ...identity,
  };
}

async function rollbackFlowInventory(tx, removed) {
  const generatedNoLotMovements = await tx.stockMovement.findMany({
    where: {
      isDeleted: false,
      lotNumber: null,
      OR: [
        { referenceType: { in: RESETTABLE_STOCK_REFERENCE_TYPES } },
        { transactionType: { in: ["PURCHASE_RECEIVE", "QUALITY_RELEASE", "QC_HOLD", "PRODUCTION", "SALES", "RETURN", "REJECT", "REWORK", "SCRAP"] } },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { movementNumber: "desc" }],
  });
  for (const movement of generatedNoLotMovements) {
    const balance = await tx.stockBalance.findFirst({ where: stockIdentityWhere(movement) });
    if (!balance) continue;
    const restoredOnHand = movement.qtyBefore == null
      ? Number(balance.qtyOnHand || 0) - Number(movement.deltaQty || 0)
      : Number(movement.qtyBefore);
    await tx.stockBalance.update({
      where: { id: balance.id },
      data: { qtyOnHand: restoredOnHand, qtyAvailable: Math.max(restoredOnHand - Number(balance.qtyReserved || 0) - Number(balance.qtyQC || 0), 0) },
    });
  }

  removed.stockMovement = (await tx.stockMovement.deleteMany({
    where: {
      OR: [
        { lotNumber: { not: null } },
        { id: { in: generatedNoLotMovements.map((row) => row.id) } },
      ],
    },
  })).count;
  removed.stockReservation = (await tx.stockReservation.deleteMany({
    where: {
      OR: [
        { lotNumber: { not: null } },
        { referenceType: { in: ["SO", "MPS", "MANUFACTURING_ORDER", "WORK_ORDER", "MATERIAL_ISSUE", "DELIVERY_SCHEDULE"] } },
      ],
    },
  })).count;
  await tx.stockReservation.updateMany({
    where: { lotNumber: null, referenceType: "PART_ALLOCATION", isDeleted: false },
    data: { qtyReleased: 0, status: "Active" },
  });
}

async function finishFlowInventoryReset(tx, removed) {
  removed.stockBalance = (await tx.stockBalance.deleteMany({ where: { lotNumber: { not: null } } })).count;
  removed.lotMaster = (await tx.lotMaster.deleteMany({})).count;
  const balances = await tx.stockBalance.findMany({ where: { lotNumber: null, isDeleted: false } });
  const reservations = await tx.stockReservation.findMany({
    where: { lotNumber: null, isDeleted: false, status: "Active", stockBalanceId: { not: null } },
    select: { stockBalanceId: true, qtyReserved: true, qtyReleased: true },
  });
  const reservedByBalance = new Map();
  for (const row of reservations) reservedByBalance.set(row.stockBalanceId, (reservedByBalance.get(row.stockBalanceId) || 0) + Math.max(Number(row.qtyReserved || 0) - Number(row.qtyReleased || 0), 0));
  for (const balance of balances) {
    const qtyReserved = reservedByBalance.get(balance.id) || 0;
    await tx.stockBalance.update({
      where: { id: balance.id },
      data: { qtyReserved, qtyAvailable: Math.max(Number(balance.qtyOnHand || 0) - qtyReserved - Number(balance.qtyQC || 0), 0) },
    });
  }
  removed.stockBalancesPreservedNoLot = balances.length;
}

// Destructive scope is MRP through Delivery. Forecast and Sales Order remain
// upstream demand; use resetDemandFlow when those documents must be removed.
const DEMAND_RESET_DELEGATES = [
  "stockReservation",
  "deliveryScheduleDetail", "deliverySchedule", "salesOrderAttachment", "salesOrderDetail", "salesOrderHeader",
  "mRPPegging", "mRPDirtyItem", "mRPPartialSnapshot", "plannedOrder", "mRPRequirement", "mRPRun",
  "demandExceptionAction", "demandException",
  "monthlyDemandSnapshot",
  "mPSDetail", "mPS", "forecastDetail", "forecast",
];

async function countPlanningFlowRows(db) {
  const counts = {};
  for (const delegate of TRANSACTIONAL_DELEGATES) counts[delegate] = await db[delegate].count();
  counts.stockBalance = await db.stockBalance.count({ where: { lotNumber: { not: null } } });
  counts.stockBalancesPreservedNoLot = await db.stockBalance.count({ where: { lotNumber: null, isDeleted: false } });
  counts.stockMovement = await db.stockMovement.count({ where: { OR: [{ lotNumber: { not: null } }, { referenceType: { in: RESETTABLE_STOCK_REFERENCE_TYPES } }] } });
  counts.stockReservation = await db.stockReservation.count({ where: { OR: [{ lotNumber: { not: null } }, { referenceType: { in: ["SO", "MPS", "MANUFACTURING_ORDER", "WORK_ORDER", "MATERIAL_ISSUE", "DELIVERY_SCHEDULE"] } }] } });
  counts.lotMaster = await db.lotMaster.count();
  counts.forecast = await db.forecast.count({ where: { isDeleted: false } });
  counts.forecastDetail = await db.forecastDetail.count({ where: { isDeleted: false } });
  return counts;
}

async function resetPlanningFlow(prisma, { forecastStatus = "Confirmed" } = {}) {
  const before = await countPlanningFlowRows(prisma);
  const removed = {};
  await prisma.$transaction(async (tx) => {
    // Serialize reset operations so two test runs cannot interleave deletes.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(2026072701)`;
    await rollbackFlowInventory(tx, removed);
    for (const delegate of TRANSACTIONAL_DELEGATES) {
      removed[delegate] = (await tx[delegate].deleteMany({})).count;
    }
    removed.salesOrderDetailsReopened = (await tx.salesOrderDetail.updateMany({
      where: { isDeleted: false, OR: [{ qtyDelivered: { gt: 0 } }, { qtyProduced: { gt: 0 } }, { status: { in: ["In Planning", "In Production", "Completed"] } }] },
      data: { qtyDelivered: 0, qtyProduced: 0, status: "Pending" },
    })).count;
    removed.salesOrdersReopened = (await tx.salesOrderHeader.updateMany({
      where: { isDeleted: false, status: { in: ["In Progress", "Ready to Deliver", "Delivered"] } },
      data: { status: "Confirmed" },
    })).count;
    await finishFlowInventoryReset(tx, removed);
    removed.forecastsReopened = (await tx.forecast.updateMany({
      where: { isDeleted: false, status: { not: forecastStatus } },
      data: { status: forecastStatus, approvedBy: null, approvedDate: null },
    })).count;
  }, { maxWait: 30000, timeout: 120000 });
  const after = await countPlanningFlowRows(prisma);
  return { status: "COMPLETED", scope: "MPS through Delivery", forecastStatus, before, removed, after };
}

async function countDemandResetRows(db) {
  const counts = {};
  for (const delegate of DEMAND_RESET_DELEGATES) {
    counts[delegate] = delegate === "stockReservation"
      ? await db[delegate].count({ where: { referenceType: "SO" } })
      : await db[delegate].count();
  }
  return counts;
}

async function resetDemandFlow(prisma) {
  const before = await countDemandResetRows(prisma);
  const removed = {};
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(2026072804)`;
    for (const delegate of DEMAND_RESET_DELEGATES) {
      const where = delegate === "stockReservation" ? { referenceType: "SO" } : {};
      removed[delegate] = (await tx[delegate].deleteMany({ where })).count;
    }
  }, { maxWait: 30000, timeout: 120000 });
  const after = await countDemandResetRows(prisma);
  return { status: "COMPLETED", scope: "Sales Order + Forecast + MPS + MRP", before, removed, after };
}

module.exports = { TRANSACTIONAL_DELEGATES, DEMAND_RESET_DELEGATES, countPlanningFlowRows, resetPlanningFlow, countDemandResetRows, resetDemandFlow };
