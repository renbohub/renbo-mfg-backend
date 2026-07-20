const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { convertPriceListFields } = require("../../utils/numericConverter");

// Include config untuk materialpricelist
const includeMaterialPriceList = {
  material: true,
  currency: true,
  supplier: {
    select: {
      supplierCode: true,
      supplierName: true,
    },
  },
};

exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      partId,
      partCode,
      materialId,
      supplierId,
      supplierCode,
      pricingYear,
      page = 1,
      limit = 20,
      CSP,
    } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    if (partId) where.partId = partId;
    if (partCode) where.partCode = partCode;
    if (materialId) where.materialId = materialId;
    if (supplierId) where.supplierId = supplierId;
    if (supplierCode) where.supplier = { supplierCode };
    if (pricingYear) where.pricingYear = Number(pricingYear);

    if (CSP) {
      where.CSP = CSP;
    }

    if (q) {
      where.OR = [
        { CSP: { contains: q, mode: "insensitive" } },
        { partNumberCP: { contains: q, mode: "insensitive" } },
        { partNameCP: { contains: q, mode: "insensitive" } },
        { material: { materialCode: { contains: q, mode: "insensitive" } } },
        { material: { materialType: { contains: q, mode: "insensitive" } } },
        { material: { spec: { contains: q, mode: "insensitive" } } },
        { supplier: { supplierName: { contains: q, mode: "insensitive" } } },
        { supplier: { supplierCode: { contains: q, mode: "insensitive" } } },
        { notes: { contains: q, mode: "insensitive" } },
      ];

      // Kalau q adalah angka valid, tambahkan thickness dan density ke search
      const numQ = parseFloat(q);
      if (!isNaN(numQ)) {
        where.OR.push({ thickness: numQ });
        where.OR.push({ material: { density: numQ } });
      }
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.materialPriceList.findMany({
        where,
        include: includeMaterialPriceList,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.materialPriceList.count({ where }),
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
    const doc = await prisma.materialPriceList.findFirst({
      where: { id: req.params.id, isDeleted: false },
      include: includeMaterialPriceList,
    });
    if (!doc)
      return res.status(404).json({ message: "MaterialPriceList not found" });
    res.json(doc);
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const convertedData = convertPriceListFields(req.body);
    const doc = await prisma.materialPriceList.create({
      data: convertedData,
      include: includeMaterialPriceList,
    });

    res.status(201).json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const convertedData = convertPriceListFields(req.body);
    const doc = await prisma.materialPriceList.update({
      where: { id: req.params.id },
      data: convertedData,
      include: includeMaterialPriceList,
    });

    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const doc = await prisma.materialPriceList.findUnique({
      where: { id: req.params.id },
    });

    if (!doc) {
      return res.status(404).json({ message: "MaterialPriceList not found" });
    }

    await prisma.materialPriceList.update({
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

    const result = await prisma.materialPriceList.updateMany({
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
    const { materialPriceLists } = req.body;

    if (!Array.isArray(materialPriceLists) || materialPriceLists.length === 0) {
      return res
        .status(400)
        .json({ message: "materialPriceLists array required" });
    }

    const results = {
      success: [],
      failed: [],
      total: materialPriceLists.length,
    };

    // Process setiap material price list
    for (const priceListData of materialPriceLists) {
      try {
        // Convert numeric fields
        const convertedData = convertPriceListFields(priceListData);

        // Resolve supplierId dari supplierCode jika supplierId kosong
        if (!convertedData.supplierId && convertedData.supplierCode) {
          const supplier = await prisma.supplier.findUnique({
            where: { supplierCode: convertedData.supplierCode },
            select: { id: true },
          });
          if (supplier) {
            convertedData.supplierId = supplier.id;
          }
        }

        // Resolve materialId dari materialCode jika materialId kosong
        if (!convertedData.materialId && convertedData.materialCode) {
          const material = await prisma.material.findUnique({
            where: { materialCode: convertedData.materialCode },
            select: { id: true },
          });
          if (material) {
            convertedData.materialId = material.id;
          }
        }

        // Create material price list baru
        const doc = await prisma.materialPriceList.create({
          data: convertedData,
          include: includeMaterialPriceList,
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
