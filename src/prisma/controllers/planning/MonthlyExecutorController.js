const { prisma } = require('../../index');
const service = require('../../services/planning/monthlyExecutorService');
const actor = req => req.user?.username || req.user?.email || 'system';
const handle = action => async (req, res, next) => {
  try { res.json(await action(req)); }
  catch (error) {
    if (error.code === 'P2034') return res.status(409).json({ message: 'Dokumen berubah saat penyimpanan. Muat ulang dan periksa dampak perubahan kembali.', code: 'EXECUTOR_CONCURRENT_CHANGE' });
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message, code: error.code });
    next(error);
  }
};
exports.options = handle(req => service.options(prisma, req.params.planNumber, req.query));
exports.history = handle(async req => ({ items: await service.history(prisma, req.params.planNumber) }));
exports.preview = handle(req => service.preview(prisma, req.params.planNumber, req.body, actor(req)));
exports.apply = handle(req => service.apply(prisma, req.params.planNumber, req.body, actor(req)));
exports.cancel = handle(req => service.cancel(prisma, req.params.planNumber, req.params.changeId, actor(req)));
