"use strict";

const { prisma } = require("../../index");
const { enqueueSolverRun } = require("../../services/planning/solver/planningSolverRunService");

exports.list = async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
    const where = {
      ...(req.query.status ? { status: String(req.query.status).toUpperCase() } : {}),
      ...(req.query.scope ? { scope: String(req.query.scope).toUpperCase() } : {}),
      ...(req.query.referenceNumber ? { referenceNumber: String(req.query.referenceNumber) } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.planningSolverRun.findMany({ where, orderBy: { requestedAt: "desc" }, take: limit }),
      prisma.planningSolverRun.count({ where }),
    ]);
    res.json({ items, total });
  } catch (error) { next(error); }
};

exports.get = async (req, res, next) => {
  try {
    const item = await prisma.planningSolverRun.findFirst({ where: { OR: [{ id: req.params.id }, { runNumber: req.params.id }] } });
    if (!item) return res.status(404).json({ message: "Planning solver run tidak ditemukan." });
    res.json(item);
  } catch (error) { next(error); }
};

exports.enqueue = async (req, res, next) => {
  try {
    const scope = String(req.body.scope || "FINITE_SCHEDULE").toUpperCase();
    if (!req.body.inputSnapshot || typeof req.body.inputSnapshot !== "object") return res.status(400).json({ message: "inputSnapshot wajib berupa object." });
    const item = await enqueueSolverRun(prisma, {
      scope,
      referenceType: req.body.referenceType,
      referenceNumber: req.body.referenceNumber,
      modelVersion: req.body.modelVersion || "OR-TOOLS-WASM-CP-SAT-V1",
      inputSnapshot: req.body.inputSnapshot,
      requestedBy: req.user?.username || req.user?.email || "system",
    });
    res.status(202).json(item);
  } catch (error) { next(error); }
};
