const router = require("express").Router();
const { prisma } = require("../index");
const { getHomeTasks } = require("../services/homeTaskService");
router.get("/", async (req, res, next) => {
  try { res.set("Cache-Control", "no-store").json(await getHomeTasks(prisma, req.user)); }
  catch (error) { next(error); }
});
module.exports = router;
