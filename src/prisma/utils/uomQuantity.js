const DISCRETE_UOMS = new Set(["PCS", "PC", "PIECE", "PIECES", "SHEET", "SHEETS", "COIL", "COILS"]);

function normalizedUom(uomCode) {
  return String(uomCode || "").trim().toUpperCase().replace(/\s+/g, "_");
}

function isDiscreteUom(uomCode) {
  return DISCRETE_UOMS.has(normalizedUom(uomCode));
}

function normalizeQuantity(value, uomCode) {
  const qty = Number(value || 0);
  if (!Number.isFinite(qty)) return 0;
  return isDiscreteUom(uomCode) ? Math.round(qty) : qty;
}

function assertQuantity(value, uomCode, label = "Qty") {
  const qty = Number(value);
  if (!Number.isFinite(qty) || qty < 0) {
    const error = new Error(`${label} harus berupa angka nol atau lebih.`);
    error.statusCode = 400;
    throw error;
  }
  if (isDiscreteUom(uomCode) && !Number.isInteger(qty)) {
    const error = new Error(`${label} untuk UOM ${normalizedUom(uomCode)} harus berupa bilangan bulat (tanpa desimal).`);
    error.statusCode = 400;
    error.code = "DISCRETE_UOM_DECIMAL";
    throw error;
  }
  return qty;
}

// Split a quantity across n buckets without creating fractional piece/sheet/coil values.
function splitQuantity(value, count, uomCode) {
  const total = normalizeQuantity(value, uomCode);
  const n = Math.max(1, Number(count) || 1);
  if (!isDiscreteUom(uomCode)) {
    const base = total / n;
    return Array.from({ length: n }, (_, index) => index === n - 1 ? total - base * (n - 1) : base);
  }
  const base = Math.floor(total / n);
  let remainder = total - (base * n);
  return Array.from({ length: n }, () => {
    const qty = base + (remainder > 0 ? 1 : 0);
    remainder -= remainder > 0 ? 1 : 0;
    return qty;
  });
}

module.exports = { DISCRETE_UOMS, normalizedUom, isDiscreteUom, normalizeQuantity, assertQuantity, splitQuantity };
