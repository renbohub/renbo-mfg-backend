/* eslint-disable no-console */
// Destructive simulation reset requested by the operator.
// Removes transactional data from Forecast through Inventory. By default it
// keeps StockBalance and StockMovement rows whose lot number is empty/null;
// --purge-all-stock removes those rows too and leaves inventory at zero.

const fs = require("fs");
const path = require("path");
const { prisma } = require("../src/prisma");

const execute = process.argv.includes("--execute");
const purgeAllStock = process.argv.includes("--purge-all-stock");

const DELETE_ALL_DELEGATES = [
  "productionLogCarryover",
  "productionLogNgReason",
  "productionLogCoilPhase",
  "incomingInspectionDetail",
  "incomingInspection",
  "purchaseInvoicePayment",
  "purchaseInvoiceDetail",
  "purchaseInvoicePO",
  "purchaseInvoice",
  "goodsReceiptAllocation",
  "goodsReceiptDetail",
  "goodsReceipt",
  "purchaseOrderComment",
  "purchaseOrderPR",
  "purchaseOrderDetail",
  "purchaseOrder",
  "purchaseRequisitionSourcingAllocation",
  "purchaseRequisitionSource",
  "purchaseRequisitionDetail",
  "purchaseRequisition",
  "purchaseSuggestionSupplierAllocation",
  "purchaseSuggestionItem",
  "purchaseSuggestion",
  "qualityInspectionDetail",
  "qualityInspection",
  "downtimeLog",
  "materialIssueDetail",
  "materialIssue",
  "productionLog",
  "dailyPlanningException",
  "dailyProductionSchedule",
  "dailyPlanRevision",
  "machineAvailabilityEvent",
  "wIPEntry",
  "vendorProcessOrder",
  "manufacturingOrderSourceWip",
  "workOrder",
  "manufacturingOrder",
  "diesUsage",
  "stockReservation",
  "capacityEditChange",
  "capacityQueueItem",
  "capacityEditSession",
  "monthlyPlanRecommendationItem",
  "monthlyPlanRecommendationScenario",
  "productionPlanAllocation",
  "capacityMachineOverride",
  "capacityDayOverride",
  "monthlyProductionPlanDetail",
  "monthlyProductionPlan",
  "planningChangeImpact",
  "planningAdjustmentLine",
  "planningAdjustment",
  "additionalDemandCoverage",
  "planningBaselineLock",
  "rccpRecommendation",
  "rccpOverride",
  "rccpOffsetDetail",
  "rccpTimeBucket",
  "rccpLoad",
  "rccpRun",
  "mRPPegging",
  "mRPDirtyItem",
  "mRPPartialSnapshot",
  "plannedOrder",
  "mRPRequirement",
  "mRPRun",
  "mPSDeliveryFeasibilitySnapshot",
  "mPSDemandSource",
  "mPSDeliveryPlan",
  "mPSDetail",
  "mPS",
  "dueDateRecoveryPlan",
  "dPPDisplacementProposal",
  "demandPlanningDecision",
  "monthlyDemandSnapshotAction",
  "monthlyDemandSnapshotDetail",
  "monthlyDemandSnapshot",
  "demandExceptionAction",
  "demandException",
  "demandDeliveryTarget",
  "deliveryScheduleDetail",
  "deliverySchedule",
  "salesOrderAttachment",
  "salesOrderDetail",
  "salesOrderHeader",
  "forecastDetail",
  "forecast",
  "stockOpnameCountAttempt",
  "stockOpnameCountRound",
  "stockOpnameDetail",
  "stockOpnameHeader",
];

const TRANSACTION_APPROVAL_TYPES = [
  "Forecast",
  "SalesOrder",
  "DemandPlanning",
  "DueDateRecoveryPlan",
  "DPPDisplacementProposal",
  "MPS",
  "MRP",
  "PurchaseSuggestion",
  "MonthlyProductionPlan",
  "ProductionPlan",
  "PurchaseRequisition",
  "PurchaseOrder",
  "GoodsReceipt",
  "IncomingInspection",
  "PurchaseInvoice",
  "ManufacturingOrder",
  "WorkOrder",
  "ProductionLog",
  "QualityInspection",
  "MaterialIssue",
  "DeliverySchedule",
  "StockOpname",
  "StockMovement",
];

const TRANSACTION_NOTIFICATION_TYPES = [
  "forecast",
  "sales_order",
  "demand_planning",
  "due_date_recovery",
  "dpp_displacement",
  "mps",
  "mrp",
  "purchase_suggestion",
  "monthly_production_plan",
  "production_plan",
  "purchase_requisition",
  "purchase_order",
  "goods_receipt",
  "incoming_inspection",
  "purchase_invoice",
  "manufacturing_order",
  "work_order",
  "production",
  "production_log",
  "quality_inspection",
  "material_issue",
  "delivery_schedule",
  "stock_opname",
  "stock_movement",
];

const approvalWhere = { documentType: { in: TRANSACTION_APPROVAL_TYPES } };
const approvalActionWhere = { request: { documentType: { in: TRANSACTION_APPROVAL_TYPES } } };
const notificationWhere = { type: { in: TRANSACTION_NOTIFICATION_TYPES } };
const hasNoLot = (row) => !String(row.lotNumber ?? "").trim();
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

async function loadScope(db) {
  const rows = {};
  for (const delegate of DELETE_ALL_DELEGATES) {
    rows[delegate] = await db[delegate].findMany();
  }

  rows.approvalAction = await db.approvalAction.findMany({ where: approvalActionWhere });
  rows.approvalRequest = await db.approvalRequest.findMany({ where: approvalWhere });
  rows.notification = await db.notification.findMany({ where: notificationWhere });
  rows.lotMaster = await db.lotMaster.findMany();

  const stockBalances = await db.stockBalance.findMany();
  const stockMovements = await db.stockMovement.findMany();
  return {
    rows,
    deleteStockBalances: purgeAllStock ? stockBalances : stockBalances.filter((row) => !hasNoLot(row)),
    preserveStockBalances: purgeAllStock ? [] : stockBalances.filter(hasNoLot),
    deleteStockMovements: purgeAllStock ? stockMovements : stockMovements.filter((row) => !hasNoLot(row)),
    preserveStockMovements: purgeAllStock ? [] : stockMovements.filter(hasNoLot),
  };
}

function summarize(scope) {
  return {
    ...Object.fromEntries(Object.entries(scope.rows).map(([name, rows]) => [name, rows.length])),
    stockBalanceWithLot: scope.deleteStockBalances.length,
    stockBalanceWithoutLotPreserved: scope.preserveStockBalances.length,
    stockMovementWithLot: scope.deleteStockMovements.length,
    stockMovementWithoutLotPreserved: scope.preserveStockMovements.length,
  };
}

function ids(rows) {
  return rows.map((row) => row.id);
}

async function deleteIds(delegate, targetIds) {
  return targetIds.length
    ? (await delegate.deleteMany({ where: { id: { in: targetIds } } })).count
    : 0;
}

function assertPreservedStock(beforeRows, afterRows) {
  const afterById = new Map(afterRows.map((row) => [row.id, row]));
  for (const before of beforeRows) {
    const after = afterById.get(before.id);
    if (!after) throw new Error(`Stock tanpa lot ikut terhapus: ${before.id}`);
    if (!hasNoLot(after)) throw new Error(`Lot stock yang dipertahankan berubah: ${before.id}`);
    if (Number(after.qtyOnHand) !== Number(before.qtyOnHand)) {
      throw new Error(`Qty on hand stock tanpa lot berubah: ${before.id}`);
    }
    if (Number(after.qtyQC) !== Number(before.qtyQC)) {
      throw new Error(`Qty QC stock tanpa lot berubah: ${before.id}`);
    }
  }
}

async function main() {
  const before = await loadScope(prisma);
  console.log(JSON.stringify({
    mode: execute ? "EXECUTE" : "DRY_RUN",
    purgeAllStock,
    before: summarize(before),
    preservedMasterData: true,
    preservedCapacityCalendarPreset: true,
    note: purgeAllStock
      ? "Seluruh stock balance, stock movement, dan lot dihapus; inventory menjadi nol."
      : "Stock balance dan stock movement tanpa lot dipertahankan.",
  }, null, 2));

  if (!execute) {
    console.log("Dry-run selesai. Gunakan --execute untuk menjalankan reset.");
    return;
  }

  const backupDir = path.join(__dirname, "..", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `forecast-to-stock-reset-${stamp()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    scope: purgeAllStock ? "Forecast through Stock; all stock purged" : "Forecast through Stock; no-lot stock preserved",
    deleted: {
      ...before.rows,
      stockBalances: before.deleteStockBalances,
      stockMovements: before.deleteStockMovements,
    },
    preserved: {
      stockBalances: before.preserveStockBalances,
      stockMovements: before.preserveStockMovements,
    },
  }, null, 2));

  const removed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(2026080601)`;
    const result = {};

    result.approvalAction = (await tx.approvalAction.deleteMany({ where: approvalActionWhere })).count;
    result.approvalRequest = (await tx.approvalRequest.deleteMany({ where: approvalWhere })).count;
    result.notification = (await tx.notification.deleteMany({ where: notificationWhere })).count;

    const usages = await tx.diesUsage.findMany({ where: { isDeleted: false } });
    const shotCountByDies = new Map();
    for (const usage of usages) {
      shotCountByDies.set(
        usage.diesId,
        (shotCountByDies.get(usage.diesId) || 0) + Number(usage.shotCount || 0),
      );
    }

    for (const delegate of DELETE_ALL_DELEGATES) {
      result[delegate] = (await tx[delegate].deleteMany({})).count;
      if (delegate === "diesUsage") {
        for (const [diesId, removedShots] of shotCountByDies) {
          const dies = await tx.dies.findUnique({ where: { id: diesId }, select: { shotCounter: true } });
          if (!dies) continue;
          await tx.dies.update({
            where: { id: diesId },
            data: { shotCounter: Math.max(0, Number(dies.shotCounter || 0) - removedShots) },
          });
        }
      }
    }

    const currentMovements = await tx.stockMovement.findMany({ select: { id: true, lotNumber: true } });
    result.stockMovementWithLot = await deleteIds(
      tx.stockMovement,
      ids(purgeAllStock ? currentMovements : currentMovements.filter((row) => !hasNoLot(row))),
    );

    const currentBalances = await tx.stockBalance.findMany({
      select: { id: true, lotNumber: true, qtyOnHand: true, qtyQC: true },
    });
    const balanceIdsWithLot = ids(purgeAllStock ? currentBalances : currentBalances.filter((row) => !hasNoLot(row)));
    result.stockBalanceWithLot = await deleteIds(tx.stockBalance, balanceIdsWithLot);
    result.lotMaster = (await tx.lotMaster.deleteMany({})).count;

    // Reservations are flow data. Keep physical/QC stock, but clear derived reservation values.
    result.stockBalanceReservationNormalized = (await tx.stockBalance.updateMany({
      data: { qtyReserved: 0 },
    })).count;
    const preservedBalances = await tx.stockBalance.findMany();
    for (const balance of preservedBalances) {
      await tx.stockBalance.update({
        where: { id: balance.id },
        data: { qtyAvailable: Math.max(0, Number(balance.qtyOnHand || 0) - Number(balance.qtyQC || 0)) },
      });
    }

    return result;
  }, { maxWait: 30000, timeout: 180000 });

  const after = await loadScope(prisma);
  assertPreservedStock(before.preserveStockBalances, after.preserveStockBalances);
  const remaining = summarize(after);
  const unexpected = Object.entries(remaining).filter(([name, count]) => (
    !name.endsWith("WithoutLotPreserved") && count !== 0
  ));
  if (unexpected.length) {
    throw new Error(`Reset belum bersih: ${JSON.stringify(Object.fromEntries(unexpected))}`);
  }
  if (after.preserveStockBalances.length !== before.preserveStockBalances.length) {
    throw new Error("Jumlah stock balance tanpa lot berubah.");
  }
  if (after.preserveStockMovements.length !== before.preserveStockMovements.length) {
    throw new Error("Jumlah stock movement tanpa lot berubah.");
  }

  console.log(JSON.stringify({
    status: "COMPLETED",
    backupPath,
    removed,
    after: remaining,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
