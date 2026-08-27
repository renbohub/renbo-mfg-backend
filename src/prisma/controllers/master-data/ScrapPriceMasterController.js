const { prisma } = require("../../index");
const { mapDoc } = require("../../utils/mapDoc");
const { assertReference } = require("../../utils/referenceValidation");

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const clean = (value) => String(value || "").trim();

function normalize(body, actor, partial = false) {
  const data = {};
  const assignText = (key, source = key) => {
    if (!partial || body[source] !== undefined) data[key] = clean(body[source]) || null;
  };
  assignText("scrapCode");
  assignText("scrapName");
  assignText("materialType");
  assignText("partCode");
  assignText("notes");
  if (!partial || body.pricePerKg !== undefined) data.pricePerKg = number(body.pricePerKg);
  if (!partial || body.effectiveFrom !== undefined) data.effectiveFrom = body.effectiveFrom ? new Date(body.effectiveFrom) : null;
  if (!partial || body.effectiveUntil !== undefined) data.effectiveUntil = body.effectiveUntil ? new Date(body.effectiveUntil) : null;
  if (!partial || body.isActive !== undefined) data.isActive = body.isActive !== false && body.isActive !== "false";
  if (!partial) data.createdBy = actor;
  if (data.scrapCode) data.scrapCode = data.scrapCode.toUpperCase();
  if (data.materialType) data.materialType = data.materialType.toUpperCase();
  if (data.partCode) data.partCode = data.partCode.toUpperCase();
  if (!partial) data.currencyCode = "IDR";
  return data;
}

function validate(data, current = {}) {
  const merged = { ...current, ...data };
  if (!clean(merged.scrapCode)) throw Object.assign(new Error("Kode scrap wajib diisi."), { status: 400 });
  if (!clean(merged.scrapName)) throw Object.assign(new Error("Nama scrap wajib diisi."), { status: 400 });
  if (!(number(merged.pricePerKg) > 0)) throw Object.assign(new Error("Harga scrap per KG harus lebih dari nol."), { status: 400 });
  if (!merged.effectiveFrom || Number.isNaN(new Date(merged.effectiveFrom).getTime())) throw Object.assign(new Error("Tanggal berlaku wajib diisi."), { status: 400 });
  if (merged.effectiveUntil && new Date(merged.effectiveUntil) < new Date(merged.effectiveFrom)) {
    throw Object.assign(new Error("Tanggal berakhir tidak boleh sebelum tanggal berlaku."), { status: 400 });
  }
}

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(number(req.query.limit) || 20, 1), 500);
    const q = clean(req.query.q || req.query.search);
    const where = { isDeleted: req.query.isDeleted === "true" };
    if (req.query.isActive !== undefined) where.isActive = req.query.isActive === "true";
    if (q) where.OR = ["scrapCode", "scrapName", "materialType", "partCode", "notes"].map((key) => ({ [key]: { contains: q, mode: "insensitive" } }));
    const [items, total] = await Promise.all([
      prisma.scrapPriceMaster.findMany({ where, orderBy: [{ effectiveFrom: "desc" }, { scrapCode: "asc" }], skip: (page - 1) * limit, take: limit }),
      prisma.scrapPriceMaster.count({ where }),
    ]);
    res.json({ items: items.map(mapDoc), total, page, limit });
  } catch (error) { next(error); }
};

exports.get = async (req, res, next) => {
  try {
    const item = await prisma.scrapPriceMaster.findFirst({ where: { id: req.params.id, isDeleted: false } });
    if (!item) return res.status(404).json({ message: "Harga scrap tidak ditemukan." });
    res.json(mapDoc(item));
  } catch (error) { next(error); }
};

exports.create = async (req, res, next) => {
  try {
    const data = normalize(req.body, req.user?.username || req.user?.email || "system");
    validate(data);
    await assertReference({ delegate: prisma.part, field: "partCode", value: data.partCode, key: "partCode", label: "Part", activeWhere: { status: "Active" } });
    const item = await prisma.scrapPriceMaster.create({ data });
    res.status(201).json(mapDoc(item));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === "P2002") return res.status(409).json({ message: "Kode scrap sudah digunakan." });
    next(error);
  }
};

exports.update = async (req, res, next) => {
  try {
    const current = await prisma.scrapPriceMaster.findFirst({ where: { id: req.params.id, isDeleted: false } });
    if (!current) return res.status(404).json({ message: "Harga scrap tidak ditemukan." });
    const data = normalize(req.body, null, true);
    validate(data, current);
    await assertReference({ delegate: prisma.part, field: "partCode", value: data.partCode, currentValue: current.partCode, key: "partCode", label: "Part", activeWhere: { status: "Active" } });
    const item = await prisma.scrapPriceMaster.update({ where: { id: current.id }, data });
    res.json(mapDoc(item));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === "P2002") return res.status(409).json({ message: "Kode scrap sudah digunakan." });
    next(error);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const result = await prisma.scrapPriceMaster.updateMany({ where: { id: req.params.id, isDeleted: false }, data: { isDeleted: true, isActive: false } });
    if (!result.count) return res.status(404).json({ message: "Harga scrap tidak ditemukan." });
    res.json({ ok: true });
  } catch (error) { next(error); }
};

exports.bulkRemove = async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ message: "Pilih minimal satu harga scrap." });
    const result = await prisma.scrapPriceMaster.updateMany({ where: { id: { in: ids }, isDeleted: false }, data: { isDeleted: true, isActive: false } });
    res.json({ deletedCount: result.count });
  } catch (error) { next(error); }
};
