const express = require('express');
const { authorize, requireSuperAdmin } = require('../../middleware/auth');
const { createPartnerAccessMiddleware } = require('../../middleware/partnerAccess');
const { wrap } = require('./partner-portal');
const { fail, text } = require('../../services/incoming/partnerPortalDomain');
function createPartnerAdminRouter(db) {
  const router = express.Router(), access = createPartnerAccessMiddleware(db);
  router.use(access.loadPartnerAccess, access.internalOnly);
  router.get('/access', requireSuperAdmin, wrap(async (req, res) => {
    const [bindings, users, suppliers, vendors] = await Promise.all([
      db.partnerAccess.findMany({ include: { user: { select: { id: true, username: true, fullName: true } }, supplier: { select: { supplierName: true } }, vendor: { select: { vendorName: true } } }, orderBy: { createdAt: 'desc' } }),
      db.user.findMany({ where: { isDeleted: false, isSuperAdmin: false }, select: { id: true, username: true, fullName: true }, orderBy: { username: 'asc' } }),
      db.supplier.findMany({ where: { isDeleted: false, status: 'Active' }, select: { supplierCode: true, supplierName: true }, orderBy: { supplierCode: 'asc' } }),
      db.vendor.findMany({ where: { isDeleted: false, status: 'Active' }, select: { vendorCode: true, vendorName: true }, orderBy: { vendorCode: 'asc' } }),
    ]); res.json({ bindings, users, suppliers, vendors });
  }));
  router.put('/access/:userId', requireSuperAdmin, wrap(async (req, res) => {
    const result = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "tbl_users" WHERE id = ${req.params.userId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: req.params.userId } });
      if (!user || user.isDeleted || user.isSuperAdmin || user.id === req.user.id) fail('Pilih akun aktif non-admin untuk portal.');
      const existing = await tx.partnerAccess.findUnique({ where: { userId: user.id } });
      const supplierCode = text(req.body.supplierCode, 100) || null, vendorCode = text(req.body.vendorCode, 100) || null;
      if (Boolean(supplierCode) === Boolean(vendorCode) || typeof req.body.isActive !== 'boolean') fail('Pilih tepat satu supplier/vendor dan status akses.');
      if (existing && (existing.supplierCode !== supplierCode || existing.vendorCode !== vendorCode)) fail('Perusahaan pada akun portal tidak dapat diganti. Nonaktifkan akses lama lalu gunakan akun lain.', 409);
      const party = supplierCode ? await tx.supplier.findFirst({ where: { supplierCode, isDeleted: false, status: 'Active' } }) : await tx.vendor.findFirst({ where: { vendorCode, isDeleted: false, status: 'Active' } });
      if (!party && req.body.isActive) fail('Supplier/vendor tidak aktif atau tidak ditemukan.');
      if (!party && !existing) fail('Supplier/vendor tidak ditemukan.');
      return tx.partnerAccess.upsert({ where: { userId: user.id }, create: { userId: user.id, supplierCode, vendorCode, isActive: req.body.isActive, managedBy: req.user.id }, update: { isActive: req.body.isActive, managedBy: req.user.id } });
    });
    global.io?.in(`user:${req.params.userId}`).disconnectSockets(true);
    res.json(result);
  }));
  router.get('/notices', authorize('purchaseOrder', 'read'), wrap(async (req, res) => {
    const status = ['Submitted','Received','Cancelled'].includes(req.query.status) ? req.query.status : 'Submitted';
    const rows = await db.partnerDeliveryNotice.findMany({ where: { status, po: { isDeleted: false } }, include: { po: { select: { supplierCode: true, supplierName: true, vendorCode: true, vendorName: true } }, documents: { select: { id: true, fileName: true, fileSize: true } } }, orderBy: { expectedDate: 'asc' } }); res.json(rows);
  }));
  router.get('/notices/:noticeId', authorize('purchaseOrder', 'read'), wrap(async (req, res) => {
    const row = await db.partnerDeliveryNotice.findUnique({ where: { id: req.params.noticeId }, include: { documents: { select: { id: true, fileName: true, fileSize: true } } } });
    if (!row) fail('Pendaftaran tidak ditemukan.', 404); res.json(row);
  }));
  return router;
}
module.exports = { createPartnerAdminRouter };
