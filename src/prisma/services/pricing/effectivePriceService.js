"use strict";

const MONTH_FIELDS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const asNumber = (value) =>
  value !== null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;

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

function legacyPriceValue(record, at = new Date()) {
  if (!record) return 0;
  const direct = asNumber(record.unitPrice);
  if (direct !== null) return direct;
  const month = at.getMonth();
  for (let index = month; index >= 0; index -= 1) {
    const price = asNumber(record[MONTH_FIELDS[index]]);
    if (price !== null && price > 0) return price;
  }
  return 0;
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
    .filter((row) => !row.effectiveFrom && Number(row.pricingYear || 0) <= at.getFullYear())
    .sort((left, right) =>
      Number(right.pricingYear || 0) - Number(left.pricingYear || 0)
      || new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime())
    .find((row) => legacyPriceValue(row, at) > 0) || null;
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
  legacyPriceValue,
  resolveEffectiveRecord,
  resolveEffectivePrice,
  normalizeEffectivePriceInput,
  createEffectiveVersion,
};
