const router = require("express").Router();
const ctrl = require("../../controllers/master-data/MainBusinessController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.post("/bulk-create", authorize("mainBusinesses", "create"), logger("mainBusiness", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("mainBusinesses", "delete"), logger("mainBusiness", "bulk-remove", { modelName: "mainBusiness" }), ctrl.bulkRemove);
router.get("/autocomplete", authorize("mainBusinesses", "read"), ctrl.autocomplete);

router.get("/", authorize("mainBusinesses", "read"), ctrl.list);
router.get("/:idOrCode", authorize("mainBusinesses", "read"), ctrl.get);
router.post("/", authorize("mainBusinesses", "create"), logger("mainBusiness", "create"), ctrl.create);
router.patch("/:id", authorize("mainBusinesses", "update"), logger("mainBusiness", "update", { modelName: "mainBusiness" }), ctrl.update);
router.patch("/:id/remove", authorize("mainBusinesses", "delete"), logger("mainBusiness", "delete"), ctrl.remove);

module.exports = router;
