const test = require("node:test");
const assert = require("node:assert/strict");
const XLSX = require("xlsx");
const fs = require("node:fs/promises");
const service = require("../src/prisma/services/inventory/stockOpnameDocumentService");
const { createQrPng } = require("../src/prisma/services/documents/qrCodeService");
const { PNG } = require("pngjs"); const jsQR = require("jsqr");

function fixture(count = 251, status = "COUNTING") {
  return { stoNo: "STO/FG/2026-009", warehouseCode: "WH-FG", stoType: "FG", status, stoDate: "2026-09-08", currentRoundNo: 1, createdBy: "maker-1", checkerBy: "checker-2", checkerApprovedAt: "2026-09-08", approvedBy: "supervisor-3", approvedAt: "2026-09-08", details: Array.from({ length: count }, (_, i) => ({ id: `detail-${i + 1}`, stockBalanceId: `balance-${i + 1}`, partCode: `FG-${String(i + 1).padStart(3, "0")}`, partNumber: `PN-${i + 1}`, partName: `Bracket penguat bagian ${i + 1}`, warehouseCode: "WH-FG", rackCode: `R-${i % 4 + 1}`, lotNumber: `LOT-202609-${i + 1}`, stockType: "FG", uomCode: i % 2 ? "KG" : "PCS", systemQty: 99999, actualQty: i % 5 ? i + 1 : null, varianceQty: -99998, varianceAmount: 87654321, varianceStatus: "SHORTAGE", countedBy: "petugas-1", countedAt: "2026-09-08", reason: i === 2 ? "Selisih fisik - perlu verifikasi" : "", adjustmentNumber: i === 2 ? "ADJ-TEST-001" : "" })), countRounds: [{ roundNo: 1, status: "ACTIVE", startedBy: "maker-1", startedAt: "2026-09-08", attempts: [{ stoDetailId: "detail-1", sequenceNo: 1, actualQty: 87654321, countedBy: "petugas-lama", countedAt: "2026-09-08", reason: "", isCurrent: false }] }] };
}
test("blind reports never expose system, variance or earlier count attempts", () => {
  for (const status of ["COUNTING", "DRAFT", "CANCELLED", "unknown"]) {
    const report = service.buildStockOpnameReport(fixture(10, status));
    assert.equal(report.blind, true);
    assert.doesNotMatch(JSON.stringify(report), /99999|87654321|systemQty|varianceQty|varianceAmount|varianceStatus|petugas-lama/);
    const book = XLSX.read(service.createStockOpnameWorkbook(report), { type: "buffer" });
    const sheets = book.SheetNames.map((name) => XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1 }));
    assert.doesNotMatch(JSON.stringify(sheets), /99999|87654321|petugas-lama/);
    assert.equal(sheets[1][0].includes("Qty sistem"), false);
  }
});
test("review report contains every active row beyond table pagination, separate UOM and history", () => {
  const header = fixture(251, "WAITING_APPROVAL"); header.details[1].isDeleted = true;
  const report = service.buildStockOpnameReport(header);
  assert.equal(report.rows.length, 250);
  assert.equal(report.rows.at(-1).itemCode, "FG-251");
  assert.equal(report.blind, false);
  assert.equal(report.rows[1].varianceQty, 3 - 99999);
  assert.equal(report.rows[0].varianceQty, null, "uncounted rows have no fabricated variance");
  assert.equal(report.totals.length, 2);
  for (const total of report.totals) {
    const matching = report.rows.filter((row) => row.uom === total.uom);
    assert.equal(total.actualQty, matching.reduce((sum, row) => sum + Number(row.actualQty || 0), 0));
    assert.equal(total.varianceQty, matching.filter((row) => row.actualQty != null).reduce((sum, row) => sum + row.varianceQty, 0));
  }
  const book = XLSX.read(service.createStockOpnameWorkbook(report), { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json(book.Sheets.Detail, { header: 1 });
  assert.equal(rows.length, 251); assert.equal(rows.at(-1)[1], "FG-251");
  assert.match(JSON.stringify(XLSX.utils.sheet_to_json(book.Sheets.Riwayat, { header: 1 })), /petugas-lama/);
});
test("spreadsheet treats potentially executable cell input as literal strings", () => {
  const header = fixture(1, "APPROVED"); header.details[0].partName = '=HYPERLINK("https://invalid.test","click")';
  const book = XLSX.read(service.createStockOpnameWorkbook(service.buildStockOpnameReport(header)), { type: "buffer" });
  assert.equal(book.Sheets.Detail.D2.t, "s"); assert.equal(book.Sheets.Detail.D2.f, undefined);
});
test("QR roundtrip resolves exactly one scoped detail and rejects another document or deleted line", async () => {
  const header = fixture(2); const value = service.stockOpnameReference(header.stoNo, "detail-1");
  const png = PNG.sync.read(await createQrPng(value)); const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height).data;
  assert.equal(decoded, value);
  const result = service.resolveStockOpnameScan(header, decoded);
  assert.equal(result.matches.length, 1); assert.equal(result.matches[0].id, "detail-1");
  assert.doesNotMatch(JSON.stringify(result), /Qty|variance|99999/);
  assert.throws(() => service.resolveStockOpnameScan(header, service.stockOpnameReference("OTHER", "detail-1")), /dokumen opname lain/);
  header.details[0].isDeleted = true;
  assert.throws(() => service.resolveStockOpnameScan(header, value), /tidak ditemukan/);
});
test("external barcode exact match preserves lot ambiguity and makes no count mutation", () => {
  const header = fixture(3); header.details[1].partCode = header.details[0].partCode;
  const before = JSON.stringify(header);
  const result = service.resolveStockOpnameScan(header, "fg-001");
  assert.equal(result.ambiguous, true); assert.equal(result.matches.length, 2);
  assert.notEqual(result.matches[0].lotNumber, result.matches[1].lotNumber);
  assert.equal(JSON.stringify(header), before);
  assert.throws(() => service.resolveStockOpnameScan(header, "FG-00"), /tidak ditemukan/);
  assert.throws(() => service.resolveStockOpnameScan(header, "ERP:STO:%XX:bad"), /tidak valid/);
});
test("PDF reports paginate all rows, labels contain no stock quantities", async () => {
  const header = fixture(36, "WAITING_APPROVAL");
  const report = service.buildStockOpnameReport(header);
  const pdf = await service.createStockOpnamePdf(report);
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  const pageCount = (pdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length;
  assert.ok(pageCount >= 3 && pageCount <= 8, "36 rows and audit must not generate blank footer-only pages");
  const labels = await service.createStockOpnameLabels(fixture(9));
  assert.equal((labels.toString("latin1").match(/\/Type \/Page\b/g) || []).length, 2);
  if (process.env.OPNAME_PREVIEW_DIR) {
    await fs.writeFile(`${process.env.OPNAME_PREVIEW_DIR}/opname-report-preview.pdf`, pdf);
    await fs.writeFile(`${process.env.OPNAME_PREVIEW_DIR}/opname-labels-preview.pdf`, labels);
    await fs.writeFile(`${process.env.OPNAME_PREVIEW_DIR}/opname-report-preview.xlsx`, service.createStockOpnameWorkbook(report));
    await fs.writeFile(`${process.env.OPNAME_PREVIEW_DIR}/opname-blind-preview.pdf`, await service.createStockOpnamePdf(service.buildStockOpnameReport(fixture(9))));
  }
});
