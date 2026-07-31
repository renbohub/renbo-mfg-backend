const router = require("express").Router();
const ctrl = require("../../controllers/production/ProductionReportController");
const { authorize } = require("../../middleware/auth");

// Semua endpoint read-only — tidak memerlukan logger
router.get("/dashboard", authorize("productionReports", "read"), ctrl.dashboard);
router.get("/machine-daily", authorize("productionReports", "read"), ctrl.machineDailyReport);
router.get("/oee", authorize("productionReports", "read"), ctrl.oeeReport);
router.get("/yield", authorize("productionReports", "read"), ctrl.yieldReport);
router.get("/scrap", authorize("productionReports", "read"), ctrl.scrapReport);
router.get("/output-trend", authorize("productionReports", "read"), ctrl.outputTrend);
router.get("/qc-summary", authorize("productionReports", "read"), ctrl.qcSummary);

module.exports = router;
