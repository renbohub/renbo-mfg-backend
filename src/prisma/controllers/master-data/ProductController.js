const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");

// Include config untuk product
const includeProduct = {
  uom: {
    select: {
      uomCode: true,
      uomName: true,
    },
  },
};

exports.generateCode = async (req, res, next) => {
  try {
    // Ambil semua product codes
    const products = await prisma.product.findMany({
      select: { productCode: true },
    });

    // Parse semua codes jadi number, filter yang valid, dan sort
    const existingNumbers = products
      .map((p) => parseInt(p.productCode))
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

    const productCode = String(nextNumber).padStart(3, "0");
    res.json({ productCode });
  } catch (e) {
    next(e);
  }
};

exports.getAllCodes = async (req, res, next) => {
  try {
    const products = await prisma.product.findMany({
      where: { isDeleted: false },
      select: { productCode: true },
      orderBy: { productCode: "asc" },
    });
    const codes = products.map((p) => p.productCode);
    res.json(codes);
  } catch (e) {
    next(e);
  }
};

exports.list = async (req, res, next) => {
  try {
    const { q, isDeleted, category, page = 1, limit = 20 } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    // Filter berdasarkan category jika ada
    if (category) {
      where.category = category;
    }

    if (q) {
      where.OR = [
        { productCode: { contains: q, mode: "insensitive" } },
        { productName: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
        { category: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: includeProduct,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.product.count({ where }),
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
    const doc = await prisma.product.findFirst({
      where: { productCode: req.params.productCode, isDeleted: false },
      include: includeProduct,
    });
    if (!doc) return res.status(404).json({ message: "Product tidak ditemukan" });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    if (req.body.productCode) {
      req.body.productCode = req.body.productCode.toUpperCase();
    }

    // Cek apakah product dengan productCode yang sama sudah ada dan soft deleted
    const existing = await prisma.product.findUnique({
      where: { productCode: req.body.productCode },
    });

    let doc;
    if (existing && existing.isDeleted) {
      doc = await prisma.product.update({
        where: { id: existing.id },
        data: { ...req.body, isDeleted: false },
        include: includeProduct,
      });
    } else {
      doc = await prisma.product.create({
        data: req.body,
        include: includeProduct,
      });
    }

    res.status(201).json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const current = await prisma.product.findUnique({
      where: { id: req.params.id },
    });

    if (!current) {
      return res.status(404).json({ message: "Product tidak ditemukan" });
    }

    // Jika productCode berubah, cek apakah ada soft deleted dengan code yang sama
    if (req.body.productCode && req.body.productCode !== current.productCode) {
      const existingSoftDeleted = await prisma.product.findFirst({
        where: {
          productCode: req.body.productCode,
          isDeleted: true,
        },
      });

      if (existingSoftDeleted) {
        await prisma.product.delete({
          where: { id: existingSoftDeleted.id },
        });
      }
    }

    const doc = await prisma.product.update({
      where: { id: req.params.id },
      data: req.body,
      include: includeProduct,
    });

    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    await prisma.product.update({
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
    const result = await prisma.product.updateMany({
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
    const { products } = req.body;

    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ message: "products array required" });
    }

    const results = {
      success: [],
      failed: [],
      duplicates: [],
      total: products.length,
    };

    for (const productData of products) {
      try {
        const processedData = {
          ...productData,
          productCode: productData.productCode ? productData.productCode.toUpperCase() : productData.productCode,
        };

        const existing = await prisma.product.findUnique({
          where: { productCode: processedData.productCode },
        });

        if (existing && !existing.isDeleted) {
          results.duplicates.push({
            productCode: processedData.productCode,
            existingId: existing.id,
          });
          continue;
        }

        let doc;
        if (existing && existing.isDeleted) {
          doc = await prisma.product.update({
            where: { id: existing.id },
            data: { ...processedData, isDeleted: false },
            include: includeProduct,
          });
        } else {
          doc = await prisma.product.create({
            data: processedData,
            include: includeProduct,
          });
        }

        results.success.push(mapDoc(doc));
      } catch (error) {
        results.failed.push({
          data: productData,
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
    const { q, limit = 20, category } = req.query;
    const where = { isDeleted: false };

    if (category) {
      where.category = category;
    }

    if (q) {
      where.OR = [
        { productCode: { contains: q, mode: "insensitive" } },
        { productName: { contains: q, mode: "insensitive" } },
      ];
    }

    const items = await prisma.product.findMany({
      where,
      select: {
        id: true,
        productCode: true,
        productName: true,
        category: true,
        uomCode: true,
        uom: {
          select: {
            uomName: true,
          },
        },
      },
      take: Number(limit),
      orderBy: { productCode: "asc" },
    });

    res.json(items);
  } catch (e) {
    next(e);
  }
};
