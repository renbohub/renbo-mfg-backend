const crypto = require("crypto");
const path = require("path");
const XLSX = require("xlsx");

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SHEETS = 60;
const MAX_ROWS = 50000;
const HEADER_SCAN_ROWS = 40;

const normalizedText = (value) => String(value ?? "").trim().toLowerCase();
const columnName = (index) => XLSX.utils.encode_col(index);

function dateValue(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return value;
  return value.toISOString().slice(0, 10);
}

function displayValue(cell) {
  if (!cell) return null;
  if (cell.t === "d") return dateValue(cell.v);
  // A formatted header such as "Aug-26" must remain a date label instead of
  // being emitted as its Excel serial number.
  if (cell.t === "n" && cell.z && cell.w) return cell.w;
  return dateValue(cell.v);
}

function isEmpty(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function headerScore(values) {
  const labels = values.map(normalizedText).filter(Boolean);
  const known = labels.filter((label) => /customer|cust|part|drawing|forecast|bulan|month|qty|quantity|uom|unit|satuan/.test(label)).length;
  const monthColumns = labels.filter((label) => /^(jan|feb|mar|apr|mei|may|jun|jul|aug|agu|sep|okt|oct|nov|des|dec|januari|februari|maret|april|agustus|september|oktober|november|desember)/.test(label)).length;
  return known * 3 + monthColumns + Math.min(labels.length, 12) / 100;
}

function makeHeaders(values) {
  const used = new Map();
  return values.map((value, index) => {
    const base = String(value ?? "").trim() || `Column ${columnName(index)}`;
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

function worksheetRows(sheet, sheetName, hidden) {
  const rangeRef = sheet?.["!ref"];
  if (!rangeRef) return { rows: [], headerRow: null, formulaCount: 0 };
  const range = XLSX.utils.decode_range(rangeRef);
  const lastRow = Math.min(range.e.r, range.s.r + MAX_ROWS);
  const scanEnd = Math.min(lastRow, range.s.r + HEADER_SCAN_ROWS - 1);
  let headerIndex = range.s.r;
  let bestScore = -1;

  for (let rowIndex = range.s.r; rowIndex <= scanEnd; rowIndex += 1) {
    const values = [];
    for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
      values.push(displayValue(sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })]));
    }
    const score = headerScore(values);
    if (score > bestScore) {
      bestScore = score;
      headerIndex = rowIndex;
    }
  }

  const headers = makeHeaders(Array.from({ length: range.e.c - range.s.c + 1 }, (_, offset) => {
    const columnIndex = range.s.c + offset;
    return displayValue(sheet[XLSX.utils.encode_cell({ r: headerIndex, c: columnIndex })]);
  }));
  const rows = [];
  let formulaCount = 0;

  for (let rowIndex = headerIndex + 1; rowIndex <= lastRow; rowIndex += 1) {
    const sourceJson = {};
    const formulas = {};
    let populated = false;
    for (let offset = 0; offset < headers.length; offset += 1) {
      const columnIndex = range.s.c + offset;
      const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
      const value = displayValue(cell);
      if (!isEmpty(value)) {
        sourceJson[headers[offset]] = value;
        populated = true;
      }
      if (cell?.f) {
        formulas[headers[offset]] = cell.f;
        formulaCount += 1;
      }
    }
    if (!populated) continue;
    sourceJson.__excelProvenance = {
      sheetName,
      rowNumber: rowIndex + 1,
      hidden,
      formulas,
    };
    rows.push({ sheetName, rowNumber: rowIndex + 1, sourceJson });
    if (rows.length >= MAX_ROWS) break;
  }
  return { rows, headerRow: headerIndex + 1, formulaCount };
}

function assertFile(file) {
  if (!file?.buffer?.length) throw Object.assign(new Error("File Excel wajib diunggah."), { statusCode: 400 });
  if (file.size > MAX_FILE_BYTES) throw Object.assign(new Error("Ukuran file maksimal 8 MB."), { statusCode: 413 });
  const extension = path.extname(file.originalname || "").toLowerCase().replace(".", "");
  if (!['xlsx', 'xls', 'csv'].includes(extension)) throw Object.assign(new Error("Format file harus .xlsx, .xls, atau .csv."), { statusCode: 400 });
  return extension;
}

function parseWorkbookUpload(file) {
  const fileType = assertFile(file);
  let workbook;
  try {
    workbook = XLSX.read(file.buffer, { type: "buffer", cellFormula: true, cellDates: true, raw: true, WTF: false });
  } catch (_error) {
    throw Object.assign(new Error("File tidak dapat dibaca sebagai workbook Excel yang valid."), { statusCode: 400 });
  }
  const sheetNames = (workbook.SheetNames || []).slice(0, MAX_SHEETS);
  if (!sheetNames.length) throw Object.assign(new Error("Workbook tidak memiliki sheet yang dapat dibaca."), { statusCode: 400 });

  const rows = [];
  const sheets = [];
  for (const [index, sheetName] of sheetNames.entries()) {
    const visibility = workbook.Workbook?.Sheets?.[index]?.Hidden || 0;
    const parsed = worksheetRows(workbook.Sheets[sheetName], sheetName, visibility !== 0);
    rows.push(...parsed.rows);
    sheets.push({ sheetName, hidden: visibility !== 0, headerRow: parsed.headerRow, rowCount: parsed.rows.length, formulaCount: parsed.formulaCount });
    if (rows.length >= MAX_ROWS) break;
  }
  if (!rows.length) throw Object.assign(new Error("Tidak ditemukan row data setelah header pada workbook."), { statusCode: 400 });

  return {
    fileName: file.originalname,
    fileType,
    sourceChecksum: crypto.createHash("sha256").update(file.buffer).digest("hex"),
    rows: rows.slice(0, MAX_ROWS),
    metadata: {
      parser: "sheetjs",
      workbookType: workbook.BookType || fileType,
      sheetCount: sheets.length,
      sheets,
      truncated: rows.length >= MAX_ROWS,
    },
  };
}

module.exports = { MAX_FILE_BYTES, parseWorkbookUpload };
