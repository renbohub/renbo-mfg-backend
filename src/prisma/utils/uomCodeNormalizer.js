function normalizeOptionalCode(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return value;
  const trimmed = value.trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

async function buildCanonicalUomMap(db, codes = []) {
  const uniqueCodes = [
    ...new Set(codes.map(normalizeOptionalCode).filter(Boolean)),
  ];

  if (uniqueCodes.length === 0) return new Map();

  const uoms = await db.uom.findMany({
    where: {
      OR: uniqueCodes.map((uomCode) => ({
        uomCode: { equals: uomCode, mode: "insensitive" },
      })),
      isDeleted: false,
    },
    select: { uomCode: true },
  });

  const canonicalByLowerCode = new Map(
    uoms.map((uom) => [uom.uomCode.toLowerCase(), uom.uomCode])
  );
  const missingCodes = uniqueCodes.filter(
    (uomCode) => !canonicalByLowerCode.has(uomCode.toLowerCase())
  );

  if (missingCodes.length > 0) {
    const error = new Error(
      `UOM tidak valid atau belum terdaftar di master UOM: ${missingCodes.join(", ")}`
    );
    error.statusCode = 400;
    error.code = "INVALID_UOM";
    throw error;
  }

  return canonicalByLowerCode;
}

async function normalizeUomCode(db, value) {
  const normalizedCode = normalizeOptionalCode(value);
  if (!normalizedCode) return null;

  const canonicalByLowerCode = await buildCanonicalUomMap(db, [normalizedCode]);
  return canonicalByLowerCode.get(normalizedCode.toLowerCase());
}

async function normalizeDetailUomCodes(db, details = []) {
  if (!Array.isArray(details)) return details;

  const normalizedDetails = details.map((detail) => ({
    ...detail,
    uomCode: normalizeOptionalCode(detail.uomCode),
  }));
  const canonicalByLowerCode = await buildCanonicalUomMap(
    db,
    normalizedDetails.map((detail) => detail.uomCode)
  );

  return normalizedDetails.map((detail) => ({
    ...detail,
    uomCode: detail.uomCode
      ? canonicalByLowerCode.get(detail.uomCode.toLowerCase())
      : null,
  }));
}

module.exports = {
  normalizeOptionalCode,
  normalizeUomCode,
  normalizeDetailUomCodes,
};
