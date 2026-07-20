const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { convertNumericFields } = require("../../utils/numericConverter");

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
        { currencyCode: { contains: q, mode: 'insensitive' } },
        { currencyName: { contains: q, mode: 'insensitive' } },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.currency.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.currency.count({ where }),
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
    // Fetch semua currency codes yang tidak soft deleted
    const currencies = await prisma.currency.findMany({
      where: { isDeleted: false },
      select: {
        currencyCode: true,
      },
      orderBy: { currencyCode: "asc" },
    });

    // Return array of currency codes
    const codes = currencies.map((c) => c.currencyCode);
    res.json(codes);
  } catch (e) {
    next(e);
  }
};

exports.get = async (req, res, next) => {
  try {
    const doc = await prisma.currency.findFirst({
      where: { currencyCode: req.params.currencyCode, isDeleted: false },
    });
    if (!doc) return res.status(404).json({ message: "Currency not found" });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    if (req.body.currencyCode) {
      req.body.currencyCode = req.body.currencyCode.toUpperCase();
    }
    
    const convertedData = convertNumericFields(req.body, ["exchangeRate"]);
    
    // Cek apakah currency dengan currencyCode yang sama sudah ada dan soft deleted
    const existing = await prisma.currency.findUnique({
      where: { currencyCode: convertedData.currencyCode },
    });

    let doc;
    if (existing && existing.isDeleted) {
      // Jika ada dan soft deleted, update dengan data baru dan restore
      doc = await prisma.currency.update({
        where: { id: existing.id },
        data: { ...convertedData, isDeleted: false },
      });
    } else {
      doc = await prisma.currency.create({
        data: convertedData,
      });
    }
    
    res.status(201).json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    // Cek current currency
    const currentCurrency = await prisma.currency.findUnique({
      where: { id: req.params.id },
    });
    
    if (!currentCurrency) {
      return res.status(404).json({ message: "Currency not found" });
    }

    // Jika currencyCode berubah, cek apakah ada currency soft deleted dengan code yang sama
    if (req.body.currencyCode && req.body.currencyCode !== currentCurrency.currencyCode) {
      const existingSoftDeleted = await prisma.currency.findFirst({
        where: {
          currencyCode: req.body.currencyCode,
          isDeleted: true,
        },
      });

      // Jika ada, hard delete dulu yang soft deleted
      if (existingSoftDeleted) {
        await prisma.currency.delete({
          where: { id: existingSoftDeleted.id },
        });
      }
    }

    // Sekarang baru update
    const convertedData = convertNumericFields(req.body, ["exchangeRate"]);
    const doc = await prisma.currency.update({
      where: { id: req.params.id },
      data: convertedData,
    });
    
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const doc = await prisma.currency.update({
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
    const result = await prisma.currency.updateMany({
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
    const { currencies } = req.body;

    if (!Array.isArray(currencies) || currencies.length === 0) {
      return res.status(400).json({ message: "currencies array required" });
    }

    const results = {
      success: [],
      failed: [],
      duplicates: [],
      total: currencies.length,
    };

    // Process setiap currency
    for (const currencyData of currencies) {
      try {
        // Uppercase currencyCode dan convert numeric fields
        const processedData = convertNumericFields(
          {
            ...currencyData,
            currencyCode: currencyData.currencyCode ? currencyData.currencyCode.toUpperCase() : currencyData.currencyCode,
          },
          ["exchangeRate"]
        );

        // Cek existing currency
        const existing = await prisma.currency.findUnique({
          where: { currencyCode: processedData.currencyCode },
        });

        if (existing && !existing.isDeleted) {
          // Currency sudah ada dan active
          results.duplicates.push({
            currencyCode: processedData.currencyCode,
            existingId: existing.id,
          });
          continue;
        }

        let doc;
        if (existing && existing.isDeleted) {
          // Update currency yang soft deleted
          doc = await prisma.currency.update({
            where: { id: existing.id },
            data: {
              ...processedData,
              isDeleted: false,
            },
          });
        } else {
          // Create currency baru
          doc = await prisma.currency.create({
            data: processedData,
          });
        }

        results.success.push(mapDoc(doc));
      } catch (error) {
        results.failed.push({
          data: currencyData,
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
    const { q, limit = 20 } = req.query;
    const where = { isDeleted: false };

    if (q) {
      where.OR = [
        { currencyCode: { contains: q, mode: 'insensitive' } },
        { currencyName: { contains: q, mode: 'insensitive' } },
      ];
    }

    const items = await prisma.currency.findMany({
      where,
      select: {
        id: true,
        currencyCode: true,
        currencyName: true,
        symbol: true,
        exchangeRate: true,
      },
      take: Number(limit),
      orderBy: { currencyCode: 'asc' },
    });

    res.json(items);
  } catch (e) {
    next(e);
  }
};
