require("dotenv").config({ quiet: true });
process.env.NODE_ENV = "production";

const { prisma } = require("../src/prisma");
const moController = require("../src/prisma/controllers/production/ManufacturingOrderController");
const mppController = require("../src/prisma/controllers/planning/MonthlyProductionPlanController");
const vendorController = require("../src/prisma/controllers/production/VendorProcessOrderController");
const dppController = require("../src/prisma/controllers/production/DailyProductionScheduleController");
const materialIssueController = require("../src/prisma/controllers/production/MaterialIssueController");
const productionLogController = require("../src/prisma/controllers/production/ProductionLogController");
const qualityController = require("../src/prisma/controllers/production/QualityInspectionController");
const { syncManufacturingOrderQtyFromWorkOrders } = require("../src/prisma/controllers/production/services/productionWorkflowService");

const ACTOR = "codex-e2e-20260806";
const PLAN_NUMBER = "MPP-202608-001";

function invoke(handler, request = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      params: {}, query: {}, body: {},
      user: { username: ACTOR, email: `${ACTOR}@local` },
      ...request,
    };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body }); return this; },
    };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}

async function expectOk(label, promise) {
  const result = await promise;
  if (result.statusCode >= 300) throw new Error(`${label}: ${result.body?.message || `HTTP ${result.statusCode}`} ${result.body?.code || ""}`.trim());
  return result.body;
}

async function prepare() {
  const plan = await prisma.monthlyProductionPlan.findUnique({
    where: { planNumber: PLAN_NUMBER },
    include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } },
  });
  if (!plan || plan.isDeleted) throw new Error(`${PLAN_NUMBER} tidak ditemukan.`);
  const masterUoms = await prisma.uom.findMany({ where: { isDeleted: false }, select: { uomCode: true } });
  const canonicalUomByLower = new Map(masterUoms.map((row) => [String(row.uomCode).trim().toLowerCase(), row.uomCode]));
  const legacyAllocationUoms = await prisma.productionPlanAllocation.findMany({
    where: { planId: plan.id, isDeleted: false },
    select: { id: true, uomCode: true },
  });
  for (const allocation of legacyAllocationUoms) {
    const canonical = canonicalUomByLower.get(String(allocation.uomCode || "").trim().toLowerCase());
    if (canonical && canonical !== allocation.uomCode) {
      await prisma.productionPlanAllocation.update({ where: { id: allocation.id }, data: { uomCode: canonical } });
    }
  }
  const root = plan.details.find((row) => Number(row.lineNumber) === 1);
  if (!root) throw new Error(`${PLAN_NUMBER} tidak memiliki FG root line.`);

  let mo = await prisma.manufacturingOrder.findFirst({
    where: { monthlyProductionPlanNumber: PLAN_NUMBER, monthlyProductionPlanLineNumber: root.lineNumber, isDeleted: false, status: { not: "Cancelled" } },
  });
  if (!mo) {
    const created = await expectOk("create MO from MPP", invoke(moController.bulkCreate, {
      body: {
        items: [{
          referenceType: "MonthlyProductionPlan",
          monthlyProductionPlanNumber: PLAN_NUMBER,
          monthlyProductionPlanLineNumber: root.lineNumber,
          partId: root.partId,
          qtyPlanned: root.qtyPlanned,
          uomCode: root.uomCode,
          status: "Planned",
          plannedStartDate: plan.periodStart,
          plannedEndDate: plan.periodEnd,
          notes: `Generated from ${PLAN_NUMBER}; all execution logs must originate from published DPP`,
        }],
      },
    }));
    mo = await prisma.manufacturingOrder.findUnique({ where: { id: created.items[0].id } });
  }

  const existingDppCount = await prisma.dailyProductionSchedule.count({ where: { moId: mo.id, isDeleted: false, status: { not: "Cancelled" } } });
  let publish = null;
  if (!existingDppCount) {
    publish = await expectOk("publish DPP from MPP", invoke(mppController.convertToDailyPlans, {
      params: { planNumber: PLAN_NUMBER },
      body: { allowPartial: true },
    }));
  }

  const vendorDailyPlans = await prisma.dailyProductionSchedule.findMany({
    where: { moId: mo.id, isDeleted: false, shift: "VENDOR" },
    select: { mbomProcessId: true, productionPlanAllocationId: true },
  });
  for (const dailyPlan of await prisma.dailyProductionSchedule.findMany({
    where: { moId: mo.id, isDeleted: false, shift: { in: ["1", "2", "3"] } },
    select: { id: true, shift: true },
  })) {
    await prisma.dailyProductionSchedule.update({
      where: { id: dailyPlan.id },
      data: { shift: ({ "1": "1A", "2": "2A", "3": "3A" })[dailyPlan.shift] },
    });
  }
  const capacityVendorProcessIds = [...new Set(vendorDailyPlans.map((row) => row.mbomProcessId).filter(Boolean))];
  if (capacityVendorProcessIds.length) {
    // A legacy generic VPO could have been generated before the phase DPP was
    // published. It has no execution and must be superseded by one VPO per DPP
    // allocation to preserve daily traceability.
    await prisma.vendorProcessOrder.updateMany({
      where: {
        moId: mo.id,
        isDeleted: false,
        mbomProcessId: { in: capacityVendorProcessIds },
        notes: { not: { contains: "[CAPACITY-VENDOR:" } },
        qtySent: 0,
        qtyReceived: 0,
        qtyAccepted: 0,
        status: { in: ["Planned", "Ready to Send"] },
      },
      data: { isDeleted: true },
    });
  }
  await expectOk("generate vendor process from MPP capacity", invoke(vendorController.generateFromMo, { params: { moNumber: mo.moNumber } }));
  let vendorOrders = await prisma.vendorProcessOrder.findMany({ where: { moId: mo.id, isDeleted: false } });
  for (const vendorOrder of vendorOrders.filter((row) => allocationIdFromVendorNotes(row.notes))) {
    if (Number(vendorOrder.qtySent || 0) > 0) continue;
    const allocation = await prisma.productionPlanAllocation.findUnique({
      where: { id: allocationIdFromVendorNotes(vendorOrder.notes) },
      select: { predecessorAllocationIds: true },
    });
    const predecessorIds = Array.isArray(allocation?.predecessorAllocationIds) ? allocation.predecessorAllocationIds : [];
    const predecessorPlan = predecessorIds.length
      ? await prisma.dailyProductionSchedule.findFirst({
          where: { moId: mo.id, productionPlanAllocationId: { in: predecessorIds }, isDeleted: false, woId: { not: null } },
          select: { woId: true },
        })
      : null;
    const predecessorWo = predecessorPlan?.woId
      ? await prisma.workOrder.findUnique({ where: { id: predecessorPlan.woId } })
      : null;
    if (predecessorWo?.outputPartCode && predecessorWo.outputPartCode !== vendorOrder.inputPartCode) {
      await prisma.vendorProcessOrder.update({
        where: { id: vendorOrder.id },
        data: {
          inputPartId: predecessorWo.outputPartId,
          inputPartCode: predecessorWo.outputPartCode,
          inputPartNumber: predecessorWo.outputPartNumber,
          inputPartName: predecessorWo.outputPartName,
        },
      });
    }
  }
  vendorOrders = await prisma.vendorProcessOrder.findMany({ where: { moId: mo.id, isDeleted: false } });

  mo = await prisma.manufacturingOrder.findUnique({ where: { id: mo.id } });
  if (["Draft", "Planned"].includes(mo.status)) {
    await expectOk("release MO", invoke(moController.release, {
      params: { moNumber: mo.moNumber },
      body: { allowShortage: true, skipReservation: true, requirementUomMode: "BY_ITEM_TYPE" },
    }));
  }

  const [finalMo, workOrders, schedules, allocations] = await Promise.all([
    prisma.manufacturingOrder.findUnique({ where: { id: mo.id } }),
    prisma.workOrder.findMany({ where: { moId: mo.id, isDeleted: false }, orderBy: [{ sequence: "asc" }, { plannedDate: "asc" }, { woNumber: "asc" }] }),
    prisma.dailyProductionSchedule.findMany({ where: { moId: mo.id, isDeleted: false }, orderBy: [{ scheduleDate: "asc" }, { sequence: "asc" }, { scheduleNumber: "asc" }] }),
    prisma.productionPlanAllocation.findMany({ where: { planId: plan.id, isDeleted: false }, orderBy: [{ scheduleDate: "asc" }, { lineNumber: "asc" }] }),
  ]);
  return {
    mo: { moNumber: finalMo.moNumber, status: finalMo.status, qtyPlanned: finalMo.qtyPlanned, uomCode: finalMo.uomCode },
    publish: publish?.summary || null,
    workOrderCount: workOrders.length,
    dailyPlanCount: schedules.length,
    vendorPlanCount: schedules.filter((row) => String(row.shift).toUpperCase() === "VENDOR").length,
    vendorOrderCount: vendorOrders.length,
    allocationCount: allocations.length,
    traceMissingCount: schedules.filter((row) => !row.productionPlanId || !row.productionPlanAllocationId || !row.mbomProcessId || (String(row.shift).toUpperCase() !== "VENDOR" && (!row.woId || !row.moId))).length,
    qtyByMode: schedules.reduce((summary, row) => {
      const mode = String(row.shift).toUpperCase() === "VENDOR" ? "VENDOR" : "INHOUSE";
      summary[mode] = (summary[mode] || 0) + Number(row.plannedQty || 0);
      return summary;
    }, {}),
  };
}

function allocationIdFromVendorNotes(notes) {
  return String(notes || "").match(/\[CAPACITY-VENDOR:([^\]]+)\]/)?.[1] || null;
}

function orderSchedulesByGraph(schedules) {
  const byAllocation = new Map(schedules.map((row) => [row.productionPlanAllocationId, row]));
  const memo = new Map();
  const depth = (row, visiting = new Set()) => {
    const allocationId = row.productionPlanAllocationId;
    if (memo.has(allocationId)) return memo.get(allocationId);
    if (visiting.has(allocationId)) return 0;
    const predecessors = Array.isArray(row.productionPlanAllocation?.predecessorAllocationIds)
      ? row.productionPlanAllocation.predecessorAllocationIds.map((id) => byAllocation.get(id)).filter(Boolean)
      : [];
    const value = predecessors.length
      ? Math.max(...predecessors.map((candidate) => depth(candidate, new Set(visiting).add(allocationId)))) + 1
      : 0;
    memo.set(allocationId, value);
    return value;
  };
  return [...schedules].sort((left, right) =>
    depth(left) - depth(right)
    || new Date(left.scheduleDate) - new Date(right.scheduleDate)
    || Number(left.sequence || 0) - Number(right.sequence || 0)
    || left.scheduleNumber.localeCompare(right.scheduleNumber));
}

async function completeQualityInspection(source, scheduleNumber, qty, inspectionDate) {
  let qc = await prisma.qualityInspection.findFirst({
    where: {
      isDeleted: false,
      ...(source.productionLogId ? { productionLogId: source.productionLogId } : { vendorProcessOrderId: source.vendorProcessOrderId }),
    },
    orderBy: { createdAt: "desc" },
  });
  if (!qc) {
    qc = await expectOk(`create QC ${scheduleNumber}`, invoke(qualityController.create, {
      body: {
        ...source,
        inspectionDate,
        sampleSize: Math.max(1, Math.min(Math.round(qty), 5)),
        qtyInspected: qty,
        qtyPassed: qty,
        qtyFailed: 0,
        inspectedBy: ACTOR,
        batchNumber: `BATCH-${scheduleNumber}`,
        notes: `Full-pass E2E inspection sourced from ${scheduleNumber}`,
      },
    }));
  }
  if (qc.status !== "Completed") {
    qc = await expectOk(`complete QC ${scheduleNumber}`, invoke(qualityController.complete, {
      params: { inspectionNumber: qc.inspectionNumber },
      body: {
        approvedBy: ACTOR,
        decision: "Accepted",
        passedDestination: {
          warehouseCode: "WH-001",
          rackCode: "RACK-001",
          lotNumber: `AUG26-${scheduleNumber}`,
        },
      },
    }));
  }
  return qc;
}

async function executeInhouseSchedule(schedule) {
  let current = await prisma.dailyProductionSchedule.findUnique({ where: { id: schedule.id } });
  let issue = await prisma.materialIssue.findFirst({
    where: { isDeleted: false, notes: { contains: `[DPS-CONSUME:${current.scheduleNumber}]` } },
    include: { details: { where: { isDeleted: false } } },
  });
  if (["Draft", "Released"].includes(current.status) && !issue) {
    const consumed = await expectOk(`consume ${current.scheduleNumber}`, invoke(dppController.consume, {
      params: { scheduleNumber: current.scheduleNumber },
    }));
    issue = consumed.materialIssue;
  }
  if (issue?.status === "Draft") {
    issue = await expectOk(`issue material ${current.scheduleNumber}`, invoke(materialIssueController.issue, {
      params: { issueNumber: issue.issueNumber },
    }));
  }

  current = await prisma.dailyProductionSchedule.findUnique({ where: { id: current.id } });
  if (current.status === "Released") {
    await expectOk(`start ${current.scheduleNumber}`, invoke(dppController.start, {
      params: { scheduleNumber: current.scheduleNumber },
    }));
  }

  let log = await prisma.productionLog.findFirst({
    where: { dpsId: current.id, isDeleted: false },
    orderBy: { createdAt: "desc" },
  });
  const scheduleDate = new Date(current.scheduleDate);
  const startTime = new Date(scheduleDate); startTime.setUTCHours(8, 0, 0, 0);
  const endTime = new Date(scheduleDate); endTime.setUTCHours(9, 0, 0, 0);
  if (!log) {
    log = await expectOk(`create Production Log ${current.scheduleNumber}`, invoke(productionLogController.create, {
      body: {
        scheduleNumber: current.scheduleNumber,
        operatorName: ACTOR,
        logDate: scheduleDate,
        startTime,
        endTime,
        qtyProduced: current.plannedQty,
        qtyGood: current.plannedQty,
        qtyReject: 0,
        notes: `Generated exclusively from Daily Production Plan ${current.scheduleNumber}`,
      },
    }));
  }
  if (log.status === "Open") {
    log = await expectOk(`submit Production Log ${current.scheduleNumber}`, invoke(productionLogController.submit, {
      params: { logNumber: log.logNumber },
    }));
  }
  if (log.status === "Submitted") {
    log = await expectOk(`approve Production Log ${current.scheduleNumber}`, invoke(productionLogController.approve, {
      params: { logNumber: log.logNumber },
      body: {
        goodDestination: {
          warehouseCode: "WH-001",
          rackCode: "RACK-001",
          lotNumber: `AUG26-${current.scheduleNumber}`,
        },
      },
    }));
  }
  const qc = await completeQualityInspection(
    { productionLogId: log.id },
    current.scheduleNumber,
    Number(current.plannedQty),
    scheduleDate,
  );
  return { scheduleNumber: current.scheduleNumber, mode: "INHOUSE", logNumber: log.logNumber, inspectionNumber: qc.inspectionNumber };
}

async function executeVendorSchedule(schedule, vendorOrders) {
  const order = vendorOrders.find((row) => allocationIdFromVendorNotes(row.notes) === schedule.productionPlanAllocationId);
  if (!order) throw new Error(`Vendor Process Order untuk ${schedule.scheduleNumber} / allocation ${schedule.productionPlanAllocationId} tidak ditemukan.`);
  let current = await prisma.vendorProcessOrder.findUnique({ where: { id: order.id } });
  if (["Planned", "Ready to Send", "Partial Sent"].includes(current.status)) {
    const remaining = Math.max(Number(current.qtyPlanned || 0) - Number(current.qtySent || 0), 0);
    if (remaining > 0) {
      await expectOk(`send vendor ${schedule.scheduleNumber}`, invoke(vendorController.send, {
        params: { orderNumber: current.orderNumber },
        body: { qtySent: remaining, sourceType: "PREVIOUS_WIP" },
      }));
    }
  }
  current = await prisma.vendorProcessOrder.findUnique({ where: { id: current.id } });
  if (["Sent", "Partial Sent", "Partial Received"].includes(current.status)) {
    const remaining = Math.max(Number(current.qtySent || 0) - Number(current.qtyReceived || 0), 0);
    if (remaining > 0) {
      await expectOk(`receive vendor ${schedule.scheduleNumber}`, invoke(vendorController.receive, {
        params: { orderNumber: current.orderNumber },
        body: {
          qtyReceived: remaining,
          warehouseCode: "WH-001",
          rackCode: "RACK-001",
          lotNumber: `AUG26-${schedule.scheduleNumber}`,
        },
      }));
    }
  }
  current = await prisma.vendorProcessOrder.findUnique({ where: { id: current.id } });
  const qc = await completeQualityInspection(
    { vendorProcessOrderId: current.id },
    schedule.scheduleNumber,
    Number(schedule.plannedQty),
    schedule.scheduleDate,
  );
  return { scheduleNumber: schedule.scheduleNumber, mode: "VENDOR", vendorOrderNumber: current.orderNumber, inspectionNumber: qc.inspectionNumber };
}

async function executeAugust() {
  const mo = await prisma.manufacturingOrder.findFirst({
    where: { monthlyProductionPlanNumber: PLAN_NUMBER, isDeleted: false, status: { not: "Cancelled" } },
  });
  const schedules = await prisma.dailyProductionSchedule.findMany({
    where: { moId: mo.id, isDeleted: false, status: { not: "Cancelled" } },
    include: { productionPlanAllocation: true },
  });
  const vendorOrders = await prisma.vendorProcessOrder.findMany({ where: { moId: mo.id, isDeleted: false } });
  const ordered = orderSchedulesByGraph(schedules);
  const executed = [];
  for (const schedule of ordered) {
    const fresh = await prisma.dailyProductionSchedule.findUnique({ where: { id: schedule.id } });
    let hasQc = 0;
    if (fresh.status === "Completed" && String(fresh.shift).toUpperCase() === "VENDOR") {
      const vendorOrder = vendorOrders.find((row) => allocationIdFromVendorNotes(row.notes) === fresh.productionPlanAllocationId);
      hasQc = vendorOrder
        ? await prisma.qualityInspection.count({ where: { vendorProcessOrderId: vendorOrder.id, status: "Completed", isDeleted: false } })
        : 0;
    } else if (fresh.status === "Completed") {
      hasQc = await prisma.qualityInspection.count({
        where: { productionLog: { dpsId: fresh.id, isDeleted: false }, status: "Completed", isDeleted: false },
      });
    }
    if (hasQc) continue;
    executed.push(String(schedule.shift).toUpperCase() === "VENDOR"
      ? await executeVendorSchedule(schedule, vendorOrders)
      : await executeInhouseSchedule(schedule));
  }

  const predecessorIds = new Set(schedules.flatMap((row) => Array.isArray(row.productionPlanAllocation?.predecessorAllocationIds)
    ? row.productionPlanAllocation.predecessorAllocationIds
    : []));
  const terminalAllocationIds = new Set(schedules
    .map((row) => row.productionPlanAllocationId)
    .filter((id) => !predecessorIds.has(id)));
  const terminalQcs = await prisma.qualityInspection.findMany({
    where: {
      isDeleted: false,
      status: "Completed",
      productionLog: {
        isDeleted: false,
        dailyProductionSchedule: { productionPlanAllocationId: { in: [...terminalAllocationIds] }, isDeleted: false },
      },
    },
    include: { productionLog: { include: { dailyProductionSchedule: true } } },
  });
  const fgReceipts = [];
  for (const qc of terminalQcs) {
    const existingReceipt = await prisma.stockMovement.findFirst({
      where: { referenceType: "QUALITY_INSPECTION", referenceNumber: qc.inspectionNumber, transactionType: "PRODUCTION", stockType: "Finished Goods", direction: "IN", isDeleted: false },
    });
    if (existingReceipt) continue;
    const scheduleNumber = qc.productionLog.dailyProductionSchedule.scheduleNumber;
    const receipt = await expectOk(`FG receipt ${scheduleNumber}`, invoke(qualityController.receiveFg, {
      params: { inspectionNumber: qc.inspectionNumber },
      body: {
        qty: qc.qtyPassed,
        warehouseCode: "WH-001",
        rackCode: "RACK-001",
        lotNumber: `FG-AUG26-${scheduleNumber}`,
        notes: `FG receipt from terminal DPP ${scheduleNumber}`,
      },
    }));
    fgReceipts.push(receipt);
  }

  // Restore WO targets from their published DPPs. Older sequence-based QC
  // synchronization could overwrite parallel branches with the sum of an
  // unrelated sequence (for example 1000 pcs). The DPP allocation is the
  // authoritative execution target.
  const woSchedules = await prisma.dailyProductionSchedule.groupBy({
    by: ["woId"],
    where: { moId: mo.id, woId: { not: null }, isDeleted: false, status: { not: "Cancelled" } },
    _sum: { plannedQty: true, actualQty: true },
    _count: { _all: true },
  });
  for (const row of woSchedules) {
    const incompleteCount = await prisma.dailyProductionSchedule.count({
      where: { woId: row.woId, isDeleted: false, status: { notIn: ["Completed", "Cancelled"] } },
    });
    await prisma.workOrder.update({
      where: { id: row.woId },
      data: {
        plannedQty: Number(row._sum.plannedQty || 0),
        ...(incompleteCount === 0 ? { status: "Completed", endTime: new Date() } : {}),
      },
    });
  }

  const openIssues = await prisma.materialIssue.findMany({
    where: { moId: mo.id, isDeleted: false, status: { in: ["Issued", "Partially Returned"] } },
    select: { issueNumber: true },
  });
  for (const issue of openIssues) {
    await expectOk(`close material ${issue.issueNumber}`, invoke(materialIssueController.close, {
      params: { issueNumber: issue.issueNumber },
    }));
  }

  await prisma.$transaction((tx) => syncManufacturingOrderQtyFromWorkOrders(tx, mo.id));
  return { executed, fgReceiptCount: fgReceipts.length, workOrderCount: woSchedules.length, materialIssuesClosed: openIssues.length };
}

async function main() {
  const preparation = await prepare();
  const execution = await executeAugust();
  process.stdout.write(JSON.stringify({ preparation, execution }, null, 2));
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
