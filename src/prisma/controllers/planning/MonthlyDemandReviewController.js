"use strict";

const { prisma } = require("../../index");
const {
  getMonthlyReview,
  createSnapshot,
  refreshSnapshot,
  createRevision,
  transitionSnapshot,
} = require("../../services/planning/monthlyDemandReviewService");

const actor = (req) => req.user?.username || req.user?.email || "system";
const handle = (next, fn) => Promise.resolve().then(fn).catch((error) => {
  if (error.statusCode) return next(Object.assign(error, { statusCode: error.statusCode }));
  return next(error);
});

exports.list = (req, res, next) => handle(next, async () => {
  res.json(await getMonthlyReview(prisma, {
    month: req.query.month,
    snapshotId: req.query.snapshotId,
    customerCode: req.query.customerCode,
    q: req.query.q,
    page: req.query.page,
    pageSize: req.query.pageSize,
  }));
});

exports.create = (req, res, next) => handle(next, async () => {
  res.status(201).json(await createSnapshot(prisma, req.body || {}, actor(req)));
});

exports.refresh = (req, res, next) => handle(next, async () => {
  res.json(await refreshSnapshot(prisma, req.params.snapshotId, req.body || {}, actor(req)));
});

exports.revise = (req, res, next) => handle(next, async () => {
  res.status(201).json(await createRevision(prisma, req.params.snapshotId, req.body || {}, actor(req)));
});

exports.transition = (action) => (req, res, next) => handle(next, async () => {
  res.json(await transitionSnapshot(prisma, req.params.snapshotId, action, req.body || {}, actor(req)));
});
