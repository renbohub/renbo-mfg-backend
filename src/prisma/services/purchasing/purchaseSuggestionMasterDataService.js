"use strict";

const { resolveEffectiveRecord, legacyPriceValue } = require("../pricing/effectivePriceService");

const asNumber = (value) => value !== null && value !== "" && Number.isFinite(Number(value))
  ? Number(value)
  : null;

function normalizePurchaseFormCode(value) {
  const code = String(value?.formCode || value?.defaultPurchaseUomCode || value?.symbol || value || "")
    .trim()
    .toUpperCase();
  if (["COIL", "C"].includes(code)) return "COIL";
  if (["SHEET", "S"].includes(code)) return "SHEET";
  if (["PCS", "PC", "P", "PIECE", "PIECES"].includes(code)) return "PCS";
  return null;
}

function resolveBomPurchaseDefaults(requirement) {
  const detail = requirement?.mbomDetail;
  if (!detail) return { form: null, width: null, source: "NOT_FOUND", materialScheme: null };
  const alternative = String(detail.materialScheme || "DEFAULT").toUpperCase() === "ALTERNATIVE";
  const selectedForm = alternative ? detail.alternateMaterialForm : detail.materialForm;
  const form = normalizePurchaseFormCode(selectedForm);
  return {
    form,
    width: asNumber(detail.materialWidth),
    source: form ? (alternative ? "MBOM_ALTERNATIVE" : "MBOM_DEFAULT") : "NOT_FOUND",
    materialScheme: alternative ? "ALTERNATIVE" : "DEFAULT",
    mbomDetailId: detail.id || requirement.mbomDetailId || null,
    mbomNumber: detail.noReg || null,
  };
}

function supplierItemIsEffective(row, at) {
  if (!row || row.isActive === false) return false;
  const from = row.validFrom ? new Date(row.validFrom) : null;
  const until = row.validUntil ? new Date(row.validUntil) : null;
  return (!from || from <= at) && (!until || until >= at);
}

function materialPriceMatches(row, material) {
  if (!row || !material) return false;
  if (row.materialId) return row.materialId === material.id;
  return row.materialSubstanceId === material.materialSubstanceId
    && row.materialGradeId === material.materialGradeId
    && (row.thickness == null || Number(row.thickness) === Number(material.thickness));
}

async function resolvePurchaseSuggestionSupplierMaster(db, item, supplierCodeInput, options = {}) {
  const supplierCode = String(supplierCodeInput || "").trim();
  if (!supplierCode) return null;
  const lookupDate = options.asOf ? new Date(options.asOf) : new Date();
  if (Number.isNaN(lookupDate.getTime())) {
    throw Object.assign(new Error("Tanggal lookup master supplier tidak valid."), { status: 400 });
  }

  const [supplier, part] = await Promise.all([
    db.supplier.findFirst({
      where: { supplierCode, isDeleted: false, status: { not: "Inactive" } },
      select: { id: true, supplierCode: true, supplierName: true, leadTimeDays: true },
    }),
    item.partId ? db.part.findFirst({
      where: { id: item.partId, isDeleted: false },
      select: {
        id: true,
        partCode: true,
        purchaseUomCode: true,
        material: {
          select: {
            id: true,
            materialCode: true,
            materialSubstanceId: true,
            materialGradeId: true,
            thickness: true,
            width: true,
            materialForm: true,
            materialFormRef: { select: { formCode: true, symbol: true, defaultPurchaseUomCode: true } },
          },
        },
      },
    }) : null,
  ]);
  if (!supplier) throw Object.assign(new Error(`Supplier ${supplierCode} tidak aktif atau tidak ditemukan.`), { status: 404 });

  const requirementIds = [...new Set([
    item.mrpRequirementId,
    ...(Array.isArray(item.sourceRequirements) ? item.sourceRequirements.map((source) => source?.id) : []),
  ].filter(Boolean))];
  const material = part?.material;
  const materialPriceWhere = material ? {
    isDeleted: false,
    supplierId: supplier.id,
    OR: [
      { materialId: material.id },
      ...(material.materialSubstanceId && material.materialGradeId ? [{
        materialId: null,
        materialSubstanceId: material.materialSubstanceId,
        materialGradeId: material.materialGradeId,
      }] : []),
    ],
  } : null;
  const [supplierItems, partPrices, materialPrices, requirements] = await Promise.all([
    part?.id ? db.supplierItem.findMany({
      where: { supplierId: supplier.id, partId: part.id, isActive: true },
      orderBy: [{ isPreferred: "desc" }, { priority: "asc" }, { updatedAt: "desc" }],
    }) : [],
    part?.id ? db.partPriceList.findMany({
      where: { partId: part.id, supplierId: supplier.id, isDeleted: false },
    }) : [],
    materialPriceWhere ? db.materialPriceList.findMany({ where: materialPriceWhere }) : [],
    requirementIds.length ? db.mRPRequirement.findMany({
      where: { id: { in: requirementIds }, isDeleted: false },
      select: {
        id: true,
        mbomDetailId: true,
        mbomDetail: {
          select: {
            id: true,
            noReg: true,
            materialScheme: true,
            materialWidth: true,
            materialForm: { select: { formCode: true, symbol: true, defaultPurchaseUomCode: true } },
            alternateMaterialForm: { select: { formCode: true, symbol: true, defaultPurchaseUomCode: true } },
          },
        },
      },
    }) : [],
  ]);

  const supplierItem = supplierItems.find((row) => supplierItemIsEffective(row, lookupDate)) || null;
  const requirementById = new Map(requirements.map((row) => [row.id, row]));
  const orderedRequirements = requirementIds.map((id) => requirementById.get(id)).filter(Boolean);
  const bomDefault = orderedRequirements.map(resolveBomPurchaseDefaults).find((value) => value.form)
    || { form: null, width: null, source: "NOT_FOUND", materialScheme: null };
  const matchesBomForm = (row) => !bomDefault.form
    || normalizePurchaseFormCode(row.purchasePackageUomCode || row.CSP) === bomDefault.form;
  const directMaterialPrices = materialPrices.filter((row) => row.materialId === material?.id && matchesBomForm(row));
  const genericMaterialPrices = materialPrices.filter((row) => !row.materialId && materialPriceMatches(row, material) && matchesBomForm(row));
  const materialPrice = resolveEffectiveRecord(directMaterialPrices, lookupDate)
    || resolveEffectiveRecord(genericMaterialPrices, lookupDate);
  const partPrice = resolveEffectiveRecord(partPrices, lookupDate);
  const priceRecord = material ? (materialPrice || partPrice) : (partPrice || materialPrice);
  const priceSource = priceRecord
    ? (priceRecord === materialPrice ? "MATERIAL_PRICE_LIST" : "PART_PRICE_LIST")
    : supplierItem?.price != null ? "SUPPLIER_ITEM" : "PRICE_NOT_FOUND";
  const unitPrice = priceRecord ? legacyPriceValue(priceRecord, lookupDate) : asNumber(supplierItem?.price);

  const fallbackForm = normalizePurchaseFormCode(
    materialPrice?.purchasePackageUomCode
      || material?.materialFormRef
      || material?.materialForm
      || supplierItem?.purchaseUomCode,
  );
  const purchasePackageUomCode = bomDefault.form || fallbackForm;
  const formSource = bomDefault.form
    ? bomDefault.source
    : materialPrice?.purchasePackageUomCode ? "MATERIAL_PRICE_LIST"
      : material?.materialFormRef || material?.materialForm ? "MATERIAL_MASTER"
        : supplierItem?.purchaseUomCode ? "SUPPLIER_ITEM" : "NOT_FOUND";
  const moq = asNumber(materialPrice?.moq) ?? asNumber(supplierItem?.moq);
  const orderMultiple = asNumber(materialPrice?.orderMultiple) ?? asNumber(supplierItem?.orderMultiple);

  return {
    supplierCode: supplier.supplierCode,
    supplierName: supplier.supplierName,
    lookupDate,
    moq,
    orderMultiple,
    unitPrice,
    currencyCode: priceRecord?.currencyCode || supplierItem?.currencyCode || null,
    leadTimeDays: asNumber(supplierItem?.leadTimeDays) ?? asNumber(supplier.leadTimeDays),
    purchasePackageUomCode,
    materialWidth: bomDefault.width ?? asNumber(material?.width),
    sources: {
      moq: materialPrice?.moq != null ? "MATERIAL_PRICE_LIST" : supplierItem?.moq != null ? "SUPPLIER_ITEM" : "NOT_FOUND",
      orderMultiple: materialPrice?.orderMultiple != null ? "MATERIAL_PRICE_LIST" : supplierItem?.orderMultiple != null ? "SUPPLIER_ITEM" : "NOT_FOUND",
      price: priceSource,
      leadTime: supplierItem?.leadTimeDays != null ? "SUPPLIER_ITEM" : supplier.leadTimeDays != null ? "SUPPLIER_MASTER" : "NOT_FOUND",
      form: formSource,
      width: bomDefault.width != null ? bomDefault.source : material?.width != null ? "MATERIAL_MASTER" : "NOT_FOUND",
    },
    priceListId: priceRecord?.id || null,
    priceEffectiveFrom: priceRecord?.effectiveFrom || null,
    priceEffectiveUntil: priceRecord?.effectiveUntil || null,
    bom: bomDefault,
  };
}

module.exports = {
  normalizePurchaseFormCode,
  resolveBomPurchaseDefaults,
  resolvePurchaseSuggestionSupplierMaster,
};
