const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { convertNumericFields } = require("../../utils/numericConverter");

exports.list = async (req, res, next) => {
  try {
    const { q, isDeleted, itemType, page = 1, limit = 20 } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    if (itemType) {
      where.itemType = itemType;
    }

    if (q) {
      where.OR = [
        { priceListCode: { contains: q, mode: 'insensitive' } },
        { partCode: { contains: q, mode: 'insensitive' } },
        { partName: { contains: q, mode: 'insensitive' } },
        { materialCode: { contains: q, mode: 'insensitive' } },
        { materialType: { contains: q, mode: 'insensitive' } },
        { supplierCode: { contains: q, mode: 'insensitive' } },
        { supplierName: { contains: q, mode: 'insensitive' } },
        { currencyCode: { contains: q, mode: 'insensitive' } },
        { notes: { contains: q, mode: 'insensitive' } },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.priceList.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.priceList.count({ where }),
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
    const doc = await prisma.priceList.findUnique({
      where: { id: req.params.id },
    });
    if (!doc) return res.status(404).json({ message: "Price list not found" });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const convertedData = convertNumericFields(req.body, [
      "unitPrice",
      "partDiameter",
      "materialThickness",
    ]);
    
    // Auto-generate priceListCode jika tidak ada
    if (!convertedData.priceListCode) {
      const now = new Date();
      const datePrefix = `PL-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
      
      // Cari nomor terakhir dengan prefix hari ini
      const lastDoc = await prisma.priceList.findFirst({
        where: {
          priceListCode: {
            startsWith: datePrefix,
          },
        },
        orderBy: {
          priceListCode: 'desc',
        },
      });

      let sequence = 1;
      if (lastDoc && lastDoc.priceListCode) {
        const lastSeq = lastDoc.priceListCode.split('-').pop();
        sequence = parseInt(lastSeq, 10) + 1;
      }

      convertedData.priceListCode = `${datePrefix}-${String(sequence).padStart(3, '0')}`;
    }

    const doc = await prisma.priceList.create({
      data: convertedData,
    });
    res.status(201).json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const convertedData = convertNumericFields(req.body, [
      "unitPrice",
      "partDiameter",
      "materialThickness",
    ]);
    
    const doc = await prisma.priceList.update({
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
    const doc = await prisma.priceList.update({
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
    const result = await prisma.priceList.updateMany({
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
    const { q = "", partCode, materialCode, limit = 10 } = req.query;
    
    const where = {
      isDeleted: false,
    };

    if (partCode) where.partCode = partCode;
    if (materialCode) where.materialCode = materialCode;

    // Jika ada query search, tambahkan kondisi OR untuk text search
    if (q) {
      where.OR = [
        { priceListCode: { contains: q, mode: 'insensitive' } },
        { partCode: { contains: q, mode: 'insensitive' } },
        { partName: { contains: q, mode: 'insensitive' } },
        { materialCode: { contains: q, mode: 'insensitive' } },
        { materialType: { contains: q, mode: 'insensitive' } },
      ];
    }

    const items = await prisma.priceList.findMany({
      where,
      select: {
        id: true,
        priceListCode: true,
        partCode: true,
        partName: true,
        materialCode: true,
        materialType: true,
        unitPrice: true,
        currencyCode: true,
      },
      take: Number(limit),
      orderBy: { priceListCode: 'asc' },
    });

    res.json(items.map((item) => ({
      value: item.priceListCode || item.id,
      label: item.priceListCode,
      partCode: item.partCode,
      partName: item.partName,
      materialCode: item.materialCode,
      materialType: item.materialType,
      unitPrice: item.unitPrice,
      currencyCode: item.currencyCode,
    })));
  } catch (e) {
    next(e);
  }
};