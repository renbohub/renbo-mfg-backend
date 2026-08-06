const { prisma } = require("../../index");
const { queueDirtyPartCodes } = require("../../utils/mrpDirtyQueue");
const { syncReservationsForConfirmedSO } = require("../../services/production/sales-order/soReservationService");
const { replaceDeliveryTargets, assertCompleteDeliveryTargets, markDownstreamDemandChange } = require("../../services/planning/demandDeliveryTargetService");

const include = {
  customer: true, currency: true, quotation: true,
  details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" }, include: { part: true, uom: true, deliveryTargets: { where: { isDeleted: false, status: "ACTIVE" }, orderBy: { phaseNumber: "asc" } } } },
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
  return { soNumber, lineNumber: index + 1, partCode: text(row.partCode), partNumber: text(row.partNumber), partName: text(row.partName), uomCode: text(row.uomCode), mbomHeaderId: text(row.mbomHeaderId), qty, unitPrice, discount, discountType, tax, totalAmount: beforeTax + beforeTax * tax / 100, status: text(row.status) || "Pending", deliveryDate: date(row.deliveryDate), notes: text(row.notes) };
}
function headerData(body, user, totalAmount) {
  return { soDate: date(body.soDate) || new Date(), quotationNumber: text(body.quotationNumber), customerCode: text(body.customerCode), customerName: text(body.customerName), contact: text(body.contact), phone: text(body.phone), email: text(body.email), billingAddress: text(body.billingAddress), shippingAddress: text(body.shippingAddress), paymentTerms: text(body.paymentTerms), taxId: text(body.taxId), currencyCode: text(body.currencyCode) || "IDR", deliveryDate: date(body.deliveryDate), status: text(body.status) || "Draft", totalAmount, notes: text(body.notes), createdBy: user?.username || user?.email || null };
}

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(number(req.query.page) || 1, 1); const limit = Math.min(Math.max(number(req.query.limit) || 20, 1), 500); const q = text(req.query.q || req.query.search); const status = text(req.query.status);
    const where = { isDeleted: false, ...(status ? { status } : {}), ...(q ? { OR: [{ soNumber: { contains: q, mode: "insensitive" } }, { quotationNumber: { contains: q, mode: "insensitive" } }, { customerName: { contains: q, mode: "insensitive" } }, { status: { contains: q, mode: "insensitive" } }] } : {}) };
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
  await replaceDeliveryTargets(tx, { sourceType: "SALES_ORDER", sourceNumber: soNumber, customerCode: text(options.customerCode || quotation.customerCode), lines: so.details, inputRows: quotation.details, headerDeliveryDate: options.deliveryDate || quotation.details[0]?.deliveryDate, user: user?.username || user?.email });
  await tx.quotationHeader.update({ where: { quotationNumber: quotation.quotationNumber }, data: { convertedToSO: soNumber, status: "Converted" } });
  await queueDirtyPartCodes(tx, details.map((row) => row.partCode), { reason: "SO", sourceNumber: soNumber, notes: "Sales Order dari quotation mengubah demand." });
  return tx.salesOrderHeader.findUnique({ where: { soNumber }, include });
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
    const doc = await prisma.$transaction(async (tx) => { const soNumber = text(req.body.soNumber) || await nextNumber(tx); const details = rows.map((row, index) => detailData(row, index, soNumber)); const totalAmount = details.reduce((sum, row) => sum + row.totalAmount, 0); const created = await tx.salesOrderHeader.create({ data: { soNumber, ...headerData(req.body, req.user, totalAmount), details: { create: details.map(({ soNumber: _parent, ...row }) => row) } }, include }); await replaceDeliveryTargets(tx, { sourceType: "SALES_ORDER", sourceNumber: soNumber, customerCode: text(req.body.customerCode), lines: created.details, inputRows: rows, headerDeliveryDate: req.body.deliveryDate, user: req.user?.username || req.user?.email }); await queueDirtyPartCodes(tx, details.map((row) => row.partCode), { reason: "SO", sourceNumber: soNumber, notes: "Sales Order dibuat; net-change MRP dijadwalkan." }); return tx.salesOrderHeader.findUnique({ where: { soNumber }, include }); });
    res.status(201).json(doc);
  } catch (error) { next(error); }
};

exports.update = async (req, res, next) => {
  try {
    const existing = await prisma.salesOrderHeader.findFirst({ where: { soNumber: req.params.soNumber, isDeleted: false }, include: { details: { where: { isDeleted: false }, select: { partCode: true, deliveryTargets: { where: { isDeleted: false } } } } } });
    if (!existing) return res.status(404).json({ message: "Sales Order tidak ditemukan" });
    if (existing.status !== "Draft") return res.status(409).json({ message: `Sales Order ${existing.soNumber} sudah ${existing.status} dan tidak dapat diedit. Gunakan workflow revisi.` });
    const doc = await prisma.$transaction(async (tx) => { const rows = Array.isArray(req.body.details) ? req.body.details : null; let totalAmount = existing.totalAmount; let details = null; if (rows) { details = rows.map((row, index) => detailData(row, index, existing.soNumber)); totalAmount = details.reduce((sum, row) => sum + row.totalAmount, 0); await tx.salesOrderDetail.deleteMany({ where: { soNumber: existing.soNumber } }); if (details.length) await tx.salesOrderDetail.createMany({ data: details }); const createdLines = await tx.salesOrderDetail.findMany({ where: { soNumber: existing.soNumber, isDeleted: false }, orderBy: { lineNumber: "asc" } }); await replaceDeliveryTargets(tx, { sourceType: "SALES_ORDER", sourceNumber: existing.soNumber, customerCode: text(req.body.customerCode || existing.customerCode), lines: createdLines, inputRows: rows, headerDeliveryDate: req.body.deliveryDate || existing.deliveryDate, user: req.user?.username || req.user?.email, trackChange: true, previousTargets: existing.details.flatMap((row) => row.deliveryTargets || []), impactSourceNumbers: [existing.soNumber, existing.revisionOfSoNumber] }); } const data = headerData({ ...existing, ...req.body }, req.user, totalAmount); delete data.createdBy; const updated = await tx.salesOrderHeader.update({ where: { soNumber: existing.soNumber }, data, include }); await queueDirtyPartCodes(tx, [...existing.details.map((row) => row.partCode), ...(details || []).map((row) => row.partCode)], { reason: "SO", sourceNumber: existing.soNumber, notes: "Sales Order diubah; net-change MRP dijadwalkan." }); return updated; });
    res.json(doc);
  } catch (error) { next(error); }
};

// Confirmed orders are immutable. A revision creates a new Draft SO and marks
// the previous version Superseded so reservations and delivery history remain
// attached to the original document.
exports.revise = async (req, res, next) => {
  try {
    const reason = text(req.body?.reason);
    if (!reason) return res.status(400).json({ message: "Alasan revisi Sales Order wajib diisi." });
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.salesOrderHeader.findFirst({
        where: { soNumber: req.params.soNumber, isDeleted: false },
        include: {
          details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" }, include: { deliveryTargets: { where: { isDeleted: false, status: "ACTIVE" }, orderBy: { phaseNumber: "asc" } } } },
          deliverySchedules: { where: { isDeleted: false }, select: { status: true } },
        },
      });
      if (!existing) throw Object.assign(new Error("Sales Order tidak ditemukan"), { statusCode: 404 });
      if (!["Confirmed", "In Progress", "Ready to Deliver"].includes(existing.status)) {
        throw Object.assign(new Error(`Sales Order berstatus ${existing.status} tidak dapat direvisi. Revisi hanya tersedia setelah Confirmed.`), { statusCode: 409 });
      }
      const delivered = existing.details.some((row) => number(row.qtyDelivered) > 0);
      const activeDelivery = existing.deliverySchedules.some((row) => !["Cancelled", "Draft"].includes(row.status));
      if (delivered || activeDelivery) {
        throw Object.assign(new Error("Sales Order sudah memiliki delivery/qty terkirim. Buat dokumen koreksi atau backorder untuk sisa kuantitas."), { statusCode: 409 });
      }
      const soNumber = await nextNumber(tx);
      const revisionNumber = number(existing.revisionNumber) + 1;
      const notes = [existing.notes, `Revisi dari ${existing.soNumber}: ${reason}`].filter(Boolean).join("; ");
      const details = existing.details.map((row, index) => ({
        ...detailData({ ...row, status: "Pending" }, index, soNumber),
        qtyProduced: 0,
        qtyDelivered: 0,
        status: "Pending",
      }));
      const created = await tx.salesOrderHeader.create({
        data: {
          soNumber,
          ...headerData({ ...existing, status: "Draft", notes }, req.user, existing.totalAmount),
          revisionOfSoNumber: existing.soNumber,
          revisionNumber,
          revisionReason: reason,
          approvedBy: null,
          approvedDate: null,
          details: { create: details.map(({ soNumber: _parent, ...row }) => row) },
        },
        include,
      });
      await replaceDeliveryTargets(tx, { sourceType: "SALES_ORDER", sourceNumber: soNumber, customerCode: existing.customerCode, lines: created.details, inputRows: existing.details.map((row) => ({ ...row, deliveryTargets: row.deliveryTargets })), headerDeliveryDate: existing.deliveryDate, user: req.user?.username || req.user?.email });
      await tx.salesOrderHeader.update({
        where: { soNumber: existing.soNumber },
        data: { status: "Superseded", notes: [existing.notes, `Digantikan oleh ${soNumber}: ${reason}`].filter(Boolean).join("; ") },
      });
      await markDownstreamDemandChange(tx, {
        sourceType: "SALES_ORDER",
        sourceNumbers: [existing.soNumber],
        reason: `Sales Order ${existing.soNumber} direvisi menjadi ${soNumber}; MPS, MRP, dan Purchase Suggestion wajib dihitung ulang.`,
        user: req.user?.username || req.user?.email,
        changeType: "SALES_ORDER_REVISION",
      });
      await queueDirtyPartCodes(tx, details.map((row) => row.partCode), { reason: "SO", sourceNumber: soNumber, notes: `Revisi ${existing.soNumber} dibuat; net-change MRP dijadwalkan.` });
      const revised = await tx.salesOrderHeader.findUnique({ where: { soNumber }, include });
      return { ...revised, previousSoNumber: existing.soNumber };
    });
    res.status(201).json(result);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};
exports.remove = async (req, res, next) => { try { const doc = await prisma.salesOrderHeader.findFirst({ where: { soNumber: req.params.soNumber, isDeleted: false }, include: { details: { where: { isDeleted: false }, select: { partCode: true } } } }); if (!doc) return res.status(404).json({ message: "Sales Order tidak ditemukan" }); if (!["Draft", "Cancelled"].includes(doc.status)) return res.status(400).json({ message: "Hanya Sales Order Draft/Cancelled yang dapat dihapus" }); await prisma.$transaction(async (tx) => { await tx.salesOrderHeader.update({ where: { soNumber: doc.soNumber }, data: { isDeleted: true, details: { updateMany: { where: {}, data: { isDeleted: true } } } } }); await queueDirtyPartCodes(tx, doc.details.map((row) => row.partCode), { reason: "SO", sourceNumber: doc.soNumber, notes: "Sales Order dihapus; net-change MRP dijadwalkan." }); }); res.json({ ok: true }); } catch (error) { next(error); } };

exports.confirm = async (req, res, next) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const so = await tx.salesOrderHeader.findFirst({ where: { soNumber: req.params.soNumber, isDeleted: false }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } } });
      if (!so) throw Object.assign(new Error("Sales Order tidak ditemukan."), { statusCode: 404 });
      if (so.status !== "Draft") throw Object.assign(new Error(`Sales Order hanya dapat dikonfirmasi dari Draft. Status saat ini ${so.status}.`), { statusCode: 409 });
      if (!so.details.length || so.details.some((row) => Number(row.qty || 0) <= 0 || !row.partCode)) throw Object.assign(new Error("Semua line SO harus memiliki part dan qty lebih dari 0."), { statusCode: 400 });
      await assertCompleteDeliveryTargets(tx, "SALES_ORDER", so.soNumber, so.details);
      const reservation = await syncReservationsForConfirmedSO(tx, so, so.details);
      const updated = await tx.salesOrderHeader.update({ where: { id: so.id }, data: { status: "Confirmed", approvedBy: req.user?.username || req.user?.email || "system", approvedDate: new Date() }, include });
      return { ...updated, reservationWarnings: reservation.warnings || [] };
    });
    res.json(result);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message, warnings: error.warnings }); next(error); }
};
