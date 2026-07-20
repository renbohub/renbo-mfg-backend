const { prisma } = require("../../index");

const include = {
  customer: true,
  currency: true,
  details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" }, include: { part: true, uom: true } },
  salesOrders: { where: { isDeleted: false }, select: { soNumber: true, status: true } },
};

const text = (value) => String(value ?? "").trim() || null;
const date = (value) => value ? new Date(value) : null;
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

function detailData(row, index, quotationNumber) {
  const qty = number(row.qty);
  const unitPrice = number(row.unitPrice);
  const discount = number(row.discount);
  const discountType = row.discountType === "nominal" ? "nominal" : "percent";
  const beforeTax = Math.max(0, qty * unitPrice - (discountType === "nominal" ? discount : qty * unitPrice * discount / 100));
  const tax = number(row.tax);
  return {
    quotationNumber, lineNumber: index + 1, partCode: text(row.partCode), partNumber: text(row.partNumber),
    partName: text(row.partName), uomCode: text(row.uomCode), qty, unitPrice, discount, discountType, tax,
    totalAmount: beforeTax + beforeTax * tax / 100, deliveryDate: date(row.deliveryDate), notes: text(row.notes),
  };
}

async function nextNumber(tx = prisma) {
  const year = new Date().getFullYear();
  const prefix = `QTN-${year}-`;
  const rows = await tx.quotationHeader.findMany({ where: { quotationNumber: { startsWith: prefix } }, select: { quotationNumber: true } });
  const max = rows.reduce((value, row) => Math.max(value, Number(row.quotationNumber.slice(prefix.length)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

function headerData(body, user, totalAmount) {
  return {
    quotationDate: date(body.quotationDate) || new Date(), customerCode: text(body.customerCode), customerName: text(body.customerName),
    contact: text(body.contact), phone: text(body.phone), email: text(body.email), billingAddress: text(body.billingAddress),
    shippingAddress: text(body.shippingAddress), paymentTerms: text(body.paymentTerms), taxId: text(body.taxId),
    currencyCode: text(body.currencyCode) || "IDR", validUntil: date(body.validUntil), status: text(body.status) || "Draft",
    totalAmount, notes: text(body.notes), createdBy: user?.username || user?.email || null,
  };
}

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(number(req.query.page) || 1, 1); const limit = Math.min(Math.max(number(req.query.limit) || 20, 1), 500);
    const q = text(req.query.q || req.query.search);
    const where = { isDeleted: false, ...(q ? { OR: [
      { quotationNumber: { contains: q, mode: "insensitive" } }, { customerName: { contains: q, mode: "insensitive" } },
      { customerCode: { contains: q, mode: "insensitive" } }, { status: { contains: q, mode: "insensitive" } },
    ] } : {}) };
    const [items, total] = await Promise.all([
      prisma.quotationHeader.findMany({ where, include: { customer: true, salesOrders: { where: { isDeleted: false }, select: { soNumber: true } } }, orderBy: { quotationDate: "desc" }, skip: (page - 1) * limit, take: limit }),
      prisma.quotationHeader.count({ where }),
    ]);
    res.json({ items, total, page, limit });
  } catch (error) { next(error); }
};

exports.get = async (req, res, next) => {
  try {
    const doc = await prisma.quotationHeader.findFirst({ where: { quotationNumber: req.params.quotationNumber, isDeleted: false }, include });
    if (!doc) return res.status(404).json({ message: "Quotation tidak ditemukan" });
    res.json(doc);
  } catch (error) { next(error); }
};

exports.generateNumber = async (_req, res, next) => { try { res.json({ quotationNumber: await nextNumber() }); } catch (error) { next(error); } };

exports.create = async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body.details) ? req.body.details : [];
    if (!rows.length) return res.status(400).json({ message: "Minimal satu item quotation wajib diisi" });
    const doc = await prisma.$transaction(async (tx) => {
      const quotationNumber = text(req.body.quotationNumber) || await nextNumber(tx);
      const details = rows.map((row, index) => detailData(row, index, quotationNumber));
      const totalAmount = details.reduce((sum, row) => sum + row.totalAmount, 0);
      return tx.quotationHeader.create({ data: { quotationNumber, ...headerData(req.body, req.user, totalAmount), details: { create: details.map(({ quotationNumber: _parent, ...row }) => row) } }, include });
    });
    res.status(201).json(doc);
  } catch (error) { next(error); }
};

exports.update = async (req, res, next) => {
  try {
    const existing = await prisma.quotationHeader.findFirst({ where: { quotationNumber: req.params.quotationNumber, isDeleted: false } });
    if (!existing) return res.status(404).json({ message: "Quotation tidak ditemukan" });
    const doc = await prisma.$transaction(async (tx) => {
      const rows = Array.isArray(req.body.details) ? req.body.details : null;
      let totalAmount = existing.totalAmount;
      if (rows) {
        const details = rows.map((row, index) => detailData(row, index, existing.quotationNumber));
        totalAmount = details.reduce((sum, row) => sum + row.totalAmount, 0);
        await tx.quotationDetail.deleteMany({ where: { quotationNumber: existing.quotationNumber } });
        if (details.length) await tx.quotationDetail.createMany({ data: details });
      }
      const data = headerData({ ...existing, ...req.body }, req.user, totalAmount); delete data.createdBy;
      return tx.quotationHeader.update({ where: { quotationNumber: existing.quotationNumber }, data, include });
    });
    res.json(doc);
  } catch (error) { next(error); }
};

exports.convertToSalesOrder = async (req, res, next) => {
  try {
    const quotation = await prisma.quotationHeader.findFirst({ where: { quotationNumber: req.params.quotationNumber, isDeleted: false }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } } });
    if (!quotation) return res.status(404).json({ message: "Quotation tidak ditemukan" });
    if (quotation.convertedToSO) return res.status(409).json({ message: `Quotation sudah menjadi ${quotation.convertedToSO}` });
    if (!["Approved", "Accepted"].includes(quotation.status)) return res.status(400).json({ message: "Quotation harus Approved/Accepted sebelum dibuat menjadi Sales Order" });
    const SalesOrderController = require("./SalesOrderController");
    const so = await SalesOrderController.createFromQuotation(quotation, req.body, req.user);
    res.status(201).json(so);
  } catch (error) { next(error); }
};

exports.remove = async (req, res, next) => {
  try {
    const doc = await prisma.quotationHeader.findFirst({ where: { quotationNumber: req.params.quotationNumber, isDeleted: false } });
    if (!doc) return res.status(404).json({ message: "Quotation tidak ditemukan" });
    if (doc.convertedToSO) return res.status(400).json({ message: "Quotation yang sudah menjadi SO tidak dapat dihapus" });
    await prisma.quotationHeader.update({ where: { quotationNumber: doc.quotationNumber }, data: { isDeleted: true, details: { updateMany: { where: {}, data: { isDeleted: true } } } } });
    res.json({ ok: true });
  } catch (error) { next(error); }
};
