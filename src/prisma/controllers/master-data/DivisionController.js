const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");

// Include config untuk division
const includeDivision = {
  department: {
    select: {
      departmentCode: true,
      departmentName: true,
    },
  },
};

exports.generateCode = async (req, res, next) => {
  try {
    // Ambil semua division codes
    const divisions = await prisma.division.findMany({
      select: { divisionCode: true },
    });

    // Parse nomor dari format DIV-XXX
    const existingNumbers = divisions
      .map((d) => {
        const match = d.divisionCode.match(/^DIV-(\d+)$/);
        return match ? parseInt(match[1]) : NaN;
      })
      .filter((num) => !isNaN(num))
      .sort((a, b) => a - b);

    // Cari gap pertama dalam sequence
    let nextNumber = 1;
    for (const num of existingNumbers) {
      if (num === nextNumber) {
        nextNumber++;
      } else if (num > nextNumber) {
        break;
      }
    }

    const divisionCode = `DIV-${String(nextNumber).padStart(3, "0")}`;
    res.json({ divisionCode });
  } catch (e) {
    next(e);
  }
};

exports.getAllCodes = async (req, res, next) => {
  try {
    const divisions = await prisma.division.findMany({
      where: { isDeleted: false },
      select: { divisionCode: true },
      orderBy: { divisionCode: "asc" },
    });
    const codes = divisions.map((d) => d.divisionCode);
    res.json(codes);
  } catch (e) {
    next(e);
  }
};

exports.list = async (req, res, next) => {
  try {
    const { q, isDeleted, departmentId, page = 1, limit = 20 } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    // Filter berdasarkan department
    if (departmentId) {
      where.departmentId = departmentId;
    }

    if (q) {
      where.OR = [
        { divisionCode: { contains: q, mode: "insensitive" } },
        { divisionName: { contains: q, mode: "insensitive" } },
        { department: { departmentName: { contains: q, mode: "insensitive" } } },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.division.findMany({
        where,
        include: includeDivision,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.division.count({ where }),
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
    const doc = await prisma.division.findFirst({
      where: { divisionCode: req.params.divisionCode, isDeleted: false },
      include: includeDivision,
    });
    if (!doc) return res.status(404).json({ message: "Divisi tidak ditemukan" });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    if (req.body.divisionCode) {
      req.body.divisionCode = req.body.divisionCode.toUpperCase();
    }

    // Cek apakah division dengan divisionCode yang sama sudah ada dan soft deleted
    const existing = await prisma.division.findUnique({
      where: { divisionCode: req.body.divisionCode },
    });

    let doc;
    if (existing && existing.isDeleted) {
      doc = await prisma.division.update({
        where: { id: existing.id },
        data: { ...req.body, isDeleted: false },
        include: includeDivision,
      });
    } else {
      doc = await prisma.division.create({
        data: req.body,
        include: includeDivision,
      });
    }

    res.status(201).json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const current = await prisma.division.findUnique({
      where: { id: req.params.id },
    });

    if (!current) {
      return res.status(404).json({ message: "Divisi tidak ditemukan" });
    }

    // Jika divisionCode berubah, cek apakah ada soft deleted dengan code yang sama
    if (req.body.divisionCode && req.body.divisionCode !== current.divisionCode) {
      const existingSoftDeleted = await prisma.division.findFirst({
        where: {
          divisionCode: req.body.divisionCode,
          isDeleted: true,
        },
      });

      if (existingSoftDeleted) {
        await prisma.division.delete({
          where: { id: existingSoftDeleted.id },
        });
      }
    }

    const doc = await prisma.division.update({
      where: { id: req.params.id },
      data: req.body,
      include: includeDivision,
    });

    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    await prisma.division.update({
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
    const result = await prisma.division.updateMany({
      where: { id: { in: ids } },
      data: { isDeleted: true },
    });
    res.json({ deletedCount: result.count });
  } catch (e) {
    next(e);
  }
};

exports.autocomplete = async (req, res, next) => {
  try {
    const { q, limit = 20, departmentId } = req.query;
    const where = { isDeleted: false };

    if (departmentId) {
      where.departmentId = departmentId;
    }

    if (q) {
      where.OR = [
        { divisionCode: { contains: q, mode: "insensitive" } },
        { divisionName: { contains: q, mode: "insensitive" } },
      ];
    }

    const items = await prisma.division.findMany({
      where,
      select: {
        id: true,
        divisionCode: true,
        divisionName: true,
        departmentId: true,
        department: {
          select: {
            departmentCode: true,
            departmentName: true,
          },
        },
      },
      take: Number(limit),
      orderBy: { divisionCode: "asc" },
    });

    res.json(items);
  } catch (e) {
    next(e);
  }
};
