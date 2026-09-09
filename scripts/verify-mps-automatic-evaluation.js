"use strict";

const assert = require("node:assert/strict");
const { runAutomaticMpsEvaluation } = require("../src/prisma/services/planning/mpsAutomaticEvaluationService");

async function main() {
  const calls = [];
  const prisma = {
    $transaction: async (operation, options) => {
      calls.push(["transaction", options]);
      return operation({ kind: "transaction-client" });
    },
  };
  const services = {
    runRccp: async (_prisma, mpsNumber, options) => {
      calls.push(["rccp", mpsNumber, options]);
      if (mpsNumber === "MPS-FAIL") throw Object.assign(new Error("Profile RCCP belum lengkap."), { code: "NO_RCCP_PROFILE" });
      return { id: `RCCP-${mpsNumber}`, status: "FEASIBLE", approvalAllowed: true };
    },
    refreshMpsDeliveryFeasibility: async (tx, mpsNumber) => {
      calls.push(["delivery", mpsNumber, tx.kind]);
      return { feasibilityStatus: "FEASIBLE", dispositionStatus: "NOT_REQUIRED", officialGateStatus: "ALLOWED" };
    },
    refreshProductionEvidence: async (_prisma, mpsNumber) => {
      calls.push(["production", mpsNumber]);
      return { phaseCount: 4, failedPhaseCount: 0 };
    },
    getMpsWorkbench: async (_prisma, options) => {
      calls.push(["checklist", options.month]);
      assert.equal(options.includeFeasibilityDetail, true);
      const latestDocument = calls.filter(([name]) => name === "rccp").at(-1)[1];
      return { mps: { mpsNumber: latestDocument }, generatedAt: "2026-09-04T00:00:00.000Z", feasibilitySummary: { status: "FEASIBLE", okCount: 12, totalCount: 12, checkedCount: 12, failCount: 0, warningCount: 0, notCheckedCount: 0 } };
    },
  };

  const result = await runAutomaticMpsEvaluation(prisma, [
    { mpsNumber: "MPS-OK", periodStart: "2026-09-01T00:00:00.000Z" },
    { mpsNumber: "MPS-OK", periodStart: "2026-09-01T00:00:00.000Z" },
    { mpsNumber: "MPS-FAIL", periodStart: "2026-09-01T00:00:00.000Z" },
  ], { runBy: "tester" }, services);

  assert.equal(result.mode, "AUTOMATIC_ON_MPS_CALCULATION");
  assert.equal(result.documentCount, 2, "Dokumen duplikat hanya boleh dievaluasi satu kali");
  assert.equal(result.status, "COMPLETED_WITH_EXCEPTIONS");
  assert.equal(result.failedSteps, 1);
  assert.equal(result.items[0].rccp.status, "FEASIBLE");
  assert.equal(result.items[0].delivery.officialGateStatus, "ALLOWED");
  assert.equal(result.items[0].checklist.status, "FEASIBLE");
  assert.equal(result.items[1].rccp.code, "NO_RCCP_PROFILE");
  assert.equal(result.items[1].delivery.completed, true, "Delivery snapshot tetap direfresh saat RCCP gagal");
  assert.deepEqual(calls.filter(([name]) => name === "rccp").map(([, mpsNumber]) => mpsNumber), ["MPS-OK", "MPS-FAIL"]);
  assert.deepEqual(calls.filter(([name]) => name === "delivery").map(([, mpsNumber]) => mpsNumber), ["MPS-OK", "MPS-FAIL"]);
  assert.deepEqual(calls.filter(([name]) => name === "checklist").map(([, month]) => month), ["2026-09", "2026-09"]);
  assert.equal(calls[0][0], "rccp");
  assert.equal(calls[2][0], "delivery", "Delivery harus dijalankan sesudah RCCP untuk tiap MPS");
  assert.equal(calls[3][0], "production", "Semua fase produksi diperiksa setelah delivery snapshot");
  assert.equal(calls[4][0], "checklist", "Checklist harus membaca bukti produksi terbaru");

  const incomplete = await runAutomaticMpsEvaluation(prisma, [{ mpsNumber: "MPS-OK", periodStart: "2026-09-01" }], {}, {
    ...services,
    getMpsWorkbench: async () => ({ mps: { mpsNumber: "MPS-OK" }, feasibilitySummary: { status: "NOT_EVALUATED", checkedCount: 12, okCount: 7, totalCount: 12, notCheckedCount: 5, missingFields: ["deliverySchedule"] } }),
  });
  assert.equal(incomplete.status, "COMPLETED_WITH_EXCEPTIONS");
  assert.equal(incomplete.items[0].checklist.attempted, true);
  assert.equal(incomplete.items[0].checklist.completed, false, "7/12 must not report a complete evaluation");
  assert.equal(incomplete.items[0].checklist.checkedCount, 12);
  assert.deepEqual(incomplete.items[0].checklist.missingFields, ["deliverySchedule"]);
  const changed = await runAutomaticMpsEvaluation(prisma, [{ mpsNumber: "MPS-OK", periodStart: "2026-09-01", revision: 1 }], {}, {
    ...services, getMpsWorkbench: async () => ({ mps: { mpsNumber: "MPS-OK", revision: 2 }, feasibilitySummary: { notCheckedCount: 0 } }),
  });
  assert.equal(changed.items[0].checklist.code, "MPS_CHECKLIST_REVISION_CHANGED");
  const productionFailed = await runAutomaticMpsEvaluation(prisma, [{ mpsNumber: "MPS-OK", periodStart: "2026-09-01" }], {}, {
    ...services, refreshProductionEvidence: async () => { throw new Error("Stock berubah selama pemeriksaan"); },
  });
  assert.equal(productionFailed.items[0].productionEvidence.completed, false);
  assert.equal(productionFailed.items[0].checklist.completed, false, "old green summary cannot hide failed production evaluation");
  assert.equal(productionFailed.failedSteps, 2);

  console.log("MPS automatic RCCP and delivery evaluation verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
