const TRANSACTIONAL_DELEGATES = [
  // Sales Order is upstream demand and must remain intact for an MRP-to-delivery reset.
  "deliveryScheduleDetail", "deliverySchedule",
  "stockReservation", "stockMovement", "stockOpnameDetail", "stockOpnameHeader", "stockBalance",
  "incomingInspectionDetail", "incomingInspection", "purchaseInvoicePayment", "purchaseInvoiceDetail", "purchaseInvoicePO", "purchaseInvoice",
  "goodsReceiptDetail", "goodsReceipt", "purchaseOrderComment", "purchaseOrderPR", "purchaseOrderDetail", "purchaseOrder",
  "purchaseRequisitionDetail", "purchaseRequisition",
  "qualityInspectionDetail", "qualityInspection", "downtimeLog", "materialIssueDetail", "materialIssue", "productionLog", "dailyProductionSchedule", "wIPEntry", "vendorProcessOrder", "manufacturingOrderSourceWip", "workOrder", "manufacturingOrder", "diesUsage",
  "capacityMachineOverride", "capacityDayOverride", "monthlyProductionPlanDetail", "monthlyProductionPlan",
  "mRPPegging", "mRPDirtyItem", "mRPPartialSnapshot", "plannedOrder", "mRPRequirement", "mRPRun", "mPSDetail", "mPS",
  "approvalAction", "approvalRequest", "notification",
];

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
    for (const delegate of TRANSACTIONAL_DELEGATES) {
      removed[delegate] = (await tx[delegate].deleteMany({})).count;
    }
    removed.forecastsReopened = (await tx.forecast.updateMany({
      where: { isDeleted: false, status: { in: ["Consumed", "Partial Product", "Closed"] } },
      data: { status: forecastStatus },
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
