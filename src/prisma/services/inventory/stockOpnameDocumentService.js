const PDFDocument = require("pdfkit");
const XLSX = require("xlsx");
const { createQrPng } = require("../documents/qrCodeService");
const REVIEW_STATUSES = new Set(["WAITING_CHECK", "WAITING_APPROVAL", "APPROVED", "ADJUSTED", "CLOSED"]);
const clean = (value) => String(value ?? "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
const qty = (value) => value == null ? "" : new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 }).format(Number(value) || 0);
const date = (value) => value ? new Date(value).toISOString() : "";
const invalid = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const activeRows = (header) => (header.details || []).filter((row) => !row.isDeleted);

function stockOpnameReference(stoNo, detailId) {
  if (!stoNo || !detailId) throw invalid("Identitas label opname tidak valid.");
  return `ERP:STO:${encodeURIComponent(stoNo)}:${encodeURIComponent(detailId)}`;
}
function resolveStockOpnameScan(header, reference) {
  const value = String(reference || "").trim();
  if (!value || value.length > 512 || /[\x00-\x1f]/.test(value)) throw invalid("Scan atau nomor barcode tidak valid.");
  let matches;
  if (value.startsWith("ERP:STO:")) {
    const parts = value.slice(8).split(":");
    if (parts.length !== 2) throw invalid("QR opname tidak valid.");
    let stoNo; let detailId;
    try { stoNo = decodeURIComponent(parts[0]); detailId = decodeURIComponent(parts[1]); } catch { throw invalid("QR opname tidak valid."); }
    if (stoNo !== header.stoNo) throw invalid("Label berasal dari dokumen opname lain.", 409);
    matches = activeRows(header).filter((row) => row.id === detailId);
  } else {
    const key = value.toUpperCase();
    matches = activeRows(header).filter((row) => [row.partCode, row.partNumber, row.materialCode, row.stockBalanceId].some((code) => code && String(code).toUpperCase() === key));
  }
  if (!matches.length) throw invalid("Item tidak ditemukan dalam scope opname ini.", 404);
  return { stoNo: header.stoNo, ambiguous: matches.length > 1, matches: matches.map((row) => ({
    id: row.id, stockBalanceId: row.stockBalanceId, partCode: row.partCode, partNumber: row.partNumber, partName: row.partName,
    materialCode: row.materialCode, materialName: row.materialName, warehouseCode: row.warehouseCode,
    rackCode: row.rackCode, lotNumber: row.lotNumber, uomCode: row.uomCode, stockType: row.stockType,
  })) };
}

function buildStockOpnameReport(header) {
  const blind = !REVIEW_STATUSES.has(String(header.status || "").toUpperCase());
  const rows = activeRows(header).map((row, index) => ({
    no: index + 1, id: row.id, itemCode: row.materialCode || row.partCode || "", partNumber: row.partNumber || "",
    name: row.materialName || row.partName || row.description || "", stockType: row.stockType || "",
    warehouse: row.warehouseCode || header.warehouseCode, rack: row.rackCode || "", lot: row.lotNumber || "", uom: row.uomCode || "(tanpa satuan)",
    actualQty: row.actualQty, countedBy: row.countedBy || "", countedAt: date(row.countedAt), reason: row.reason || "", adjustmentNumber: row.adjustmentNumber || "",
    ...(!blind ? { systemQty: Number(row.systemQty || 0), varianceQty: row.actualQty == null ? null : Number(row.actualQty) - Number(row.systemQty || 0), varianceStatus: row.actualQty == null ? "UNCOUNTED" : row.varianceStatus, varianceAmount: row.varianceAmount } : {}),
  }));
  const totals = new Map();
  rows.forEach((row) => {
    const total = totals.get(row.uom) || { uom: row.uom, lines: 0, counted: 0, actualQty: 0, ...(!blind ? { systemQty: 0, varianceQty: 0 } : {}) };
    total.lines += 1;
    if (row.actualQty != null) { total.counted += 1; total.actualQty += Number(row.actualQty); if (!blind) total.varianceQty += row.varianceQty; }
    if (!blind) total.systemQty += row.systemQty;
    totals.set(row.uom, total);
  });
  const rounds = (header.countRounds || []).map((round) => ({ roundNo: round.roundNo, status: round.status, startedBy: round.startedBy || "", startedAt: date(round.startedAt), submittedBy: round.submittedBy || "", submittedAt: date(round.submittedAt), requestReason: round.requestReason || "", ...(!blind ? { attempts: (round.attempts || []).filter((attempt) => rows.some((row) => row.id === attempt.stoDetailId)).map((attempt) => ({ detailId: attempt.stoDetailId, sequenceNo: attempt.sequenceNo, actualQty: attempt.actualQty, countedBy: attempt.countedBy, countedAt: date(attempt.countedAt), reason: attempt.reason || "", isCurrent: attempt.isCurrent })) } : {}) }));
  const approvals = [["Dibuat", header.createdBy, header.createdAt], ["Submit", header.submittedBy, header.submittedAt], ["Checker", header.checkerBy, header.checkerApprovedAt], ["Supervisor", header.supervisorApprovedBy, header.supervisorApprovedAt], ["Inventory", header.inventoryApprovedBy, header.inventoryApprovedAt], ["Approval", header.approvedBy, header.approvedAt], ["Adjustment", header.adjustedBy, header.adjustedAt], ["Tutup", header.closedBy, header.closedAt]].map(([step, by, at]) => ({ step, by: by || "", at: date(at) }));
  return { stoNo: header.stoNo, warehouse: header.warehouseCode, type: header.stoType, status: header.status, stoDate: date(header.stoDate), currentRound: header.currentRoundNo, notes: header.notes || "", blind, rows, totals: [...totals.values()], rounds, approvals };
}

function createStockOpnameWorkbook(report) {
  const book = XLSX.utils.book_new();
  const summary = [["LAPORAN STOCK OPNAME", report.stoNo], ["Status", report.status], ["Warehouse", report.warehouse], ["Jenis", report.type], ["Tanggal", report.stoDate], ["Ronde", report.currentRound], ["Mode", report.blind ? "BLIND COUNT - qty sistem dan selisih disembunyikan" : "HASIL COUNTING"], ["Catatan", report.notes], [], ["Satuan", "Jumlah baris", "Sudah dihitung", "Qty fisik dihitung", ...(!report.blind ? ["Qty sistem", "Selisih baris dihitung"] : [])], ...report.totals.map((t) => [t.uom, t.lines, t.counted, t.actualQty, ...(!report.blind ? [t.systemQty, t.varianceQty] : [])]), [], ["Tahap", "Pelaku", "Waktu"], ...report.approvals.map((row) => [row.step, row.by, row.at])];
  const headers = ["No", "Kode item", "Part Number", "Nama", "Tipe", "Warehouse", "Rack", "Lot", "Satuan", ...(!report.blind ? ["Qty sistem"] : []), "Qty fisik", ...(!report.blind ? ["Selisih", "Status selisih"] : []), "Penghitung", "Waktu hitung", "Alasan", "No adjustment"];
  const detailRows = report.rows.map((row) => [row.no, row.itemCode, row.partNumber, row.name, row.stockType, row.warehouse, row.rack, row.lot, row.uom, ...(!report.blind ? [row.systemQty] : []), row.actualQty, ...(!report.blind ? [row.varianceQty, row.varianceStatus] : []), row.countedBy, row.countedAt, row.reason, row.adjustmentNumber]);
  const history = [["Ronde", "Status", "Mulai oleh", "Mulai", "Submit oleh", "Submit", "Alasan recount"], ...report.rounds.map((round) => [round.roundNo, round.status, round.startedBy, round.startedAt, round.submittedBy, round.submittedAt, round.requestReason])];
  if (!report.blind) history.push([], ["Ronde", "Detail", "Urutan", "Qty fisik", "Penghitung", "Waktu", "Alasan", "Aktif"], ...report.rounds.flatMap((round) => round.attempts.map((attempt) => [round.roundNo, attempt.detailId, attempt.sequenceNo, attempt.actualQty, attempt.countedBy, attempt.countedAt, attempt.reason, attempt.isCurrent ? "Ya" : "Tidak"])));
  for (const [name, data, widths] of [["Ringkasan", summary, [30, 44, 28, 25, 22, 26]], ["Detail", [headers, ...detailRows], [8, 23, 23, 40, 19, 18, 18, 23, 14]], ["Riwayat", history, [12, 40, 25, 26, 25, 26, 45, 15]]]) {
    const sheet = XLSX.utils.aoa_to_sheet(data); sheet["!cols"] = Array.from({ length: Math.max(...data.map((row) => row.length)) }, (_, i) => ({ wch: widths[i] || 23 }));
    if (name === "Detail") sheet["!autofilter"] = { ref: sheet["!ref"] };
    for (const [key, cell] of Object.entries(sheet)) if (!key.startsWith("!") && cell.t === "n") cell.z = "#,##0.###;[Red](#,##0.###);-";
    XLSX.utils.book_append_sheet(book, sheet, name);
  }
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

function newPdf(title, landscape = false) {
  const doc = new PDFDocument({ size: "A4", layout: landscape ? "landscape" : "portrait", margin: 34, bufferPages: true, info: { Title: title } });
  const chunks = []; const result = new Promise((resolve, reject) => { doc.on("data", (chunk) => chunks.push(chunk)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject); });
  return { doc, result };
}
async function createStockOpnamePdf(report) {
  const { doc, result } = newPdf(`Stock Opname ${report.stoNo}`, true);
  const left = 34; const width = 774; const bottom = 530; let y = 34;
  function heading(section) {
    doc.font("Helvetica-Bold").fontSize(17).fillColor("#173957").text("LAPORAN STOCK OPNAME", left, 30, { width });
    doc.font("Helvetica").fontSize(9).text(`${report.stoNo} | ${report.warehouse} | ${report.status} | Ronde ${report.currentRound || 1}`, left, 56, { width });
    doc.fontSize(9).text(report.blind ? "BLIND COUNT - Qty sistem dan selisih disembunyikan sampai submit." : "Hasil counting, selisih, dan keterlacakan approval.", left, 72, { width });
    doc.font("Helvetica-Bold").fontSize(11).text(section, left, 95, { width }); y = 117;
  }
  const ensureSpace = (height, section) => { if (y + height > bottom) { doc.addPage(); heading(section); return true; } return false; };
  function table(title, columns, values) {
    heading(title);
    const widths = columns.map((c) => c.width); let tableY;
    const drawHeaders = () => {
      doc.fillColor("#e6edf4").rect(left, y, width, 25).fill(); let x = left;
      columns.forEach((c) => { doc.fillColor("#173957").font("Helvetica-Bold").fontSize(8).text(c.label, x + 4, y + 8, { width: c.width - 8 }); x += c.width; }); y += 25;
    };
    drawHeaders();
    values.forEach((values, index) => {
      doc.font("Helvetica").fontSize(8);
      const rowHeight = Math.max(25, ...values.map((value, i) => doc.heightOfString(clean(value), { width: widths[i] - 8 }) + 12));
      if (ensureSpace(rowHeight, title)) drawHeaders();
      tableY = y; let x = left;
      if (index % 2) doc.fillColor("#f5f8fb").rect(left, y, width, rowHeight).fill();
      values.forEach((value, i) => { doc.fillColor("#173957").font("Helvetica").fontSize(8).text(clean(value), x + 4, tableY + 6, { width: widths[i] - 8 }); x += widths[i]; }); y = tableY + rowHeight;
    });
  }
  const columns = [{ label: "No", width: 27 }, { label: "Kode / Part No", width: 125 }, { label: "Nama", width: 161 }, { label: "Rack / Lot", width: 118 }, { label: "Satuan", width: 48 }, ...(!report.blind ? [{ label: "Sistem", width: 66 }] : []), { label: "Fisik", width: 66 }, ...(!report.blind ? [{ label: "Selisih", width: 66 }] : []), { label: "Penghitung", width: report.blind ? 229 : 97 }];
  table("Detail seluruh item aktif", columns, report.rows.map((r) => [r.no, [r.itemCode, r.partNumber].filter(Boolean).join("\n"), r.name, [r.rack || "Tanpa rack", r.lot || "Tanpa lot"].join("\n"), r.uom, ...(!report.blind ? [qty(r.systemQty)] : []), qty(r.actualQty), ...(!report.blind ? [qty(r.varianceQty)] : []), r.countedBy]));
  doc.addPage();
  table("Ringkasan per satuan (qty tidak dijumlahkan lintas satuan)", [{ label: "Satuan", width: 110 }, { label: "Baris / dihitung", width: 130 }, { label: "Qty fisik dihitung", width: 180 }, ...(!report.blind ? [{ label: "Qty sistem", width: 177 }, { label: "Selisih baris dihitung", width: 177 }] : [{ label: "Keterangan", width: 354 }])], report.totals.map((t) => [t.uom, `${t.lines} / ${t.counted}`, qty(t.actualQty), ...(!report.blind ? [qty(t.systemQty), qty(t.varianceQty)] : ["Qty sistem disembunyikan"])]));
  y += 18; ensureSpace(180, "Approval dan audit");
  doc.font("Helvetica-Bold").fontSize(11).text("Approval dan audit", left, y); y += 24;
  report.approvals.forEach((r) => { ensureSpace(19, "Approval dan audit"); doc.font("Helvetica").fontSize(9).text(`${r.step}: ${r.by || "-"} | ${r.at || "-"}`, left, y, { width }); y += 19; });
  const annotated = report.rows.filter((row) => row.reason || row.adjustmentNumber);
  if (annotated.length) {
    doc.addPage();
    table("Alasan selisih dan referensi adjustment", [{ label: "No / Kode", width: 170 }, { label: "Alasan", width: 404 }, { label: "No adjustment", width: 200 }], annotated.map((row) => [`${row.no} / ${row.itemCode}`, row.reason, row.adjustmentNumber]));
  }
  if (report.rounds.length) {
    doc.addPage();
    const history = report.rounds.flatMap((round) => !report.blind && round.attempts?.length ? round.attempts.map((a) => [round.roundNo, a.detailId, qty(a.actualQty), a.countedBy, a.countedAt, a.reason]) : [[round.roundNo, round.status, "", round.startedBy, round.startedAt, round.requestReason]]);
    table("Riwayat ronde / hitungan", [{ label: "Ronde", width: 50 }, { label: "Detail / Status", width: 204 }, { label: "Fisik", width: 60 }, { label: "Petugas", width: 100 }, { label: "Waktu", width: 160 }, { label: "Alasan", width: 200 }], history);
  }
  const pages = doc.bufferedPageRange();
  for (let page = 0; page < pages.count; page += 1) { doc.switchToPage(page); doc.font("Helvetica").fontSize(8).fillColor("#64748b").text(`${report.stoNo} | ${page + 1} / ${pages.count}`, left, 545, { width, align: "center", lineBreak: false }); }
  doc.end(); return result;
}

async function createStockOpnameLabels(header) {
  const { doc, result } = newPdf(`Label Opname ${header.stoNo}`);
  const rows = activeRows(header); const left = 34; const labelWidth = 257; const labelHeight = 174;
  doc.font("Helvetica-Bold").fontSize(13).text(`LABEL STOCK OPNAME - ${header.stoNo}`, left, 28, { width: 526 });
  for (let index = 0; index < rows.length; index += 1) {
    if (index && index % 8 === 0) { doc.addPage(); doc.font("Helvetica-Bold").fontSize(13).text(`LABEL STOCK OPNAME - ${header.stoNo}`, left, 28, { width: 526 }); }
    const row = rows[index]; const slot = index % 8; const x = left + (slot % 2) * (labelWidth + 10); const y = 65 + Math.floor(slot / 2) * (labelHeight + 10);
    const qr = await createQrPng(stockOpnameReference(header.stoNo, row.id));
    doc.strokeColor("#d8e1eb").rect(x, y, labelWidth, labelHeight).stroke();
    doc.image(qr, x + 7, y + 9, { width: 100 });
    doc.fillColor("#173957").font("Helvetica-Bold").fontSize(9).text(clean(row.materialCode || row.partNumber || row.partCode || "Item"), x + 110, y + 15, { width: 138, height: 39, ellipsis: true });
    doc.font("Helvetica").fontSize(8).text(`Warehouse: ${clean(row.warehouseCode)}\nRack: ${clean(row.rackCode || "-")}\nLot: ${clean(row.lotNumber || "-")}\nUOM: ${clean(row.uomCode || "-")}`, x + 110, y + 60, { width: 138 });
    doc.fontSize(8).text(clean(row.partName || row.materialName || row.description || ""), x + 10, y + 116, { width: labelWidth - 20, height: 36, ellipsis: true });
    doc.fontSize(7).text(`${index + 1} | ${header.stoNo}`, x + 10, y + 155, { width: labelWidth - 20 });
  }
  doc.end(); return result;
}
module.exports = { buildStockOpnameReport, createStockOpnameWorkbook, createStockOpnamePdf, createStockOpnameLabels, stockOpnameReference, resolveStockOpnameScan };
