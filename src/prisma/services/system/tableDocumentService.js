const PDFDocument = require("pdfkit");
const XLSX = require("xlsx");

const MAX_ROWS = 10000;
const MAX_COLUMNS = 80;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_IN_TEXT_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const cleanText = (value) => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
const safeFileName = (value, fallback = "erp-export") => cleanText(value || fallback).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 100) || fallback;
const humanDate = () => new Intl.DateTimeFormat("id-ID", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date());

function normalizeCell(value) {
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean" || value instanceof Date) return value;
  if (typeof value === "object") return cleanText(JSON.stringify(value));
  const text = cleanText(value);
  return UUID_PATTERN.test(text) ? "" : text.replace(UUID_IN_TEXT_PATTERN, "").replace(/\s{2,}/g, " ").trim();
}

function normalizeTable(payload = {}) {
  const headers = (Array.isArray(payload.headers) ? payload.headers : []).slice(0, MAX_COLUMNS).map((value, index) => cleanText(value) || `Kolom ${index + 1}`);
  if (!headers.length) throw Object.assign(new Error("Header tabel tidak tersedia."), { status: 400 });
  const rows = (Array.isArray(payload.rows) ? payload.rows : []).slice(0, MAX_ROWS).map((row) => {
    const values = Array.isArray(row) ? row : [];
    return headers.map((_header, index) => normalizeCell(values[index]));
  });
  return {
    title: cleanText(payload.title) || "ERP Table Export",
    subtitle: cleanText(payload.subtitle),
    headers,
    rows,
    fileName: safeFileName(payload.fileName || payload.title),
  };
}

function typedCell(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text || /^0\d+/.test(text) || /(?:code|number|no\.?|kode)/i.test(text)) return value;
  const normalized = text.replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  return /^-?\d+(?:[.,]\d+)?$/.test(text) && Number.isFinite(Number(normalized)) ? Number(normalized) : value;
}

function buildXlsx(payload) {
  const table = normalizeTable(payload);
  const generated = `Dibuat ${humanDate()} | ${table.rows.length.toLocaleString("id-ID")} baris`;
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title: table.title, Subject: "RENBO ERP management export", Author: "RENBO ERP", CreatedDate: new Date() };
  const sourceSheets = Array.isArray(payload.sheets) && payload.sheets.length ? payload.sheets : [{ name: "Data", headers: table.headers, rows: table.rows }];
  sourceSheets.slice(0, 12).forEach((source, sheetIndex) => {
    const headers = (Array.isArray(source.headers) ? source.headers : table.headers).slice(0, MAX_COLUMNS).map(cleanText);
    const rows = (Array.isArray(source.rows) ? source.rows : []).slice(0, MAX_ROWS).map((row) => headers.map((_header, index) => normalizeCell(row[index])));
    const groupHeaders = Array.isArray(source.groupHeaders) ? source.groupHeaders : (sheetIndex === 0 && Array.isArray(payload.groupHeaders) ? payload.groupHeaders : []);
    const groupRow = headers.map(() => "");
    groupHeaders.forEach((group) => { const start = Number(group.start); if (start >= 0 && start < headers.length) groupRow[start] = cleanText(group.label); });
    const data = [[sheetIndex ? cleanText(source.title || source.name) : table.title], [cleanText(source.subtitle) || table.subtitle || generated], [], ...(groupHeaders.length ? [groupRow] : []), headers, ...rows.map((row) => row.map(typedCell))];
    const sheet = XLSX.utils.aoa_to_sheet(data, { cellDates: true });
    const headerRowIndex = groupHeaders.length ? 4 : 3;
    sheet["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(headers.length - 1, 0) } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: Math.max(headers.length - 1, 0) } },
      ...groupHeaders.map((group) => ({ s: { r: 3, c: Number(group.start) }, e: { r: 3, c: Math.min(headers.length - 1, Number(group.start) + Math.max(1, Number(group.span) || 1) - 1) } })),
    ];
    sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ r: headerRowIndex, c: 0 }, { r: headerRowIndex + rows.length, c: Math.max(headers.length - 1, 0) }) };
    sheet["!cols"] = headers.map((header, index) => {
      const length = Math.max(header.length, ...rows.slice(0, 300).map((row) => cleanText(row[index]).length));
      return { wch: Math.max(10, Math.min(42, length + 2)) };
    });
    sheet["!rows"] = [{ hpt: 24 }, { hpt: 22 }, { hpt: 8 }, ...(groupHeaders.length ? [{ hpt: 20 }] : []), { hpt: 22 }];
    sheet["!margins"] = { left: 0.25, right: 0.25, top: 0.45, bottom: 0.45, header: 0.2, footer: 0.2 };
    sheet["!pageSetup"] = { orientation: headers.length > 7 ? "landscape" : "portrait", fitToWidth: 1, fitToHeight: 0, paperSize: headers.length > 12 ? 8 : 9 };
    sheet["!printHeader"] = [headerRowIndex, headerRowIndex];
    const name = cleanText(source.name || `Sheet ${sheetIndex + 1}`).replace(/[\\/?*\[\]:]/g, " ").slice(0, 31) || `Sheet ${sheetIndex + 1}`;
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  });
  return { buffer: XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true }), fileName: `${table.fileName}.xlsx` };
}

function buildTemplate(payload = {}) {
  const title = cleanText(payload.title) || "Template Import Master Data";
  const fields = (Array.isArray(payload.fields) ? payload.fields : []).slice(0, MAX_COLUMNS).filter((field) => field && field.name && field.label);
  if (!fields.length) throw Object.assign(new Error("Field template tidak tersedia."), { status: 400 });
  const headers = fields.map((field) => cleanText(field.label));
  const example = fields.map((field) => normalizeCell(field.example ?? ""));
  const dataSheet = XLSX.utils.aoa_to_sheet([headers, example]);
  dataSheet["!autofilter"] = { ref: XLSX.utils.encode_range({ r: 0, c: 0 }, { r: 1, c: fields.length - 1 }) };
  dataSheet["!cols"] = fields.map((field) => ({ wch: Math.max(14, Math.min(40, cleanText(field.label).length + 6)) }));
  const guideRows = [
    [title],
    ["Petunjuk", "Isi sheet 'Data Import' mulai baris kedua. Hapus baris contoh bila tidak diperlukan."],
    ["Lookup", "Gunakan code, name, atau number yang tersedia di master terkait. Jangan memasukkan database ID/UUID."],
    ["Tanggal", "Gunakan format YYYY-MM-DD. Angka disimpan sebagai nilai angka, bukan teks berformat."],
    [],
    ["Nama Kolom", "Field Sistem", "Tipe", "Wajib", "Lookup / Pilihan", "Keterangan"],
    ...fields.map((field) => [field.label, field.name, field.type || "text", field.required ? "Ya" : "Tidak", field.lookupLabel || field.options || "", field.help || ""]),
  ];
  const guideSheet = XLSX.utils.aoa_to_sheet(guideRows);
  guideSheet["!cols"] = [{ wch: 28 }, { wch: 24 }, { wch: 15 }, { wch: 10 }, { wch: 40 }, { wch: 65 }];
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title: title, Subject: "RENBO ERP master-data import template", Author: "RENBO ERP", CreatedDate: new Date() };
  XLSX.utils.book_append_sheet(workbook, dataSheet, "Data Import");
  XLSX.utils.book_append_sheet(workbook, guideSheet, "Petunjuk");
  return { buffer: XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true }), fileName: `${safeFileName(payload.fileName || title)}.xlsx` };
}

function parseWorkbook(file) {
  if (!file?.buffer?.length) throw Object.assign(new Error("File Excel wajib dipilih."), { status: 400 });
  let workbook;
  try { workbook = XLSX.read(file.buffer, { type: "buffer", cellDates: true, raw: false }); }
  catch (_error) { throw Object.assign(new Error("Workbook tidak dapat dibaca. Gunakan format .xlsx, .xls, atau .csv yang valid."), { status: 400 }); }
  const sheetName = workbook.SheetNames.find((name) => name.toLowerCase() === "data import") || workbook.SheetNames[0];
  const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false, blankrows: false });
  const headerIndex = matrix.findIndex((row) => Array.isArray(row) && row.some((cell) => cleanText(cell)));
  if (headerIndex < 0) throw Object.assign(new Error("Workbook tidak memiliki header."), { status: 400 });
  const headers = matrix[headerIndex].map(cleanText);
  const rows = matrix.slice(headerIndex + 1).filter((row) => row.some((cell) => cleanText(cell))).slice(0, MAX_ROWS).map((row, offset) => ({
    rowNumber: headerIndex + offset + 2,
    values: headers.map((_header, index) => normalizeCell(row[index])),
  }));
  return { fileName: cleanText(file.originalname), sheetName, headers, rows, totalRows: rows.length, truncated: rows.length >= MAX_ROWS };
}

function buildPdf(payload) {
  const table = normalizeTable(payload);
  return new Promise((resolve, reject) => {
    const requestedPageSize = ["A4", "A3"].includes(String(payload.pageSize || "").toUpperCase()) ? String(payload.pageSize).toUpperCase() : null;
    const doc = new PDFDocument({ size: requestedPageSize || (table.headers.length > 8 ? "A3" : "A4"), layout: "landscape", margins: { top: 30, right: 26, bottom: 34, left: 26 }, bufferPages: true, info: { Title: table.title, Author: "RENBO ERP" } });
    const pdfBuffers = [];
    doc.on("data", (chunk) => pdfBuffers.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve({ buffer: Buffer.concat(pdfBuffers), fileName: `${table.fileName}.pdf` }));
    const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const chunkSize = payload.keepColumnsTogether ? table.headers.length : Math.min(Math.max(Number(payload.maxColumnsPerPanel) || 12, 4), 20);
    const chunks = [];
    for (let start = 0; start < table.headers.length; start += chunkSize) chunks.push({ start, end: Math.min(start + chunkSize, table.headers.length) });
    let activeChunk = chunks[0];
    let activeHeaders = table.headers.slice(activeChunk.start, activeChunk.end);
    const sourceWeights = Array.isArray(payload.columnWidths) ? payload.columnWidths.map((value) => Math.max(number(value), 0.1)) : [];
    const sourceAlignments = Array.isArray(payload.alignments) ? payload.alignments.map((value) => ["left", "center", "right"].includes(value) ? value : "left") : [];
    const calculateWidths = (chunk) => {
      const weights = table.headers.slice(chunk.start, chunk.end).map((_header, localIndex) => sourceWeights[chunk.start + localIndex] || 1);
      const totalWeight = weights.reduce((sum, value) => sum + value, 0) || weights.length;
      return weights.map((value) => usableWidth * value / totalWeight);
    };
    let widths = calculateWidths(activeChunk);
    let alignments = activeHeaders.map((_header, index) => sourceAlignments[activeChunk.start + index] || "left");
    let summaryDrawn = false;
    const bodyFontSize = Math.max(5.5, Math.min(8, number(payload.bodyFontSize) || (table.headers.length > 12 ? 6.1 : 7)));
    const headerFontSize = Math.max(5.8, Math.min(8.5, number(payload.headerFontSize) || (table.headers.length > 12 ? 6.4 : 7.3)));
    const rowHeight = (row, header = false) => Math.min(header ? 36 : 40, Math.max(header ? 25 : 20, ...row.map((cell, index) => {
      doc.font(header ? "Helvetica-Bold" : "Helvetica").fontSize(header ? headerFontSize : bodyFontSize);
      return doc.heightOfString(cleanText(cell) || "-", { width: Math.max(widths[index] - 8, 8), align: alignments[index] || "left" }) + 8;
    })));
    const drawRow = (row, y, header = false, stripe = false) => {
      const height = rowHeight(row, header);
      doc.save().fillColor(header ? "#E8EDFF" : stripe ? "#F8FAFC" : "#FFFFFF").rect(doc.page.margins.left, y, usableWidth, height).fill().restore();
      let x = doc.page.margins.left;
      row.forEach((cell, index) => {
        doc.rect(x, y, widths[index], height).strokeColor("#D7DDE7").lineWidth(0.45).stroke();
        doc.fillColor(header ? "#2438A3" : "#101828").font(header ? "Helvetica-Bold" : "Helvetica").fontSize(header ? headerFontSize : bodyFontSize)
          .text(cleanText(cell) || "-", x + 4, y + 5, { width: Math.max(widths[index] - 8, 8), height: height - 8, ellipsis: true, align: alignments[index] || "left" });
        x += widths[index];
      });
      return height;
    };
    const drawGroupHeaders = (y) => {
      const groups = (Array.isArray(payload.groupHeaders) ? payload.groupHeaders : []).filter((group) => {
        const start = Number(group.start); const span = Math.max(1, Number(group.span) || 1);
        return start >= activeChunk.start && start + span <= activeChunk.end;
      });
      if (!groups.length) return y;
      const height = 18;
      let x = doc.page.margins.left;
      widths.forEach((width) => { doc.rect(x, y, width, height).fillAndStroke("#F8FAFC", "#D7DDE7"); x += width; });
      groups.forEach((group) => {
        const localStart = Number(group.start) - activeChunk.start;
        const span = Math.max(1, Number(group.span) || 1);
        const groupX = doc.page.margins.left + widths.slice(0, localStart).reduce((sum, value) => sum + value, 0);
        const groupWidth = widths.slice(localStart, localStart + span).reduce((sum, value) => sum + value, 0);
        doc.rect(groupX, y, groupWidth, height).fillAndStroke("#DDE5FF", "#AEBBEF");
        doc.fillColor("#2438A3").font("Helvetica-Bold").fontSize(7.3).text(cleanText(group.label), groupX + 4, y + 5, { width: groupWidth - 8, align: "center", lineBreak: false });
      });
      return y + height;
    };
    const drawHeader = (panelIndex) => {
      // PDFKit keeps the last explicit text cursor when a page is added. Reset it
      // so continuation pages always start below the configured top margin.
      doc.x = doc.page.margins.left;
      doc.y = doc.page.margins.top;
      doc.fillColor("#4F46E5").font("Helvetica-Bold").fontSize(6.5).text(cleanText(payload.documentLabel || "RENBO ERP - MANAGEMENT REPORT"), { width: usableWidth, characterSpacing: 0.7 });
      doc.moveDown(0.25);
      doc.fillColor("#111827").font("Helvetica-Bold").fontSize(15).text(table.title, { width: usableWidth });
      const panel = chunks.length > 1 ? ` | Panel kolom ${panelIndex + 1}/${chunks.length}` : "";
      doc.fillColor("#667085").font("Helvetica").fontSize(7.5).text(`${table.subtitle || `Dibuat ${humanDate()} | ${table.rows.length.toLocaleString("id-ID")} baris`}${panel}`, { width: usableWidth });
      if (panelIndex === 0 && !summaryDrawn && Array.isArray(payload.summary) && payload.summary.length) {
        const cards = payload.summary.slice(0, 8);
        const cardWidth = usableWidth / Math.min(cards.length, 4);
        const summaryY = doc.y + 4;
        cards.forEach((card, index) => {
          const column = index % 4; const row = Math.floor(index / 4);
          const x = doc.page.margins.left + column * cardWidth; const cardY = summaryY + row * 34;
          doc.roundedRect(x, cardY, cardWidth - 6, 29, 3).fillAndStroke("#F8FAFC", "#D7DDE7");
          doc.fillColor("#667085").font("Helvetica").fontSize(6.5).text(cleanText(card.label).toUpperCase(), x + 6, cardY + 5, { width: cardWidth - 18 });
          doc.fillColor("#101828").font("Helvetica-Bold").fontSize(9).text(cleanText(card.value) || "-", x + 6, cardY + 15, { width: cardWidth - 18 });
        });
        doc.y = summaryY + Math.ceil(cards.length / 4) * 34;
        summaryDrawn = true;
      }
      const y = drawGroupHeaders(doc.y + 8);
      return y + drawRow(activeHeaders, y, true);
    };
    chunks.forEach((chunk, panelIndex) => {
      activeChunk = chunk;
      activeHeaders = table.headers.slice(chunk.start, chunk.end);
      widths = calculateWidths(chunk);
      alignments = activeHeaders.map((_header, index) => sourceAlignments[chunk.start + index] || "left");
      if (panelIndex > 0) doc.addPage();
      let y = drawHeader(panelIndex);
      table.rows.forEach((sourceRow, index) => {
        const row = sourceRow.slice(chunk.start, chunk.end);
        const required = rowHeight(row);
        if (y + required > doc.page.height - doc.page.margins.bottom - 14) { doc.addPage(); y = drawHeader(panelIndex); }
        y += drawRow(row, y, false, index % 2 === 1);
      });
    });
    const appendixSections = Array.isArray(payload.sections) ? payload.sections.slice(0, 8) : [];
    appendixSections.forEach((source, sectionIndex) => {
      const section = normalizeTable(source);
      const sectionKeepTogether = source.keepColumnsTogether !== false;
      const sectionChunkSize = sectionKeepTogether ? section.headers.length : Math.min(Math.max(Number(source.maxColumnsPerPanel) || 12, 4), 20);
      const sectionChunks = [];
      for (let start = 0; start < section.headers.length; start += sectionChunkSize) sectionChunks.push({ start, end: Math.min(start + sectionChunkSize, section.headers.length) });
      sectionChunks.forEach((sectionChunk, panelIndex) => {
        doc.addPage();
        const sectionHeaders = section.headers.slice(sectionChunk.start, sectionChunk.end);
        const weights = sectionHeaders.map((_header, localIndex) => Math.max(number(source.columnWidths?.[sectionChunk.start + localIndex]) || 1, 0.1));
        const totalWeight = weights.reduce((sum, value) => sum + value, 0) || weights.length;
        const sectionWidths = weights.map((value) => usableWidth * value / totalWeight);
        const sectionAlignments = sectionHeaders.map((_header, localIndex) => {
          const value = source.alignments?.[sectionChunk.start + localIndex];
          return ["left", "center", "right"].includes(value) ? value : "left";
        });
        const sectionBodyFontSize = Math.max(5.5, Math.min(8, number(source.bodyFontSize) || (sectionHeaders.length > 12 ? 6.1 : 7)));
        const sectionHeaderFontSize = Math.max(5.8, Math.min(8.5, number(source.headerFontSize) || (sectionHeaders.length > 12 ? 6.4 : 7.3)));
        const sectionRowHeight = (row, header = false) => Math.min(header ? 36 : 40, Math.max(header ? 25 : 20, ...row.map((cell, index) => {
          doc.font(header ? "Helvetica-Bold" : "Helvetica").fontSize(header ? sectionHeaderFontSize : sectionBodyFontSize);
          return doc.heightOfString(cleanText(cell) || "-", { width: Math.max(sectionWidths[index] - 8, 8), align: sectionAlignments[index] || "left" }) + 8;
        })));
        const sectionDrawRow = (row, y, header = false, stripe = false) => {
          const height = sectionRowHeight(row, header);
          doc.save().fillColor(header ? "#E8EDFF" : stripe ? "#F8FAFC" : "#FFFFFF").rect(doc.page.margins.left, y, usableWidth, height).fill().restore();
          let x = doc.page.margins.left;
          row.forEach((cell, index) => {
            doc.rect(x, y, sectionWidths[index], height).strokeColor("#D7DDE7").lineWidth(0.45).stroke();
            doc.fillColor(header ? "#2438A3" : "#101828").font(header ? "Helvetica-Bold" : "Helvetica").fontSize(header ? sectionHeaderFontSize : sectionBodyFontSize)
              .text(cleanText(cell) || "-", x + 4, y + 5, { width: Math.max(sectionWidths[index] - 8, 8), height: height - 8, ellipsis: true, align: sectionAlignments[index] || "left" });
            x += sectionWidths[index];
          });
          return height;
        };
        const sectionHeader = () => {
          doc.x = doc.page.margins.left;
          doc.y = doc.page.margins.top;
          doc.fillColor("#4F46E5").font("Helvetica-Bold").fontSize(6.5).text(cleanText(source.documentLabel || payload.documentLabel || "RENBO ERP - MANAGEMENT REPORT"), { width: usableWidth, characterSpacing: 0.7 });
          doc.moveDown(0.25);
          doc.fillColor("#111827").font("Helvetica-Bold").fontSize(15).text(section.title, { width: usableWidth });
          const panel = sectionChunks.length > 1 ? ` | Panel kolom ${panelIndex + 1}/${sectionChunks.length}` : "";
          doc.fillColor("#667085").font("Helvetica").fontSize(7.5).text(`${section.subtitle || `Lampiran ${sectionIndex + 1}`}${panel}`, { width: usableWidth });
          const y = doc.y + 8;
          return y + sectionDrawRow(sectionHeaders, y, true);
        };
        let sectionY = sectionHeader();
        section.rows.forEach((sourceRow, index) => {
          const row = sourceRow.slice(sectionChunk.start, sectionChunk.end);
          const required = sectionRowHeight(row);
          if (sectionY + required > doc.page.height - doc.page.margins.bottom - 14) { doc.addPage(); sectionY = sectionHeader(); }
          sectionY += sectionDrawRow(row, sectionY, false, index % 2 === 1);
        });
      });
    });
    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      doc.switchToPage(index);
      doc.fillColor("#667085").font("Helvetica").fontSize(7).text(`RENBO ERP | Dicetak ${humanDate()} | Halaman ${index + 1}/${range.count}`, doc.page.margins.left, doc.page.height - doc.page.margins.bottom - 16, { width: usableWidth, align: "right", lineBreak: false });
    }
    doc.end();
  });
}

function imageBuffer(dataUrl) {
  const match = String(dataUrl || "").match(/^data:image\/(png|jpeg);base64,([a-z0-9+/=\r\n]+)$/i);
  if (!match) throw Object.assign(new Error("Gambar bagan BOM tidak valid."), { status: 400 });
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 45 * 1024 * 1024) throw Object.assign(new Error("Ukuran gambar bagan BOM tidak valid."), { status: 400 });
  return buffer;
}

function buildImagePdf(payload = {}) {
  const imageInputs = Array.isArray(payload.imagesDataUrls) && payload.imagesDataUrls.length
    ? payload.imagesDataUrls.slice(0, 60)
    : [payload.imageDataUrl];
  const images = imageInputs.map(imageBuffer);
  if (images.reduce((sum, image) => sum + image.length, 0) > 60 * 1024 * 1024) throw Object.assign(new Error("Total gambar bagan BOM terlalu besar."), { status: 400 });
  const title = cleanText(payload.title) || "BOM Diagram";
  const subtitle = cleanText(payload.subtitle);
  const fileName = safeFileName(payload.fileName || title);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A3", layout: "landscape", margins: { top: 30, right: 26, bottom: 32, left: 26 }, bufferPages: true, info: { Title: title, Author: "RENBO ERP" } });
    const buffers = [];
    doc.on("data", (chunk) => buffers.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve({ buffer: Buffer.concat(buffers), fileName: `${fileName}.pdf` }));
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const pageHeight = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
    const drawHeading = (label) => {
      doc.fillColor("#111827").font("Helvetica-Bold").fontSize(15).text(title, { width: pageWidth });
      doc.fillColor("#667085").font("Helvetica").fontSize(7.5).text([subtitle, label].filter(Boolean).join(" | "), { width: pageWidth });
      return doc.y + 9;
    };
    images.forEach((image, index) => {
      if (index > 0) doc.addPage();
      const label = index === 0 ? "Overview seluruh bagan" : `Detail bagan ${index}/${images.length - 1}`;
      const top = drawHeading(label);
      doc.image(image, doc.page.margins.left, top, { fit: [pageWidth, doc.page.height - doc.page.margins.bottom - top], align: "center", valign: "top" });
    });
    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      doc.switchToPage(index);
      doc.fillColor("#667085").font("Helvetica").fontSize(7).text(`RENBO ERP | BOM Diagram | ${index + 1}/${range.count}`, doc.page.margins.left, doc.page.height - doc.page.margins.bottom - 16, { width: pageWidth, align: "right", lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { buildImagePdf, buildPdf, buildTemplate, buildXlsx, normalizeTable, parseWorkbook };
