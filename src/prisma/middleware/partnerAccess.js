const { partyScope } = require('../services/incoming/partnerPortalDomain');
function createPartnerAccessMiddleware(db) {
  const loadPartnerAccess = async (req, res, next) => {
    try {
      if (!req.user?.id) return res.status(401).json({ message: 'Login diperlukan.' });
      req.partnerAccess = await db.partnerAccess.findUnique({ where: { userId: req.user.id }, include: { supplier: true, vendor: true } });
      next();
    } catch (error) { next(error); }
  };
  const requirePartner = (req, res, next) => {
    try {
      partyScope(req.partnerAccess);
      const party = req.partnerAccess.supplier || req.partnerAccess.vendor;
      if (!party || party.isDeleted || party.status !== 'Active') return res.status(403).json({ message: 'Supplier/vendor tidak aktif.' });
      next();
    } catch (error) { res.status(error.statusCode || 403).json({ message: error.message }); }
  };
  const internalOnly = (req, res, next) => req.partnerAccess
    ? res.status(403).json({ code: 'PARTNER_PORTAL_ONLY', message: 'Akun ini hanya dapat menggunakan Portal Supplier & Vendor.' }) : next();
  return { loadPartnerAccess, requirePartner, internalOnly };
}
const publicAccess = access => access ? { isActive: access.isActive, partyType: access.supplierCode ? 'supplier' : 'vendor', partyCode: access.supplierCode || access.vendorCode, partyName: access.supplier?.supplierName || access.vendor?.vendorName || '' } : null;
module.exports = { createPartnerAccessMiddleware, publicAccess };
