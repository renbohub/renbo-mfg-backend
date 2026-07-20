const { prisma } = require("../../index");
const { buildCapacitySnapshot } = require("../../services/planning/capacityPlanningService");

exports.snapshot = async (req, res, next) => {
  try {
    res.json(await buildCapacitySnapshot(prisma, req.query));
  } catch (error) {
    next(error);
  }
};

exports.checkPlan = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber: req.params.planNumber, isDeleted: false },
      select: { planNumber: true, periodStart: true, periodEnd: true, status: true },
    });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan." });
    const snapshot = await buildCapacitySnapshot(prisma, {
      ...req.query,
      planNumber: plan.planNumber,
      startDate: req.query.startDate || plan.periodStart,
      endDate: req.query.endDate || plan.periodEnd,
    });
    res.json(snapshot);
  } catch (error) {
    next(error);
  }
};
