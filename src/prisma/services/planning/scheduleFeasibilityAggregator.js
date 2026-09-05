"use strict";

const CHECK_STATUS = Object.freeze({ PASS: "PASS", WARNING: "WARNING", FAIL: "FAIL", NOT_CHECKED: "NOT_CHECKED", NA: "NA" });
const OVERALL_STATUS = Object.freeze({ FEASIBLE: "FEASIBLE", FEASIBLE_WITH_RISK: "FEASIBLE_WITH_RISK", NOT_FEASIBLE: "NOT_FEASIBLE", NOT_EVALUATED: "NOT_EVALUATED", NA: "NA" });
const STATUS_META = Object.freeze({
  FEASIBLE: { label: "Feasible", tone: "success", rank: 0 },
  FEASIBLE_WITH_RISK: { label: "Feasible dengan Risiko", tone: "warning", rank: 1 },
  NOT_EVALUATED: { label: "Belum Dievaluasi", tone: "neutral", rank: 2 },
  NOT_FEASIBLE: { label: "Tidak Feasible", tone: "danger", rank: 3 },
  NA: { label: "Tidak Berlaku", tone: "muted", rank: -1 },
});
const RULE_PRIORITY = ["MASTER_DATA_READY", "FG_COVERAGE_AT_DUE_DATE", "MATERIAL_READY_BY_START", "FIRM_SUPPLY_ON_TIME", "CAPACITY_AVAILABLE", "RESOURCE_CALENDAR_AVAILABLE", "ROUTING_SEQUENCE_VALID", "LOT_BATCH_YIELD_VALID", "LEAD_TIME_AND_FINISH_FIT", "QUALITY_RELEASE_READY", "DELIVERY_SLOT_AVAILABLE", "BUFFER_POLICY_MET"];

function numericImpact(check = {}) {
  const values = [check.actual?.lateByMinutes, check.actual?.lateByWorkingDays, check.actual?.shortageQty, check.actual?.capacityGapHours, check.gap?.value]
    .map(Number).filter(Number.isFinite).map(Math.abs);
  return values.length ? Math.max(...values) : 0;
}

function primaryConstraint(checks = []) {
  return checks.filter((row) => row.applicable !== false && row.critical && row.status === CHECK_STATUS.FAIL)
    .sort((a, b) => numericImpact(b) - numericImpact(a) || RULE_PRIORITY.indexOf(a.code) - RULE_PRIORITY.indexOf(b.code))[0] || null;
}

function summarizeChecks(checks = [], metadata = {}) {
  const applicable = checks.filter((row) => row.applicable !== false && row.status !== CHECK_STATUS.NA);
  const count = (status) => applicable.filter((row) => row.status === status).length;
  const okCount = count(CHECK_STATUS.PASS);
  const warningCount = count(CHECK_STATUS.WARNING);
  const failCount = count(CHECK_STATUS.FAIL);
  const notCheckedCount = count(CHECK_STATUS.NOT_CHECKED);
  const hasCriticalFail = applicable.some((row) => row.critical && row.status === CHECK_STATUS.FAIL);
  const hasCriticalUnknown = applicable.some((row) => row.critical && row.status === CHECK_STATUS.NOT_CHECKED);
  let status = OVERALL_STATUS.NA;
  if (applicable.length) {
    if (hasCriticalFail) status = OVERALL_STATUS.NOT_FEASIBLE;
    else if (hasCriticalUnknown) status = OVERALL_STATUS.NOT_EVALUATED;
    else if (warningCount || failCount) status = OVERALL_STATUS.FEASIBLE_WITH_RISK;
    else status = OVERALL_STATUS.FEASIBLE;
  }
  const constraint = primaryConstraint(checks);
  return {
    status,
    label: STATUS_META[status].label,
    tone: STATUS_META[status].tone,
    isFeasible: status === OVERALL_STATUS.FEASIBLE || status === OVERALL_STATUS.FEASIBLE_WITH_RISK ? true : status === OVERALL_STATUS.NOT_FEASIBLE ? false : null,
    okCount,
    totalCount: applicable.length,
    warningCount,
    failCount,
    notCheckedCount,
    primaryConstraint: constraint ? { code: constraint.code, label: constraint.label, impact: constraint.gap?.display || constraint.actual?.impactDisplay || constraint.reason } : null,
    earliestFeasibleDeliveryAt: metadata.earliestFeasibleDeliveryAt || null,
    lateByWorkingDays: metadata.lateByWorkingDays ?? null,
    evaluatedAt: metadata.evaluatedAt || new Date().toISOString(),
    sourceDataAsOf: metadata.sourceDataAsOf || metadata.evaluatedAt || new Date().toISOString(),
    rulesVersion: metadata.rulesVersion || "SCHEDULE_FEASIBILITY_V1",
    formulaVersion: metadata.formulaVersion || "MPS_EXISTING_NETTING_V1",
  };
}

function summarizeMpsAssessments(assessments = []) {
  const rows = assessments.filter(Boolean).map((row) => row.summary || row.checklistSummary || row);
  const counts = Object.fromEntries(Object.keys(STATUS_META).map((status) => [status, rows.filter((row) => row.status === status).length]));
  if (!rows.length) return { ...STATUS_META.NA, status: OVERALL_STATUS.NA, isFeasible: null, okCount: 0, totalCount: 0, warningCount: 0, failCount: 0, notCheckedCount: 0, counts };
  const worst = rows.filter((row) => row.status !== OVERALL_STATUS.NA).sort((a, b) => (STATUS_META[b.status]?.rank ?? -1) - (STATUS_META[a.status]?.rank ?? -1))[0];
  const status = worst?.status || OVERALL_STATUS.NA;
  return {
    status, label: STATUS_META[status].label, tone: STATUS_META[status].tone,
    isFeasible: status === OVERALL_STATUS.FEASIBLE || status === OVERALL_STATUS.FEASIBLE_WITH_RISK ? true : status === OVERALL_STATUS.NOT_FEASIBLE ? false : null,
    okCount: rows.reduce((sum, row) => sum + Number(row.okCount || 0), 0),
    totalCount: rows.reduce((sum, row) => sum + Number(row.totalCount || 0), 0),
    warningCount: rows.reduce((sum, row) => sum + Number(row.warningCount || 0), 0),
    failCount: rows.reduce((sum, row) => sum + Number(row.failCount || 0), 0),
    notCheckedCount: rows.reduce((sum, row) => sum + Number(row.notCheckedCount || 0), 0),
    primaryConstraint: worst?.primaryConstraint || null,
    counts,
  };
}

module.exports = { CHECK_STATUS, OVERALL_STATUS, STATUS_META, summarizeChecks, summarizeMpsAssessments };
