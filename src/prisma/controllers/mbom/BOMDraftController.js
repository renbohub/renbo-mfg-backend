const { randomUUID } = require("crypto");
const { prisma } = require("../../index");

const actor = req => req.user?.username || req.user?.email || req.user?.id || null;
const mapDraft = draft => ({ ...draft, payload: draft.payload || {} });
const draftNumber = () => {
  const now = new Date();
  const stamp = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("");
  return `MBOM-DRAFT-${stamp}-${randomUUID().slice(0, 8).toUpperCase()}`;
};
const validPayload = value => value && typeof value === "object" && !Array.isArray(value);

exports.list = async (req, res, next) => {
  try {
    const where = { isDeleted: false, status: "DRAFT" };
    if (req.query.mine === "true" && actor(req)) where.createdBy = actor(req);
    const drafts = await prisma.mBOMDraft.findMany({ where, orderBy: { updatedAt: "desc" }, take: Math.min(100, Math.max(1, Number(req.query.limit || 25))) });
    res.json({ data: drafts.map(mapDraft), total: drafts.length });
  } catch (error) { next(error); }
};

exports.get = async (req, res, next) => {
  try {
    const draft = await prisma.mBOMDraft.findFirst({ where: { OR: [{ id: req.params.id }, { draftNumber: req.params.id }], isDeleted: false } });
    if (!draft) return res.status(404).json({ message: "Draft BOM tidak ditemukan." });
    res.json(mapDraft(draft));
  } catch (error) { next(error); }
};

exports.create = async (req, res, next) => {
  try {
    if (!validPayload(req.body?.payload)) return res.status(400).json({ message: "Payload canvas draft wajib diisi." });
    const draft = await prisma.mBOMDraft.create({ data: { draftNumber: draftNumber(), payload: req.body.payload, createdBy: actor(req), updatedBy: actor(req) } });
    res.status(201).json(mapDraft(draft));
  } catch (error) { next(error); }
};

exports.update = async (req, res, next) => {
  try {
    if (!validPayload(req.body?.payload)) return res.status(400).json({ message: "Payload canvas draft wajib diisi." });
    if (!req.body?.expectedUpdatedAt) return res.status(428).json({ message: "Versi draft wajib dikirim. Reload halaman draft lalu ulangi perubahan." });
    const current = await prisma.mBOMDraft.findFirst({ where: { id: req.params.id, isDeleted: false } });
    if (!current) return res.status(404).json({ message: "Draft BOM tidak ditemukan." });
    if (current.status !== "DRAFT") return res.status(409).json({ message: "Draft yang sudah diproses tidak dapat diubah." });
    if (new Date(req.body.expectedUpdatedAt).getTime() !== current.updatedAt.getTime()) return res.status(409).json({ message: "Draft berubah dari sesi lain. Reload halaman agar perubahan terbaru tidak tertimpa." });
    const draft = await prisma.mBOMDraft.update({ where: { id: current.id }, data: { payload: req.body.payload, updatedBy: actor(req) } });
    res.json(mapDraft(draft));
  } catch (error) { next(error); }
};

exports.complete = async (req, res, next) => {
  try {
    const noReg = String(req.body?.approvedNoReg || "").trim();
    if (!noReg) return res.status(400).json({ message: "Nomor BOM hasil approval wajib diisi." });
    const current = await prisma.mBOMDraft.findFirst({ where: { id: req.params.id, isDeleted: false } });
    if (!current) return res.status(404).json({ message: "Draft BOM tidak ditemukan." });
    if (current.status !== "DRAFT") return res.status(409).json({ message: "Draft sudah diproses." });
    const draft = await prisma.mBOMDraft.update({ where: { id: current.id }, data: { status: "APPROVED", approvedNoReg: noReg, approvedAt: new Date(), approvedBy: actor(req), updatedBy: actor(req) } });
    res.json(mapDraft(draft));
  } catch (error) { next(error); }
};

exports.remove = async (req, res, next) => {
  try {
    const current = await prisma.mBOMDraft.findFirst({ where: { id: req.params.id, isDeleted: false } });
    if (!current) return res.status(404).json({ message: "Draft BOM tidak ditemukan." });
    await prisma.mBOMDraft.update({ where: { id: current.id }, data: { isDeleted: true, updatedBy: actor(req) } });
    res.json({ message: "Draft BOM dihapus." });
  } catch (error) { next(error); }
};
