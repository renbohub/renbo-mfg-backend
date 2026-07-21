const { prisma } = require("../../index");
const { validateExpression, evaluateFormula, key } = require("../../services/masterFormulaService");

const actor = (req) => req.user?.username || req.user?.email || "system";
function normalize(body, current = {}) {
  const moduleCode = String(body.moduleCode ?? current.moduleCode ?? "").trim().toLowerCase();
  const formulaKey = key(body.formulaKey ?? current.formulaKey);
  const formulaCode = key(body.formulaCode ?? current.formulaCode ?? `${moduleCode}_${formulaKey}`);
  const formulaName = String(body.formulaName ?? current.formulaName ?? "").trim();
  const expression = String(body.expression ?? current.expression ?? "").trim();
  if (!moduleCode || !formulaKey || !formulaName || !expression) throw Object.assign(new Error("Module, key, nama, dan expression wajib diisi."), { statusCode: 400 });
  const variables = body.variables === undefined ? current.variables ?? null : (typeof body.variables === "string" ? JSON.parse(body.variables || "{}") : body.variables);
  const names = variables && typeof variables === "object" ? Object.keys(variables) : [];
  validateExpression(expression, names);
  return { formulaCode, moduleCode, formulaKey, formulaName, expression, variables, resultType: String(body.resultType ?? current.resultType ?? "number"), description: body.description === undefined ? current.description ?? null : body.description || null, isActive: body.isActive === undefined ? current.isActive !== false : body.isActive !== false };
}
exports.list = async (req, res, next) => { try { const q = String(req.query.q || "").trim(); const where = { isDeleted: false, ...(req.query.moduleCode ? { moduleCode: String(req.query.moduleCode).toLowerCase() } : {}), ...(req.query.active === "false" ? { isActive: false } : {}), ...(q ? { OR: [{ formulaCode: { contains: q, mode: "insensitive" } }, { formulaName: { contains: q, mode: "insensitive" } }, { formulaKey: { contains: q, mode: "insensitive" } }] } : {}) }; const [items, total] = await Promise.all([prisma.masterFormula.findMany({ where, orderBy: [{ moduleCode: "asc" }, { formulaKey: "asc" }] }), prisma.masterFormula.count({ where })]); res.json({ items, total }); } catch (e) { next(e); } };
exports.get = async (req, res, next) => { try { const item = await prisma.masterFormula.findFirst({ where: { isDeleted: false, OR: [{ id: req.params.id }, { formulaCode: key(req.params.id) }] } }); if (!item) return res.status(404).json({ message: "Master formula tidak ditemukan." }); res.json(item); } catch (e) { next(e); } };
exports.create = async (req, res, next) => { try { const data = normalize(req.body); const item = await prisma.masterFormula.create({ data: { ...data, createdBy: actor(req), updatedBy: actor(req) } }); res.status(201).json(item); } catch (e) { next(e); } };
exports.update = async (req, res, next) => { try { const current = await prisma.masterFormula.findFirst({ where: { isDeleted: false, OR: [{ id: req.params.id }, { formulaCode: key(req.params.id) }] } }); if (!current) return res.status(404).json({ message: "Master formula tidak ditemukan." }); const data = normalize(req.body, current); const item = await prisma.masterFormula.update({ where: { id: current.id }, data: { ...data, version: { increment: 1 }, updatedBy: actor(req) } }); res.json(item); } catch (e) { next(e); } };
exports.remove = async (req, res, next) => { try { const current = await prisma.masterFormula.findFirst({ where: { isDeleted: false, OR: [{ id: req.params.id }, { formulaCode: key(req.params.id) }] } }); if (!current) return res.status(404).json({ message: "Master formula tidak ditemukan." }); await prisma.masterFormula.update({ where: { id: current.id }, data: { isDeleted: true, isActive: false, updatedBy: actor(req) } }); res.json({ ok: true }); } catch (e) { next(e); } };
exports.simulate = async (req, res, next) => { try { const expression = String(req.body?.expression || "").trim(); const variables = req.body?.variables || {}; if (!expression) return res.status(400).json({ message: "Expression wajib diisi." }); const value = evaluateFormula(expression, variables); res.json({ value }); } catch (e) { e.statusCode = 400; next(e); } };
