const { prisma } = require("../../index");
const { queueDirtyPartCodes } = require("../../utils/mrpDirtyQueue");
const { syncReservationsForConfirmedSO } = require("../../services/production/sales-order/soReservationService");
const { replaceDeliveryTargets, retireDeliveryTargets, assertCompleteDeliveryTargets, markDownstreamDemandChange } = require("../../services/planning/demandDeliveryTargetService");
const { resolveSalesLinePreview } = require("../../services/sales/salesPricingService");

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
  const pricing = row.priceResolution || {};
  const margin = row.marginPreview || {};
  return { soNumber, lineNumber: index + 1, partCode: text(row.partCode), partNumber: text(row.partNumber), partName: text(row.partName), uomCode: text(row.uomCode), mbomHeaderId: text(row.mbomHeaderId || row.resolvedMbomHeaderId), qty, unitPrice, discount, discountType, tax, totalAmount: beforeTax + beforeTax * tax / 100, priceSource: text(pricing.code || row.priceSource), priceSourceId: text(pricing.priceSourceId || row.priceSourceId), originalMasterPrice: pricing.originalMasterPrice == null ? (row.originalMasterPrice == null ? null : number(row.originalMasterPrice)) : number(pricing.originalMasterPrice), priceOverrideReason: text(pricing.overrideReason || row.priceOverrideReason), priceOverriddenBy: pricing.code === "PRICE_OVERRIDE" ? text(row.priceOverriddenBy) : null, priceOverriddenAt: pricing.code === "PRICE_OVERRIDE" ? new Date() : null, estimatedMaterialCost: number(margin.estimatedBomMaterialCost), estimatedProcessCost: number(margin.estimatedProcessCost), estimatedOverheadCost: number(margin.estimatedOverheadCost), estimatedBomCostPerUnit: number(margin.estimatedBomCostPerUnit), estimatedTotalCost: number(margin.estimatedTotalCost), estimatedGrossContribution: number(margin.estimatedGrossContribution), estimatedMarginPercent: number(margin.estimatedMarginPercent), costingStatus: text(row.costingStatus), status: text(row.status) || "Pending", deliveryDate: date(row.deliveryDate), notes: text(row.notes) };
}

function canOverridePrice(user) {
  if (user?.isSuperAdmin) return true;
  return (user?.roleAssignments || []).some((assignment) => (assignment.role?.permissions || []).some((permission) => {
    const resource = String(permission.resourceCode || "").toLowerCase().replace(/[^a-z0-9*]/g, "");
    const actions = Array.isArray(permission.actions) ? permission.actions.map((action) => String(action).toLowerCase()) : [];
    return ["*", "salesorder", "salespriceoverride"].includes(resource) && (actions.includes("*") || actions.includes("approve"));
  }));
}

async function resolveAuthoritativeDetails(tx, rows, body, user) {
  return Promise.all(rows.map(async (row) => {
    const preview = await resolveSalesLinePreview(tx, {
      customerCode: text(body.customerCode), partCode: text(row.partCode), currencyCode: text(body.currencyCode) || "IDR", effectiveDate: date(body.soDate) || new Date(), qty: number(row.qty),
      requestedPrice: row.priceOverride === true || text(row.priceOverrideReason) ? number(row.unitPrice) : null,
      overrideReason: text(row.priceOverrideReason), canOverride: canOverridePrice(user),
    });
    return { ...row, unitPrice: preview.price.unitPrice, priceResolution: preview.price, marginPreview: preview.margin, costingStatus: preview.costStatus, resolvedMbomHeaderId: preview.mbomHeaderId, priceOverriddenBy: user?.username || user?.email || null };
  }));
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
exports.get = async (req, res, next) => { try { const doc = await prisma.salesOrderHeader.findFirst({ where: { soNumber: req.params.soNumber, isDeleted: false }, include }); if (!doc) return res.status(404).json({ message: "Sales Order tidak ditemukan" }); const targetIds=doc.details.flatMap((row)=>row.deliveryTargets.map((target)=>target.id));const decisions=targetIds.length?await prisma.demandPlanningDecision.findMany({where:{deliveryTargetId:{in:targetIds},isDeleted:false}}):[];const decisionByTarget=new Map(decisions.map((row)=>[row.deliveryTargetId,row]));res.json({...doc,details:doc.details.map((row)=>({...row,priceOverride:row.priceSource==="PRICE_OVERRIDE",deliveryTargets:row.deliveryTargets.map((target)=>({...target,planningDecision:decisionByTarget.get(target.id)||null}))}))}); } catch (error) { next(error); } };
exports.generateNumber = async (_req, res, next) => { try { res.json({ soNumber: await nextNumber() }); } catch (error) { next(error); } };
exports.linePreview = async (req, res, next) => {
  try {
    const preview = await resolveSalesLinePreview(prisma, { customerCode: text(req.query.customerCode), partCode: text(req.query.partCode), currencyCode: text(req.query.currencyCode) || "IDR", effectiveDate: date(req.query.effectiveDate) || new Date(), qty: number(req.query.qty), requestedPrice: null, canOverride: canOverridePrice(req.user) });
    res.json(preview);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ code: error.code, message: error.message }); next(error); }
};

// Active Forecast delivery phases available for explicit SO consumption.
exports.forecastTargets = async (req, res, next) => {
  try {
    const customerCode = text(req.query.customerCode);
    const partCode = text(req.query.partCode);
    if (!customerCode || !partCode) return res.status(400).json({ message: "Customer dan part wajib dipilih." });
    const targets = await prisma.demandDeliveryTarget.findMany({
      where: {
        sourceType: "FORECAST",
        customerCode,
        partCode,
        status: "ACTIVE",
        isDeleted: false,
        forecastDetail: {
          isDeleted: false,
          forecast: { isDeleted: false, isCurrentVersion: true, status: { not: "Obsolete" } },
        },
      },
      include: { forecastDetail: { include: { forecast: { select: { forecastName: true, status: true } } } } },
      orderBy: [{ targetDate: "asc" }, { sourceNumber: "asc" }, { phaseNumber: "asc" }],
    });
    const targetIds = targets.map((row) => row.id);
    const links = targetIds.length ? await prisma.demandDeliveryTarget.findMany({
      where: {
        sourceType: "SALES_ORDER",
        consumesForecastTargetId: { in: targetIds },
        status: "ACTIVE",
        isDeleted: false,
        soDetail: { isDeleted: false, soHeader: { isDeleted: false, status: { notIn: ["Cancelled", "Superseded"] } } },
      },
      select: { consumesForecastTargetId: true, qty: true, sourceNumber: true, targetDate: true },
    }) : [];
    const linkedByTarget = new Map();
    for (const link of links) {
      const current = linkedByTarget.get(link.consumesForecastTargetId) || { qty: 0, salesOrders: [] };
      current.qty += number(link.qty);
      current.salesOrders.push({ sourceNumber: link.sourceNumber, qty: number(link.qty), targetDate: link.targetDate });
      linkedByTarget.set(link.consumesForecastTargetId, current);
    }
    res.json(targets.map((target) => {
      const linked = linkedByTarget.get(target.id) || { qty: 0, salesOrders: [] };
      return {
        id: target.id,
        sourceNumber: target.sourceNumber,
        forecastName: target.forecastDetail?.forecast?.forecastName || null,
        phaseNumber: target.phaseNumber,
        targetDate: target.targetDate,
        qty: number(target.qty),
        linkedQty: linked.qty,
        availableQty: Math.max(number(target.qty) - linked.qty, 0),
        uomCode: target.uomCode,
        status: target.forecastDetail?.forecast?.status || "ACTIVE",
        linkedSalesOrders: linked.salesOrders,
      };
    }));
  } catch (error) { next(error); }
};

exports.createFromQuotation = async (quotation, options = {}, user) => prisma.$transaction(async (tx) => {
  const soNumber = text(options.soNumber) || await nextNumber(tx);
  const resolvedRows = await resolveAuthoritativeDetails(tx, quotation.details, { ...quotation, ...options, soDate: options.soDate || new Date() }, user);
  const details = resolvedRows.map((row, index) => detailData(row, index, soNumber));
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
    const doc = await prisma.$transaction(async (tx) => { const soNumber = text(req.body.soNumber) || await nextNumber(tx); const resolvedRows = await resolveAuthoritativeDetails(tx, rows, req.body, req.user); const details = resolvedRows.map((row, index) => detailData(row, index, soNumber)); const totalAmount = details.reduce((sum, row) => sum + row.totalAmount, 0); const created = await tx.salesOrderHeader.create({ data: { soNumber, ...headerData(req.body, req.user, totalAmount), details: { create: details.map(({ soNumber: _parent, ...row }) => row) } }, include }); await replaceDeliveryTargets(tx, { sourceType: "SALES_ORDER", sourceNumber: soNumber, customerCode: text(req.body.customerCode), lines: created.details, inputRows: rows, headerDeliveryDate: req.body.deliveryDate, user: req.user?.username || req.user?.email }); await queueDirtyPartCodes(tx, details.map((row) => row.partCode), { reason: "SO", sourceNumber: soNumber, notes: "Sales Order dibuat; net-change MRP dijadwalkan." }); return tx.salesOrderHeader.findUnique({ where: { soNumber }, include }); });
    res.status(201).json(doc);
  } catch (error) { next(error); }
};

exports.update = async (req, res, next) => {
  try {
    const existing = await prisma.salesOrderHeader.findFirst({ where: { soNumber: req.params.soNumber, isDeleted: false }, include: { details: { where: { isDeleted: false }, select: { partCode: true, deliveryTargets: { where: { isDeleted: false } } } } } });
    if (!existing) return res.status(404).json({ message: "Sales Order tidak ditemukan" });
    if (existing.status !== "Draft") return res.status(409).json({ message: `Sales Order ${existing.soNumber} sudah ${existing.status} dan tidak dapat diedit. Gunakan workflow revisi.` });
    const doc = await prisma.$transaction(async (tx) => { const rows = Array.isArray(req.body.details) ? req.body.details : null; let totalAmount = existing.totalAmount; let details = null; if (rows) { const resolvedRows = await resolveAuthoritativeDetails(tx, rows, { ...existing, ...req.body }, req.user); details = resolvedRows.map((row, index) => detailData(row, index, existing.soNumber)); totalAmount = details.reduce((sum, row) => sum + row.totalAmount, 0); await tx.salesOrderDetail.deleteMany({ where: { soNumber: existing.soNumber } }); if (details.length) await tx.salesOrderDetail.createMany({ data: details }); const createdLines = await tx.salesOrderDetail.findMany({ where: { soNumber: existing.soNumber, isDeleted: false }, orderBy: { lineNumber: "asc" } }); await replaceDeliveryTargets(tx, { sourceType: "SALES_ORDER", sourceNumber: existing.soNumber, customerCode: text(req.body.customerCode || existing.customerCode), lines: createdLines, inputRows: rows, headerDeliveryDate: req.body.deliveryDate || existing.deliveryDate, user: req.user?.username || req.user?.email, trackChange: true, previousTargets: existing.details.flatMap((row) => row.deliveryTargets || []), impactSourceNumbers: [existing.soNumber, existing.revisionOfSoNumber] }); } const data = headerData({ ...existing, ...req.body }, req.user, totalAmount); delete data.createdBy; const updated = await tx.salesOrderHeader.update({ where: { soNumber: existing.soNumber }, data, include }); await queueDirtyPartCodes(tx, [...existing.details.map((row) => row.partCode), ...(details || []).map((row) => row.partCode)], { reason: "SO", sourceNumber: existing.soNumber, notes: "Sales Order diubah; net-change MRP dijadwalkan." }); return updated; });
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
      const resolvedRows = await resolveAuthoritativeDetails(tx, existing.details, { ...existing, soDate: new Date() }, req.user);
      const details = resolvedRows.map((row, index) => ({
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
      await retireDeliveryTargets(tx, {
        sourceType: "SALES_ORDER",
        sourceNumber: existing.soNumber,
        status: "SUPERSEDED",
        user: req.user?.username || req.user?.email,
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
exports.remove = async (req, res, next) => { try { const doc = await prisma.salesOrderHeader.findFirst({ where: { soNumber: req.params.soNumber, isDeleted: false }, include: { details: { where: { isDeleted: false }, select: { partCode: true } } } }); if (!doc) return res.status(404).json({ message: "Sales Order tidak ditemukan" }); if (!["Draft", "Cancelled"].includes(doc.status)) return res.status(400).json({ message: "Hanya Sales Order Draft/Cancelled yang dapat dihapus" }); await prisma.$transaction(async (tx) => { await retireDeliveryTargets(tx, { sourceType: "SALES_ORDER", sourceNumber: doc.soNumber, status: "CANCELLED", user: req.user?.username || req.user?.email, markDeleted: true }); await tx.salesOrderHeader.update({ where: { soNumber: doc.soNumber }, data: { isDeleted: true, details: { updateMany: { where: {}, data: { isDeleted: true } } } } }); await queueDirtyPartCodes(tx, doc.details.map((row) => row.partCode), { reason: "SO", sourceNumber: doc.soNumber, notes: "Sales Order dihapus; net-change MRP dijadwalkan." }); }); res.json({ ok: true }); } catch (error) { next(error); } };

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
