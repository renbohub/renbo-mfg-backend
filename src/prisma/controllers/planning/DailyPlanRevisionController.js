const service = require("../../services/planning/dailyPlanRevisionService");
const { prisma } = require("../../index");
const { createAiDraftService } = require("../../services/ai/aiDraftService");
const aiDraftService = createAiDraftService({ prisma });

const actor = (req) => req.user?.username || req.user?.email || req.user?.id || "system";

function handle(next, res, fn) {
  return Promise.resolve().then(fn).catch((error) => {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message, code: error.code || null, validation: error.validation || null });
    return next(error);
  });
}

exports.workspace = (req, res, next) => handle(next, res, async () => res.json(await service.getWorkspace({ date: req.query.date, revisionId: req.query.revisionId, mode: req.query.mode })));
exports.autoCorrectPlacement = (req, res, next) => handle(next, res, async () => res.json(await service.autoCorrectPlacement({ date: req.body?.date, revisionId: req.body?.revisionId, expectedVersion: req.body?.expectedVersion, userId: actor(req) })));
exports.create = (req, res, next) => handle(next, res, async () => {
  if (req.body?.aiDraftId) await aiDraftService.validateDraftForOfficial({ draftId: req.body.aiDraftId, actor: req.user, draftType: "DAILY_PLAN_RECOVERY", moduleCode: "production", pageCode: "daily-production-schedules" });
  const revision = await service.createDraft({ ...req.body, userId: actor(req) });
  if (req.body?.aiDraftId) await aiDraftService.markAiDraftConfirmed({ draftId: req.body.aiDraftId, userId: req.user?.id, officialEntityType: "DAILY_PLAN_REVISION", officialEntityId: revision.id });
  return res.status(201).json(revision);
});
exports.updateItem = (req, res, next) => handle(next, res, async () => res.json(await service.updateItem({ revisionId: req.params.revisionId, scheduleId: req.params.scheduleId, expectedVersion: req.body?.expectedVersion, changes: req.body?.changes || req.body })));
exports.releaseItem = (req, res, next) => handle(next, res, async () => res.json(await service.releaseSchedule({ revisionId: req.params.revisionId, scheduleId: req.params.scheduleId, expectedVersion: req.body?.expectedVersion, warningReason: req.body?.warningReason, userId: actor(req) })));
exports.validate = (req, res, next) => handle(next, res, async () => res.json(await service.validateRevision(req.params.revisionId)));
exports.release = (req, res, next) => handle(next, res, async () => res.json(await service.releaseRevision({ revisionId: req.params.revisionId, expectedVersion: req.body?.expectedVersion, warningReason: req.body?.warningReason, userId: actor(req) })));
