const router = require("express").Router();
const ctrl = require("../../controllers/production/QualityReportController");
const { authorize } = require("../../middleware/auth");

router.get("/value", authorize("productionReports", "read"), ctrl.valueReport);

module.exports = router;
