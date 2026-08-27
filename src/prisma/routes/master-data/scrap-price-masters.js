const router = require("express").Router();
const ctrl = require("../../controllers/master-data/ScrapPriceMasterController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// Menggunakan permission harga material agar role costing yang sudah ada tetap
// dapat mengelola harga scrap tanpa migrasi permission yang memutus akses.
router.patch("/bulk-remove", authorize("materialPriceLists", "delete"), logger("scrapPriceMasters", "bulk-remove"), ctrl.bulkRemove);
router.get("/", authorize("materialPriceLists", "read"), ctrl.list);
router.get("/:id", authorize("materialPriceLists", "read"), ctrl.get);
router.post("/", authorize("materialPriceLists", "create"), logger("scrapPriceMasters", "create"), ctrl.create);
router.patch("/:id", authorize("materialPriceLists", "update"), logger("scrapPriceMasters", "update"), ctrl.update);
router.patch("/:id/remove", authorize("materialPriceLists", "delete"), logger("scrapPriceMasters", "delete"), ctrl.remove);

module.exports = router;
