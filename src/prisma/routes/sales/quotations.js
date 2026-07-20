const router = require("express").Router();
const ctrl = require("../../controllers/sales/QuotationController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");
router.get("/generate-number", authorize("quotation", "create"), ctrl.generateNumber);
router.get("/", authorize("quotation", "read"), ctrl.list);
router.get("/:quotationNumber", authorize("quotation", "read"), ctrl.get);
router.post("/", authorize("quotation", "create"), logger("quotation", "create"), ctrl.create);
router.patch("/:quotationNumber", authorize("quotation", "update"), logger("quotation", "update", { modelName: "quotationHeader", paramKey: "quotationNumber", whereKey: "quotationNumber" }), ctrl.update);
router.post("/:quotationNumber/make-to-so", authorize("salesOrder", "create"), logger("quotation", "make-to-so", { paramKey: "quotationNumber", entityField: "quotationNumber" }), ctrl.convertToSalesOrder);
router.delete("/:quotationNumber", authorize("quotation", "delete"), logger("quotation", "delete", { paramKey: "quotationNumber", entityField: "quotationNumber" }), ctrl.remove);
module.exports = router;

