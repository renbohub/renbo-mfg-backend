"use strict";

const { prisma } = require("../../index");
const { buildDemandRows, buildCapacityOverview, reviewDemand, planningAnchorMonth } = require("../../services/planning/demandPlanningService");
const { assessDemandFeasibility } = require("../../services/planning/demandFeasibilityService");
const { simulateDisplacement } = require("../../services/planning/dppDisplacementService");
const { buildDueDateRecoveryChecklist, buildTrialRecoveryChecklist, resolveAcceptedLateDate, validateRecoveryChecklist } = require("../../services/planning/dueDateRecoveryService");
const { deliveryTargetIdsFromMps, refreshMpsDeliveryFeasibility, isAcceptLateApplicable } = require("../../services/planning/mpsDeliveryFeasibilityService");

const text = (value) => String(value ?? "").trim() || null;
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const actor = (req) => req.user?.username || req.user?.email || "system";
const json = (value) => JSON.parse(JSON.stringify(value));

async function targetFeasibility(deliveryTargetId, planNumber = null) {
  const target = await prisma.demandDeliveryTarget.findFirst({ where: { id: deliveryTargetId, isDeleted: false, status: "ACTIVE" } });
  if (!target) throw Object.assign(new Error("Delivery target tidak ditemukan."), { statusCode: 404 });
  const demandRow = (await buildDemandRows(prisma, { customerCode: target.customerCode, partCode: target.partCode })).find((row) => row.id === target.id);
  const feasibility = await assessDemandFeasibility(prisma, {
    sourceType: demandRow?.actualSalesOrderQty > 0 ? "SALES_ORDER" : target.sourceType,
    sourceNumber: target.sourceNumber,
    deliveryTargetId: target.id,
    customerCode: target.customerCode,
    partCode: target.partCode,
    quantity: number(demandRow?.demandQty ?? target.qty),
    requestedDeliveryDate: demandRow?.effectiveTargetDate || target.targetDate,
    planNumber,
    leadTimeControls: demandRow?.feasibilityOptions?.leadTimeControls,
    supplierStrategy: demandRow?.feasibilityOptions?.supplierStrategy,
    supplierSelections: demandRow?.feasibilityOptions?.supplierSelections,
    vendorProcessAdjustments: demandRow?.feasibilityOptions?.vendorProcessAdjustments,
  });
  return { target, demandRow, feasibility, recommendation: buildDueDateRecoveryChecklist(feasibility) };
}

function mergeRecoveryChecklist(recommendation, submitted = []) {
  const submittedById = new Map((Array.isArray(submitted) ? submitted : []).map((item) => [String(item.id || ""), item]));
  return recommendation.actions.map((recommended) => {
    const supplied = submittedById.get(recommended.id) || {};
    return {
      ...recommended,
      selected: supplied.selected == null ? Boolean(recommended.required) : Boolean(supplied.selected),
      owner: text(supplied.owner) || null,
      targetDate: text(supplied.targetDate) || recommended.targetDate || null,
      notes: text(supplied.notes) || null,
      evidenceReference: text(supplied.evidenceReference) || null,
    };
  });
}

function acceptLateDecision(checklist = [], body = {}, requestedDeliveryDate = null) {
  const action = (Array.isArray(checklist) ? checklist : []).find((item) => item.id === "ACCEPT_LATE" && item.selected);
  if (!action) return { decisionType: "RECOVERY", originalDeliveryDate: requestedDeliveryDate, acceptedDeliveryDate: null, acceptLateReason: null };
  const acceptedDeliveryDate = text(body.acceptedDeliveryDate) || text(action.targetDate);
  return {
    decisionType: "ACCEPT_LATE",
    originalDeliveryDate: requestedDeliveryDate,
    acceptedDeliveryDate: acceptedDeliveryDate ? new Date(acceptedDeliveryDate) : null,
    acceptLateReason: text(body.acceptLateReason) || text(action.notes),
  };
}

function validateAcceptLate(plan) {
  if (plan.decisionType !== "ACCEPT_LATE") return [];
  const errors = [];
  if (!plan.acceptedDeliveryDate || Number.isNaN(new Date(plan.acceptedDeliveryDate).getTime())) errors.push("Accept Late: tanggal komitmen baru wajib diisi.");
  if (plan.acceptedDeliveryDate && new Date(plan.acceptedDeliveryDate) <= new Date(plan.requestedDeliveryDate)) errors.push("Accept Late: tanggal komitmen baru harus setelah tanggal delivery asli.");
  if (!text(plan.acceptLateReason) || text(plan.acceptLateReason).length < 10) errors.push("Accept Late: alasan minimal 10 karakter.");
  return errors;
}

function autoAcceptLateChecklist(recommendation = {}, reason, evidenceReference) {
  return (recommendation.actions || []).map((item) => ({
    ...item,
    selected: Boolean(item.required || item.id === "ACCEPT_LATE"),
    owner: text(item.ownerRole) || "PPIC",
    targetDate: item.id === "ACCEPT_LATE"
      ? recommendation.earliestFeasibleDeliveryDate
      : item.targetDate || recommendation.earliestFeasibleDeliveryDate,
    notes: item.id === "ACCEPT_LATE" ? reason : `Tindakan pendukung Auto Accept Late: ${reason}`,
    evidenceReference,
  }));
}

function deliveryTargetIdsFromRequirements(requirements = []) {
  return [...new Set(requirements.flatMap((row) => {
    const pegging = Array.isArray(row.customerPegging) ? row.customerPegging : [];
    return [row.deliveryTargetId, ...pegging.map((item) => item.deliveryTargetId)].filter(Boolean);
  }).map(String))];
}

function effectiveRecoveryPlan(plan, feasibility = {}, requestedDeliveryDate = null) {
  if (!plan || String(plan.decisionType || "").toUpperCase() !== "ACCEPT_LATE") return plan;
  const originalTargetDate = requestedDeliveryDate || feasibility.requestedDeliveryDate || plan.requestedDeliveryDate;
  const applicable = isAcceptLateApplicable({
    feasibilityStatus: feasibility.status || feasibility.feasibilityStatus,
    originalTargetDate,
    earliestFeasibleDeliveryDate: feasibility.earliestFeasibleDeliveryDate,
    acceptLateNewDate: plan.acceptedDeliveryDate,
  });
  if (applicable) return { ...plan, isApplicableToCurrentCalculation: true };
  return {
    ...plan,
    historicalStatus: plan.status,
    status: "REPLAN_REQUIRED",
    isApplicableToCurrentCalculation: false,
  };
}

const RECOVERY_FEEDBACK_STATUSES = new Set(["OPEN", "IN_PROGRESS", "WAITING", "DONE"]);
function recoveryFeedbackStatus(plan = {}, checklist = []) {
  const explicit = (Array.isArray(checklist) ? checklist : []).map((item) => String(item.feedbackStatus || "").toUpperCase()).find((value) => RECOVERY_FEEDBACK_STATUSES.has(value));
  if (explicit) return explicit;
  if (plan.status === "APPROVED") return "DONE";
  if (plan.status === "PENDING_APPROVAL") return "WAITING";
  if (["DRAFT", "REJECTED", "REPLAN_REQUIRED"].includes(plan.status)) return "IN_PROGRESS";
  return "OPEN";
}
function recoveryDepartment(action = {}, decisionType = "RECOVERY") {
  if (decisionType === "ACCEPT_LATE" || action.id === "ACCEPT_LATE") return "Sales";
  const key = `${action.id || ""} ${action.title || ""} ${action.ownerRole || ""}`.toUpperCase();
  if (/SUPPLIER|MATERIAL|PURCHAS|VENDOR|PO|PR/.test(key)) return "Purchasing";
  if (/CAPACITY|OVERTIME|LINE|PRODUCTION|ROUT/.test(key)) return "Production";
  if (/WAREHOUSE|STOCK|INVENTORY/.test(key)) return "Warehouse";
  if (/ENGINEER|MASTER DATA|BOM/.test(key)) return "Engineering";
  return "PPIC";
}

exports.listRecoveryPlans = async (req, res, next) => {
  try {
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || "")) ? String(req.query.month) : null;
    const start = month ? new Date(`${month}-01T00:00:00.000Z`) : null;
    const end = start ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)) : null;
    const plans = await prisma.dueDateRecoveryPlan.findMany({
      where: { isCurrentPlan: true, isDeleted: false, ...(start ? { requestedDeliveryDate: { gte: start, lt: end } } : {}) },
      orderBy: [{ updatedAt: "desc" }],
    });
    const targetIds = [...new Set(plans.map((plan) => plan.deliveryTargetId))];
    const [targets, sources] = targetIds.length ? await Promise.all([
      prisma.demandDeliveryTarget.findMany({ where: { id: { in: targetIds }, isDeleted: false } }),
      prisma.mPSDemandSource.findMany({
        where: { deliveryTargetId: { in: targetIds } },
        select: { deliveryTargetId: true, mpsDetail: { select: { mpsNumber: true } } },
        orderBy: { updatedAt: "desc" },
      }),
    ]) : [[], []];
    const targetById = new Map(targets.map((target) => [target.id, target]));
    const mpsByTarget = new Map();
    for (const source of sources) if (!mpsByTarget.has(source.deliveryTargetId)) mpsByTarget.set(source.deliveryTargetId, source.mpsDetail?.mpsNumber || null);
    const query = String(req.query.q || "").trim().toLowerCase();
    const requestedFeedback = String(req.query.feedbackStatus || "").toUpperCase();
    const items = plans.map((plan) => {
      const target = targetById.get(plan.deliveryTargetId) || {};
      const checklist = Array.isArray(plan.checklist) ? plan.checklist : [];
      const selectedActions = checklist.filter((item) => item.selected);
      const primaryAction = selectedActions.find((item) => !item.required && item.id !== "ACCEPT_LATE") || selectedActions.find((item) => item.id === "ACCEPT_LATE") || selectedActions[0] || {};
      const feedbackStatus = recoveryFeedbackStatus(plan, selectedActions);
      return {
        id: plan.id, deliveryTargetId: plan.deliveryTargetId, revision: plan.revision, planStatus: plan.status,
        feedbackStatus, decisionType: plan.decisionType, recovery: plan.decisionType === "ACCEPT_LATE" ? "Change Delivery Target" : primaryAction.title || "Recovery Action",
        dept: recoveryDepartment(primaryAction, plan.decisionType), owner: primaryAction.owner || primaryAction.ownerRole || null, targetDate: primaryAction.targetDate || plan.acceptedDeliveryDate || plan.earliestFeasibleDelivery,
        notes: primaryAction.notes || plan.notes, evidenceReference: primaryAction.evidenceReference || null,
        requestedDeliveryDate: plan.requestedDeliveryDate, earliestFeasibleDelivery: plan.earliestFeasibleDelivery, recoveryGapDays: plan.recoveryGapDays,
        criticalConstraint: plan.criticalConstraint, sourceType: target.sourceType || null, sourceNumber: target.sourceNumber || null,
        customerCode: target.customerCode || null, partCode: target.partCode || null, qty: target.qty ?? null, uomCode: target.uomCode || null,
        mpsNumber: mpsByTarget.get(plan.deliveryTargetId) || null, updatedAt: plan.updatedAt,
      };
    }).filter((item) => (!requestedFeedback || item.feedbackStatus === requestedFeedback) && (!query || [item.mpsNumber, item.sourceNumber, item.partCode, item.customerCode, item.recovery, item.dept].some((value) => String(value || "").toLowerCase().includes(query))));
    const counts = Object.fromEntries([...RECOVERY_FEEDBACK_STATUSES].map((status) => [status, items.filter((item) => item.feedbackStatus === status).length]));
    res.json({ items, total: items.length, month, counts });
  } catch (error) { next(error); }
};

exports.updateRecoveryFeedbackStatus = async (req, res, next) => {
  try {
    const feedbackStatus = String(req.body.feedbackStatus || "").toUpperCase();
    if (!RECOVERY_FEEDBACK_STATUSES.has(feedbackStatus)) return res.status(400).json({ message: "Feedback Status harus Open, In Progress, Waiting, atau Done." });
    const plan = await prisma.dueDateRecoveryPlan.findFirst({ where: { id: req.params.planId, isCurrentPlan: true, isDeleted: false } });
    if (!plan) return res.status(404).json({ message: "Recovery Plan tidak ditemukan." });
    const checklist = (Array.isArray(plan.checklist) ? plan.checklist : []).map((item) => item.selected ? { ...item, feedbackStatus } : item);
    const updated = await prisma.dueDateRecoveryPlan.update({ where: { id: plan.id }, data: { checklist: json(checklist), updatedBy: actor(req) } });
    res.json({ id: updated.id, feedbackStatus, updatedAt: updated.updatedAt });
  } catch (error) { next(error); }
};

async function displacementSimulation(deliveryTargetId, proposedCompletion = null) {
  const target = await prisma.demandDeliveryTarget.findFirst({ where: { id: deliveryTargetId, isDeleted: false } });
  if (!target) throw Object.assign(new Error("Delivery target tidak ditemukan."), { statusCode: 404 });
  const plans = await prisma.monthlyProductionPlan.findMany({ where: { isDeleted: false, status: { in: ["Draft", "Confirmed", "Released"] } }, select: { id: true, planNumber: true, freezeFenceDays: true, dailyProductionSchedules: { where: { isDeleted: false, status: { in: ["Draft", "Released", "In Progress", "Completed"] } }, select: { scheduleNumber: true, scheduleDate: true, plannedEndTime: true, status: true, customerCode: true, customerTargetDate: true, priorityScore: true } } } });
  const schedules = plans.flatMap((plan) => plan.dailyProductionSchedules.map((schedule) => ({ ...schedule, planNumber: plan.planNumber, plannedEnd: schedule.scheduleDate })));
  const maxFenceDays = plans.reduce((max, plan) => Math.max(max, number(plan.freezeFenceDays)), 0);
  const freezeFenceDate = new Date(); freezeFenceDate.setUTCDate(freezeFenceDate.getUTCDate() + maxFenceDays);
  const affected = simulateDisplacement({ proposedCompletion: proposedCompletion || target.targetDate }, schedules, freezeFenceDate).filter((row) => row.affectedCustomer !== target.customerCode || row.deltaDays !== 0);
  return { target, affected, requiresApproval: affected.some((row) => ["OVERRIDE_APPROVAL_REQUIRED", "RESCHEDULE_PROPOSAL_REQUIRED"].includes(row.decision)) };
}

exports.list = async (req, res, next) => {
  try {
    const demandRows = await buildDemandRows(prisma, { startDate: text(req.query.startDate), endDate: text(req.query.endDate), customerCode: text(req.query.customerCode), partCode: text(req.query.partCode), status: text(req.query.status) });
    const targetIds=demandRows.map((row)=>row.id);const [proposals,recoveryPlans]=demandRows.length?await Promise.all([prisma.dPPDisplacementProposal.findMany({where:{deliveryTargetId:{in:targetIds},isDeleted:false},orderBy:{requestedAt:"desc"}}),prisma.dueDateRecoveryPlan.findMany({where:{deliveryTargetId:{in:targetIds},isCurrentPlan:true,isDeleted:false},select:{id:true,deliveryTargetId:true,revision:true,status:true,decisionType:true,requestedDeliveryDate:true,acceptedDeliveryDate:true,recoveryGapDays:true,approvedBy:true,approvedAt:true}})]):[[],[]];const proposalByTarget=new Map();for(const proposal of proposals)if(!proposalByTarget.has(proposal.deliveryTargetId))proposalByTarget.set(proposal.deliveryTargetId,proposal);const recoveryByTarget=new Map(recoveryPlans.map((plan)=>[plan.deliveryTargetId,plan]));
    const items=demandRows.map((row)=>{const proposal=proposalByTarget.get(row.id),storedRecovery=recoveryByTarget.get(row.id),recovery=effectiveRecoveryPlan(storedRecovery,{status:row.feasibilityStatus,earliestFeasibleDeliveryDate:row.earliestFeasibleDeliveryDate},row.effectiveTargetDate||row.targetDate);return{...row,displacementProposalId:proposal?.id||null,displacementProposalStatus:proposal?.status||null,dueDateRecoveryPlanId:recovery?.id||null,dueDateRecoveryRevision:recovery?.revision||null,dueDateRecoveryStatus:recovery?.status||null,dueDateRecoveryHistoricalStatus:recovery?.historicalStatus||null,dueDateRecoveryApplicable:recovery?.isApplicableToCurrentCalculation??null,dueDateRecoveryGapDays:recovery?.recoveryGapDays||0,dueDateRecoveryApprovedBy:recovery?.approvedBy||null,dueDateRecoveryApprovedAt:recovery?.approvedAt||null}});
    const priorityClass = text(req.query.priorityClass);
    const feasibilityStatus = text(req.query.feasibilityStatus);
    const filtered = items.filter((row) => (!priorityClass || row.priorityClass === priorityClass) && (!feasibilityStatus || row.feasibilityStatus === feasibilityStatus));
    const capacityMonths = await buildCapacityOverview(prisma, demandRows);
    res.json({ items: filtered, total: filtered.length, planningAnchorMonth: text(req.query.planningAnchorMonth) || planningAnchorMonth(new Date()), capacityMonths, summary: { forecastQty: filtered.reduce((sum, row) => sum + number(row.forecastQty), 0), actualSalesOrderQty: filtered.reduce((sum, row) => sum + number(row.actualSalesOrderQty), 0), draftSalesOrderQty: filtered.reduce((sum, row) => sum + number(row.draftSalesOrderQty), 0), draftSalesOrderCount: filtered.reduce((sum, row) => sum + (row.draftSalesOrders || []).length, 0), demandQty: filtered.reduce((sum, row) => sum + number(row.demandQty), 0), outstandingQty: filtered.reduce((sum, row) => sum + number(row.outstandingQty), 0), critical: filtered.filter((row) => row.priorityClass === "P0").length, atRisk: filtered.filter((row) => ["AT_RISK", "NOT_FEASIBLE"].includes(row.feasibilityStatus)).length, unreviewed: filtered.filter((row) => row.planningStatus === "UNREVIEWED").length } });
  } catch (error) { next(error); }
};

exports.feasibility = async (req, res, next) => {
  try {
    const deliveryTargetId = text(req.body.deliveryTargetId);
    const target = deliveryTargetId ? await prisma.demandDeliveryTarget.findFirst({ where: { id: deliveryTargetId, isDeleted: false, status: "ACTIVE" } }) : null;
    const demandRow = target ? (await buildDemandRows(prisma, { customerCode: target.customerCode, partCode: target.partCode })).find((row) => row.id === target.id) : null;
    const capacityShiftsPerDay = number(req.body.capacityShiftsPerDay) || undefined;
    const feasibilityOptions = { leadTimeControls: req.body.leadTimeControls, supplierStrategy: text(req.body.supplierStrategy), supplierSelections: req.body.supplierSelections, vendorProcessAdjustments: req.body.vendorProcessAdjustments };
    const input = target ? { sourceType: demandRow?.actualSalesOrderQty > 0 ? "SALES_ORDER" : target.sourceType, sourceNumber: target.sourceNumber, deliveryTargetId: target.id, customerCode: target.customerCode, partCode: target.partCode, quantity: number(demandRow?.demandQty ?? target.qty), requestedDeliveryDate: demandRow?.effectiveTargetDate || target.targetDate, planNumber: text(req.body.planNumber), capacityShiftsPerDay, ...feasibilityOptions } : { sourceType: text(req.body.sourceType), sourceNumber: text(req.body.sourceNumber), customerCode: text(req.body.customerCode), partCode: text(req.body.partCode), quantity: number(req.body.quantity), requestedDeliveryDate: req.body.requestedDeliveryDate, planNumber: text(req.body.planNumber), capacityShiftsPerDay, ...feasibilityOptions };
    if (!input.partCode || !input.requestedDeliveryDate || input.quantity <= 0) return res.status(400).json({ message: "Part, quantity, dan requested delivery date wajib diisi." });
    res.json(await assessDemandFeasibility(prisma, input));
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.review = async (req, res, next) => {
  try {
    const result = await reviewDemand(prisma, req.params.deliveryTargetId, req.body || {}, req.user?.username || req.user?.email || "system");
    res.json(result);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ code: error.code, message: error.message }); next(error); }
};

exports.getRecoveryPlan = async (req, res, next) => {
  try {
    const context = await targetFeasibility(req.params.deliveryTargetId, text(req.query.planNumber));
    const storedPlan = await prisma.dueDateRecoveryPlan.findFirst({ where: { deliveryTargetId: context.target.id, isCurrentPlan: true, isDeleted: false }, orderBy: { revision: "desc" } });
    const plan = effectiveRecoveryPlan(storedPlan, context.feasibility, context.target.targetDate);
    res.json({ target: { id: context.target.id, sourceType: context.target.sourceType, sourceNumber: context.target.sourceNumber, customerCode: context.target.customerCode, partCode: context.target.partCode, targetDeliveryDate: context.target.targetDate }, feasibility: context.feasibility, recommendation: context.recommendation, plan });
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.saveRecoveryPlan = async (req, res, next) => {
  try {
    const context = await targetFeasibility(req.params.deliveryTargetId, text(req.body.planNumber));
    const checklist = mergeRecoveryChecklist(context.recommendation, req.body.checklist);
    const acceptLate = acceptLateDecision(checklist, req.body, new Date(context.recommendation.requestedDeliveryDate));
    const current = await prisma.dueDateRecoveryPlan.findFirst({ where: { deliveryTargetId: context.target.id, isCurrentPlan: true, isDeleted: false }, orderBy: { revision: "desc" } });
    if (current?.status === "PENDING_APPROVAL") return res.status(409).json({ message: "Recovery Plan sedang menunggu approval PPIC dan tidak dapat diedit." });
    const data = {
      requestedDeliveryDate: new Date(context.recommendation.requestedDeliveryDate),
      fgRequiredDate: context.recommendation.fgRequiredDate ? new Date(context.recommendation.fgRequiredDate) : null,
      earliestFeasibleFgDate: context.recommendation.earliestFeasibleFgDate ? new Date(context.recommendation.earliestFeasibleFgDate) : null,
      earliestFeasibleDelivery: context.recommendation.earliestFeasibleDeliveryDate ? new Date(context.recommendation.earliestFeasibleDeliveryDate) : null,
      recoveryGapDays: context.recommendation.recoveryGapDays,
      criticalConstraint: context.recommendation.criticalConstraint,
      feasibilitySnapshot: json(context.feasibility),
      checklist: json(checklist),
      notes: text(req.body.notes),
      status: "DRAFT",
      updatedBy: actor(req),
      submittedBy: null, submittedAt: null, approvedBy: null, approvedAt: null, approvalReason: null, rejectedBy: null, rejectedAt: null, rejectionReason: null,
      ...acceptLate,
    };
    const plan = await prisma.$transaction(async (tx) => {
      if (current && ["DRAFT", "REJECTED", "REPLAN_REQUIRED"].includes(current.status)) return tx.dueDateRecoveryPlan.update({ where: { id: current.id }, data });
      if (current) await tx.dueDateRecoveryPlan.update({ where: { id: current.id }, data: { isCurrentPlan: false, updatedBy: actor(req) } });
      return tx.dueDateRecoveryPlan.create({ data: { ...data, deliveryTargetId: context.target.id, revision: number(current?.revision) + 1 || 1, isCurrentPlan: true, createdBy: actor(req) } });
    });
    res.json(plan);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.submitRecoveryPlan = async (req, res, next) => {
  try {
    const plan = await prisma.dueDateRecoveryPlan.findFirst({ where: { id: req.params.planId, isCurrentPlan: true, isDeleted: false } });
    if (!plan) return res.status(404).json({ message: "Recovery Plan tidak ditemukan." });
    if (!['DRAFT','REJECTED','REPLAN_REQUIRED'].includes(plan.status)) return res.status(409).json({ message: `Recovery Plan berstatus ${plan.status} tidak dapat diajukan.` });
    const errors = [...validateRecoveryChecklist(plan.checklist, plan.requestedDeliveryDate), ...validateAcceptLate(plan)];
    if (errors.length) return res.status(400).json({ message: "Checklist belum siap diajukan.", errors });
    res.json(await prisma.dueDateRecoveryPlan.update({ where: { id: plan.id }, data: { status: "PENDING_APPROVAL", submittedBy: actor(req), submittedAt: new Date(), updatedBy: actor(req) } }));
  } catch (error) { next(error); }
};

exports.approveRecoveryPlan = async (req, res, next) => {
  try {
    const reason = text(req.body.reason);
    if (!reason || reason.length < 10) return res.status(400).json({ message: "Catatan approval minimal 10 karakter." });
    if (req.body.acknowledgedRisk !== true) return res.status(400).json({ message: "PPIC wajib menyatakan telah memeriksa PIC, target, dan bukti keberhasilan setiap tindakan." });
    const plan = await prisma.dueDateRecoveryPlan.findFirst({ where: { id: req.params.planId, isCurrentPlan: true, isDeleted: false } });
    if (!plan) return res.status(404).json({ message: "Recovery Plan tidak ditemukan." });
    if (plan.status !== "PENDING_APPROVAL") return res.status(409).json({ message: `Recovery Plan berstatus ${plan.status} tidak dapat di-approve.` });
    const target = await prisma.demandDeliveryTarget.findFirst({ where: { id: plan.deliveryTargetId, isDeleted: false, status: "ACTIVE" } });
    if (!target || target.updatedAt > plan.updatedAt || target.targetDate.getTime() !== plan.requestedDeliveryDate.getTime()) return res.status(409).json({ code: "RECOVERY_RECHECK_REQUIRED", message: "Delivery target berubah setelah checklist dibuat. Simpan ulang Recovery Plan sebelum approval." });
    const errors = [...validateRecoveryChecklist(plan.checklist, plan.requestedDeliveryDate), ...validateAcceptLate(plan)];
    if (errors.length) return res.status(400).json({ message: "Checklist tidak valid untuk approval.", errors });
    res.json(await prisma.dueDateRecoveryPlan.update({ where: { id: plan.id }, data: { status: "APPROVED", approvedBy: actor(req), approvedAt: new Date(), approvalReason: reason, updatedBy: actor(req) } }));
  } catch (error) { next(error); }
};

exports.bulkTrialRecovery = async (req, res, next) => {
  try {
    const mpsNumber = text(req.body.mpsNumber);
    const requestedIds = [...new Set((Array.isArray(req.body.deliveryTargetIds) ? req.body.deliveryTargetIds : [])
      .map((value) => String(value || "").trim()).filter(Boolean))];
    if (!mpsNumber) return res.status(400).json({ message: "Nomor MPS wajib diisi." });
    if (!requestedIds.length) return res.status(400).json({ message: "Tidak ada delivery infeasible yang dapat direcovery." });
    if (requestedIds.length > 100) return res.status(400).json({ message: "Maksimal 100 delivery target per recovery trial." });

    const mps = await prisma.mPS.findFirst({
      where: { mpsNumber, isDeleted: false },
      include: { details: { where: { isDeleted: false }, include: { demandSources: true } } },
    });
    if (!mps) return res.status(404).json({ message: "MPS tidak ditemukan." });
    const allowedIds = new Set(deliveryTargetIdsFromMps(mps));
    const actorName = actor(req);
    const now = new Date();
    const processed = [];
    const skipped = [];
    const failed = [];

    for (const deliveryTargetId of requestedIds) {
      if (!allowedIds.has(deliveryTargetId)) {
        skipped.push({ deliveryTargetId, reason: "TARGET_NOT_LINKED_TO_MPS" });
        continue;
      }
      try {
        const context = await targetFeasibility(deliveryTargetId);
        if (!["NOT_FEASIBLE", "MASTER_DATA_INCOMPLETE"].includes(String(context.feasibility.status || "").toUpperCase())) {
          skipped.push({ deliveryTargetId, reason: "DELIVERY_NOT_INFEASIBLE" });
          continue;
        }
        const current = await prisma.dueDateRecoveryPlan.findFirst({
          where: { deliveryTargetId, isCurrentPlan: true, isDeleted: false },
          orderBy: { revision: "desc" },
        });
        if (["PENDING_APPROVAL", "APPROVED"].includes(current?.status)) {
          skipped.push({ deliveryTargetId, reason: `RECOVERY_${current.status}`, planId: current.id });
          continue;
        }
        const checklist = buildTrialRecoveryChecklist(context.recommendation, {
          owner: actorName,
          notes: `Trial recovery satu tombol untuk ${mpsNumber}.`,
          evidenceReference: `MPS Workbench ${mpsNumber}`,
        });
        const requestedDeliveryDate = new Date(context.recommendation.requestedDeliveryDate);
        const errors = validateRecoveryChecklist(checklist, requestedDeliveryDate);
        if (errors.length) {
          failed.push({ deliveryTargetId, reason: "VALIDATION_FAILED", errors });
          continue;
        }
        const data = {
          requestedDeliveryDate,
          fgRequiredDate: context.recommendation.fgRequiredDate ? new Date(context.recommendation.fgRequiredDate) : null,
          earliestFeasibleFgDate: context.recommendation.earliestFeasibleFgDate ? new Date(context.recommendation.earliestFeasibleFgDate) : null,
          earliestFeasibleDelivery: context.recommendation.earliestFeasibleDeliveryDate ? new Date(context.recommendation.earliestFeasibleDeliveryDate) : null,
          recoveryGapDays: context.recommendation.recoveryGapDays,
          criticalConstraint: context.recommendation.criticalConstraint,
          feasibilitySnapshot: json(context.feasibility),
          checklist: json(checklist),
          notes: `Trial recovery satu tombol untuk ${mpsNumber}.`,
          status: "PENDING_APPROVAL",
          submittedBy: actorName,
          submittedAt: now,
          approvedBy: null,
          approvedAt: null,
          approvalReason: null,
          decisionType: "RECOVERY",
          originalDeliveryDate: requestedDeliveryDate,
          acceptedDeliveryDate: null,
          acceptLateReason: null,
          rejectedBy: null,
          rejectedAt: null,
          rejectionReason: null,
          updatedBy: actorName,
        };
        const plan = await prisma.$transaction(async (tx) => {
          if (current && ["DRAFT", "REJECTED", "REPLAN_REQUIRED"].includes(current.status)) {
            return tx.dueDateRecoveryPlan.update({ where: { id: current.id }, data });
          }
          if (current) await tx.dueDateRecoveryPlan.update({ where: { id: current.id }, data: { isCurrentPlan: false, updatedBy: actorName } });
          return tx.dueDateRecoveryPlan.create({ data: { ...data, deliveryTargetId, revision: number(current?.revision) + 1 || 1, isCurrentPlan: true, createdBy: actorName } });
        });
        processed.push({ deliveryTargetId, planId: plan.id, status: plan.status });
      } catch (error) {
        failed.push({ deliveryTargetId, reason: "PROCESSING_FAILED", message: error.message });
      }
    }
    if (processed.length) await refreshMpsDeliveryFeasibility(prisma, mpsNumber);
    return res.json({ mpsNumber, requested: requestedIds.length, processed, skipped, failed });
  } catch (error) { return next(error); }
};

exports.bulkAcceptLate = async (req, res, next) => {
  try {
    const runNumber = text(req.body.runNumber);
    const reason = text(req.body.reason);
    const requestedIds = [...new Set((Array.isArray(req.body.deliveryTargetIds) ? req.body.deliveryTargetIds : []).map((value) => String(value || "").trim()).filter(Boolean))];
    if (!runNumber) return res.status(400).json({ message: "MRP Run wajib diisi." });
    if (!reason || reason.length < 10) return res.status(400).json({ message: "Alasan Auto Accept Late minimal 10 karakter." });
    if (req.body.acknowledgedRisk !== true) return res.status(400).json({ message: "Risiko perubahan komitmen delivery wajib dikonfirmasi." });
    if (!requestedIds.length) return res.status(400).json({ message: "Tidak ada delivery target terlambat yang dipilih." });
    if (requestedIds.length > 100) return res.status(400).json({ message: "Maksimal 100 delivery target per proses massal." });

    const run = await prisma.mRPRun.findFirst({ where: { runNumber, isDeleted: false }, select: { runNumber: true } });
    if (!run) return res.status(404).json({ message: "MRP Run tidak ditemukan." });
    const requirements = await prisma.mRPRequirement.findMany({
      where: { runNumber, isDeleted: false },
      select: { deliveryTargetId: true, customerPegging: true },
    });
    const linkedTargetIds = new Set(deliveryTargetIdsFromRequirements(requirements));
    const actorName = actor(req);
    const processed = [];
    const skipped = [];
    const failed = [];

    for (const deliveryTargetId of requestedIds) {
      if (!linkedTargetIds.has(deliveryTargetId)) {
        skipped.push({ deliveryTargetId, reason: "TARGET_NOT_LINKED_TO_MRP" });
        continue;
      }
      try {
        const context = await targetFeasibility(deliveryTargetId);
        if (String(context.target.sourceType || "").toUpperCase() === "FORECAST" && number(context.demandRow?.actualSalesOrderQty) > 0) {
          skipped.push({ deliveryTargetId, reason: "FORECAST_REPLACED_BY_SO" });
          continue;
        }
        const requestedDeliveryDate = new Date(context.recommendation.requestedDeliveryDate);
        const calculatedFeasibleDate = new Date(context.recommendation.earliestFeasibleDeliveryDate);
        if (String(context.feasibility.status || "").toUpperCase() !== "NOT_FEASIBLE") {
          skipped.push({ deliveryTargetId, reason: String(context.feasibility.status || "DELIVERY_NOT_INFEASIBLE").toUpperCase() });
          continue;
        }
        const acceptedDeliveryDate = resolveAcceptedLateDate(requestedDeliveryDate, calculatedFeasibleDate);
        if (!acceptedDeliveryDate) {
          skipped.push({ deliveryTargetId, reason: "DELIVERY_NOT_LATE" });
          continue;
        }
        const current = await prisma.dueDateRecoveryPlan.findFirst({ where: { deliveryTargetId, isCurrentPlan: true, isDeleted: false }, orderBy: { revision: "desc" } });
        if (current?.status === "APPROVED" && current?.decisionType === "ACCEPT_LATE") {
          skipped.push({ deliveryTargetId, reason: "ALREADY_ACCEPTED_LATE", planId: current.id });
          continue;
        }
        const now = new Date();
        if (current?.status === "PENDING_APPROVAL" && current.decisionType === "ACCEPT_LATE") {
          const targetChanged = context.target.updatedAt > current.updatedAt
            || context.target.targetDate.getTime() !== current.requestedDeliveryDate.getTime();
          const currentErrors = [
            ...validateRecoveryChecklist(current.checklist, current.requestedDeliveryDate),
            ...validateAcceptLate(current),
          ];
          if (targetChanged || currentErrors.length) {
            failed.push({ deliveryTargetId, reason: targetChanged ? "RECOVERY_RECHECK_REQUIRED" : "VALIDATION_FAILED", errors: currentErrors });
            continue;
          }
          const approved = await prisma.dueDateRecoveryPlan.update({
            where: { id: current.id },
            data: { status: "APPROVED", approvedBy: actorName, approvedAt: now, approvalReason: reason, updatedBy: actorName },
          });
          processed.push({ deliveryTargetId, planId: approved.id, acceptedDeliveryDate: approved.acceptedDeliveryDate, approvedPending: true });
          continue;
        }
        const evidenceReference = `Auto Accept Late ${runNumber}`;
        const acceptLateRecommendation = { ...context.recommendation, earliestFeasibleDeliveryDate: acceptedDeliveryDate.toISOString() };
        const checklist = autoAcceptLateChecklist(acceptLateRecommendation, reason, evidenceReference);
        const validationErrors = [
          ...validateRecoveryChecklist(checklist, requestedDeliveryDate),
          ...validateAcceptLate({ decisionType: "ACCEPT_LATE", acceptedDeliveryDate, requestedDeliveryDate, acceptLateReason: reason }),
        ];
        if (validationErrors.length) {
          failed.push({ deliveryTargetId, reason: "VALIDATION_FAILED", errors: validationErrors });
          continue;
        }
        const data = {
          requestedDeliveryDate,
          fgRequiredDate: context.recommendation.fgRequiredDate ? new Date(context.recommendation.fgRequiredDate) : null,
          earliestFeasibleFgDate: context.recommendation.earliestFeasibleFgDate ? new Date(context.recommendation.earliestFeasibleFgDate) : null,
          earliestFeasibleDelivery: acceptedDeliveryDate,
          recoveryGapDays: context.recommendation.recoveryGapDays,
          criticalConstraint: context.recommendation.criticalConstraint,
          feasibilitySnapshot: json(context.feasibility),
          checklist: json(checklist),
          notes: reason,
          status: "APPROVED",
          submittedBy: actorName,
          submittedAt: now,
          approvedBy: actorName,
          approvedAt: now,
          approvalReason: reason,
          decisionType: "ACCEPT_LATE",
          originalDeliveryDate: requestedDeliveryDate,
          acceptedDeliveryDate,
          acceptLateReason: reason,
          rejectedBy: null,
          rejectedAt: null,
          rejectionReason: null,
          updatedBy: actorName,
        };
        const plan = await prisma.$transaction(async (tx) => {
          if (current && ["DRAFT", "REJECTED", "REPLAN_REQUIRED"].includes(current.status)) {
            return tx.dueDateRecoveryPlan.update({ where: { id: current.id }, data });
          }
          if (current) await tx.dueDateRecoveryPlan.update({ where: { id: current.id }, data: { isCurrentPlan: false, updatedBy: actorName } });
          return tx.dueDateRecoveryPlan.create({ data: { ...data, deliveryTargetId, revision: number(current?.revision) + 1 || 1, isCurrentPlan: true, createdBy: actorName } });
        });
        processed.push({ deliveryTargetId, planId: plan.id, acceptedDeliveryDate: plan.acceptedDeliveryDate });
      } catch (error) {
        failed.push({ deliveryTargetId, reason: "PROCESSING_FAILED", message: error.message });
      }
    }
    res.json({ runNumber, requested: requestedIds.length, processed, skipped, failed });
  } catch (error) { next(error); }
};

exports.rejectRecoveryPlan = async (req, res, next) => {
  try {
    const reason = text(req.body.reason);
    if (!reason || reason.length < 10) return res.status(400).json({ message: "Alasan reject minimal 10 karakter." });
    const plan = await prisma.dueDateRecoveryPlan.findFirst({ where: { id: req.params.planId, isCurrentPlan: true, isDeleted: false } });
    if (!plan) return res.status(404).json({ message: "Recovery Plan tidak ditemukan." });
    if (plan.status !== "PENDING_APPROVAL") return res.status(409).json({ message: `Recovery Plan berstatus ${plan.status} tidak dapat di-reject.` });
    res.json(await prisma.dueDateRecoveryPlan.update({ where: { id: plan.id }, data: { status: "REJECTED", rejectedBy: actor(req), rejectedAt: new Date(), rejectionReason: reason, updatedBy: actor(req) } }));
  } catch (error) { next(error); }
};

exports.simulateImpact = async (req, res, next) => {
  try {
    const { target, affected, requiresApproval } = await displacementSimulation(req.params.deliveryTargetId, req.body?.proposedCompletion);
    res.json({ deliveryTargetId: target.id, sourceType: target.sourceType, sourceNumber: target.sourceNumber, customerCode: target.customerCode, partCode: target.partCode, targetDeliveryDate: target.targetDate, simulationOnly: true, committed: false, affectedSchedules: affected, requiresApproval });
  } catch (error) { next(error); }
};

exports.createDisplacementProposal = async (req, res, next) => {
  try {
    const reason = text(req.body.reason); if (!reason || reason.length < 10) return res.status(400).json({ message: "Alasan displacement proposal minimal 10 karakter." });
    const { target, affected, requiresApproval } = await displacementSimulation(req.params.deliveryTargetId, req.body.proposedCompletion);
    if (affected.some((row) => row.decision === "IMMUTABLE")) return res.status(409).json({ code: "DPP_IMMUTABLE", message: "Proposal menyentuh DPP In Progress/Completed dan tidak dapat diajukan.", affectedSchedules: affected });
    const proposal = await prisma.dPPDisplacementProposal.create({ data: { deliveryTargetId: target.id, proposedCompletion: new Date(req.body.proposedCompletion || target.targetDate), affectedSchedules: affected, requiresApproval, status: requiresApproval ? "PENDING_APPROVAL" : "APPROVED", reason, requestedBy: req.user?.username || req.user?.email || "system", ...(!requiresApproval ? { approvedBy: "SYSTEM_GOVERNANCE", approvedAt: new Date(), approvalReason: "Hanya Draft DPP yang terdampak." } : {}) } });
    res.status(201).json(proposal);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.approveDisplacementProposal = async (req, res, next) => {
  try {
    const reason = text(req.body.reason); if (!reason || reason.length < 10) return res.status(400).json({ message: "Alasan approval minimal 10 karakter." });
    const proposal = await prisma.dPPDisplacementProposal.findFirst({ where: { id: req.params.proposalId, isDeleted: false } });
    if (!proposal) return res.status(404).json({ message: "Displacement proposal tidak ditemukan." });
    if (proposal.status !== "PENDING_APPROVAL") return res.status(409).json({ message: `Proposal berstatus ${proposal.status} tidak dapat di-approve.` });
    res.json(await prisma.dPPDisplacementProposal.update({ where: { id: proposal.id }, data: { status: "APPROVED", approvedBy: req.user?.username || req.user?.email || "system", approvedAt: new Date(), approvalReason: reason } }));
  } catch (error) { next(error); }
};
