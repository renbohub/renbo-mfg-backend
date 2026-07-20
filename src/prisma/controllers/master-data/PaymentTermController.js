const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");

/**
 * List Payment Terms dengan pagination, search, dan filter
 * Query params: q, isDeleted, page, limit, sort
 */
exports.list = async (req, res, next) => {
  try {
    const { q, isDeleted, page = 1, limit = 20 } = req.query;
    const where = {};

    // Filter isDeleted
    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    // Search query
    if (q) {
      where.OR = [
        { termCode: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.paymentTerm.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.paymentTerm.count({ where }),
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

/**
 * Get all Payment Term codes
 * Returns array of termCode untuk dropdown/select
 */
exports.getAllCodes = async (req, res, next) => {
  try {
    // Fetch semua payment term codes yang tidak soft deleted
    const paymentTerms = await prisma.paymentTerm.findMany({
      where: { isDeleted: false },
      select: {
        termCode: true,
      },
      orderBy: { termCode: "asc" },
    });

    // Return array of term codes
    const codes = paymentTerms.map((pt) => pt.termCode);
    res.json(codes);
  } catch (e) {
    next(e);
  }
};

/**
 * Get single Payment Term by termCode
 * @param {string} req.params.termCode - Kode term pembayaran
 */
exports.get = async (req, res, next) => {
  try {
    const doc = await prisma.paymentTerm.findFirst({
      where: { termCode: req.params.termCode, isDeleted: false },
    });
    if (!doc) {
      return res.status(404).json({ message: "Payment term not found" });
    }
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

/**
 * Create new Payment Term
 * @param {object} req.body - Data payment term baru
 */
exports.create = async (req, res, next) => {
  try {
    // Uppercase termCode
    if (req.body.termCode) {
      req.body.termCode = req.body.termCode.toUpperCase();
    }

    // Cek apakah payment term dengan termCode yang sama sudah ada dan soft deleted
    const existing = await prisma.paymentTerm.findUnique({
      where: { termCode: req.body.termCode },
    });

    let doc;
    if (existing && existing.isDeleted) {
      // Jika ada dan soft deleted, update dengan data baru dan restore
      doc = await prisma.paymentTerm.update({
        where: { id: existing.id },
        data: { ...req.body, isDeleted: false },
      });
    } else {
      doc = await prisma.paymentTerm.create({
        data: req.body,
      });
    }

    res.status(201).json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

/**
 * Update Payment Term by ID
 * @param {string} req.params.id - ID payment term
 * @param {object} req.body - Data update
 */
exports.update = async (req, res, next) => {
  try {
    // Cek current payment term
    const currentTerm = await prisma.paymentTerm.findUnique({
      where: { id: req.params.id },
    });
    
    if (!currentTerm) {
      return res.status(404).json({ message: "Payment term not found" });
    }

    // Jika termCode berubah, cek apakah ada payment term soft deleted dengan code yang sama
    if (req.body.termCode && req.body.termCode !== currentTerm.termCode) {
      const existingSoftDeleted = await prisma.paymentTerm.findFirst({
        where: {
          termCode: req.body.termCode,
          isDeleted: true,
        },
      });

      // Jika ada, hard delete dulu yang soft deleted
      if (existingSoftDeleted) {
        await prisma.paymentTerm.delete({
          where: { id: existingSoftDeleted.id },
        });
      }
    }

    // Sekarang baru update
    const doc = await prisma.paymentTerm.update({
      where: { id: req.params.id },
      data: req.body,
    });
    
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

/**
 * Soft delete Payment Term by ID
 * @param {string} req.params.id - ID payment term
 */
exports.remove = async (req, res, next) => {
  try {
    await prisma.paymentTerm.update({
      where: { id: req.params.id },
      data: { isDeleted: true },
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
};

/**
 * Bulk soft delete Payment Terms
 * @param {array} req.body.ids - Array of payment term IDs
 */
exports.bulkRemove = async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids array required" });
    }

    const result = await prisma.paymentTerm.updateMany({
      where: { id: { in: ids } },
      data: { isDeleted: true },
    });

    res.json({ deletedCount: result.count });
  } catch (e) {
    next(e);
  }
};

/**
 * Bulk create Payment Terms
 * @param {array} req.body.paymentTerms - Array of payment term data
 */
exports.bulkCreate = async (req, res, next) => {
  try {
    const { paymentTerms } = req.body;

    if (!Array.isArray(paymentTerms) || paymentTerms.length === 0) {
      return res.status(400).json({ message: "paymentTerms array required" });
    }

    const results = {
      success: [],
      failed: [],
      duplicates: [],
      total: paymentTerms.length,
    };

    // Process setiap payment term
    for (const termData of paymentTerms) {
      try {
        // Uppercase termCode
        const processedData = {
          ...termData,
          termCode: termData.termCode ? termData.termCode.toUpperCase() : termData.termCode,
        };

        // Cek existing payment term
        const existing = await prisma.paymentTerm.findUnique({
          where: { termCode: processedData.termCode },
        });

        if (existing && !existing.isDeleted) {
          // Payment term sudah ada dan active
          results.duplicates.push({
            termCode: processedData.termCode,
            existingId: existing.id,
          });
          continue;
        }

        let doc;
        if (existing && existing.isDeleted) {
          // Update payment term yang soft deleted
          doc = await prisma.paymentTerm.update({
            where: { id: existing.id },
            data: {
              ...processedData,
              isDeleted: false,
            },
          });
        } else {
          // Create payment term baru
          doc = await prisma.paymentTerm.create({
            data: processedData,
          });
        }

        results.success.push(mapDoc(doc));
      } catch (error) {
        results.failed.push({
          data: termData,
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

/**
 * Autocomplete untuk dropdown/select
 * Query params: q, limit
 * Returns minimal fields untuk performa optimal
 */
exports.autocomplete = async (req, res, next) => {
  try {
    const { q, limit = 20 } = req.query;
    const where = { isDeleted: false };

    if (q) {
      where.OR = [
        { termCode: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
      ];
    }

    const items = await prisma.paymentTerm.findMany({
      where,
      select: {
        id: true,
        termCode: true,
        description: true,
        days: true,
      },
      take: Number(limit),
      orderBy: { termCode: "asc" },
    });

    res.json(items);
  } catch (e) {
    next(e);
  }
};
