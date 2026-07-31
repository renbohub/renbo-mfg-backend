const router = require("express").Router();
const controller = require("../controllers/reporting/P2ReportingController");
const { authorize } = require("../middleware/auth");

router.get("/mbom-costing", authorize("mbom", "read"), controller.mbomCosting);
router.get("/mbom-structure", authorize("mbom", "read"), controller.mbomStructure);
router.get("/inventory", authorize("stockBalances", "read"), controller.inventory);
router.get("/sales-margin", authorize("salesOrder", "read"), controller.salesMargin);
router.get("/cost-trend", authorize("mbom", "read"), controller.costTrend);
router.get("/purchasing", authorize("purchaseOrder", "read"), controller.purchasing);

module.exports = router;
