const { prisma } = require("../../index");

const include = {
  customer: true, currency: true, quotation: true,
  details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" }, include: { part: true, uom: true } },
  attachments: { where: { isDeleted: false } }, deliverySchedules: { where: { isDeleted: false } },
};
const text = (value) => String(value ?? "").trim() || null;
const date = (value) => value ? new Date(value) : null;
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

async function nextNumber(tx = prisma) {
  const year = new Date().getFullYear(); const prefix = `SO-${year}-`;
  const rows = await tx.salesOrderHeader.findMany({ where: { soNumber: { startsWith: prefix } }, select: { soNumber: true } });
  const max = rows.reduce((value, row) => Math.max(value, Number(row.soNumber.slice(prefix.length)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}
function detailData(row, index, soNumber) {
  const qty = number(row.qty); const unitPrice = number(row.unitPrice); const discount = number(row.discount);
  const discountType = row.discountType === "nominal" ? "nominal" : "percent";
  const beforeTax = Math.max(0, qty * unitPrice - (discountType === "nominal" ? discount : qty * unitPrice * discount / 100));
  const tax = number(row.tax);
  return { soNumber, lineNumber: index + 1, partCode: text(row.partCode), partNumber: text(row.partNumber), partName: text(row.partName), uomCode: text(row.uomCode), qty, unitPrice, discount, discountType, tax, totalAmount: beforeTax + beforeTax * tax / 100, status: text(row.status) || "Pending", deliveryDate: date(row.deliveryDate), notes: text(row.notes) };
}
function headerData(body, user, totalAmount) {
  return { soDate: date(body.soDate) || new Date(), quotationNumber: text(body.quotationNumber), customerCode: text(body.customerCode), customerName: text(body.customerName), contact: text(body.contact), phone: text(body.phone), email: text(body.email), billingAddress: text(body.billingAddress), shippingAddress: text(body.shippingAddress), paymentTerms: text(body.paymentTerms), taxId: text(body.taxId), currencyCode: text(body.currencyCode) || "IDR", deliveryDate: date(body.deliveryDate), status: text(body.status) || "Draft", totalAmount, notes: text(body.notes), createdBy: user?.username || user?.email || null };
}

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(number(req.query.page) || 1, 1); const limit = Math.min(Math.max(number(req.query.limit) || 20, 1), 500); const q = text(req.query.q || req.query.search);
    const where = { isDeleted: false, ...(q ? { OR: [{ soNumber: { contains: q, mode: "insensitive" } }, { quotationNumber: { contains: q, mode: "insensitive" } }, { customerName: { contains: q, mode: "insensitive" } }, { status: { contains: q, mode: "insensitive" } }] } : {}) };
    const [items, total] = await Promise.all([prisma.salesOrderHeader.findMany({ where, include: { customer: true, quotation: true }, orderBy: { soDate: "desc" }, skip: (page - 1) * limit, take: limit }), prisma.salesOrderHeader.count({ where })]);
    res.json({ items, total, page, limit });
  } catch (error) { next(error); }
};
exports.get = async (req, res, next) => { try { const doc = await prisma.salesOrderHeader.findFirst({ where: { soNumber: req.params.soNumber, isDeleted: false }, include }); if (!doc) return res.status(404).json({ message: "Sales Order tidak ditemukan" }); res.json(doc); } catch (error) { next(error); } };
exports.generateNumber = async (_req, res, next) => { try { res.json({ soNumber: await nextNumber() }); } catch (error) { next(error); } };

exports.createFromQuotation = async (quotation, options = {}, user) => prisma.$transaction(async (tx) => {
  const soNumber = text(options.soNumber) || await nextNumber(tx);
  const details = quotation.details.map((row, index) => detailData(row, index, soNumber));
  const totalAmount = details.reduce((sum, row) => sum + row.totalAmount, 0);
  const so = await tx.salesOrderHeader.create({ data: { soNumber, ...headerData({ ...quotation, ...options, quotationNumber: quotation.quotationNumber, soDate: options.soDate || new Date(), deliveryDate: options.deliveryDate || quotation.details[0]?.deliveryDate, status: "Draft" }, user, totalAmount), details: { create: details.map(({ soNumber: _parent, ...row }) => row) } }, include });
  await tx.quotationHeader.update({ where: { quotationNumber: quotation.quotationNumber }, data: { convertedToSO: soNumber, status: "Converted" } });
  return so;
});

exports.create = async (req, res, next) => {
  try {
    if (req.body.quotationNumber) {
      const quotation = await prisma.quotationHeader.findFirst({ where: { quotationNumber: req.body.quotationNumber, isDeleted: false }, include: { details: { where: { isDeleted: false } } } });
      if (!quotation) return res.status(404).json({ message: "Quotation referensi tidak ditemukan" });
      if (quotation.convertedToSO) return res.status(409).json({ message: `Quotation sudah menjadi ${quotation.convertedToSO}` });
      if (!["Approved", "Accepted"].includes(quotation.status)) return res.status(400).json({ message: "Quotation harus Approved/Accepted sebelum dibuat menjadi Sales Order" });
      return res.status(201).json(await exports.createFromQuotation(quotation, req.body, req.user));
    }
    const rows = Array.isArray(req.body.details) ? req.body.details : [];
    if (!rows.length) return res.status(400).json({ message: "Minimal satu item Sales Order wajib diisi" });
    const doc = await prisma.$transaction(async (tx) => { const soNumber = text(req.body.soNumber) || await nextNumber(tx); const details = rows.map((row, index) => detailData(row, index, soNumber)); const totalAmount = details.reduce((sum, row) => sum + row.totalAmount, 0); return tx.salesOrderHeader.create({ data: { soNumber, ...headerData(req.body, req.user, totalAmount), details: { create: details.map(({ soNumber: _parent, ...row }) => row) } }, include }); });
    res.status(201).json(doc);
  } catch (error) { next(error); }
};

exports.update = async (req, res, next) => {
  try {
    const existing = await prisma.salesOrderHeader.findFirst({ where: { soNumber: req.params.soNumber, isDeleted: false } });
    if (!existing) return res.status(404).json({ message: "Sales Order tidak ditemukan" });
    const doc = await prisma.$transaction(async (tx) => { const rows = Array.isArray(req.body.details) ? req.body.details : null; let totalAmount = existing.totalAmount; if (rows) { const details = rows.map((row, index) => detailData(row, index, existing.soNumber)); totalAmount = details.reduce((sum, row) => sum + row.totalAmount, 0); await tx.salesOrderDetail.deleteMany({ where: { soNumber: existing.soNumber } }); if (details.length) await tx.salesOrderDetail.createMany({ data: details }); } const data = headerData({ ...existing, ...req.body }, req.user, totalAmount); delete data.createdBy; return tx.salesOrderHeader.update({ where: { soNumber: existing.soNumber }, data, include }); });
    res.json(doc);
  } catch (error) { next(error); }
};
exports.remove = async (req, res, next) => { try { const doc = await prisma.salesOrderHeader.findFirst({ where: { soNumber: req.params.soNumber, isDeleted: false } }); if (!doc) return res.status(404).json({ message: "Sales Order tidak ditemukan" }); if (!["Draft", "Cancelled"].includes(doc.status)) return res.status(400).json({ message: "Hanya Sales Order Draft/Cancelled yang dapat dihapus" }); await prisma.salesOrderHeader.update({ where: { soNumber: doc.soNumber }, data: { isDeleted: true, details: { updateMany: { where: {}, data: { isDeleted: true } } } } }); res.json({ ok: true }); } catch (error) { next(error); } };
