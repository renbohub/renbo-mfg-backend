const PDFDocument = require("pdfkit");
const { createQrPng } = require("../documents/qrCodeService");
const { resolveEvidence } = require("./deliveryEvidenceService");
const fs = require("fs/promises");

const PREFIX = "ERP:DELIVERY:";
const number = (value) => new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 }).format(Number(value) || 0);
const date = (value) => value ? new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeZone: "Asia/Jakarta" }).format(new Date(value)) : "-";
const display = (value) => String(value || "-").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
function parseDeliveryReference(value) {
  const reference = String(value || "").trim();
  const scheduleNumber = reference.startsWith(PREFIX) ? reference.slice(PREFIX.length) : reference;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(scheduleNumber)) throw Object.assign(new Error("Scan QR surat jalan atau masukkan nomor Delivery Schedule yang valid."), { statusCode: 400 });
  return scheduleNumber;
}
function deliveryReference(scheduleNumber) { return `${PREFIX}${parseDeliveryReference(scheduleNumber)}`; }

async function createDeliveryNotePdf(schedule) {
  const qr = await createQrPng(deliveryReference(schedule.scheduleNumber));
  let signature;
  if (String(schedule.receivedSignature || "").startsWith("private-delivery:")) {
    signature = await fs.readFile(resolveEvidence(schedule.receivedSignature).path).catch(() => null);
  }
  const doc = new PDFDocument({ size: "A4", margin: 42, bufferPages: true, info: { Title: `Surat Jalan ${schedule.scheduleNumber}`, Author: "PT. Mitsutoyo Indonesia" } });
  const chunks = [];
  const completed = new Promise((resolve, reject) => { doc.on("data", (chunk) => chunks.push(chunk)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject); });
  const left = 42; const right = 553; const width = right - left; const tableBottom = 745;
  let y = 42;
  const header = (continued = false) => {
    doc.fillColor("#122d48").font("Helvetica-Bold").fontSize(14).text("PT. MITSUTOYO INDONESIA", left, 42, { width: 380 });
    doc.fontSize(20).text("SURAT JALAN", left, 66, { width: 380 });
    doc.font("Helvetica").fontSize(9).fillColor("#334155").text(`${schedule.scheduleNumber}${continued ? " / lanjutan" : ""}`, left, 92, { width: 370 });
    doc.image(qr, right - 84, 38, { width: 84 });
    doc.fontSize(7).text("Scan di menu Scan Surat Jalan", right - 122, 125, { width: 124, align: "center" });
    y = 147;
  };
  const field = (label, value) => {
    const text = display(value);
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#334155").text(label, left, y, { width: 105 });
    doc.font("Helvetica").text(text, left + 112, y, { width: width - 112 });
    y += Math.max(13, doc.heightOfString(text, { width: width - 112 })) + 5;
  };
  const columns = [{ x: left, width: 30, label: "No" }, { x: left + 30, width: 128, label: "Kode / Part Number" }, { x: left + 158, width: 230, label: "Nama Barang" }, { x: left + 388, width: 68, label: "Qty", align: "right" }, { x: left + 456, width: 55, label: "Satuan" }];
  const tableHeader = () => {
    doc.fillColor("#e9eff5").rect(left, y, width, 24).fill();
    doc.fillColor("#122d48").font("Helvetica-Bold").fontSize(8);
    columns.forEach((column) => doc.text(column.label, column.x + 5, y + 8, { width: column.width - 10, align: column.align || "left" }));
    y += 24;
  };
  header();
  field("Referensi Sales Order", schedule.soNumber);
  field("Customer", [schedule.soHeader?.customerCode, schedule.soHeader?.customerName].filter(Boolean).join(" / "));
  field("Alamat tujuan", schedule.deliveryAddress || schedule.soHeader?.shippingAddress);
  field("Tanggal rencana / kirim", `${date(schedule.plannedDate)} / ${date(schedule.shippedAt)}`);
  field("Pengemudi / ekspedisi", [schedule.driver, schedule.carrier].filter(Boolean).join(" / "));
  field("Kendaraan / resi", [schedule.vehicle, schedule.trackingNumber].filter(Boolean).join(" / "));
  field("Status", schedule.status);
  y += 8;
  tableHeader();
  const lines = (schedule.details || []).filter((line) => !line.isDeleted);
  lines.forEach((line, index) => {
    const part = line.soDetail || {};
    const values = [String(index + 1), [part.partCode, part.partNumber && part.partNumber !== part.partCode ? part.partNumber : null].filter(Boolean).join("\n") || "-", display(part.partName), number(line.qty), display(part.uomCode)];
    doc.font("Helvetica").fontSize(9);
    const rowHeight = Math.max(28, ...values.map((value, col) => doc.heightOfString(value, { width: columns[col].width - 10 }) + 14));
    if (y + rowHeight > tableBottom) { doc.addPage(); header(true); tableHeader(); }
    if (index % 2) doc.fillColor("#f8fafc").rect(left, y, width, rowHeight).fill();
    doc.fillColor("#172b40").font("Helvetica").fontSize(9);
    columns.forEach((column, col) => doc.text(values[col], column.x + 5, y + 7, { width: column.width - 10, align: column.align || "left" }));
    y += rowHeight;
    doc.strokeColor("#dce4eb").lineWidth(0.4).moveTo(left, y).lineTo(right, y).stroke();
  });
  if (y + 176 > tableBottom) { doc.addPage(); header(true); }
  y += 15;
  doc.font("Helvetica").fontSize(9).fillColor("#334155").text(`${lines.length} jenis barang. Kuantitas mengikuti satuan pada setiap baris.`, left, y, { width });
  y += 24;
  if (schedule.notes) {
    const note = `Catatan: ${display(schedule.notes)}`;
    const noteHeight = doc.heightOfString(note, { width });
    if (y + noteHeight + 120 > tableBottom) { doc.addPage(); header(true); }
    doc.text(note, left, y, { width }); y += noteHeight + 18;
  }
  const sigY = y;
  doc.font("Helvetica-Bold").text("Diserahkan oleh", left, sigY, { width: 200, align: "center" });
  doc.text("Diterima oleh", right - 200, sigY, { width: 200, align: "center" });
  if (signature) doc.image(signature, right - 190, sigY + 17, { fit: [180, 54], align: "center" });
  doc.font("Helvetica").text(display(schedule.driver || schedule.deliveredBy), left, sigY + 77, { width: 200, align: "center" });
  doc.text(display(schedule.receivedBy), right - 200, sigY + 77, { width: 200, align: "center" });
  doc.fontSize(8).text(`Tanggal diterima: ${date(schedule.deliveredAt)}`, right - 200, sigY + 93, { width: 200, align: "center" });
  const pages = doc.bufferedPageRange();
  for (let page = 0; page < pages.count; page += 1) {
    doc.switchToPage(page);
    doc.font("Helvetica").fontSize(8).fillColor("#64748b").text(`${schedule.scheduleNumber} | ${schedule.status} | ${page + 1} / ${pages.count}`, left, 787, { width, align: "center", lineBreak: false });
  }
  doc.end();
  return completed;
}

module.exports = { createDeliveryNotePdf, deliveryReference, parseDeliveryReference };
