const router = require("express").Router();
const ctrl = require("../controllers/ExportController");
const partCtrl = require("../controllers/master-data/PartController");
const machineCtrl = require("../controllers/master-data/MachineController");
const diesCtrl = require("../controllers/master-data/DiesController");
const manufacturingOrderCtrl = require("../controllers/production/ManufacturingOrderController");
const workOrderCtrl = require("../controllers/production/WorkOrderController");
const productionLogCtrl = require("../controllers/production/ProductionLogController");
const downtimeLogCtrl = require("../controllers/production/DowntimeLogController");
const { auth, authExportToken } = require("../middleware/auth");

// Generate token export (berlaku 1 tahun, bisa regenerate kapan saja)
router.post("/generate-token", auth, ctrl.generateToken);
router.post("/revoke-token", auth, ctrl.revokeToken);
router.get("/tokens", auth, ctrl.listTokens);
router.delete("/tokens/:jti", auth, ctrl.deleteToken);

// // Endpoint export untuk integrasi eksternal (tanpa login user)
// router.get("/parts", authExportToken, partCtrl.list);
// router.get("/machines", authExportToken, machineCtrl.list);
// router.get("/dies", authExportToken, diesCtrl.list);

// Sementara tidak pakai authToken dulu
router.get("/parts", partCtrl.list);
router.get("/machines", machineCtrl.list);
router.get("/dies", diesCtrl.list);

// Endpoint integrasi production eksternal (tanpa login user, wajib export token)
// router.get("/manufacturing-orders", authExportToken, manufacturingOrderCtrl.list);
// router.get("/manufacturing-orders/:moNumber", authExportToken, manufacturingOrderCtrl.get);

// router.get("/work-orders", authExportToken, workOrderCtrl.list);
// router.get("/work-orders/:woNumber", authExportToken, workOrderCtrl.get);

// router.get("/production-logs/generate-number", authExportToken, productionLogCtrl.generateNumber);
// router.get("/production-logs", authExportToken, productionLogCtrl.list);
// router.get("/production-logs/:logNumber", authExportToken, productionLogCtrl.get);
// router.post("/production-logs", authExportToken, productionLogCtrl.create);

// router.get("/downtime-logs/generate-number", authExportToken, downtimeLogCtrl.generateNumber);
// router.get("/downtime-logs", authExportToken, downtimeLogCtrl.list);
// router.get("/downtime-logs/:downtimeNumber", authExportToken, downtimeLogCtrl.get);
// router.post("/downtime-logs", authExportToken, downtimeLogCtrl.create);

// Sementara tidak pakai authToken dulu
router.get("/manufacturing-orders", manufacturingOrderCtrl.list);
router.get("/manufacturing-orders/:moNumber", manufacturingOrderCtrl.get);

router.get("/work-orders", workOrderCtrl.list);
router.get("/work-orders/:woNumber", workOrderCtrl.get);

router.get("/production-logs/generate-number", productionLogCtrl.generateNumber);
router.get("/production-logs", productionLogCtrl.list);
router.get("/production-logs/:logNumber", productionLogCtrl.get);
router.post("/production-logs", productionLogCtrl.create);

router.get("/downtime-logs/generate-number", downtimeLogCtrl.generateNumber);
router.get("/downtime-logs", downtimeLogCtrl.list);
router.get("/downtime-logs/:downtimeNumber", downtimeLogCtrl.get);
router.post("/downtime-logs", downtimeLogCtrl.create);

module.exports = router;
