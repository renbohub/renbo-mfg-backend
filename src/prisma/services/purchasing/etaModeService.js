"use strict";
const { fail } = require("./etaConfirmationStore");
function canManage(user, action = "update") {
  const { userHasPermission } = require("../ai/permissionEvaluator");
  return ["master-production-schedule", "mps"].some((pageCode) => userHasPermission(user,
    { resourceCode: "mps", action }, { moduleCode: "planning-ppic", pageCode }));
}
function authorize(req, res, next) {
  if (!req.user) return res.status(401).json({ message: "No user context" });
  if (!canManage(req.user)) return res.status(403).json({ message: "Sumber ETA memerlukan akses update MPS Planning PPIC." });
  next();
}
function validateMode(value) {
  if (!["BOM", "MANUAL"].includes(value)) fail("Pilih Konfirmasi ETA atau Explode lead time BOM.", 400);
  return value;
}
async function setMode(tx, input, user = {}) {
  validateMode(input.etaMode);
  if (!input.mpsNumber || !Number.isInteger(input.revision) || !Number.isInteger(input.etaModeVersion)) fail("MPS / revisi mode tidak valid. Refresh status.", 400);
  const doc = await tx.mPS.findFirst({ where: { mpsNumber: input.mpsNumber, isDeleted: false } });
  if (!doc) fail("MPS tidak ditemukan.", 404);
  if (!["Draft", "Confirmed"].includes(doc.status)) fail("Metode ETA hanya dapat diubah pada MPS Draft atau Confirmed.");
  if (doc.revision !== input.revision || doc.etaModeVersion !== input.etaModeVersion) fail("MPS atau metode ETA berubah. Refresh status sebelum menyimpan.", 409, "ETA_MODE_CHANGED");
  if (doc.etaMode === input.etaMode) return { saved: true, etaMode: doc.etaMode, etaModeVersion: doc.etaModeVersion };
  const at = new Date(), actor = user.username || user.email || "system";
  const entry = { from: doc.etaMode, to: input.etaMode, revision: doc.revision, by: actor, at: at.toISOString() };
  const updated = await tx.mPS.updateMany({ where: { id: doc.id, revision: doc.revision, etaModeVersion: doc.etaModeVersion, status: doc.status, isDeleted: false }, data: {
    etaMode: input.etaMode, etaModeVersion: { increment: 1 }, etaModeChangedBy: actor, etaModeChangedAt: at,
    etaModeHistory: [...(Array.isArray(doc.etaModeHistory) ? doc.etaModeHistory : []), entry],
  } });
  if (updated.count !== 1) fail("MPS berubah saat menyimpan metode ETA. Refresh status.", 409, "ETA_MODE_CHANGED");
  return { saved: true, etaMode: input.etaMode, etaModeVersion: doc.etaModeVersion + 1 };
}
module.exports = { setMode, validateMode, canManage, authorize };
