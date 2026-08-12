"use strict";

const { prisma } = require("../../index");
const { buildDemandRows, buildCapacityOverview, reviewDemand, planningAnchorMonth } = require("../../services/planning/demandPlanningService");
const { assessDemandFeasibility } = require("../../services/planning/demandFeasibilityService");
const { simulateDisplacement } = require("../../services/planning/dppDisplacementService");
const { buildDueDateRecoveryChecklist, validateRecoveryChecklist } = require("../../services/planning/dueDateRecoveryService");

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
    const targetIds=demandRows.map((row)=>row.id);const [proposals,recoveryPlans]=demandRows.length?await Promise.all([prisma.dPPDisplacementProposal.findMany({where:{deliveryTargetId:{in:targetIds},isDeleted:false},orderBy:{requestedAt:"desc"}}),prisma.dueDateRecoveryPlan.findMany({where:{deliveryTargetId:{in:targetIds},isCurrentPlan:true,isDeleted:false},select:{id:true,deliveryTargetId:true,revision:true,status:true,recoveryGapDays:true,approvedBy:true,approvedAt:true}})]):[[],[]];const proposalByTarget=new Map();for(const proposal of proposals)if(!proposalByTarget.has(proposal.deliveryTargetId))proposalByTarget.set(proposal.deliveryTargetId,proposal);const recoveryByTarget=new Map(recoveryPlans.map((plan)=>[plan.deliveryTargetId,plan]));
    const items=demandRows.map((row)=>{const proposal=proposalByTarget.get(row.id),recovery=recoveryByTarget.get(row.id);return{...row,displacementProposalId:proposal?.id||null,displacementProposalStatus:proposal?.status||null,dueDateRecoveryPlanId:recovery?.id||null,dueDateRecoveryRevision:recovery?.revision||null,dueDateRecoveryStatus:recovery?.status||null,dueDateRecoveryGapDays:recovery?.recoveryGapDays||0,dueDateRecoveryApprovedBy:recovery?.approvedBy||null,dueDateRecoveryApprovedAt:recovery?.approvedAt||null}});
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
    const plan = await prisma.dueDateRecoveryPlan.findFirst({ where: { deliveryTargetId: context.target.id, isCurrentPlan: true, isDeleted: false }, orderBy: { revision: "desc" } });
    res.json({ target: { id: context.target.id, sourceType: context.target.sourceType, sourceNumber: context.target.sourceNumber, customerCode: context.target.customerCode, partCode: context.target.partCode, targetDeliveryDate: context.target.targetDate }, feasibility: context.feasibility, recommendation: context.recommendation, plan });
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.saveRecoveryPlan = async (req, res, next) => {
  try {
    const context = await targetFeasibility(req.params.deliveryTargetId, text(req.body.planNumber));
    const checklist = mergeRecoveryChecklist(context.recommendation, req.body.checklist);
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
    const errors = validateRecoveryChecklist(plan.checklist, plan.requestedDeliveryDate);
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
    const errors = validateRecoveryChecklist(plan.checklist, plan.requestedDeliveryDate);
    if (errors.length) return res.status(400).json({ message: "Checklist tidak valid untuk approval.", errors });
    res.json(await prisma.dueDateRecoveryPlan.update({ where: { id: plan.id }, data: { status: "APPROVED", approvedBy: actor(req), approvedAt: new Date(), approvalReason: reason, updatedBy: actor(req) } }));
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
