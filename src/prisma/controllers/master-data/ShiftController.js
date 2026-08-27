"use strict";

const { prisma } = require("../../index");
const { mapDoc } = require("../../utils/mapDoc");

const normalize = (body = {}) => ({
  shiftCode: String(body.shiftCode || "").trim().toUpperCase().replace(/\s+/g, "-"),
  shiftName: String(body.shiftName || "").trim(),
  sequence: Math.max(Number(body.sequence || 1), 1),
  isActive: body.isActive !== false && body.isActive !== "false",
  notes: body.notes ? String(body.notes).trim() : null,
});

exports.list = async (req, res, next) => { try {
  const q = String(req.query.q || "").trim();
  const where = { isDeleted: req.query.isDeleted === "true", ...(q ? { OR: [{ shiftCode: { contains: q, mode: "insensitive" } }, { shiftName: { contains: q, mode: "insensitive" } }] } : {}) };
  const [items, total] = await Promise.all([prisma.shiftMaster.findMany({ where, orderBy: [{ sequence: "asc" }, { shiftCode: "asc" }] }), prisma.shiftMaster.count({ where })]);
  res.json({ items: items.map(mapDoc), total, page: 1, limit: items.length });
} catch (error) { next(error); } };
exports.get = async (req, res, next) => { try { const row = await prisma.shiftMaster.findFirst({ where: { OR: [{ id: req.params.id }, { shiftCode: req.params.id }], isDeleted: false } }); if (!row) return res.status(404).json({ message: "Shift tidak ditemukan." }); res.json(mapDoc(row)); } catch (error) { next(error); } };
exports.create = async (req, res, next) => { try { const data = normalize(req.body); if (!data.shiftCode || !data.shiftName) return res.status(400).json({ message: "Kode dan nama shift wajib diisi." }); res.status(201).json(mapDoc(await prisma.shiftMaster.create({ data }))); } catch (error) { next(error); } };
exports.update = async (req, res, next) => { try { res.json(mapDoc(await prisma.shiftMaster.update({ where: { id: req.params.id }, data: normalize(req.body) }))); } catch (error) { next(error); } };
exports.remove = async (req, res, next) => { try { await prisma.shiftMaster.update({ where: { id: req.params.id }, data: { isDeleted: true, isActive: false } }); res.json({ ok: true }); } catch (error) { next(error); } };
