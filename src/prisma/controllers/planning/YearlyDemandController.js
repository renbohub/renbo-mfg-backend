"use strict";

const { prisma } = require("../../index");
const { buildYearlyDemand } = require("../../services/planning/yearlyDemandService");
const { saveEfdRule, saveEfdOverride, removeEfdOverride } = require("../../services/planning/effectiveDemandRuleService");
const { loadAdditionalDemandCoverage } = require("../../services/planning/additionalDemandCoverageService");

const actor = (req) => req.user?.username || req.user?.email || "system";
const previousMonth = (month) => {
  const [year, value] = String(month || "").split("-").map(Number);
  if (!year || !value) return null;
  const date = new Date(Date.UTC(year, value - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};

async function markMpsForReplan(month, message) {
  const keys = month ? [`MONTH:${month}`, `MONTH:${previousMonth(month)}`] : null;
  await prisma.mPS.updateMany({
    where: { isDeleted: false, status: { notIn: ["Superseded", "Cancelled"] }, ...(keys ? { sourceKey: { in: keys } } : {}) },
    data: { replanRequired: true, replanReason: message, sourceChangedAt: new Date() },
  });
}

exports.list = async (req, res, next) => {
  try {
    res.json(await buildYearlyDemand(prisma, {
      year: req.query.year,
      customerCode: req.query.customerCode,
      q: req.query.q,
      page: req.query.page,
      pageSize: req.query.pageSize,
    }));
  } catch (error) {
    next(error);
  }
};

exports.additionalCoverage = async (req, res, next) => {
  try {
    const month = String(req.query.month || "").trim();
    const partCode = String(req.query.partCode || "").trim();
    if (!/^\d{4}-\d{2}$/.test(month) || !partCode) {
      return res.status(400).json({ message: "month (YYYY-MM) dan partCode wajib diisi." });
    }
    const result = await loadAdditionalDemandCoverage(prisma, {
      year: Number(month.slice(0, 4)),
      customerCode: req.query.customerCode,
      partCodes: [partCode],
    });
    const items = result.items.filter((row) => row.month === month && row.partCode === partCode);
    return res.json({ month, partCode, items, aggregate: result.byPartMonth.get(`${month}|${partCode}`) || null });
  } catch (error) {
    return next(error);
  }
};

exports.updateRule = async (req, res, next) => {
  try {
    const rule = await saveEfdRule(prisma, req.body || {}, actor(req));
    await markMpsForReplan(null, "General rule EFD berubah; hitung ulang MPS agar horizon M-1/M/M+1 konsisten.");
    res.json({ rule, message: "General rule EFD berhasil disimpan." });
  } catch (error) { next(error); }
};

exports.updateEfd = async (req, res, next) => {
  try {
    const override = await saveEfdOverride(prisma, req.body || {}, actor(req));
    await markMpsForReplan(override.month, `EFD ${override.partCode} ${override.month} berubah; hitung ulang MPS bulan tersebut dan buffer bulan sebelumnya.`);
    res.json({ override, message: "EFD item berhasil disimpan." });
  } catch (error) { next(error); }
};

exports.removeEfd = async (req, res, next) => {
  try {
    const result = await removeEfdOverride(prisma, req.body || {}, actor(req));
    await markMpsForReplan(result.month, `Override EFD ${result.partCode} ${result.month} dihapus; hitung ulang MPS terkait.`);
    res.json({ ...result, message: "Override EFD dihapus dan general rule kembali digunakan." });
  } catch (error) { next(error); }
};
