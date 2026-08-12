const assert = require("assert");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { buildImagePdf, buildPdf, buildTemplate, buildXlsx, normalizeTable, parseWorkbook } = require("../src/prisma/services/system/tableDocumentService");

(async () => {
  const uuid = "cff1fca8-7a2d-43d5-96c7-50c6361094a2";
  const payload = {
    title: "MRP Planner Grid",
    pageSize: "A3",
    keepColumnsTogether: true,
    headers: ["Supplier", "Part Code", "Part Number", "Required Qty", "Required Date", "Bucket", "Risk", "Customer", "FG", "MPS", "MRP", "Catatan", "Status"],
    rows: [["PT Papajaya", "C002-C006-030", "11058-1288", 4.33, "2026-08-14", "AUG B1", "AMAN", "C002", "FG-01", "MPS-202608", "MRP-202608-R001", `internal ${uuid} hidden`, "OPEN"]],
    summary: [{ label: "Suggested Buy", value: "4,33 KG" }, { label: "At Risk", value: "0" }],
    sections: [{
      title: "Customer Pegging",
      subtitle: "Netting consolidated dengan trace customer terpisah",
      headers: ["Customer", "Target Delivery", "FG", "Material", "Requirement", "Coverage", "Risk"],
      rows: [["C002", "2026-08-31", "FG-01", "SPHC-PO-2-145", 4.33, 0, "EXPEDITE"]],
      keepColumnsTogether: true,
    }],
    sheets: [
      { name: "Management Summary", headers: ["Metric", "Value"], rows: [["Target MPS", 450], ["Actual SO", 300]] },
      { name: "Demand Matrix", headers: ["Customer", "FG", "Target Delivery", "Target MPS"], rows: [["C002", "FG-01", "2026-08-31", 450]] },
    ],
  };
  const normalized = normalizeTable(payload);
  assert(!JSON.stringify(normalized).includes(uuid), "UUID internal harus dibersihkan");
  const xlsx = buildXlsx(payload);
  assert(xlsx.buffer.length > 5000 && xlsx.fileName.endsWith(".xlsx"));
  const workbook = XLSX.read(xlsx.buffer, { type: "buffer" });
  assert.deepStrictEqual(workbook.SheetNames, ["Management Summary", "Demand Matrix"]);
  assert.strictEqual(workbook.Sheets["Management Summary"].A5.v, "Target MPS");
  assert.strictEqual(workbook.Sheets["Management Summary"].B5.v, 450);
  const pdf = await buildPdf(payload);
  assert(pdf.buffer.subarray(0, 4).toString() === "%PDF" && pdf.buffer.length > 2500);
  assert((pdf.buffer.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length >= 2, "PDF management harus memuat main report dan customer pegging");
  if (process.env.REPORT_QA_DIR) {
    fs.mkdirSync(process.env.REPORT_QA_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.REPORT_QA_DIR, "planning-management-report.pdf"), pdf.buffer);
    fs.writeFileSync(path.join(process.env.REPORT_QA_DIR, "planning-management-report.xlsx"), xlsx.buffer);
  }
  const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const imagePdf = await buildImagePdf({ title: "BOM Diagram", subtitle: "Part No. 11058-1288", fileName: "bom-diagram", imagesDataUrls: [pixel, pixel] });
  assert(imagePdf.buffer.subarray(0, 4).toString() === "%PDF" && imagePdf.buffer.length > 1200 && imagePdf.fileName === "bom-diagram.pdf");
  const template = buildTemplate({ title: "Template Supplier", fields: [{ name: "supplierCode", label: "Supplier Code", required: true, example: "S001" }, { name: "supplierName", label: "Supplier Name", required: true, example: "PT Supplier" }] });
  const parsed = parseWorkbook({ originalname: template.fileName, buffer: template.buffer });
  assert.deepStrictEqual(parsed.headers, ["Supplier Code", "Supplier Name"]);
  assert.strictEqual(parsed.rows[0].values[0], "S001");
  console.log("Table document contracts PASS (XLSX, PDF, image-PDF, template, parser, UUID sanitization)");
})().catch((error) => { console.error(error); process.exitCode = 1; });
