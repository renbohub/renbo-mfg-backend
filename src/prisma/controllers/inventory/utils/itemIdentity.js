const IDENTITY_REQUIRED_MESSAGE =
  "Isi minimal salah satu identitas item: material(materialId/materialCode), part(partId/partCode/partNumber), product(productId/productCode), description, atau kombinasi spec+thickness+width+CSP";

const normalizeText = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeNumber = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeLegacyToken = (value) => {
  const normalized = normalizeText(value);
  return normalized && normalized !== "-" ? normalized : null;
};

const parseLegacySpecIdentity = (value) => {
  const normalized = normalizeText(value);
  if (!normalized) return null;

  const match = normalized.match(
    /^SPEC\|([^|]*)\|W\|([^|]*)\|T\|([^|]*)\|CSP\|([^|]*)$/i,
  );
  if (!match) return null;

  return {
    spec: normalizeLegacyToken(match[1]),
    width: normalizeNumber(match[2]),
    thickness: normalizeNumber(match[3]),
    CSP: normalizeLegacyToken(match[4]),
  };
};

const pickLegacyValue = (explicitValue, legacyValue) =>
  explicitValue !== null && explicitValue !== undefined
    ? explicitValue
    : legacyValue ?? null;

const hasSpecIdentityFields = (identity = {}) =>
  Boolean(
    identity.spec ||
      (identity.thickness !== undefined && identity.thickness !== null) ||
      (identity.width !== undefined && identity.width !== null) ||
      identity.CSP,
  );

const buildSpecIdentityWhere = (identity = {}) =>
  hasSpecIdentityFields(identity)
    ? {
        spec: identity.spec || null,
        thickness: identity.thickness ?? null,
        width: identity.width ?? null,
        CSP: identity.CSP || null,
      }
    : {};

const pickPreferredPartBase = (partBases = []) => {
  if (!Array.isArray(partBases) || partBases.length === 0) return null;

  return (
    partBases.find((base) => String(base.baseOn || "").toLowerCase() === "actual") ||
    partBases.find((base) => String(base.baseOn || "").toLowerCase() === "qtn") ||
    partBases[0]
  );
};

const applyPartSnapshotIdentity = (identity = {}, part = {}) => {
  if (!part) return identity;

  const base = pickPreferredPartBase(part.partBases);

  return {
    ...identity,
    partCode: identity.partCode || part.partCode || null,
    partNumber: identity.partNumber || part.partNumber || null,
    partName: identity.partName || part.partName || null,
    spec: identity.spec || part.material?.spec || null,
    thickness: pickLegacyValue(identity.thickness, base?.thickness),
    width: pickLegacyValue(identity.width, base?.width),
    CSP: identity.CSP || base?.CSP || null,
  };
};

const sanitizeItemIdentityFields = (item = {}) => {
  if (!item || typeof item !== "object") return item;

  const legacyFromSpec = parseLegacySpecIdentity(item.spec);
  const legacyFromDescription = parseLegacySpecIdentity(item.description);
  const legacyIdentity = legacyFromSpec || legacyFromDescription;
  if (!legacyIdentity) return item;

  return {
    ...item,
    description: legacyFromDescription ? null : item.description,
    spec: legacyFromSpec
      ? legacyIdentity.spec
      : pickLegacyValue(normalizeText(item.spec), legacyIdentity.spec),
    thickness: pickLegacyValue(item.thickness, legacyIdentity.thickness),
    width: pickLegacyValue(item.width, legacyIdentity.width),
    CSP: pickLegacyValue(normalizeText(item.CSP), legacyIdentity.CSP),
  };
};

const resolveIdentityCore = (source = {}) => {
  const materialId = normalizeText(source.materialId) || normalizeText(source.material?.id);
  const materialCode = normalizeText(source.materialCode) || normalizeText(source.material?.materialCode);
  const materialName = normalizeText(source.materialName) || normalizeText(source.material?.materialName);
  const materialType = normalizeText(source.materialType) || normalizeText(source.material?.materialType);
  const partCode = normalizeText(source.partCode) || normalizeText(source.part?.partCode);
  const partId = normalizeText(source.partId) || normalizeText(source.part?.id);
  const partNumber = normalizeText(source.partNumber) || normalizeText(source.part?.partNumber);
  const productId = normalizeText(source.productId) || normalizeText(source.product?.id);
  const productCode =
    normalizeText(source.productCode) || normalizeText(source.product?.productCode);
  const rawDescription = normalizeText(source.description);
  const productDescription = normalizeText(source.product?.description);
  const rawSpec = normalizeText(source.spec);
  const legacyFromDescription = parseLegacySpecIdentity(rawDescription);
  const legacyFromProductDescription = parseLegacySpecIdentity(productDescription);
  const legacyFromSpec = parseLegacySpecIdentity(rawSpec);
  const legacyIdentity =
    legacyFromSpec || legacyFromDescription || legacyFromProductDescription;
  const description =
    (legacyFromDescription ? null : rawDescription) ||
    (legacyFromProductDescription ? null : productDescription);
  const spec = (legacyFromSpec ? legacyFromSpec.spec : rawSpec) || legacyIdentity?.spec || null;
  const thickness = normalizeNumber(source.thickness);
  const width = normalizeNumber(source.width);
  const csp = normalizeText(source.CSP || source.csp);
  const resolvedThickness = pickLegacyValue(thickness, legacyIdentity?.thickness);
  const resolvedWidth = pickLegacyValue(width, legacyIdentity?.width);
  const resolvedCsp = csp || legacyIdentity?.CSP || null;

  return {
    materialId,
    materialCode,
    materialName,
    materialType,
    partCode,
    partId,
    partNumber,
    productId,
    productCode,
    description,
    spec,
    thickness: resolvedThickness,
    width: resolvedWidth,
    CSP: resolvedCsp,
    partName: normalizeText(source.partName) || normalizeText(source.part?.partName),
  };
};

const hasItemIdentity = (identity = {}) =>
  Boolean(
    identity.materialCode ||
      identity.materialId ||
      identity.partCode ||
      identity.partNumber ||
      identity.productId ||
      identity.description ||
      identity.spec ||
      (identity.thickness !== undefined && identity.thickness !== null) ||
      (identity.width !== undefined && identity.width !== null) ||
      identity.CSP,
  );

const buildIdentityWhere = (identity = {}) => {
  if (identity.materialCode || identity.materialId) {
    return {
      materialCode: identity.materialCode || null,
      ...(identity.materialId ? { materialId: identity.materialId } : {}),
      partCode: null,
      productId: null,
      description: null,
      partNumber: null,
      ...buildSpecIdentityWhere(identity),
    };
  }
  if (identity.partCode) {
    return {
      partCode: identity.partCode,
      ...buildSpecIdentityWhere(identity),
    };
  }
  if (identity.partNumber) {
    return {
      partCode: null,
      productId: null,
      description: null,
      ...buildSpecIdentityWhere(identity),
      partNumber: identity.partNumber,
    };
  }
  if (identity.productId) {
    return {
      partCode: null,
      productId: identity.productId,
      ...buildSpecIdentityWhere(identity),
    };
  }
  if (identity.description) {
    return {
      partCode: null,
      productId: null,
      description: identity.description,
      ...buildSpecIdentityWhere(identity),
      partNumber: null,
    };
  }

  const hasSpecIdentity = hasSpecIdentityFields(identity);
  if (hasSpecIdentity) {
    return {
      partCode: null,
      productId: null,
      description: null,
      spec: identity.spec || null,
      thickness: identity.thickness ?? null,
      width: identity.width ?? null,
      CSP: identity.CSP || null,
      partNumber: null,
    };
  }

  return {
    partCode: null,
    productId: null,
    description: null,
    spec: null,
    thickness: null,
    width: null,
    CSP: null,
    partNumber: null,
  };
};

const buildIdentityKey = (identity = {}) =>
  [
    normalizeText(identity.materialCode) || "",
    normalizeText(identity.materialId) || "",
    normalizeText(identity.partCode) || "",
    normalizeText(identity.partNumber) || "",
    normalizeText(identity.productId) || "",
    normalizeText(identity.description) || "",
    normalizeText(identity.spec) || "",
    identity.thickness === null || identity.thickness === undefined
      ? ""
      : String(identity.thickness),
    identity.width === null || identity.width === undefined
      ? ""
      : String(identity.width),
    normalizeText(identity.CSP) || "",
  ].join("|");

const resolveItemIdentity = (source = {}) => resolveIdentityCore(source);

const resolveItemIdentityInput = async (db, source = {}, options = {}) => {
  let identity = resolveIdentityCore(source);
  const shouldEnrichPartSnapshot = options.enrichPartSnapshot === true;

  if (identity.materialId || identity.materialCode) {
    const material = await db.material.findFirst({
      where: {
        isDeleted: false,
        ...(identity.materialId ? { id: identity.materialId } : { materialCode: identity.materialCode }),
      },
      select: {
        id: true,
        materialCode: true,
        materialName: true,
        materialType: true,
        spec: true,
        thickness: true,
        width: true,
        CSP: true,
      },
    });
    if (material) {
      identity = {
        ...identity,
        materialId: material.id,
        materialCode: material.materialCode,
        materialName: identity.materialName || material.materialName || null,
        materialType: identity.materialType || material.materialType || null,
        spec: identity.spec || material.spec || null,
        thickness: identity.thickness ?? material.thickness ?? null,
        width: identity.width ?? material.width ?? null,
        CSP: identity.CSP || material.CSP || null,
      };
    }
  }

  if (!identity.partCode && identity.partId) {
    const part = await db.part.findFirst({
      where: { id: identity.partId, isDeleted: false },
      select: {
        partCode: true,
        partNumber: true,
        partName: true,
        material: { select: { spec: true } },
        partBases: {
          select: {
            baseOn: true,
            thickness: true,
            width: true,
            CSP: true,
          },
        },
      },
    });
    if (part?.partCode) {
      identity = shouldEnrichPartSnapshot
        ? applyPartSnapshotIdentity(identity, part)
        : { ...identity, partCode: part.partCode };
    }
  }

  if (
    shouldEnrichPartSnapshot &&
    identity.partCode &&
    !hasSpecIdentityFields(identity)
  ) {
    const part = await db.part.findFirst({
      where: { partCode: identity.partCode, isDeleted: false },
      select: {
        partCode: true,
        partNumber: true,
        partName: true,
        material: { select: { spec: true } },
        partBases: {
          select: {
            baseOn: true,
            thickness: true,
            width: true,
            CSP: true,
          },
        },
      },
    });
    if (part) identity = applyPartSnapshotIdentity(identity, part);
  }

  if (!identity.productId && identity.productCode) {
    const product = await db.product.findFirst({
      where: { productCode: identity.productCode, isDeleted: false },
      select: { id: true },
    });
    if (product?.id) identity.productId = product.id;
  }

  return identity;
};

module.exports = {
  IDENTITY_REQUIRED_MESSAGE,
  normalizeText,
  normalizeNumber,
  parseLegacySpecIdentity,
  sanitizeItemIdentityFields,
  resolveItemIdentity,
  resolveItemIdentityInput,
  hasItemIdentity,
  buildIdentityWhere,
  buildIdentityKey,
};
