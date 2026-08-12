"use strict";

function evaluateDisplacement({ status, withinFreezeFence = false, hasOverrideApproval = false, overrideReason = null }) {
  const normalized = String(status || "Draft").trim().toUpperCase();
  if (["IN PROGRESS", "COMPLETED"].includes(normalized)) return { decision: "IMMUTABLE", allowed: false, reason: `${status} schedule tidak boleh di-reschedule otomatis.` };
  if (normalized === "DRAFT") return { decision: "AUTO_RESCHEDULE_ALLOWED", allowed: true };
  if (normalized === "RELEASED" && withinFreezeFence) {
    const approved = Boolean(hasOverrideApproval && String(overrideReason || "").trim());
    return { decision: approved ? "APPROVED_OVERRIDE" : "OVERRIDE_APPROVAL_REQUIRED", allowed: approved, reason: approved ? overrideReason : "Released DPP dalam freeze fence memerlukan approval dan alasan." };
  }
  if (normalized === "RELEASED") return { decision: "RESCHEDULE_PROPOSAL_REQUIRED", allowed: false, proposalAllowed: true };
  return { decision: "RESCHEDULE_PROPOSAL_REQUIRED", allowed: false, proposalAllowed: true };
}

function simulateDisplacement(candidate, schedules = [], freezeFenceDate = null) {
  return schedules.map((schedule) => {
    const withinFreezeFence = freezeFenceDate ? new Date(schedule.scheduleDate) <= new Date(freezeFenceDate) : false;
    const governance = evaluateDisplacement({ status: schedule.status, withinFreezeFence });
    const oldCompletion = schedule.plannedEnd || schedule.scheduleDate;
    const newCompletion = candidate.proposedCompletion || oldCompletion;
    const deltaDays = Math.ceil((new Date(newCompletion) - new Date(oldCompletion)) / 86400000);
    return { scheduleNumber: schedule.scheduleNumber, affectedCustomer: schedule.customerCode || null, oldCompletion, newCompletion, deltaDays, affectedDeliveryRisk: deltaDays > 0 ? "AT_RISK" : "UNCHANGED", withinFreezeFence, ...governance };
  });
}

module.exports = { evaluateDisplacement, simulateDisplacement };
