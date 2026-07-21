const { prisma } = require("../../index");
const { mapDoc } = require("../../utils/mapDoc");

const positiveNumber = (value, field) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw Object.assign(new Error(`${field} must be a positive number`), { statusCode: 400 });
  return parsed;
};

exports.listSupplierItems = async (req, res, next) => {
  try {
    const where = { isActive: req.query.isActive === "false" ? false : true };
    if (req.query.supplierId) where.supplierId = req.query.supplierId;
    if (req.query.partId) where.partId = req.query.partId;
    const items = await prisma.supplierItem.findMany({
      where,
      include: { supplier: { select: { id: true, supplierCode: true, supplierName: true } }, part: { select: { id: true, partCode: true, partName: true } } },
      orderBy: [{ isPreferred: "desc" }, { priority: "asc" }],
    });
    res.json({ items: items.map(mapDoc) });
  } catch (error) { next(error); }
};

exports.createSupplierItem = async (req, res, next) => {
  try {
    const data = { ...req.body };
    ["moq", "orderMultiple", "packSize", "price"].forEach((field) => { const value = positiveNumber(data[field], field); if (value !== null) data[field] = value; else delete data[field]; });
    if (data.leadTimeDays !== undefined) data.leadTimeDays = Math.round(positiveNumber(data.leadTimeDays, "leadTimeDays"));
    const item = await prisma.supplierItem.create({ data, include: { supplier: true, part: true } });
    res.status(201).json(mapDoc(item));
  } catch (error) { next(error); }
};

exports.listUomConversions = async (_req, res, next) => {
  try {
    const items = await prisma.uomConversion.findMany({ include: { fromUom: true, toUom: true }, orderBy: { createdAt: "desc" } });
    res.json({ items: items.map(mapDoc) });
  } catch (error) { next(error); }
};

exports.createUomConversion = async (req, res, next) => {
  try {
    const factor = positiveNumber(req.body.factor, "factor");
    if (req.body.fromUomCode === req.body.toUomCode) return res.status(400).json({ message: "Source and target UOM must differ" });
    const item = await prisma.uomConversion.upsert({
      where: { fromUomCode_toUomCode: { fromUomCode: req.body.fromUomCode, toUomCode: req.body.toUomCode } },
      create: { ...req.body, factor }, update: { factor, isActive: req.body.isActive ?? true, notes: req.body.notes },
      include: { fromUom: true, toUom: true },
    });
    res.status(201).json(mapDoc(item));
  } catch (error) { next(error); }
};

exports.listMaterialAttributeSets = async (_req, res, next) => {
  try {
    const items = await prisma.materialAttributeSet.findMany({ where: { isDeleted: false }, include: { definitions: { orderBy: { sequence: "asc" } } }, orderBy: { setCode: "asc" } });
    res.json({ items: items.map(mapDoc) });
  } catch (error) { next(error); }
};

exports.createMaterialAttributeSet = async (req, res, next) => {
  try {
    const { definitions = [], ...header } = req.body;
    const item = await prisma.materialAttributeSet.create({ data: { ...header, definitions: { create: definitions } }, include: { definitions: true } });
    res.status(201).json(mapDoc(item));
  } catch (error) { next(error); }
};
