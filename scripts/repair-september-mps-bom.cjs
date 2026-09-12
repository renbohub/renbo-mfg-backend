"use strict";
const assert = require("node:assert/strict");
const { prisma } = require("../src/prisma");
const { resolveMbomRevision, isRevisionEffectiveAt } = require("../src/prisma/services/planning/mbomRevisionService");
const { invalidateRccp } = require("../src/prisma/services/planning/rccpService");
const { invalidateMpsDeliveryGate } = require("../src/prisma/services/planning/mpsDeliveryFeasibilityService");
const { runAutomaticMpsEvaluation } = require("../src/prisma/services/planning/mpsAutomaticEvaluationService");
const DETAIL = "c072c896-6ee9-4309-9d7d-374afce8a57c";
const OLD = "534d6b28-07fc-47d6-a2d2-bd7f27feae47";
const KEEP = "4735fd08-f680-4351-ba57-12436cccf497";
const REASON = "Perbaikan referensi BOM Retainer: revisi 6 diganti revisi 7 yang berlaku; qty dan tanggal delivery tidak berubah. Approval perlu diulang.";

async function inspect(tx) {
  const detail = await tx.mPSDetail.findUnique({ where: { id: DETAIL }, include: { mps: true } });
  assert(detail && !detail.isDeleted && !detail.mps.isDeleted && detail.mpsNumber === "MPS-202609");
  assert(["Draft", "Confirmed"].includes(detail.mps.status), "Released/historical MPS must not be repaired in place");
  assert([OLD, KEEP].includes(detail.mbomHeaderId), "MPS BOM changed unexpectedly");
  assert.equal(detail.mbomSelectionMode, "AUTO_EFFECTIVE_DATE");
  const revisions = await tx.mBOMHeader.findMany({ where: { partId: detail.partId, isDeleted: false } });
  const selectionDate = detail.mbomSelectionDate || detail.fgRequiredDate || detail.startDate;
  const selected = resolveMbomRevision({ revisions, selectionDate }).revision;
  assert.equal(selected?.id, KEEP, "Expected effective revision 7");
  const phases = await tx.mPSDeliveryPlan.findMany({ where: { mpsNumber: detail.mpsNumber, partCode: detail.partCode }, orderBy: { id: "asc" } });
  for (const date of [detail.startDate, detail.endDate, ...phases.flatMap((row) => [row.plannedDate, row.fgRequiredDate]).filter(Boolean)]) {
    assert(isRevisionEffectiveAt(selected, date), "New BOM does not cover all planned dates");
  }
  return { detail, selected, selectionDate, phases };
}

async function run() {
  const before = await inspect(prisma);
  if (!process.argv.includes("--execute")) return { dryRun: true, mps: before.detail.mpsNumber, status: before.detail.mps.status, from: before.detail.mbomHeaderId, to: before.selected.id, newStatus: "Draft", qtyUnchanged: before.detail.qtyPlanned };
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM tbl_mps WHERE mps_number = 'MPS-202609' FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM tbl_mps_detail WHERE id = ${DETAIL} FOR UPDATE`;
    const { detail, selected, selectionDate, phases } = await inspect(tx);
    if (detail.mbomHeaderId === KEEP) return { alreadyRepaired: true, mpsNumber: detail.mpsNumber };
    const trace = { ...(detail.calculationTrace || {}) };
    delete trace.productionChecksheet;
    trace.bomReferenceRepair = { at: new Date().toISOString(), reason: REASON, from: OLD, to: KEEP, previousMpsRevision: detail.mps.revision, previousStatus: detail.mps.status, previousApprovedBy: detail.mps.approvedBy, previousApprovedDate: detail.mps.approvedDate };
    await tx.mPSDetail.update({ where: { id: DETAIL }, data: {
      mbomHeaderId: KEEP, mbomRevisionSnapshot: selected.revision, mbomNoRegSnapshot: selected.noReg,
      mbomSelectionDate: selectionDate, mbomSelectionWarning: null, calculationTrace: trace,
    } });
    await invalidateRccp(tx, detail.mps.id, REASON);
    await invalidateMpsDeliveryGate(tx, detail.mpsNumber, REASON);
    await tx.mPS.update({ where: { id: detail.mps.id }, data: { status: "Draft", lifecycleStatus: "DRAFT", approvedBy: null, approvedDate: null, notes: `${detail.mps.notes || ""}\n${REASON}`.trim() } });
    const retired = await tx.mRPRun.updateMany({ where: { mpsNumber: detail.mpsNumber, isCurrentPlan: true, isDeleted: false }, data: { isCurrentPlan: false } });
    const after = await tx.mPSDetail.findUnique({ where: { id: DETAIL } });
    for (const field of ["qtyPlanned", "startDate", "endDate", "customerTargetDate", "fgRequiredDate", "bufferQty", "effectiveDemandQty"]) assert.deepEqual(after[field], detail[field]);
    assert.deepEqual(await tx.mPSDeliveryPlan.findMany({ where: { mpsNumber: detail.mpsNumber, partCode: detail.partCode }, orderBy: { id: "asc" } }), phases);
    return { mpsNumber: detail.mpsNumber, from: OLD, to: KEEP, bom: selected.noReg, status: "Draft", qtyUnchanged: after.qtyPlanned, historicalMrpRunsRetired: retired.count };
  }, { isolationLevel: "Serializable", timeout: 30000 });
  console.log(JSON.stringify({ repair: result }));
  if (process.argv.includes("--evaluate")) {
    const doc = await prisma.mPS.findUnique({ where: { mpsNumber: "MPS-202609" } });
    return { repair: result, evaluation: await runAutomaticMpsEvaluation(prisma, [doc], { runBy: "system-bom-repair" }) };
  }
  return result;
}
run().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); process.exit(process.exitCode || 0); });
