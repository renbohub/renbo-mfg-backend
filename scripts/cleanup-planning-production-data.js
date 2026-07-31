/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { prisma } = require("../src/prisma");

const execute = process.argv.includes("--execute");
const EPSILON = 0.000001;

const unique = (values) => [...new Set(values.filter(Boolean).map(String))];
const sum = (values) => values.reduce((total, value) => total + Number(value || 0), 0);
const nowStamp = () =>
  new Date().toISOString().replace(/[:.]/g, "-");

const productionReferenceTypes = [
  "MANUFACTURING_ORDER",
  "ManufacturingOrder",
  "MO",
  "MPS",
  "WORK_ORDER",
  "WorkOrder",
  "WO",
  "PRODUCTION",
];

const loadTargetData = async (db) => {
  const [
    mps,
    mpsDetails,
    mrpRuns,
    mrpRequirements,
    plannedOrders,
    productionPlans,
    productionPlanDetails,
    capacityMachineOverrides,
    capacityDayOverrides,
    mrpDirtyItems,
    mrpPegging,
    mrpPartialSnapshots,
    manufacturingOrders,
    manufacturingOrderSourceWips,
    vendorProcessOrders,
    workOrders,
    dailyProductionSchedules,
    productionLogs,
    downtimeLogs,
    qualityInspections,
    qualityInspectionDetails,
    materialIssues,
    materialIssueDetails,
    wipEntries,
  ] = await Promise.all([
    db.mPS.findMany(),
    db.mPSDetail.findMany(),
    db.mRPRun.findMany(),
    db.mRPRequirement.findMany(),
    db.plannedOrder.findMany(),
    db.monthlyProductionPlan.findMany(),
    db.monthlyProductionPlanDetail.findMany(),
    db.capacityMachineOverride.findMany(),
    db.capacityDayOverride.findMany(),
    db.mRPDirtyItem.findMany(),
    db.mRPPegging.findMany(),
    db.mRPPartialSnapshot.findMany(),
    db.manufacturingOrder.findMany(),
    db.manufacturingOrderSourceWip.findMany(),
    db.vendorProcessOrder.findMany(),
    db.workOrder.findMany(),
    db.dailyProductionSchedule.findMany(),
    db.productionLog.findMany(),
    db.downtimeLog.findMany(),
    db.qualityInspection.findMany(),
    db.qualityInspectionDetail.findMany(),
    db.materialIssue.findMany(),
    db.materialIssueDetail.findMany(),
    db.wIPEntry.findMany(),
  ]);

  const documentNumbers = unique([
    ...mps.map((row) => row.mpsNumber),
    ...mrpRuns.map((row) => row.runNumber),
    ...plannedOrders.map((row) => row.orderNumber),
    ...productionPlans.map((row) => row.planNumber),
    ...manufacturingOrders.map((row) => row.moNumber),
    ...vendorProcessOrders.map((row) => row.orderNumber),
    ...workOrders.map((row) => row.woNumber),
    ...dailyProductionSchedules.map((row) => row.scheduleNumber),
    ...productionLogs.map((row) => row.logNumber),
    ...downtimeLogs.map((row) => row.downtimeNumber),
    ...qualityInspections.map((row) => row.inspectionNumber),
    ...materialIssues.map((row) => row.issueNumber),
    ...wipEntries.map((row) => row.entryNumber),
  ]);
  const documentIds = unique([
    ...mps.map((row) => row.id),
    ...mrpRuns.map((row) => row.id),
    ...plannedOrders.map((row) => row.id),
    ...productionPlans.map((row) => row.id),
    ...manufacturingOrders.map((row) => row.id),
    ...vendorProcessOrders.map((row) => row.id),
    ...workOrders.map((row) => row.id),
    ...dailyProductionSchedules.map((row) => row.id),
    ...productionLogs.map((row) => row.id),
    ...downtimeLogs.map((row) => row.id),
    ...qualityInspections.map((row) => row.id),
    ...materialIssues.map((row) => row.id),
    ...wipEntries.map((row) => row.id),
  ]);
  const forecastNumbers = unique(mps.map((row) => row.forecastNumber));
  const linkedDiesUsageIds = unique(workOrders.map((row) => row.diesUsageId));

  const diesUsageWhere = {
    OR: [
      ...(linkedDiesUsageIds.length > 0 ? [{ id: { in: linkedDiesUsageIds } }] : []),
      {
        referenceType: { in: productionReferenceTypes },
        ...(documentNumbers.length > 0
          ? { referenceNumber: { in: documentNumbers } }
          : {}),
      },
    ],
  };
  const diesUsages =
    diesUsageWhere.OR.length > 0
      ? await db.diesUsage.findMany({ where: diesUsageWhere })
      : [];

  const referenceFilter =
    documentNumbers.length > 0
      ? {
          OR: [
            { referenceNumber: { in: documentNumbers } },
            {
              referenceType: { in: productionReferenceTypes },
              referenceNumber: { in: documentNumbers },
            },
          ],
        }
      : null;
  const stockReservations = referenceFilter
    ? await db.stockReservation.findMany({ where: referenceFilter })
    : [];

  const approvalWhere =
    documentNumbers.length > 0 || documentIds.length > 0
      ? {
          OR: [
            ...(documentNumbers.length > 0
              ? [{ documentNumber: { in: documentNumbers } }]
              : []),
            ...(documentIds.length > 0
              ? [{ documentId: { in: documentIds } }]
              : []),
          ],
        }
      : null;
  const approvalRequests = approvalWhere
    ? await db.approvalRequest.findMany({
        where: approvalWhere,
        include: { actions: true },
      })
    : [];
  const notifications =
    documentNumbers.length > 0
      ? await db.notification.findMany({
          where: { entityId: { in: documentNumbers } },
        })
      : [];

  return {
    mps,
    mpsDetails,
    mrpRuns,
    mrpRequirements,
    plannedOrders,
    productionPlans,
    productionPlanDetails,
    capacityMachineOverrides,
    capacityDayOverrides,
    mrpDirtyItems,
    mrpPegging,
    mrpPartialSnapshots,
    manufacturingOrders,
    manufacturingOrderSourceWips,
    vendorProcessOrders,
    workOrders,
    dailyProductionSchedules,
    productionLogs,
    downtimeLogs,
    qualityInspections,
    qualityInspectionDetails,
    materialIssues,
    materialIssueDetails,
    wipEntries,
    diesUsages,
    stockReservations,
    approvalRequests,
    notifications,
    documentNumbers,
    documentIds,
    forecastNumbers,
  };
};

const countSnapshot = (snapshot) =>
  Object.fromEntries(
    Object.entries(snapshot)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => [key, value.length]),
  );

const deleteByIds = async (delegate, rows) => {
  const ids = unique(rows.map((row) => row.id));
  return ids.length > 0
    ? delegate.deleteMany({ where: { id: { in: ids } } })
    : { count: 0 };
};

const main = async () => {
  const snapshot = await loadTargetData(prisma);
  const before = countSnapshot(snapshot);

  console.log(
    JSON.stringify(
      {
        mode: execute ? "EXECUTE" : "DRY_RUN",
        before,
        forecastsToReopen: snapshot.forecastNumbers,
        note:
          "Forecast/SO, master data, Purchasing, Stock Movement, dan Stock Balance dipertahankan.",
      },
      null,
      2,
    ),
  );

  if (!execute) {
    console.log("\nDry-run selesai. Jalankan kembali dengan --execute untuk menghapus data.");
    return;
  }

  const backupDir = path.join(__dirname, "..", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(
    backupDir,
    `planning-production-cleanup-${nowStamp()}.json`,
  );
  fs.writeFileSync(
    backupPath,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        scope: "MPS, MRP, Production Plan/Capacity, Production transactions",
        snapshot,
      },
      null,
      2,
    ),
    "utf8",
  );

  const results = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(2026072601)`;

      const removed = {};

      const reservationByBalance = new Map();
      for (const reservation of snapshot.stockReservations) {
        if (!reservation.stockBalanceId) continue;
        const outstanding = Math.max(
          0,
          Number(reservation.qtyReserved || 0) -
            Number(reservation.qtyReleased || 0),
        );
        reservationByBalance.set(
          reservation.stockBalanceId,
          (reservationByBalance.get(reservation.stockBalanceId) || 0) +
            outstanding,
        );
      }
      for (const [stockBalanceId, outstanding] of reservationByBalance) {
        if (outstanding <= EPSILON) continue;
        const balance = await tx.stockBalance.findUnique({
          where: { id: stockBalanceId },
          select: {
            id: true,
            qtyOnHand: true,
            qtyReserved: true,
            qtyQC: true,
          },
        });
        if (!balance) continue;
        const qtyReserved = Math.max(
          0,
          Number(balance.qtyReserved || 0) - outstanding,
        );
        await tx.stockBalance.update({
          where: { id: balance.id },
          data: {
            qtyReserved,
            qtyAvailable: Math.max(
              0,
              Number(balance.qtyOnHand || 0) -
                qtyReserved -
                Number(balance.qtyQC || 0),
            ),
          },
        });
      }
      removed.stockReservations = (
        await deleteByIds(tx.stockReservation, snapshot.stockReservations)
      ).count;
      removed.approvalRequests = (
        await deleteByIds(tx.approvalRequest, snapshot.approvalRequests)
      ).count;
      removed.notifications = (
        await deleteByIds(tx.notification, snapshot.notifications)
      ).count;

      removed.qualityInspectionDetails = (
        await deleteByIds(
          tx.qualityInspectionDetail,
          snapshot.qualityInspectionDetails,
        )
      ).count;
      removed.qualityInspections = (
        await deleteByIds(tx.qualityInspection, snapshot.qualityInspections)
      ).count;
      removed.downtimeLogs = (
        await deleteByIds(tx.downtimeLog, snapshot.downtimeLogs)
      ).count;
      removed.materialIssueDetails = (
        await deleteByIds(tx.materialIssueDetail, snapshot.materialIssueDetails)
      ).count;
      removed.materialIssues = (
        await deleteByIds(tx.materialIssue, snapshot.materialIssues)
      ).count;
      removed.productionLogs = (
        await deleteByIds(tx.productionLog, snapshot.productionLogs)
      ).count;
      removed.dailyProductionSchedules = (
        await deleteByIds(
          tx.dailyProductionSchedule,
          snapshot.dailyProductionSchedules,
        )
      ).count;
      removed.wipEntries = (
        await deleteByIds(tx.wIPEntry, snapshot.wipEntries)
      ).count;
      removed.vendorProcessOrders = (
        await deleteByIds(tx.vendorProcessOrder, snapshot.vendorProcessOrders)
      ).count;
      removed.manufacturingOrderSourceWips = (
        await deleteByIds(
          tx.manufacturingOrderSourceWip,
          snapshot.manufacturingOrderSourceWips,
        )
      ).count;
      removed.workOrders = (
        await deleteByIds(tx.workOrder, snapshot.workOrders)
      ).count;
      removed.manufacturingOrders = (
        await deleteByIds(
          tx.manufacturingOrder,
          snapshot.manufacturingOrders,
        )
      ).count;

      const removedShotsByDies = new Map();
      for (const usage of snapshot.diesUsages) {
        if (usage.isDeleted) continue;
        removedShotsByDies.set(
          usage.diesId,
          (removedShotsByDies.get(usage.diesId) || 0) +
            Number(usage.shotCount || 0),
        );
      }
      removed.diesUsages = (
        await deleteByIds(tx.diesUsage, snapshot.diesUsages)
      ).count;
      for (const [diesId, removedShots] of removedShotsByDies) {
        const dies = await tx.dies.findUnique({
          where: { id: diesId },
          select: { id: true, shotCounter: true },
        });
        if (!dies) continue;
        await tx.dies.update({
          where: { id: dies.id },
          data: {
            shotCounter: Math.max(
              0,
              Number(dies.shotCounter || 0) - removedShots,
            ),
          },
        });
      }

      removed.capacityMachineOverrides = (
        await deleteByIds(
          tx.capacityMachineOverride,
          snapshot.capacityMachineOverrides,
        )
      ).count;
      removed.capacityDayOverrides = (
        await deleteByIds(
          tx.capacityDayOverride,
          snapshot.capacityDayOverrides,
        )
      ).count;
      removed.productionPlanDetails = (
        await deleteByIds(
          tx.monthlyProductionPlanDetail,
          snapshot.productionPlanDetails,
        )
      ).count;
      removed.productionPlans = (
        await deleteByIds(
          tx.monthlyProductionPlan,
          snapshot.productionPlans,
        )
      ).count;

      removed.mrpPegging = (
        await deleteByIds(tx.mRPPegging, snapshot.mrpPegging)
      ).count;
      removed.mrpDirtyItems = (
        await deleteByIds(tx.mRPDirtyItem, snapshot.mrpDirtyItems)
      ).count;
      removed.mrpPartialSnapshots = (
        await deleteByIds(
          tx.mRPPartialSnapshot,
          snapshot.mrpPartialSnapshots,
        )
      ).count;
      removed.plannedOrders = (
        await deleteByIds(tx.plannedOrder, snapshot.plannedOrders)
      ).count;
      removed.mrpRequirements = (
        await deleteByIds(tx.mRPRequirement, snapshot.mrpRequirements)
      ).count;
      removed.mrpRuns = (
        await deleteByIds(tx.mRPRun, snapshot.mrpRuns)
      ).count;
      removed.mpsDetails = (
        await deleteByIds(tx.mPSDetail, snapshot.mpsDetails)
      ).count;
      removed.mps = (await deleteByIds(tx.mPS, snapshot.mps)).count;

      removed.forecastsReopened =
        snapshot.forecastNumbers.length > 0
          ? (
              await tx.forecast.updateMany({
                where: {
                  forecastNumber: { in: snapshot.forecastNumbers },
                  status: "Consumed",
                  isDeleted: false,
                },
                data: { status: "Confirmed" },
              })
            ).count
          : 0;

      return removed;
    },
    { maxWait: 30000, timeout: 120000 },
  );

  const after = countSnapshot(await loadTargetData(prisma));
  console.log(
    JSON.stringify(
      {
        status: "COMPLETED",
        backupPath,
        removed: results,
        after,
      },
      null,
      2,
    ),
  );
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
