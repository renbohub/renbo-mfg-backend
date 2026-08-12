const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { convertPriceListFields } = require("../../utils/numericConverter");
const {
  normalizeEffectivePriceInput,
  createEffectiveVersion,
} = require("../../services/pricing/effectivePriceService");

// Include config untuk partpricelist
const includePartPriceList = {
  part: true,
  supplier: true,
};

async function assertPurchasePart(partId) {
  if (!partId) {
    const error = new Error("Part wajib dipilih.");
    error.statusCode = 400;
    throw error;
  }

  const part = await prisma.part.findFirst({
    where: { id: partId, isDeleted: false },
    select: { id: true, itemType: true, rawType: true },
  });
  if (!part) {
    const error = new Error("Part tidak ditemukan atau sudah tidak aktif.");
    error.statusCode = 400;
    throw error;
  }
  if (String(part.itemType || "").toUpperCase() !== "RAW" || String(part.rawType || "").toUpperCase() !== "PURCHASE_PART") {
    const error = new Error("Part Price List hanya dapat dibuat untuk Purchase Part (RAW / PURCHASE_PART).");
    error.statusCode = 400;
    throw error;
  }
  return part;
}

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
    const convertedData = normalizeEffectivePriceInput(convertPriceListFields(req.body), {
      actor: req.user?.username || req.user?.email || "system",
    });
    await assertPurchasePart(convertedData.partId);
    if (!convertedData.supplierId || convertedData.unitPrice === undefined) {
      return res.status(400).json({ message: "Supplier dan harga satuan wajib diisi." });
    }
    const saved = await prisma.$transaction((tx) => createEffectiveVersion(tx, {
      model: "partPriceList",
      data: convertedData,
      scopeWhere: {
        partId: convertedData.partId,
        supplierId: convertedData.supplierId,
        currencyCode: convertedData.currencyCode || "IDR",
      },
    }));
    const doc = await prisma.partPriceList.findUnique({
      where: { id: saved.id },
      include: includePartPriceList,
    });

    res.status(201).json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const existing = await prisma.partPriceList.findFirst({
      where: { id: req.params.id, isDeleted: false },
      select: { partId: true, supplierId: true, currencyCode: true, effectiveFrom: true },
    });
    if (!existing) return res.status(404).json({ message: "PartPriceList not found" });
    const convertedData = normalizeEffectivePriceInput(convertPriceListFields({ ...req.body, effectiveFrom: req.body.effectiveFrom || existing.effectiveFrom }), { requireEffective: true });
    if ((convertedData.partId && convertedData.partId !== existing.partId)
      || (convertedData.supplierId && convertedData.supplierId !== existing.supplierId)
      || (convertedData.currencyCode && convertedData.currencyCode !== existing.currencyCode)
      || convertedData.effectiveFrom.getTime() !== new Date(existing.effectiveFrom).getTime()) {
      return res.status(409).json({ message: "Part, supplier, mata uang, dan tanggal mulai tidak boleh diubah pada histori. Buat Harga Baru untuk periode baru." });
    }
    convertedData.partId = existing.partId;
    convertedData.supplierId = existing.supplierId;
    convertedData.currencyCode = existing.currencyCode;
    await assertPurchasePart(existing.partId);
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
        let convertedData = convertPriceListFields(priceListData);
        if (convertedData.effectiveFrom !== undefined || convertedData.unitPrice !== undefined) {
          convertedData = normalizeEffectivePriceInput(convertedData, { actor: req.user?.username || req.user?.email || "system" });
        }

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

        await assertPurchasePart(convertedData.partId);

        // Create part price list baru
        const saved = convertedData.effectiveFrom
          ? await prisma.$transaction((tx) => createEffectiveVersion(tx, {
              model: "partPriceList",
              data: convertedData,
              scopeWhere: { partId: convertedData.partId, supplierId: convertedData.supplierId || null, currencyCode: convertedData.currencyCode || "IDR" },
            }))
          : await prisma.partPriceList.create({ data: convertedData });
        const doc = await prisma.partPriceList.findUnique({ where: { id: saved.id }, include: includePartPriceList });

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
