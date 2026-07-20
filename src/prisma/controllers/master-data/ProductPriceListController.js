const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { convertPriceListFields } = require("../../utils/numericConverter");

// Include config untuk product price list
const includeProductPriceList = {
  product: true,
  currency: true,
  supplier: {
    select: {
      supplierCode: true,
      supplierName: true,
    },
  },
  uom: {
    select: {
      uomCode: true,
      uomName: true,
    },
  },
};

exports.list = async (req, res, next) => {
  try {
    const { q, isDeleted, productId, supplierId, supplierCode, pricingYear, page = 1, limit = 20 } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    if (productId) where.productId = productId;
    if (supplierId) where.supplierId = supplierId;
    if (supplierCode) where.supplier = { supplierCode };
    if (pricingYear) where.pricingYear = Number(pricingYear);

    if (q) {
      where.OR = [
        { product: { productCode: { contains: q, mode: "insensitive" } } },
        { product: { productName: { contains: q, mode: "insensitive" } } },
        { supplier: { supplierCode: { contains: q, mode: "insensitive" } } },
        { supplier: { supplierName: { contains: q, mode: "insensitive" } } },
        { notes: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.productPriceList.findMany({
        where,
        include: includeProductPriceList,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.productPriceList.count({ where }),
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
    const doc = await prisma.productPriceList.findFirst({
      where: { id: req.params.id, isDeleted: false },
      include: includeProductPriceList,
    });
    if (!doc) return res.status(404).json({ message: "ProductPriceList tidak ditemukan" });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const convertedData = convertPriceListFields(req.body);
    const doc = await prisma.productPriceList.create({
      data: convertedData,
      include: includeProductPriceList,
    });
    res.status(201).json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const convertedData = convertPriceListFields(req.body);
    const doc = await prisma.productPriceList.update({
      where: { id: req.params.id },
      data: convertedData,
      include: includeProductPriceList,
    });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const doc = await prisma.productPriceList.findUnique({
      where: { id: req.params.id },
    });

    if (!doc) {
      return res.status(404).json({ message: "ProductPriceList tidak ditemukan" });
    }

    await prisma.productPriceList.update({
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

    const result = await prisma.productPriceList.updateMany({
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
    const { productPriceLists } = req.body;

    if (!Array.isArray(productPriceLists) || productPriceLists.length === 0) {
      return res.status(400).json({ message: "productPriceLists array required" });
    }

    const results = {
      success: [],
      failed: [],
      total: productPriceLists.length,
    };

    for (const priceListData of productPriceLists) {
      try {
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

        // Resolve productId dari productCode jika productId kosong
        if (!convertedData.productId && convertedData.productCode) {
          const product = await prisma.product.findUnique({
            where: { productCode: convertedData.productCode },
            select: { id: true },
          });
          if (product) {
            convertedData.productId = product.id;
          }
        }

        const doc = await prisma.productPriceList.create({
          data: convertedData,
          include: includeProductPriceList,
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
