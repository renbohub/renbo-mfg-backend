const { prisma } = require("../../index");
const { resolveDeliveryReadiness } = require("../../services/outgoing/deliveryReadinessService");

const pageArgs = (req) => {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 500);
  return { page, limit, skip: (page - 1) * limit };
};
const text = (value) => String(value || "").trim();
const statusFilter = (req, where) => { if (text(req.query.status)) where.status = text(req.query.status); return where; };
const totalQty = (rows, key) => (rows || []).reduce((sum, row) => sum + Number(row[key] || 0), 0);

async function sendList(req, res, next, options) {
  try {
    const { page, limit, skip } = pageArgs(req);
    const where = options.where(req);
    const [items, total] = await Promise.all([
      options.delegate.findMany({ where, include: options.include, orderBy: options.orderBy, skip, take: limit }),
      options.delegate.count({ where }),
    ]);
    res.json({ items: options.map ? await Promise.all(items.map(options.map)) : items, total, page, limit });
  } catch (error) { next(error); }
}

async function sendDetail(req, res, next, options) {
  try {
    const value = req.params[options.param];
    const item = await options.delegate.findFirst({ where: { [options.key]: value, ...(options.notDeleted ? { isDeleted: false } : {}) }, include: options.include });
    if (!item) return res.status(404).json({ message: `${options.label} tidak ditemukan.` });
    res.json(options.map ? await options.map(item) : item);
  } catch (error) { next(error); }
}

const requisitionListInclude = {
  department: { select: { departmentCode: true, departmentName: true } },
  details: { where: { isDeleted: false }, select: { id: true, qty: true, orderedQty: true } },
};
const requisitionDetailInclude = {
  department: true,
  details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" }, include: { product: true } },
  purchaseOrders: { include: { po: { select: { poNumber: true, poDate: true, status: true, supplierName: true, vendorName: true } } } },
};
const requisitionWhere = (req) => {
  const where = statusFilter(req, { isDeleted: false });
  const q = text(req.query.q || req.query.search);
  if (q) where.OR = ["prNumber", "requestedBy", "priority", "poType", "notes"].map((key) => ({ [key]: { contains: q, mode: "insensitive" } }));
  return where;
};
exports.listPurchaseRequisitions = (req, res, next) => sendList(req, res, next, {
  delegate: prisma.purchaseRequisition, where: requisitionWhere, include: requisitionListInclude, orderBy: { prDate: "desc" },
  map: (row) => ({ ...row, requestedQty: totalQty(row.details, "qty"), orderedQty: totalQty(row.details, "orderedQty"), lineCount: row.details.length }),
});
exports.getPurchaseRequisition = (req, res, next) => sendDetail(req, res, next, { delegate: prisma.purchaseRequisition, key: "prNumber", param: "prNumber", label: "Purchase Requisition", notDeleted: true, include: requisitionDetailInclude });

const invoiceListInclude = {
  purchaseOrders: { select: { poNumber: true } },
  details: { select: { id: true, qtyInvoiced: true, varianceAmount: true } },
  payments: { select: { amountPayment: true, outstandingPayment: true } },
};
const invoiceDetailInclude = {
  supplier: true, vendor: true, currency: true,
  purchaseOrders: { include: { po: { select: { poNumber: true, poDate: true, totalAmount: true, status: true } } } },
  details: { orderBy: { lineNumber: "asc" }, include: { poDetail: true, grDetail: true, product: true } },
  payments: { orderBy: { lineNumber: "asc" } },
};
const invoiceWhere = (req) => {
  const where = statusFilter(req, { isDeleted: false });
  const q = text(req.query.q || req.query.search);
  if (q) where.OR = ["invoiceNumber", "supplierInvoiceNumber", "poNumber", "supplierName", "vendorName", "matchStatus"].map((key) => ({ [key]: { contains: q, mode: "insensitive" } }));
  return where;
};
exports.listPurchaseInvoices = (req, res, next) => sendList(req, res, next, {
  delegate: prisma.purchaseInvoice, where: invoiceWhere, include: invoiceListInclude, orderBy: { invoiceDate: "desc" },
  map: (row) => ({ ...row, poCount: row.purchaseOrders.length, paidAmount: totalQty(row.payments, "amountPayment"), outstandingAmount: totalQty(row.payments, "outstandingPayment") }),
});
exports.getPurchaseInvoice = (req, res, next) => sendDetail(req, res, next, { delegate: prisma.purchaseInvoice, key: "invoiceNumber", param: "invoiceNumber", label: "Purchase Invoice", notDeleted: true, include: invoiceDetailInclude });

const receiptListInclude = {
  po: { select: { supplierCode: true, supplierName: true, vendorCode: true, vendorName: true, deliveryDate: true } },
  warehouse: { select: { warehouseCode: true, warehouseName: true } },
  details: { where: { isDeleted: false }, select: { qtyOrdered: true, qtyReceived: true, qtyInspected: true } },
};
const receiptDetailInclude = {
  po: { include: { supplier: true, vendor: true } }, warehouse: true,
  details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" }, include: { poDetail: { include: { prDetail: { include: { sources: { where: { isDeleted: false } }, sourcingAllocations: { where: { isDeleted: false } } } } } }, rack: true, allocations: { where: { isDeleted: false }, orderBy: [{ requiredDate: "asc" }, { createdAt: "asc" }] } } },
  incomingInspections: { where: { isDeleted: false }, orderBy: { inspectionDate: "desc" } },
};
const receiptWhere = (req) => {
  const where = statusFilter(req, { isDeleted: false });
  const q = text(req.query.q || req.query.search);
  if (q) where.OR = ["grNumber", "poNumber", "warehouseCode", "deliveryNoteNumber", "receivedBy"].map((key) => ({ [key]: { contains: q, mode: "insensitive" } }));
  return where;
};
exports.listGoodsReceipts = (req, res, next) => sendList(req, res, next, {
  delegate: prisma.goodsReceipt, where: receiptWhere, include: receiptListInclude, orderBy: { grDate: "desc" },
  map: (row) => ({ ...row, supplierName: row.po?.supplierName || row.po?.vendorName || "-", qtyReceived: totalQty(row.details, "qtyReceived"), qtyInspected: totalQty(row.details, "qtyInspected") }),
});
exports.getGoodsReceipt = (req, res, next) => sendDetail(req, res, next, { delegate: prisma.goodsReceipt, key: "grNumber", param: "grNumber", label: "Goods Receipt", notDeleted: true, include: receiptDetailInclude });

const inspectionListInclude = {
  gr: { select: { poNumber: true, warehouseCode: true, deliveryNoteNumber: true } },
  details: { select: { qtyInspected: true, qtyAccepted: true, qtyRejected: true, qtyRework: true } },
};
const inspectionDetailInclude = {
  gr: { include: { po: true, warehouse: true } },
  details: { orderBy: { lineNumber: "asc" }, include: { grDetail: { include: { poDetail: { include: { prDetail: { include: { sources: { where: { isDeleted: false } }, sourcingAllocations: { where: { isDeleted: false } } } } } }, rack: true, allocations: { where: { isDeleted: false }, orderBy: [{ requiredDate: "asc" }, { createdAt: "asc" }] } } } } },
};
const inspectionWhere = (req) => {
  const where = statusFilter(req, { isDeleted: false });
  const q = text(req.query.q || req.query.search);
  if (q) where.OR = ["inspectionNumber", "grNumber", "decision", "inspectedBy"].map((key) => ({ [key]: { contains: q, mode: "insensitive" } }));
  return where;
};
exports.listIncomingInspections = (req, res, next) => sendList(req, res, next, {
  delegate: prisma.incomingInspection, where: inspectionWhere, include: inspectionListInclude, orderBy: { inspectionDate: "desc" },
  map: (row) => ({ ...row, qtyInspected: totalQty(row.details, "qtyInspected"), qtyAccepted: totalQty(row.details, "qtyAccepted"), qtyRejected: totalQty(row.details, "qtyRejected") }),
});
exports.getIncomingInspection = (req, res, next) => sendDetail(req, res, next, { delegate: prisma.incomingInspection, key: "inspectionNumber", param: "inspectionNumber", label: "Incoming Inspection", notDeleted: true, include: inspectionDetailInclude });

const supplierDeliveryWhere = (req) => {
  const where = { isDeleted: false, status: { in: ["Sent", "Confirmed", "Partial Receipt", "Completed"] } };
  const q = text(req.query.q || req.query.search);
  if (q) where.OR = ["poNumber", "supplierName", "vendorName", "supplierCode", "vendorCode"].map((key) => ({ [key]: { contains: q, mode: "insensitive" } }));
  return where;
};
const supplierDeliveryMap = (row) => ({ ...row, deliveryNumber: row.poNumber, partnerName: row.supplierName || row.vendorName || "-", plannedQty: totalQty(row.details, "qty"), receivedQty: totalQty(row.details, "qtyReceived") });
exports.listSupplierDeliveries = (req, res, next) => sendList(req, res, next, { delegate: prisma.purchaseOrder, where: supplierDeliveryWhere, include: { details: { where: { isDeleted: false }, select: { qty: true, qtyReceived: true } }, goodsReceipts: { where: { isDeleted: false }, select: { grNumber: true, grDate: true, status: true } } }, orderBy: { deliveryDate: "desc" }, map: supplierDeliveryMap });
exports.getSupplierDelivery = (req, res, next) => sendDetail(req, res, next, { delegate: prisma.purchaseOrder, key: "poNumber", param: "poNumber", label: "Supplier Delivery", notDeleted: true, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" }, include: { prDetail: { include: { sources: { where: { isDeleted: false } }, sourcingAllocations: { where: { isDeleted: false } } } } } }, goodsReceipts: { where: { isDeleted: false }, orderBy: { grDate: "desc" } }, supplier: true, vendor: true }, map: supplierDeliveryMap });

const putawayWhere = (req) => {
  const where = { isDeleted: false, direction: "IN", transactionType: { in: ["PURCHASE_RECEIVE", "QUALITY_RELEASE"] } };
  const q = text(req.query.q || req.query.search);
  if (q) where.OR = ["movementNumber", "referenceNumber", "partCode", "partName", "warehouseCode", "rackCode", "lotNumber"].map((key) => ({ [key]: { contains: q, mode: "insensitive" } }));
  return where;
};
exports.listPutaway = (req, res, next) => sendList(req, res, next, { delegate: prisma.stockMovement, where: putawayWhere, include: { warehouse: true, rack: true }, orderBy: { movementDate: "desc" } });
exports.getPutaway = (req, res, next) => sendDetail(req, res, next, { delegate: prisma.stockMovement, key: "movementNumber", param: "movementNumber", label: "Putaway", notDeleted: true, include: { warehouse: true, rack: true, destinationRack: true } });

const deliveryOrderWhere = (req) => {
  // A Delivery Order is represented by an SO that has an active delivery
  // schedule. Keep legacy non-draft SOs visible, but also surface schedules
  // created before the SO workflow hardening so the operational document is
  // never hidden from the Delivery Orders menu.
  const where = statusFilter(req, { isDeleted: false, OR: [
    { status: { notIn: ["Draft", "Cancelled"] } },
    { deliverySchedules: { some: { isDeleted: false, status: { notIn: ["Cancelled", "Failed"] } } } },
  ] });
  const q = text(req.query.q || req.query.search);
  if (q) where.AND = [{ OR: ["soNumber", "customerCode", "customerName", "shippingAddress"].map((key) => ({ [key]: { contains: q, mode: "insensitive" } })) }];
  return where;
};
const deliveryOrderMap = (row) => ({ ...row, deliveryOrderNumber: row.soNumber, plannedQty: totalQty(row.details, "qty"), deliveredQty: totalQty(row.details, "qtyDelivered"), scheduleCount: row.deliverySchedules.length });
exports.listDeliveryOrders = (req, res, next) => sendList(req, res, next, { delegate: prisma.salesOrderHeader, where: deliveryOrderWhere, include: { details: { where: { isDeleted: false }, select: { qty: true, qtyDelivered: true } }, deliverySchedules: { where: { isDeleted: false }, select: { scheduleNumber: true, status: true, plannedDate: true } } }, orderBy: { deliveryDate: "desc" }, map: deliveryOrderMap });
exports.getDeliveryOrder = (req, res, next) => sendDetail(req, res, next, { delegate: prisma.salesOrderHeader, key: "soNumber", param: "soNumber", label: "Delivery Order", notDeleted: true, include: { customer: true, details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } }, deliverySchedules: { where: { isDeleted: false }, include: { details: true }, orderBy: { plannedDate: "asc" } } }, map: deliveryOrderMap });

const scheduleInclude = { soHeader: { select: { customerCode: true, customerName: true, shippingAddress: true } }, details: { where: { isDeleted: false }, include: { soDetail: true } } };
const scheduleDetailInclude = { soHeader: { include: { customer: true } }, details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" }, include: { soDetail: true } } };
const scheduleMap = async (row) => ({
  ...row,
  customerCode: row.soHeader?.customerCode,
  customerName: row.soHeader?.customerName,
  plannedQty: totalQty(row.details, "qty"),
  deliveredQty: totalQty(row.details, "qtyDelivered"),
  ...await resolveDeliveryReadiness(prisma, row.scheduleNumber),
});
const scheduleWhere = (statuses) => (req) => {
  const where = { isDeleted: false, ...(statuses ? { status: { in: statuses } } : {}) };
  const requestedStatus = text(req.query.status); if (requestedStatus) where.status = requestedStatus;
  const q = text(req.query.q || req.query.search);
  if (q) where.OR = ["scheduleNumber", "soNumber", "trackingNumber", "shippingMethod", "deliveryAddress"].map((key) => ({ [key]: { contains: q, mode: "insensitive" } }));
  return where;
};
const listSchedules = (statuses) => (req, res, next) => sendList(req, res, next, { delegate: prisma.deliverySchedule, where: scheduleWhere(statuses), include: scheduleInclude, orderBy: { plannedDate: "desc" }, map: scheduleMap });
const getSchedule = (label) => (req, res, next) => sendDetail(req, res, next, { delegate: prisma.deliverySchedule, key: "scheduleNumber", param: "scheduleNumber", label, notDeleted: true, include: scheduleDetailInclude, map: scheduleMap });
exports.listDeliverySchedules = listSchedules(null);
exports.getDeliverySchedule = getSchedule("Delivery Schedule");
exports.listPickingPacking = listSchedules(["Scheduled", "On Process"]);
exports.getPickingPacking = getSchedule("Picking & Packing");
exports.listShipments = listSchedules(["In Transit", "Delivered"]);
exports.getShipment = getSchedule("Shipment");
