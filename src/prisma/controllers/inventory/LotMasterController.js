const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { generateDocNumber } = require("../purchasing/utils/purchasingHelpers");

// ============================================
// GENERATE LOT NUMBER
// ============================================
exports.generateNumber = async (req, res, next) => {
  try {
    const lotNumber = await generateDocNumber("lotMaster", "LOT", "lotNumber");
    res.json({ lotNumber });
  } catch (e) {
    next(e);
  }
};

// ============================================
// LIST LOTS
// ============================================
exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      partCode,
      productId,
      description,
      expiringSoon, // jumlah hari mendatang untuk filter expiry
      dateFrom,
      dateTo,
      page = 1,
      limit = 20,
    } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    if (partCode) {
      where.partCode = partCode;
    }

    if (productId) {
      where.productId = productId;
    }

    if (description) {
      where.description = { contains: description, mode: "insensitive" };
    }

    if (dateFrom || dateTo) {
      where.expiryDate = {};
      if (dateFrom) where.expiryDate.gte = new Date(dateFrom);
      if (dateTo) where.expiryDate.lte = new Date(dateTo);
    }

    // Filter lot yang akan expired dalam N hari ke depan
    if (expiringSoon) {
      const days = Number(expiringSoon);
      if (Number.isFinite(days) && days > 0) {
        const future = new Date();
        future.setDate(future.getDate() + days);
        where.expiryDate = { gte: new Date(), lte: future };
      }
    }

    if (q) {
      where.OR = [
        { lotNumber: { contains: q, mode: "insensitive" } },
        { partCode: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
        { supplierBatch: { contains: q, mode: "insensitive" } },
        { notes: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query) || { lotNumber: "asc" };
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.lotMaster.findMany({
        where,
        include: {
          product: {
            select: { productCode: true, productName: true },
          },
        },
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.lotMaster.count({ where }),
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

// ============================================
// GET LOT BY NUMBER
// ============================================
exports.get = async (req, res, next) => {
  try {
    const { lotNumber } = req.params;

    const lot = await prisma.lotMaster.findUnique({
      where: { lotNumber },
      include: {
        product: {
          select: { productCode: true, productName: true },
        },
      },
    });

    if (!lot) {
      return res.status(404).json({ message: "LOT tidak ditemukan" });
    }

    res.json(mapDoc(lot));
  } catch (e) {
    next(e);
  }
};

// ============================================
// CREATE LOT
// ============================================
exports.create = async (req, res, next) => {
  try {
    const data = req.body;

    const lot = await prisma.lotMaster.create({ data });
    res.status(201).json(mapDoc(lot));
  } catch (e) {
    next(e);
  }
};

// ============================================
// UPDATE LOT
// ============================================
exports.update = async (req, res, next) => {
  try {
    const { lotNumber } = req.params;
    const { lotNumber: _ln, createdAt, updatedAt, ...data } = req.body;

    const lot = await prisma.lotMaster.update({
      where: { lotNumber },
      data: {
        ...data,
        manufacturingDate: data.manufacturingDate ? new Date(data.manufacturingDate) : undefined,
        expiryDate: data.expiryDate ? new Date(data.expiryDate) : undefined,
      },
    });

    res.json(mapDoc(lot));
  } catch (e) {
    next(e);
  }
};

// ============================================
// SOFT DELETE LOT
// ============================================
exports.remove = async (req, res, next) => {
  try {
    const { lotNumber } = req.params;

    await prisma.lotMaster.update({
      where: { lotNumber },
      data: { isDeleted: true },
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
};

// ============================================
// BULK REMOVE
// ============================================
exports.bulkRemove = async (req, res, next) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids harus berupa array" });
    }

    await prisma.lotMaster.updateMany({
      where: { id: { in: ids } },
      data: { isDeleted: true },
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
};

// ============================================
// GET ALL LOT NUMBERS
// ============================================
exports.getAllLotNumbers = async (req, res, next) => {
  try {
    const lots = await prisma.lotMaster.findMany({
      where: { isDeleted: false },
      select: { lotNumber: true },
      orderBy: { lotNumber: "asc" },
    });

    const lotNumbers = lots.map((l) => l.lotNumber);
    res.json(lotNumbers);
  } catch (e) {
    next(e);
  }
};

