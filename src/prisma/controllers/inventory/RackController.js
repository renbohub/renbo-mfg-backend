const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { convertNumericFields } = require("../../utils/numericConverter");
const { start } = require("../production/ManufacturingOrderController");
const { parseFilter } = require("../../utils/parseFilter");

// ============================================
// HELPERS
// ============================================
const parseBoolean = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
  }
  return value;
};

const normalizeRackPayload = (payload = {}) => {
  const normalized = convertNumericFields(payload, ["capacity"]);
  if (normalized.isActive !== undefined) {
    normalized.isActive = parseBoolean(normalized.isActive);
  }
  return normalized;
};

const normalizeExcludeRackCodes = (excludeFilter) => {
  let rawCodes = [];

  if (!excludeFilter) {
    return [];
  }

  if (typeof excludeFilter === "string") {
    rawCodes = [excludeFilter];
  } else if (Array.isArray(excludeFilter)) {
    rawCodes = excludeFilter;
  } else if (
    typeof excludeFilter === "object" &&
    Array.isArray(excludeFilter.in)
  ) {
    rawCodes = excludeFilter.in;
  }

  const exactCodes = new Set();
  const prefixCodes = new Set();

  rawCodes
    .map((code) => String(code || "").trim())
    .filter(Boolean)
    .forEach((code) => {
      const upper = code.toUpperCase();

      exactCodes.add(upper);
      prefixCodes.add(upper);

      if (upper.startsWith("RACK-")) {
        const noPrefix = upper.slice(5);
        if (noPrefix) {
          exactCodes.add(noPrefix);
          prefixCodes.add(noPrefix);
        }
      } else {
        const prefixed = `RACK-${upper}`;
        exactCodes.add(prefixed);
        prefixCodes.add(prefixed);
      }
    });

  return {
    exactCodes: Array.from(exactCodes),
    prefixCodes: Array.from(prefixCodes),
  };
};

const normalizeOnlyStartWithPrefixes = (onlyStartWithFilter) => {
  if (!onlyStartWithFilter) {
    return [];
  }

  let rawPrefixes = [];
  if (typeof onlyStartWithFilter === "string") {
    rawPrefixes = [onlyStartWithFilter];
  } else if (Array.isArray(onlyStartWithFilter)) {
    rawPrefixes = onlyStartWithFilter;
  } else if (
    typeof onlyStartWithFilter === "object" &&
    Array.isArray(onlyStartWithFilter.in)
  ) {
    rawPrefixes = onlyStartWithFilter.in;
  }

  const normalizedPrefixes = new Set();

  rawPrefixes
    .map((prefix) => String(prefix || "").trim())
    .filter(Boolean)
    .forEach((prefix) => {
      const upper = prefix.toUpperCase();
      if (upper.startsWith("RACK-")) {
        normalizedPrefixes.add(upper);
      } else {
        normalizedPrefixes.add(`RACK-${upper}`);
      }
    });

  return Array.from(normalizedPrefixes);
};

const SPECIAL_RACK_PREFIXES = ["RACK-SCRAP", "RACK-REJECT", "RACK-REWORK"];

const buildExcludeSpecialRackCondition = () => ({
  NOT: {
    OR: SPECIAL_RACK_PREFIXES.map((prefix) => ({
      rackCode: { startsWith: prefix, mode: "insensitive" },
    })),
  },
});

const buildOnlySpecialRackCondition = () => ({
  OR: SPECIAL_RACK_PREFIXES.map((prefix) => ({
    rackCode: { startsWith: prefix, mode: "insensitive" },
  })),
});

const buildSpecialRackCondition = (typeFilter = null) => {
  const VALID_TYPES = {
    SCRAP: "RACK-SCRAP",
    REJECT: "RACK-REJECT",
    REWORK: "RACK-REWORK",
  };

  if (typeFilter) {
    const type = String(typeFilter).trim().toUpperCase();
    if (VALID_TYPES[type]) {
      const prefix = VALID_TYPES[type];
      return {
        rackCode: { startsWith: prefix, mode: "insensitive" },
      };
    }
  }

  // Default: all three special prefixes
  return {
    OR: SPECIAL_RACK_PREFIXES.map((prefix) => ({
      rackCode: { startsWith: prefix, mode: "insensitive" },
    })),
  };
};

const shouldIncludeSpecialRacks = (value) => value === "true" || value === true;

const applySpecialRackFilter = (where, includeSpecial) => {
  if (shouldIncludeSpecialRacks(includeSpecial)) {
    return where;
  }

  where.AND = [...(where.AND || []), buildExcludeSpecialRackCondition()];
  return where;
};

// ============================================
// GENERATE RACK CODE
// ============================================
exports.generateCode = async (req, res, next) => {
  try {
    const lastRack = await prisma.rack.findFirst({
      orderBy: { rackCode: "desc" },
      select: { rackCode: true },
    });

    let nextNumber = 1;
    if (lastRack) {
      const match = lastRack.rackCode.match(/^RACK-(\d+)$/);
      if (match) {
        nextNumber = parseInt(match[1]) + 1;
      }
    }

    const rackCode = `RACK-${String(nextNumber).padStart(3, "0")}`;
    res.json({ rackCode });
  } catch (e) {
    next(e);
  }
};

// ============================================
// LIST RACKS
// ============================================
exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      isActive,
      zone,
      page = 1,
      limit = 20,
      includeSpecial,
    } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    if (isActive !== undefined) {
      where.isActive = parseBoolean(isActive);
    }

    applySpecialRackFilter(where, includeSpecial);

    if (zone) {
      where.zone = zone;
    }

    if (q) {
      where.OR = [
        { rackCode: { contains: q, mode: "insensitive" } },
        { rackName: { contains: q, mode: "insensitive" } },
        { zone: { contains: q, mode: "insensitive" } },
        { notes: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query);
    const pageNumber = Number(page);
    const limitNumber = Number(limit);
    const skip = (pageNumber - 1) * limitNumber;

    const [items, total] = await Promise.all([
      prisma.rack.findMany({
        where,
        orderBy,
        skip,
        take: limitNumber,
      }),
      prisma.rack.count({ where }),
    ]);

    res.json({
      items: items.map(mapDoc),
      total,
      page: pageNumber,
      limit: limitNumber,
    });
  } catch (e) {
    next(e);
  }
};

// ============================================
// LIST SPECIAL RACKS
// ============================================

exports.listSpecial = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      isActive,
      zone,
      type,
      page = 1,
      limit = 20,
    } = req.query;
    const where = {
      AND: [buildSpecialRackCondition(type)],
    };

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    if (isActive !== undefined) {
      where.isActive = parseBoolean(isActive);
    }

    if (zone) {
      where.zone = zone;
    }

    if (q) {
      where.OR = [
        { rackCode: { contains: q, mode: "insensitive" } },
        { rackName: { contains: q, mode: "insensitive" } },
        { zone: { contains: q, mode: "insensitive" } },
        { notes: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query);
    const pageNumber = Number(page);
    const limitNumber = Number(limit);
    const skip = (pageNumber - 1) * limitNumber;

    const [items, total] = await Promise.all([
      prisma.rack.findMany({
        where,
        orderBy,
        skip,
        take: limitNumber,
      }),
      prisma.rack.count({ where }),
    ]);

    res.json({
      items: items.map(mapDoc),
      total,
      page: pageNumber,
      limit: limitNumber,
    });
  } catch (e) {
    next(e);
  }
};

// ============================================
// GET RACK BY CODE
// ============================================
exports.get = async (req, res, next) => {
  try {
    const { code } = req.params;

    const rack = await prisma.rack.findUnique({
      where: { rackCode: code },
    });

    if (!rack) {
      return res.status(404).json({ message: "Rack tidak ditemukan" });
    }

    res.json(mapDoc(rack));
  } catch (e) {
    next(e);
  }
};

// ============================================
// CREATE RACK
// ============================================
exports.create = async (req, res, next) => {
  try {
    const data = normalizeRackPayload(req.body);

    const rack = await prisma.rack.create({
      data,
    });

    res.status(201).json(mapDoc(rack));
  } catch (e) {
    next(e);
  }
};

// ============================================
// UPDATE RACK
// ============================================
exports.update = async (req, res, next) => {
  try {
    const { code } = req.params;
    const data = normalizeRackPayload(req.body);

    const rack = await prisma.rack.update({
      where: { rackCode: code },
      data,
    });

    res.json(mapDoc(rack));
  } catch (e) {
    next(e);
  }
};

// ============================================
// SOFT DELETE RACK
// ============================================
exports.remove = async (req, res, next) => {
  try {
    const { code } = req.params;

    await prisma.rack.update({
      where: { rackCode: code },
      data: { isDeleted: true },
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
};

// ============================================
// BULK CREATE RACKS
// ============================================
exports.bulkCreate = async (req, res, next) => {
  try {
    const { racks } = req.body;

    if (!Array.isArray(racks) || racks.length === 0) {
      return res.status(400).json({ message: "Racks harus berupa array" });
    }

    const createdRacks = await prisma.$transaction(
      racks.map((rack) =>
        prisma.rack.create({
          data: normalizeRackPayload(rack),
        }),
      ),
    );

    res.status(201).json({
      items: createdRacks.map(mapDoc),
      total: createdRacks.length,
    });
  } catch (e) {
    next(e);
  }
};

// ============================================
// BULK SOFT DELETE
// ============================================
exports.bulkRemove = async (req, res, next) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "IDs harus berupa array" });
    }

    await prisma.rack.updateMany({
      where: { id: { in: ids } },
      data: { isDeleted: true },
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
};

// ============================================
// GET ALL RACK CODES
// ============================================
exports.allCodes = async (req, res, next) => {
  try {
    const { isActive, includeSpecial } = req.query;
    const where = { isDeleted: false };

    if (isActive !== undefined) {
      where.isActive = parseBoolean(isActive);
    }

    applySpecialRackFilter(where, includeSpecial);

    const codes = await prisma.rack.findMany({
      where,
      select: {
        rackCode: true,
        rackName: true,
        zone: true,
      },
      orderBy: { rackCode: "asc" },
    });

    res.json(codes.map(mapDoc));
  } catch (e) {
    next(e);
  }
};

// ============================================
// GET ALL RACK CODES WITH SPECIAL PREFIXES
// ============================================
exports.specialCodes = async (req, res, next) => {
  try {
    const { isActive, type } = req.query;
    const where = {
      isDeleted: false,
      ...buildSpecialRackCondition(type),
    };

    if (isActive !== undefined) {
      where.isActive = parseBoolean(isActive);
    }

    const codes = await prisma.rack.findMany({
      where,
      select: {
        rackCode: true,
        rackName: true,
        zone: true,
      },
      orderBy: { rackCode: "asc" },
    });
    res.json(codes.map(mapDoc));
  } catch (e) {
    next(e);
  }
};
