const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");

exports.generateCode = async (req, res, next) => {
  try {
    // Ambil semua department codes
    const departments = await prisma.department.findMany({
      select: { departmentCode: true },
    });

    // Parse semua codes jadi number, filter yang valid, dan sort
    const existingNumbers = departments
      .map((d) => parseInt(d.departmentCode))
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

    const departmentCode = String(nextNumber).padStart(3, "0");
    res.json({ departmentCode });
  } catch (e) {
    next(e);
  }
};

exports.getAllCodes = async (req, res, next) => {
  try {
    const departments = await prisma.department.findMany({
      where: { isDeleted: false },
      select: { departmentCode: true },
      orderBy: { departmentCode: "asc" },
    });
    const codes = departments.map((d) => d.departmentCode);
    res.json(codes);
  } catch (e) {
    next(e);
  }
};

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
        { departmentCode: { contains: q, mode: "insensitive" } },
        { departmentName: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.department.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.department.count({ where }),
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
    const doc = await prisma.department.findFirst({
      where: { departmentCode: req.params.departmentCode, isDeleted: false },
    });
    if (!doc) return res.status(404).json({ message: "Department tidak ditemukan" });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    if (req.body.departmentCode) {
      req.body.departmentCode = req.body.departmentCode.toUpperCase();
    }

    // Cek apakah department dengan departmentCode yang sama sudah ada dan soft deleted
    const existing = await prisma.department.findUnique({
      where: { departmentCode: req.body.departmentCode },
    });

    let doc;
    if (existing && existing.isDeleted) {
      doc = await prisma.department.update({
        where: { id: existing.id },
        data: { ...req.body, isDeleted: false },
      });
    } else {
      doc = await prisma.department.create({
        data: req.body,
      });
    }

    res.status(201).json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const current = await prisma.department.findUnique({
      where: { id: req.params.id },
    });

    if (!current) {
      return res.status(404).json({ message: "Department tidak ditemukan" });
    }

    // Jika departmentCode berubah, cek apakah ada soft deleted dengan code yang sama
    if (req.body.departmentCode && req.body.departmentCode !== current.departmentCode) {
      const existingSoftDeleted = await prisma.department.findFirst({
        where: {
          departmentCode: req.body.departmentCode,
          isDeleted: true,
        },
      });

      if (existingSoftDeleted) {
        await prisma.department.delete({
          where: { id: existingSoftDeleted.id },
        });
      }
    }

    const doc = await prisma.department.update({
      where: { id: req.params.id },
      data: req.body,
    });

    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    await prisma.department.update({
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
    const result = await prisma.department.updateMany({
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
    const { departments } = req.body;

    if (!Array.isArray(departments) || departments.length === 0) {
      return res.status(400).json({ message: "departments array required" });
    }

    const results = {
      success: [],
      failed: [],
      duplicates: [],
      total: departments.length,
    };

    for (const departmentData of departments) {
      try {
        const processedData = {
          ...departmentData,
          departmentCode: departmentData.departmentCode
            ? departmentData.departmentCode.toUpperCase()
            : departmentData.departmentCode,
        };

        const existing = await prisma.department.findUnique({
          where: { departmentCode: processedData.departmentCode },
        });

        if (existing && !existing.isDeleted) {
          results.duplicates.push({
            departmentCode: processedData.departmentCode,
            existingId: existing.id,
          });
          continue;
        }

        let doc;
        if (existing && existing.isDeleted) {
          doc = await prisma.department.update({
            where: { id: existing.id },
            data: { ...processedData, isDeleted: false },
          });
        } else {
          doc = await prisma.department.create({ data: processedData });
        }

        results.success.push(mapDoc(doc));
      } catch (error) {
        results.failed.push({ data: departmentData, error: error.message });
      }
    }

    res.status(201).json({
      message: `Bulk create completed: ${results.success.length} success, ${results.failed.length} failed, ${results.duplicates.length} duplicates`,
      ...results,
    });
  } catch (e) {
    next(e);
  }
};

exports.autocomplete = async (req, res, next) => {
  try {
    const { q, limit = 20 } = req.query;
    const where = { isDeleted: false };

    if (q) {
      where.OR = [
        { departmentCode: { contains: q, mode: "insensitive" } },
        { departmentName: { contains: q, mode: "insensitive" } },
      ];
    }

    const items = await prisma.department.findMany({
      where,
      select: {
        id: true,
        departmentCode: true,
        departmentName: true,
      },
      take: Number(limit),
      orderBy: { departmentCode: "asc" },
    });

    res.json(items);
  } catch (e) {
    next(e);
  }
};
