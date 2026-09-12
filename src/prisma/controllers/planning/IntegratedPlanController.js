const { prisma } = require("../../index");
const service = require("../../services/planning/integratedPlanService");
exports.resolveApprovalSource = async (req, tx) => {
  const source = req.params.mpsNumber;
  const month = /^MONTH:(\d{4}-(?:0[1-9]|1[0-2]))$/.exec(source)?.[1];
  if (!month) return tx.mPS.findUnique({ where: { mpsNumber: source } });
  const existing = await tx.mPS.findFirst({ where: { sourceKey: source, isDeleted: false, status: { not: "Superseded" } }, orderBy: { updatedAt: "desc" } });
  if (existing) return existing;
  // A month without an MPS is still a proposed document. Obtain its calculated
  // approval context without persisting the generated source or temporary IDs.
  const preview = await service.review(tx, { mpsNumber: source, user: req.user });
  const document = preview.workbench?.mps || {};
  return { ...document, id: source, mpsNumber: source, sourceKey: source, status: "Draft", periodStart: new Date(`${month}-01T00:00:00Z`) };
};
// Return a completed operation before running approval middleware again. The
// service checks the original fingerprint and normalized options for a replay.
exports.replay = async (req, res, next) => {
  try {
    const operationId = String(req.body?.operationId || "");
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(operationId)) return next();
    const previous = await prisma.systemSetting.findUnique({ where: { settingKey: `PPIC_INTEGRATED:${operationId}` }, select: { id: true } });
    if (!previous) return next();
    return exports.confirm(req, res, next);
  } catch (error) { next(error); }
};
for (const action of ["review", "confirm"]) exports[action] = async (req, res, next) => {
  try {
    const result = await service[action](prisma, { mpsNumber: req.params.mpsNumber, user: req.user, safetyDays: req.body?.safetyDays, machineSelections: req.body?.machineSelections, expectedFingerprint: req.body?.expectedFingerprint, operationId: req.body?.operationId });
    res.set("Cache-Control", "no-store").json(result);
  } catch (error) {
    if (error.statusCode || ["P2034", "P2002"].includes(error.code)) return res.status(error.statusCode || 409).json({ code: error.code, message: error.statusCode ? error.message : "Data sedang berubah. Muat ulang simulasi lalu ulangi konfirmasi.", detail: error.detail || null });
    next(error);
  }
};
