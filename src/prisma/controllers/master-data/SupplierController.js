const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { generateSequentialCode } = require("../../utils/generateSequentialCode");
const { mapDoc } = require("../../utils/mapDoc");
const { parseFilter } = require("../../utils/parseFilter");

// Helper function untuk format supplier dengan mainBusiness
const formatSupplierWithMainBusiness = (supplier) => {
  if (!supplier) return null;
  
  return {
    ...mapDoc(supplier),
    mainBusiness: supplier.mainBusinesses
      ? supplier.mainBusinesses.map((item) => item.mainBusiness)
      : [],
    mainBusinesses: undefined,
  };
};

// Include config untuk main business
const includeSupplierMainBusinesses = {
  mainBusinesses: {
    include: {
      mainBusiness: {
        select: {
          id: true,
          mainBusinessCode: true,
          mainBusinessName: true,
        },
      },
    },
  },
};

function mainBusinessTokens(value) {
  let rows = value;
  if (typeof rows === "string") {
    const trimmed = rows.trim();
    if (!trimmed) return [];
    try {
      rows = JSON.parse(trimmed);
    } catch {
      rows = [trimmed];
    }
  }
  if (!Array.isArray(rows)) rows = rows == null ? [] : [rows];
  return [...new Set(rows
    .map((item) => typeof item === "object" && item
      ? item.id || item.mainBusinessId || item.mainBusinessCode
      : item)
    .map((item) => String(item ?? "").trim())
    .filter(Boolean))];
}

async function resolveMainBusinessIds(db, value) {
  const tokens = mainBusinessTokens(value);
  if (!tokens.length) return [];
  const rows = await db.mainBusiness.findMany({
    where: {
      isDeleted: false,
      OR: [
        { id: { in: tokens } },
        { mainBusinessCode: { in: tokens } },
      ],
    },
    select: { id: true, mainBusinessCode: true },
  });
  const byToken = new Map();
  rows.forEach((row) => {
    byToken.set(row.id, row.id);
    byToken.set(row.mainBusinessCode, row.id);
  });
  const invalid = tokens.filter((token) => !byToken.has(token));
  if (invalid.length) {
    throw Object.assign(
      new Error(`Bidang Usaha tidak ditemukan atau sudah nonaktif: ${invalid.join(", ")}`),
      { statusCode: 400 },
    );
  }
  return [...new Set(tokens.map((token) => byToken.get(token)))];
}

const mainBusinessRelation = (ids) => ({
  create: ids.map((mainBusinessId) => ({ mainBusinessId })),
});

function supplierLeadTimeChanged(currentValue, nextValue) {
  if (nextValue === undefined) return false;
  const current = currentValue == null ? null : Number(currentValue);
  const next = nextValue == null || nextValue === "" ? null : Number(nextValue);
  return current !== next;
}

async function updateSupplierAndInheritedItemLeadTime(db, supplierId, currentSupplier, updateData) {
  const shouldCascade = supplierLeadTimeChanged(currentSupplier.leadTimeDays, updateData.leadTimeDays);
  const previousLeadTimeDays = currentSupplier.leadTimeDays == null ? null : Number(currentSupplier.leadTimeDays);
  const nextLeadTimeDays = updateData.leadTimeDays == null || updateData.leadTimeDays === "" ? null : Number(updateData.leadTimeDays);
  return db.$transaction(async (tx) => {
    let synchronizedSupplierItemCount = 0;
    if (shouldCascade) {
      const synchronized = await tx.supplierItem.updateMany({
        where: {
          supplierId,
          isActive: true,
          OR: [
            { leadTimeDays: null },
            ...(previousLeadTimeDays == null ? [] : [{ leadTimeDays: previousLeadTimeDays }]),
          ],
        },
        data: { leadTimeDays: nextLeadTimeDays },
      });
      synchronizedSupplierItemCount = synchronized.count;
    }
    const supplier = await tx.supplier.update({
      where: { id: supplierId },
      data: { ...updateData, ...(shouldCascade ? { leadTimeDays: nextLeadTimeDays } : {}) },
      include: includeSupplierMainBusinesses,
    });
    return { supplier, synchronizedSupplierItemCount };
  });
}

exports.generateCode = async (req, res, next) => {
  try {
    // Ambil semua supplier codes
    const suppliers = await prisma.supplier.findMany({
      select: {
        supplierCode: true
      }
    });
    
    const supplierCode = generateSequentialCode(
      suppliers.map((s) => s.supplierCode),
      "S",
    );
    
    res.json({ supplierCode });
  } catch (e) {
    next(e);
  }
};

exports.getAllCodes = async (req, res, next) => {
  try {
    // Fetch semua supplier codes yang tidak soft deleted
    const suppliers = await prisma.supplier.findMany({
      where: { isDeleted: false },
      select: {
        supplierCode: true,
      },
      orderBy: { supplierCode: "asc" },
    });

    // Return array of supplier codes
    const codes = suppliers.map((s) => s.supplierCode);
    res.json(codes);
  } catch (e) {
    next(e);
  }
};

exports.list = async (req, res, next) => {
  try {
    const { q, isDeleted, page = 1, limit = 20, status, users } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;

    if (users) {
      where.users = { has: users };
    }

    if (q) {
      where.OR = [
        { supplierCode: { contains: q, mode: "insensitive" } },
        { supplierName: { contains: q, mode: "insensitive" } },
        { contact: { contains: q, mode: "insensitive" } },
        { phone: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { billingAddress: { contains: q, mode: "insensitive" } },
        { shippingAddress: { contains: q, mode: "insensitive" } },
        { taxId: { contains: q, mode: "insensitive" } },
        { notes: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.supplier.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
        include: includeSupplierMainBusinesses,
      }),
      prisma.supplier.count({ where }),
    ]);

    res.json({
      items: items.map(formatSupplierWithMainBusiness),
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
    const reference = String(req.params.supplierCode || "").trim();
    const doc = await prisma.supplier.findFirst({
      where: {
        isDeleted: false,
        OR: [
          { supplierCode: reference },
          { id: reference },
        ],
      },
      include: includeSupplierMainBusinesses,
    });
    if (!doc) return res.status(404).json({ message: "Supplier not found" });

    res.json(formatSupplierWithMainBusiness(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    // Extract mainBusiness dari request body
    const { mainBusiness, ...supplierData } = req.body;
    const mainBusinessIds = await resolveMainBusinessIds(prisma, mainBusiness);

    // Cek apakah supplier dengan supplierCode yang sama sudah ada dan soft deleted
    const existing = await prisma.supplier.findUnique({
      where: { supplierCode: req.body.supplierCode },
    });

    let doc;
    if (existing && existing.isDeleted) {
      // Jika ada dan soft deleted, update dengan data baru dan restore
      doc = await prisma.supplier.update({
        where: { id: existing.id },
        data: {
          ...supplierData,
          isDeleted: false,
          mainBusinesses: {
            deleteMany: {}, // Hapus relasi lama
            ...mainBusinessRelation(mainBusinessIds),
          },
        },
        include: includeSupplierMainBusinesses,
      });
    } else {
      doc = await prisma.supplier.create({
        data: {
          ...supplierData,
          mainBusinesses: mainBusinessRelation(mainBusinessIds),
        },
        include: includeSupplierMainBusinesses,
      });
    }

    res.status(201).json(formatSupplierWithMainBusiness(doc));
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
    if (e.code === "P2003") {
      return res.status(400).json({ message: "Relasi Bidang Usaha Supplier tidak valid. Muat ulang pilihan lalu coba kembali." });
    }
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    // Extract mainBusiness dari request body
    const { mainBusiness, ...supplierData } = req.body;
    const mainBusinessIds = mainBusiness === undefined
      ? null
      : await resolveMainBusinessIds(prisma, mainBusiness);

    // Cek current supplier
    const currentSupplier = await prisma.supplier.findUnique({
      where: { id: req.params.id },
    });

    if (!currentSupplier) {
      return res.status(404).json({ message: "Supplier not found" });
    }

    // Jika supplierCode berubah, cek apakah ada supplier soft deleted dengan code yang sama
    if (
      req.body.supplierCode &&
      req.body.supplierCode !== currentSupplier.supplierCode
    ) {
      const existingSoftDeleted = await prisma.supplier.findFirst({
        where: {
          supplierCode: req.body.supplierCode,
          isDeleted: true,
        },
      });

      // Jika ada, hard delete dulu yang soft deleted
      if (existingSoftDeleted) {
        await prisma.supplier.delete({
          where: { id: existingSoftDeleted.id },
        });
      }
    }

    // Prepare update data
    const updateData = { ...supplierData };

    // Jika mainBusiness ada di request, update relasi
    if (mainBusiness !== undefined) {
      updateData.mainBusinesses = {
        deleteMany: {}, // Hapus semua relasi lama
        ...mainBusinessRelation(mainBusinessIds),
      };
    }

    const { supplier: doc, synchronizedSupplierItemCount } = await updateSupplierAndInheritedItemLeadTime(prisma, req.params.id, currentSupplier, updateData);
    res.json({ ...formatSupplierWithMainBusiness(doc), synchronizedSupplierItemCount });
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
    if (e.code === "P2003") {
      return res.status(400).json({ message: "Relasi Bidang Usaha Supplier tidak valid. Muat ulang pilihan lalu coba kembali." });
    }
    next(e);
  }
};

exports.supplierLeadTimeChanged = supplierLeadTimeChanged;
exports.updateSupplierAndInheritedItemLeadTime = updateSupplierAndInheritedItemLeadTime;

exports.remove = async (req, res, next) => {
  try {
    const doc = await prisma.supplier.update({
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
    const result = await prisma.supplier.updateMany({
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
    const { suppliers } = req.body;

    if (!Array.isArray(suppliers) || suppliers.length === 0) {
      return res.status(400).json({ message: "suppliers array required" });
    }

    const results = {
      success: [],
      failed: [],
      duplicates: [],
      total: suppliers.length,
    };

    // Process setiap supplier
    for (const supplierData of suppliers) {
      try {
        // Extract mainBusiness dari supplier data
        const { mainBusiness, ...dataWithoutMainBusiness } = supplierData;
        const mainBusinessIds = await resolveMainBusinessIds(prisma, mainBusiness);

        // Cek existing supplier
        const existing = await prisma.supplier.findUnique({
          where: { supplierCode: supplierData.supplierCode },
        });

        if (existing && !existing.isDeleted) {
          // Supplier sudah ada dan active
          results.duplicates.push({
            supplierCode: supplierData.supplierCode,
            existingId: existing.id,
          });
          continue;
        }

        let doc;
        if (existing && existing.isDeleted) {
          // Update supplier yang soft deleted
          doc = await prisma.supplier.update({
            where: { id: existing.id },
            data: {
              ...dataWithoutMainBusiness,
              isDeleted: false,
              mainBusinesses: {
                deleteMany: {},
                ...mainBusinessRelation(mainBusinessIds),
              },
            },
            include: includeSupplierMainBusinesses,
          });
        } else {
          // Create supplier baru
          doc = await prisma.supplier.create({
            data: {
              ...dataWithoutMainBusiness,
              mainBusinesses: mainBusinessRelation(mainBusinessIds),
            },
            include: includeSupplierMainBusinesses,
          });
        }

        results.success.push(formatSupplierWithMainBusiness(doc));
      } catch (error) {
        results.failed.push({
          data: supplierData,
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

exports.stats = async (req, res, next) => {
  try {
    // Count total dan active suppliers
    const [total, active] = await Promise.all([
      prisma.supplier.count(),
      prisma.supplier.count({ where: { isDeleted: false } }),
    ]);
    const inactive = total - active;

    // Hitung supplier berdasarkan range leadTimeDays menggunakan subquery + GROUP BY
    const leadTimeStats = await prisma.$queryRaw`
      SELECT t.range AS range, COUNT(*)::integer AS count
      FROM (
        SELECT
          CASE 
            WHEN lead_time_days < 5 THEN '0-5'
            WHEN lead_time_days >= 5 AND lead_time_days < 10 THEN '5-10'
            WHEN lead_time_days >= 10 AND lead_time_days < 20 THEN '10-20'
            WHEN lead_time_days >= 20 AND lead_time_days < 50 THEN '20-50'
            WHEN lead_time_days >= 50 AND lead_time_days < 100 THEN '50-100'
            ELSE '100+'
          END AS range,
          CASE 
            WHEN lead_time_days < 5 THEN 1
            WHEN lead_time_days >= 5 AND lead_time_days < 10 THEN 2
            WHEN lead_time_days >= 10 AND lead_time_days < 20 THEN 3
            WHEN lead_time_days >= 20 AND lead_time_days < 50 THEN 4
            WHEN lead_time_days >= 50 AND lead_time_days < 100 THEN 5
            ELSE 6
          END AS range_order
        FROM tbl_supplier
        WHERE is_deleted = false AND lead_time_days IS NOT NULL
      ) t
      GROUP BY t.range, t.range_order
      ORDER BY t.range_order;
    `;

    // Count suppliers dengan informasi kontak/alamat lengkap
    const contactFilled = await prisma.supplier.count({
      where: {
        OR: [
          { AND: [{ contact: { not: null } }, { NOT: { contact: "" } }] },
          {
            AND: [
              { billingAddress: { not: null } },
              { NOT: { billingAddress: "" } },
            ],
          },
          {
            AND: [
              { shippingAddress: { not: null } },
              { NOT: { shippingAddress: "" } },
            ],
          },
        ],
      },
    });

    // Count suppliers dengan tax ID (NPWP)
    const withTaxId = await prisma.supplier.count({
      where: {
        AND: [{ taxId: { not: null } }, { NOT: { taxId: "" } }],
      },
    });

    // Supplier berdasarkan bulan dibuat (12 bulan terakhir)
    const monthSeries = await prisma.$queryRaw`
      SELECT 
        EXTRACT(YEAR FROM created_at)::integer as year,
        EXTRACT(MONTH FROM created_at)::integer as month,
        COUNT(*)::integer as count
      FROM tbl_supplier
      GROUP BY EXTRACT(YEAR FROM created_at), EXTRACT(MONTH FROM created_at)
      ORDER BY year DESC, month DESC
      LIMIT 12
    `;

    // Supplier terbaru (30 hari terakhir)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentSuppliers = await prisma.supplier.findMany({
      where: {
        createdAt: { gte: thirtyDaysAgo },
      },
      select: {
        supplierCode: true,
        supplierName: true,
        createdAt: true,
        leadTimeDays: true,
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    // Rata-rata lead time menggunakan aggregate
    const avgLeadTimeResult = await prisma.supplier.aggregate({
      where: {
        isDeleted: false,
        leadTimeDays: { not: null },
      },
      _avg: {
        leadTimeDays: true,
      },
    });

    res.json({
      total,
      active,
      inactive,
      leadTimeStats,
      contactFilled,
      withTaxId,
      avgLeadTime: avgLeadTimeResult._avg.leadTimeDays || 0,
      createdPerMonth: monthSeries.map((m) => ({
        year: m.year,
        month: m.month,
        count: m.count,
      })),
      recentSuppliers,
    });
  } catch (e) {
    next(e);
  }
};
