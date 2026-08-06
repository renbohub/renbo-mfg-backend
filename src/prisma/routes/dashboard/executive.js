const router = require("express").Router();
const controller = require("../../controllers/dashboard/ExecutiveDashboardController");

router.get("/:module", controller.get);

module.exports = router;
