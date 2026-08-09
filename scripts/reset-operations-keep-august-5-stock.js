/* eslint-disable no-console */

const fs = require("fs");
const path = require("path");
const { prisma } = require("../src/prisma");

const execute = process.argv.includes("--execute");
const preservedDateLabel = "2026-08-05 Asia/Jakarta";
const preservedStart = new Date("2026-08-05T00:00:00+07:00");
const preservedEnd = new Date("2026-08-06T00:00:00+07:00");

const DELETE_ALL_DELEGATES = [
  "productionLogCarryover",
  "productionLogCoilPhase",
  "incomingInspectionDetail",
  "incomingInspection",
  "purchaseInvoicePayment",
  "purchaseInvoiceDetail",
  "purchaseInvoicePO",
  "purchaseInvoice",
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
  "dailyProductionSchedule",
  "wIPEntry",
  "vendorProcessOrder",
  "manufacturingOrderSourceWip",
  "workOrder",
  "manufacturingOrder",
  "diesUsage",
  "stockReservation",
  "stockOpnameDetail",
  "stockOpnameHeader",
  "productionPlanAllocation",
  "capacityMachineOverride",
  "capacityDayOverride",
  "monthlyProductionPlanDetail",
  "monthlyProductionPlan",
  "planningChangeImpact",
  "mRPPegging",
  "mRPDirtyItem",
  "mRPPartialSnapshot",
  "plannedOrder",
  "mRPRequirement",
  "mRPRun",
  "mPSDemandSource",
  "mPSDeliveryPlan",
  "mPSDetail",
  "mPS",
  "demandDeliveryTarget",
  "deliveryScheduleDetail",
  "deliverySchedule",
  "salesOrderAttachment",
  "salesOrderDetail",
  "salesOrderHeader",
  "quotationDetail",
  "quotationHeader",
  "forecastDetail",
  "forecast",
  "salesActualLedger",
  "materialDemandSnapshot",
  "excelImportRow",
  "excelImportBatch",
];

const PRESERVED_MASTER_DELEGATES = [
  "user",
  "role",
  "rolePermission",
  "approvalRule",
  "approvalRuleStep",
  "systemSetting",
  "masterFormula",
  "numberingRule",
  "uom",
  "currency",
  "customer",
  "supplier",
  "vendor",
  "part",
  "material",
  "machine",
  "dies",
  "process",
  "warehouse",
  "rack",
  "eBOMHeader",
  "mBOMHeader",
  "mBOMDetail",
  "mBOMProcess",
  "capacityCalendarOverride",
];

const STOCK_IDENTITY_FIELDS = [
  "warehouseCode",
  "rackCode",
  "lotNumber",
  "materialId",
  "materialCode",
  "partCode",
  "partNumber",
  "productId",
  "description",
  "spec",
  "thickness",
  "width",
  "CSP",
  "uomCode",
  "stockType",
];

const STOCK_SNAPSHOT_FIELDS = [
  "partName",
  "materialName",
  "materialType",
];

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const movementWhere = { movementDate: { gte: preservedStart, lt: preservedEnd } };

function movementDelta(row) {
  if (row.deltaQty != null && Number.isFinite(Number(row.deltaQty))) return Number(row.deltaQty);
  return String(row.direction || row.movementType).toUpperCase() === "OUT"
    ? -Math.abs(Number(row.qty || 0))
    : Math.abs(Number(row.qty || 0));
}

function stockIdentityKey(row) {
  return STOCK_IDENTITY_FIELDS.map((field) => row[field] ?? "").join("|");
}

function buildOpeningBalances(movements) {
  const grouped = new Map();
  for (const movement of movements) {
    const key = stockIdentityKey(movement);
    const current = grouped.get(key) || {
      ...Object.fromEntries(STOCK_IDENTITY_FIELDS.map((field) => [field, movement[field] ?? null])),
      ...Object.fromEntries(STOCK_SNAPSHOT_FIELDS.map((field) => [field, movement[field] ?? null])),
      qtyOnHand: 0,
      lastMovement: movement.movementDate,
    };
    current.qtyOnHand += movementDelta(movement);
    if (movement.movementDate > current.lastMovement) current.lastMovement = movement.movementDate;
    for (const field of STOCK_SNAPSHOT_FIELDS) {
      if (!current[field] && movement[field]) current[field] = movement[field];
    }
    grouped.set(key, current);
  }

  return [...grouped.values()].map((row) => {
    const qtyOnHand = Math.abs(row.qtyOnHand) < 1e-9 ? 0 : row.qtyOnHand;
    if (qtyOnHand < 0) {
      throw new Error(`Net stock opening negatif untuk ${stockIdentityKey(row)}: ${qtyOnHand}`);
    }
    return {
      ...row,
      qtyOnHand,
      qtyReserved: 0,
      qtyQC: 0,
      qtyAvailable: qtyOnHand,
      isDeleted: false,
    };
  }).filter((row) => row.qtyOnHand > 0);
}

async function countDelegates(db, delegates) {
  const counts = {};
  for (const delegate of delegates) counts[delegate] = await db[delegate].count();
  return counts;
}

async function loadScope(db) {
  const rows = {};
  for (const delegate of DELETE_ALL_DELEGATES) rows[delegate] = await db[delegate].findMany();
  rows.approvalAction = await db.approvalAction.findMany();
  rows.approvalRequest = await db.approvalRequest.findMany();
  rows.notification = await db.notification.findMany();
  rows.lotMaster = await db.lotMaster.findMany();

  const stockMovements = await db.stockMovement.findMany({ orderBy: { movementNumber: "asc" } });
  const preservedMovements = stockMovements.filter((row) => (
    row.movementDate >= preservedStart && row.movementDate < preservedEnd
  ));
  return {
    rows,
    stockBalances: await db.stockBalance.findMany(),
    stockMovements,
    preservedMovements,
    openingBalances: buildOpeningBalances(preservedMovements),
    masterCounts: await countDelegates(db, PRESERVED_MASTER_DELEGATES),
  };
}

function summarize(scope) {
  return {
    ...Object.fromEntries(Object.entries(scope.rows).map(([delegate, rows]) => [delegate, rows.length])),
    stockBalance: scope.stockBalances.length,
    stockMovement: scope.stockMovements.length,
    preservedStockMovement: scope.preservedMovements.length,
    rebuiltOpeningBalance: scope.openingBalances.length,
  };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, actual ${actual}`);
}

async function verifyResult(before) {
  const afterCounts = await countDelegates(prisma, DELETE_ALL_DELEGATES);
  const remaining = Object.entries(afterCounts).filter(([, count]) => count !== 0);
  if (remaining.length) {
    throw new Error(`Data transaksi masih tersisa: ${JSON.stringify(Object.fromEntries(remaining))}`);
  }

  assertEqual(await prisma.approvalAction.count(), 0, "Approval action");
  assertEqual(await prisma.approvalRequest.count(), 0, "Approval request");
  assertEqual(await prisma.notification.count(), 0, "Notification");
  assertEqual(await prisma.lotMaster.count(), 0, "Lot master transaksi");

  const movements = await prisma.stockMovement.findMany({ orderBy: { movementNumber: "asc" } });
  assertEqual(movements.length, before.preservedMovements.length, "Stock movement yang dipertahankan");
  const expectedMovementIds = before.preservedMovements.map((row) => row.id).sort().join("|");
  const actualMovementIds = movements.map((row) => row.id).sort().join("|");
  assertEqual(actualMovementIds, expectedMovementIds, "Identitas stock movement");
  if (movements.some((row) => row.movementDate < preservedStart || row.movementDate >= preservedEnd)) {
    throw new Error("Stock movement di luar tanggal 5 Agustus masih tersisa.");
  }

  const balances = await prisma.stockBalance.findMany();
  assertEqual(balances.length, before.openingBalances.length, "Saldo opening hasil rebuild");
  const actualByKey = new Map(balances.map((row) => [stockIdentityKey(row), Number(row.qtyOnHand)]));
  for (const expected of before.openingBalances) {
    const actualQty = actualByKey.get(stockIdentityKey(expected));
    if (actualQty == null || Math.abs(actualQty - expected.qtyOnHand) > 1e-8) {
      throw new Error(`Saldo opening tidak sesuai untuk ${stockIdentityKey(expected)}.`);
    }
  }

  const masterCounts = await countDelegates(prisma, PRESERVED_MASTER_DELEGATES);
  for (const delegate of PRESERVED_MASTER_DELEGATES) {
    assertEqual(masterCounts[delegate], before.masterCounts[delegate], `Master/preset ${delegate}`);
  }

  const receiveMovements = await prisma.stockMovement.count({
    where: {
      OR: [
        { transactionType: { in: ["PURCHASE_RECEIVE", "QUALITY_RELEASE", "QC_HOLD"] } },
        { referenceType: { in: ["GR", "GOODS_RECEIPT", "INCOMING_INSPECTION"] } },
      ],
    },
  });
  assertEqual(receiveMovements, 0, "Movement receive/incoming");

  return {
    transactionCounts: afterCounts,
    stockMovement: movements.length,
    stockBalance: balances.length,
    receiveMovement: receiveMovements,
    masterCounts,
  };
}

async function main() {
  const before = await loadScope(prisma);
  console.log(JSON.stringify({
    mode: execute ? "EXECUTE" : "DRY_RUN",
    scope: "All operational data from Forecast through Delivery and Stock",
    preservedStockMovementDate: preservedDateLabel,
    before: summarize(before),
    preservedMovementNumbers: before.preservedMovements.map((row) => row.movementNumber),
    masterAndPresetCounts: before.masterCounts,
  }, null, 2));

  if (!execute) {
    console.log("Dry-run selesai. Gunakan --execute untuk menjalankan reset.");
    return;
  }

  if (!before.preservedMovements.length) {
    throw new Error(`Tidak ada Stock Movement pada ${preservedDateLabel}; reset dibatalkan.`);
  }

  const backupDir = path.join(__dirname, "..", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `operations-reset-keep-august-5-${stamp()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    preservedStockMovementDate: preservedDateLabel,
    deleted: {
      ...before.rows,
      stockBalances: before.stockBalances,
      stockMovements: before.stockMovements.filter((row) => (
        row.movementDate < preservedStart || row.movementDate >= preservedEnd
      )),
    },
    preserved: {
      stockMovements: before.preservedMovements,
      masterAndPresetCounts: before.masterCounts,
    },
    rebuiltOpeningBalances: before.openingBalances,
  }, null, 2));

  const removed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(2026080702)`;
    const result = {};

    result.approvalAction = (await tx.approvalAction.deleteMany()).count;
    result.approvalRequest = (await tx.approvalRequest.deleteMany()).count;
    result.notification = (await tx.notification.deleteMany()).count;

    const usages = await tx.diesUsage.findMany({ where: { isDeleted: false } });
    const removedShotsByDies = new Map();
    for (const usage of usages) {
      removedShotsByDies.set(
        usage.diesId,
        (removedShotsByDies.get(usage.diesId) || 0) + Number(usage.shotCount || 0),
      );
    }

    for (const delegate of DELETE_ALL_DELEGATES) {
      result[delegate] = (await tx[delegate].deleteMany()).count;
      if (delegate === "diesUsage") {
        for (const [diesId, removedShots] of removedShotsByDies) {
          const dies = await tx.dies.findUnique({ where: { id: diesId }, select: { shotCounter: true } });
          if (!dies) continue;
          await tx.dies.update({
            where: { id: diesId },
            data: { shotCounter: Math.max(0, Number(dies.shotCounter || 0) - removedShots) },
          });
        }
      }
    }

    result.stockMovementOutsideAugust5 = (await tx.stockMovement.deleteMany({
      where: {
        OR: [
          { movementDate: { lt: preservedStart } },
          { movementDate: { gte: preservedEnd } },
        ],
      },
    })).count;
    result.stockBalance = (await tx.stockBalance.deleteMany()).count;
    result.lotMaster = (await tx.lotMaster.deleteMany()).count;

    for (const balance of before.openingBalances) {
      await tx.stockBalance.create({ data: balance });
    }
    result.stockBalanceRebuilt = before.openingBalances.length;
    return result;
  }, { maxWait: 30000, timeout: 180000 });

  const after = await verifyResult(before);
  console.log(JSON.stringify({
    status: "COMPLETED",
    backupPath,
    removed,
    after,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
