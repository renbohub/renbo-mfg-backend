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
  ["isActive", "availableForMrp", "availableForProduction", "availableForDelivery"].forEach((field) => {
    if (normalized[field] !== undefined) normalized[field] = parseBoolean(normalized[field]);
  });
  if (normalized.warehouseCode !== undefined) normalized.warehouseCode = String(normalized.warehouseCode || "").trim().toUpperCase();
  if (normalized.warehouseName !== undefined) normalized.warehouseName = String(normalized.warehouseName || "").trim();
  if (normalized.location !== undefined) normalized.location = String(normalized.location || "").trim() || null;
  if (normalized.type !== undefined) normalized.type = String(normalized.type || "Main").trim();
  if (normalized.stockStatus !== undefined) normalized.stockStatus = String(normalized.stockStatus || "AVAILABLE").trim().toUpperCase();
  return normalized;
};

const ACTIVE_STO_STATUSES = ["DRAFT", "COUNTING", "WAITING_APPROVAL", "APPROVED"];

function validateWarehouse(data, current = null) {
  const code = data.warehouseCode ?? current?.warehouseCode;
  const name = data.warehouseName ?? current?.warehouseName;
  if (!code) {
    const error = new Error("warehouseCode wajib diisi.");
    error.statusCode = 400;
    throw error;
  }
  if (!name) {
    const error = new Error("warehouseName wajib diisi.");
    error.statusCode = 400;
    throw error;
  }
  if (data.capacity != null && Number(data.capacity) < 0) {
    const error = new Error("capacity tidak boleh negatif.");
    error.statusCode = 400;
    throw error;
  }
}

async function enrichWarehouseRows(items) {
  const codes = items.map((item) => item.warehouseCode);
  if (!codes.length) return [];
  const [stockGroups, rackGroups, stoGroups] = await Promise.all([
    prisma.stockBalance.groupBy({
      by: ["warehouseCode"],
      where: { warehouseCode: { in: codes }, isDeleted: false },
      _count: { _all: true },
      _sum: {
        qtyOnHand: true,
        qtyAvailable: true,
        qtyReserved: true,
        qtyQC: true,
      },
    }),
    prisma.rack.groupBy({
      by: ["warehouseCode"],
      where: { warehouseCode: { in: codes }, isDeleted: false, isActive: true },
      _count: { _all: true },
    }),
    prisma.stockOpnameHeader.groupBy({
      by: ["warehouseCode"],
      where: {
        warehouseCode: { in: codes },
        isDeleted: false,
        status: { in: ACTIVE_STO_STATUSES },
      },
      _count: { _all: true },
    }),
  ]);
  const stockByWarehouse = new Map(stockGroups.map((group) => [group.warehouseCode, group]));
  const racksByWarehouse = new Map(rackGroups.map((group) => [group.warehouseCode, group._count._all]));
  const stoByWarehouse = new Map(stoGroups.map((group) => [group.warehouseCode, group._count._all]));
  return items.map((item) => {
    const stock = stockByWarehouse.get(item.warehouseCode);
    return mapDoc({
      ...item,
      rackCount: racksByWarehouse.get(item.warehouseCode) || 0,
      stockItemCount: stock?._count?._all || 0,
      qtyOnHand: stock?._sum?.qtyOnHand || 0,
      qtyAvailable: stock?._sum?.qtyAvailable || 0,
      qtyReserved: stock?._sum?.qtyReserved || 0,
      qtyQC: stock?._sum?.qtyQC || 0,
      activeStoCount: stoByWarehouse.get(item.warehouseCode) || 0,
    });
  });
}

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
      items: await enrichWarehouseRows(items),
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

    const warehouse = await prisma.warehouse.findFirst({
      where: { warehouseCode: code, isDeleted: false },
      include: {
        racks: {
          where: { isDeleted: false },
          orderBy: [{ zone: "asc" }, { rackCode: "asc" }],
        },
        stockOpnameHeaders: {
          where: { isDeleted: false, status: { in: ACTIVE_STO_STATUSES } },
          orderBy: { stoDate: "desc" },
          select: {
            stoNo: true,
            stoType: true,
            stoDate: true,
            status: true,
            inventoryFrozen: true,
          },
        },
        stockMovements: {
          where: { isDeleted: false },
          orderBy: { movementDate: "desc" },
          take: 20,
          select: {
            movementNumber: true,
            movementDate: true,
            movementType: true,
            direction: true,
            transactionType: true,
            partCode: true,
            materialCode: true,
            rackCode: true,
            lotNumber: true,
            qty: true,
            uomCode: true,
            referenceNumber: true,
          },
        },
      },
    });

    if (!warehouse) {
      return res.status(404).json({ message: "Warehouse tidak ditemukan" });
    }

    const [enriched] = await enrichWarehouseRows([warehouse]);
    const stockByType = await prisma.stockBalance.groupBy({
      by: ["stockType"],
      where: { warehouseCode: code, isDeleted: false },
      _count: { _all: true },
      _sum: { qtyOnHand: true, qtyAvailable: true, qtyReserved: true, qtyQC: true },
    });
    res.json(mapDoc({
      ...enriched,
      inventoryByType: stockByType.map((group) => ({
        stockType: group.stockType || "Unclassified",
        stockLines: group._count._all,
        qtyOnHand: group._sum.qtyOnHand || 0,
        qtyAvailable: group._sum.qtyAvailable || 0,
        qtyReserved: group._sum.qtyReserved || 0,
        qtyQC: group._sum.qtyQC || 0,
      })),
    }));
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
    validateWarehouse(data);

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
    const current = await prisma.warehouse.findFirst({ where: { warehouseCode: code, isDeleted: false } });
    if (!current) return res.status(404).json({ message: "Warehouse tidak ditemukan" });
    delete data.warehouseCode;
    validateWarehouse(data, current);

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
    const [stockLines, activeSto] = await Promise.all([
      prisma.stockBalance.count({ where: { warehouseCode: code, isDeleted: false, qtyOnHand: { not: 0 } } }),
      prisma.stockOpnameHeader.count({ where: { warehouseCode: code, isDeleted: false, status: { in: ACTIVE_STO_STATUSES } } }),
    ]);
    if (activeSto > 0) return res.status(409).json({ message: "Warehouse tidak dapat dihapus karena masih memiliki Stock Opname aktif." });
    if (stockLines > 0) return res.status(409).json({ message: "Warehouse tidak dapat dihapus karena masih memiliki saldo stok." });
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

    const normalizedWarehouses = warehouses.map((warehouse) => {
      const data = normalizeWarehousePayload(warehouse);
      validateWarehouse(data);
      return data;
    });
    const createdWarehouses = await prisma.$transaction(
      normalizedWarehouses.map((warehouse) =>
        prisma.warehouse.create({
          data: warehouse,
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

    const targets = await prisma.warehouse.findMany({
      where: { id: { in: ids }, isDeleted: false },
      select: { id: true, warehouseCode: true },
    });
    const codes = targets.map((item) => item.warehouseCode);
    const [stockLines, activeSto] = await Promise.all([
      prisma.stockBalance.count({ where: { warehouseCode: { in: codes }, isDeleted: false, qtyOnHand: { not: 0 } } }),
      prisma.stockOpnameHeader.count({ where: { warehouseCode: { in: codes }, isDeleted: false, status: { in: ACTIVE_STO_STATUSES } } }),
    ]);
    if (activeSto > 0) return res.status(409).json({ message: "Bulk remove ditolak karena terdapat Stock Opname aktif." });
    if (stockLines > 0) return res.status(409).json({ message: "Bulk remove ditolak karena terdapat saldo stok." });
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
