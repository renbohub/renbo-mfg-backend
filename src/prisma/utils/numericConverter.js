/**
 * Helper function untuk konversi field numerik dari string ke number
 * Digunakan untuk mengatasi issue type mismatch saat data dikirim sebagai string
 * dari frontend/API calls
 * 
 * @param {Object} data - Object data yang akan dikonversi
 * @param {Array<string>} fields - Array nama field yang perlu dikonversi
 * @returns {Object} Object baru dengan field numerik yang sudah dikonversi
 */
const convertNumericFields = (data, fields = []) => {
  const converted = { ...data };

  fields.forEach((field) => {
    if (converted[field] !== undefined && converted[field] !== null) {
      const value = converted[field];
      if (typeof value === "string") {
        // Konversi string ke number
        const parsed = parseFloat(value);
        converted[field] = isNaN(parsed) ? null : parsed;
      }
    }
  });

  return converted;
};

/**
 * Preset field names untuk monthly pricing (januari-desember)
 */
const MONTHLY_PRICE_FIELDS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * Helper khusus untuk price list dengan pricing bulanan
 * @param {Object} data - Object data yang akan dikonversi
 * @returns {Object} Object dengan field bulan & pricingYear sudah dikonversi
 */
const convertPriceListFields = (data) => {
  return convertNumericFields(data, [
    ...MONTHLY_PRICE_FIELDS,
    "pricingYear",
  ]);
};

module.exports = {
  convertNumericFields,
  convertPriceListFields,
  MONTHLY_PRICE_FIELDS,
};
