const slugify = require("slugify");

const STRICT_IDENTIFIER_FIELDS = new Set([
  "currencyCode",
  "customerCode",
  "departmentCode",
  "diesCode",
  "divisionCode",
  "entryNumber",
  "forecastNumber",
  "grNumber",
  "inspectionNumber",
  "issueNumber",
  "logNumber",
  "lotNumber",
  "machineCode",
  "maintenanceNumber",
  "materialCode",
  "moNumber",
  "movementNumber",
  "mpsNumber",
  "orderNumber",
  "partCode",
  "prNumber",
  "processCode",
  "productCode",
  "quotationNumber",
  "rackCode",
  "reservationNumber",
  "runNumber",
  "scheduleNumber",
  "snapshotNumber",
  "soNumber",
  "subProcessCode",
  "supplierCode",
  "termCode",
  "uomCode",
  "vendorCode",
  "vendorProcessCode",
  "warehouseCode",
  "woNumber",
]);

function normalizeStrictIdentifier(value, { lower = false } = {}) {
  if (value === null || typeof value === "undefined") return value;
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return lower ? trimmed : null;

  const normalized = slugify(trimmed, {
    lower,
    replacement: "-",
    strict: true,
    trim: true,
  });

  return lower ? normalized : normalized.toUpperCase();
}

function normalizeUsername(value) {
  return normalizeStrictIdentifier(value, { lower: true });
}

function normalizeEmail(value) {
  if (value === null || typeof value === "undefined") return value;
  if (typeof value !== "string") return value;

  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function normalizeUomCode(value) {
  if (value === null || typeof value === "undefined") return value;
  if (typeof value !== "string") return value;

  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function normalizeStrictIdentifierField(field, value) {
  if (field === "email") return normalizeEmail(value);
  if (field === "username") return normalizeUsername(value);
  if (field === "uomCode") return normalizeUomCode(value);
  if (STRICT_IDENTIFIER_FIELDS.has(field)) return normalizeStrictIdentifier(value);
  return value;
}

function normalizeStrictIdentifiersDeep(input) {
  if (!input || typeof input !== "object") return input;

  if (Array.isArray(input)) {
    input.forEach((item) => normalizeStrictIdentifiersDeep(item));
    return input;
  }

  for (const [key, value] of Object.entries(input)) {
    if (value && typeof value === "object") {
      normalizeStrictIdentifiersDeep(value);
      continue;
    }

    input[key] = normalizeStrictIdentifierField(key, value);
  }

  return input;
}

function findEmptyStrictIdentifier(input, path = []) {
  if (!input || typeof input !== "object") return null;

  if (Array.isArray(input)) {
    for (let index = 0; index < input.length; index += 1) {
      const found = findEmptyStrictIdentifier(input[index], [...path, index]);
      if (found) return found;
    }
    return null;
  }

  for (const [key, value] of Object.entries(input)) {
    const currentPath = [...path, key];
    if (key === "username" && value === "") {
      return currentPath.join(".");
    }

    if (value && typeof value === "object") {
      const found = findEmptyStrictIdentifier(value, currentPath);
      if (found) return found;
    }
  }

  return null;
}

function strictIdentifierMiddleware(req, res, next) {
  if (!["POST", "PUT", "PATCH"].includes(req.method)) return next();
  if (!req.body || typeof req.body !== "object") return next();

  normalizeStrictIdentifiersDeep(req.body);

  const emptyField = findEmptyStrictIdentifier(req.body);
  if (emptyField) {
    return res.status(400).json({
      message: `${emptyField} tidak valid setelah normalisasi`,
    });
  }

  return next();
}

module.exports = {
  STRICT_IDENTIFIER_FIELDS,
  normalizeEmail,
  normalizeStrictIdentifier,
  normalizeStrictIdentifierField,
  normalizeStrictIdentifiersDeep,
  normalizeUomCode,
  normalizeUsername,
  strictIdentifierMiddleware,
};
