const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { convertNumericFields } = require("../../utils/numericConverter");

const MATERIAL_NUMERIC_FIELDS = ["density", "thickness", "width"];
const MATERIAL_INCLUDE = {
  materialSubstance: true,
  materialGradeRef: { include: { density: true, substance: true } },
  materialFormRef: true,
  materialDensityRef: true,
};

async function applyMaterialMasterLookups(data, current = {}) {
  const merged = { ...current, ...data };
  const result = { ...data };
  let grade = null;

  if (merged.materialGradeId) {
    grade = await prisma.materialGrade.findFirst({
      where: { id: merged.materialGradeId, isDeleted: false },
      include: { substance: true, density: true },
    });
    if (!grade) throw Object.assign(new Error("Material grade tidak ditemukan."), { status: 400 });
    result.materialSubstanceId = grade.substanceId;
    result.materialGrade = grade.gradeCode;
    result.spec = grade.spec || grade.gradeCode;
    result.thickness = grade.thickness;
    if (grade.density) {
      result.materialDensityId = grade.densityId;
      result.density = grade.density.densityKgMm3;
    }
  }

  const substanceId = result.materialSubstanceId ?? merged.materialSubstanceId;
  if (substanceId) {
    const substance = grade?.substance || await prisma.materialSubstance.findFirst({
      where: { id: substanceId, isDeleted: false },
    });
    if (!substance) throw Object.assign(new Error("Bahan material tidak ditemukan."), { status: 400 });
    result.materialSubstanceId = substance.id;
    result.materialType = substance.substanceName;
  }

  if (merged.materialDensityId && !grade?.density) {
    const density = await prisma.materialDensity.findFirst({
      where: { id: merged.materialDensityId, isDeleted: false },
    });
    if (!density) throw Object.assign(new Error("Berat jenis material tidak ditemukan."), { status: 400 });
    if (substanceId && density.substanceId !== substanceId) {
      throw Object.assign(new Error("Berat jenis harus mengikuti bahan material yang dipilih."), { status: 400 });
    }
    result.density = density.densityKgMm3;
  }

  // Coil/Sheet/Pieces (C/S/P) is a manufacturing/purchasing form, not part of
  // Material Master identity. It is selected per default/alternative BOM.
  return {
    ...result,
    materialFormId: null,
    materialForm: null,
    CSP: null,
    defaultPurchaseUomCode: null,
    defaultConversionUomCode: null,
    defaultConversionFactor: null,
  };
}

const formatMaterialCodePart = (value) => {
  if (value === null || value === undefined || value === "") return "";

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return String(value).replace(/\.0+$/, "");
  }

  return String(value).trim().toUpperCase().replace(/\s+/g, "");
};

const buildMaterialCode = (data) => {
  const spec = formatMaterialCodePart(data.spec);
  const thickness = formatMaterialCodePart(data.thickness);
  const width = formatMaterialCodePart(data.width);

  if (!spec) return "";
  return [spec, thickness, width].filter(Boolean).join("-");
};

const materialIdentityWhere = (data, excludeId = null) => ({
  isDeleted: false,
  materialSubstanceId: data.materialSubstanceId || null,
  materialGradeId: data.materialGradeId || null,
  width: Number(data.width),
  ...(excludeId ? { id: { not: excludeId } } : {}),
});

async function assertUniqueMaterialIdentity(data, excludeId = null) {
  if (!data.materialSubstanceId || !data.materialGradeId || !Number.isFinite(Number(data.width))) {
    throw Object.assign(
      new Error("Material Grade dan Width wajib diisi. Bahan serta thickness mengikuti Material Grade."),
      { status: 400 },
    );
  }
  const duplicate = await prisma.material.findFirst({
    where: materialIdentityWhere(data, excludeId),
    select: { materialCode: true },
  });
  if (duplicate) {
    throw Object.assign(
      new Error(`Material dengan bahan, grade/thickness, dan width yang sama sudah ada: ${duplicate.materialCode}. Form C/S/P dipilih di BOM.`),
      { status: 409 },
    );
  }
}

const applyMaterialCode = (data) => {
  const materialCode = buildMaterialCode(data);
  if (!materialCode) {
    const error = new Error("Spec is required to generate material code");
    error.status = 400;
    throw error;
  }

  return { ...data, materialCode };
};

exports.generateCode = async (req, res, next) => {
  try {
    const convertedQuery = convertNumericFields(req.query, MATERIAL_NUMERIC_FIELDS);
    res.json({ materialCode: buildMaterialCode(convertedQuery) });
  } catch (e) {
    next(e);
  }
};

exports.getAllCodes = async (req, res, next) => {
  try {
    // Fetch semua material codes yang tidak soft deleted
    const materials = await prisma.material.findMany({
      where: { isDeleted: false },
      select: {
        materialCode: true,
      },
      orderBy: { materialCode: "asc" },
    });

    // Return array of material codes
    const codes = materials.map((m) => m.materialCode);
    res.json(codes);
  } catch (e) {
    next(e);
  }
};

exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      category,
      materialCode,
      materialName,
      materialType,
      materialFamily,
      materialForm,
      spec,
      thickness,
      width,
      CSP,
      density,
      page = 1,
      limit = 20,
    } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    if (category) {
      where.itemCategory = category;
    }

    if (materialCode) {
      where.materialCode = { contains: materialCode, mode: "insensitive" };
    }
    if (materialName) {
      where.materialName = { contains: materialName, mode: "insensitive" };
    }
    if (materialType) {
      where.materialType = { contains: materialType, mode: "insensitive" };
    }
    if (materialFamily) {
      where.materialFamily = { contains: materialFamily, mode: "insensitive" };
    }
    if (materialForm) {
      where.materialForm = { contains: materialForm, mode: "insensitive" };
    }
    if (spec) {
      where.spec = { contains: spec, mode: "insensitive" };
    }
    if (CSP) {
      where.CSP = { contains: CSP, mode: "insensitive" };
    }
    if (thickness !== undefined) {
      const value = Number(thickness);
      if (!Number.isNaN(value)) where.thickness = value;
    }
    if (width !== undefined) {
      const value = Number(width);
      if (!Number.isNaN(value)) where.width = value;
    }
    if (density !== undefined) {
      const value = Number(density);
      if (!Number.isNaN(value)) where.density = value;
    }

    if (q) {
      where.OR = [
        { materialCode: { contains: q, mode: "insensitive" } },
        { materialName: { contains: q, mode: "insensitive" } },
        { materialType: { contains: q, mode: "insensitive" } },
        { materialFamily: { contains: q, mode: "insensitive" } },
        { materialForm: { contains: q, mode: "insensitive" } },
        { spec: { contains: q, mode: "insensitive" } },
      ];
      
      // Kalau q adalah angka valid, tambahkan dimension dan density ke search
      const numQ = parseFloat(q);
      if (!isNaN(numQ)) {
        where.OR.push({ density: numQ });
        where.OR.push({ thickness: numQ });
        where.OR.push({ width: numQ });
      }
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.material.findMany({
        where,
        include: MATERIAL_INCLUDE,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.material.count({ where }),
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
    const doc = await prisma.material.findFirst({
      where: { materialCode: req.params.materialCode, isDeleted: false },
      include: MATERIAL_INCLUDE,
    });
    if (!doc) return res.status(404).json({ message: "Material not found" });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const lookupData = await applyMaterialMasterLookups(convertNumericFields(req.body, MATERIAL_NUMERIC_FIELDS));
    const convertedData = applyMaterialCode(lookupData);
    await assertUniqueMaterialIdentity(convertedData);

    // Cek apakah material dengan materialCode yang sama sudah ada dan soft deleted
    const existing = await prisma.material.findUnique({
      where: { materialCode: convertedData.materialCode },
    });

    let doc;
    if (existing && existing.isDeleted) {
      // Jika ada dan soft deleted, update dengan data baru dan restore
      doc = await prisma.material.update({
        where: { id: existing.id },
        data: { ...convertedData, isDeleted: false },
        include: MATERIAL_INCLUDE,
      });
    } else {
      doc = await prisma.material.create({
        data: convertedData,
        include: MATERIAL_INCLUDE,
      });
    }

    res.status(201).json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const convertedData = convertNumericFields(req.body, MATERIAL_NUMERIC_FIELDS);

    // Cek current material
    const currentMaterial = await prisma.material.findUnique({
      where: { id: req.params.id },
    });

    if (!currentMaterial) {
      return res.status(404).json({ message: "Material not found" });
    }

    const lookupData = await applyMaterialMasterLookups(convertedData, currentMaterial);
    const normalizedData = lookupData;
    const materialCode = buildMaterialCode({ ...currentMaterial, ...normalizedData });
    if (!materialCode) {
      return res.status(400).json({ message: "Spec is required to generate material code" });
    }
    const updateData = { ...normalizedData, materialCode };
    await assertUniqueMaterialIdentity({ ...currentMaterial, ...updateData }, currentMaterial.id);

    // Jika materialCode berubah, cek apakah ada material soft deleted dengan code yang sama
    if (
      updateData.materialCode &&
      updateData.materialCode !== currentMaterial.materialCode
    ) {
      const existingSoftDeleted = await prisma.material.findFirst({
        where: {
          materialCode: updateData.materialCode,
          isDeleted: true,
        },
      });

      // Jika ada, hard delete dulu yang soft deleted
      if (existingSoftDeleted) {
        await prisma.material.delete({
          where: { id: existingSoftDeleted.id },
        });
      }
    }

    // Sekarang baru update
    const doc = await prisma.material.update({
      where: { id: req.params.id },
      data: updateData,
      include: MATERIAL_INCLUDE,
    });

    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const doc = await prisma.material.update({
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
    const result = await prisma.material.updateMany({
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
    const { materials } = req.body;

    if (!Array.isArray(materials) || materials.length === 0) {
      return res.status(400).json({ message: "materials array required" });
    }

    const results = {
      success: [],
      failed: [],
      duplicates: [],
      total: materials.length,
    };

    // Process setiap material
    for (const materialData of materials) {
      try {
        const lookupData = await applyMaterialMasterLookups(convertNumericFields(materialData, MATERIAL_NUMERIC_FIELDS));
        const processedData = applyMaterialCode(lookupData);
        await assertUniqueMaterialIdentity(processedData);

        // Cek existing material
        const existing = await prisma.material.findUnique({
          where: { materialCode: processedData.materialCode },
        });

        if (existing && !existing.isDeleted) {
          // Material sudah ada dan active
          results.duplicates.push({
            materialCode: processedData.materialCode,
            existingId: existing.id,
          });
          continue;
        }

        let doc;
        if (existing && existing.isDeleted) {
          // Update material yang soft deleted
          doc = await prisma.material.update({
            where: { id: existing.id },
            data: {
              ...processedData,
              isDeleted: false,
            },
            include: MATERIAL_INCLUDE,
          });
        } else {
          // Create material baru
          doc = await prisma.material.create({
            data: processedData,
            include: MATERIAL_INCLUDE,
          });
        }

        results.success.push(mapDoc(doc));
      } catch (error) {
        results.failed.push({
          data: materialData,
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
        { materialCode: { contains: q, mode: "insensitive" } },
        { materialType: { contains: q, mode: "insensitive" } },
      ];
    }

    const items = await prisma.material.findMany({
      where,
      select: {
        id: true,
        materialCode: true,
        materialName: true,
        materialType: true,
        materialFamily: true,
        materialForm: true,
        spec: true,
        thickness: true,
        width: true,
        CSP: true,
         density: true,
        defaultPurchaseUomCode: true,
        defaultConversionUomCode: true,
        defaultConversionFactor: true,
        materialSubstanceId: true,
        materialGradeId: true,
        materialFormId: true,
        materialDensityId: true,
        materialSubstance: true,
        materialGradeRef: { include: { density: true, substance: true } },
        materialFormRef: true,
        materialDensityRef: true,
      },
      take: Number(limit),
      orderBy: { materialCode: "asc" },
    });

    res.json(items);
  } catch (e) {
    next(e);
  }
};

