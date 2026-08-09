const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const COMPANY = {
  name: "PT. Mitsutoyo Indonesia",
  address: "Kawasan Industri Jababeka, Jl. Jababeka V No. 43\nKarang Baru, Cikarang Utara, Bekasi, Jawa Barat 17832",
  phone: "(+62) 21-3970-3104",
  website: "http://www.m-toyo.co.jp/",
  documentNumber: "FR-MI-PR-PURCH-06-005",
};

const PAGE = { width: 595.28, height: 841.89, left: 28, right: 567.28 };
const LAYOUT = { tableBottom: 642, totalsTop: 665, signatureTop: 750, signatureHeight: 60 };
const logoPath = path.resolve(__dirname, "../../../../../frontend/public/img/mitsutoyo-indonesia-logo.png");

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const text = (value, fallback = "-") => {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
};
const date = (value) => {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return text(value);
  return new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "2-digit", year: "numeric" }).format(parsed);
};
const qty = (value) => new Intl.NumberFormat("id-ID", { minimumFractionDigits: 0, maximumFractionDigits: 3 }).format(number(value));
const money = (value, symbol = "Rp") => `${symbol} ${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 }).format(Math.abs(number(value)) < 0.5 ? 0 : Math.round(number(value)))}`;
const keyPart = (value) => String(value ?? "").trim().toUpperCase();

function materialName(line) {
  return text(line.spec || line.materialName || line.materialCode || line.product?.productName || line.partName || line.partNumber);
}

function materialSize(line) {
  let dimensions = [line.thickness, line.width, line.CSP || line.csp || line.materialLength]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  if (dimensions.length < 3 && line.materialCode && line.materialName) {
    const code = String(line.materialCode);
    const prefix = `${String(line.materialName)}-`;
    if (code.toUpperCase().startsWith(prefix.toUpperCase())) {
      const codeDimensions = code.slice(prefix.length).split("-").map((value) => value.trim()).filter(Boolean);
      if (codeDimensions.length >= 2) dimensions = [...codeDimensions.slice(0, 2), line.CSP || line.csp || line.materialLength].filter(Boolean);
    }
  }
  return dimensions.length ? dimensions.join(" X ") : text(line.size || line.dimension || line.notes);
}

function referenceLabel(references) {
  const names = new Map();
  references.forEach(({ partNumber, partName }) => {
    const name = text(partName, "");
    const nameKey = keyPart(name || "PART");
    if (!names.has(nameKey)) names.set(nameKey, { name, numbers: new Set() });
    if (partNumber) names.get(nameKey).numbers.add(text(partNumber));
  });
  return [...names.values()].map(({ name, numbers }) => {
    const codes = [...numbers].join(", ");
    return [codes, name].filter(Boolean).join(" - ") || "-";
  }).join("\n");
}

function lineReferences(line) {
  const sources = Array.isArray(line.sourceReferences) ? line.sourceReferences : [];
  const candidates = sources.length ? sources : [{
    partNumber: line.partNumber || line.partCode || line.product?.productCode,
    partName: line.partName || line.product?.productName || line.product?.description,
  }];
  const references = [];
  candidates.forEach((source) => {
    const partNumber = text(source.partNumber || source.partCode, "");
    const partName = text(source.partName, "");
    const key = `${keyPart(partNumber)}|${keyPart(partName)}`;
    if ((partNumber || partName) && !references.some((item) => item.key === key)) references.push({ key, partNumber, partName });
  });
  return references;
}

function groupPurchaseOrderDetails(details = [], options = {}) {
  const groupMaterials = options.groupMaterials !== false;
  const groups = new Map();
  details.filter((line) => !line?.isDeleted).forEach((line, index) => {
    const material = materialName(line);
    const size = materialSize(line);
    const uom = text(line.uomCode, "");
    const unitPrice = number(line.unitPrice);
    const discount = number(line.discount);
    const discountType = text(line.discountType, "percent");
    const tax = number(line.tax);
    const parsedDeliveryDate = line.deliveryDate ? new Date(line.deliveryDate) : null;
    const deliveryDate = parsedDeliveryDate && !Number.isNaN(parsedDeliveryDate.getTime())
      ? parsedDeliveryDate.toISOString().slice(0, 10)
      : text(line.deliveryDate, "");
    const category = text(line.category, "");
    const groupKey = [material, size, uom, unitPrice, discount, discountType, tax, deliveryDate, category, groupMaterials ? "" : line.id || line.lineNumber || index]
      .map(keyPart).join("|");
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        material,
        size,
        uom,
        unitPrice,
        discount,
        discountType,
        tax,
        deliveryDate,
        category,
        quantity: 0,
        value: 0,
        references: [],
      });
    }
    const group = groups.get(groupKey);
    group.quantity += number(line.qty);
    group.value += number(line.totalAmount) || number(line.qty) * unitPrice;
    lineReferences(line).forEach((reference) => {
      if (!group.references.some((item) => item.key === reference.key)) group.references.push(reference);
    });
  });
  return [...groups.values()].map((group, index) => ({
    ...group,
    lineNumber: index + 1,
    reference: referenceLabel(group.references),
  }));
}

function signatoryName(value, fallback) {
  return text(value?.employee?.fullName || value?.fullName || value?.username || fallback);
}

function line(doc, x1, y1, x2, y2, width = 0.5) {
  doc.lineWidth(width).moveTo(x1, y1).lineTo(x2, y2).stroke("#222222");
}

function box(doc, x, y, width, height) {
  doc.lineWidth(0.6).rect(x, y, width, height).stroke("#222222");
}

function labelValue(doc, label, value, x, y, labelWidth = 56, options = {}) {
  doc.font("Helvetica-Bold").fontSize(7).fillColor("#222222").text(label, x, y, { width: labelWidth });
  doc.font("Helvetica").fontSize(7).text(text(value), x + labelWidth, y, { width: options.width || 190, lineGap: 1 });
}

function drawHeader(doc, po, continuation = false) {
  const top = 24;
  if (fs.existsSync(logoPath)) doc.image(logoPath, PAGE.left, top + 5, { fit: [190, 37], align: "left" });
  else doc.font("Helvetica-Bold").fontSize(15).text(COMPANY.name, PAGE.left, top + 10);
  doc.font("Helvetica").fontSize(6.5).fillColor("#333333").text(COMPANY.address, PAGE.left, top + 48, { width: 300, lineGap: 1 });
  doc.font("Helvetica").fontSize(6).text(`No. Doc : ${COMPANY.documentNumber}`, 362, top, { width: 205, align: "right" });
  doc.font("Helvetica-Bold").fontSize(17).fillColor("#111111").text(continuation ? "PURCHASE ORDER (CONT.)" : "PURCHASE ORDER", 330, top + 22, { width: 237, align: "right" });
  doc.font("Helvetica").fontSize(7).text(`Ph : ${COMPANY.phone}\nWeb : ${COMPANY.website}`, 368, top + 49, { width: 199, align: "right", lineGap: 2 });
  if (continuation) {
    doc.font("Helvetica-Bold").fontSize(7).text(`P/O NO : ${text(po.poNumber)}`, PAGE.left, 99);
    return 116;
  }

  const y = 98;
  const gap = 5;
  const half = (PAGE.right - PAGE.left - gap) / 2;
  box(doc, PAGE.left, y, half, 106);
  box(doc, PAGE.left + half + gap, y, half, 106);
  doc.font("Helvetica-Bold").fontSize(8).text("SUPPLIER", PAGE.left + 7, y + 7);
  doc.text("ORDER", PAGE.left + half + gap + 7, y + 7);
  line(doc, PAGE.left, y + 21, PAGE.left + half, y + 21);
  line(doc, PAGE.left + half + gap, y + 21, PAGE.right, y + 21);

  const partner = po.supplier || po.vendor || {};
  const supplierName = partner.supplierName || partner.vendorName || po.supplierName || po.vendorName;
  const address = partner.billingAddress || partner.shippingAddress || po.billingAddress || po.shippingAddress;
  const contact = partner.contact || po.contact;
  const phone = partner.phone || po.phone;
  labelValue(doc, "Co", supplierName, PAGE.left + 7, y + 28, 27, { width: 220 });
  labelValue(doc, "Address", address, PAGE.left + 7, y + 42, 40, { width: 205 });
  labelValue(doc, "PIC", contact, PAGE.left + 7, y + 75, 27, { width: 220 });
  labelValue(doc, "Ph", phone, PAGE.left + 7, y + 87, 27, { width: 220 });
  labelValue(doc, "Qtn", po.quotationNumber, PAGE.left + 7, y + 97, 27, { width: 220 });

  const orderX = PAGE.left + half + gap + 7;
  labelValue(doc, "P/O NO", po.poNumber, orderX, y + 28, 58, { width: 190 });
  labelValue(doc, "P/O Date", date(po.poDate), orderX, y + 42, 58, { width: 190 });
  labelValue(doc, "NPWP NO", partner.taxId, orderX, y + 56, 58, { width: 190 });
  labelValue(doc, "Delivery to", COMPANY.name, orderX, y + 70, 58, { width: 190 });
  doc.font("Helvetica").fontSize(7).text(po.shippingAddress || COMPANY.address, orderX + 58, y + 82, { width: 190, lineGap: 1 });
  return y + 113;
}

const columns = [
  { key: "lineNumber", label: "NO", width: 24, align: "center" },
  { key: "material", label: "MATERIAL", width: 75 },
  { key: "size", label: "SIZE", width: 76 },
  { key: "quantity", label: "QTY", width: 58, align: "right" },
  { key: "unitPrice", label: "PRICE/UNIT", width: 72, align: "right" },
  { key: "value", label: "VALUE", width: 79, align: "right" },
  { key: "reference", label: "REFERENCE / PART NUMBER", width: 155 },
];

function drawTableHeader(doc, y) {
  const height = 20;
  doc.save().fillColor("#eceff3").rect(PAGE.left, y, PAGE.right - PAGE.left, height).fill().restore();
  let x = PAGE.left;
  columns.forEach((column) => {
    box(doc, x, y, column.width, height);
    doc.font("Helvetica-Bold").fontSize(6.5).fillColor("#111111").text(column.label, x + 3, y + 7, { width: column.width - 6, align: column.align || "left" });
    x += column.width;
  });
  return y + height;
}

function rowValue(row, key, currencySymbol) {
  if (key === "quantity") return `${qty(row.quantity)} ${row.uom}`.trim();
  if (key === "unitPrice") return money(row.unitPrice, currencySymbol);
  if (key === "value") return money(row.value, currencySymbol);
  return text(row[key]);
}

function drawRow(doc, row, y, currencySymbol) {
  const values = columns.map((column) => rowValue(row, column.key, currencySymbol));
  const heights = values.map((value, index) => doc.font(index === 6 ? "Helvetica-Bold" : "Helvetica").fontSize(6.3)
    .heightOfString(value, { width: columns[index].width - 6, lineGap: 1 }));
  const height = Math.max(20, Math.max(...heights) + 8);
  let x = PAGE.left;
  columns.forEach((column, index) => {
    box(doc, x, y, column.width, height);
    doc.font(index === 6 ? "Helvetica-Bold" : "Helvetica").fontSize(6.3).fillColor("#222222")
      .text(values[index], x + 3, y + 4, { width: column.width - 6, align: column.align || "left", lineGap: 1 });
    x += column.width;
  });
  return height;
}

function extendTableGrid(doc, y, bottom = LAYOUT.tableBottom) {
  let rowY = y;
  while (rowY < bottom - 0.5) {
    const height = Math.min(20, bottom - rowY);
    let x = PAGE.left;
    columns.forEach((column) => {
      box(doc, x, rowY, column.width, height);
      x += column.width;
    });
    rowY += height;
  }
}

function calculateTotals(rows) {
  return rows.reduce((result, row) => {
    const gross = row.quantity * row.unitPrice;
    const discount = String(row.discountType).toLowerCase() === "nominal" ? row.discount : gross * row.discount / 100;
    const taxable = Math.max(gross - discount, 0);
    result.subtotal += gross;
    result.discount += discount;
    result.tax += taxable * row.tax / 100;
    result.quantity += row.quantity;
    return result;
  }, { subtotal: 0, discount: 0, tax: 0, quantity: 0 });
}

function drawFooter(doc, po, rows, currencySymbol) {
  const totals = calculateTotals(rows);
  const total = totals.subtotal - totals.discount + totals.tax;
  const uoms = [...new Set(rows.map((row) => row.uom).filter(Boolean))];
  const totalsTop = LAYOUT.totalsTop;
  doc.font("Helvetica-Bold").fontSize(7).text(`Total Qty : ${qty(totals.quantity)} ${uoms.length === 1 ? uoms[0] : ""}`, PAGE.left, totalsTop - 15);
  const notesX = PAGE.left;
  const totalsX = 379;
  box(doc, notesX, totalsTop, 341, 74);
  doc.font("Helvetica-Bold").fontSize(7).text("Note", notesX + 6, totalsTop + 7);
  doc.font("Helvetica").fontSize(7).text(text(po.notes), notesX + 50, totalsTop + 7, { width: 280 });
  doc.font("Helvetica-Bold").text("Request Delivery", notesX + 6, totalsTop + 26);
  doc.font("Helvetica").text(date(po.deliveryDate), notesX + 92, totalsTop + 26);
  doc.font("Helvetica-Bold").text("Category", notesX + 6, totalsTop + 45);
  doc.font("Helvetica").text([...new Set(rows.map((row) => row.category).filter(Boolean))].join(", ") || text(po.poType), notesX + 60, totalsTop + 45, { width: 270 });

  box(doc, totalsX, totalsTop, PAGE.right - totalsX, 74);
  const totalRows = [
    ["SUBTOTAL", totals.subtotal],
    ["DISCOUNT", totals.discount],
    ["VAT", totals.tax],
    ["TOTAL", total],
  ];
  totalRows.forEach(([label, value], index) => {
    const rowY = totalsTop + 6 + index * 17;
    doc.font(index === 3 ? "Helvetica-Bold" : "Helvetica").fontSize(7).text(`${label} :`, totalsX + 6, rowY, { width: 58 });
    doc.text(money(value, currencySymbol), totalsX + 64, rowY, { width: PAGE.right - totalsX - 70, align: "right" });
    if (index < 3) line(doc, totalsX, rowY + 13, PAGE.right, rowY + 13, 0.25);
  });

  const signY = LAYOUT.signatureTop;
  const signW = 113.67;
  const signatories = [
    ["Approved", signatoryName(po.approved, po.approvedBy), date(po.approvedDate)],
    ["Checked", signatoryName(po.checked, po.checkedBy), date(po.checkedDate)],
    ["Issued", signatoryName(po.issued, po.createdBy), date(po.createdAt || po.poDate)],
  ];
  signatories.forEach(([role, name, signedDate], index) => {
    const x = PAGE.left + index * signW;
    box(doc, x, signY, signW, LAYOUT.signatureHeight);
    doc.font("Helvetica-Bold").fontSize(7).text(role, x, signY + 6, { width: signW, align: "center" });
    doc.font("Helvetica").fontSize(6.5).text(signedDate, x, signY + 20, { width: signW, align: "center" });
    doc.font("Helvetica-Bold").fontSize(6.5).text(name, x + 4, signY + 46, { width: signW - 8, align: "center" });
  });
  doc.font("Helvetica").fontSize(5.5).fillColor("#777777").text(`Generated from ERP | ${text(po.poNumber)}`, PAGE.left, PAGE.height - 20, { width: PAGE.right - PAGE.left, align: "right" });
}

function buildPurchaseOrderPdf(po) {
  const materialDocument = String(po?.poType || "").trim().toUpperCase() === "MATERIAL"
    || (po?.details || []).some((line) => String(line?.prDetail?.procurementCategory || "").trim().toUpperCase() === "MATERIAL");
  const rows = groupPurchaseOrderDetails(po?.details || [], { groupMaterials: materialDocument });
  const currencySymbol = po?.currency?.symbol || (String(po?.currencyCode || "IDR").toUpperCase() === "IDR" ? "Rp" : text(po?.currencyCode, ""));
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 0, bottom: 0, left: 0, right: 0 }, compress: true, info: { Title: `Purchase Order ${text(po?.poNumber)}`, Author: COMPANY.name } });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    let y = drawTableHeader(doc, drawHeader(doc, po));
    rows.forEach((row) => {
      const probeValues = columns.map((column) => rowValue(row, column.key, currencySymbol));
      const expectedHeight = Math.max(20, ...probeValues.map((value, index) => doc.font(index === 6 ? "Helvetica-Bold" : "Helvetica").fontSize(6.3)
        .heightOfString(value, { width: columns[index].width - 6, lineGap: 1 }) + 8));
      if (y + expectedHeight > LAYOUT.tableBottom) {
        doc.addPage();
        y = drawTableHeader(doc, drawHeader(doc, po, true));
      }
      y += drawRow(doc, row, y, currencySymbol);
    });
    extendTableGrid(doc, y);
    drawFooter(doc, po, rows, currencySymbol);
    doc.end();
  });
}

module.exports = { buildPurchaseOrderPdf, groupPurchaseOrderDetails, referenceLabel };
