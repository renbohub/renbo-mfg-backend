const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { generateSequentialCode } = require("../../utils/generateSequentialCode");
const { mapDoc } = require("../../utils/mapDoc");

exports.generateCode = async (req, res, next) => {
  try {
    // Ambil semua customer codes
    const customers = await prisma.customer.findMany({
      select: {
        customerCode: true,
      },
    });

    const customerCode = generateSequentialCode(
      customers.map((c) => c.customerCode),
      "C",
    );

    res.json({ customerCode });
  } catch (e) {
    next(e);
  }
};

exports.getAllCodes = async (req, res, next) => {
  try {
    // Fetch semua customer codes yang tidak soft deleted
    const customers = await prisma.customer.findMany({
      where: { isDeleted: false },
      select: {
        customerCode: true,
      },
      orderBy: { customerCode: "asc" },
    });

    // Return array of customer codes
    const codes = customers.map((c) => c.customerCode);
    res.json(codes);
  } catch (e) {
    next(e);
  }
};

exports.list = async (req, res, next) => {
  try {
    const { q, isDeleted, page = 1, limit = 20, classification } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    if (classification) {
      where.customerClassification = { has: classification };
    }

    if (q) {
      where.OR = [
        { customerCode: { contains: q, mode: "insensitive" } },
        { customerName: { contains: q, mode: "insensitive" } },
        { contact: { contains: q, mode: "insensitive" } },
        { phone: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.customer.count({ where }),
    ]);

    res.json({
      items: items.map(mapDoc),
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
    const doc = await prisma.customer.findFirst({
      where: { customerCode: req.params.customerCode, isDeleted: false },
    });
    if (!doc) return res.status(404).json({ message: "Customer not found" });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    // Cek apakah customer dengan customerCode yang sama sudah ada dan soft deleted
    const existing = await prisma.customer.findUnique({
      where: { customerCode: req.body.customerCode },
    });

    let doc;
    if (existing && existing.isDeleted) {
      // Jika ada dan soft deleted, update dengan data baru dan restore
      doc = await prisma.customer.update({
        where: { id: existing.id },
        data: {
          ...req.body,
          isDeleted: false,
        },
      });
    } else {
      // Jika tidak ada, create baru
      doc = await prisma.customer.create({
        data: req.body,
      });
    }

    res.status(201).json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    // Cek current customer
    const currentCustomer = await prisma.customer.findUnique({
      where: { id: req.params.id },
    });

    if (!currentCustomer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    // Jika customerCode berubah, cek apakah ada customer soft deleted dengan code yang sama
    if (
      req.body.customerCode &&
      req.body.customerCode !== currentCustomer.customerCode
    ) {
      const existingSoftDeleted = await prisma.customer.findFirst({
        where: {
          customerCode: req.body.customerCode,
          isDeleted: true,
        },
      });

      // Jika ada, hard delete dulu yang soft deleted
      if (existingSoftDeleted) {
        await prisma.customer.delete({
          where: { id: existingSoftDeleted.id },
        });
      }
    }

    // Sekarang baru update
    const doc = await prisma.customer.update({
      where: { id: req.params.id },
      data: req.body,
    });

    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

// Soft delete
exports.remove = async (req, res, next) => {
  try {
    const doc = await prisma.customer.update({
      where: { id: req.params.id },
      data: { isDeleted: true },
    });
    if (!doc) return res.status(404).json({ message: "Customer not found" });
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
    const result = await prisma.customer.updateMany({
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
    const { customers } = req.body;

    if (!Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({ message: "customers array required" });
    }

    const results = {
      success: [],
      failed: [],
      duplicates: [],
      total: customers.length,
    };

    // Process setiap customer
    for (const customerData of customers) {
      try {
        // Cek existing customer
        const existing = await prisma.customer.findUnique({
          where: { customerCode: customerData.customerCode },
        });

        if (existing && !existing.isDeleted) {
          // Customer sudah ada dan active
          results.duplicates.push({
            customerCode: customerData.customerCode,
            existingId: existing.id,
          });
          continue;
        }

        let doc;
        if (existing && existing.isDeleted) {
          // Update customer yang soft deleted
          doc = await prisma.customer.update({
            where: { id: existing.id },
            data: { ...customerData, isDeleted: false },
          });
        } else {
          // Create customer baru
          doc = await prisma.customer.create({
            data: customerData,
          });
        }

        results.success.push(mapDoc(doc));
      } catch (error) {
        results.failed.push({
          data: customerData,
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

exports.autocomplete = async (req, res, next) => {
  try {
    const { q, limit = 10 } = req.query;
    const where = { isDeleted: false };

    if (q) {
      where.OR = [
        { customerCode: { contains: q, mode: "insensitive" } },
        { customerName: { contains: q, mode: "insensitive" } },
      ];
    }

    const items = await prisma.customer.findMany({
      where,
      select: {
        id: true,
        customerCode: true,
        customerName: true,
      },
      take: Number(limit),
      orderBy: { customerName: "asc" },
    });

    res.json(items);
  } catch (e) {
    next(e);
  }
};

exports.stats = async (req, res, next) => {
  try {
    // Count total dan active customers
    const [total, active] = await Promise.all([
      prisma.customer.count(),
      prisma.customer.count({ where: { isDeleted: false } }),
    ]);
    const inactive = total - active;

    // Distinct paymentTerms (hanya yang tidak null/empty)
    const paymentTermsData = await prisma.customer.groupBy({
      by: ["paymentTerms"],
      where: {
        paymentTerms: { not: null },
        NOT: { paymentTerms: "" },
      },
      _count: { paymentTerms: true },
      orderBy: {
        _count: {
          paymentTerms: "desc",
        },
      },
    });

    const paymentTermsList = paymentTermsData.map((item) => item.paymentTerms);
    const totalPaymentTermsTypes = paymentTermsList.length;
    const paymentTermsCounts = paymentTermsData.map((item) => ({
      _id: item.paymentTerms,
      count: item._count.paymentTerms,
    }));

    // Count customers dengan contact atau billing address
    const contactFilled = await prisma.customer.count({
      where: {
        OR: [
          { contact: { not: null }, NOT: { contact: "" } },
          { billingAddress: { not: null }, NOT: { billingAddress: "" } },
        ],
      },
    });

    // Created per month (last 12 months) - menggunakan raw SQL untuk DATE_TRUNC
    const monthSeries = await prisma.$queryRaw`
      SELECT 
        EXTRACT(YEAR FROM created_at)::integer as year,
        EXTRACT(MONTH FROM created_at)::integer as month,
        COUNT(*)::integer as count
      FROM tbl_customer
      GROUP BY EXTRACT(YEAR FROM created_at), EXTRACT(MONTH FROM created_at)
      ORDER BY year DESC, month DESC
      LIMIT 12
    `;

    // Recent customers (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentCustomers = await prisma.customer.findMany({
      where: {
        createdAt: { gte: thirtyDaysAgo },
      },
      select: {
        customerCode: true,
        customerName: true,
        createdAt: true,
        paymentTerms: true,
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    res.json({
      total,
      active,
      inactive,
      paymentTerms: {
        totalTypes: totalPaymentTermsTypes,
        list: paymentTermsList,
        counts: paymentTermsCounts,
      },
      contactFilled,
      createdPerMonth: monthSeries.map((m) => ({
        year: m.year,
        month: m.month,
        count: m.count,
      })),
      recentCustomers,
    });
  } catch (e) {
    next(e);
  }
};
