"use strict";

const MONTH_FIELDS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const asNumber = (value) => {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  // Prisma numeric values are numbers (or Decimal objects); request validation
  // below deliberately accepts only numbers and numeric strings.
  if (typeof value === "boolean" || Array.isArray(value)) return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
};
const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 });
const monthlyNumber = (value, message = "Harga bulanan harus berupa angka nol atau lebih.") => {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  if (!["number", "string"].includes(typeof value)) throw invalid(message);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw invalid(message);
  return number;
};
const stripMonthlyMetadata = (row) => {
  for (const field of ["monthlyPlan", "monthlyResolved", "monthlyOverrides", "sourceCount", "sourceVersions"]) delete row[field];
  return row;
};

const asDate = (value, fieldName = "tanggal") => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`${fieldName} tidak valid.`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
};

// Price periods are maintained as business dates (not instants). Persist the
// previous calendar date so the generic date form displays Aug 10 when the new
// price starts Aug 11 in Asia/Jakarta.
const endBefore = (date) => new Date(date.getTime() - 24 * 60 * 60 * 1000);

function nullablePriceValue(record, at = new Date()) {
  if (!record) return null;
  const direct = asNumber(record.unitPrice);
  if (direct !== null) return direct;
  const date = asDate(at) || new Date();
  // A pre-effective-date row carries its last known price into later years.
  const month = !record.effectiveFrom && Number(record.pricingYear) < date.getFullYear() ? 11 : date.getMonth();
  for (let index = month; index >= 0; index -= 1) {
    const price = asNumber(record[MONTH_FIELDS[index]]);
    if (price !== null) return price;
  }
  return null;
}

function legacyPriceValue(record, at = new Date()) {
  return nullablePriceValue(record, at) ?? 0;
}

function resolveEffectiveRecord(records, atInput = new Date()) {
  const at = asDate(atInput) || new Date();
  const available = (records || []).filter((row) => row && row.isDeleted !== true);
  const temporal = available
    .filter((row) => {
      if (!row.effectiveFrom || row.isActive === false) return false;
      const from = new Date(row.effectiveFrom);
      const until = row.effectiveUntil ? new Date(row.effectiveUntil) : null;
      return from <= at && (!until || until >= at);
    })
    .sort((left, right) =>
      new Date(right.effectiveFrom).getTime() - new Date(left.effectiveFrom).getTime()
      || new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime());
  if (temporal.length) return temporal[0];

  // Compatibility for historical monthly rows created before effective dating.
  return available
    .filter((row) => !row.effectiveFrom && row.isActive !== false && Number(row.pricingYear || 0) <= at.getFullYear())
    .sort((left, right) =>
      Number(right.pricingYear || 0) - Number(left.pricingYear || 0)
      || new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime())
    .find((row) => nullablePriceValue(row, at) !== null
      || row.details?.some(detail => !detail.isDeleted && nullablePriceValue({ ...detail, pricingYear: row.pricingYear }, at) !== null)) || null;
}

function resolveEffectivePrice(records, atInput = new Date()) {
  const at = asDate(atInput) || new Date();
  const record = resolveEffectiveRecord(records, at);
  return {
    record,
    unitPrice: legacyPriceValue(record, at),
    source: record?.effectiveFrom ? "EFFECTIVE_DATED" : record ? "LEGACY_MONTHLY" : "NOT_FOUND",
    effectiveFrom: record?.effectiveFrom || null,
    effectiveUntil: record?.effectiveUntil || null,
  };
}

function normalizeEffectivePriceInput(input, options = {}) {
  if (input.pricingMode === "MONTHLY") return normalizeMonthlyPriceInput(input, options);
  const data = { ...input };
  const numericFields = ["unitPrice", "moq", "orderMultiple"];
  numericFields.forEach((field) => {
    if (data[field] === undefined) return;
    data[field] = asNumber(data[field]);
  });
  if (data.unitPrice !== undefined && (data.unitPrice === null || data.unitPrice < 0)) {
    throw Object.assign(new Error("Harga wajib berupa angka nol atau lebih."), { statusCode: 400 });
  }
  ["moq", "orderMultiple"].forEach((field) => {
    if (data[field] !== undefined && data[field] !== null && data[field] < 0) {
      throw Object.assign(new Error(`${field === "moq" ? "MOQ" : "Order multiple"} tidak boleh negatif.`), { statusCode: 400 });
    }
  });
  if (data.effectiveFrom !== undefined) data.effectiveFrom = asDate(data.effectiveFrom, "Tanggal berlaku mulai");
  if (data.effectiveUntil !== undefined) data.effectiveUntil = asDate(data.effectiveUntil, "Tanggal berlaku sampai");
  if (options.requireEffective !== false && !data.effectiveFrom) {
    throw Object.assign(new Error("Tanggal berlaku mulai wajib diisi."), { statusCode: 400 });
  }
  if (data.effectiveFrom && data.effectiveUntil && data.effectiveUntil < data.effectiveFrom) {
    throw Object.assign(new Error("Tanggal berlaku sampai tidak boleh sebelum tanggal mulai."), { statusCode: 400 });
  }
  if (data.isActive !== undefined) data.isActive = data.isActive !== false && data.isActive !== "false";
  if (options.actor && !data.createdBy) data.createdBy = options.actor;

  // Keep old reports/imports operational while all consumers migrate.
  if (data.effectiveFrom && data.unitPrice !== undefined && data.unitPrice !== null) {
    data.pricingYear = data.effectiveFrom.getFullYear();
    data[MONTH_FIELDS[data.effectiveFrom.getMonth()]] = data.unitPrice;
  }
  return data;
}

// Existing dense month arrays were previously generated by the form. Collapse
// repeated values to change points; newly saved sparse arrays retain every
// explicit value, including zero and same-value future anchors.
function monthlyProjection(row = {}) {
  const direct = asNumber(row.unitPrice);
  const dense = MONTH_FIELDS.every(field => asNumber(row[field]) !== null);
  let previous = null;
  const fields = {}, monthlyResolved = {}, monthlyOverrides = {};
  const firstMonth = row.effectiveFrom ? new Date(row.effectiveFrom).getMonth() : 0;
  MONTH_FIELDS.forEach((field, index) => {
    const value = direct !== null ? (index === firstMonth ? direct : null) : asNumber(row[field]);
    const explicit = value !== null && (direct !== null || !dense || value !== previous);
    fields[field] = explicit ? value : null;
    monthlyOverrides[field] = explicit;
    if (explicit) previous = value;
    monthlyResolved[field] = previous;
  });
  return { ...fields, monthlyResolved, monthlyOverrides };
}

function normalizeMonthlyPriceInput(input, options = {}) {
  const baseline = options.existing?.monthlyPlan || options.existing || {};
  const data = stripMonthlyMetadata({ ...input }); delete data.pricingMode;
  const rawYear = data.pricingYear ?? baseline.pricingYear;
  if (!["number", "string"].includes(typeof rawYear)) throw invalid("Tahun harga harus antara 2000 dan 2100.");
  const year = Number(rawYear);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw invalid("Tahun harga harus antara 2000 dan 2100.");
  if (baseline.pricingYear && Number(baseline.pricingYear) !== year) throw invalid("Tahun harga tidak dapat diubah saat edit. Buat harga tahun baru agar histori tetap terpisah.");
  data.pricingYear = year;
  data.effectiveFrom = new Date(Date.UTC(year, 0, 1));
  data.effectiveUntil = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
  const normalizeMonths = (row, previous = {}) => {
    const normalized = stripMonthlyMetadata({ ...row, unitPrice: null });
    const previousFields = previous.monthlyOverrides ? previous : monthlyProjection(previous);
    MONTH_FIELDS.forEach((field) => {
      // PATCH omission preserves the existing anchor. An explicit blank removes
      // it; subsequent months then inherit the preceding remaining anchor.
      const raw = row[field] === undefined ? previousFields[field] : row[field];
      normalized[field] = monthlyNumber(raw);
    });
    if (!MONTH_FIELDS.some((field) => normalized[field] !== null)) throw invalid("Isi minimal satu bulan harga pada setiap item/proses.");
    return normalized;
  };
  if (options.vendor) {
    let details = input.details === undefined ? baseline.details : input.details;
    if (typeof details === "string") { try { details = JSON.parse(details); } catch { throw invalid("Detail harga proses tidak valid."); } }
    if (!Array.isArray(details) || !details.length) throw invalid("Tambahkan minimal satu proses vendor beserta harga bulanannya.");
    const seen = new Set();
    data.details = details.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw invalid("Detail harga proses tidak valid.");
      if (!row.vendorProcessId || seen.has(row.vendorProcessId)) throw invalid("Proses vendor wajib dipilih dan tidak boleh duplikat.");
      seen.add(row.vendorProcessId);
      const previous = baseline.details?.find(detail => detail.vendorProcessId === row.vendorProcessId);
      return stripMonthlyMetadata({ ...previous, ...normalizeMonths(row, previous) });
    });
    delete data.unitPrice;
    MONTH_FIELDS.forEach((field) => delete data[field]);
  } else Object.assign(data, normalizeMonths(data, baseline));
  if (data.isActive !== undefined) data.isActive = data.isActive !== false && data.isActive !== "false";
  for (const field of ["moq", "orderMultiple"]) {
    if (data[field] === undefined) continue;
    data[field] = monthlyNumber(data[field], `${field} tidak valid.`);
  }
  if (options.actor && !data.createdBy) data.createdBy = options.actor;
  return data;
}

async function saveMonthlyPrice(tx, { model, data, scopeWhere, id, include }) {
  data = { ...data };
  scopeWhere = normalizeMonthlyScope(scopeWhere);
  let versions = data.monthlySourceVersions; delete data.monthlySourceVersions;
  if (typeof versions === "string") { try { versions = JSON.parse(versions); } catch { throw invalid("Versi sumber harga tidak valid. Muat ulang form harga."); } }
  if (versions != null && (typeof versions !== "object" || Array.isArray(versions))) throw invalid("Versi sumber harga tidak valid. Muat ulang form harga.");
  // Lock the annual identity across simultaneous form submissions, including creates.
  const lock = `${model}:${JSON.stringify(Object.entries(scopeWhere).sort())}:${data.pricingYear}`;
  if (tx.$executeRaw) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lock}))`;
  const annualWhere = {
    ...scopeWhere, isDeleted: false,
    OR: [{ pricingYear: data.pricingYear }, { effectiveFrom: { gte: data.effectiveFrom, lte: data.effectiveUntil } }],
  };
  if (id && versions && typeof versions === "object" && !Array.isArray(versions)) {
    const current = await tx[model].findUnique({ where: { id }, select: { id: true, updatedAt: true } });
    const sources = await tx[model].findMany({ where: annualWhere, select: { id: true, updatedAt: true } });
    const originalIds = Object.keys(versions);
    const originals = await tx[model].findMany({ where: { id: { in: originalIds } }, select: { id: true, updatedAt: true, isDeleted: true } });
    const stale = (row) => !row || !versions[row.id] || new Date(row.updatedAt).toISOString() !== versions[row.id];
    if (stale(current) || sources.some(stale) || originals.length !== originalIds.length || originals.some(row => row.isDeleted || stale(row))) throw Object.assign(new Error("Harga berubah sejak form dibuka. Muat ulang agar perubahan terbaru tidak tertimpa."), { statusCode: 409 });
    const oldIds = sources.filter(row=>row.id !== id).map(row=>row.id);
    if (oldIds.length) await tx[model].updateMany({ where: { id: { in: oldIds } }, data: { isDeleted: true, isActive: false } });
    return tx[model].update({ where: { id }, data, ...(include ? { include } : {}) });
  }
  const duplicate = await tx[model].findFirst({ where: { ...annualWhere, ...(id ? { id: { not: id } } : {}) }, select: { id: true } });
  if (duplicate) throw Object.assign(new Error("Harga untuk item, partner, dan tahun ini sudah ada. Edit record tahun tersebut agar tidak ada harga ganda."), { statusCode: 409 });
  return id ? tx[model].update({ where: { id }, data, ...(include ? { include } : {}) }) : tx[model].create({ data, ...(include ? { include } : {}) });
}

function normalizeMonthlyScope(scope) {
  return typeof scope.uomCode === "string" ? { ...scope, uomCode: { equals: scope.uomCode.toUpperCase(), mode: "insensitive" } } : scope;
}

function monthlyPriceScope(model, row) {
  const currencyCode = row.currencyCode || "IDR";
  if (model === "vendorPriceList") return { vendorId: row.vendorId || null, partId: row.partId || null, customerId: row.customerId || null, category: row.category, currencyCode };
  if (model === "partPriceList") return { partId: row.partId || null, supplierId: row.supplierId || null, currencyCode };
  const identity = row.materialId ? { materialId: row.materialId } : { materialId: null, materialSubstanceId: row.materialSubstanceId || null, materialGradeId: row.materialGradeId || null, thickness: row.thickness, CSP: row.CSP || null };
  return normalizeMonthlyScope({ ...identity, supplierId: row.supplierId || null, currencyCode, uomCode: row.uomCode || null });
}

async function monthlyPriceView(db, model, record) {
  const year = Number(record.pricingYear || new Date(record.effectiveFrom || Date.now()).getFullYear());
  const rows = await db[model].findMany({ where: { ...monthlyPriceScope(model, record), isDeleted: false,
    OR: [{ pricingYear: year }, { effectiveFrom: { gte: new Date(Date.UTC(year,0,1)), lt: new Date(Date.UTC(year+1,0,1)) } }] },
    ...(model === "vendorPriceList" ? { include: { details: { where: { isDeleted: false } } } } : {}), orderBy: [{ effectiveFrom: "desc" }, { updatedAt: "desc" }] });
  // Sort locally as well: callers and test doubles may not enforce Prisma's
  // ordering; null effective dates must never outrank dated price versions.
  rows.sort((a,b) => new Date(b.effectiveFrom || 0) - new Date(a.effectiveFrom || 0) || new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  const dateMonth = (d) => new Date(d).toISOString().slice(0,7);
  const eligible = (r, i) => { const month = `${year}-${String(i+1).padStart(2,"0")}`; return r.isActive !== false && (!r.effectiveFrom || dateMonth(r.effectiveFrom) <= month) && (!r.effectiveUntil || dateMonth(r.effectiveUntil) >= month); };
  const fieldsFor = (processId) => {
    const fields = {}, monthlyResolved = {}, monthlyOverrides = {};
    let previous = null;
    const sources = rows.map(row => {
      const detail = processId ? row.details?.find(d => !d.isDeleted && d.vendorProcessId === processId) : row;
      return { row, projection: detail ? monthlyProjection({ ...detail, effectiveFrom: row.effectiveFrom }) : null };
    });
    MONTH_FIELDS.forEach((field, i) => {
      const source = sources.find(({row, projection}) => eligible(row, i) && projection?.monthlyResolved[field] != null);
      const value = source?.projection.monthlyResolved[field] ?? null;
      const explicit = value !== null && (value !== previous || source.projection.monthlyOverrides[field]);
      fields[field] = explicit ? value : null;
      monthlyResolved[field] = value;
      monthlyOverrides[field] = explicit;
      previous = value;
    });
    return { ...fields, monthlyResolved, monthlyOverrides };
  };
  const plan = { pricingYear: year, sourceCount: rows.length, sourceVersions: Object.fromEntries(rows.map(r=>[r.id,new Date(r.updatedAt).toISOString()])) };
  if (model === "vendorPriceList") {
    const processes = new Map(); rows.forEach(r=>(r.details || []).filter(d=>!d.isDeleted).forEach(d=>{if(!processes.has(d.vendorProcessId)) processes.set(d.vendorProcessId,d);}));
    plan.details = [...processes.values()].map((d,i)=>({...d,...fieldsFor(d.vendorProcessId),unitPrice:null,sequence:i+1}));
  } else Object.assign(plan,fieldsFor());
  return { ...record, monthlyPlan: plan };
}

async function createEffectiveVersion(tx, options) {
  const { model, data, scopeWhere } = options;
  const delegate = tx[model];
  if (!delegate) throw new Error(`Pricing model ${model} tidak tersedia.`);
  const from = data.effectiveFrom;
  const sameDate = await delegate.findFirst({
    where: { ...scopeWhere, isDeleted: false, effectiveFrom: from },
    select: { id: true },
  });
  if (sameDate) {
    throw Object.assign(new Error("Harga dengan tanggal mulai yang sama sudah ada. Edit record tersebut atau pilih tanggal lain."), { statusCode: 409 });
  }
  const future = await delegate.findFirst({
    where: { ...scopeWhere, isDeleted: false, effectiveFrom: { gt: from } },
    orderBy: { effectiveFrom: "asc" },
    select: { effectiveFrom: true },
  });
  const effectiveUntil = future?.effectiveFrom && (!data.effectiveUntil || data.effectiveUntil >= future.effectiveFrom)
    ? endBefore(future.effectiveFrom)
    : data.effectiveUntil;
  await delegate.updateMany({
    where: {
      ...scopeWhere,
      isDeleted: false,
      effectiveFrom: { lt: from },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: from } }],
    },
    data: { effectiveUntil: endBefore(from) },
  });
  return delegate.create({ data: { ...data, effectiveUntil } });
}

module.exports = {
  MONTH_FIELDS,
  asDate,
  nullablePriceValue,
  legacyPriceValue,
  resolveEffectiveRecord,
  resolveEffectivePrice,
  normalizeEffectivePriceInput,
  createEffectiveVersion,
  normalizeMonthlyPriceInput,
  monthlyProjection,
  saveMonthlyPrice,
  monthlyPriceView,
  monthlyPriceScope,
};
