const router = require("express").Router();
const multer = require("multer");
const { buildImagePdf, buildPdf, buildTemplate, buildXlsx, parseWorkbook } = require("../../services/system/tableDocumentService");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
const sendFile = (res, output, mime) => {
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", `attachment; filename="${output.fileName}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(output.buffer);
};

router.post("/xlsx", async (req, res, next) => { try { sendFile(res, buildXlsx(req.body), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); } catch (error) { next(error); } });
router.post("/pdf", async (req, res, next) => { try { sendFile(res, await buildPdf(req.body), "application/pdf"); } catch (error) { next(error); } });
router.post("/image-pdf", async (req, res, next) => { try { sendFile(res, await buildImagePdf(req.body), "application/pdf"); } catch (error) { next(error); } });
router.post("/template", async (req, res, next) => { try { sendFile(res, buildTemplate(req.body), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); } catch (error) { next(error); } });
router.post("/import-preview", upload.single("file"), (req, res, next) => { try { res.json(parseWorkbook(req.file)); } catch (error) { next(error); } });

module.exports = router;
