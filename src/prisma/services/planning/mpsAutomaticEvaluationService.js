"use strict";

const { runRccp } = require("./rccpService");
const { refreshMpsDeliveryFeasibility } = require("./mpsDeliveryFeasibilityService");
const { getMpsWorkbench } = require("./mpsWorkbenchService");
const { planningMonthKey } = require("../../utils/planningMonth");
const { refreshProductionEvidence } = require("./mpsProductionEvidenceService");

function errorSummary(error) {
  return {
    code: error?.code || "AUTOMATIC_EVALUATION_FAILED",
    message: error?.message || "Evaluasi otomatis gagal dijalankan.",
    exceptions: Array.isArray(error?.exceptions) ? error.exceptions : [],
  };
}

function rccpSummary(run) {
  const completed = Boolean(run?.id) && !["NOT_CHECKED", "RUNNING", "INVALID"].includes(run.status || "NOT_CHECKED");
  return {
    completed,
    ...(!completed ? { code: "MPS_RCCP_INCOMPLETE", message: "RCCP belum menghasilkan evaluasi aktif untuk revisi ini." } : {}),
    runId: run?.id || null,
    status: run?.status || "NOT_CHECKED",
    approvalAllowed: Boolean(run?.approvalAllowed),
    completedAt: run?.completedAt || null,
  };
}

function deliverySummary(gate) {
  const completed = Boolean(gate?.feasibilityStatus) && !["STALE", "UNKNOWN", "NOT_CHECKED", "NOT_EVALUATED"].includes(gate.feasibilityStatus);
  return {
    completed,
    ...(!completed ? { code: "MPS_DELIVERY_INCOMPLETE", message: gate?.reason || "Snapshot delivery belum current; pemeriksaan belum lengkap." } : {}),
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
  const evaluateProduction = services.refreshProductionEvidence || refreshProductionEvidence;
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
      const evidence = await evaluateProduction(prisma, document.mpsNumber, options);
      item.productionEvidence = { ...evidence, completed: evidence.failedPhaseCount === 0 };
      if (!item.productionEvidence.completed) item.productionEvidence.message = `${evidence.failedPhaseCount} fase produksi gagal dievaluasi; buka checksheet untuk detail error.`;
    } catch (error) {
      item.productionEvidence = { completed: false, ...errorSummary(error) };
    }

    try {
      const month = planningMonthKey(document.periodStart || options.planningAnchorMonth);
      if (!month) throw Object.assign(new Error("Periode MPS tidak tersedia untuk checklist."), { code: "MPS_PERIOD_MISSING" });
      const workbench = await readWorkbench(prisma, {
        month,
        page: 1,
        pageSize: 100,
        allItemsForEvaluation: true,
        includeFeasibilityDetail: true,
      });
      if (workbench?.mps?.mpsNumber !== document.mpsNumber || !workbench.feasibilitySummary
        || (document.revision != null && Number(document.revision) !== Number(workbench.mps.revision))) {
        throw Object.assign(new Error("Dokumen/revisi MPS berubah saat pemeriksaan; hitung ulang checklist revisi aktif."), { code: "MPS_CHECKLIST_REVISION_CHANGED" });
      }
      item.checklist = {
        completed: item.productionEvidence.completed && Number(workbench.feasibilitySummary.notCheckedCount || 0) === 0 && Number(workbench.feasibilitySummary.missingDataCount || 0) === 0,
        attempted: true,
        status: workbench?.feasibilitySummary?.status || "NOT_EVALUATED",
        okCount: Number(workbench?.feasibilitySummary?.okCount) || 0,
        totalCount: Number(workbench?.feasibilitySummary?.totalCount) || 0,
        failCount: Number(workbench?.feasibilitySummary?.failCount) || 0,
        warningCount: Number(workbench?.feasibilitySummary?.warningCount) || 0,
        notCheckedCount: Number(workbench?.feasibilitySummary?.notCheckedCount) || 0,
        missingDataCount: Number(workbench?.feasibilitySummary?.missingDataCount ?? workbench?.feasibilitySummary?.notCheckedCount) || 0,
        checkedCount: Number(workbench?.feasibilitySummary?.checkedCount) || 0,
        missingFields: workbench?.feasibilitySummary?.missingFields || [],
        evaluatedAt: workbench?.generatedAt || null,
      };
      if (!item.checklist.completed) {
        item.checklist.code = "MPS_CHECKLIST_DATA_INCOMPLETE";
        item.checklist.message = item.productionEvidence.completed
          ? `${item.checklist.missingDataCount} area masih memerlukan data sumber; lengkapi datanya lalu klik Periksa Checksheet.`
          : "Sebagian pemeriksaan produksi gagal; periksa detail error lalu klik Periksa Checksheet kembali.";
      }
    } catch (error) {
      item.checklist = { completed: false, ...errorSummary(error) };
    }
    items.push(item);
  }

  const failedSteps = items.reduce((count, item) => count
    + (item.rccp?.completed ? 0 : 1)
    + (item.delivery?.completed ? 0 : 1)
    + (item.productionEvidence?.completed ? 0 : 1)
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
