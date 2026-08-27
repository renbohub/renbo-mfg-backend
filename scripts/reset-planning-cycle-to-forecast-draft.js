/* eslint-disable no-console */

// Controlled planning reset.
// Keeps Forecast/ForecastDetail and upstream/execution data, reopens every
// active Forecast as Draft, and removes derived planning documents only.

require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const { prisma } = require("../src/prisma");

const execute = process.argv.includes("--execute");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

// Child-first ordering keeps the reset explicit and makes the backup/counts
// useful even where the schema also has ON DELETE CASCADE.
const TARGET_DELEGATES = [
  "dailyPlanningException",
  "dailyProductionSchedule",
  "dailyPlanRevision",
  "purchaseSuggestionSupplierAllocation",
  "purchaseSuggestionItem",
  "purchaseSuggestion",
  "monthlyPlanRecommendationItem",
  "monthlyPlanRecommendationScenario",
  "capacityEditChange",
  "capacityQueueItem",
  "capacityEditSession",
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
  "rccpRecommendation",
  "rccpOverride",
  "rccpOffsetDetail",
  "rccpTimeBucket",
  "rccpLoad",
  "rccpRun",
  "mPSDeliveryFeasibilitySnapshot",
  "mPSDeliveryPlan",
  "mPSDemandSource",
  "mPSDetail",
  "mPS",
];

const PRESERVED_DELEGATES = [
  "forecast",
  "forecastDetail",
  "demandDeliveryTarget",
  "purchaseRequisition",
  "purchaseOrder",
  "manufacturingOrder",
  "workOrder",
  "vendorProcessOrder",
  "productionLog",
  "stockBalance",
  "stockMovement",
];

async function loadRows(db, delegates) {
  const rows = {};
  for (const delegate of delegates) rows[delegate] = await db[delegate].findMany();
  return rows;
}

const countsOf = (rows) => Object.fromEntries(
  Object.entries(rows).map(([delegate, values]) => [delegate, values.length]),
);

function planningDocumentIdentity(targetRows) {
  const ids = [];
  const numbers = [];
  const add = (value, destination) => {
    if (value != null && String(value).trim()) destination.push(String(value));
  };

  for (const row of targetRows.mPS) {
    add(row.id, ids);
    add(row.mpsNumber, numbers);
  }
  for (const row of targetRows.mRPRun) {
    add(row.id, ids);
    add(row.runNumber, numbers);
  }
  for (const row of targetRows.purchaseSuggestion) {
    add(row.id, ids);
    add(row.suggestionNumber, numbers);
  }
  for (const row of targetRows.monthlyProductionPlan) {
    add(row.id, ids);
    add(row.planNumber, numbers);
  }
  for (const row of targetRows.dailyPlanRevision) {
    add(row.id, ids);
    add(row.revisionNumber, numbers);
  }
  for (const row of targetRows.dailyProductionSchedule) {
    add(row.id, ids);
    add(row.scheduleNumber, numbers);
  }

  return {
    ids: [...new Set(ids)],
    numbers: [...new Set(numbers)],
  };
}

function linkedDocumentWhere(identity) {
  const clauses = [];
  if (identity.ids.length) clauses.push({ documentId: { in: identity.ids } });
  if (identity.numbers.length) clauses.push({ documentNumber: { in: identity.numbers } });
  return clauses.length ? { OR: clauses } : { id: { in: [] } };
}

function linkedNotificationWhere(identity) {
  const values = [...identity.ids, ...identity.numbers];
  return values.length ? { entityId: { in: values } } : { id: { in: [] } };
}

async function snapshot(db) {
  const targetRows = await loadRows(db, TARGET_DELEGATES);
  const preservedRows = await loadRows(db, PRESERVED_DELEGATES);
  const forecasts = await db.forecast.findMany({ where: { isDeleted: false } });
  const identity = planningDocumentIdentity(targetRows);
  const approvalRequests = await db.approvalRequest.findMany({
    where: linkedDocumentWhere(identity),
    include: { actions: true },
  });
  const notifications = await db.notification.findMany({
    where: linkedNotificationWhere(identity),
  });

  return {
    targetRows,
    preservedRows,
    forecasts,
    identity,
    approvalRequests,
    notifications,
  };
}

async function main() {
  const before = await snapshot(prisma);
  const beforeTargetCounts = countsOf(before.targetRows);
  const beforePreservedCounts = countsOf(before.preservedRows);
  const forecastStatusBefore = before.forecasts.reduce((summary, row) => {
    summary[row.status] = (summary[row.status] || 0) + 1;
    return summary;
  }, {});

  console.log(JSON.stringify({
    mode: execute ? "EXECUTE" : "DRY_RUN",
    scope: "Forecast => Draft; remove MPS/RCCP, MRP, Purchase Suggestion, Monthly/Daily Production Plan",
    before: beforeTargetCounts,
    forecasts: {
      active: before.forecasts.length,
      status: forecastStatusBefore,
    },
    linkedAudit: {
      approvalRequests: before.approvalRequests.length,
      notifications: before.notifications.length,
    },
    preserved: beforePreservedCounts,
    note: "PR, PO, stock, demand delivery target, MO/WO/VPO, dan production log dipertahankan.",
  }, null, 2));

  if (!execute) {
    console.log("Dry-run selesai. Jalankan dengan --execute untuk menerapkan reset.");
    return;
  }

  const backupDir = path.join(__dirname, "..", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `planning-cycle-reset-${stamp()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    scope: "Planning cycle reset to Forecast Draft",
    forecastsBefore: before.forecasts,
    deleted: {
      ...before.targetRows,
      approvalRequests: before.approvalRequests,
      notifications: before.notifications,
    },
    preservedCounts: beforePreservedCounts,
  }, null, 2), "utf8");

  const removed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(2026082501)`;

    const result = {};
    const approvalIds = before.approvalRequests.map((row) => row.id);
    result.approvalRequest = approvalIds.length
      ? (await tx.approvalRequest.deleteMany({ where: { id: { in: approvalIds } } })).count
      : 0;
    const notificationIds = before.notifications.map((row) => row.id);
    result.notification = notificationIds.length
      ? (await tx.notification.deleteMany({ where: { id: { in: notificationIds } } })).count
      : 0;

    for (const delegate of TARGET_DELEGATES) {
      result[delegate] = (await tx[delegate].deleteMany({})).count;
    }

    result.forecastsReopened = (await tx.forecast.updateMany({
      where: { isDeleted: false },
      data: {
        status: "Draft",
        approvedBy: null,
        approvedDate: null,
      },
    })).count;

    return result;
  }, { maxWait: 30000, timeout: 120000 });

  const afterTargetRows = await loadRows(prisma, TARGET_DELEGATES);
  const remaining = Object.entries(afterTargetRows)
    .filter(([, rows]) => rows.length)
    .map(([delegate, rows]) => `${delegate}=${rows.length}`);
  if (remaining.length) throw new Error(`Planning rows masih tersisa: ${remaining.join(", ")}`);

  const nonDraftForecasts = await prisma.forecast.count({
    where: { isDeleted: false, status: { not: "Draft" } },
  });
  if (nonDraftForecasts) throw new Error(`${nonDraftForecasts} Forecast aktif belum berstatus Draft.`);

  const afterPreservedRows = await loadRows(prisma, PRESERVED_DELEGATES);
  const afterPreservedCounts = countsOf(afterPreservedRows);
  for (const delegate of PRESERVED_DELEGATES) {
    if (afterPreservedCounts[delegate] !== beforePreservedCounts[delegate]) {
      throw new Error(
        `Data yang harus dipertahankan berubah: ${delegate} ${beforePreservedCounts[delegate]} -> ${afterPreservedCounts[delegate]}`,
      );
    }
  }

  console.log(JSON.stringify({
    status: "COMPLETED",
    backupPath,
    removed,
    after: countsOf(afterTargetRows),
    forecasts: {
      active: await prisma.forecast.count({ where: { isDeleted: false } }),
      draft: await prisma.forecast.count({ where: { isDeleted: false, status: "Draft" } }),
    },
    preserved: afterPreservedCounts,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());

