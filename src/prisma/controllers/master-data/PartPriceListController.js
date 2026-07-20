const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { convertPriceListFields } = require("../../utils/numericConverter");

// Include config untuk partpricelist
const includePartPriceList = {
  part: true,
  supplier: true,
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
        {
          part: {
            partCode: { contains: q, mode: "insensitive" },
            partNumber: { contains: q, mode: "insensitive" },
            partName: { contains: q, mode: "insensitive" },
          },
        },

        { notes: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.partPriceList.findMany({
        where,
        include: includePartPriceList,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.partPriceList.count({ where }),
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
    const doc = await prisma.partPriceList.findFirst({
      where: { id: req.params.id, isDeleted: false },
      include: includePartPriceList,
    });
    if (!doc)
      return res.status(404).json({ message: "PartPriceList not found" });
    res.json(doc);
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const convertedData = convertPriceListFields(req.body);
    const doc = await prisma.partPriceList.create({
      data: convertedData,
      include: includePartPriceList,
    });

    res.status(201).json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const convertedData = convertPriceListFields(req.body);
    const doc = await prisma.partPriceList.update({
      where: { id: req.params.id },
      data: convertedData,
      include: includePartPriceList,
    });

    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const doc = await prisma.partPriceList.findUnique({
      where: { id: req.params.id },
    });

    if (!doc) {
      return res.status(404).json({ message: "PartPriceList not found" });
    }

    await prisma.partPriceList.update({
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

    const result = await prisma.partPriceList.updateMany({
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
    const { partPriceLists } = req.body;

    if (!Array.isArray(partPriceLists) || partPriceLists.length === 0) {
      return res.status(400).json({ message: "partPriceLists array required" });
    }

    const results = {
      success: [],
      failed: [],
      total: partPriceLists.length,
    };

    // Process setiap part price list
    for (const priceListData of partPriceLists) {
      try {
        // Convert numeric fields
        const convertedData = convertPriceListFields(priceListData);

        // Resolve partId dari partCode jika partId kosong
        if (!convertedData.partId && convertedData.partCode) {
          const part = await prisma.part.findUnique({
            where: { partCode: convertedData.partCode },
            select: { id: true },
          });
          if (part) {
            convertedData.partId = part.id;
          }
        }

        // Create part price list baru
        const doc = await prisma.partPriceList.create({
          data: convertedData,
          include: includePartPriceList,
        });

        results.success.push(mapDoc(doc));
      } catch (error) {
        results.failed.push({
          data: priceListData,
          error: error.message,
        });
      }
    }

    res.status(201).json({
      message: `Bulk create completed: ${results.success.length} success, ${results.failed.length} failed`,
      ...results,
    });
  } catch (e) {
    next(e);
  }
};
