const router = require("express").Router();
const ctrl = require("../controllers/SystemSettingController");
const { authorize } = require("../middleware/auth");

router.get("/mrp-demand-fence", authorize("systemSettings", "read"), ctrl.getMrpDemandFence);
router.patch("/mrp-demand-fence", authorize("systemSettings", "update"), ctrl.updateMrpDemandFence);

module.exports = router;
