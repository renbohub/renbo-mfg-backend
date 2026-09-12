"use strict";
const router = require("express").Router();
const service = require("../../services/planning/ppicExecutionFollowupService");
router.get("/:page", async (req, res) => {
  try { return res.set("Cache-Control", "no-store").json(await service.snapshot(require("../../index").prisma, req.params.page, req.query, req.user)); }
  catch (error) {
    if (error.statusCode && error.statusCode < 500) return res.status(error.statusCode).json({ message: error.message, code: error.code });
    console.error("PPIC followup request failed:", error);
    return res.status(500).json({ message: "Data tindak lanjut PPIC belum dapat dimuat.", code: "PPIC_FOLLOWUP_ERROR" });
  }
});
module.exports = router;
