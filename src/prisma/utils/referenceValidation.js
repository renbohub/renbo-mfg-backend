const blank = (value) => value === undefined || value === null || String(value).trim() === "";

function referenceError(field, message, code = "REFERENCE_NOT_FOUND") {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  error.details = { field };
  return error;
}

async function assertReference({
  delegate,
  field,
  value,
  key = "id",
  label = field,
  currentValue,
  activeWhere = {},
  extraWhere = {},
}) {
  if (blank(value)) return null;
  if (!delegate?.findFirst) throw new TypeError(`Delegate lookup ${label} tidak tersedia.`);

  const normalized = String(value).trim();
  const isCurrent = !blank(currentValue) && String(currentValue).trim() === normalized;
  const baseWhere = { [key]: normalized, isDeleted: false, ...extraWhere };
  const row = await delegate.findFirst({ where: isCurrent ? baseWhere : { ...baseWhere, ...activeWhere } });
  if (row) return row;

  if (!isCurrent && Object.keys(activeWhere).length) {
    const inactive = await delegate.findFirst({ where: baseWhere });
    if (inactive) throw referenceError(field, `${label} tidak aktif dan tidak dapat dipilih.`, "REFERENCE_INACTIVE");
  }
  throw referenceError(field, `${label} tidak ditemukan.`, "REFERENCE_NOT_FOUND");
}

async function assertReferenceList({
  delegate,
  field,
  values,
  key = "id",
  label = field,
  extraWhere = {},
}) {
  if (values === undefined) return [];
  const normalized = [...new Set((Array.isArray(values) ? values : [values]).filter((value) => !blank(value)).map((value) => String(value).trim()))];
  if (!normalized.length) return [];
  if (!delegate?.findMany) throw new TypeError(`Delegate lookup ${label} tidak tersedia.`);

  const rows = await delegate.findMany({ where: { [key]: { in: normalized }, isDeleted: false, ...extraWhere }, select: { [key]: true } });
  const found = new Set(rows.map((row) => String(row[key])));
  const missing = normalized.filter((value) => !found.has(value));
  if (missing.length) {
    const error = referenceError(field, `${label} tidak ditemukan atau tidak sesuai: ${missing.join(", ")}.`, "REFERENCE_NOT_FOUND");
    error.details = { field, values: missing };
    throw error;
  }
  return rows;
}

module.exports = { assertReference, assertReferenceList, referenceError };
