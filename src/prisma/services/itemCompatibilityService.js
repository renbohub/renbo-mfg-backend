// Resolves the new item contract without rewriting legacy Part data.
const LEGACY_ITEM_CLASS = {
  FG: "FG",
  WIP: "SFG",
};

function deriveItemClass(part = {}) {
  if (part.itemClass) return { value: part.itemClass, source: "itemClass" };
  if (part.itemType === "RAW") {
    return {
      value: part.rawType === "MATERIAL" ? "RAW_MATERIAL" : "COMPONENT",
      source: "legacy:itemType/rawType",
    };
  }
  return { value: LEGACY_ITEM_CLASS[part.itemType] || "COMPONENT", source: "legacy:itemType" };
}

function deriveProcurementType(part = {}) {
  if (part.procurementType) return { value: part.procurementType, source: "procurementType" };
  if (part.itemType === "RAW") return { value: "BUY", source: "legacy:itemType" };
  if (part.canManufacture && part.canPurchase) return { value: "MAKE_OR_BUY", source: "legacy:permissions" };
  if (part.canManufacture) return { value: "MAKE", source: "legacy:permissions" };
  if (part.canPurchase) return { value: "BUY", source: "legacy:permissions" };
  return { value: "MAKE", source: "default" };
}

function resolveItemCompatibility(part = {}) {
  const itemClass = deriveItemClass(part);
  const procurementType = deriveProcurementType(part);
  const baseUomCode = part.baseUomCode || part.stockUomCode || part.productionUomCode || part.salesUomCode || null;
  return {
    partId: part.id,
    partCode: part.partCode,
    itemClass,
    procurementType,
    uom: {
      base: baseUomCode,
      purchase: part.purchaseUomCode || baseUomCode,
      stock: part.stockUomCode || baseUomCode,
      production: part.productionUomCode || baseUomCode,
      sales: part.salesUomCode || baseUomCode,
      source: baseUomCode ? "normalized" : "legacy-unavailable",
    },
    planning: {
      policy: part.planningPolicy || "MTO",
      safetyStock: part.safetyStock ?? part.bufferStock ?? 0,
      safetyStockSource: part.safetyStock != null ? "safetyStock" : "legacy:bufferStock",
    },
  };
}

module.exports = { resolveItemCompatibility };
