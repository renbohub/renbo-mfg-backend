const { prisma } = require("../../index");
const { generateDocNumber, generatePONumber } = require("./utils/purchasingHelpers");
const { submitDocumentForApproval } = require("../../services/approvalRuleService");
const { getFormulaSet, evaluateFromSet } = require("../../services/masterFormulaService");
// Commercial PO quantity is intentionally separate from exact MRP demand pegging.
const {
  resolveCommercialOrderQty,
  buildManualPrSourcingDecision,
} = require("../../services/purchasing/purchaseOrderQuantityService");

// Keep sourcing allocations in every PR read so the UI and PO conversion use
// the same persisted supplier/form/delivery decisions.
const include = {
  department: true,
  details: {
    where: { isDeleted: false },
    orderBy: { lineNumber: "asc" },
    include: {
      product: true,
      sources: { where: { isDeleted: false }, orderBy: [{ demandMonth: "asc" }, { createdAt: "asc" }] },
      sourcingAllocations: { where: { isDeleted: false }, orderBy: [{ deliveryDate: "asc" }, { createdAt: "asc" }] },
    },
  },
  purchaseOrders: { include: { po: { select: { poNumber: true, status: true, supplierName: true, vendorName: true } } } },
};
const date = (v) => v ? new Date(v) : undefined;
const num = (v, d = 0) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : d;
  let normalized = String(v ?? "").trim().replace(/\s+/g, "");
  if (!normalized) return d;
  if (normalized.includes(",") && normalized.includes(".")) normalized = normalized.replace(/\./g, "").replace(",", ".");
  else if (normalized.includes(",")) normalized = normalized.replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : d;
};
const bodyObject = (v) => typeof v === "string" ? JSON.parse(v) : (v || {});
const normalize = (v) => String(v || "").trim().toUpperCase();
const clean = (v) => {
  const value = String(v ?? "").trim();
  return value || null;
};
const positiveNumberOrNull = (v) => {
  const value = num(v);
  return value > 0 ? value : null;
};
const actor = (req) => req.user?.username || req.user?.email || req.user?.id || "system";
const dayKey = (value) => {
  const parsed = date(value);
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
};
const isKg = (v) => ["KG", "KGS", "KILOGRAM", "KILOGRAMS"].includes(normalize(v));
const materialPackageUom = (material) => {
  const configured = normalize(material?.defaultPurchaseUomCode);
  if (configured) return configured;
  const form = normalize(material?.materialForm);
  if (form === "SHEET") return "SHEET";
  if (form === "COIL") return "COIL";
  if (["PIECES", "PIECE", "PCS"].includes(form)) return "PCS";
  return form || "LOT";
};
const classifyPart = (part) => {
  if (normalize(part?.rawType) === "MATERIAL") return "MATERIAL";
  if (normalize(part?.rawType) === "PURCHASE_PART") {
    return part?.hasDrawing ? "PURCHASE_PART" : "UNIVERSAL_PURCHASE_PART";
  }
  return "NON_PRODUCTION";
};
const normalizeCategory = (value) => {
  const category = normalize(value).replace(/[\s-]+/g, "_");
  if (["RAW", "MATERIAL", "RAW_MATERIAL"].includes(category)) return "MATERIAL";
  if (["PURCHASE", "PURCHASED", "PURCHASE_PART"].includes(category)) return "PURCHASE_PART";
  if (["UNIVERSAL", "UNIVERSAL_PART", "UNIVERSAL_PURCHASE", "UNIVERSAL_PURCHASE_PART", "NO_DRAWING"].includes(category)) return "UNIVERSAL_PURCHASE_PART";
  if (["OTHER", "NON_PRODUCTION", "NON_PRODUCTION_ITEM", "GENERAL"].includes(category)) return "NON_PRODUCTION";
  return category || null;
};
const normalizeSourceType = (value) => {
  const sourceType = normalize(value || "MANUAL").replace(/[\s-]+/g, "_");
  if (!["MANUAL", "MRP", "SYSTEM"].includes(sourceType)) {
    throw Object.assign(new Error("sourceType PR harus MANUAL, MRP, atau SYSTEM."), { statusCode: 400 });
  }
  return sourceType;
};
const preferredPartBase = (part) => {
  const bases = Array.isArray(part?.partBases) ? part.partBases : [];
  return bases.find((row) => normalize(row.baseOn) === "ACTUAL")
    || bases.find((row) => normalize(row.baseOn) === "QTN")
    || bases[0]
    || null;
};
const classifyRequisition = (details = []) => {
  const categories = [...new Set(details.map((detail) => detail.procurementCategory).filter(Boolean))];
  return categories.length === 1 ? categories[0] : categories.length > 1 ? "MIXED" : "NON_PRODUCTION";
};
async function attachProcurementClassification(rows, client = prisma) {
  const list = Array.isArray(rows) ? rows : [rows];
  const partCodes = [...new Set(list.flatMap((row) => row?.details || []).map((detail) => detail.partCode).filter(Boolean))];
  const vendorCodes = [...new Set(list.flatMap((row) => row?.details || []).flatMap((detail) => [detail.preferredVendor, ...(detail.sourcingAllocations || []).map((allocation) => allocation.vendorCode)]).filter(Boolean))];
  const supplierCodes = [...new Set(list.flatMap((row) => row?.details || []).flatMap((detail) => [detail.confirmedSupplierCode, detail.proposedSupplierCode, detail.preferredSupplier, ...(detail.sourcingAllocations || []).map((allocation) => allocation.supplierCode)]).filter(Boolean))];
  const [parts, vendors, suppliers] = await Promise.all([
    partCodes.length ? client.part.findMany({
      where: { partCode: { in: partCodes }, isDeleted: false },
      select: { partCode: true, itemType: true, rawType: true, hasDrawing: true, procurementType: true, baseUomCode: true, purchaseUomCode: true },
    }) : [],
    vendorCodes.length ? client.vendor.findMany({ where: { vendorCode: { in: vendorCodes }, isDeleted: false }, select: { vendorCode: true, vendorName: true } }) : [],
    supplierCodes.length ? client.supplier.findMany({ where: { supplierCode: { in: supplierCodes }, isDeleted: false }, select: { supplierCode: true, supplierName: true } }) : [],
  ]);
  const partByCode = new Map(parts.map((part) => [normalize(part.partCode), part]));
  const vendorByCode = new Map(vendors.map((vendor) => [normalize(vendor.vendorCode), vendor]));
  const supplierByCode = new Map(suppliers.map((supplier) => [normalize(supplier.supplierCode), supplier]));
  const classified = list.map((row) => {
    const details = (row?.details || []).map((detail) => {
      const part = partByCode.get(normalize(detail.partCode));
      const procurementCategory = normalizeCategory(detail.procurementCategory)
        || (detail.materialCode ? "MATERIAL" : classifyPart(part));
      const sources = Array.isArray(detail.sources) ? detail.sources : [];
      const sourcingAllocations = Array.isArray(detail.sourcingAllocations) ? detail.sourcingAllocations : [];
      const activeSourcingAllocations = sourcingAllocations.filter((allocation) => normalize(allocation.status) !== "CANCELLED");
      const joined = (key) => [...new Set(sources.map((source) => source[key]).filter(Boolean))].join(", ") || null;
      const allocationJoined = (key) => [...new Set(activeSourcingAllocations.map((allocation) => allocation[key]).filter(Boolean))].join(", ") || null;
      const metadataRows = sources.map((source) => source.metadata).filter((metadata) => metadata && typeof metadata === "object" && !Array.isArray(metadata));
      const metadataJoined = (key) => [...new Set(metadataRows.map((metadata) => metadata[key]).filter(Boolean))].join(", ") || null;
      const allocatedDemandQty = activeSourcingAllocations
        .reduce((sum, allocation) => sum + num(allocation.demandCoveredQty), 0);
      const supplierAllocationVariance = allocatedDemandQty - num(detail.qty);
      const supplierAllocationStatus = Math.abs(supplierAllocationVariance) <= 0.000001
        ? "EXACT"
        : supplierAllocationVariance < 0 ? "UNDER" : "OVER";
      const orderVariance = num(detail.orderedQty) - num(detail.qty);
      const orderControlStatus = Math.abs(orderVariance) <= 0.000001
        ? "EXACT"
        : orderVariance < 0 ? "UNDER" : "OVER";
      return {
        ...detail,
        procurementCategory,
        sourceCount: sources.length,
        sourceMrpNumbers: joined("mrpRunNumber"),
        sourceMpsNumbers: joined("mpsNumber"),
        sourceForecastNumbers: joined("forecastNumber"),
        sourceSONumbers: joined("soNumber"),
        sourceDemandMonths: [...new Set(sources.map((source) => dayKey(source.demandMonth)?.slice(0, 7)).filter(Boolean))].join(", ") || null,
        sourcingAllocationCount: activeSourcingAllocations.length,
        sourcingSuppliers: allocationJoined("supplierCode"),
        sourcingVendors: allocationJoined("vendorCode") || detail.preferredVendor || null,
        sourcingForms: allocationJoined("purchasePackageUomCode"),
        sourcingWidths: allocationJoined("materialWidth"),
        sourcingLengths: allocationJoined("materialLength"),
        sourcingDeliveryDates: [...new Set(activeSourcingAllocations.map((allocation) => dayKey(allocation.deliveryDate)).filter(Boolean))].join(", ") || null,
        sourcePlanNumbers: metadataJoined("planNumber"),
        sourceCapacityAllocationIds: metadataJoined("allocationId") || (sources.find((source) => source.sourceType === "CAPACITY_ALLOCATION")?.sourceNumber ?? null),
        vendorSendDates: [...new Set(metadataRows.map((metadata) => dayKey(metadata.vendorSendDate)).filter(Boolean))].join(", ") || null,
        vendorReturnDates: [...new Set(metadataRows.map((metadata) => dayKey(metadata.vendorReturnDate)).filter(Boolean))].join(", ") || null,
        vendorProcessCode: metadataJoined("processCode"),
        vendorProcessName: metadataJoined("processName"),
        customerCodes: metadataJoined("customerCode"),
        customerTargetDates: [...new Set(metadataRows.map((metadata) => dayKey(metadata.customerTargetDate)).filter(Boolean))].join(", ") || null,
        vendorPriceSource: metadataJoined("priceSource"),
        allocatedDemandQty,
        supplierAllocationVariance,
        supplierAllocationStatus,
        orderVariance,
        orderControlStatus,
        partClassification: part || null,
      };
    });
    const procurementCategory = normalizeCategory(row.procurementGroup) || classifyRequisition(details);
    const partnerCodes = [...new Set(details.flatMap((detail) => [detail.sourcingVendors, detail.sourcingSuppliers]).filter(Boolean).flatMap((value) => String(value).split(",").map((part) => part.trim()).filter(Boolean)))];
    const partnerNames = partnerCodes.map((code) => vendorByCode.get(normalize(code))?.vendorName || supplierByCode.get(normalize(code))?.supplierName).filter(Boolean);
    return {
      ...row,
      details,
      procurementCategory,
      prCategory: procurementCategory,
      materialCategory: procurementCategory,
      categoryLabel: ({ MATERIAL: "PR-Raw Material", PURCHASE_PART: "PR-Purchase Part", UNIVERSAL_PURCHASE_PART: "PR-Universal Part", VENDOR_PROCESS: "PR-Vendor Process", NON_PRODUCTION: "PR-Non Production" })[procurementCategory] || procurementCategory,
      partnerCodes: partnerCodes.join(", ") || null,
      partnerNames: partnerNames.join(", ") || null,
      partnerLabel: partnerCodes.map((code) => `${code} — ${vendorByCode.get(normalize(code))?.vendorName || supplierByCode.get(normalize(code))?.supplierName || "Master partner"}`).join(", ") || null,
    };
  });
  return Array.isArray(rows) ? classified : classified[0];
}

/**
 * Normalize user-entered PR lines against master data. Identity values are
 * always snapshotted from the master, not trusted from the request payload.
 * Legacy/free-form lines remain supported when no procurement category is
 * supplied, while explicit Material/Purchase Part lines are strictly checked.
 */
async function normalizeRequisitionDetails(details, client) {
  if (!Array.isArray(details) || !details.length) {
    throw Object.assign(new Error("Minimal satu detail PR wajib diisi."), { statusCode: 400 });
  }

  const partIds = [...new Set(details.map((row) => clean(row.partId)).filter(Boolean))];
  const partCodes = [...new Set(details.map((row) => clean(row.partCode)).filter(Boolean))];
  const partNumbers = [...new Set(details.map((row) => clean(row.partNumber)).filter(Boolean))];
  const materialIds = [...new Set(details.map((row) => clean(row.materialId)).filter(Boolean))];
  const materialCodes = [...new Set(details.map((row) => clean(row.materialCode)).filter(Boolean))];

  const [parts, explicitMaterials, formulas] = await Promise.all([
    (partIds.length || partCodes.length || partNumbers.length) ? client.part.findMany({
      where: {
        isDeleted: false,
        OR: [
          ...(partIds.length ? [{ id: { in: partIds } }] : []),
          ...(partCodes.length ? [{ partCode: { in: partCodes } }] : []),
          ...(partNumbers.length ? [{ partNumber: { in: partNumbers } }] : []),
        ],
      },
      select: {
        id: true, partCode: true, partNumber: true, partName: true, itemType: true,
        rawType: true, hasDrawing: true, materialId: true, baseUomCode: true, purchaseUomCode: true,
      },
    }) : [],
    (materialIds.length || materialCodes.length) ? client.material.findMany({
      where: {
        isDeleted: false,
        OR: [
          ...(materialIds.length ? [{ id: { in: materialIds } }] : []),
          ...(materialCodes.length ? [{ materialCode: { in: materialCodes } }] : []),
        ],
      },
      select: { id: true, materialCode: true, materialName: true, materialType: true, materialForm: true, spec: true, thickness: true, width: true, CSP: true, defaultPurchaseUomCode: true, defaultConversionUomCode: true, defaultConversionFactor: true },
    }) : [],
    getFormulaSet(client, "purchasing"),
  ]);

  const linkedMaterialIds = [...new Set(parts.map((part) => part.materialId).filter(Boolean))];
  const linkedMaterials = linkedMaterialIds.length ? await client.material.findMany({
    where: { id: { in: linkedMaterialIds }, isDeleted: false },
    select: { id: true, materialCode: true, materialName: true, materialType: true, materialForm: true, spec: true, thickness: true, width: true, CSP: true, defaultPurchaseUomCode: true, defaultConversionUomCode: true, defaultConversionFactor: true },
  }) : [];
  const materials = [...explicitMaterials, ...linkedMaterials.filter((material) => !explicitMaterials.some((row) => row.id === material.id))];
  const partById = new Map(parts.map((part) => [part.id, part]));
  const partByCode = new Map(parts.map((part) => [normalize(part.partCode), part]));
  const partsByNumber = new Map();
  for (const part of parts) {
    const key = normalize(part.partNumber);
    if (!key) continue;
    if (!partsByNumber.has(key)) partsByNumber.set(key, []);
    partsByNumber.get(key).push(part);
  }
  const materialById = new Map(materials.map((material) => [material.id, material]));
  const materialByCode = new Map(materials.map((material) => [normalize(material.materialCode), material]));

  const rows = details.map((detail, index) => {
    const line = index + 1;
    const numberMatches = partsByNumber.get(normalize(detail.partNumber)) || [];
    if (!detail.partId && !detail.partCode && clean(detail.partNumber) && numberMatches.length > 1) {
      throw Object.assign(new Error(`Part Number baris ${line} ambigu. Pilih Part Code dari Part Master.`), { statusCode: 400 });
    }
    const part = partById.get(clean(detail.partId))
      || partByCode.get(normalize(detail.partCode))
      || numberMatches[0]
      || null;
    const material = materialById.get(clean(detail.materialId))
      || materialByCode.get(normalize(detail.materialCode))
      || (part?.materialId ? materialById.get(part.materialId) : null)
      || null;
    const categoryHint = normalizeCategory(detail.procurementCategory || detail.prCategory || detail.itemCategory || detail.rawType);
    const category = categoryHint || (material ? "MATERIAL" : classifyPart(part));
    if (categoryHint === "MATERIAL" && part && ["PURCHASE_PART", "UNIVERSAL_PURCHASE_PART"].includes(classifyPart(part))) {
      throw Object.assign(new Error(`Baris ${line}: Purchase Part tidak dapat dicatat sebagai Raw Material.`), { statusCode: 400 });
    }
    if (["PURCHASE_PART", "UNIVERSAL_PURCHASE_PART"].includes(categoryHint) && part && classifyPart(part) === "MATERIAL") {
      throw Object.assign(new Error(`Baris ${line}: Part Material tidak dapat dicatat sebagai Purchase Part.`), { statusCode: 400 });
    }

    if (category === "MATERIAL" && !material) {
      throw Object.assign(new Error(`Baris ${line}: Raw Material wajib dipilih dari Material Master (contoh SPHC), atau Part Material harus memiliki relasi Material Master.`), { statusCode: 400 });
    }
    const isPieceMaterial = category === "MATERIAL" && normalize(material?.materialForm) === "PIECES";
    if (category === "PURCHASE_PART" && !part) {
      throw Object.assign(new Error(`Baris ${line}: Purchase Part wajib dipilih dari Part Master.`), { statusCode: 400 });
    }
    if (category === "PURCHASE_PART" && !clean(part.partNumber)) {
      throw Object.assign(new Error(`Baris ${line}: Purchase Part ${part.partCode} belum memiliki Part Number/drawing code di Part Master.`), { statusCode: 409 });
    }
    if (category === "UNIVERSAL_PURCHASE_PART" && !part) {
      throw Object.assign(new Error(`Baris ${line}: Universal Purchase Part wajib dipilih dari Part Master.`), { statusCode: 400 });
    }
    if (category === "UNIVERSAL_PURCHASE_PART" && clean(part.partNumber)) {
      throw Object.assign(new Error(`Baris ${line}: ${part.partCode} memiliki drawing/Part Number dan harus masuk kelompok Purchase Part.`), { statusCode: 409 });
    }

    const requestedQty = num(detail.qty, Number.NaN);
    if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
      throw Object.assign(new Error(`Qty baris ${line} harus lebih dari 0.`), { statusCode: 400 });
    }
    const lotCount = detail.lotCount == null ? null : num(detail.lotCount, Number.NaN);
    const kgPerLot = detail.kgPerLot == null ? null : num(detail.kgPerLot, Number.NaN);
    if ((lotCount != null || kgPerLot != null) && category !== "MATERIAL") {
      throw Object.assign(new Error(`Baris ${line}: pengaturan lot hanya berlaku untuk Raw Material.`), { statusCode: 400 });
    }
    if ((lotCount != null || kgPerLot != null) && (!(lotCount > 0) || !(kgPerLot > 0))) {
      throw Object.assign(new Error(`Baris ${line}: jumlah lot dan KG per lot harus diisi bersama dan lebih dari 0.`), { statusCode: 400 });
    }
    const calculatedLotKg = lotCount && kgPerLot ? lotCount * kgPerLot : null;
    const requestedPurchaseQtyKg = detail.purchaseQtyKg == null ? null : num(detail.purchaseQtyKg, Number.NaN);
    if (requestedPurchaseQtyKg != null && (!Number.isFinite(requestedPurchaseQtyKg) || requestedPurchaseQtyKg <= 0)) {
      throw Object.assign(new Error(`Baris ${line}: purchaseQtyKg harus lebih dari 0.`), { statusCode: 400 });
    }
    if (calculatedLotKg != null && requestedPurchaseQtyKg != null && Math.abs(calculatedLotKg - requestedPurchaseQtyKg) > 1e-6) {
      throw Object.assign(new Error(`Baris ${line}: purchaseQtyKg harus sama dengan lotCount × kgPerLot (${calculatedLotKg} KG).`), { statusCode: 400 });
    }
    const purchaseQtyKg = calculatedLotKg ?? requestedPurchaseQtyKg;
    const requestedMaterialForm = normalize(detail.purchasePackageUomCode);
    const hasGenericConversion = [
      detail.purchasePackageQty,
      detail.conversionUomCode,
      detail.conversionFactor,
      detail.convertedPurchaseQty,
    ].some((value) => value != null && value !== "");
    const hasLegacyConversion = lotCount != null || kgPerLot != null;
    const usesPurchaseConversion = category === "MATERIAL" && (hasGenericConversion || hasLegacyConversion);
    const purchasePackageQty = usesPurchaseConversion
      ? num(detail.purchasePackageQty ?? lotCount ?? (isPieceMaterial ? requestedQty : 0), 0)
      : null;
    const purchasePackageUomCode = category === "MATERIAL"
      ? (requestedMaterialForm || (usesPurchaseConversion ? materialPackageUom(material) : null))
      : null;
    const conversionUomCode = usesPurchaseConversion
      ? normalize(detail.conversionUomCode || material?.defaultConversionUomCode || (purchaseQtyKg != null ? "KG" : isPieceMaterial ? "PCS" : detail.uomCode))
      : null;
    const conversionFactor = usesPurchaseConversion
      ? num(detail.conversionFactor ?? kgPerLot ?? material?.defaultConversionFactor ?? (isPieceMaterial ? 1 : 0), 0)
      : null;
    const calculatedConvertedQty = purchasePackageQty > 0 && conversionFactor > 0
      ? purchasePackageQty * conversionFactor
      : 0;
    const convertedPurchaseQty = usesPurchaseConversion
      ? num(detail.convertedPurchaseQty ?? purchaseQtyKg ?? (hasGenericConversion ? calculatedConvertedQty : isPieceMaterial ? requestedQty : 0), 0)
      : null;
    if (purchasePackageUomCode && !["COIL", "SHEET", "PCS"].includes(purchasePackageUomCode)) {
      throw Object.assign(new Error(`Baris ${line}: bentuk pembelian wajib C/COIL, S/SHEET, atau P/PCS; bukan ${purchasePackageUomCode || "-"}.`), { statusCode: 400 });
    }
    if (hasGenericConversion && (
      !Number.isInteger(purchasePackageQty)
      || purchasePackageQty <= 0
      || !purchasePackageUomCode
      || !conversionUomCode
      || !(conversionFactor > 0)
    )) {
      throw Object.assign(new Error(`Baris ${line}: qty form harus bilangan bulat positif, form/UOM hasil wajib diisi, dan faktor konversi harus lebih dari 0.`), { statusCode: 400 });
    }
    if (hasGenericConversion && Math.abs(calculatedConvertedQty - convertedPurchaseQty) > 1e-6) {
      throw Object.assign(new Error(`Baris ${line}: convertedPurchaseQty harus sama dengan qty form × faktor (${calculatedConvertedQty} ${conversionUomCode}).`), { statusCode: 400 });
    }
    // Qty PR tetap merupakan kebutuhan PPIC/MRP. Pembulatan bentuk beli disimpan
    // terpisah agar Sheet/Coil/Pcs tidak mengubah demand awal. Selisih kurang
    // atau lebih adalah indikator kontrol, bukan blocker transaksi.
    const qty = requestedQty;
    const estimatedPrice = num(detail.estimatedPrice ?? detail.unitPrice);
    const uomCode = category === "MATERIAL" ? (conversionUomCode || clean(detail.uomCode) || "KG") : (clean(detail.uomCode) || part?.purchaseUomCode || part?.baseUomCode || null);
    const sourcingAllocations = (Array.isArray(detail.sourcingAllocations) ? detail.sourcingAllocations : [])
      .map((allocation, allocationIndex) => {
        const demandCoveredQty = num(allocation.demandCoveredQty ?? allocation.sourceQty ?? allocation.qty);
        if (!(demandCoveredQty > 0)) {
          throw Object.assign(new Error(`Baris ${line}, alokasi supplier ${allocationIndex + 1}: qty alokasi harus lebih dari 0.`), { statusCode: 400 });
        }
        const allocationSupplierCode = clean(allocation.supplierCode);
        if (!allocationSupplierCode) {
          throw Object.assign(new Error(`Baris ${line}, alokasi supplier ${allocationIndex + 1}: supplier wajib dipilih.`), { statusCode: 400 });
        }
        const allocationForm = normalize(allocation.purchasePackageUomCode || allocation.orderUomCode);
        const allocationPackageQty = num(allocation.purchasePackageQty ?? allocation.orderQty, 0);
        const allocationFactor = num(allocation.conversionFactor ?? allocation.kgPerLot, 0);
        const allocationConversionUom = normalize(allocation.conversionUomCode || uomCode);
        const hasAllocationForm = Boolean(allocationForm);
        const hasAllocationConversion = [allocationPackageQty, allocationFactor].some(Boolean);
        if (category === "MATERIAL" && hasAllocationForm) {
          if (!["SHEET", "COIL", "PCS"].includes(allocationForm)) {
            throw Object.assign(new Error(`Baris ${line}, alokasi supplier ${allocationIndex + 1}: pilih bentuk SHEET, COIL, atau PCS.`), { statusCode: 400 });
          }
        }
        if (category === "MATERIAL" && hasAllocationConversion) {
          if (!Number.isInteger(allocationPackageQty) || allocationPackageQty <= 0 || allocationFactor <= 0) {
            throw Object.assign(new Error(`Baris ${line}, alokasi supplier ${allocationIndex + 1}: qty bentuk harus bilangan bulat positif dan isi per bentuk harus lebih dari 0.`), { statusCode: 400 });
          }
          if (!["KG", "PCS"].includes(allocationConversionUom) || allocationConversionUom !== normalize(uomCode)) {
            throw Object.assign(new Error(`Baris ${line}, alokasi supplier ${allocationIndex + 1}: UOM hasil harus sama dengan UOM kebutuhan ${uomCode}.`), { statusCode: 400 });
          }
        }
        const allocationDate = date(allocation.deliveryDate);
        if (allocation.deliveryDate && (!allocationDate || Number.isNaN(allocationDate.getTime()))) {
          throw Object.assign(new Error(`Baris ${line}, alokasi supplier ${allocationIndex + 1}: delivery date tidak valid.`), { statusCode: 400 });
        }
        const unitPrice = allocation.unitPrice == null || allocation.unitPrice === "" ? null : num(allocation.unitPrice);
        const convertedQty = category === "MATERIAL" && hasAllocationConversion
          ? allocationPackageQty * allocationFactor
          : null;
        return {
          supplierCode: allocationSupplierCode,
          vendorCode: clean(allocation.vendorCode),
          demandCoveredQty,
          commercialQty: num(allocation.commercialQty ?? demandCoveredQty),
          demandUomCode: uomCode,
          purchasePackageQty: category === "MATERIAL" && hasAllocationConversion ? allocationPackageQty : null,
          purchasePackageUomCode: category === "MATERIAL" && hasAllocationForm ? allocationForm : null,
          conversionFactor: category === "MATERIAL" && hasAllocationConversion ? allocationFactor : null,
          conversionUomCode: category === "MATERIAL" && hasAllocationConversion ? allocationConversionUom : null,
          convertedPurchaseQty: convertedQty,
          deliveryDate: allocationDate || null,
          currencyCode: normalize(allocation.currencyCode || "IDR"),
          unitPrice,
          totalAmount: unitPrice == null ? null : unitPrice * num(allocationPackageQty || demandCoveredQty),
          status: "Draft",
          notes: clean(allocation.notes),
        };
      });
    return {
      lineNumber: line,
      // For direct Material selection, do not misuse materialCode as partCode.
      // partCode remains an optional, validated trace back to the consuming part.
      procurementCategory: category,
      partCode: category === "MATERIAL" ? (part?.partCode || null) : (part?.partCode || clean(detail.partCode)),
      partNumber: category === "MATERIAL" ? (part?.partNumber || null) : (part?.partNumber || clean(detail.partNumber)),
      partName: category === "MATERIAL" ? (part?.partName || null) : (part?.partName || clean(detail.partName)),
      materialId: material?.id || null,
      materialCode: material?.materialCode || null,
      materialName: material?.materialName || null,
      materialType: material?.materialType || null,
      // Product and Part use different tables/IDs. Never write Part.id into
      // productId for Material/Purchase Part lines (it would violate the FK).
      productId: ["MATERIAL", "PURCHASE_PART", "UNIVERSAL_PURCHASE_PART"].includes(category) ? null : clean(detail.productId),
      description: clean(detail.description),
      spec: category === "MATERIAL" ? (material?.spec || clean(detail.spec)) : clean(detail.spec),
      thickness: category === "MATERIAL" && material?.thickness != null ? num(material.thickness) : (detail.thickness == null ? null : num(detail.thickness)),
      width: category === "MATERIAL" && material?.width != null ? num(material.width) : (detail.width == null ? null : num(detail.width)),
      CSP: category === "MATERIAL"
        ? ({ COIL: "C", SHEET: "S", PCS: "P" }[purchasePackageUomCode] || null)
        : clean(detail.CSP),
      qty,
      uomCode,
      estimatedPrice,
      totalAmount: detail.totalAmount == null || detail.totalAmount === ""
        ? evaluateFromSet(formulas, "PR_LINE_TOTAL", { qty, estimatedPrice })
        : num(detail.totalAmount),
      preferredSupplier: clean(detail.preferredSupplier),
      proposedSupplierCode: clean(detail.proposedSupplierCode || detail.supplierCode),
      supplierProposalSource: clean(detail.supplierProposalSource) || (detail.proposedSupplierCode || detail.supplierCode ? "PURCHASING" : null),
      purchasePackageQty: purchasePackageQty > 0 ? purchasePackageQty : null,
      purchasePackageUomCode,
      conversionUomCode,
      conversionFactor: conversionFactor > 0 ? conversionFactor : null,
      convertedPurchaseQty: convertedPurchaseQty > 0 ? convertedPurchaseQty : null,
      recommendedPurchaseForms: Array.isArray(detail.recommendedPurchaseForms)
        ? detail.recommendedPurchaseForms
        : null,
      lotCount: isKg(conversionUomCode) ? (purchasePackageQty || lotCount) : null,
      kgPerLot: isKg(conversionUomCode) ? (conversionFactor || kgPerLot) : null,
      purchaseQtyKg: isKg(conversionUomCode)
        ? (convertedPurchaseQty || purchaseQtyKg)
        : category === "MATERIAL" && isKg(detail.uomCode || "KG") ? (purchaseQtyKg || requestedQty) : null,
      lotAllocations: detail.lotAllocations || null,
      preferredVendor: clean(detail.preferredVendor),
      plannedOrderNumber: clean(detail.plannedOrderNumber),
      sourcePlannedOrderNumbers: detail.sourcePlannedOrderNumbers || null,
      ...(sourcingAllocations.length ? { sourcingAllocations: { create: sourcingAllocations } } : {}),
      notes: clean(detail.notes),
    };
  });

  const supplierCodes = [...new Set(rows.flatMap((row) => [
    row.proposedSupplierCode,
    ...(row.sourcingAllocations?.create || []).map((allocation) => allocation.supplierCode),
  ]).filter(Boolean))];
  if (supplierCodes.length) {
    const suppliers = await client.supplier.findMany({
      where: { supplierCode: { in: supplierCodes }, isDeleted: false },
      select: { supplierCode: true },
    });
    const found = new Set(suppliers.map((supplier) => supplier.supplierCode));
    const missing = supplierCodes.filter((code) => !found.has(code));
    if (missing.length) throw Object.assign(new Error(`Supplier tidak ditemukan: ${missing.join(", ")}`), { statusCode: 400 });
  }
  return rows;
}

async function rawMaterialConversion(part, sourceUomCode, client) {
  if (isKg(sourceUomCode)) return { factor: 1, uomCode: "KG", source: "already kg" };
  const kgUom = await client.uom.findFirst({ where: { uomCode: { in: ["KG", "kg", "Kg", "KGS", "kgs"] }, isDeleted: false }, select: { uomCode: true } });
  const targetUomCode = kgUom?.uomCode || "KG";
  if (sourceUomCode) {
    const direct = await client.uomConversion.findFirst({
      where: { fromUomCode: sourceUomCode, toUomCode: targetUomCode, isActive: true },
      select: { factor: true },
    });
    if (num(direct?.factor) > 0) return { factor: num(direct.factor), uomCode: targetUomCode, source: "UOM Conversion Master" };
    const inverse = await client.uomConversion.findFirst({
      where: { fromUomCode: targetUomCode, toUomCode: sourceUomCode, isActive: true },
      select: { factor: true },
    });
    if (num(inverse?.factor) > 0) return { factor: 1 / num(inverse.factor), uomCode: targetUomCode, source: "UOM Conversion Master (inverse)" };
  }
  const grossWeight = num(preferredPartBase(part)?.grossWeight);
  if (grossWeight > 0) return { factor: grossWeight, uomCode: targetUomCode, source: "Part Base gross weight" };
  throw Object.assign(new Error(`Konversi ${part?.partCode || "raw material"} dari ${sourceUomCode || "UOM kosong"} ke KG belum tersedia. Isi UOM Conversion Master atau gross weight Part Base.`), { statusCode: 409 });
}
const withSummary = (row) => {
  const grouped = new Map();
  for (const detail of row.details || []) {
    const uomCode = normalize(detail.uomCode) || "UNIT";
    const current = grouped.get(uomCode) || { uomCode, requestedQty: 0, orderedQty: 0 };
    current.requestedQty += num(detail.qty);
    current.orderedQty += num(detail.orderedQty);
    grouped.set(uomCode, current);
  }
  const qtyByUom = [...grouped.values()];
  const singleUom = qtyByUom.length === 1 ? qtyByUom[0] : null;
  const requestedTotal = qtyByUom.reduce((sum, item) => sum + item.requestedQty, 0);
  const orderedTotal = qtyByUom.reduce((sum, item) => sum + item.orderedQty, 0);
  return {
    ...row,
    requestedQty: singleUom?.requestedQty ?? null,
    orderedQty: singleUom?.orderedQty ?? null,
    qtyByUom,
    mixedUom: qtyByUom.length > 1,
    requestedQtyLabel: qtyByUom.map((item) => `${item.requestedQty} ${item.uomCode}`).join(" + "),
    orderedQtyLabel: qtyByUom.map((item) => `${item.orderedQty} ${item.uomCode}`).join(" + "),
    lineCount: (row.details || []).length,
    outstandingQtyLabel: qtyByUom.map((item) => `${Math.max(item.requestedQty - item.orderedQty, 0)} ${item.uomCode}`).join(" + "),
    orderProgressPercent: requestedTotal > 0 ? Math.min(Math.round(orderedTotal / requestedTotal * 10000) / 100, 100) : 0,
  };
};

const materialHeaderSnapshot = (rows, requiredDate) => {
  const materials = [...new Map(rows
    .filter((row) => row.procurementCategory === "MATERIAL" && row.materialId)
    .map((row) => [row.materialId, row])).values()];
  if (!materials.length) {
    return {
      headerMaterialId: null,
      headerMaterialCode: null,
      headerMaterialName: null,
      demandBucket: null,
    };
  }
  if (materials.length > 1) {
    throw Object.assign(
      new Error("Satu header PR Raw Material hanya boleh untuk satu Material Master. Buat header PR terpisah untuk material lainnya."),
      { statusCode: 400 },
    );
  }
  const material = materials[0];
  return {
    headerMaterialId: material.materialId,
    headerMaterialCode: material.materialCode,
    headerMaterialName: material.materialName,
    demandBucket: dayKey(requiredDate || new Date())?.slice(0, 7) || null,
  };
};

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(Number(req.query.page || 1), 1), limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 500);
    const q = String(req.query.q || req.query.search || "").trim();
    const where = {
      isDeleted: false,
      ...(req.query.status ? { status: String(req.query.status) } : {}),
      ...(req.query.sourceType || req.query.source ? { sourceType: normalizeSourceType(req.query.sourceType || req.query.source) } : {}),
    };
    const category = normalizeCategory(req.query.category || req.query.procurementCategory || req.query.prType);
    if (category) {
      const masterPartWhere = category === "MATERIAL"
        ? { rawType: "MATERIAL" }
        : category === "PURCHASE_PART"
          ? { rawType: "PURCHASE_PART", hasDrawing: true }
          : category === "UNIVERSAL_PURCHASE_PART"
            ? { rawType: "PURCHASE_PART", hasDrawing: false }
            : null;
      const matchingParts = masterPartWhere
        ? await prisma.part.findMany({ where: { ...masterPartWhere, isDeleted: false }, select: { partCode: true } })
        : [];
      const legacyDetailFilter = category === "VENDOR_PROCESS"
        ? { procurementCategory: "VENDOR_PROCESS" }
        : category === "MATERIAL"
        ? { OR: [{ materialCode: { not: null } }, { partCode: { in: matchingParts.map((part) => part.partCode) } }] }
        : ["PURCHASE_PART", "UNIVERSAL_PURCHASE_PART"].includes(category)
          ? { partCode: { in: matchingParts.map((part) => part.partCode) } }
          : { partCode: null, materialCode: null };
      where.OR = [
        { procurementGroup: category },
        {
          procurementGroup: null,
          details: {
            some: {
              isDeleted: false,
              OR: [
                { procurementCategory: category },
                { procurementCategory: null, ...legacyDetailFilter },
              ],
            },
          },
        },
      ];
    }
    if (q) {
      const search = [
        ...["prNumber", "requestedBy", "priority", "poType", "sourceType", "headerMaterialCode", "headerMaterialName", "demandBucket", "notes"].map((k) => ({ [k]: { contains: q, mode: "insensitive" } })),
        { details: { some: { isDeleted: false, OR: ["partCode", "partNumber", "partName", "materialCode", "materialName", "materialType", "description"].map((k) => ({ [k]: { contains: q, mode: "insensitive" } })) } } },
      ];
      where.AND = [...(where.AND || []), { OR: search }];
    }
    const [items, total] = await Promise.all([
      prisma.purchaseRequisition.findMany({ where, include, orderBy: { prDate: "desc" }, skip: (page - 1) * limit, take: limit }),
      prisma.purchaseRequisition.count({ where }),
    ]);
    const classified = await attachProcurementClassification(items);
    res.json({ items: classified.map(withSummary), total, page, limit, category: category || "ALL" });
  } catch (e) { next(e); }
};
exports.get = async (req, res, next) => {
  try { const row = await prisma.purchaseRequisition.findFirst({ where: { prNumber: req.params.prNumber, isDeleted: false }, include }); if (!row) return res.status(404).json({ message: "Purchase Requisition tidak ditemukan." }); res.json(await attachProcurementClassification(row)); } catch (e) { next(e); }
};
exports.create = async (req, res, next) => {
  try {
    const input = bodyObject(req.body), header = bodyObject(input.header || input), details = Array.isArray(input.details) ? input.details : [];
    const requiredDate = date(header.requiredDate);
    if (header.requiredDate && (!requiredDate || Number.isNaN(requiredDate.getTime()))) return res.status(400).json({ message: "requiredDate tidak valid." });
    const prDate = date(header.prDate);
    if (header.prDate && (!prDate || Number.isNaN(prDate.getTime()))) return res.status(400).json({ message: "prDate tidak valid." });
    const result = await prisma.$transaction(async (tx) => {
      if (header.departmentId) {
        const department = await tx.department.findFirst({ where: { id: header.departmentId, isDeleted: false }, select: { id: true } });
        if (!department) throw Object.assign(new Error("Department tidak ditemukan atau sudah nonaktif."), { statusCode: 400 });
      }
      const prNumber = await generateDocNumber("purchaseRequisition", "PR", "prNumber", tx);
      const rows = await normalizeRequisitionDetails(details, tx);
      const procurementGroup = normalizeCategory(header.procurementGroup || input.procurementGroup) || classifyRequisition(rows);
      if (procurementGroup === "MIXED") {
        throw Object.assign(new Error("Satu header PR hanya boleh berisi satu kelompok: Material, Purchase Part, Universal Purchase Part, atau Non Produksi."), { statusCode: 400 });
      }
      if (rows.some((row) => row.procurementCategory !== procurementGroup)) {
        throw Object.assign(new Error(`Semua detail PR harus berada pada kelompok ${procurementGroup}.`), { statusCode: 400 });
      }
      const materialHeader = procurementGroup === "MATERIAL"
        ? materialHeaderSnapshot(rows, requiredDate || new Date())
        : materialHeaderSnapshot([], null);
      const totalAmount = rows.reduce((s, d) => s + d.totalAmount, 0);
      return tx.purchaseRequisition.create({ data: { prNumber, prDate: prDate || new Date(), requestedBy: header.requestedBy || req.user?.username || req.user?.email || null, departmentId: header.departmentId || null, requiredDate: requiredDate || new Date(), priority: header.priority || "Normal", poType: header.poType || (procurementGroup === "MATERIAL" ? "Material" : "Other"), procurementGroup, ...materialHeader, sourceType: normalizeSourceType(header.sourceType || input.sourceType || "MANUAL"), totalAmount, notes: header.notes || null, details: { create: rows } }, include });
    });
    res.status(201).json(await attachProcurementClassification(result));
  } catch (e) { if (e.statusCode) return res.status(e.statusCode).json({ message: e.message }); next(e); }
};
exports.update = async (req, res, next) => {
  try {
    const current = await prisma.purchaseRequisition.findFirst({
      where: { prNumber: req.params.prNumber, isDeleted: false },
      include: {
        details: {
          where: { isDeleted: false },
          select: {
            id: true,
            orderedQty: true,
            procurementCategory: true,
            plannedOrderNumber: true,
            sourcePlannedOrderNumbers: true,
            lotAllocations: true,
            notes: true,
            sources: { where: { isDeleted: false } },
            sourcingAllocations: { where: { isDeleted: false } },
          },
        },
        purchaseOrders: { select: { poNumber: true } },
      },
    });
    if (!current) return res.status(404).json({ message: "Purchase Requisition tidak ditemukan." });
    if (!["Draft", "Revision Required", "Rejected"].includes(current.status)) return res.status(409).json({ message: "PR hanya dapat diedit saat Draft, Revision Required, atau Rejected." });
    if (current.purchaseOrders.length || current.details.some((row) => num(row.orderedQty) > 0)) {
      return res.status(409).json({ message: "PR yang sudah terhubung ke PO atau memiliki qty ordered tidak dapat diedit." });
    }
    const input = bodyObject(req.body), header = bodyObject(input.header || input);
    const data = {}; ["requestedBy", "departmentId", "priority", "poType", "notes"].forEach((k) => { if (header[k] !== undefined) data[k] = header[k]; });
    if (header.departmentId !== undefined) data.departmentId = clean(header.departmentId);
    if (header.sourceType !== undefined && normalizeSourceType(header.sourceType) !== current.sourceType) return res.status(409).json({ message: "sourceType PR tidak dapat diubah setelah dokumen dibuat." });
    if (header.prDate !== undefined) {
      data.prDate = date(header.prDate);
      if (!data.prDate || Number.isNaN(data.prDate.getTime())) return res.status(400).json({ message: "prDate tidak valid." });
    }
    if (header.requiredDate !== undefined) {
      data.requiredDate = date(header.requiredDate);
      if (!data.requiredDate || Number.isNaN(data.requiredDate.getTime())) return res.status(400).json({ message: "requiredDate tidak valid." });
    }
    const currentDetailById = new Map(current.details.map((row) => [row.id, row]));
    const details = Array.isArray(input.details) ? input.details.map((row) => {
      const existing = currentDetailById.get(clean(row.id));
      if (!existing || !["MRP", "SYSTEM"].includes(current.sourceType)) return row;
      return {
        ...row,
        plannedOrderNumber: row.plannedOrderNumber || existing.plannedOrderNumber,
        sourcePlannedOrderNumbers: row.sourcePlannedOrderNumbers || existing.sourcePlannedOrderNumbers,
        lotAllocations: row.lotAllocations || existing.lotAllocations,
        notes: row.notes || existing.notes,
        sources: Array.isArray(row.sources) && row.sources.length ? row.sources : existing.sources,
        sourcingAllocations: Array.isArray(row.sourcingAllocations) ? row.sourcingAllocations : existing.sourcingAllocations,
      };
    }) : null;
    const result = await prisma.$transaction(async (tx) => {
      if (data.departmentId) {
        const department = await tx.department.findFirst({ where: { id: data.departmentId, isDeleted: false }, select: { id: true } });
        if (!department) throw Object.assign(new Error("Department tidak ditemukan atau sudah nonaktif."), { statusCode: 400 });
      }
      if (details) {
        const rows = (await normalizeRequisitionDetails(details, tx)).map((row) => ({ ...row, prNumber: current.prNumber }));
        const procurementGroup = normalizeCategory(current.procurementGroup) || classifyRequisition(rows);
        if (classifyRequisition(rows) === "MIXED" || rows.some((row) => row.procurementCategory !== procurementGroup)) {
          throw Object.assign(new Error(`Semua detail PR harus berada pada kelompok ${procurementGroup}.`), { statusCode: 400 });
        }
        data.procurementGroup = procurementGroup;
        Object.assign(
          data,
          procurementGroup === "MATERIAL"
            ? materialHeaderSnapshot(rows, data.requiredDate || current.requiredDate)
            : materialHeaderSnapshot([], null),
        );
        const oldDetailIds = current.details.map((row) => row.id);
        if (oldDetailIds.length) {
          await tx.purchaseRequisitionSourcingAllocation.updateMany({
            where: { prDetailId: { in: oldDetailIds }, isDeleted: false },
            data: { isDeleted: true },
          });
        }
        await tx.purchaseRequisitionDetail.updateMany({ where: { prNumber: current.prNumber }, data: { isDeleted: true } });
        data.totalAmount = rows.reduce((s, r) => s + r.totalAmount, 0);
        for (let index = 0; index < rows.length; index += 1) {
          const sourceRows = Array.isArray(details[index]?.sources) ? details[index].sources : [];
          await tx.purchaseRequisitionDetail.create({
            data: {
              ...rows[index],
              ...(sourceRows.length ? {
                sources: {
                  create: sourceRows.map((source) => ({
                    plannedOrderNumber: clean(source.plannedOrderNumber),
                    mrpRunNumber: clean(source.mrpRunNumber),
                    mpsNumber: clean(source.mpsNumber),
                    mpsDetailId: clean(source.mpsDetailId),
                    forecastNumber: clean(source.forecastNumber),
                    forecastDetailId: clean(source.forecastDetailId),
                    soNumber: clean(source.soNumber),
                    sourceType: clean(source.sourceType),
                    sourceNumber: clean(source.sourceNumber),
                    demandMonth: date(source.demandMonth),
                    requiredDate: date(source.requiredDate),
                    partCode: clean(source.partCode),
                    fgPartCode: clean(source.fgPartCode),
                    qty: num(source.qty),
                    uomCode: clean(source.uomCode),
                    metadata: source.metadata || null,
                  })),
                },
              } : {}),
            },
          });
        }
      }
      return tx.purchaseRequisition.update({ where: { prNumber: current.prNumber }, data, include });
    });
    res.json(await attachProcurementClassification(result));
  } catch (e) { if (e.statusCode) return res.status(e.statusCode).json({ message: e.message }); next(e); }
};
exports.submit = async (req, res, next) => {
  try {
    const pr = await prisma.purchaseRequisition.findFirst({ where: { prNumber: req.params.prNumber, isDeleted: false } });
    if (!pr) return res.status(404).json({ message: "Purchase Requisition tidak ditemukan." });
    if (!["Draft", "Revision Required", "Rejected"].includes(pr.status)) return res.status(409).json({ message: `PR berstatus ${pr.status} tidak dapat disubmit.` });
    const result = await prisma.$transaction(async (tx) => {
      const approvalRequest = await submitDocumentForApproval({ moduleCode: "purchasing", pageCode: "purchase-requisitions", actionCode: "approve", documentType: "PurchaseRequisition", documentId: pr.id, documentNumber: pr.prNumber, amount: pr.totalAmount, context: pr, requestedByUserId: req.user?.id, requestedBy: req.user?.username || req.user?.email, tx });
      const pendingStatus = approvalRequest.rule?.steps?.[0]?.pendingStatus || "Submitted";
      const updated = await tx.purchaseRequisition.update({ where: { prNumber: pr.prNumber }, data: { status: pendingStatus }, include });
      return { updated, approvalRequest };
    });
    res.json({ ...result.updated, approvalRequest: result.approvalRequest });
  } catch (e) { if (e.statusCode) return res.status(e.statusCode).json({ message: e.message }); next(e); }
};
exports.approve = async (req, res, next) => { try { const current = await prisma.purchaseRequisition.findFirst({ where: { prNumber: req.params.prNumber, isDeleted: false } }); if (!current) return res.status(404).json({ message: "Purchase Requisition tidak ditemukan." }); const approvedStatus = req.approval?.step?.approvedStatus || "Approved"; const pr = await prisma.purchaseRequisition.update({ where: { prNumber: current.prNumber }, data: { status: approvedStatus, approvedBy: req.user?.username || req.user?.email || "system", approvedDate: new Date(), rejectedBy: null, rejectedDate: null, rejectionReason: null }, include }); res.json(pr); } catch (e) { next(e); } };
exports.reject = async (req, res, next) => { try { const reason = String(req.body?.reason || req.body?.rejectionReason || req.body?.notes || "").trim(); if (!reason) return res.status(400).json({ message: "Alasan penolakan wajib diisi." }); const current = await prisma.purchaseRequisition.findFirst({ where: { prNumber: req.params.prNumber, isDeleted: false } }); if (!current) return res.status(404).json({ message: "Purchase Requisition tidak ditemukan." }); const rejectedStatus = req.approval?.step?.rejectedStatus || "Rejected"; const pr = await prisma.purchaseRequisition.update({ where: { prNumber: current.prNumber }, data: { status: rejectedStatus, rejectedBy: req.user?.username || req.user?.email || "system", rejectedDate: new Date(), rejectionReason: reason }, include }); res.json(pr); } catch (e) { next(e); } };
exports.remove = async (req, res, next) => {
  try {
    const pr = await prisma.purchaseRequisition.findFirst({
      where: { prNumber: req.params.prNumber, isDeleted: false },
      include: {
        details: { where: { isDeleted: false }, select: { orderedQty: true } },
        purchaseOrders: { select: { poNumber: true } },
      },
    });
    if (!pr) return res.status(404).json({ message: "Purchase Requisition tidak ditemukan." });
    if (!["Draft", "Revision Required", "Rejected"].includes(pr.status)) {
      return res.status(409).json({
        message: `PR berstatus ${pr.status} tidak dapat dihapus. Batalkan proses turunannya terlebih dahulu.`,
      });
    }
    if (pr.purchaseOrders.length || pr.details.some((detail) => num(detail.orderedQty) > 0)) {
      return res.status(409).json({
        message: "PR sudah terhubung ke Purchase Order dan tidak dapat dihapus.",
      });
    }
    await prisma.$transaction([
      prisma.purchaseRequisitionDetail.updateMany({
        where: { prNumber: pr.prNumber, isDeleted: false },
        data: { isDeleted: true },
      }),
      prisma.purchaseRequisition.update({
        where: { prNumber: pr.prNumber },
        data: { isDeleted: true },
      }),
    ]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
};

/**
 * Purchasing supplier confirmation is deliberately separate from the supplier
 * proposal made by PPIC/MRP. Only outstanding lines are mutable so an existing
 * PO always keeps the supplier decision that was used when it was created.
 */
exports.confirmSuppliers = async (req, res, next) => {
  try {
    const input = bodyObject(req.body);
    const lines = Array.isArray(input.lines) ? input.lines : [];
    if (!lines.length) return res.status(400).json({ message: "Minimal satu detail supplier harus dikonfirmasi." });
    const pr = await prisma.purchaseRequisition.findFirst({
      where: { prNumber: req.params.prNumber, isDeleted: false },
      include: { details: { where: { isDeleted: false } } },
    });
    if (!pr) return res.status(404).json({ message: "Purchase Requisition tidak ditemukan." });
    if (!["Draft", "Revising", "Rejected", "Approved", "Partially Ordered"].includes(pr.status)) {
      return res.status(409).json({ message: "Keputusan supplier hanya dapat diedit sebelum proses order selesai dan bukan saat approval sedang berjalan." });
    }

    const vendorProcessPr = normalizeCategory(pr.procurementGroup) === "VENDOR_PROCESS" || normalize(pr.poType) === "OUT PROCESS";
    const byId = new Map(pr.details.map((row) => [row.id, row]));
    const normalizedLines = lines.map((line) => {
      const detail = byId.get(String(line?.prDetailId || line?.id || ""));
      if (!detail) throw Object.assign(new Error("Detail PR yang akan dikonfirmasi tidak ditemukan."), { statusCode: 400 });
      const supplierCode = vendorProcessPr ? null : String(line?.supplierCode || line?.confirmedSupplierCode || "").trim();
      const vendorCode = vendorProcessPr ? String(line?.vendorCode || detail.preferredVendor || "").trim() : null;
      if (!supplierCode && !vendorCode) throw Object.assign(new Error(`${vendorProcessPr ? "Vendor" : "Supplier"} baris ${detail.lineNumber} wajib diisi.`), { statusCode: 400 });
      const rawMaterial = Boolean(detail.materialCode);
      const outstandingQty = Math.max(num(detail.qty) - num(detail.orderedQty), 0);
      const sourceQty = line?.commercialQty == null
        ? (line?.sourceQty == null ? outstandingQty : num(line.sourceQty))
        : num(line.commercialQty);
      const demandCoveredQty = line?.demandCoveredQty == null
        ? Math.min(sourceQty, outstandingQty)
        : Math.min(Math.max(num(line.demandCoveredQty), 0), sourceQty);
      const purchasePackageUomCode = normalize(line?.purchasePackageUomCode || line?.orderUomCode);
      const requestUomCode = normalize(detail.uomCode);
      const materialWidth = num(line?.materialWidth ?? detail.width, 0);
      const materialLength = purchasePackageUomCode === "SHEET" ? num(line?.materialLength ?? detail.materialLength, 0) : null;
      if (rawMaterial) {
        if (!["SHEET", "COIL", "PCS"].includes(purchasePackageUomCode)) {
          throw Object.assign(new Error(`Baris ${detail.lineNumber}: Purchasing wajib memilih bentuk SHEET, COIL, atau PCS.`), { statusCode: 400 });
        }
        if (materialWidth <= 0) {
          throw Object.assign(new Error(`Baris ${detail.lineNumber}: lebar material tersedia wajib lebih dari 0.`), { statusCode: 400 });
        }
        if (purchasePackageUomCode === "SHEET" && materialLength <= 0) {
          throw Object.assign(new Error(`Baris ${detail.lineNumber}: panjang sheet wajib lebih dari 0 mm.`), { statusCode: 400 });
        }
      }
      if (sourceQty <= 0) {
        throw Object.assign(new Error(`Baris ${detail.lineNumber}: qty alokasi supplier harus lebih dari 0.`), { statusCode: 400 });
      }
      return {
        detail,
        supplierCode,
        vendorCode,
        sourceQty,
        demandCoveredQty,
        demandUomCode: requestUomCode || null,
        rawMaterial,
        purchasePackageUomCode: rawMaterial ? purchasePackageUomCode : null,
        purchasePackageQty: null,
        conversionUomCode: null,
        conversionFactor: null,
        convertedPurchaseQty: null,
        materialWidth: rawMaterial ? materialWidth : null,
        materialLength: rawMaterial ? materialLength : null,
        deliveryDate: date(line?.deliveryDate || pr.requiredDate),
        currencyCode: normalize(line?.currencyCode || "IDR"),
        unitPrice: line?.unitPrice == null ? null : num(line.unitPrice),
        notes: clean(line?.notes),
      };
    });
    const coverageByDetail = new Map();
    for (const row of normalizedLines) {
      coverageByDetail.set(row.detail.id, num(coverageByDetail.get(row.detail.id)) + row.sourceQty);
    }
    // Total split supplier boleh UNDER, EXACT, atau OVER terhadap kebutuhan PR.
    // Status selisih dihitung saat response/detail ditampilkan.
    const supplierCodes = [...new Set(normalizedLines.map((row) => row.supplierCode).filter(Boolean))];
    const vendorCodes = [...new Set(normalizedLines.map((row) => row.vendorCode).filter(Boolean))];
    const [suppliers, vendors] = await Promise.all([
      supplierCodes.length ? prisma.supplier.findMany({ where: { supplierCode: { in: supplierCodes }, isDeleted: false }, select: { supplierCode: true, supplierName: true } }) : [],
      vendorCodes.length ? prisma.vendor.findMany({ where: { vendorCode: { in: vendorCodes }, isDeleted: false }, select: { vendorCode: true, vendorName: true } }) : [],
    ]);
    const supplierByCode = new Map(suppliers.map((row) => [row.supplierCode, row]));
    const vendorByCode = new Map(vendors.map((row) => [row.vendorCode, row]));
    const missing = [...supplierCodes.filter((code) => !supplierByCode.has(code)), ...vendorCodes.filter((code) => !vendorByCode.has(code))];
    if (missing.length) return res.status(400).json({ message: `Supplier/vendor tidak ditemukan: ${missing.join(", ")}` });

    const confirmedAt = new Date();
    const confirmedBy = actor(req);
    const result = await prisma.$transaction(async (tx) => {
      const touchedIds = [...coverageByDetail.keys()];
      await tx.purchaseRequisitionSourcingAllocation.updateMany({
        where: {
          prDetailId: { in: touchedIds },
          status: { in: ["Draft", "Confirmed"] },
          isDeleted: false,
        },
        data: { isDeleted: true },
      });
      for (const row of normalizedLines) {
        await tx.purchaseRequisitionSourcingAllocation.create({
          data: {
            prDetailId: row.detail.id,
            supplierCode: row.supplierCode,
            vendorCode: row.vendorCode,
            demandCoveredQty: row.demandCoveredQty,
            commercialQty: row.sourceQty,
            demandUomCode: row.demandUomCode,
            purchasePackageQty: row.purchasePackageQty,
            purchasePackageUomCode: row.purchasePackageUomCode,
            conversionUomCode: row.conversionUomCode,
            conversionFactor: row.conversionFactor,
            convertedPurchaseQty: row.convertedPurchaseQty,
            materialWidth: row.materialWidth,
            materialLength: row.materialLength,
            deliveryDate: row.deliveryDate,
            currencyCode: row.currencyCode,
            unitPrice: row.unitPrice,
            totalAmount: row.unitPrice == null
              ? null
              : row.unitPrice * row.sourceQty,
            status: "Confirmed",
            confirmedBy,
            confirmedAt,
            notes: row.notes,
          },
        });
      }
      for (const detailId of touchedIds) {
        const detailRows = normalizedLines.filter((row) => row.detail.id === detailId);
        const single = detailRows.length === 1 ? detailRows[0] : null;
        await tx.purchaseRequisitionDetail.update({
          where: { id: detailId },
          data: {
            confirmedSupplierCode: single?.supplierCode || null,
            preferredVendor: single?.vendorCode || detailRows[0]?.detail.preferredVendor || null,
            supplierConfirmedBy: confirmedBy,
            supplierConfirmedAt: confirmedAt,
            purchasePackageQty: single?.purchasePackageQty || null,
            purchasePackageUomCode: single?.purchasePackageUomCode || null,
            conversionUomCode: single?.conversionUomCode || null,
            conversionFactor: single?.conversionFactor || null,
            convertedPurchaseQty: single?.convertedPurchaseQty || null,
            width: single?.materialWidth || detailRows[0]?.detail.width || null,
            materialLength: single?.materialLength || null,
            CSP: single?.rawMaterial ? ({ COIL: "C", SHEET: "S", PCS: "P" })[single.purchasePackageUomCode] || null : detailRows[0]?.detail.CSP || null,
            lotCount: null,
            kgPerLot: null,
            purchaseQtyKg: single?.rawMaterial ? single.sourceQty : null,
          },
        });
      }
      return tx.purchaseRequisition.findUnique({ where: { prNumber: pr.prNumber }, include });
    });
    res.json({
      ...(await attachProcurementClassification(result)),
      supplierConfirmation: { confirmedBy, confirmedAt, lineCount: normalizedLines.length, partnerType: vendorProcessPr ? "VENDOR" : "SUPPLIER" },
    });
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
    next(e);
  }
};

/**
 * Consolidate outstanding lines from multiple approved PRs. Grouping is based
 * on the commercial PO header (supplier/vendor, currency and delivery date),
 * never on MRP run, planned order, customer, or parent FG.
 */
exports.consolidateToPO = async (req, res, next) => {
  try {
    const input = bodyObject(req.body);
    const requestedLines = Array.isArray(input.lines) ? input.lines : [];
    if (!requestedLines.length) return res.status(400).json({ message: "Minimal satu detail PR harus dipilih." });
    const ids = [...new Set(requestedLines.map((line) => String(line?.prDetailId || line?.id || "")).filter(Boolean))];
    if (!ids.length) return res.status(400).json({ message: "prDetailId wajib diisi pada setiap baris." });

    const detailRows = await prisma.purchaseRequisitionDetail.findMany({
      where: { id: { in: ids }, isDeleted: false },
      include: {
        pr: true,
        sourcingAllocations: { where: { isDeleted: false } },
      },
    });
    const detailById = new Map(detailRows.map((row) => [row.id, row]));
    if (detailRows.length !== ids.length) return res.status(400).json({ message: "Sebagian detail PR tidak ditemukan." });
    const invalidPr = detailRows.find((row) => !["Approved", "Partially Ordered"].includes(row.pr.status));
    if (invalidPr) return res.status(409).json({ message: `${invalidPr.prNumber} belum Approved atau sudah selesai.` });

    const normalizedLines = requestedLines.map((requestLine) => {
      const detail = detailById.get(String(requestLine?.prDetailId || requestLine?.id || ""));
      const requestedAllocationId = clean(requestLine.sourcingAllocationId || requestLine.allocationId);
      const usableAllocations = detail.sourcingAllocations.filter((allocation) => allocation.status === "Confirmed");
      let persistedAllocation = requestedAllocationId
        ? usableAllocations.find((allocation) => allocation.id === requestedAllocationId)
        : usableAllocations.length === 1 ? usableAllocations[0] : null;
      const manualPr = normalize(detail.pr.sourceType) === "MANUAL";
      // Manual PR stores its commercial decision directly on the PR detail.
      // Do not force users to reopen the split-sourcing editor merely to copy
      // the same supplier/form into a separate allocation record. The adapter
      // below is persisted as a Confirmed allocation in the transaction, so PO
      // conversion and audit still use the canonical sourcing model.
      if (!persistedAllocation && !requestedAllocationId && manualPr && usableAllocations.length === 0) {
        persistedAllocation = buildManualPrSourcingDecision({
          detail,
          requestLine,
          currencyCode: input.currencyCode || "IDR",
        });
      }
      if (!persistedAllocation) {
        throw Object.assign(new Error(`${detail.prNumber}/${detail.lineNumber}: keputusan supplier/form belum final. Gunakan Edit Supplier & Material Form pada PR.`), { statusCode: 409 });
      }
      const outstanding = num(detail.qty) - num(detail.orderedQty);
      const sourceQty = resolveCommercialOrderQty({
        commercialQty: persistedAllocation.commercialQty,
        demandCoveredQty: persistedAllocation.demandCoveredQty,
        outstandingQty: outstanding,
        activeAllocationCount: usableAllocations.length,
      });
      if (sourceQty <= 0) {
        throw Object.assign(new Error(`Qty baris ${detail.prNumber}/${detail.lineNumber} harus lebih dari 0.`), { statusCode: 400 });
      }
      const supplierCode = String(persistedAllocation.supplierCode || detail.confirmedSupplierCode || "").trim();
      const vendorCode = String(persistedAllocation.vendorCode || detail.preferredVendor || "").trim();
      if (!supplierCode && !vendorCode) {
        throw Object.assign(new Error(`Supplier Purchasing baris ${detail.prNumber}/${detail.lineNumber} belum dikonfirmasi.`), { statusCode: 409 });
      }
      if (supplierCode && vendorCode) {
        throw Object.assign(new Error(`Baris ${detail.prNumber}/${detail.lineNumber} tidak boleh memiliki supplier dan vendor sekaligus.`), { statusCode: 400 });
      }
      const currencyCode = String(persistedAllocation.currencyCode || input.currencyCode || "IDR").trim().toUpperCase();
      const deliveryDate = dayKey(persistedAllocation.deliveryDate || detail.pr.requiredDate);
      const targetPoNumber = String(requestLine.targetPoNumber || input.targetPoNumber || "").trim() || null;
      const rawMaterial = Boolean(detail.materialCode);
      const purchasePackageUomCode = normalize(
        persistedAllocation.purchasePackageUomCode
          || detail.purchasePackageUomCode,
      );
      const materialWidth = rawMaterial ? num(persistedAllocation.materialWidth ?? detail.width) : null;
      const materialLength = rawMaterial && purchasePackageUomCode === "SHEET"
        ? num(persistedAllocation.materialLength ?? detail.materialLength)
        : null;
      if (rawMaterial) {
        if (!["SHEET", "COIL", "PCS"].includes(purchasePackageUomCode)) {
          throw Object.assign(
            new Error(`${detail.prNumber}/${detail.lineNumber}: Purchasing wajib memilih bentuk SHEET, COIL, atau PCS.`),
            { statusCode: 400 },
          );
        }
        if (materialWidth <= 0) {
          throw Object.assign(new Error(`${detail.prNumber}/${detail.lineNumber}: lebar material pada keputusan PR belum diisi.`), { statusCode: 400 });
        }
        if (purchasePackageUomCode === "SHEET" && materialLength <= 0) {
          throw Object.assign(new Error(`${detail.prNumber}/${detail.lineNumber}: panjang sheet pada keputusan PR belum diisi.`), { statusCode: 400 });
        }
      }
      return {
        requestLine,
        detail,
        sourceQty,
        supplierCode: supplierCode || null,
        vendorCode: vendorCode || null,
        currencyCode,
        deliveryDate,
        targetPoNumber,
        rawMaterial,
        purchasePackageUomCode: rawMaterial ? purchasePackageUomCode : null,
        purchasePackageQty: rawMaterial
          ? positiveNumberOrNull(persistedAllocation.purchasePackageQty ?? detail.purchasePackageQty)
          : null,
        conversionUomCode: rawMaterial
          ? clean(persistedAllocation.conversionUomCode || detail.conversionUomCode)
          : null,
        conversionFactor: rawMaterial
          ? positiveNumberOrNull(persistedAllocation.conversionFactor ?? detail.conversionFactor)
          : null,
        convertedPurchaseQty: rawMaterial
          ? positiveNumberOrNull(persistedAllocation.convertedPurchaseQty ?? detail.convertedPurchaseQty)
          : null,
        materialWidth,
        materialLength,
        sourcingAllocationId: persistedAllocation.id || null,
        demandCoveredQty: Math.min(num(persistedAllocation.demandCoveredQty), sourceQty),
        unitPrice: persistedAllocation.unitPrice == null ? null : num(persistedAllocation.unitPrice),
        notes: clean(persistedAllocation.notes),
      };
    });

    // A PR detail may appear multiple times when its demand is split across
    // suppliers/forms. The aggregate may be under the outstanding demand, but
    // must never claim more demand than the PR actually has.
    const coverageByDetail = new Map();
    for (const row of normalizedLines) {
      coverageByDetail.set(row.detail.id, num(coverageByDetail.get(row.detail.id)) + row.sourceQty);
    }
    for (const [detailId, coveredQty] of coverageByDetail) {
      const detail = detailById.get(detailId);
      const outstandingQty = Math.max(num(detail.qty) - num(detail.orderedQty), 0);
      if (coveredQty > outstandingQty + 0.000001) {
        throw Object.assign(new Error(`${detail.prNumber}/${detail.lineNumber}: total qty ${coveredQty} melebihi outstanding PR ${outstandingQty}.`), { statusCode: 409 });
      }
    }
    const supplierCodes = [...new Set(normalizedLines.map((row) => row.supplierCode).filter(Boolean))];
    const vendorCodes = [...new Set(normalizedLines.map((row) => row.vendorCode).filter(Boolean))];
    const [suppliers, vendors] = await Promise.all([
      supplierCodes.length ? prisma.supplier.findMany({ where: { supplierCode: { in: supplierCodes }, isDeleted: false }, select: { supplierCode: true, supplierName: true } }) : [],
      vendorCodes.length ? prisma.vendor.findMany({ where: { vendorCode: { in: vendorCodes }, isDeleted: false }, select: { vendorCode: true, vendorName: true } }) : [],
    ]);
    const supplierByCode = new Map(suppliers.map((row) => [row.supplierCode, row]));
    const vendorByCode = new Map(vendors.map((row) => [row.vendorCode, row]));
    const unknownPartner = normalizedLines.find((row) => (row.supplierCode && !supplierByCode.has(row.supplierCode)) || (row.vendorCode && !vendorByCode.has(row.vendorCode)));
    if (unknownPartner) return res.status(400).json({ message: `Supplier/vendor tidak ditemukan: ${unknownPartner.supplierCode || unknownPartner.vendorCode}` });

    const result = await prisma.$transaction(async (tx) => {
      // Serialize all conversions for the same PR details. The rows were read
      // above for UI validation, but only the locked values are authoritative.
      for (const detailId of [...coverageByDetail.keys()].sort()) {
        await tx.$queryRaw`SELECT id FROM "tbl_purchase_requisition_detail" WHERE id = ${detailId} FOR UPDATE`;
      }
      const lockedDetails = await tx.purchaseRequisitionDetail.findMany({
        where: { id: { in: [...coverageByDetail.keys()] }, isDeleted: false },
        select: { id: true, prNumber: true, lineNumber: true, qty: true, orderedQty: true },
      });
      const lockedById = new Map(lockedDetails.map((row) => [row.id, row]));
      for (const [detailId, coveredQty] of coverageByDetail) {
        const detail = lockedById.get(detailId);
        if (!detail) throw Object.assign(new Error("Detail PR berubah atau sudah dihapus. Muat ulang data."), { statusCode: 409 });
        const outstandingQty = Math.max(num(detail.qty) - num(detail.orderedQty), 0);
        if (coveredQty > outstandingQty + 0.000001) {
          throw Object.assign(new Error(`${detail.prNumber}/${detail.lineNumber}: outstanding PR berubah menjadi ${outstandingQty}; qty ${coveredQty} tidak dapat diproses.`), { statusCode: 409 });
        }
      }
      const confirmedAt = new Date();
      const confirmedBy = actor(req);
      for (const row of normalizedLines) {
        const allocationData = {
          supplierCode: row.supplierCode,
          vendorCode: row.vendorCode,
          demandCoveredQty: row.demandCoveredQty,
          commercialQty: row.sourceQty,
          demandUomCode: row.detail.uomCode,
          purchasePackageUomCode: row.purchasePackageUomCode,
          purchasePackageQty: row.purchasePackageQty,
          conversionUomCode: row.conversionUomCode,
          conversionFactor: row.conversionFactor,
          convertedPurchaseQty: row.convertedPurchaseQty,
          materialWidth: row.materialWidth,
          materialLength: row.materialLength,
          deliveryDate: date(row.deliveryDate),
          currencyCode: row.currencyCode,
          unitPrice: row.unitPrice,
          totalAmount: row.unitPrice == null
            ? null
            : row.unitPrice * num(row.purchasePackageQty || row.sourceQty),
          status: "Confirmed",
          confirmedBy,
          confirmedAt,
          notes: row.notes,
        };
        if (row.sourcingAllocationId) {
          const existingAllocation = row.detail.sourcingAllocations.find(
            (allocation) => allocation.id === row.sourcingAllocationId && !["Ordered", "Cancelled"].includes(allocation.status),
          );
          if (!existingAllocation) {
            throw Object.assign(new Error(`Sourcing allocation ${row.sourcingAllocationId} tidak tersedia untuk diproses.`), { statusCode: 409 });
          }
          await tx.purchaseRequisitionSourcingAllocation.update({
            where: { id: existingAllocation.id },
            data: allocationData,
          });
        } else {
          const allocation = await tx.purchaseRequisitionSourcingAllocation.create({
            data: { prDetailId: row.detail.id, ...allocationData },
            select: { id: true },
          });
          row.sourcingAllocationId = allocation.id;
        }
      }
      for (const detailId of coverageByDetail.keys()) {
        const detailAllocations = normalizedLines.filter((row) => row.detail.id === detailId);
        const single = detailAllocations.length === 1 ? detailAllocations[0] : null;
        await tx.purchaseRequisitionDetail.update({
          where: { id: detailId },
          data: {
            confirmedSupplierCode: single?.supplierCode || null,
            supplierConfirmedBy: confirmedBy,
            supplierConfirmedAt: confirmedAt,
            supplierProposalSource: "PURCHASING",
            purchasePackageUomCode: single?.purchasePackageUomCode || null,
            purchasePackageQty: single?.purchasePackageQty || null,
            conversionUomCode: single?.conversionUomCode || null,
            conversionFactor: single?.conversionFactor || null,
            convertedPurchaseQty: single?.convertedPurchaseQty || null,
            width: single?.materialWidth || null,
            materialLength: single?.materialLength || null,
            CSP: single?.rawMaterial ? ({ COIL: "C", SHEET: "S", PCS: "P" })[single.purchasePackageUomCode] || null : null,
            lotCount: single?.rawMaterial && single.conversionUomCode === "KG" ? single.purchasePackageQty : null,
            kgPerLot: single?.rawMaterial && single.conversionUomCode === "KG" ? single.conversionFactor : null,
            purchaseQtyKg: single?.rawMaterial && single.conversionUomCode === "KG" ? single.convertedPurchaseQty : null,
          },
        });
      }
      const groups = new Map();
      for (const row of normalizedLines) {
        // Explicit PO targets form their own group; otherwise use compatible
        // commercial header values. MRP/FG references are intentionally absent.
        const key = row.targetPoNumber
          ? `PO:${row.targetPoNumber}`
          : [row.supplierCode || "", row.vendorCode || "", row.currencyCode, row.deliveryDate].join("|");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }

      const purchaseOrders = [];
      for (const groupRows of groups.values()) {
        const first = groupRows[0];
        const target = first.targetPoNumber
          ? await tx.purchaseOrder.findFirst({ where: { poNumber: first.targetPoNumber, isDeleted: false } })
          : null;
        if (first.targetPoNumber && !target) throw Object.assign(new Error(`PO tujuan ${first.targetPoNumber} tidak ditemukan.`), { statusCode: 404 });
        if (target && target.status !== "Draft") throw Object.assign(new Error(`PO tujuan ${target.poNumber} harus berstatus Draft.`), { statusCode: 409 });
        if (target && ((target.supplierCode || null) !== first.supplierCode || (target.vendorCode || null) !== first.vendorCode)) {
          throw Object.assign(new Error(`Supplier/vendor tidak cocok dengan PO tujuan ${target.poNumber}.`), { statusCode: 409 });
        }
        if (target && normalize(target.currencyCode) !== normalize(first.currencyCode)) {
          throw Object.assign(new Error(`Currency tidak cocok dengan PO tujuan ${target.poNumber}.`), { statusCode: 409 });
        }
        if (target && dayKey(target.deliveryDate) !== first.deliveryDate) {
          throw Object.assign(new Error(`Delivery date tidak cocok dengan PO tujuan ${target.poNumber}.`), { statusCode: 409 });
        }
        if (groupRows.some((row) => row.supplierCode !== first.supplierCode || row.vendorCode !== first.vendorCode || row.currencyCode !== first.currencyCode || row.deliveryDate !== first.deliveryDate)) {
          throw Object.assign(new Error(`Baris untuk PO ${target?.poNumber || "baru"} memiliki header komersial yang tidak kompatibel.`), { statusCode: 409 });
        }

        const prepared = [];
        for (const row of groupRows) {
          const detail = row.detail;
          const explicitOrderUom = row.requestLine.orderUomCode || row.requestLine.poUomCode;
          const explicitOrderQty = num(row.requestLine.orderQty ?? row.requestLine.poQty, 0);
          const poQty = row.rawMaterial ? row.sourceQty : (explicitOrderQty || row.sourceQty);
          const poUom = row.rawMaterial ? (detail.uomCode || "KG") : (explicitOrderUom || detail.uomCode);
          let conversionSource = null;
          if (row.rawMaterial) {
            conversionSource = row.purchasePackageUomCode === "SHEET"
              ? `bentuk SHEET; lebar ${row.materialWidth} mm; panjang ${row.materialLength} mm; order dalam ${poUom}`
              : `bentuk ${row.purchasePackageUomCode}; lebar ${row.materialWidth} mm; order dalam ${poUom}`;
          } else if (explicitOrderUom && explicitOrderQty > 0) {
            conversionSource = "keputusan final PR";
          }
          const totalAmount = row.unitPrice != null
            ? row.unitPrice * poQty
            : num(detail.estimatedPrice) * row.sourceQty;
          const unitPrice = row.unitPrice != null
            ? row.unitPrice
            : poQty > 0 ? totalAmount / poQty : 0;
          prepared.push({
            sourceQty: row.sourceQty,
            sourcingAllocationId: row.sourcingAllocationId,
            detail,
            data: {
              prDetailId: detail.id,
              productId: detail.productId,
              partCode: detail.partCode,
              partNumber: detail.partNumber,
              partName: detail.partName,
              materialId: detail.materialId,
              materialCode: detail.materialCode,
              materialName: detail.materialName,
              materialType: detail.materialType,
              description: detail.description,
              spec: detail.spec,
              thickness: detail.thickness,
              width: row.materialWidth || detail.width,
              materialLength: row.materialLength,
              CSP: row.rawMaterial ? ({ COIL: "C", SHEET: "S", PCS: "P" })[row.purchasePackageUomCode] || detail.CSP : detail.CSP,
               qty: poQty,
               uomCode: poUom,
              purchasePackageQty: row.purchasePackageQty,
              purchasePackageUomCode: row.purchasePackageUomCode,
              conversionUomCode: row.conversionUomCode,
              conversionFactor: row.conversionFactor,
              convertedPurchaseQty: row.convertedPurchaseQty,
              unitPrice,
              totalAmount,
              deliveryDate: date(row.deliveryDate),
              notes: conversionSource
                ? `${detail.notes || ""}${detail.notes ? "; " : ""}${conversionSource}; source demand ${row.sourceQty} ${detail.uomCode || "unit"}`
                : detail.notes,
            },
          });
        }
        const amount = prepared.reduce((sum, row) => sum + row.data.totalAmount, 0);
        const prNumbers = [...new Set(prepared.map((row) => row.detail.prNumber))];
        const poTypes = [...new Set(prepared.map((row) => row.detail.pr.poType).filter(Boolean))];
        let po;
        if (target) {
          const lastLine = await tx.purchaseOrderDetail.findFirst({ where: { poNumber: target.poNumber }, orderBy: { lineNumber: "desc" }, select: { lineNumber: true } });
          await tx.purchaseOrderDetail.createMany({ data: prepared.map((row, index) => ({ ...row.data, poNumber: target.poNumber, lineNumber: num(lastLine?.lineNumber) + index + 1 })) });
          for (const prNumber of prNumbers) await tx.purchaseOrderPR.upsert({ where: { poNumber_prNumber: { poNumber: target.poNumber, prNumber } }, create: { poNumber: target.poNumber, prNumber }, update: {} });
          await tx.purchaseOrderComment.create({ data: { poNumber: target.poNumber, type: "pr-consolidation", message: `Added ${prepared.length} line(s) from ${prNumbers.join(", ")}; grouped by supplier/currency/delivery`, createdBy: actor(req), userId: req.user?.id || null } });
          po = await tx.purchaseOrder.update({ where: { poNumber: target.poNumber }, data: { totalAmount: { increment: amount } }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } }, purchaseRequisitions: true } });
        } else {
          const poNumber = await generatePONumber(poTypes.length === 1 ? poTypes[0] : "Mixed", tx, input.poNumberPrefix, first.supplierCode || first.vendorCode);
          po = await tx.purchaseOrder.create({
            data: {
              poNumber,
              poDate: new Date(),
              supplierCode: first.supplierCode,
              supplierName: supplierByCode.get(first.supplierCode)?.supplierName || null,
              vendorCode: first.vendorCode,
              vendorName: vendorByCode.get(first.vendorCode)?.vendorName || null,
              deliveryDate: date(first.deliveryDate),
              poType: poTypes.length === 1 ? poTypes[0] : "Mixed",
              currencyCode: first.currencyCode,
              status: "Draft",
              totalAmount: amount,
              notes: input.notes || `Consolidated from ${prNumbers.join(", ")}`,
              createdBy: actor(req),
              purchaseRequisitions: { create: prNumbers.map((prNumber) => ({ prNumber })) },
              comments: { create: { type: "pr-consolidation", message: `Created from ${prNumbers.join(", ")}; grouping independent of MRP/FG`, createdBy: actor(req), userId: req.user?.id || null } },
              details: { create: prepared.map((row, index) => ({ ...row.data, lineNumber: index + 1 })) },
            },
            include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } }, purchaseRequisitions: true },
          });
        }

        const allocationIds = prepared.map((row) => row.sourcingAllocationId).filter(Boolean);
        if (allocationIds.length) {
          await tx.purchaseRequisitionSourcingAllocation.updateMany({
            where: { id: { in: allocationIds }, isDeleted: false },
            data: { status: "Ordered", poNumber: po.poNumber },
          });
        }
        for (const row of prepared) {
          await tx.purchaseRequisitionDetail.update({
            where: { id: row.detail.id },
            data: {
              orderedQty: { increment: row.sourceQty },
              supplierConfirmedBy: actor(req),
              supplierConfirmedAt: new Date(),
            },
          });
        }
        purchaseOrders.push(po);
      }

      const affectedPrNumbers = [...new Set(normalizedLines.map((row) => row.detail.prNumber))];
      const prStatuses = [];
      for (const prNumber of affectedPrNumbers) {
        const details = await tx.purchaseRequisitionDetail.findMany({ where: { prNumber, isDeleted: false }, select: { qty: true, orderedQty: true } });
        const hasOutstanding = details.some((row) => num(row.qty) > num(row.orderedQty) + 1e-9);
        const relatedPOs = purchaseOrders.filter((po) => po.purchaseRequisitions?.some((link) => link.prNumber === prNumber));
        await tx.purchaseRequisition.update({ where: { prNumber }, data: { status: hasOutstanding ? "Partially Ordered" : "Completed", convertedToPO: relatedPOs.at(-1)?.poNumber || undefined } });
        prStatuses.push({ prNumber, status: hasOutstanding ? "Partially Ordered" : "Completed" });
      }
      return { purchaseOrders, prStatuses };
    });
    res.status(201).json({
      ...result,
      poCount: result.purchaseOrders.length,
      grouping: "SUPPLIER_CURRENCY_DELIVERY",
    });
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
    next(e);
  }
};

exports.convertToPO = async (req, res, next) => {
  try {
    const input = bodyObject(req.body);
    const pr = await prisma.purchaseRequisition.findFirst({
      where: { prNumber: req.params.prNumber, isDeleted: false },
      include: { details: { where: { isDeleted: false } } },
    });
    if (!pr) return res.status(404).json({ message: "Purchase Requisition tidak ditemukan." });
    if (!["Approved", "Partially Ordered"].includes(pr.status)) {
      return res.status(409).json({ message: "PR harus Approved sebelum dipindahkan ke PO." });
    }
    const suppliedLines = Array.isArray(input.lines) ? input.lines : [];
    const requestedIds = new Set([
      ...(Array.isArray(input.detailIds) ? input.detailIds : []),
      ...(Array.isArray(input.prDetailIds) ? input.prDetailIds : []),
      ...suppliedLines.map((line) => line?.prDetailId || line?.id),
    ].filter(Boolean).map(String));
    const outstanding = pr.details.filter(
      (detail) => num(detail.qty) > num(detail.orderedQty)
        && (!requestedIds.size || requestedIds.has(detail.id)),
    );
    if (!outstanding.length) {
      return res.status(409).json({ message: "Tidak ada detail PR outstanding yang dapat diproses." });
    }
    const suppliedById = new Map(
      suppliedLines
        .map((line) => [String(line?.prDetailId || line?.id || ""), line])
        .filter(([id]) => id),
    );
    req.body = {
      ...input,
      targetPoNumber: input.targetPoNumber || input.existingPoNumber || input.poNumber || null,
      lines: outstanding.map((detail) => {
        const supplied = suppliedById.get(detail.id) || {};
        return {
          ...supplied,
          prDetailId: detail.id,
          sourceQty: supplied.sourceQty ?? supplied.qty ?? (num(detail.qty) - num(detail.orderedQty)),
          supplierCode: supplied.supplierCode || input.supplierCode || detail.confirmedSupplierCode || null,
          vendorCode: supplied.vendorCode || input.vendorCode || detail.preferredVendor || null,
          purchasePackageUomCode:
            supplied.purchasePackageUomCode
            || supplied.orderUomCode
            || detail.purchasePackageUomCode,
          purchasePackageQty:
            supplied.purchasePackageQty
            ?? supplied.orderQty
            ?? detail.purchasePackageQty,
          conversionFactor:
            supplied.conversionFactor
            ?? supplied.kgPerLot
            ?? detail.conversionFactor,
        };
      }),
    };
    return exports.consolidateToPO(req, res, next);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
    return next(e);
  }

  /* istanbul ignore next -- retained temporarily as unreachable legacy source */
  try {
    const input = bodyObject(req.body), pr = await prisma.purchaseRequisition.findFirst({ where: { prNumber: req.params.prNumber, isDeleted: false }, include: { details: { where: { isDeleted: false } } } });
    if (!pr) return res.status(404).json({ message: "Purchase Requisition tidak ditemukan." });
    if (!["Approved", "Partially Ordered"].includes(pr.status)) return res.status(409).json({ message: "PR harus Approved sebelum dipindahkan ke PO." });
    const requestedTargetPo = input.targetPoNumber || input.existingPoNumber || input.poNumber || null;
    const result = await prisma.$transaction(async (tx) => {
      const requestedDetailIds = Array.isArray(input.detailIds)
        ? input.detailIds.map(String)
        : Array.isArray(input.prDetailIds)
          ? input.prDetailIds.map(String)
          : Array.isArray(input.lines)
            ? input.lines.map((line) => String(line?.prDetailId || line?.id || "")).filter(Boolean)
            : [];
      const outstanding = pr.details.filter((detail) => num(detail.qty) > num(detail.orderedQty)
        && (!requestedDetailIds.length || requestedDetailIds.includes(detail.id)));
      if (!outstanding.length) throw Object.assign(new Error(requestedDetailIds.length ? "Detail PR terpilih tidak ditemukan atau sudah dipesan." : "Seluruh detail PR sudah dipesan."), { statusCode: requestedDetailIds.length ? 400 : 409 });
      const confirmedSuppliers = [...new Set(outstanding.map((detail) => detail.confirmedSupplierCode).filter(Boolean))];
      if (!input.supplierCode && confirmedSuppliers.length > 1) {
        throw Object.assign(new Error("Detail terpilih memiliki supplier Purchasing berbeda. Gunakan konsolidasi lintas PR agar PO otomatis dipisah per supplier."), { statusCode: 409 });
      }

      const partCodes = [...new Set(outstanding.map((detail) => detail.partCode).filter(Boolean))];
      const parts = partCodes.length ? await tx.part.findMany({
        where: { partCode: { in: partCodes }, isDeleted: false },
        select: { id: true, partCode: true, rawType: true, itemType: true, partBases: true },
      }) : [];
      const partByCode = new Map(parts.map((part) => [normalize(part.partCode), part]));
      const preparedRows = [];
      for (const detail of outstanding) {
        const sourceQty = num(detail.qty) - num(detail.orderedQty);
        const part = partByCode.get(normalize(detail.partCode));
        const category = normalizeCategory(detail.procurementCategory) || (detail.materialCode ? "MATERIAL" : classifyPart(part));
        const hasPackagePlan = category === "MATERIAL"
          && num(detail.conversionFactor ?? detail.kgPerLot) > 0
          && Boolean(detail.purchasePackageUomCode || detail.lotCount);
        const packageFactor = num(detail.conversionFactor ?? detail.kgPerLot);
        const conversion = hasPackagePlan
          ? {
              factor: 1 / packageFactor,
              uomCode: detail.purchasePackageUomCode || "LOT",
              source: `${packageFactor} ${detail.conversionUomCode || detail.uomCode || "KG"}/${detail.purchasePackageUomCode || "LOT"}`,
            }
          : category === "MATERIAL"
            ? await rawMaterialConversion(part, detail.uomCode, tx)
            : { factor: 1, uomCode: detail.uomCode, source: null };
        const poQty = sourceQty * conversion.factor;
        const sourceAmount = num(detail.estimatedPrice) * sourceQty;
        const unitPrice = poQty > 0 ? sourceAmount / poQty : 0;
        preparedRows.push({
          sourceQty,
          conversionSource: conversion.source,
          data: {
            prDetailId: detail.id,
            productId: detail.productId,
            partCode: detail.partCode,
            partNumber: detail.partNumber,
            partName: detail.partName,
            materialId: detail.materialId,
            materialCode: detail.materialCode,
            materialName: detail.materialName,
            materialType: detail.materialType,
            description: detail.description,
            spec: detail.spec,
            thickness: detail.thickness,
            width: detail.width,
            CSP: detail.CSP,
             qty: poQty,
             uomCode: conversion.uomCode,
            purchasePackageQty: hasPackagePlan ? poQty : null,
            purchasePackageUomCode: hasPackagePlan ? conversion.uomCode : null,
            conversionUomCode: hasPackagePlan ? (detail.conversionUomCode || detail.uomCode) : null,
            conversionFactor: hasPackagePlan ? packageFactor : null,
            convertedPurchaseQty: hasPackagePlan ? poQty * packageFactor : null,
            unitPrice,
            totalAmount: sourceAmount,
            deliveryDate: date(input.deliveryDate) || pr.requiredDate,
            notes: conversion.source ? `${detail.notes || ""}${detail.notes ? "; " : ""}${hasPackagePlan ? "Purchased by material form" : "Converted to KG"} via ${conversion.source}; source ${sourceQty} ${detail.uomCode || "unit"}` : detail.notes,
          },
        });
      }

      let po;
      if (requestedTargetPo) {
        const target = await tx.purchaseOrder.findFirst({ where: { poNumber: requestedTargetPo, isDeleted: false } });
        if (!target) throw Object.assign(new Error(`PO tujuan ${requestedTargetPo} tidak ditemukan.`), { statusCode: 404 });
        if (target.status !== "Draft") throw Object.assign(new Error("Konsolidasi PR hanya dapat dilakukan ke PO berstatus Draft."), { statusCode: 409 });
        const requestedSupplier = input.supplierCode
          || outstanding.find((detail) => detail.confirmedSupplierCode)?.confirmedSupplierCode
          || outstanding.find((detail) => detail.proposedSupplierCode)?.proposedSupplierCode
          || outstanding.find((detail) => detail.preferredSupplier)?.preferredSupplier
          || null;
        const requestedVendor = input.vendorCode || pr.details.find((detail) => detail.preferredVendor)?.preferredVendor || null;
        if (requestedSupplier && target.supplierCode && requestedSupplier !== target.supplierCode) throw Object.assign(new Error("Supplier PR berbeda dengan supplier PO tujuan."), { statusCode: 409 });
        if (requestedVendor && target.vendorCode && requestedVendor !== target.vendorCode) throw Object.assign(new Error("Vendor PR berbeda dengan vendor PO tujuan."), { statusCode: 409 });
        if (input.currencyCode && target.currencyCode !== input.currencyCode) throw Object.assign(new Error("Currency PR berbeda dengan currency PO tujuan."), { statusCode: 409 });
        const lastLine = await tx.purchaseOrderDetail.findFirst({ where: { poNumber: target.poNumber }, orderBy: { lineNumber: "desc" }, select: { lineNumber: true } });
        await tx.purchaseOrderDetail.createMany({ data: preparedRows.map((row, index) => ({ ...row.data, poNumber: target.poNumber, lineNumber: num(lastLine?.lineNumber) + index + 1 })) });
        await tx.purchaseOrderPR.upsert({
          where: { poNumber_prNumber: { poNumber: target.poNumber, prNumber: pr.prNumber } },
          create: { poNumber: target.poNumber, prNumber: pr.prNumber },
          update: {},
        });
        po = await tx.purchaseOrder.update({
          where: { poNumber: target.poNumber },
          data: {
            totalAmount: { increment: preparedRows.reduce((sum, row) => sum + row.data.totalAmount, 0) },
            ...(!target.supplierCode && requestedSupplier ? { supplierCode: requestedSupplier, supplierName: input.supplierName || target.supplierName } : {}),
            ...(!target.vendorCode && requestedVendor ? { vendorCode: requestedVendor, vendorName: input.vendorName || target.vendorName } : {}),
          },
          include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } }, purchaseRequisitions: true },
        });
      } else {
        const supplierCode = input.supplierCode
          || outstanding.find((detail) => detail.confirmedSupplierCode)?.confirmedSupplierCode
          || outstanding.find((detail) => detail.proposedSupplierCode)?.proposedSupplierCode
          || outstanding.find((detail) => detail.preferredSupplier)?.preferredSupplier;
        if (!supplierCode && !input.vendorCode) throw Object.assign(new Error("supplierCode atau vendorCode wajib diisi."), { statusCode: 400 });
        const poNumber = await generatePONumber(pr.poType, tx, input.poNumberPrefix, supplierCode || input.vendorCode);
        po = await tx.purchaseOrder.create({
          data: {
            poNumber,
            poDate: new Date(),
            supplierCode: supplierCode || null,
            supplierName: input.supplierName || null,
            vendorCode: input.vendorCode || null,
            vendorName: input.vendorName || null,
            deliveryDate: date(input.deliveryDate) || pr.requiredDate,
            poType: pr.poType,
            currencyCode: input.currencyCode || "IDR",
            status: "Draft",
            totalAmount: preparedRows.reduce((sum, row) => sum + row.data.totalAmount, 0),
            notes: input.notes || `Converted from ${pr.prNumber}`,
            createdBy: req.user?.username || req.user?.email || null,
            purchaseRequisitions: { create: { prNumber: pr.prNumber } },
            details: { create: preparedRows.map((row, index) => ({ ...row.data, lineNumber: index + 1 })) },
          },
          include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } }, purchaseRequisitions: true },
        });
      }
      for (const row of preparedRows) await tx.purchaseRequisitionDetail.update({ where: { id: row.data.prDetailId }, data: { orderedQty: { increment: row.sourceQty } } });
      const refreshedDetails = await tx.purchaseRequisitionDetail.findMany({ where: { prNumber: pr.prNumber, isDeleted: false }, select: { qty: true, orderedQty: true } });
      const hasOutstanding = refreshedDetails.some((detail) => num(detail.qty) > num(detail.orderedQty));
      await tx.purchaseRequisition.update({ where: { prNumber: pr.prNumber }, data: { status: hasOutstanding ? "Partially Ordered" : "Completed", convertedToPO: po.poNumber } });
      return {
        ...po,
        consolidated: Boolean(requestedTargetPo),
        prStatus: hasOutstanding ? "Partially Ordered" : "Completed",
        processedDetailIds: preparedRows.map((row) => row.data.prDetailId),
        conversionSummary: preparedRows.filter((row) => row.conversionSource).map((row) => ({ prDetailId: row.data.prDetailId, qty: row.data.qty, uomCode: row.data.uomCode, source: row.conversionSource })),
      };
    });
    res.status(requestedTargetPo ? 200 : 201).json(result);
  } catch (e) { if (e.statusCode) return res.status(e.statusCode).json({ message: e.message }); next(e); }
};
