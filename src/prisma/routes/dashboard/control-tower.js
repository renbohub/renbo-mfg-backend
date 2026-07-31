const router = require("express").Router();
const ctrl = require("../../controllers/dashboard/ControlTowerController");
const { authorize } = require("../../middleware/auth");
router.get("/", authorize("salesOrder", "read"), ctrl.list);
router.get("/:soNumber", authorize("salesOrder", "read"), ctrl.get);
module.exports = router;
