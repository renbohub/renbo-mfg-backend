const router = require("express").Router();
const ctrl = require("../../controllers/inventory/StockBalanceController");
const { prisma } = require("../../index");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

const STOCK_TYPE_RESOURCE = {
  material: "stockMaterials",
  consumable: "stockConsumables",
  "finished goods": "stockFinishedGoods",
};

const SPECIAL_RACK_RESOURCE = {
  "RACK-SCRAP": "stockScrap",
  "RACK-REJECT": "stockReject",
  "RACK-REWORK": "stockRework",
};

const stockTypeResource = (stockType) => {
  if (!stockType) return "stockBalances";
  return STOCK_TYPE_RESOURCE[String(stockType).trim().toLowerCase()] || "stockBalances";
};

const specialRackResource = ({ rackCode, rackCodePrefix } = {}) => {
  const value = rackCodePrefix || rackCode;
  const normalizedValue = String(value || "").trim().toUpperCase();
  const matchingPrefix = Object.keys(SPECIAL_RACK_RESOURCE).find((prefix) =>
    normalizedValue.startsWith(prefix),
  );

  return matchingPrefix ? SPECIAL_RACK_RESOURCE[matchingPrefix] : null;
};

const authorizeStockBalanceRead = async (req, res, next) => {
  try {
    let resource = specialRackResource(req.query) || stockTypeResource(req.query.stockType);

    if (req.params.id) {
      const stockBalance = await prisma.stockBalance.findUnique({
        where: { id: req.params.id },
        select: { stockType: true, rackCode: true },
      });

      resource = specialRackResource(stockBalance || {}) || stockTypeResource(stockBalance?.stockType);
    }

    return authorize(resource, "read")(req, res, next);
  } catch (error) {
    return next(error);
  }
};

// Special routes first
router.get("/low-stock-alert", authorize("stockBalances", "read"), ctrl.lowStockAlert);
router.get("/summary", authorize("stockBalances", "read"), ctrl.summaryByItem);
router.get("/summary-special", authorize("stockBalances", "read"), ctrl.summarySpecialByItem);
router.get("/by-item", authorize("stockBalances", "read"), ctrl.getByItem);
router.post("/adjust", authorize("stockBalances", "adjust"), logger("stockBalances", "adjust"), ctrl.adjust);
router.post("/upsert", authorize("stockBalances", "create"), logger("stockBalances", "upsert"), ctrl.upsert);
router.post("/:id/decide-reject", authorize("stockReject", "update"), logger("stockReject", "update"), ctrl.decideReject);
router.post("/:id/process-rework", authorize("stockRework", "update"), logger("stockRework", "update"), ctrl.processRework);

// Standard CRUD routes
router.get("/", authorizeStockBalanceRead, ctrl.list);
router.get("/:id", authorizeStockBalanceRead, ctrl.get);
router.patch("/:id/remove", authorize("stockBalances", "delete"), logger("stockBalances", "delete"), ctrl.remove);

module.exports = router;
