"use strict";

const { prisma } = require("../../index");
const {
  runRccp,
  latestRccpForMps,
  acknowledgeWarning,
  overrideOverload,
  applyRecommendation,
} = require("../../services/planning/rccpService");

const actor = (req) => req.user?.username || req.user?.email || "system";
const fail = (res, error, next) => error.statusCode
  ? res.status(error.statusCode).json({ message: error.message, code: error.code || null, exceptions: error.exceptions || [], rccp: error.rccp || null })
  : next(error);

exports.run = async (req, res, next) => {
  try {
    return res.status(201).json(await runRccp(prisma, req.params.mpsNumber, { ...req.body, runBy: actor(req) }));
  } catch (error) { return fail(res, error, next); }
};

exports.latest = async (req, res, next) => {
  try {
    const mps = await prisma.mPS.findFirst({ where: { mpsNumber: req.params.mpsNumber, isDeleted: false }, select: { id: true, mpsNumber: true, revision: true, capacityStatus: true, lifecycleStatus: true } });
    if (!mps) return res.status(404).json({ message: "MPS tidak ditemukan." });
    return res.json({ mps, rccp: await latestRccpForMps(prisma, mps.id) });
  } catch (error) { return fail(res, error, next); }
};

exports.get = async (req, res, next) => {
  try {
    const run = await prisma.rccpRun.findFirst({
      where: { id: req.params.runId },
      include: {
        mps: { select: { mpsNumber: true, revision: true, periodStart: true, periodEnd: true } },
        loads: { orderBy: { loadPercentage: "desc" } }, overrides: { orderBy: { approvedAt: "desc" } },
        timeBuckets: { orderBy: [{ bucketStart: "asc" }, { resourceCode: "asc" }] },
        offsetDetails: { orderBy: [{ requiredDate: "asc" }, { sequence: "asc" }] },
        recommendations: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!run) return res.status(404).json({ message: "RCCP run tidak ditemukan." });
    return res.json(run);
  } catch (error) { return fail(res, error, next); }
};

exports.acknowledge = async (req, res, next) => {
  try {
    return res.json(await acknowledgeWarning(prisma, req.params.runId, { reason: req.body.reason, runBy: actor(req) }));
  } catch (error) { return fail(res, error, next); }
};

exports.override = async (req, res, next) => {
  try {
    return res.json(await overrideOverload(prisma, req.params.runId, { reason: req.body.reason, runBy: actor(req) }));
  } catch (error) { return fail(res, error, next); }
};

exports.timeline = async (req, res, next) => {
  try {
    const run = await prisma.rccpRun.findFirst({
      where: { id: req.params.runId },
      select: { id: true, mpsId: true, earliestStartDate: true, latestRequiredDate: true, phaseSummary: true, offsetDetails: { orderBy: [{ requiredDate: "asc" }, { sequence: "asc" }] } },
    });
    if (!run) return res.status(404).json({ message: "RCCP run tidak ditemukan." });
    return res.json(run);
  } catch (error) { return fail(res, error, next); }
};

exports.offsetLoad = async (req, res, next) => {
  try {
    const run = await prisma.rccpRun.findFirst({
      where: { id: req.params.runId },
      select: { id: true, capacityHorizonStart: true, capacityHorizonEnd: true, hasPreviousMonthLoad: true, offsetStatus: true, timeBuckets: { orderBy: [{ bucketStart: "asc" }, { resourceCode: "asc" }] } },
    });
    if (!run) return res.status(404).json({ message: "RCCP run tidak ditemukan." });
    return res.json(run);
  } catch (error) { return fail(res, error, next); }
};

exports.recommendations = async (req, res, next) => {
  try {
    const run = await prisma.rccpRun.findFirst({
      where: { id: req.params.runId },
      select: { id: true, recommendations: { orderBy: { createdAt: "asc" } } },
    });
    if (!run) return res.status(404).json({ message: "RCCP run tidak ditemukan." });
    return res.json(run);
  } catch (error) { return fail(res, error, next); }
};

exports.applyRecommendation = async (req, res, next) => {
  try {
    return res.json(await applyRecommendation(prisma, req.params.runId, req.params.recommendationId, { runBy: actor(req) }));
  } catch (error) { return fail(res, error, next); }
};
