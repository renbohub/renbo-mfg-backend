const router = require("express").Router();
const ctrl = require("../../controllers/planning/PlanningExecutionCockpitController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.get("/production-actuals", authorize("monthlyProductionPlan", "read"), authorize("productionLogs", "read"), authorize("vendorProcessOrders", "read"), async (req, res, next) => { try { const { prisma } = require("../../index"); const result = await require("../../services/planning/productionActualsService").snapshot(prisma, req.query.month); res.json(result); } catch(error) { if(error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); } });
router.get("/", authorize("mrp", "read"), ctrl.snapshot);
router.post("/:month/close", authorize("mrp", "release"), logger("mrp", "period-close"), ctrl.close);
router.post("/:month/reopen", authorize("mrp", "release"), logger("mrp", "period-reopen"), ctrl.reopen);

module.exports = router;
