const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const XLSX = require("xlsx");
const { buildPdf, buildXlsx } = require("../src/prisma/services/system/tableDocumentService");

const matrix = {
  title: "Inventory Stock Matrix - C002-C004-000",
  subtitle: "C002-C004-000 | 23062-1498C - BRACKET COMP | BOM MBOM-20260729-001 Rev 1",
  fileName: "inventory-matrix-contract",
  headers: ["P/N", "Part Code", "Part Name", "MAT Stock", "Stock Reserved", "Stock Allocation", "Purchase Allocation", "Free Stock", "PRG", "BE", "SPOT", "WELD-1", "WELD-2", "WELD-3", "WELD-4", "PAINT", "INSP-PACK-1", "INSP-PACK-2", "FG"],
  rows: [
    ["23062-1498C", "C002-C004-000", "BRACKET COMP", "0 PCS", "0 PCS", "0 PCS", "0 PCS", "0 PCS", "", "", "", "", "", "", "10 PCS", "", "", "", "20 PCS"],
    ["11058-1287", "C002-C005-000", "BRACKET", "1,43 KG / ≈ 11 PCS", "0,00 KG / ≈ 0 PCS", "0,00 KG / ≈ 0 PCS", "0,26 KG / ≈ 2 PCS", "1,43 KG / ≈ 11 PCS", "121 PCS", "", "7 PCS", "", "", "", "", "", "", "", "10 PCS"],
    ["11058-1288", "C002-C006-000", "BRACKET", "1,04 KG / ≈ 8 PCS", "0,00 KG / ≈ 0 PCS", "0,00 KG / ≈ 0 PCS", "0,00 KG / ≈ 0 PCS", "1,04 KG / ≈ 8 PCS", "87 PCS", "", "6 PCS", "", "", "", "", "", "", "", "15 PCS"],
    ["270D0600", "MI-M06-N01", "NUT-M6", "205 PCS", "0 PCS", "100 PCS", "60 PCS", "105 PCS", "", "", "", "", "", "", "", "", "", "", ""],
  ],
  summary: [
    { label: "Finished Goods", value: "C002-C004-000" },
    { label: "BOM Aktif", value: "MBOM-20260729-001 Rev 1" },
    { label: "Total Item", value: "11 item" },
    { label: "Status", value: "MATERIAL AVAILABLE" },
  ],
  pageSize: "A3",
  keepColumnsTogether: true,
  columnWidths: [1.45, 1.45, 1.35, ...Array(16).fill(1)],
  alignments: ["left", "left", "left", ...Array(16).fill("center")],
  groupHeaders: [{ label: "WIP", start: 8, span: 10 }],
};

const detailHeaders = ["Stock Type", "Part Code", "Part Number", "Part Name", "Process", "Material / Spec", "Level", "Req / FG", "GW KG/PCS", "On Hand KG", "On Hand PCS", "Reserved PCS", "Available KG", "Available PCS", "Status"];
const detail = {
  ...matrix,
  title: "Inventory Detail - C002-C004-000",
  fileName: "inventory-detail-contract",
  pageSize: "A3",
  headers: detailHeaders,
  rows: Array.from({ length: 42 }, (_, index) => ["Material", `C002-C${String(index + 5).padStart(3, "0")}-030`, `11058-${1287 + index}`, "BRACKET", "Progressive - Spot - Weld", "Besi - SPHC-PO-2-145 - 2 mm x 145 mm", 3, "1 PCS", 0.13, 1.38, index === 0 ? 11 : index + 1, 0, 1.38, index === 0 ? 11 : index + 1, "AVAILABLE"]),
  keepColumnsTogether: true,
  groupHeaders: [],
  columnWidths: [0.9, 1.15, 1.05, 1.15, 1.2, 1.8, 0.4, 0.72, 0.7, 0.7, 0.72, 0.72, 0.7, 0.72, 0.9],
  alignments: ["left", "left", "left", "left", "left", "left", "center", "right", "right", "right", "right", "right", "right", "right", "center"],
};

async function main() {
  const outputDirectory = path.resolve(__dirname, "../tmp/pdfs");
  await fs.mkdir(outputDirectory, { recursive: true });
  const [matrixPdf, detailPdf] = await Promise.all([buildPdf(matrix), buildPdf(detail)]);
  const workbook = buildXlsx({ ...matrix, sheets: [{ name: "Stock Matrix", headers: matrix.headers, rows: matrix.rows, groupHeaders: matrix.groupHeaders }] });
  assert.equal(matrixPdf.buffer.subarray(0, 4).toString(), "%PDF");
  assert.equal(detailPdf.buffer.subarray(0, 4).toString(), "%PDF");
  const parsedWorkbook = XLSX.read(workbook.buffer, { type: "buffer" });
  assert.deepEqual(parsedWorkbook.SheetNames, ["Stock Matrix"]);
  const rows = XLSX.utils.sheet_to_json(parsedWorkbook.Sheets["Stock Matrix"], { header: 1, defval: "" });
  assert.ok(rows.some((row) => row[0] === "11058-1287" && row[1] === "C002-C005-000" && row[2] === "BRACKET" && row[3].includes("KG") && row[8] === "121 PCS" && row[10] === "7 PCS" && row[18] === "10 PCS"));
  assert.ok(rows.some((row) => row[0] === "270D0600" && row[5] === "100 PCS" && row[6] === "60 PCS" && row[7] === "105 PCS"), "Allocation stok dan purchase suggestion harus terpisah dari free stock");
  assert.ok(rows.some((row) => row.includes("WELD-4")), "Kolom proses BOM berulang wajib tetap terpisah");
  await fs.writeFile(path.join(outputDirectory, matrixPdf.fileName), matrixPdf.buffer);
  await fs.writeFile(path.join(outputDirectory, detailPdf.fileName), detailPdf.buffer);
  await fs.writeFile(path.join(outputDirectory, workbook.fileName), workbook.buffer);
  console.log(`Inventory report export contracts: PASS\n${path.join(outputDirectory, matrixPdf.fileName)}\n${path.join(outputDirectory, detailPdf.fileName)}\n${path.join(outputDirectory, workbook.fileName)}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
