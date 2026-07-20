const router = require("express").Router();
const ctrl = require("../../controllers/production/VendorProcessOrderController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.post(
  "/generate-from-mo/:moNumber",
  authorize("vendorProcessOrders", "create"),
  logger("vendorProcessOrders", "generate-from-mo", { modelName: "VendorProcessOrder" }),
  ctrl.generateFromMo,
);

router.patch(
  "/:orderNumber/send",
  authorize("vendorProcessOrders", "update"),
  logger("vendorProcessOrders", "send", { modelName: "VendorProcessOrder" }),
  ctrl.send,
);

router.patch(
  "/:orderNumber/rollback-send",
  authorize("vendorProcessOrders", "update"),
  logger("vendorProcessOrders", "rollback-send", { modelName: "VendorProcessOrder" }),
  ctrl.rollbackSend,
);

router.patch(
  "/:orderNumber/receive",
  authorize("vendorProcessOrders", "update"),
  logger("vendorProcessOrders", "receive", { modelName: "VendorProcessOrder" }),
  ctrl.receive,
);

router.patch(
  "/:orderNumber/reprice",
  authorize("vendorProcessOrders", "update"),
  logger("vendorProcessOrders", "reprice", { modelName: "VendorProcessOrder" }),
  ctrl.reprice,
);

router.get("/", authorize("vendorProcessOrders", "read"), ctrl.list);
router.get("/:orderNumber", authorize("vendorProcessOrders", "read"), ctrl.get);
router.patch(
  "/:orderNumber",
  authorize("vendorProcessOrders", "update"),
  logger("vendorProcessOrders", "update", { modelName: "VendorProcessOrder" }),
  ctrl.update,
);
router.patch(
  "/:orderNumber/remove",
  authorize("vendorProcessOrders", "delete"),
  logger("vendorProcessOrders", "delete", { modelName: "VendorProcessOrder" }),
  ctrl.remove,
);

module.exports = router;
