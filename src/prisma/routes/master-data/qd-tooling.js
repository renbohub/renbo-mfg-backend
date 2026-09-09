const { prisma } = require('../../index');
const { authorize } = require('../../middleware/auth');
const { logger } = require('../../middleware/logger');
const service = require('../../services/qdToolingService').createService(prisma);
const run = fn => (req,res,next) => Promise.resolve(fn(req,res)).catch(next);
module.exports = function qdRouter(kind) {
  const router = require('express').Router();
  const modelName = kind === 'types' ? 'qdType' : 'qdUnit';
  router.get('/autocomplete', authorize('dies','read'), run(async (req,res) => res.json((await service.list(kind, { ...req.query, isDeleted: 'false', ...(kind === 'types' ? { isActive: 'true' } : {}) })).items)));
  router.patch('/bulk-remove', authorize('dies','delete'), logger(modelName,'bulk-remove'), run(async (req,res) => res.json(await service.remove(kind, req.body.ids))));
  router.get('/', authorize('dies','read'), run(async (req,res) => res.json(await service.list(kind, req.query))));
  router.get('/:key', authorize('dies','read'), run(async (req,res) => res.json(await service.get(kind, req.params.key))));
  router.post('/', authorize('dies','create'), logger(modelName,'create'), run(async (req,res) => res.status(201).json(await service.save(kind, null, req.body))));
  router.patch('/:id/remove', authorize('dies','delete'), logger(modelName,'delete'), run(async (req,res) => res.json(await service.remove(kind, [req.params.id]))));
  router.patch('/:id', authorize('dies','update'), logger(modelName,'update',{ modelName }), run(async (req,res) => res.json(await service.save(kind, req.params.id, req.body))));
  return router;
};
