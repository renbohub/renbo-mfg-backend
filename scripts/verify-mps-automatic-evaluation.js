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
    getMpsWorkbench: async (_prisma, options) => {
      calls.push(["checklist", options.month]);
      return { generatedAt: "2026-09-04T00:00:00.000Z", feasibilitySummary: { status: "FEASIBLE", okCount: 12, totalCount: 12, failCount: 0, warningCount: 0, notCheckedCount: 0 } };
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
  assert.equal(calls[3][0], "checklist", "Checklist harus dihitung setelah delivery snapshot");

  console.log("MPS automatic RCCP and delivery evaluation verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
