const { prisma } = require("../../index");
const { countPlanningFlowRows, resetPlanningFlow, countDemandResetRows, resetDemandFlow } = require("../../services/system/planningFlowResetService");
const {
  listResetSources,
  previewSourcePlanningReset,
  resetSourcePlanning,
} = require("../../services/system/sourcePlanningResetService");

exports.getPlanningFlowResetStatus = async (_req, res, next) => {
  try {
    res.json({ scope: "MPS through Delivery", counts: await countPlanningFlowRows(prisma) });
  } catch (error) {
    next(error);
  }
};

exports.resetPlanningFlow = async (req, res, next) => {
  try {
    const confirmation = String(req.body?.confirmation || "").trim();
    if (confirmation !== "RESET_MPS_TO_DELIVERY") {
      return res.status(400).json({
        code: "RESET_CONFIRMATION_REQUIRED",
        message: "Kirim confirmation RESET_MPS_TO_DELIVERY untuk menghapus transaksi MRP sampai Delivery.",
      });
    }
    const result = await resetPlanningFlow(prisma, { forecastStatus: "Confirmed" });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
};

exports.getDemandResetStatus = async (_req, res, next) => {
  try {
    res.json({ scope: "Sales Order + Forecast + MPS + MRP", counts: await countDemandResetRows(prisma) });
  } catch (error) { next(error); }
};

exports.resetDemandFlow = async (req, res, next) => {
  try {
    const confirmation = String(req.body?.confirmation || "").trim();
    if (confirmation !== "RESET_SO_MPS_MRP_FORECAST") {
      return res.status(400).json({
        code: "RESET_CONFIRMATION_REQUIRED",
        message: "Kirim confirmation RESET_SO_MPS_MRP_FORECAST untuk menghapus Sales Order, Forecast, MPS, dan MRP.",
      });
    }
    return res.json(await resetDemandFlow(prisma));
  } catch (error) { return next(error); }
};

exports.listSourcePlanningResetSources = async (req, res, next) => {
  try {
    const rows = await listResetSources(prisma, {
      sourceType: req.query.sourceType,
      query: req.query.query,
      limit: req.query.limit,
    });
    return res.json({ rows });
  } catch (error) { return next(error); }
};

exports.previewSourcePlanningReset = async (req, res, next) => {
  try {
    return res.json(await previewSourcePlanningReset(prisma, req.body || {}));
  } catch (error) { return next(error); }
};

exports.resetSourcePlanning = async (req, res, next) => {
  try {
    const actor = req.user?.username || req.user?.email || req.user?.id || null;
    return res.json(await resetSourcePlanning(prisma, req.body || {}, actor));
  } catch (error) { return next(error); }
};
