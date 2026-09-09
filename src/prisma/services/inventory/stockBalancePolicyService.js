const POLICY_FIELDS = ['minStock', 'maxStock', 'reorderPoint'];
const error = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
function normalizedPolicy(body, existing) {
  if (!body || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some(key => !POLICY_FIELDS.includes(key))) error('Hanya minStock, maxStock dan reorderPoint yang dapat diubah pada policy.');
  const result = {};
  for (const key of Object.keys(body)) {
    const value = body[key];
    if (value === null && key !== 'minStock') { result[key] = null; continue; }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) error(`${key} harus berupa angka >= 0${key === 'minStock' ? '' : ' atau null'}.`);
    result[key] = value;
  }
  const merged = { minStock: existing.minStock ?? 0, maxStock: existing.maxStock ?? null, reorderPoint: existing.reorderPoint ?? null, ...result };
  if (merged.maxStock !== null && merged.minStock > merged.maxStock) error('minStock tidak boleh lebih besar dari maxStock.');
  if (merged.reorderPoint !== null && merged.reorderPoint < merged.minStock) error('reorderPoint tidak boleh lebih kecil dari minStock.');
  if (merged.maxStock !== null && merged.reorderPoint !== null && merged.reorderPoint > merged.maxStock) error('reorderPoint tidak boleh lebih besar dari maxStock.');
  return result;
}
function createPolicyController(db) {
  return async (req, res, next) => {
    try {
      // Reject quantity/identity/nested relation payloads before accessing data.
      if (Object.keys(req.body || {}).some(key => !POLICY_FIELDS.includes(key))) error('Policy tidak dapat mengubah quantity, identitas, atau status saldo.');
      const result = await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "tbl_stock_balance" WHERE id = ${req.params.id} FOR UPDATE`;
        const existing = await tx.stockBalance.findFirst({ where: { id: req.params.id, isDeleted: false } });
        if (!existing) error('Stock balance tidak ditemukan.', 404);
        const data = normalizedPolicy(req.body, existing);
        return tx.stockBalance.update({ where: { id: existing.id }, data });
      }); res.json(result);
    } catch (err) { if (err.statusCode) return res.status(err.statusCode).json({ message: err.message }); next(err); }
  };
}
module.exports = { POLICY_FIELDS, normalizedPolicy, createPolicyController };
