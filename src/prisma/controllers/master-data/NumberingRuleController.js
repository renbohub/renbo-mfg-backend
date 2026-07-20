const { prisma } = require("../../index");
const { mapDoc } = require("../../utils/mapDoc");
const { buildSort } = require("../../utils/buildSort");
const { normalizeRuleInput, previewConfiguredNumber, ensureDefaultNumberingRules, TOKENS } = require("../../services/numberingService");

exports.list = async (req, res, next) => { try {
  await ensureDefaultNumberingRules();
  const { q, page = 1, limit = 20 } = req.query; const where = { isDeleted: false, ...(q ? { OR: [{ ruleKey: { contains: q, mode: "insensitive" } }, { ruleName: { contains: q, mode: "insensitive" } }, { pattern: { contains: q, mode: "insensitive" } }] } : {}) };
  const [items, total] = await Promise.all([prisma.numberingRule.findMany({ where, orderBy: buildSort(req.query) || { ruleKey: "asc" }, skip: (Number(page) - 1) * Number(limit), take: Number(limit) }), prisma.numberingRule.count({ where })]);
  res.json({ items: items.map(mapDoc), total, page: Number(page), limit: Number(limit), tokens: TOKENS });
} catch (error) { next(error); } };
exports.get = async (req, res, next) => { try { const doc = await prisma.numberingRule.findFirst({ where: { ruleKey: req.params.ruleKey.toUpperCase(), isDeleted: false } }); if (!doc) return res.status(404).json({ message: "Aturan penomoran tidak ditemukan." }); res.json(mapDoc(doc)); } catch (error) { next(error); } };
exports.preview = async (req, res, next) => { try { const value = await previewConfiguredNumber(req.params.ruleKey, { context: req.query }); if (!value) return res.status(404).json({ message: "Aturan penomoran tidak ditemukan." }); res.json({ value }); } catch (error) { next(error); } };
exports.create = async (req, res, next) => { try { const data = normalizeRuleInput({ ...req.body, updatedBy: req.user?.username }); const doc = await prisma.numberingRule.create({ data }); res.status(201).json(mapDoc(doc)); } catch (error) { next(error); } };
exports.update = async (req, res, next) => { try { const current = await prisma.numberingRule.findUnique({ where: { id: req.params.id } }); if (!current) return res.status(404).json({ message: "Aturan penomoran tidak ditemukan." }); const data = normalizeRuleInput({ ...current, ...req.body, updatedBy: req.user?.username }); delete data.id; delete data.createdAt; delete data.updatedAt; const doc = await prisma.numberingRule.update({ where: { id: req.params.id }, data }); res.json(mapDoc(doc)); } catch (error) { next(error); } };
exports.remove = async (req, res, next) => { try { await prisma.numberingRule.update({ where: { id: req.params.id }, data: { isDeleted: true, isActive: false, updatedBy: req.user?.username } }); res.json({ ok: true }); } catch (error) { next(error); } };
