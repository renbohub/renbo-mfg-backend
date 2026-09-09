const PURCHASE_PART_CATEGORIES = ['PD', 'WD', 'MD'];
function normalizePurchasePartCategory(data, existing = null) {
  const itemType = data.itemType ?? existing?.itemType;
  const rawType = data.rawType ?? existing?.rawType;
  if (itemType !== 'RAW' || rawType !== 'PURCHASE_PART' || data.category === undefined) return data;
  if (data.category === null || data.category === '') { data.category = null; return data; }
  const category = String(data.category).trim().toUpperCase();
  if (!PURCHASE_PART_CATEGORIES.includes(category)) {
    // Retain an explicitly unchanged historical classification; never invent a
    // PD/WD/MD mapping for existing data during an unrelated edit.
    if (existing && data.category === existing.category) return data;
    throw Object.assign(new Error('Kategori Purchase Part harus PD, WD, atau MD.'), { statusCode: 400 });
  }
  data.category = category;
  return data;
}
module.exports = { PURCHASE_PART_CATEGORIES, normalizePurchasePartCategory };
