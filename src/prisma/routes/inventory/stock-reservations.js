const router = require("express").Router();
const ctrl = require("../../controllers/inventory/StockReservationController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.get("/", authorize("stockBalances", "read"), ctrl.list);
router.get("/stock-options", authorize("stockBalances", "read"), ctrl.stockOptions);
router.get("/part-options", authorize("stockBalances", "read"), ctrl.partOptions);
router.post("/", authorize("stockBalances", "adjust"), logger("stockBalances", "manual-reserve"), ctrl.create);
router.patch("/:reservationNumber/cancel", authorize("stockBalances", "adjust"), logger("stockBalances", "adjust"), ctrl.cancel);
router.get("/:reservationNumber", authorize("stockBalances", "read"), ctrl.get);

module.exports = router;
