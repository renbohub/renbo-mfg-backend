"use strict";

const router = require("express").Router();
const ctrl = require("../../controllers/planning/DemandPlanningController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.get("/", authorize("mps", "read"), ctrl.list);
router.post("/feasibility", authorize("mps", "read"), ctrl.feasibility);
router.get("/:deliveryTargetId/recovery-plan", authorize("mps", "read"), ctrl.getRecoveryPlan);
router.put("/:deliveryTargetId/recovery-plan", authorize("mps", "update"), logger("demandPlanning", "save-due-date-recovery"), ctrl.saveRecoveryPlan);
router.post("/recovery-plans/:planId/submit", authorize("mps", "update"), logger("demandPlanning", "submit-due-date-recovery"), ctrl.submitRecoveryPlan);
router.patch("/recovery-plans/:planId/approve", authorize("mps", "approve"), logger("demandPlanning", "approve-due-date-recovery"), ctrl.approveRecoveryPlan);
router.patch("/recovery-plans/:planId/reject", authorize("mps", "approve"), logger("demandPlanning", "reject-due-date-recovery"), ctrl.rejectRecoveryPlan);
router.patch("/:deliveryTargetId/review", authorize("mps", "update"), logger("demandPlanning", "review"), ctrl.review);
router.post("/:deliveryTargetId/simulate-impact", authorize("mps", "update"), logger("demandPlanning", "simulate-impact"), ctrl.simulateImpact);
router.post("/:deliveryTargetId/displacement-proposals", authorize("mps", "update"), logger("demandPlanning", "propose-displacement"), ctrl.createDisplacementProposal);
router.patch("/displacement-proposals/:proposalId/approve", authorize("monthlyProductionPlan", "approve"), logger("demandPlanning", "approve-displacement"), ctrl.approveDisplacementProposal);

module.exports = router;
