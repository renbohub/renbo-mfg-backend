const express = require('express');
const PDFDocument = require('pdfkit');
const { authorize } = require('../../middleware/auth');
const { createPartnerAccessMiddleware } = require('../../middleware/partnerAccess');
const { upload, wrap } = require('./partner-portal');
const docs = require('../../services/incoming/incomingDocumentService');
const { fail, CHECKLIST, normalizeChecklist } = require('../../services/incoming/partnerPortalDomain');
function createIncomingEvidenceRouter(db) {
  const router = express.Router(), access = createPartnerAccessMiddleware(db);
  router.use(access.loadPartnerAccess, access.internalOnly);
  router.get('/documents/:documentId', authorize('purchaseOrder', 'read'), wrap((req, res) => docs.downloadDocument(db, req, res)));
  router.get('/goods-receipts/:grNumber/documents', authorize('purchaseOrder', 'read'), wrap(async (req, res) => {
    const gr = await db.goodsReceipt.findFirst({ where: { grNumber: req.params.grNumber, isDeleted: false }, select: { grNumber: true } });
    if (!gr) fail('Goods receipt tidak ditemukan.', 404);
    const rows = await db.incomingDocument.findMany({ where: { OR: [{ grNumber: gr.grNumber }, { notice: { grNumber: gr.grNumber } }] }, orderBy: { createdAt: 'asc' } }); res.json(rows.map(docs.publicDocument));
  }));
  router.post('/goods-receipts/:grNumber/documents', authorize('purchaseOrder', 'update'), upload, wrap(async (req, res) => {
    let cleanup;
    try {
      const result = await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "tbl_goods_receipt" WHERE "gr_number" = ${req.params.grNumber} FOR UPDATE`;
        const gr = await tx.goodsReceipt.findFirst({ where: { grNumber: req.params.grNumber, isDeleted: false }, include: { details: { where: { isDeleted: false } } } });
        if (!gr) fail('Goods receipt tidak ditemukan.', 404);
        if (gr.status === 'Cancelled') fail('Goods receipt dibatalkan.', 409);
        const result = await docs.saveDocument(tx, { file: req.file, grNumber: gr.grNumber, actor: req.user.id });
        cleanup = result.cleanup;
        const metadata = { ...docs.publicDocument(result.saved), fileUrl: `/api/incoming/documents/${result.saved.id}` };
        for (const line of gr.details) await tx.goodsReceiptDetail.update({ where: { id: line.id }, data: { deliveryNoteFiles: [...(Array.isArray(line.deliveryNoteFiles) ? line.deliveryNoteFiles : []), metadata] } });
        return metadata;
      }); res.status(201).json(result);
    } catch (error) { if (cleanup) await cleanup(); throw error; }
  }));
  const getInspection = async number => {
    const item = await db.incomingInspection.findFirst({ where: { inspectionNumber: number, isDeleted: false }, include: { details: { orderBy: { lineNumber: 'asc' }, include: { grDetail: { include: { poDetail: { select: { materialCode: true, partCode: true, materialName: true, partName: true, description: true } } } } } }, gr: { select: { grNumber: true, poNumber: true, deliveryNoteNumber: true } } } });
    if (!item) fail('Inspection tidak ditemukan.', 404); return item;
  };
  router.get('/incoming-inspections/:inspectionNumber/checklist', authorize('purchaseOrder', 'read'), wrap(async (req, res) => res.json({ inspection: await getInspection(req.params.inspectionNumber), criteria: CHECKLIST })));
  router.put('/incoming-inspections/:inspectionNumber/checklist', authorize('purchaseOrder', 'update'), wrap(async (req, res) => {
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "tbl_incoming_inspection" WHERE "inspection_number" = ${req.params.inspectionNumber} FOR UPDATE`;
      const item = await tx.incomingInspection.findFirst({ where: { inspectionNumber: req.params.inspectionNumber, isDeleted: false }, include: { details: true } });
      if (!item) fail('Inspection tidak ditemukan.', 404);
      if (item.status !== 'Open') fail('Checklist hanya dapat diubah pada inspeksi yang masih Open.', 409);
      const lines = req.body.lines;
      if (!Array.isArray(lines) || lines.length !== item.details.length || new Set(lines.map(line => line.id)).size !== item.details.length) fail('Checklist wajib diisi untuk semua baris inspeksi.');
      for (const line of lines) {
        if (!item.details.some(row => row.id === line.id)) fail('Baris inspeksi tidak valid.');
        const checklist = normalizeChecklist(line.rows, { actor: req.user.username || req.user.id });
        await tx.incomingInspectionDetail.update({ where: { id: line.id }, data: { checklist } });
      }
    }); res.json({ message: 'Checklist tersimpan. Selesaikan keputusan qty melalui halaman IQC setelah seluruh kriteria diperiksa.' });
  }));
  router.get('/incoming-inspections/:inspectionNumber/report.pdf', authorize('purchaseOrder', 'read'), wrap(async (req, res) => {
    const item = await getInspection(req.params.inspectionNumber);
    const pdf = new PDFDocument({ size: 'A4', margin: 42 });
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="IQC-${item.inspectionNumber.replace(/[^a-zA-Z0-9-]/g, '')}.pdf"`); res.setHeader('Cache-Control', 'private, no-store');
    pdf.pipe(res);
    pdf.fontSize(18).text('Laporan Verifikasi Incoming');
    pdf.moveDown().fontSize(10).text(`IQC: ${item.inspectionNumber} | Status: ${item.status} | Keputusan: ${item.decision}`);
    pdf.text(`GR: ${item.grNumber} | PO: ${item.gr.poNumber} | Surat jalan: ${item.gr.deliveryNoteNumber || '-'}`);
    pdf.text(`Pemeriksa: ${item.inspectedBy || '-'} | Diselesaikan: ${item.approvedBy || '-'} | ${item.approvedAt?.toISOString() || '-'}`);
    for (const line of item.details) {
      const detail = line.grDetail, part = detail.poDetail;
      pdf.moveDown().fontSize(12).text(`Baris ${line.lineNumber}: ${part.materialCode || part.partCode || ''} ${part.materialName || part.partName || part.description || ''}`);
      pdf.fontSize(10).text(`Lot supplier: ${detail.supplierLotNumber || '-'} | Diterima ${detail.qtyReceived} ${detail.uomCode || ''} | Accepted ${line.qtyAccepted} | Rejected ${line.qtyRejected}`);
      for (const row of line.checklist?.rows || []) pdf.moveDown(0.3).text(`[${row.result}] ${row.label}${row.expected ? ` | Standar: ${row.expected}` : ''}${row.actual ? ` | Aktual: ${row.actual}` : ''}${row.notes ? ` | Temuan: ${row.notes}` : ''}`);
      if (!line.checklist) pdf.text(item.decision === 'QC Bypassed' ? 'QC dilewati dengan alasan: ' + (item.notes || '-') : 'Checklist belum dicatat.');
      if (line.checklist?.checkedBy) pdf.text(`Checklist: ${line.checklist.checkedBy} pada ${line.checklist.checkedAt}`);
      pdf.moveDown(0.3).text(`Issue: ${line.defectCode || '-'} / ${line.defectCategory || '-'} | ${line.notes || '-'} | Disposition: ${line.rejectedDisposition || '-'} | Ref: ${line.dispositionReference || '-'}`);
    }
    pdf.end();
  }));
  router.use((err, req, res, next) => err.code?.startsWith('LIMIT_') ? res.status(400).json({ message: 'Unggah satu dokumen maksimal 10 MB.' }) : next(err));
  return router;
}
module.exports = { createIncomingEvidenceRouter };
