// Utilitas untuk membangun objek sort dari query params untuk Prisma

/**
 * Normalisasi arah sorting agar selalu kompatibel dengan Prisma.
 * @param {string} orderRaw
 * @returns {"asc"|"desc"}
 */
function normalizeOrder(orderRaw) {
  return orderRaw && String(orderRaw).toLowerCase() === "asc" ? "asc" : "desc";
}

/**
 * Membangun objek nested Prisma dari field dot notation.
 * Contoh: dies.diesCode -> { dies: { diesCode: "asc" } }
 * @param {string} field
 * @param {"asc"|"desc"} order
 * @returns {Object|null}
 */
function buildNestedSort(field, order) {
  const parts = String(field || "")
    .split(".")
    .map((x) => x.trim())
    .filter(Boolean);

  if (parts.length === 0) return null;

  let cursor = order;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    cursor = { [parts[i]]: cursor };
  }
  return cursor;
}

/**
 * Mengecek apakah field diizinkan untuk sorting.
 * @param {string} field
 * @param {string[]} allowed
 * @returns {boolean}
 */
function isAllowedField(field, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  return allowed.includes(field);
}

/**
 * Memetakan alias field (dari FE) ke field Prisma yang sebenarnya.
 * @param {string} field
 * @param {Object<string, string>} fieldMap
 * @returns {string}
 */
function resolveField(field, fieldMap) {
  if (!field) return field;
  if (!fieldMap || typeof fieldMap !== "object") return field;

  const normalizedInput = String(field).trim();
  if (!normalizedInput) return field;

  // Support format nested dari FE: dies__diesCode -> dies.diesCode
  const inputWithDot = normalizedInput.replace(/__/g, ".");

  // 1) Exact key match
  if (fieldMap[inputWithDot]) {
    return fieldMap[inputWithDot];
  }

  // 2) Case-insensitive key match
  const keys = Object.keys(fieldMap);
  const matchedKey = keys.find(
    (k) => String(k).toLowerCase() === inputWithDot.toLowerCase(),
  );
  if (matchedKey) {
    return fieldMap[matchedKey];
  }

  // 3) Leaf field match (contoh: diesCode -> dies.diesCode)
  const leafMatches = Object.values(fieldMap).filter((value) => {
    const v = String(value || "").trim();
    if (!v) return false;
    const leaf = v.includes(".") ? v.split(".").pop() : v;
    return leaf && leaf.toLowerCase() === inputWithDot.toLowerCase();
  });

  if (leafMatches.length === 1) {
    return leafMatches[0];
  }

  return inputWithDot;
}

/**
 * Membangun objek sort berdasarkan parameter query untuk Prisma.
 * @param {Object} query - Parameter query yang diterima.
 * @param {Object} options - Opsi tambahan.
 * @param {string[]} [options.allowed] - Daftar field yang boleh di-sort.
 * @param {Object<string, string>} [options.fieldMap] - Pemetaan alias field FE ke field Prisma.
 * @param {Object} [options.default] - Default sort object.
 * @param {Object} [options.defaultSort] - Alias default sort object.
 * @returns {Object|Array} - Objek sort single field atau array multi-field.
 */
function buildSort(query = {}, options = {}) {
  const { sort, sortBy, sortOrder } = query;
  const { allowed, fieldMap, default: defaultOption, defaultSort } = options;
  const fallback = defaultOption || defaultSort || { createdAt: "desc" };

  // Prioritas 1: parameter `sort` (format: field:order,field2:order2)
  if (sort) {
    const fields = String(sort)
      .split(",")
      .map((s) => {
        const [fieldRaw, orderRaw] = s.split(":").map((x) => (x ? x.trim() : ""));
        if (!fieldRaw || !isAllowedField(fieldRaw, allowed)) return null;
        const resolvedField = resolveField(fieldRaw, fieldMap);
        return buildNestedSort(resolvedField, normalizeOrder(orderRaw));
      })
      .filter(Boolean);

    if (fields.length > 0) {
      return fields.length > 1 ? fields : fields[0];
    }
  }

  // Prioritas 2: parameter `sortBy` + `sortOrder` (single field)
  if (sortBy && isAllowedField(sortBy, allowed)) {
    const resolvedField = resolveField(sortBy, fieldMap);
    const parsed = buildNestedSort(resolvedField, normalizeOrder(sortOrder));
    if (parsed) return parsed;
  }

  return fallback;
}

module.exports = { buildSort };