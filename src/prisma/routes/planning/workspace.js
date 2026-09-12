"use strict";
const router = require("express").Router();
const { logger } = require("../../middleware/logger");
const workspace = require("../../services/planning/ppicWorkspaceService");
const scenarios = require("../../services/planning/ppicWorkspaceScenarioService");
const analysis = require("../../services/planning/ppicWorkspaceAnalysisService");
const db = () => require("../../index").prisma;
const handle = fn => async (req, res, next) => {
  try { res.set("Cache-Control", "no-store").json(await fn(req)); }
  catch (error) {
    if (error.statusCode && error.statusCode < 500) return res.status(error.statusCode).json({ message: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
    console.error("PPIC workspace request failed:", error);
    return res.status(500).json({ message: "Workspace PPIC belum dapat memproses permintaan. Silakan muat ulang; jika tetap gagal, periksa layanan backend.", code: "PPIC_WORKSPACE_ERROR" });
  }
};
router.get("/", handle(req => workspace.snapshot(db(), req.query, req.user)));
router.get("/execution", handle(req => require("../../services/planning/ppicExecutionWorkspaceService").snapshot(db(), req.query, req.user)));
router.get("/analytics", handle(req => require("../../services/planning/ppicAnalyticsService").snapshot(db(), req.query, req.user)));
router.use("/followup", require("./workspaceFollowup"));
router.use("/improvements", require("./workspaceImprovements"));
router.post("/seed", handle(req => scenarios.seed(db(), req.body, req.user)));
router.get("/scenarios", handle(req => scenarios.list(db(), req.query, req.user)));
router.get("/scenarios/compare", handle(req => analysis.compare(db(), req.query, req.user)));
router.post("/comparison", handle(req => analysis.compare(db(), req.body, req.user)));
router.get("/scenarios/:id/analysis", handle(req => analysis.get(db(), req.params.id, req.query, req.user)));
router.get("/scenarios/:id", handle(req => scenarios.get(db(), req.params.id, req.query, req.user)));
router.post("/scenarios", logger("ppicWorkspaceScenario", "create"), handle(req => scenarios.save(db(), req.body, req.user)));
router.put("/scenarios/:id", logger("ppicWorkspaceScenario", "update"), handle(req => scenarios.save(db(), req.body, req.user, req.params.id)));
router.use("/release", require("./workspaceRelease"));
module.exports = router;
