"use strict";

const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { normalizeEffectivePriceInput, createEffectiveVersion } = require("../../services/pricing/effectivePriceService");

const include = { machine: true, currency: true };

function payload(body, actor, requireEffective = true) {
  const data = normalizeEffectivePriceInput(body, { actor, requireEffective });
  data.costingRateType = String(data.costingRateType || "PER_HOUR").toUpperCase();
  if (!data.machineId || data.unitPrice === undefined) {
    throw Object.assign(new Error("Mesin dan rate proses wajib diisi."), { statusCode: 400 });
  }
  return data;
}

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 500);
    const q = String(req.query.q || "").trim();
    const where = {
      isDeleted: req.query.isDeleted === "true",
      ...(q ? { OR: [
        { machine: { machineCode: { contains: q, mode: "insensitive" } } },
        { machine: { machineName: { contains: q, mode: "insensitive" } } },
        { notes: { contains: q, mode: "insensitive" } },
      ] } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.machineCostRate.findMany({ where, include, orderBy: buildSort(req.query), skip: (page - 1) * limit, take: limit }),
      prisma.machineCostRate.count({ where }),
    ]);
    res.json({ items: items.map(mapDoc), total, page, limit });
  } catch (error) { next(error); }
};

exports.get = async (req, res, next) => {
  try {
    const row = await prisma.machineCostRate.findFirst({ where: { id: req.params.id, isDeleted: false }, include });
    if (!row) return res.status(404).json({ message: "Riwayat rate proses tidak ditemukan." });
    res.json(mapDoc(row));
  } catch (error) { next(error); }
};

exports.create = async (req, res, next) => {
  try {
    const data = payload(req.body, req.user?.username || req.user?.email || "system");
    const saved = await prisma.$transaction((tx) => createEffectiveVersion(tx, {
      model: "machineCostRate", data, scopeWhere: { machineId: data.machineId },
    }));
    res.status(201).json(mapDoc(await prisma.machineCostRate.findUnique({ where: { id: saved.id }, include })));
  } catch (error) { next(error); }
};

exports.update = async (req, res, next) => {
  try {
    const current = await prisma.machineCostRate.findFirst({ where: { id: req.params.id, isDeleted: false } });
    if (!current) return res.status(404).json({ message: "Riwayat rate proses tidak ditemukan." });
    const data = payload({ ...current, ...req.body, id: undefined, createdAt: undefined, updatedAt: undefined }, null);
    if (data.machineId !== current.machineId || data.effectiveFrom.getTime() !== new Date(current.effectiveFrom).getTime()) {
      return res.status(409).json({ message: "Mesin dan tanggal mulai tidak boleh diubah pada histori. Buat Rate Baru untuk periode baru." });
    }
    delete data.createdBy;
    const saved = await prisma.machineCostRate.update({ where: { id: current.id }, data, include });
    res.json(mapDoc(saved));
  } catch (error) { next(error); }
};

exports.remove = async (req, res, next) => {
  try {
    await prisma.machineCostRate.update({ where: { id: req.params.id }, data: { isDeleted: true, isActive: false } });
    res.json({ ok: true });
  } catch (error) { next(error); }
};
