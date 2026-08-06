const router = require("express").Router();
const ctrl = require("../../controllers/inventory/StockReservationController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.get("/", authorize("stockBalances", "read"), ctrl.list);
router.patch("/:reservationNumber/cancel", authorize("stockBalances", "adjust"), logger("stockBalances", "adjust"), ctrl.cancel);
router.get("/:reservationNumber", authorize("stockBalances", "read"), ctrl.get);

module.exports = router;
