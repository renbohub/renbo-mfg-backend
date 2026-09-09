const router = require("express").Router();
const { prisma } = require("../../index");
const permissions = require("../../services/purchasing/etaPermissionService");
const { userHasPermission } = require("../../services/ai/permissionEvaluator");
const service = require("../../services/purchasing/etaMonitorService");
const { logger } = require("../../middleware/logger");
const confirmation = require("../../services/purchasing/etaConfirmationService");
for (const source of Object.keys(permissions.resources)) {
  router.get(`/${source}`, permissions.authorize(source, "read"), async (req, res, next) => {
    try {
      const result = await service.list(prisma, source, req.query.month, req.query.mpsNumber);
      const canConfirm = permissions.canConfirm(req.user, source);
      result.permissions = { canConfirm, canEvaluate: userHasPermission(req.user, { resourceCode: "mps", action: "update" }, { moduleCode: "planning-ppic", pageCode: "mps" }) };
      if (!canConfirm) result.items = result.items.map((row) => ({ ...row, canConfirm: false, blockReason: row.blockReason || "Konfirmasi dilakukan oleh akun dengan akses update Purchasing." }));
      res.set("Cache-Control", "no-store").json(result);
    }
    catch (error) { if (error.status || error.statusCode) return res.status(error.status || error.statusCode).json({ message: error.message, code: error.code }); next(error); }
  });
  router.post(`/${source}/confirm`, permissions.authorize(source, "update"), logger("eta-confirmation", "confirm"), async (req, res, next) => {
    try {
      const result = await prisma.$transaction((tx) => confirmation.confirm(tx, source, req.body, req.user), { isolationLevel: "Serializable", timeout: 30000, maxWait: 10000 });
      res.set("Cache-Control", "no-store").json(result);
    } catch (error) {
      if (["P2034", "P2002"].includes(error.code)) return res.status(409).json({ message: "Data berubah atau konfirmasi sedang diproses. Refresh status sebelum mencoba lagi.", code: "ETA_CONCURRENT_CHANGE" });
      if (error.status || error.statusCode) return res.status(error.status || error.statusCode).json({ message: error.message, code: error.code });
      next(error);
    }
  });
}
module.exports = router;
