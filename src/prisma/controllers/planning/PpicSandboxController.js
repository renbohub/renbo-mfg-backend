const { prisma } = require("../../index");
exports.seed = async (req, res, next) => {
  try {
    const result = await require("../../services/planning/ppicSandboxCachedSeed").seed(prisma, { mpsNumber: req.params.mpsNumber, user: req.user }, { force: req.body?.force === true });
    res.set("Cache-Control", "no-store").json(result);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message, code: error.code });
    next(error);
  }
};
