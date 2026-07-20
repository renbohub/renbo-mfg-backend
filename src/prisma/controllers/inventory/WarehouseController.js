const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { convertNumericFields } = require("../../utils/numericConverter");

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

const normalizeWarehousePayload = (payload = {}) => {
  const normalized = convertNumericFields(payload, ["capacity"]);
  if (normalized.isActive !== undefined) {
    normalized.isActive = parseBoolean(normalized.isActive);
  }
  return normalized;
};

// ============================================
// GENERATE WAREHOUSE CODE
// ============================================
exports.generateCode = async (req, res, next) => {
  try {
    const lastWarehouse = await prisma.warehouse.findFirst({
      orderBy: { warehouseCode: "desc" },
      select: { warehouseCode: true },
    });

    let nextNumber = 1;
    if (lastWarehouse) {
      const lastCode = lastWarehouse.warehouseCode;
      const match = lastCode.match(/^WH-(\d+)$/);
      if (match) {
        nextNumber = parseInt(match[1]) + 1;
      }
    }

    const warehouseCode = `WH-${String(nextNumber).padStart(3, "0")}`;
    res.json({ warehouseCode });
  } catch (e) {
    next(e);
  }
};

// ============================================
// LIST WAREHOUSES
// ============================================
exports.list = async (req, res, next) => {
  try {
    const { q, isDeleted, isActive, type, page = 1, limit = 20 } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    if (isActive !== undefined) {
      where.isActive = parseBoolean(isActive);
    }

    if (type) {
      where.type = type;
    }

    if (q) {
      where.OR = [
        { warehouseCode: { contains: q, mode: "insensitive" } },
        { warehouseName: { contains: q, mode: "insensitive" } },
        { location: { contains: q, mode: "insensitive" } },
        { notes: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query);
    const pageNumber = Number(page);
    const limitNumber = Number(limit);
    const skip = (pageNumber - 1) * limitNumber;

    const [items, total] = await Promise.all([
      prisma.warehouse.findMany({
        where,
        orderBy,
        skip,
        take: limitNumber,
      }),
      prisma.warehouse.count({ where }),
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
// GET WAREHOUSE BY CODE
// ============================================
exports.get = async (req, res, next) => {
  try {
    const { code } = req.params;

    const warehouse = await prisma.warehouse.findUnique({
      where: { warehouseCode: code },
    });

    if (!warehouse) {
      return res.status(404).json({ message: "Warehouse tidak ditemukan" });
    }

    res.json(mapDoc(warehouse));
  } catch (e) {
    next(e);
  }
};

// ============================================
// CREATE WAREHOUSE
// ============================================
exports.create = async (req, res, next) => {
  try {
    const data = normalizeWarehousePayload(req.body);

    const warehouse = await prisma.warehouse.create({
      data,
    });

    res.status(201).json(mapDoc(warehouse));
  } catch (e) {
    next(e);
  }
};

// ============================================
// UPDATE WAREHOUSE
// ============================================
exports.update = async (req, res, next) => {
  try {
    const { code } = req.params;
    const data = normalizeWarehousePayload(req.body);

    const warehouse = await prisma.warehouse.update({
      where: { warehouseCode: code },
      data,
    });

    res.json(mapDoc(warehouse));
  } catch (e) {
    next(e);
  }
};

// ============================================
// SOFT DELETE WAREHOUSE
// ============================================
exports.remove = async (req, res, next) => {
  try {
    const { code } = req.params;

    await prisma.warehouse.update({
      where: { warehouseCode: code },
      data: { isDeleted: true },
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
};

// ============================================
// BULK CREATE WAREHOUSES
// ============================================
exports.bulkCreate = async (req, res, next) => {
  try {
    const { warehouses } = req.body;

    if (!Array.isArray(warehouses) || warehouses.length === 0) {
      return res.status(400).json({ message: "Warehouses harus berupa array" });
    }

    const createdWarehouses = await prisma.$transaction(
      warehouses.map((warehouse) =>
        prisma.warehouse.create({
          data: normalizeWarehousePayload(warehouse),
        })
      )
    );

    res.status(201).json({
      items: createdWarehouses.map(mapDoc),
      total: createdWarehouses.length,
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

    await prisma.warehouse.updateMany({
      where: { id: { in: ids } },
      data: { isDeleted: true },
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
};

// ============================================
// GET ALL WAREHOUSE CODES
// ============================================
exports.allCodes = async (req, res, next) => {
  try {
    const { isActive } = req.query;
    const where = { isDeleted: false };

    if (isActive !== undefined) {
      where.isActive = parseBoolean(isActive);
    }

    const codes = await prisma.warehouse.findMany({
      where,
      select: {
        warehouseCode: true,
        warehouseName: true,
        type: true,
      },
      orderBy: { warehouseCode: "asc" },
    });

    res.json(codes.map(mapDoc));
  } catch (e) {
    next(e);
  }
};
