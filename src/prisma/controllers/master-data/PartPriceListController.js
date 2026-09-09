const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { convertPriceListFields } = require("../../utils/numericConverter");
const {
  normalizeEffectivePriceInput,
  createEffectiveVersion,
  normalizeMonthlyPriceInput,
  saveMonthlyPrice,
  monthlyPriceView,
} = require("../../services/pricing/effectivePriceService");

// Include config untuk partpricelist
const includePartPriceList = {
  part: true,
  supplier: true,
};

const { assertEligiblePricePart, eligibleVendorPartIds, priceEligibility } = require('../../services/pricing/bomVendorPartEligibility');
const assertPurchasePart = (db, data) => assertEligiblePricePart(db, data, { purchaseOnly: true });

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

    const eligibleIds=await eligibleVendorPartIds(prisma);
    res.json({
      items: items.map(item=>({...mapDoc(item),priceEligibility:priceEligibility(item.part,eligibleIds,true)})),
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
    const eligibility=priceEligibility(doc.part,await eligibleVendorPartIds(prisma),true);
    if (req.query.monthlyForm === "true") return res.json({...await monthlyPriceView(prisma, "partPriceList", doc),priceEligibility:eligibility});
    res.json({...doc,priceEligibility:eligibility});
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const convertedData = normalizeEffectivePriceInput(req.body.pricingMode === "MONTHLY" ? req.body : convertPriceListFields(req.body), {
      actor: req.user?.username || req.user?.email || "system",
    });
    if (!convertedData.supplierId || convertedData.unitPrice === undefined) {
      return res.status(400).json({ message: "Supplier dan harga satuan wajib diisi." });
    }
    const saveVersion = req.body.pricingMode === "MONTHLY" ? saveMonthlyPrice : createEffectiveVersion;
    const saved = await prisma.$transaction(async (tx) => { await assertPurchasePart(tx, convertedData); return saveVersion(tx, {
      model: "partPriceList",
      data: convertedData,
      scopeWhere: {
        partId: convertedData.partId,
        supplierId: convertedData.supplierId,
        currencyCode: convertedData.currencyCode || "IDR",
      },
    }); }, {isolationLevel:'Serializable'});
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
      include: includePartPriceList,
    });
    if (!existing) return res.status(404).json({ message: "PartPriceList not found" });
    if (req.body.pricingMode === "MONTHLY") {
      const existingView = await monthlyPriceView(prisma, 'partPriceList', existing);
      const data = normalizeMonthlyPriceInput({partId:existing.partId,supplierId:existing.supplierId,currencyCode:existing.currencyCode,uomCode:existing.uomCode,...req.body}, {existing:existingView});
      if (!data.supplierId || !data.uomCode) return res.status(400).json({ message: "Supplier dan UOM harga wajib dipilih." });
      const doc = await prisma.$transaction(async (tx) => { await assertPurchasePart(tx, data); return saveMonthlyPrice(tx, {
        model: "partPriceList", id: req.params.id, data, include: includePartPriceList,
        scopeWhere: { partId: data.partId, supplierId: data.supplierId, currencyCode: data.currencyCode || "IDR" },
      }); }, {isolationLevel:'Serializable'});
      return res.json(mapDoc(doc));
    }
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
    const doc = await prisma.$transaction(async tx => { await assertPurchasePart(tx, convertedData); return tx.partPriceList.update({
      where: { id: req.params.id },
      data: convertedData,
      include: includePartPriceList,
    }); }, {isolationLevel:'Serializable'});

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

        // Create part price list baru
        delete convertedData.partCode;
        const saved = await prisma.$transaction(async tx => { await assertPurchasePart(tx, convertedData); return convertedData.effectiveFrom
          ? createEffectiveVersion(tx, {
              model: "partPriceList",
              data: convertedData,
              scopeWhere: { partId: convertedData.partId, supplierId: convertedData.supplierId || null, currencyCode: convertedData.currencyCode || "IDR" },
            })
          : tx.partPriceList.create({ data: convertedData }); }, {isolationLevel:'Serializable'});
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
