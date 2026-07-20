const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");

const normalizeUomCode = (uomCode) => {
  if (typeof uomCode !== "string") return uomCode;
  return uomCode.trim();
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
        { uomCode: { contains: q, mode: 'insensitive' } },
        { uomName: { contains: q, mode: 'insensitive' } },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.uom.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.uom.count({ where }),
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

exports.getAllCodes = async (req, res, next) => {
  try {
    // Fetch semua uom codes yang tidak soft deleted
    const uoms = await prisma.uom.findMany({
      where: { isDeleted: false },
      select: {
        uomCode: true,
      },
      orderBy: { uomCode: "asc" },
    });

    // Return array of uom codes
    const codes = uoms.map((u) => u.uomCode);
    res.json(codes);
  } catch (e) {
    next(e);
  }
};

exports.get = async (req, res, next) => {
  try {
    const uomCode = normalizeUomCode(req.params.uomCode);
    const doc = await prisma.uom.findFirst({
      where: { uomCode, isDeleted: false },
    });
    if (!doc) return res.status(404).json({ message: "UOM not found" });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    if (req.body.uomCode) {
      req.body.uomCode = normalizeUomCode(req.body.uomCode);
    }
    
    // Cek apakah uom dengan uomCode yang sama sudah ada dan soft deleted
    const existing = await prisma.uom.findUnique({
      where: { uomCode: req.body.uomCode },
    });

    let doc;
    if (existing && existing.isDeleted) {
      // Jika ada dan soft deleted, update dengan data baru dan restore
      doc = await prisma.uom.update({
        where: { id: existing.id },
        data: { ...req.body, isDeleted: false },
      });
    } else {
      doc = await prisma.uom.create({
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
    if (req.body.uomCode) {
      req.body.uomCode = normalizeUomCode(req.body.uomCode);
    }

    // Cek current uom
    const currentUom = await prisma.uom.findUnique({
      where: { id: req.params.id },
    });
    
    if (!currentUom) {
      return res.status(404).json({ message: "UOM not found" });
    }

    // Jika uomCode berubah, cek apakah ada uom soft deleted dengan code yang sama
    if (req.body.uomCode && req.body.uomCode !== currentUom.uomCode) {
      const existingSoftDeleted = await prisma.uom.findFirst({
        where: {
          uomCode: req.body.uomCode,
          isDeleted: true,
        },
      });

      // Jika ada, hard delete dulu yang soft deleted
      if (existingSoftDeleted) {
        await prisma.uom.delete({
          where: { id: existingSoftDeleted.id },
        });
      }
    }

    // Sekarang baru update
    const doc = await prisma.uom.update({
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
    const doc = await prisma.uom.update({
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
    const result = await prisma.uom.updateMany({
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
    const { uoms } = req.body;

    if (!Array.isArray(uoms) || uoms.length === 0) {
      return res.status(400).json({ message: "uoms array required" });
    }

    const results = {
      success: [],
      failed: [],
      duplicates: [],
      total: uoms.length,
    };

    // Process setiap uom
    for (const uomData of uoms) {
      try {
        const processedData = {
          ...uomData,
          uomCode: uomData.uomCode ? normalizeUomCode(uomData.uomCode) : uomData.uomCode,
        };

        // Cek existing uom
        const existing = await prisma.uom.findUnique({
          where: { uomCode: processedData.uomCode },
        });

        if (existing && !existing.isDeleted) {
          // UOM sudah ada dan active
          results.duplicates.push({
            uomCode: processedData.uomCode,
            existingId: existing.id,
          });
          continue;
        }

        let doc;
        if (existing && existing.isDeleted) {
          // Update uom yang soft deleted
          doc = await prisma.uom.update({
            where: { id: existing.id },
            data: {
              ...processedData,
              isDeleted: false,
            },
          });
        } else {
          // Create uom baru
          doc = await prisma.uom.create({
            data: processedData,
          });
        }

        results.success.push(mapDoc(doc));
      } catch (error) {
        results.failed.push({
          data: uomData,
          error: error.message,
        });
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
    const { q, limit = 50 } = req.query;
    const where = { isDeleted: false };

    if (q) {
      where.OR = [
        { uomCode: { contains: q, mode: 'insensitive' } },
        { uomName: { contains: q, mode: 'insensitive' } },
      ];
    }

    const items = await prisma.uom.findMany({
      where,
      select: {
        id: true,
        uomCode: true,
        uomName: true,
      },
      take: Number(limit),
      orderBy: { uomCode: 'asc' },
    });

    res.json(items);
  } catch (e) {
    next(e);
  }
};
