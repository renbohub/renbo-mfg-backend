const crypto = require("crypto");
const { prisma } = require("../../index");
const { mapDoc } = require("../../utils/mapDoc");

const text = (value) => String(value ?? "").trim() || null;
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const upper = (value) => text(value)?.toUpperCase() || null;
const MONTHS = new Map([
  ["jan", 0], ["january", 0], ["januari", 0], ["feb", 1], ["february", 1], ["februari", 1],
  ["mar", 2], ["march", 2], ["maret", 2], ["apr", 3], ["april", 3], ["may", 4], ["mei", 4],
  ["jun", 5], ["june", 5], ["juni", 5], ["jul", 6], ["july", 6], ["juli", 6],
  ["aug", 7], ["agu", 7], ["august", 7], ["agustus", 7], ["sep", 8], ["september", 8],
  ["oct", 9], ["okt", 9], ["october", 9], ["oktober", 9], ["nov", 10], ["november", 10],
  ["dec", 11], ["des", 11], ["december", 11], ["desember", 11],
]);

const aliases = (source, names) => {
  const keys = Object.keys(source || {});
  for (const name of names) {
    const key = keys.find((candidate) => candidate.toLowerCase().trim() === name.toLowerCase());
    if (key) return source[key];
  }
  return null;
};
const periodMonth = (value, fallbackYear) => {
  if (!value) return null;
  const raw = String(value).trim();
  const match = raw.toLowerCase().match(/(jan(?:uary|uari)?|feb(?:ruary|ruari)?|mar(?:ch|et)?|apr(?:il)?|may|mei|jun(?:e|i)?|jul(?:y|i)?|aug(?:ust)?|agu(?:stus)?|sep(?:tember)?|oct(?:ober)?|okt(?:ober)?|nov(?:ember)?|dec(?:ember)?|des(?:ember)?)[^0-9]*(\d{4})?/);
  const month = MONTHS.get(match?.[1]);
  const year = Number(match?.[2] || fallbackYear);
  if (month !== undefined && year) return new Date(Date.UTC(year, month, 1));
  const direct = new Date(raw);
  return /\d/.test(raw) && !Number.isNaN(direct.getTime())
    ? new Date(Date.UTC(direct.getUTCFullYear(), direct.getUTCMonth(), 1))
    : null;
};
const identity = (...parts) => crypto.createHash("sha256").update(parts.map((part) => String(part ?? "")).join("|")).digest("hex");
const rowSource = (row) => row?.sourceJson || row?.data || row || {};
const provenance = (source) => source.__excelProvenance || {};
const uniqueErrors = (errors) => [...new Map(errors.map((error) => [
  `${error.sheetName || ""}|${error.rowNumber || ""}|${error.code || ""}`,
  error,
])).values()];
const normalizedLookup = (value) => upper(value)?.replace(/[^A-Z0-9]/g, "") || null;
const customerAcronym = (value) => String(value || "")
  .replace(/\b(PT|TBK|LTD|CO|COMPANY)\b/gi, " ")
  .split(/[^A-Za-z0-9]+/)
  .filter(Boolean)
  .map((part) => part[0])
  .join("")
  .toUpperCase();

async function loadBatch(key) {
  const batch = await prisma.excelImportBatch.findFirst({
    where: { OR: [{ id: key }, { batchNumber: key }] },
    include: { rows: { orderBy: [{ sheetName: "asc" }, { rowNumber: "asc" }] } },
  });
  if (!batch) throw Object.assign(new Error("Import batch tidak ditemukan."), { statusCode: 404 });
  return batch;
}

function salesPeriods(source, fallbackYear) {
  const explicit = periodMonth(aliases(source, ["period", "month", "bulan", "actual month", "sales month"]), fallbackYear);
  const qty = number(aliases(source, ["qty", "quantity", "pcs", "sales qty", "actual qty"]));
  const totalAmount = number(aliases(source, ["total amount", "amount", "sales value", "revenue", "nilai"]));
  if (explicit && (qty || totalAmount)) return [{ period: explicit, qty, totalAmount }];
  const result = [];
  const years = provenance(source).columnYears || {};
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith("__")) continue;
    const period = periodMonth(`${key} ${years[key] || ""}`, fallbackYear);
    const periodQty = number(value);
    if (period && periodQty) result.push({ period, qty: periodQty, totalAmount: 0 });
  }
  return result;
}

function sourceStartYear(options, fallbackYear) {
  const explicit = Number(options.historyStartYear || options.startYear);
  if (explicit) return explicit;
  const match = String(options.sourcePeriod || "").match(/(?:19|20)\d{2}/);
  return Number(match?.[0]) || fallbackYear;
}

function materialPeriods(source, options, fallbackYear) {
  const explicitPeriod = periodMonth(
    aliases(source, ["period", "month", "bulan", "demand month"]) || options.sourcePeriod || options.period,
    fallbackYear,
  );
  const qtyPcs = number(aliases(source, ["qty pcs", "demand pcs", "pcs", "po/bulan", "po/"]));
  const qtyKg = number(aliases(source, ["qty kg", "demand kg", "kg", "po/ (2)"]));
  const monthColumnCount = Object.keys(source).filter((key) => {
    const match = key.match(/^([A-Za-z]+)(?: \((\d+)\))?$/);
    return MONTHS.has(String(match?.[1] || "").toLowerCase());
  }).length;
  if (monthColumnCount < 2 && explicitPeriod && (qtyPcs || qtyKg)) return [{ period: explicitPeriod, qtyPcs, qtyKg }];

  const entries = Object.entries(source).filter(([key]) => !key.startsWith("__"));
  const result = [];
  const years = provenance(source).columnYears || {};
  let activeYear = sourceStartYear(options, fallbackYear);
  let previousMonth = null;
  for (let index = 0; index < entries.length; index += 1) {
    const [key, value] = entries[index];
    const match = key.match(/^([A-Za-z]+)(?: \((\d+)\))?$/);
    const month = MONTHS.get(String(match?.[1] || "").toLowerCase());
    const occurrence = Number(match?.[2] || 1);
    if (month === undefined || occurrence % 2 === 0) continue;
    if (years[key]) activeYear = Number(years[key]);
    else if (previousMonth !== null && month < previousMonth) activeYear += 1;
    previousMonth = month;
    const next = entries[index + 1];
    const nextMatch = next?.[0]?.match(/^([A-Za-z]+)(?: \((\d+)\))?$/);
    const nextMonth = MONTHS.get(String(nextMatch?.[1] || "").toLowerCase());
    const nextOccurrence = Number(nextMatch?.[2] || 1);
    const periodQtyPcs = number(value);
    const periodQtyKg = nextMonth === month && nextOccurrence === occurrence + 1 ? number(next[1]) : 0;
    if (periodQtyPcs || periodQtyKg) result.push({ period: new Date(Date.UTC(activeYear, month, 1)), qtyPcs: periodQtyPcs, qtyKg: periodQtyKg });
  }
  return result;
}

async function previewSales(rows, options = {}) {
  const mapped = [];
  const errors = [];
  const fallbackYear = Number(options.defaultYear) || new Date().getFullYear();
  for (const row of rows) {
    const source = rowSource(row);
    const customerCode = upper(aliases(source, ["customer code", "customer", "cust", "customer_code"]) || options.customerCode || String(row.sheetName || "").replace(/\s*detail.*/i, ""));
    const partCode = text(aliases(source, ["part code", "partcode", "part_code", "kode part"]));
    const partNumber = text(aliases(source, ["part number", "part no", "part no.", "drawing number", "item"]));
    const partName = text(aliases(source, ["part name", "nama part", "description", "column c"]));
    const unitPrice = number(aliases(source, ["unit price", "price", "harga", "column d"]));
    const basis = upper(aliases(source, ["actual basis", "basis", "sales basis"]) || options.actualBasis || "BOOKED");
    const periods = salesPeriods(source, fallbackYear);
    if (!customerCode) errors.push({ sheetName: row.sheetName, rowNumber: row.rowNumber, code: "CUSTOMER_REQUIRED", message: "Customer wajib dipetakan." });
    if (!partCode && !partNumber) errors.push({ sheetName: row.sheetName, rowNumber: row.rowNumber, code: "PART_REQUIRED", message: "Part Code atau Part Number wajib dipetakan." });
    if (!periods.length) errors.push({ sheetName: row.sheetName, rowNumber: row.rowNumber, code: "PERIOD_QTY_REQUIRED", message: "Periode dan qty/nilai aktual tidak ditemukan." });
    if (!["BOOKED", "DELIVERED", "INVOICED", "RECOGNIZED"].includes(basis)) errors.push({ sheetName: row.sheetName, rowNumber: row.rowNumber, code: "ACTUAL_BASIS_INVALID", message: `Basis aktual ${basis} tidak dikenal.` });
    periods.forEach((period) => mapped.push({ row, customerCode, partCode, partNumber, partName, unitPrice, actualBasis: basis, ...period }));
  }
  const partCodes = [...new Set(mapped.map((row) => row.partCode).filter(Boolean))];
  const partNumbers = [...new Set(mapped.map((row) => row.partNumber).filter(Boolean))];
  const parts = (partCodes.length || partNumbers.length) ? await prisma.part.findMany({
    where: { isDeleted: false, OR: [...(partCodes.length ? [{ partCode: { in: partCodes } }] : []), ...(partNumbers.length ? [{ partNumber: { in: partNumbers } }] : [])] },
    select: { id: true, partCode: true, partNumber: true, partName: true, salesUomCode: true, baseUomCode: true },
  }) : [];
  const byCode = new Map(parts.map((part) => [part.partCode, part]));
  const byNumber = new Map(parts.filter((part) => part.partNumber).map((part) => [part.partNumber, part]));
  const customerCodes = [...new Set(mapped.map((row) => row.customerCode).filter(Boolean))];
  const customers = customerCodes.length ? await prisma.customer.findMany({
    where: { isDeleted: false },
    select: { customerCode: true, customerName: true },
  }) : [];
  const customerByCode = new Map();
  customers.forEach((customer) => {
    [customer.customerCode, customer.customerName, customerAcronym(customer.customerName)].filter(Boolean)
      .forEach((key) => customerByCode.set(normalizedLookup(key), customer));
  });
  const items = mapped.flatMap((item) => {
    const part = byCode.get(item.partCode) || byNumber.get(item.partNumber);
    if (!part) {
      errors.push({ sheetName: item.row.sheetName, rowNumber: item.row.rowNumber, code: "PART_NOT_FOUND", message: `Part ${item.partCode || item.partNumber} tidak ditemukan.` });
      return [];
    }
    const customer = customerByCode.get(normalizedLookup(item.customerCode));
    if (!customer) {
      errors.push({ sheetName: item.row.sheetName, rowNumber: item.row.rowNumber, code: "CUSTOMER_NOT_FOUND", message: `Customer ${item.customerCode} tidak ditemukan.` });
      return [];
    }
    const totalAmount = item.totalAmount || item.qty * item.unitPrice;
    return [{
      identityKey: identity(options.batchNumber, item.row.sheetName, item.row.rowNumber, item.actualBasis, item.period.toISOString(), part.partCode),
      actualBasis: item.actualBasis, actualDate: item.period, periodMonth: item.period,
      customerCode: item.customerCode, customerName: customer.customerName, partId: part.id, partCode: part.partCode, partNumber: part.partNumber,
      partName: part.partName || item.partName, businessCategory: text(options.businessCategory), qty: item.qty,
      uomCode: upper(options.uomCode || part.salesUomCode || part.baseUomCode || "PCS"), unitPrice: item.unitPrice,
      totalAmount, currencyCode: upper(options.currencyCode || "IDR"), exchangeRateToIdr: number(options.exchangeRateToIdr) || 1,
      amountIdr: totalAmount * (number(options.exchangeRateToIdr) || 1), sourceType: "EXCEL_IMPORT",
      sourceNumber: `${item.row.sheetName}#${item.row.rowNumber}`, sourceBatchNumber: options.batchNumber,
      importRowId: item.row.id || null,
    }];
  });
  const reconciledErrors = uniqueErrors(errors);
  return { items, errors: reconciledErrors, reconciliation: { sourceRows: rows.length, mappedRows: items.length, errorCount: reconciledErrors.length, totalQty: items.reduce((sum, row) => sum + row.qty, 0), totalAmountIdr: items.reduce((sum, row) => sum + row.amountIdr, 0) } };
}

async function previewMaterial(rows, options = {}) {
  const items = [];
  const errors = [];
  const materialCache = new Map();
  const partCache = new Map();
  const fallbackYear = Number(options.defaultYear) || new Date().getFullYear();
  for (const row of rows) {
    const source = rowSource(row);
    const materialCode = text(aliases(source, ["material code", "kode material"]));
    const materialSpec = text(aliases(source, ["material spec", "spec", "spec material", "material"]));
    const thickness = number(aliases(source, ["thickness", "t", "tebal", "size"])) || null;
    const width = number(aliases(source, ["width", "w", "lebar", "column e", "column f"])) || null;
    const partCode = text(aliases(source, ["part code", "partcode", "part_code"]));
    const partNumber = text(aliases(source, ["part number", "part no", "drawing number", "number", "part"]));
    const grossWeightKg = number(aliases(source, ["gross weight", "gross kg/pcs", "gross weight kg", "weight", "gross"])) || null;
    const periods = materialPeriods(source, options, fallbackYear);
    if (!periods.length) continue;
    if (!materialCode && !(materialSpec && thickness && width)) errors.push({ sheetName: row.sheetName, rowNumber: row.rowNumber, code: "MATERIAL_REQUIRED", message: "Material Code atau kombinasi Spec/Thickness/Width wajib diisi." });
    if (!materialCode && !(materialSpec && thickness && width)) continue;
    const materialKey = materialCode ? `CODE:${upper(materialCode)}` : `IDENTITY:${upper(materialSpec)}|${thickness}|${width}`;
    if (!materialCache.has(materialKey)) materialCache.set(materialKey, await prisma.material.findFirst({ where: { isDeleted: false, ...(materialCode ? { materialCode } : { spec: materialSpec, thickness, width }) }, select: { id: true, materialCode: true, spec: true, thickness: true, width: true } }));
    const material = materialCache.get(materialKey);
    if (!material) { errors.push({ sheetName: row.sheetName, rowNumber: row.rowNumber, code: "MATERIAL_NOT_FOUND", message: `Material ${materialCode || `${materialSpec}-${thickness}-${width}`} tidak ditemukan.` }); continue; }
    const partKey = partCode ? `CODE:${upper(partCode)}` : partNumber ? `NUMBER:${upper(partNumber)}` : null;
    if (partKey && !partCache.has(partKey)) partCache.set(partKey, await prisma.part.findFirst({ where: { isDeleted: false, OR: [...(partCode ? [{ partCode }] : []), ...(partNumber ? [{ partNumber }] : [])] }, select: { id: true, partCode: true, partNumber: true, partName: true } }));
    const part = partKey ? partCache.get(partKey) : null;
    periods.forEach(({ period, qtyPcs, qtyKg: sourceQtyKg }) => {
      const qtyKg = sourceQtyKg || (qtyPcs && grossWeightKg ? qtyPcs * grossWeightKg : 0);
      items.push({
        identityKey: identity(options.batchNumber, row.sheetName, row.rowNumber, period.toISOString(), material.materialCode, part?.partCode || partNumber),
        periodMonth: period, materialId: material.id, materialCode: material.materialCode, materialSpec: material.spec,
        thickness: material.thickness, width: material.width, materialForm: upper(aliases(source, ["material form", "form", "type material", "type"])),
        partId: part?.id || null, partCode: part?.partCode || partCode, partNumber: part?.partNumber || partNumber, partName: part?.partName || text(aliases(source, ["part name", "description", "part (2)", "column m"])),
        customerCode: upper(aliases(source, ["customer code", "customer", "cust", "column d"])), pitch: number(aliases(source, ["pitch", "p", "column n"])) || null,
        cavity: Math.max(0, Math.round(number(aliases(source, ["cavity", "cav", "column o"])))) || null, grossWeightKg,
        demandQtyPcs: qtyPcs, demandQtyKg: qtyKg, warehouseCode: upper(aliases(source, ["warehouse", "warehouse code"])), rackCode: upper(aliases(source, ["rack", "rak", "rack code"])),
        sourceBatchNumber: options.batchNumber, importRowId: row.id || null,
      });
    });
  }
  const reconciledErrors = uniqueErrors(errors);
  return { items, errors: reconciledErrors, reconciliation: { sourceRows: rows.length, mappedRows: items.length, errorCount: reconciledErrors.length, totalPcs: items.reduce((sum, row) => sum + row.demandQtyPcs, 0), totalKg: items.reduce((sum, row) => sum + row.demandQtyKg, 0) } };
}

async function previewFor(type, rows, options) {
  if (type === "SALES_HISTORY") return previewSales(rows, options);
  if (type === "MATERIAL_DEMAND_HISTORY") return previewMaterial(rows, options);
  throw Object.assign(new Error("Import type historis tidak didukung."), { statusCode: 400 });
}

exports.preview = async (req, res, next) => {
  try {
    const batch = req.body?.batchKey ? await loadBatch(String(req.body.batchKey)) : null;
    const importType = upper(req.body?.importType || batch?.importType);
    const rows = batch?.rows || (Array.isArray(req.body?.rows) ? req.body.rows : []);
    if (!rows.length) return res.status(400).json({ message: "Minimal satu row diperlukan." });
    const result = await previewFor(importType, rows, { ...(batch?.metadata || {}), ...(req.body?.metadata || {}), ...req.body, batchNumber: batch?.batchNumber || req.body?.batchNumber || "PREVIEW" });
    res.json({ importType, lines: result.items.slice(0, 500), ...result.reconciliation, errors: result.errors, reconciliation: result.reconciliation });
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.apply = async (req, res, next) => {
  try {
    const batch = await loadBatch(req.params.key);
    if (batch.status === "APPLIED") return res.json({ idempotent: true, batch: mapDoc(batch), reconciliation: batch.reconciliation });
    if (batch.status !== "APPROVED") return res.status(409).json({ message: "Batch harus APPROVED sebelum diterapkan." });
    const result = await previewFor(batch.importType, batch.rows, { ...(batch.metadata || {}), ...req.body, batchNumber: batch.batchNumber });
    if (result.errors.length) return res.status(409).json({ message: "Mapping historis masih memiliki error.", errors: result.errors, reconciliation: result.reconciliation });
    const applied = await prisma.$transaction(async (tx) => {
      const common = (row) => ({ ...row, importBatchId: batch.id, importRowId: row.importRowId || null });
      const write = batch.importType === "SALES_HISTORY"
        ? tx.salesActualLedger.createMany({ data: result.items.map(common), skipDuplicates: true })
        : tx.materialDemandSnapshot.createMany({ data: result.items.map(common), skipDuplicates: true });
      const created = await write;
      await tx.excelImportRow.updateMany({ where: { batchId: batch.id }, data: { status: "APPLIED" } });
      return tx.excelImportBatch.update({ where: { id: batch.id }, data: { status: "APPLIED", appliedCount: created.count, reconciliation: { ...result.reconciliation, appliedCount: created.count, appliedAt: new Date().toISOString() } }, include: { rows: true } });
    });
    res.json({ idempotent: false, batch: mapDoc(applied), reconciliation: applied.reconciliation });
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

module.exports = exports;
