const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { generateSequentialCode } = require("../../utils/generateSequentialCode");
const { mapDoc } = require("../../utils/mapDoc");
const { parseFilter } = require("../../utils/parseFilter");

// Helper function untuk format vendor dengan mainBusiness
const formatVendorWithMainBusiness = (vendor) => {
  if (!vendor) return null;
  
  return {
    ...mapDoc(vendor),
    mainBusiness: vendor.mainBusinesses
      ? vendor.mainBusinesses.map((item) => item.mainBusiness)
      : [],
    mainBusinesses: undefined,
  };
};

// Include config untuk main business
const includeVendorMainBusinesses = {
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

exports.generateCode = async (req, res, next) => {
  try {
    // Ambil semua vendor codes
    const vendors = await prisma.vendor.findMany({
      select: {
        vendorCode: true
      }
    });
    
    const vendorCode = generateSequentialCode(
      vendors.map((v) => v.vendorCode),
      "V",
    );
    
    res.json({ vendorCode });
  } catch (e) {
    next(e);
  }
};

exports.getAllCodes = async (req, res, next) => {
  try {
    // Fetch semua vendor codes yang tidak soft deleted
    const vendors = await prisma.vendor.findMany({
      where: { isDeleted: false },
      select: {
        vendorCode: true,
      },
      orderBy: { vendorCode: "asc" },
    });

    // Return array of vendor codes
    const codes = vendors.map((v) => v.vendorCode);
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
        { vendorCode: { contains: q, mode: "insensitive" } },
        { vendorName: { contains: q, mode: "insensitive" } },
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
      prisma.vendor.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
        include: includeVendorMainBusinesses,
      }),
      prisma.vendor.count({ where }),
    ]);

    res.json({
      items: items.map(formatVendorWithMainBusiness),
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
    const doc = await prisma.vendor.findFirst({
      where: { vendorCode: req.params.vendorCode, isDeleted: false },
      include: includeVendorMainBusinesses,
    });
    if (!doc) return res.status(404).json({ message: "Vendor not found" });

    res.json(formatVendorWithMainBusiness(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    // Extract mainBusiness dari request body
    const { mainBusiness, ...vendorData } = req.body;

    // Cek apakah vendor dengan vendorCode yang sama sudah ada dan soft deleted
    const existing = await prisma.vendor.findUnique({
      where: { vendorCode: req.body.vendorCode },
    });

    let doc;
    if (existing && existing.isDeleted) {
      // Jika ada dan soft deleted, update dengan data baru dan restore
      doc = await prisma.vendor.update({
        where: { id: existing.id },
        data: {
          ...vendorData,
          isDeleted: false,
          mainBusinesses: {
            deleteMany: {}, // Hapus relasi lama
            create: Array.isArray(mainBusiness)
              ? mainBusiness.map((mainBusinessId) => ({
                  mainBusinessId,
                }))
              : [],
          },
        },
        include: includeVendorMainBusinesses,
      });
    } else {
      doc = await prisma.vendor.create({
        data: {
          ...vendorData,
          mainBusinesses: {
            create: Array.isArray(mainBusiness)
              ? mainBusiness.map((mainBusinessId) => ({
                  mainBusinessId,
                }))
              : [],
          },
        },
        include: includeVendorMainBusinesses,
      });
    }

    res.status(201).json(formatVendorWithMainBusiness(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    // Extract mainBusiness dari request body
    const { mainBusiness, ...vendorData } = req.body;

    // Cek current vendor
    const currentVendor = await prisma.vendor.findUnique({
      where: { id: req.params.id },
    });

    if (!currentVendor) {
      return res.status(404).json({ message: "Vendor not found" });
    }

    // Jika vendorCode berubah, cek apakah ada vendor soft deleted dengan code yang sama
    if (
      req.body.vendorCode &&
      req.body.vendorCode !== currentVendor.vendorCode
    ) {
      const existingSoftDeleted = await prisma.vendor.findFirst({
        where: {
          vendorCode: req.body.vendorCode,
          isDeleted: true,
        },
      });

      // Jika ada, hard delete dulu yang soft deleted
      if (existingSoftDeleted) {
        await prisma.vendor.delete({
          where: { id: existingSoftDeleted.id },
        });
      }
    }

    // Prepare update data
    const updateData = { ...vendorData };

    // Jika mainBusiness ada di request, update relasi
    if (mainBusiness !== undefined) {
      updateData.mainBusinesses = {
        deleteMany: {}, // Hapus semua relasi lama
        create: Array.isArray(mainBusiness)
          ? mainBusiness.map((mainBusinessId) => ({
              mainBusinessId,
            }))
          : [],
      };
    }

    // Sekarang baru update
    const doc = await prisma.vendor.update({
      where: { id: req.params.id },
      data: updateData,
      include: includeVendorMainBusinesses,
    });

    res.json(formatVendorWithMainBusiness(doc));
  } catch (e) {
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const doc = await prisma.vendor.update({
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
    const result = await prisma.vendor.updateMany({
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
    const { vendors } = req.body;

    if (!Array.isArray(vendors) || vendors.length === 0) {
      return res.status(400).json({ message: "vendors array required" });
    }

    const results = {
      success: [],
      failed: [],
      duplicates: [],
      total: vendors.length,
    };

    // Process setiap vendor
    for (const vendorData of vendors) {
      try {
        // Extract mainBusiness dari vendor data
        const { mainBusiness, ...dataWithoutMainBusiness } = vendorData;

        // Cek existing vendor
        const existing = await prisma.vendor.findUnique({
          where: { vendorCode: vendorData.vendorCode },
        });

        if (existing && !existing.isDeleted) {
          // Vendor sudah ada dan active
          results.duplicates.push({
            vendorCode: vendorData.vendorCode,
            existingId: existing.id,
          });
          continue;
        }

        let doc;
        if (existing && existing.isDeleted) {
          // Update vendor yang soft deleted
          doc = await prisma.vendor.update({
            where: { id: existing.id },
            data: {
              ...dataWithoutMainBusiness,
              isDeleted: false,
              mainBusinesses: {
                deleteMany: {},
                create: Array.isArray(mainBusiness)
                  ? mainBusiness.map((mainBusinessId) => ({
                      mainBusinessId,
                    }))
                  : [],
              },
            },
            include: includeVendorMainBusinesses,
          });
        } else {
          // Create vendor baru
          doc = await prisma.vendor.create({
            data: {
              ...dataWithoutMainBusiness,
              mainBusinesses: {
                create: Array.isArray(mainBusiness)
                  ? mainBusiness.map((mainBusinessId) => ({
                      mainBusinessId,
                    }))
                  : [],
              },
            },
            include: includeVendorMainBusinesses,
          });
        }

        results.success.push(formatVendorWithMainBusiness(doc));
      } catch (error) {
        results.failed.push({
          data: vendorData,
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
    // Count total dan active vendors
    const [total, active] = await Promise.all([
      prisma.vendor.count(),
      prisma.vendor.count({ where: { isDeleted: false } }),
    ]);
    const inactive = total - active;

    // Hitung vendor berdasarkan range leadTimeDays menggunakan subquery + GROUP BY
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
        FROM tbl_vendor
        WHERE is_deleted = false AND lead_time_days IS NOT NULL
      ) t
      GROUP BY t.range, t.range_order
      ORDER BY t.range_order;
    `;

    // Count vendors dengan informasi kontak/alamat lengkap
    const contactFilled = await prisma.vendor.count({
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

    // Count vendors dengan tax ID (NPWP)
    const withTaxId = await prisma.vendor.count({
      where: {
        AND: [{ taxId: { not: null } }, { NOT: { taxId: "" } }],
      },
    });

    // Vendor berdasarkan bulan dibuat (12 bulan terakhir)
    const monthSeries = await prisma.$queryRaw`
      SELECT 
        EXTRACT(YEAR FROM created_at)::integer as year,
        EXTRACT(MONTH FROM created_at)::integer as month,
        COUNT(*)::integer as count
      FROM tbl_vendor
      GROUP BY EXTRACT(YEAR FROM created_at), EXTRACT(MONTH FROM created_at)
      ORDER BY year DESC, month DESC
      LIMIT 12
    `;

    // Vendor terbaru (30 hari terakhir)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentVendors = await prisma.vendor.findMany({
      where: {
        createdAt: { gte: thirtyDaysAgo },
      },
      select: {
        vendorCode: true,
        vendorName: true,
        createdAt: true,
        leadTimeDays: true,
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    // Rata-rata lead time menggunakan aggregate
    const avgLeadTimeResult = await prisma.vendor.aggregate({
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
      recentVendors,
    });
  } catch (e) {
    next(e);
  }
};
