const assert = require("assert");
const fs = require("fs");
const path = require("path");

const controller = fs.readFileSync(path.join(__dirname, "../src/prisma/controllers/mbom/BOMController.js"), "utf8");
const routes = fs.readFileSync(path.join(__dirname, "../src/prisma/routes/mbom/bom.js"), "utf8");
const service = fs.readFileSync(path.join(__dirname, "../src/prisma/services/mbomReportService.js"), "utf8");
const frontend = fs.readFileSync(path.join(__dirname, "../../frontend/public/js/bom-report.js"), "utf8");
const template = fs.readFileSync(path.join(__dirname, "../../frontend/views/bom/list.ejs"), "utf8");

assert(controller.includes("buildMbomReport"));
assert(routes.includes('/:noReg/report'));
["partNumber", "priceSource", "cycleTimeSeconds", "processCostPerUnit", "costingStatus", "resolveMbomRevision", "expandHeader", "sourceBomNoReg", "parentNodeKey", "cumulativeQty", "explodedComponentCount"].forEach((field) => assert(service.includes(field), `report field ${field} missing`));
["Management Summary", "BOM Structure & Cost", "Routing & Cycle Time", "canvas.toBlob", "childrenByParent", "leafCount", "parentBottom", "BOM EXPLOSION", "Linked Child BOM"].forEach((text) => assert(frontend.includes(text), `frontend report ${text} missing`));
["Excel Lengkap", "PDF Management", "PDF Bagan BOM", "PNG Bagan BOM"].forEach((text) => assert(template.includes(text), `report action ${text} missing`));
assert(frontend.includes('"image-pdf"'), "diagram PDF action missing");
console.log("MBOM management report contracts PASS (part number, costing, routing, XLSX/PDF/Canvas)");
