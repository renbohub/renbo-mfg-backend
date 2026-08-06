/* eslint-disable no-console */
require("dotenv").config({ quiet: true });

const { prisma } = require("../src/prisma");
const dailyPlanController = require("../src/prisma/controllers/production/DailyProductionScheduleController");
const materialIssueController = require("../src/prisma/controllers/production/MaterialIssueController");

const apply = process.argv.includes("--apply");
const moNumber = process.argv.find((value) => value.startsWith("--mo="))?.slice(5);

if (!moNumber) {
  throw new Error("Gunakan --mo=<MO_NUMBER> dan tambahkan --apply setelah hasil dry-run diverifikasi.");
}

const number = (value) => Number(value || 0);

function invoke(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) {
        if (this.statusCode >= 400) {
          const error = new Error(body?.message || `HTTP ${this.statusCode}`);
          error.statusCode = this.statusCode;
          error.body = body;
          reject(error);
          return;
        }
        resolve({ statusCode: this.statusCode, body });
      },
    };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}

async function getWipSnapshot(partPrefix) {
  const rows = await prisma.stockBalance.groupBy({
    by: ["partCode", "uomCode"],
    where: {
      isDeleted: false,
      stockType: "WIP",
      qtyOnHand: { gt: 0.000001 },
      ...(partPrefix ? { partCode: { startsWith: partPrefix } } : {}),
    },
    _sum: {
      qtyOnHand: true,
      qtyReserved: true,
      qtyQC: true,
      qtyAvailable: true,
    },
    orderBy: [{ partCode: "asc" }, { uomCode: "asc" }],
  });
  return rows.map((row) => ({
    partCode: row.partCode,
    uomCode: row.uomCode,
    qtyOnHand: number(row._sum.qtyOnHand),
    qtyReserved: number(row._sum.qtyReserved),
    qtyQC: number(row._sum.qtyQC),
    qtyAvailable: number(row._sum.qtyAvailable),
  }));
}

function outputIdentity(schedule) {
  return {
    partId: schedule.workOrder?.outputPartId
      || schedule.mbomProcess?.mbomDetail?.partId
      || schedule.partId
      || null,
    partCode: schedule.workOrder?.outputPartCode
      || schedule.mbomProcess?.mbomDetail?.part?.partCode
      || schedule.partCode
      || null,
  };
}

function allocationDepth(scheduleByAllocationId, schedule, visiting = new Set()) {
  const allocation = schedule.productionPlanAllocation;
  if (!allocation || visiting.has(allocation.id)) return 0;
  const predecessors = Array.isArray(allocation.predecessorAllocationIds)
    ? allocation.predecessorAllocationIds
    : [];
  if (!predecessors.length) return 0;
  const next = new Set(visiting).add(allocation.id);
  return Math.max(...predecessors.map((id) => {
    const predecessor = scheduleByAllocationId.get(id);
    return predecessor ? allocationDepth(scheduleByAllocationId, predecessor, next) + 1 : 1;
  }));
}

async function prepareMaterialIssue(schedule) {
  const marker = `[DPS-CONSUME:${schedule.scheduleNumber}]`;
  return prisma.$transaction(async (tx) => {
    const corrected = await tx.dailyProductionSchedule.update({
      where: { id: schedule.id },
      data: outputIdentity(schedule),
    });
    const existing = await tx.materialIssue.findFirst({
      where: { moId: schedule.moId, woId: schedule.woId, isDeleted: false, notes: { contains: marker } },
      include: { details: { where: { isDeleted: false } } },
    });
    if (!existing) {
      throw new Error(`Material Issue ${marker} tidak ditemukan; repair dibatasi ke dokumen kosong yang sudah terbentuk.`);
    }
    if (existing.details.length > 0) return existing;
    if (!new Set(["Draft", "Closed"]).has(existing.status)) {
      throw new Error(`${existing.issueNumber} kosong tetapi status ${existing.status}; tidak aman direkonsiliasi otomatis.`);
    }
    if (existing.status !== "Draft") {
      await tx.materialIssue.update({ where: { id: existing.id }, data: { status: "Draft" } });
    }
    return dailyPlanController.__maintenance.ensureMaterialIssueDraft(tx, corrected, "dpp-wip-reconciliation");
  });
}

async function main() {
  const mo = await prisma.manufacturingOrder.findFirst({
    where: { moNumber, isDeleted: false },
    select: {
      id: true,
      moNumber: true,
      partId: true,
      qtyPlanned: true,
      qtyGood: true,
      status: true,
      uomCode: true,
      materialRequirementUomMode: true,
      inputSourceType: true,
      sourceStockBalanceId: true,
      sourceQtyPlanned: true,
      sourcePartCode: true,
      sourcePartNumber: true,
      sourceWarehouseCode: true,
      sourceRackCode: true,
      sourceLotNumber: true,
      part: { select: { partCode: true } },
    },
  });
  if (!mo) throw new Error(`MO ${moNumber} tidak ditemukan.`);
  if (apply && mo.status !== "Completed") {
    throw new Error(`Repair apply hanya untuk MO Completed; status ${moNumber} saat ini ${mo.status}.`);
  }

  const scheduleRows = await prisma.dailyProductionSchedule.findMany({
    where: { moId: mo.id, isDeleted: false },
    include: {
      mbomProcess: {
        select: {
          mbomDetail: { select: { partId: true, part: { select: { partCode: true } } } },
        },
      },
      productionPlanAllocation: { select: { id: true, predecessorAllocationIds: true, routingMode: true } },
    },
    orderBy: [{ scheduleDate: "asc" }, { scheduleNumber: "asc" }],
  });
  const workOrders = await prisma.workOrder.findMany({
    where: { id: { in: scheduleRows.map((row) => row.woId).filter(Boolean) }, isDeleted: false },
    select: { id: true, outputPartId: true, outputPartCode: true },
  });
  const workOrderById = new Map(workOrders.map((row) => [row.id, row]));
  const schedules = scheduleRows.map((row) => ({ ...row, workOrder: workOrderById.get(row.woId) || null }));
  if (!schedules.length) throw new Error(`Daily Production Plan untuk ${moNumber} tidak ditemukan.`);
  const incomplete = schedules.filter((row) => row.status !== "Completed");
  if (apply && incomplete.length) {
    throw new Error(`Ada ${incomplete.length} DPP yang belum Completed; repair dibatalkan.`);
  }

  const partPrefix = String(mo.part?.partCode || "").split("-").slice(0, 1).join("-") || null;
  const before = await getWipSnapshot(partPrefix);
  const mappingMismatch = schedules.filter((row) => {
    const expected = outputIdentity(row);
    return row.partId !== expected.partId || row.partCode !== expected.partCode;
  });
  const inhouse = schedules.filter((row) => row.woId && String(row.productionPlanAllocation?.routingMode || row.shift).toUpperCase() !== "VENDOR");
  const issues = await prisma.materialIssue.findMany({
    where: { moId: mo.id, isDeleted: false },
    select: { id: true, issueNumber: true, status: true, notes: true, details: { where: { isDeleted: false }, select: { id: true } } },
  });
  const emptyIssues = issues.filter((row) => row.details.length === 0);
  const rawCoverage = new Map();
  for (const schedule of inhouse) {
    const availability = await dailyPlanController.__maintenance.buildScheduleMaterialAvailability(prisma, schedule, mo);
    for (const item of availability.items || []) {
      if (String(item.itemType || "").trim().toUpperCase() !== "RAW") continue;
      const isMaterial = String(item.rawType || "").trim().toUpperCase() === "MATERIAL";
      const key = isMaterial
        ? `MATERIAL|${item.materialCode || item.partCode}|${String(item.uomCode || "").toLowerCase()}`
        : `PART|${item.partCode}|${String(item.uomCode || "").toLowerCase()}`;
      const current = rawCoverage.get(key) || {
        key,
        partCodes: new Set(),
        materialCode: isMaterial ? item.materialCode || null : null,
        uomCode: item.uomCode || null,
        requiredQty: 0,
        availableQty: 0,
      };
      current.partCodes.add(item.partCode);
      current.requiredQty += number(item.qtyRequired);
      // Shared material identities expose the same aggregate availability on
      // every part alias. Use the pool once, never sum it per BOM line.
      current.availableQty = Math.max(current.availableQty, number(item.qtyAvailable));
      rawCoverage.set(key, current);
    }
  }
  const rawCoverageRows = [...rawCoverage.values()].map((row) => ({
    ...row,
    partCodes: [...row.partCodes],
    shortageQty: Math.max(0, row.requiredQty - row.availableQty),
  }));
  const rawShortages = rawCoverageRows.filter((row) => row.shortageQty > 0.000001);

  const baseReport = {
    mode: apply ? "APPLY" : "DRY_RUN",
    mo: { moNumber: mo.moNumber, status: mo.status, qtyPlanned: number(mo.qtyPlanned), qtyGood: number(mo.qtyGood) },
    dailyPlans: schedules.length,
    inhouseDailyPlans: inhouse.length,
    mappingMismatch: mappingMismatch.length,
    materialIssues: issues.length,
    emptyMaterialIssues: emptyIssues.length,
    rawCoverage: rawCoverageRows,
    rawShortages,
    wipBefore: before,
  };

  if (!apply) {
    console.log(`RESULT=${JSON.stringify(baseReport)}`);
    return;
  }
  if (rawShortages.length) {
    throw Object.assign(
      new Error(`Repair dibatalkan: ada ${rawShortages.length} pool raw material yang tidak cukup. Lakukan purchasing/receipt yang sah sebelum posting ulang Material Issue.`),
      { shortages: rawShortages },
    );
  }

  // Repair in graph order. Splits of the same operation remain ordered by
  // date/number so the second split selects the stock left by the first one.
  const byAllocation = new Map(schedules.map((row) => [row.productionPlanAllocation?.id, row]).filter(([id]) => id));
  const ordered = [...inhouse].sort((left, right) =>
    allocationDepth(byAllocation, left) - allocationDepth(byAllocation, right)
      || new Date(left.scheduleDate).getTime() - new Date(right.scheduleDate).getTime()
      || left.scheduleNumber.localeCompare(right.scheduleNumber));

  // Correct vendor DPP identity as well; vendor material movement is managed
  // by the Vendor Process Order and must not create a second Material Issue.
  for (const schedule of schedules.filter((row) => !row.woId)) {
    await prisma.dailyProductionSchedule.update({ where: { id: schedule.id }, data: outputIdentity(schedule) });
  }

  const repaired = [];
  for (const schedule of ordered) {
    const marker = `[DPS-CONSUME:${schedule.scheduleNumber}]`;
    let issue = await prisma.materialIssue.findFirst({
      where: { moId: mo.id, woId: schedule.woId, isDeleted: false, notes: { contains: marker } },
      include: { details: { where: { isDeleted: false } } },
    });
    if (!issue) throw new Error(`Material Issue ${marker} tidak ditemukan.`);

    if (!issue.details.length) issue = await prepareMaterialIssue(schedule);
    if (!issue.details.length) {
      throw new Error(`${issue.issueNumber} tetap tidak mempunyai detail setelah output DPP diperbaiki.`);
    }
    const unresolved = issue.details.filter((detail) => number(detail.qtyIssued) > 0 && !detail.stockBalanceId);
    if (unresolved.length) {
      throw new Error(`${issue.issueNumber} memiliki ${unresolved.length} shortage/unresolved stock source; transaksi dihentikan sebelum posting.`);
    }

    if (issue.status === "Draft") {
      await invoke(materialIssueController.issue, {
        params: { issueNumber: issue.issueNumber },
        body: {},
        user: { username: "dpp-wip-reconciliation" },
      });
      issue = await prisma.materialIssue.findUnique({ where: { id: issue.id }, include: { details: { where: { isDeleted: false } } } });
    }
    if (issue.status === "Issued" || issue.status === "Partially Returned") {
      await invoke(materialIssueController.close, {
        params: { issueNumber: issue.issueNumber },
        body: {},
        user: { username: "dpp-wip-reconciliation" },
      });
    }
    repaired.push({
      scheduleNumber: schedule.scheduleNumber,
      outputPartCode: outputIdentity(schedule).partCode,
      issueNumber: issue.issueNumber,
      detailCount: issue.details.length,
      qtyIssued: issue.details.reduce((sum, detail) => sum + number(detail.qtyIssued), 0),
    });
  }

  const after = await getWipSnapshot(partPrefix);
  const finalIssues = await prisma.materialIssue.findMany({
    where: { moId: mo.id, isDeleted: false },
    select: { status: true, details: { where: { isDeleted: false }, select: { id: true } } },
  });
  console.log(`RESULT=${JSON.stringify({
    ...baseReport,
    repairedCount: repaired.length,
    repaired,
    emptyMaterialIssuesAfter: finalIssues.filter((row) => row.details.length === 0).length,
    materialIssueStatusesAfter: [...new Set(finalIssues.map((row) => row.status))],
    wipAfter: after,
  })}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
