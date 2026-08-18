const { prisma } = require("../index");
const { assertPeriodOpen, normalizeMonth } = require("../services/planning/periodClosingService");

const respond = (res, error, next) => error.statusCode
  ? res.status(error.statusCode).json({ message: error.message, code: error.code, periodState: error.periodState })
  : next(error);

const monthOf = (value) => value ? new Date(value).toISOString().slice(0, 7) : null;

exports.guardMonthBody = async (req, res, next) => {
  try {
    const raw = req.body?.month || req.body?.planningMonth || req.body?.periodMonth;
    if (raw) await assertPeriodOpen(prisma, normalizeMonth(String(raw).slice(0, 7)));
    next();
  } catch (error) { respond(res, error, next); }
};

exports.guardMps = async (req, res, next) => {
  try {
    const mpsNumber = req.params?.mpsNumber || req.body?.mpsNumber;
    if (mpsNumber) {
      const row = await prisma.mPS.findFirst({ where: { mpsNumber, isDeleted: false }, select: { periodStart: true } });
      if (row) await assertPeriodOpen(prisma, monthOf(row.periodStart));
    }
    next();
  } catch (error) { respond(res, error, next); }
};

exports.guardMrp = async (req, res, next) => {
  try {
    const runNumber = req.params?.runNumber;
    if (runNumber) {
      const row = await prisma.mRPRun.findFirst({ where: { runNumber, isDeleted: false }, select: { planningMonth: true, mps: { select: { periodStart: true } } } });
      const month = monthOf(row?.planningMonth || row?.mps?.periodStart);
      if (month) await assertPeriodOpen(prisma, month);
    }
    next();
  } catch (error) { respond(res, error, next); }
};

exports.guardPlan = async (req, res, next) => {
  try {
    const planNumber = req.params?.planNumber;
    if (planNumber) {
      const row = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber, isDeleted: false }, select: { periodStart: true } });
      if (row) await assertPeriodOpen(prisma, monthOf(row.periodStart));
    }
    next();
  } catch (error) { respond(res, error, next); }
};
