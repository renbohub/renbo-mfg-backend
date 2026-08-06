/* eslint-disable no-console */
require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");

const FORECAST_NUMBER = "FCT-2026-001";
const FG_PART_CODE = "C002-C004-000";

const sum = (rows, field) => rows.reduce((total, row) => total + Number(row[field] || 0), 0);
const day = (value) => value ? new Date(value).toISOString().slice(0, 10) : null;

async function planningMonth(mpsNumber) {
  const mps = await prisma.mPS.findUnique({
    where: { mpsNumber },
    include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } },
  });
  const mrp = await prisma.mRPRun.findFirst({
    where: { mpsNumber, isDeleted: false, status: "Completed" },
    orderBy: { createdAt: "desc" },
  });
  const rootRequirements = mrp
    ? await prisma.mRPRequirement.findMany({
        where: { runNumber: mrp.runNumber, partCode: FG_PART_CODE, levelMBOM: 0, isDeleted: false },
        orderBy: { requiredDate: "asc" },
      })
    : [];
  const plannedOrderCount = mrp
    ? await prisma.plannedOrder.count({ where: { runNumber: mrp.runNumber, isDeleted: false } })
    : 0;
  const plan = await prisma.monthlyProductionPlan.findFirst({
    where: { sourceType: `MPS:${mpsNumber}`, isDeleted: false },
    include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
  const rootMps = mps?.details.find((row) => row.partCode === FG_PART_CODE && !String(row.notes || "").includes("[MRP-PRODUCTION]"));
  const rootPlan = plan?.details.find((row) => row.partCode === FG_PART_CODE && !String(row.notes || "").includes("[MRP-PRODUCTION]"));
  return {
    mps: mps && {
      number: mps.mpsNumber,
      status: mps.status,
      forecastQty: Number(rootMps?.forecastQty || 0),
      salesOrderQty: Number(rootMps?.actualSalesOrderQty || 0),
      plannedQty: Number(rootMps?.qtyPlanned || 0),
      requiredDate: day(rootMps?.endDate),
    },
    mrp: mrp && {
      number: mrp.runNumber,
      status: mrp.status,
      grossRequirement: sum(rootRequirements, "grossRequirement"),
      onHandSnapshotQty: Math.max(0, ...rootRequirements.map((row) => Number(row.onHandQty || 0))),
      stockCoverageQty: rootRequirements.reduce((total, row) => total + Math.max(Number(row.grossRequirement || 0) - Number(row.netRequirement || 0), 0), 0),
      netRequirement: sum(rootRequirements, "netRequirement"),
      plannedOrderQty: sum(rootRequirements, "plannedOrderQty"),
      plannedOrderCount,
      dueDates: rootRequirements.map((row) => ({
        date: day(row.requiredDate),
        gross: Number(row.grossRequirement || 0),
        onHandSnapshot: Number(row.onHandQty || 0),
        stockApplied: Math.max(Number(row.grossRequirement || 0) - Number(row.netRequirement || 0), 0),
        net: Number(row.netRequirement || 0),
      })),
    },
    productionPlan: plan && {
      number: plan.planNumber,
      status: plan.status,
      qtyPlanned: Number(rootPlan?.qtyPlanned || 0),
      qtyReleased: Number(rootPlan?.qtyReleased || 0),
      notes: plan.notes,
    },
  };
}

async function main() {
  const forecast = await prisma.forecast.findUnique({
    where: { forecastNumber: FORECAST_NUMBER },
    include: {
      details: {
        where: { isDeleted: false },
        include: { deliveryTargets: { where: { isDeleted: false }, orderBy: { targetDate: "asc" } } },
        orderBy: { lineNumber: "asc" },
      },
    },
  });
  const augustMo = await prisma.manufacturingOrder.findFirst({
    where: { monthlyProductionPlanNumber: "MPP-202608-001", isDeleted: false, status: { not: "Cancelled" } },
  });
  const [august, september, workOrders, dailyPlans, logs, productionQcs, vendorOrders, fgBalances, fgReceipts, suggestions, requisitions, purchaseOrders, goodsReceipts, incomingQcs, activeSalesOrders, deliveries] = await Promise.all([
    planningMonth("MPS-202608"),
    planningMonth("MPS-202609"),
    prisma.workOrder.findMany({ where: { moId: augustMo?.id, isDeleted: false } }),
    prisma.dailyProductionSchedule.findMany({ where: { moId: augustMo?.id, isDeleted: false } }),
    prisma.productionLog.findMany({ where: { moId: augustMo?.id, isDeleted: false } }),
    prisma.qualityInspection.findMany({ where: { moId: augustMo?.id, isDeleted: false } }),
    prisma.vendorProcessOrder.findMany({ where: { moId: augustMo?.id, isDeleted: false } }),
    prisma.stockBalance.findMany({ where: { partCode: FG_PART_CODE, stockType: "Finished Goods", isDeleted: false } }),
    prisma.stockMovement.findMany({ where: { partCode: FG_PART_CODE, stockType: "Finished Goods", transactionType: "PRODUCTION", direction: "IN", isDeleted: false } }),
    prisma.purchaseSuggestion.findMany({ where: { isDeleted: false }, orderBy: { createdAt: "asc" } }),
    prisma.purchaseRequisition.findMany({ where: { isDeleted: false }, orderBy: { createdAt: "asc" } }),
    prisma.purchaseOrder.findMany({ where: { isDeleted: false }, orderBy: { createdAt: "asc" } }),
    prisma.goodsReceipt.findMany({ where: { isDeleted: false }, orderBy: { createdAt: "asc" } }),
    prisma.incomingInspection.findMany({ where: { isDeleted: false }, orderBy: { createdAt: "asc" } }),
    prisma.salesOrderHeader.findMany({ where: { isDeleted: false, status: { notIn: ["Cancelled", "Closed"] } } }),
    prisma.deliverySchedule.findMany({ where: { isDeleted: false } }),
  ]);

  const forecastRows = forecast.details.flatMap((detail) => [
    ...(Number(detail.M1Qty || 0) > 0 ? [{ period: day(detail.M1Forecast), qty: detail.M1Qty }] : []),
    ...(Number(detail.M2Qty || 0) > 0 ? [{ period: day(detail.M2Forecast), qty: detail.M2Qty }] : []),
    ...(Number(detail.M3Qty || 0) > 0 ? [{ period: day(detail.M3Forecast), qty: detail.M3Qty }] : []),
  ].map((bucket) => ({
    partCode: detail.partCode,
    uomCode: detail.uomCode,
    ...bucket,
    dueDates: detail.deliveryTargets
      .filter((target) => day(target.targetDate)?.slice(0, 7) === bucket.period?.slice(0, 7))
      .map((target) => ({ date: day(target.targetDate), qty: target.qty })),
  })));

  console.log(`RESULT=${JSON.stringify({
    forecast: {
      number: forecast.forecastNumber,
      status: forecast.status,
      customerCode: forecast.customerCode,
      rows: forecastRows,
    },
    august: {
      ...august,
      purchasing: {
        suggestions: suggestions.map((row) => ({ number: row.suggestionNumber, status: row.status })),
        requisitions: requisitions.map((row) => ({ number: row.prNumber, status: row.status })),
        purchaseOrders: purchaseOrders.map((row) => ({ number: row.poNumber, status: row.status })),
        goodsReceipts: goodsReceipts.map((row) => ({ number: row.grNumber, status: row.status })),
        incomingQc: incomingQcs.map((row) => ({ number: row.inspectionNumber, status: row.status, decision: row.decision })),
      },
      production: {
        manufacturingOrder: augustMo && { number: augustMo.moNumber, status: augustMo.status, plannedQty: augustMo.qtyPlanned, goodQty: augustMo.qtyGood },
        workOrders: { total: workOrders.length, completed: workOrders.filter((row) => row.status === "Completed").length },
        dailyPlans: { total: dailyPlans.length, completed: dailyPlans.filter((row) => row.status === "Completed").length, inHouse: dailyPlans.filter((row) => row.shift !== "VENDOR").length, vendor: dailyPlans.filter((row) => row.shift === "VENDOR").length },
        productionLogs: { total: logs.length, approved: logs.filter((row) => row.status === "Approved").length, withoutDailyPlan: logs.filter((row) => !row.dpsId).length },
        vendorOrders: { total: vendorOrders.length, completed: vendorOrders.filter((row) => row.status === "Completed").length, plannedQty: sum(vendorOrders, "qtyPlanned"), acceptedQty: sum(vendorOrders, "qtyAccepted") },
        qualityInspections: { total: productionQcs.length, completed: productionQcs.filter((row) => row.status === "Completed").length },
        fgReceipts: { total: fgReceipts.length, qty: sum(fgReceipts, "qty") },
      },
    },
    september,
    stock: { partCode: FG_PART_CODE, uomCode: "pcs", onHandQty: sum(fgBalances, "qtyOnHand"), availableQty: sum(fgBalances, "qtyAvailable") },
    delivery: {
      activeSalesOrders: activeSalesOrders.length,
      deliverySchedules: deliveries.length,
      status: activeSalesOrders.length ? "READY_FOR_SO_DELIVERY_FLOW" : "BLOCKED_NO_SALES_ORDER",
    },
  })}`);
}

main().catch((error) => {
  console.error(`FAIL=${error.stack || error.message}`);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
