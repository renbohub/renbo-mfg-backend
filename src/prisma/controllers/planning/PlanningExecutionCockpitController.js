const { prisma } = require("../../index");
const { buildExecutionCockpit, closePeriod, reopenPeriod } = require("../../services/planning/planningExecutionCockpitService");

const actor = (req) => req.user?.username || req.user?.email || "system";

exports.snapshot = async (req, res, next) => {
  try { res.json(await buildExecutionCockpit(prisma, req.query.month)); } catch (error) { next(error); }
};

exports.close = async (req, res, next) => {
  try { res.json({ periodState: await closePeriod(prisma, req.params.month, actor(req), req.body?.confirmation), message: `Periode ${req.params.month} berhasil ditutup.` }); }
  catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message, blockers: error.blockers || [] }); next(error); }
};

exports.reopen = async (req, res, next) => {
  try { res.json({ periodState: await reopenPeriod(prisma, req.params.month, actor(req), req.body?.confirmation, req.body?.reason), message: `Periode ${req.params.month} dibuka kembali.` }); }
  catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};
