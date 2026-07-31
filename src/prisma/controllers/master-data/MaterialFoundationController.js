const { prisma } = require("../../index");
const { mapDoc } = require("../../utils/mapDoc");

const configs = {
  substance: {
    model: "materialSubstance",
    code: "substanceCode",
    name: "substanceName",
    search: ["substanceCode", "substanceName", "description"],
    include: {},
  },
  density: {
    model: "materialDensity",
    code: "densityCode",
    name: "densityName",
    search: ["densityCode", "densityName", "notes"],
    include: { substance: true },
  },
  grade: {
    model: "materialGrade",
    code: "gradeCode",
    name: "gradeName",
    search: ["gradeCode", "gradeName", "spec", "notes"],
    include: { substance: true, density: true },
  },
  form: {
    model: "materialForm",
    code: "formCode",
    name: "formName",
    search: ["formCode", "formName", "symbol", "notes"],
    include: {},
  },
};

const uppercase = (value) => value == null ? value : String(value).trim().toUpperCase();
const optionalPositive = (value, label) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    const error = new Error(`${label} harus lebih dari 0.`);
    error.status = 400;
    throw error;
  }
  return parsed;
};
const present = (kind, value) => kind === "grade" && value
  ? { ...mapDoc(value), displayName: `${value.gradeCode} — ${value.thickness == null ? "Thickness belum diisi" : `${Number(value.thickness).toLocaleString("id-ID")} mm`}` }
  : mapDoc(value);

async function normalizeData(kind, input, current = {}) {
  const config = configs[kind];
  const data = { ...input };
  if (Object.prototype.hasOwnProperty.call(data, config.code)) data[config.code] = uppercase(data[config.code]);
  if (kind === "form" && Object.prototype.hasOwnProperty.call(data, "symbol")) data.symbol = uppercase(data.symbol);
  if (kind === "density" && Object.prototype.hasOwnProperty.call(data, "densityKgMm3")) {
    data.densityKgMm3 = optionalPositive(data.densityKgMm3, "Density");
  }
  if (kind === "grade" && Object.prototype.hasOwnProperty.call(data, "thickness")) {
    data.thickness = optionalPositive(data.thickness, "Thickness");
  }
  if (kind === "form" && Object.prototype.hasOwnProperty.call(data, "defaultConversionFactor")) {
    data.defaultConversionFactor = optionalPositive(data.defaultConversionFactor, "Default conversion factor");
  }

  const merged = { ...current, ...data };
  if (kind === "density" && !merged.substanceId) {
    throw Object.assign(new Error("Bahan material wajib dipilih."), { status: 400 });
  }
  if (kind === "grade") {
    if (!merged.substanceId) throw Object.assign(new Error("Bahan material wajib dipilih."), { status: 400 });
    if (merged.densityId) {
      const density = await prisma.materialDensity.findFirst({
        where: { id: merged.densityId, isDeleted: false },
        select: { substanceId: true },
      });
      if (!density || density.substanceId !== merged.substanceId) {
        throw Object.assign(new Error("Berat jenis harus berasal dari bahan material yang sama."), { status: 400 });
      }
    }
  }
  return data;
}

function makeHandlers(kind) {
  const config = configs[kind];
  const db = () => prisma[config.model];

  return {
    list: async (req, res, next) => {
      try {
        const page = Math.max(1, Number(req.query.page || 1));
        const limit = Math.min(500, Math.max(1, Number(req.query.limit || 20)));
        const where = { isDeleted: req.query.isDeleted === "true" };
        if (req.query.substanceId && ["density", "grade"].includes(kind)) where.substanceId = req.query.substanceId;
        if (req.query.q) {
          where.OR = config.search.map((field) => ({ [field]: { contains: req.query.q, mode: "insensitive" } }));
          if (["density", "grade"].includes(kind)) {
            where.OR.push({ substance: { substanceName: { contains: req.query.q, mode: "insensitive" } } });
          }
        }
        const [items, total] = await Promise.all([
          db().findMany({
            where,
            include: config.include,
            orderBy: { [config.code]: "asc" },
            skip: (page - 1) * limit,
            take: limit,
          }),
          db().count({ where }),
        ]);
        res.json({ items: items.map((item) => present(kind, item)), total, page, limit });
      } catch (error) { next(error); }
    },
    get: async (req, res, next) => {
      try {
        const doc = await db().findFirst({
          where: {
            isDeleted: false,
            OR: [{ id: req.params.key }, { [config.code]: req.params.key }],
          },
          include: config.include,
        });
        if (!doc) return res.status(404).json({ message: "Master material tidak ditemukan." });
        res.json(present(kind, doc));
      } catch (error) { next(error); }
    },
    create: async (req, res, next) => {
      try {
        const data = await normalizeData(kind, req.body);
        const doc = await db().create({ data, include: config.include });
        res.status(201).json(present(kind, doc));
      } catch (error) { next(error); }
    },
    update: async (req, res, next) => {
      try {
        const current = await db().findUnique({ where: { id: req.params.id } });
        if (!current) return res.status(404).json({ message: "Master material tidak ditemukan." });
        const data = await normalizeData(kind, req.body, current);
        const doc = await db().update({ where: { id: req.params.id }, data, include: config.include });
        res.json(present(kind, doc));
      } catch (error) { next(error); }
    },
    remove: async (req, res, next) => {
      try {
        await db().update({ where: { id: req.params.id }, data: { isDeleted: true } });
        res.json({ ok: true });
      } catch (error) { next(error); }
    },
    autocomplete: async (req, res, next) => {
      try {
        const where = { isDeleted: false };
        if (req.query.substanceId && ["density", "grade"].includes(kind)) where.substanceId = req.query.substanceId;
        if (req.query.q) where.OR = config.search.map((field) => ({ [field]: { contains: req.query.q, mode: "insensitive" } }));
        const items = await db().findMany({
          where,
          include: config.include,
          take: Math.min(100, Number(req.query.limit || 20)),
          orderBy: { [config.code]: "asc" },
        });
        res.json(items.map((item) => present(kind, item)));
      } catch (error) { next(error); }
    },
  };
}

exports.substance = makeHandlers("substance");
exports.density = makeHandlers("density");
exports.grade = makeHandlers("grade");
exports.form = makeHandlers("form");
