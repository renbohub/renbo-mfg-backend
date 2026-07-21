const router = require("express").Router();
const ctrl = require("../../controllers/master-data/FoundationController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.get("/supplier-items", authorize("suppliers", "read"), ctrl.listSupplierItems);
router.post("/supplier-items", authorize("suppliers", "create"), logger("supplier-item", "create"), ctrl.createSupplierItem);
router.get("/uom-conversions", authorize("uom", "read"), ctrl.listUomConversions);
router.post("/uom-conversions", authorize("uom", "create"), logger("uom-conversion", "create"), ctrl.createUomConversion);
router.get("/material-attribute-sets", authorize("materials", "read"), ctrl.listMaterialAttributeSets);
router.post("/material-attribute-sets", authorize("materials", "create"), logger("material-attribute-set", "create"), ctrl.createMaterialAttributeSet);

module.exports = router;
