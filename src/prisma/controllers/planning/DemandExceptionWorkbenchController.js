"use strict";

const { prisma } = require("../../index");
const {
  syncExceptions,
  listExceptions,
  getException,
  updateAssignment,
  transitionException,
  addNote,
} = require("../../services/planning/demandExceptionWorkbenchService");

const actor = (req) => req.user?.username || req.user?.email || "system";
const handle = (next, fn) => Promise.resolve().then(fn).catch(next);

exports.list = (req, res, next) => handle(next, async () => res.json(await listExceptions(prisma, req.query || {})));
exports.detail = (req, res, next) => handle(next, async () => res.json(await getException(prisma, req.params.exceptionId)));
exports.sync = (req, res, next) => handle(next, async () => res.json(await syncExceptions(prisma, req.body || {}, actor(req))));
exports.assign = (req, res, next) => handle(next, async () => res.json(await updateAssignment(prisma, req.params.exceptionId, req.body || {}, actor(req))));
exports.transition = (action) => (req, res, next) => handle(next, async () => res.json(await transitionException(prisma, req.params.exceptionId, action, req.body || {}, actor(req))));
exports.note = (req, res, next) => handle(next, async () => res.status(201).json(await addNote(prisma, req.params.exceptionId, req.body || {}, actor(req))));
