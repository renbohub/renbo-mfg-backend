// Share the same part scope between PR lookup and transaction validation.
function prPartWhere(category) {
  const group = String(category || "").trim().toUpperCase();
  if (group === "VENDOR_PROCESS") {
    return { isDeleted: false, OR: [
      { procurementType: { equals: "SUBCONTRACT", mode: "insensitive" } },
      { category: { equals: "Vendor", mode: "insensitive" } },
      { mbomDetails: { some: {
        isDeleted: false, mbomHeader: { isDeleted: false },
        OR: [{ category: "Vendor" }, { mbomProcesses: { some: { isDeleted: false, routingMode: "VENDOR" } } }],
      } } },
    ] };
  }
  if (["PURCHASE_PART", "UNIVERSAL_PURCHASE_PART"].includes(group)) {
    return { isDeleted: false, itemType: "RAW", rawType: "PURCHASE_PART", AND: [
      { OR: [{ procurementType: null }, { procurementType: { not: "SUBCONTRACT", mode: "insensitive" } }] },
      ...(group === "PURCHASE_PART"
        ? [{ partNumber: { not: null } }, { partNumber: { not: "" } }]
        : [{ OR: [{ partNumber: null }, { partNumber: "" }] }]),
    ] };
  }
  return null;
}

module.exports = { prPartWhere };
