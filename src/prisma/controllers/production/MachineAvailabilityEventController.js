const service = require("../../services/planning/machineAvailabilityEventService");
const actor = (req) => req.user?.username || req.user?.email || req.user?.id || "system";
function respond(next, res, fn) { return Promise.resolve().then(fn).catch((error) => error.statusCode ? res.status(error.statusCode).json({ message: error.message, code: error.code || null }) : next(error)); }
exports.create = (req, res, next) => respond(next, res, async () => res.status(201).json(await service.createMachineEvent(req.body, actor(req))));
exports.resolve = (req, res, next) => respond(next, res, async () => res.json(await service.resolveMachineEvent(req.params.id, actor(req))));
