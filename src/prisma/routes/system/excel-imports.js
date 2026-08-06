const router = require("express").Router();
const multer = require("multer");
const ctrl = require("../../controllers/system/ExcelImportController");
const forecastImport = require("../../controllers/planning/ExcelForecastImportController");
const historicalImport = require("../../controllers/system/HistoricalExcelImportController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const name = String(file.originalname || "").toLowerCase();
    callback(null, /\.(xlsx|xls|csv)$/.test(name));
  },
});

router.post("/upload-preview", authorize("excelImports", "create"), upload.single("file"), ctrl.uploadPreview);
router.post("/preview", authorize("excelImports", "read"), ctrl.preview);
router.post("/forecast-preview", authorize("forecast", "read"), forecastImport.preview);
router.post("/historical-preview", authorize("excelImports", "read"), historicalImport.preview);
router.get("/", authorize("excelImports", "read"), ctrl.list);
router.post("/:key/apply-forecast", authorize("forecast", "create"), logger("excelImports", "apply-forecast"), forecastImport.apply);
router.post("/:key/apply-historical", authorize("excelImports", "create"), logger("excelImports", "apply-historical"), historicalImport.apply);
router.get("/:key", authorize("excelImports", "read"), ctrl.get);
router.post("/", authorize("excelImports", "create"), logger("excelImports", "create"), ctrl.create);
router.patch("/:key/approve", authorize("excelImports", "approve"), logger("excelImports", "approve"), ctrl.approve);

module.exports = router;
