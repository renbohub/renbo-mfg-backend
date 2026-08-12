"use strict";

function normalizeMonth(value) {
  const match = String(value || "").match(/(\d{4})[-/]?(\d{2})/);
  if (!match) throw Object.assign(new Error("Planning month wajib berformat YYYY-MM."), { statusCode: 400 });
  return `${match[1]}-${match[2]}`;
}

function monthlyMrpIdentity(planningMonth, revision = 1) {
  const month = normalizeMonth(planningMonth);
  const planNumber = `MRP-${month.replace("-", "")}`;
  const planRevision = Math.max(Number(revision) || 1, 1);
  return { planNumber, runNumber: `${planNumber}-R${String(planRevision).padStart(3, "0")}`, planRevision };
}

async function nextMonthlyMrpIdentity(tx, planningMonth) {
  const base = monthlyMrpIdentity(planningMonth, 1);
  const latest = await tx.mRPRun.findFirst({ where: { planNumber: base.planNumber }, orderBy: { planRevision: "desc" }, select: { planRevision: true } });
  return monthlyMrpIdentity(planningMonth, Number(latest?.planRevision || 0) + 1);
}

module.exports = { normalizeMonth, monthlyMrpIdentity, nextMonthlyMrpIdentity };
