"use strict";

const { runRccp } = require("./rccpService");
const { refreshMpsDeliveryFeasibility } = require("./mpsDeliveryFeasibilityService");
const { getMpsWorkbench } = require("./mpsWorkbenchService");
const { planningMonthKey } = require("../../utils/planningMonth");

function errorSummary(error) {
  return {
    code: error?.code || "AUTOMATIC_EVALUATION_FAILED",
    message: error?.message || "Evaluasi otomatis gagal dijalankan.",
    exceptions: Array.isArray(error?.exceptions) ? error.exceptions : [],
  };
}

function rccpSummary(run) {
  return {
    completed: true,
    runId: run?.id || null,
    status: run?.status || "NOT_CHECKED",
    approvalAllowed: Boolean(run?.approvalAllowed),
    completedAt: run?.completedAt || null,
  };
}

function deliverySummary(gate) {
  return {
    completed: true,
    feasibilityStatus: gate?.feasibilityStatus || "NOT_CHECKED",
    dispositionStatus: gate?.dispositionStatus || "PENDING",
    officialGateStatus: gate?.officialGateStatus || "BLOCKED",
    reason: gate?.reason || null,
    fingerprint: gate?.fingerprint || null,
  };
}

/**
 * Single post-calculation pipeline for MPS. RCCP must run before the final
 * delivery snapshot so every workbench checklist reads one current revision.
 * A missing master-data prerequisite is reported per document without hiding
 * the MPS that was already calculated and committed.
 */
async function runAutomaticMpsEvaluation(prisma, documents = [], options = {}, services = {}) {
  const executeRccp = services.runRccp || runRccp;
  const refreshDelivery = services.refreshMpsDeliveryFeasibility || refreshMpsDeliveryFeasibility;
  const readWorkbench = services.getMpsWorkbench || getMpsWorkbench;
  const uniqueDocuments = [...new Map((documents || [])
    .filter((document) => document?.mpsNumber)
    .map((document) => [document.mpsNumber, document])).values()];
  const items = [];

  for (const document of uniqueDocuments) {
    const item = { mpsNumber: document.mpsNumber, rccp: null, delivery: null, checklist: null };
    try {
      const run = await executeRccp(prisma, document.mpsNumber, {
        runBy: options.runBy || "system",
        requiredDateSource: "DELIVERY_PHASE",
        includePreviousMonth: true,
        includeVendorLeadTime: true,
        useWorkingCalendar: true,
        searchAlternativeStart: true,
      });
      item.rccp = rccpSummary(run);
    } catch (error) {
      item.rccp = { completed: false, ...errorSummary(error) };
    }

    try {
      const gate = await prisma.$transaction((tx) => refreshDelivery(tx, document.mpsNumber), {
        maxWait: 10000,
        timeout: 120000,
      });
      item.delivery = deliverySummary(gate);
    } catch (error) {
      item.delivery = { completed: false, ...errorSummary(error) };
    }

    try {
      const month = planningMonthKey(document.periodStart || options.planningAnchorMonth);
      if (!month) throw Object.assign(new Error("Periode MPS tidak tersedia untuk checklist."), { code: "MPS_PERIOD_MISSING" });
      const workbench = await readWorkbench(prisma, {
        month,
        page: 1,
        pageSize: 100,
        includeSimulation: true,
      });
      item.checklist = {
        completed: true,
        status: workbench?.feasibilitySummary?.status || "NOT_EVALUATED",
        okCount: Number(workbench?.feasibilitySummary?.okCount) || 0,
        totalCount: Number(workbench?.feasibilitySummary?.totalCount) || 0,
        failCount: Number(workbench?.feasibilitySummary?.failCount) || 0,
        warningCount: Number(workbench?.feasibilitySummary?.warningCount) || 0,
        notCheckedCount: Number(workbench?.feasibilitySummary?.notCheckedCount) || 0,
        evaluatedAt: workbench?.generatedAt || null,
      };
    } catch (error) {
      item.checklist = { completed: false, ...errorSummary(error) };
    }
    items.push(item);
  }

  const failedSteps = items.reduce((count, item) => count
    + (item.rccp?.completed ? 0 : 1)
    + (item.delivery?.completed ? 0 : 1)
    + (item.checklist?.completed ? 0 : 1), 0);
  return {
    mode: "AUTOMATIC_ON_MPS_CALCULATION",
    status: failedSteps ? "COMPLETED_WITH_EXCEPTIONS" : "COMPLETED",
    documentCount: items.length,
    failedSteps,
    items,
  };
}

module.exports = {
  runAutomaticMpsEvaluation,
  errorSummary,
};
