const express = require('express');
const multer = require('multer');
const { randomUUID } = require('node:crypto');
const domain = require('../../services/incoming/partnerPortalDomain');
const documents = require('../../services/incoming/incomingDocumentService');
const { createPartnerAccessMiddleware, publicAccess } = require('../../middleware/partnerAccess');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 2 } }).single('document');
const wrap = fn => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { if (e.statusCode || e.code?.startsWith('LIMIT_')) return res.status(e.statusCode || 400).json({ message: e.code?.startsWith('LIMIT_') ? 'Unggah satu dokumen maksimal 10 MB.' : e.message }); if (e.code === 'P2002') return res.status(409).json({ message: 'Nomor surat jalan sudah terdaftar untuk PO ini.' }); next(e); } };
const detailSelect = { id: true, lineNumber: true, materialCode: true, materialName: true, partCode: true, partName: true, description: true, qty: true, qtyReceived: true, uomCode: true };
const receiptSelect = {
  grNumber: true, poNumber: true, grDate: true, receivedDate: true, status: true, deliveryNoteNumber: true,
  incomingDocuments: { select: { id: true, fileName: true, fileType: true, fileSize: true, createdAt: true } },
  details: { where: { isDeleted: false }, select: { id: true, lineNumber: true, qtyReceived: true, uomCode: true, supplierLotNumber: true, poDetail: { select: { materialCode: true, materialName: true, partCode: true, partName: true, description: true } }, incomingInspectionDetails: { where: { inspection: { isDeleted: false } }, select: { qtyAccepted: true, qtyRejected: true, defectCode: true, defectCategory: true, notes: true, checklist: true, inspection: { select: { inspectionNumber: true, status: true, decision: true } } } } } },
};
function createPartnerPortalRouter(db) {
  const router = express.Router();
  const access = createPartnerAccessMiddleware(db);
  router.use(access.loadPartnerAccess, access.requirePartner);
  router.get('/me', (req, res) => res.json({ userName: req.user.fullName || req.user.username, partnerAccess: publicAccess(req.partnerAccess) }));
  router.get('/purchase-orders', wrap(async (req, res) => {
    const rows = await db.purchaseOrder.findMany({ where: { ...domain.partyScope(req.partnerAccess), isDeleted: false, status: { in: ['Sent', 'Confirmed', 'Partial Receipt'] } }, orderBy: { deliveryDate: 'asc' }, select: { poNumber: true, deliveryDate: true, status: true, details: { where: { isDeleted: false }, select: detailSelect }, partnerNotices: { where: { status: 'Submitted' }, select: { details: true } } } });
    res.json(rows.map(po => ({ poNumber: po.poNumber, deliveryDate: po.deliveryDate, status: po.status, details: po.details.map(line => ({ ...line, qtyUnregistered: Math.max(0, Number(line.qty) - Number(line.qtyReceived) - po.partnerNotices.flatMap(n => n.details || []).filter(n => n.poDetailId === line.id).reduce((sum, n) => sum + Number(n.qty || 0), 0)) })) })));
  }));
  router.get('/dashboard', wrap(async (req, res) => {
    const scope = domain.partyScope(req.partnerAccess), period = domain.dateRange(req.query);
    const [notices, receipts, ownedVendorOrders] = await Promise.all([
      db.partnerDeliveryNotice.findMany({ where: { po: { ...scope, isDeleted: false }, expectedDate: period.where }, orderBy: { expectedDate: 'desc' }, select: { id: true, noticeNumber: true, poNumber: true, deliveryNoteNumber: true, expectedDate: true, details: true, status: true, grNumber: true, documents: { select: { id: true, fileName: true, fileSize: true } } } }),
      db.goodsReceipt.findMany({ where: { po: { ...scope, isDeleted: false }, isDeleted: false, receivedDate: period.where }, orderBy: { receivedDate: 'desc' }, select: receiptSelect }),
      req.partnerAccess.vendorCode ? db.vendorProcessOrder.findMany({ where: { vendorCode: req.partnerAccess.vendorCode, isDeleted: false }, orderBy: { receivedAt: 'desc' }, select: { orderNumber: true, receivedAt: true, sentAt: true, status: true, outputPartCode: true, outputPartName: true, uomCode: true, qualityInspections: { where: { isDeleted: false }, select: { inspectionNumber: true, status: true, approvedAt: true, inspectionDate: true, qtyPassed: true, qtyFailed: true } } } }) : Promise.resolve([]),
    ]);
    const movements = ownedVendorOrders.length ? await db.stockMovement.findMany({ where: { isDeleted: false, referenceType: 'VENDOR_PROCESS_ORDER', referenceNumber: { in: ownedVendorOrders.map(row => row.orderNumber) }, transactionType: 'QC_HOLD', direction: 'IN', movementDate: period.where }, select: { referenceNumber: true, movementDate: true, qty: true } }) : [];
    const inPeriod = value => value && new Date(value) >= period.where.gte && new Date(value) < period.where.lt;
    // Vendor orders store lifetime cumulative quantities and the first receipt date.
    // Use arrival movements and completed inspection dates so partial receipts in
    // different months cannot be counted again as this month's deliveries.
    const vendorOrders = ownedVendorOrders.map(order => {
      const arrivals = movements.filter(row => row.referenceNumber === order.orderNumber);
      const decisions = order.qualityInspections.filter(row => row.status === 'Completed' && inPeriod(row.approvedAt || row.inspectionDate));
      return { ...order, receivedAt: arrivals.length ? arrivals.reduce((date,row) => new Date(row.movementDate) > new Date(date) ? row.movementDate : date, arrivals[0].movementDate) : null, qtyReceived: arrivals.reduce((sum,row) => sum + Number(row.qty), 0), qtyAccepted: decisions.reduce((sum,row) => sum + Number(row.qtyPassed), 0), qtyReject: decisions.reduce((sum,row) => sum + Number(row.qtyFailed), 0), relevant: arrivals.length > 0 || decisions.length > 0 || inPeriod(order.sentAt) };
    }).filter(row => row.relevant).map(({ relevant, ...row }) => row);
    res.json({ period: { from: period.from, to: period.to }, notices, receipts, vendorOrders, summaryByUom: domain.summarizeUnits(receipts, vendorOrders) });
  }));
  router.post('/notices', wrap(async (req, res) => {
    const result = await db.$transaction(async tx => {
      const poNumber = domain.text(req.body.poNumber, 100);
      await tx.$queryRaw`SELECT id FROM "tbl_purchase_order" WHERE "po_number" = ${poNumber} FOR UPDATE`;
      const po = await tx.purchaseOrder.findFirst({ where: { poNumber, ...domain.partyScope(req.partnerAccess), isDeleted: false }, include: { details: { where: { isDeleted: false } } } });
      if (!po) domain.fail('PO tidak ditemukan.', 404);
      const pending = await tx.partnerDeliveryNotice.findMany({ where: { poNumber, status: 'Submitted' }, select: { details: true } });
      const reserved = new Map();
      for (const row of pending.flatMap(n => n.details || [])) reserved.set(row.poDetailId, (reserved.get(row.poDetailId) || 0) + Number(row.qty || 0));
      const input = domain.validateNotice(req.body, po, reserved);
      return tx.partnerDeliveryNotice.create({ data: { ...input, poNumber, partnerAccessId: req.partnerAccess.id, noticeNumber: `ASN-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8).toUpperCase()}`, createdBy: req.user.id }, select: { id: true, noticeNumber: true, status: true } });
    });
    res.status(201).json(result);
  }));
  router.post('/notices/:noticeId/cancel', wrap(async (req, res) => {
    const result = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "tbl_partner_delivery_notice" WHERE id = ${req.params.noticeId} FOR UPDATE`;
      const row = await tx.partnerDeliveryNotice.findFirst({ where: { id: req.params.noticeId, po: { ...domain.partyScope(req.partnerAccess), isDeleted: false } } });
      if (!row) domain.fail('Pendaftaran tidak ditemukan.', 404);
      if (row.status !== 'Submitted') domain.fail('Pendaftaran sudah diterima atau dibatalkan.', 409);
      return tx.partnerDeliveryNotice.update({ where: { id: row.id }, data: { status: 'Cancelled' }, select: { id: true, status: true } });
    }); res.json(result);
  }));
  router.post('/notices/:noticeId/documents', upload, wrap(async (req, res) => {
    let cleanup;
    try {
      const result = await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "tbl_partner_delivery_notice" WHERE id = ${req.params.noticeId} FOR UPDATE`;
        const notice = await tx.partnerDeliveryNotice.findFirst({ where: { id: req.params.noticeId, po: { ...domain.partyScope(req.partnerAccess), isDeleted: false } } });
        if (!notice) domain.fail('Pendaftaran tidak ditemukan.', 404);
        if (notice.status !== 'Submitted') domain.fail('Dokumen hanya dapat ditambahkan sebelum penerimaan.', 409);
        const result = await documents.saveDocument(tx, { file: req.file, noticeId: notice.id, actor: req.user.id });
        cleanup = result.cleanup; return documents.publicDocument(result.saved);
      }); res.status(201).json(result);
    } catch (e) { if (cleanup) await cleanup(); throw e; }
  }));
  router.get('/documents/:documentId', wrap((req, res) => documents.downloadDocument(db, req, res, domain.partyScope(req.partnerAccess))));
  router.use((err, req, res, next) => err instanceof multer.MulterError ? res.status(400).json({ message: 'Unggah satu dokumen maksimal 10 MB.' }) : next(err));
  return router;
}
module.exports = { createPartnerPortalRouter, upload, wrap };
