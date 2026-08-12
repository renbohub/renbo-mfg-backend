const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { convertPriceListFields } = require("../../utils/numericConverter");
const {
  normalizeEffectivePriceInput,
  createEffectiveVersion,
} = require("../../services/pricing/effectivePriceService");

// Include config untuk materialpricelist
const includeMaterialPriceList = {
  material: true,
  materialSubstance: true,
  materialGrade: { include: { density: true, substance: true } },
  currency: true,
  supplier: {
    select: {
      supplierCode: true,
      supplierName: true,
    },
  },
};
const mapMaterialPrice = (doc) => {
  const mapped = mapDoc(doc);
  if (mapped?.materialGrade) {
    mapped.materialGrade.displayName = `${mapped.materialGrade.gradeCode} — ${mapped.materialGrade.thickness == null ? "Thickness belum diisi" : `${Number(mapped.materialGrade.thickness).toLocaleString("id-ID")} mm`}`;
  }
  return mapped;
};

async function normalizeMaterialPriceData(input) {
  const data = normalizeEffectivePriceInput(convertPriceListFields(input), {
    requireEffective: input.effectiveFrom !== undefined || input.unitPrice !== undefined,
    actor: input.createdBy,
  });
  if (data.thickness !== undefined && data.thickness !== null && data.thickness !== "") {
    data.thickness = Number(data.thickness);
  }

  let material = null;
  if (data.materialId) {
    material = await prisma.material.findFirst({
      where: { id: data.materialId, isDeleted: false },
      select: {
        materialSubstanceId: true,
        materialGradeId: true,
        thickness: true,
        CSP: true,
        materialForm: true,
        defaultPurchaseUomCode: true,
        materialFormRef: { select: { symbol: true, defaultPurchaseUomCode: true } },
      },
    });
    if (!material) throw Object.assign(new Error("Material tidak ditemukan."), { status: 400 });
    data.materialSubstanceId ??= material.materialSubstanceId;
    data.materialGradeId ??= material.materialGradeId;
    data.thickness ??= material.thickness;
    data.CSP ??= material.CSP;
    data.purchasePackageUomCode ??= material.materialFormRef?.symbol || material.materialForm;
    data.uomCode ??= material.defaultPurchaseUomCode || material.materialFormRef?.defaultPurchaseUomCode;
  }

  if (data.materialGradeId) {
    const grade = await prisma.materialGrade.findFirst({
      where: { id: data.materialGradeId, isDeleted: false },
      select: { substanceId: true, thickness: true },
    });
    if (!grade) throw Object.assign(new Error("Material grade tidak ditemukan."), { status: 400 });
    if (data.materialSubstanceId && data.materialSubstanceId !== grade.substanceId) {
      throw Object.assign(new Error("Material grade harus sesuai dengan bahan material."), { status: 400 });
    }
    data.materialSubstanceId = grade.substanceId;
    data.thickness = grade.thickness;
  }

  if (!data.materialId && (!data.materialSubstanceId || !data.materialGradeId || !(Number(data.thickness) > 0))) {
    throw Object.assign(new Error("Harga material wajib memiliki bahan material, grade, dan thickness."), { status: 400 });
  }
  delete data.materialCode;
  delete data.supplierCode;
  return data;
}

exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      partId,
      partCode,
      materialId,
      materialSubstanceId,
      materialGradeId,
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
    if (materialSubstanceId) where.materialSubstanceId = materialSubstanceId;
    if (materialGradeId) where.materialGradeId = materialGradeId;
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
        { materialSubstance: { substanceName: { contains: q, mode: "insensitive" } } },
        { materialGrade: { gradeName: { contains: q, mode: "insensitive" } } },
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
      items: items.map(mapMaterialPrice),
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
    res.json(mapMaterialPrice(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const convertedData = await normalizeMaterialPriceData({
      ...req.body,
      createdBy: req.user?.username || req.user?.email || "system",
    });
    if (!convertedData.supplierId || convertedData.unitPrice === undefined) {
      return res.status(400).json({ message: "Supplier dan harga satuan wajib diisi." });
    }
    const identity = convertedData.materialId
      ? { materialId: convertedData.materialId }
      : {
          materialId: null,
          materialSubstanceId: convertedData.materialSubstanceId,
          materialGradeId: convertedData.materialGradeId,
          thickness: convertedData.thickness,
          CSP: convertedData.CSP || null,
        };
    const saved = await prisma.$transaction((tx) => createEffectiveVersion(tx, {
      model: "materialPriceList",
      data: convertedData,
      scopeWhere: {
        ...identity,
        supplierId: convertedData.supplierId,
        currencyCode: convertedData.currencyCode || "IDR",
        uomCode: convertedData.uomCode || null,
      },
    }));
    const doc = await prisma.materialPriceList.findUnique({
      where: { id: saved.id },
      include: includeMaterialPriceList,
    });

    res.status(201).json(mapMaterialPrice(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const current = await prisma.materialPriceList.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: "MaterialPriceList not found" });
    const convertedData = await normalizeMaterialPriceData({ ...current, ...req.body, id: undefined, createdAt: undefined, updatedAt: undefined });
    delete convertedData.createdBy;
    const doc = await prisma.materialPriceList.update({
      where: { id: req.params.id },
      data: convertedData,
      include: includeMaterialPriceList,
    });

    res.json(mapMaterialPrice(doc));
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
        const normalizedData = await normalizeMaterialPriceData({
          ...convertedData,
          ...(convertedData.effectiveFrom || convertedData.unitPrice !== undefined ? { createdBy: req.user?.username || req.user?.email || "system" } : {}),
        });

        // Create material price list baru
        const identity = normalizedData.materialId
          ? { materialId: normalizedData.materialId }
          : { materialId: null, materialSubstanceId: normalizedData.materialSubstanceId, materialGradeId: normalizedData.materialGradeId, thickness: normalizedData.thickness, CSP: normalizedData.CSP || null };
        const saved = normalizedData.effectiveFrom
          ? await prisma.$transaction((tx) => createEffectiveVersion(tx, {
              model: "materialPriceList",
              data: normalizedData,
              scopeWhere: { ...identity, supplierId: normalizedData.supplierId || null, currencyCode: normalizedData.currencyCode || "IDR", uomCode: normalizedData.uomCode || null },
            }))
          : await prisma.materialPriceList.create({ data: normalizedData });
        const doc = await prisma.materialPriceList.findUnique({ where: { id: saved.id }, include: includeMaterialPriceList });

        results.success.push(mapMaterialPrice(doc));
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
