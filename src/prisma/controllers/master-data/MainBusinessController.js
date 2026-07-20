const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const slugify = require("slugify");

async function generateUniqueCode(mainBusinessName, excludeId = null) {
  const baseSlug = slugify(mainBusinessName || "main-business", {
    lower: true,
    strict: true,
    trim: true,
  }) || "main-business";

  let code = baseSlug;
  let counter = 1;

  while (true) {
    const existing = await prisma.mainBusiness.findFirst({
      where: {
        mainBusinessCode: code,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });

    if (!existing) return code;

    code = `${baseSlug}-${counter}`;
    counter += 1;
  }
}

exports.list = async (req, res, next) => {
  try {
    const { q, isDeleted, page = 1, limit = 20 } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    if (q) {
      where.OR = [
        { mainBusinessCode: { contains: q, mode: "insensitive" } },
        { mainBusinessName: { contains: q, mode: "insensitive" } },
        { notes: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.mainBusiness.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.mainBusiness.count({ where }),
    ]);

    res.json({
      items: items.map(mapDoc),
      total,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (e) {
    next(e);
  }
};

exports.get = async (req, res, next) => {
  try {
    const doc = await prisma.mainBusiness.findFirst({
      where: {
        OR: [
          { id: req.params.idOrCode },
          { mainBusinessCode: req.params.idOrCode },
        ],
        isDeleted: false,
      },
    });

    if (!doc) return res.status(404).json({ message: "MainBusiness not found" });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const mainBusinessCode = req.body.mainBusinessCode
      || await generateUniqueCode(req.body.mainBusinessName);

    const doc = await prisma.mainBusiness.create({
      data: {
        ...req.body,
        mainBusinessCode,
      },
    });

    res.status(201).json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const current = await prisma.mainBusiness.findUnique({
      where: { id: req.params.id },
    });

    if (!current)
      return res.status(404).json({ message: "MainBusiness not found" });

    const updateData = { ...req.body };
    if (
      req.body.mainBusinessName
      && req.body.mainBusinessName !== current.mainBusinessName
      && !req.body.mainBusinessCode
    ) {
      updateData.mainBusinessCode = await generateUniqueCode(
        req.body.mainBusinessName,
        req.params.id,
      );
    }

    const doc = await prisma.mainBusiness.update({
      where: { id: req.params.id },
      data: updateData,
    });

    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    await prisma.mainBusiness.update({
      where: { id: req.params.id },
      data: { isDeleted: true },
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
};

exports.bulkRemove = async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids array required" });
    }

    const result = await prisma.mainBusiness.updateMany({
      where: { id: { in: ids } },
      data: { isDeleted: true },
    });

    res.json({ deletedCount: result.count });
  } catch (e) {
    next(e);
  }
};

exports.bulkCreate = async (req, res, next) => {
  try {
    const { mainBusinesses } = req.body;
    if (!Array.isArray(mainBusinesses) || mainBusinesses.length === 0) {
      return res.status(400).json({ message: "mainBusinesses array required" });
    }

    const created = [];
    for (const item of mainBusinesses) {
      if (!item.mainBusinessName) continue;
      const mainBusinessCode = item.mainBusinessCode
        || await generateUniqueCode(item.mainBusinessName);
      const doc = await prisma.mainBusiness.create({
        data: {
          mainBusinessCode,
          mainBusinessName: item.mainBusinessName,
          notes: item.notes || null,
        },
      });
      created.push(doc);
    }

    res.status(201).json({
      created: created.length,
      items: created.map(mapDoc),
    });
  } catch (e) {
    next(e);
  }
};

exports.autocomplete = async (req, res, next) => {
  try {
    const { q, limit = 10 } = req.query;
    const where = { isDeleted: false };

    if (q) {
      where.OR = [
        { mainBusinessCode: { contains: q, mode: "insensitive" } },
        { mainBusinessName: { contains: q, mode: "insensitive" } },
      ];
    }

    const items = await prisma.mainBusiness.findMany({
      where,
      select: {
        id: true,
        mainBusinessCode: true,
        mainBusinessName: true,
      },
      take: Number(limit),
      orderBy: { mainBusinessName: "asc" },
    });

    res.json(items);
  } catch (e) {
    next(e);
  }
};
