const router = require("express").Router();
const ctrl = require("../../controllers/inventory/StockMovementController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.get("/", authorize("stockMovements", "read"), ctrl.list);
router.get("/material-piece-sources", authorize("stockMovements", "read"), ctrl.listMaterialPieceSources);
router.get("/:movementNumber", authorize("stockMovements", "read"), ctrl.get);
router.post("/", authorize("stockMovements", "create"), logger("stockMovements", "create"), ctrl.create);

module.exports = router;
