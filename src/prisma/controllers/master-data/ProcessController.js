const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");

exports.list = async (req, res, next) => {
  try {
    const { q, isDeleted, page = 1, limit = 20 } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    if (q) {
      where.OR = [
        { processCode: { contains: q, mode: 'insensitive' } },
        { processName: { contains: q, mode: 'insensitive' } },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.process.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.process.count({ where }),
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

exports.getAllCodes = async (req, res, next) => {
  try {
    // Fetch semua process codes yang tidak soft deleted
    const processes = await prisma.process.findMany({
      where: { isDeleted: false },
      select: {
        processCode: true,
      },
      orderBy: { processCode: "asc" },
    });

    // Return array of process codes
    const codes = processes.map((p) => p.processCode);
    res.json(codes);
  } catch (e) {
    next(e);
  }
};

exports.get = async (req, res, next) => {
  try {
    const doc = await prisma.process.findFirst({
      where: { processCode: req.params.processCode, isDeleted: false },
    });
    if (!doc) return res.status(404).json({ message: "Process not found" });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    if (req.body.processCode) {
      req.body.processCode = req.body.processCode.toUpperCase();
    }
    
    // Cek apakah process dengan processCode yang sama sudah ada dan soft deleted
    const existing = await prisma.process.findUnique({
      where: { processCode: req.body.processCode },
    });

    let doc;
    if (existing && existing.isDeleted) {
      // Jika ada dan soft deleted, update dengan data baru dan restore
      doc = await prisma.process.update({
        where: { id: existing.id },
        data: { ...req.body, isDeleted: false },
      });
    } else {
      doc = await prisma.process.create({
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
    // Cek current process
    const currentProcess = await prisma.process.findUnique({
      where: { id: req.params.id },
    });
    
    if (!currentProcess) {
      return res.status(404).json({ message: "Process not found" });
    }

    // Jika processCode berubah, cek apakah ada process soft deleted dengan code yang sama
    if (req.body.processCode && req.body.processCode !== currentProcess.processCode) {
      const existingSoftDeleted = await prisma.process.findFirst({
        where: {
          processCode: req.body.processCode,
          isDeleted: true,
        },
      });

      // Jika ada, hard delete dulu yang soft deleted
      if (existingSoftDeleted) {
        await prisma.process.delete({
          where: { id: existingSoftDeleted.id },
        });
      }
    }

    // Sekarang baru update
    const doc = await prisma.process.update({
      where: { id: req.params.id },
      data: req.body,
    });
    
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const doc = await prisma.process.update({
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
    const result = await prisma.process.updateMany({
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
    const { processes } = req.body;

    if (!Array.isArray(processes) || processes.length === 0) {
      return res.status(400).json({ message: "processes array required" });
    }

    const results = {
      success: [],
      failed: [],
      duplicates: [],
      total: processes.length,
    };

    // Process setiap process
    for (const processData of processes) {
      try {
        // Uppercase processCode
        const processedData = {
          ...processData,
          processCode: processData.processCode ? processData.processCode.toUpperCase() : processData.processCode,
        };

        // Cek existing process
        const existing = await prisma.process.findUnique({
          where: { processCode: processedData.processCode },
        });

        if (existing && !existing.isDeleted) {
          // Process sudah ada dan active
          results.duplicates.push({
            processCode: processedData.processCode,
            existingId: existing.id,
          });
          continue;
        }

        let doc;
        if (existing && existing.isDeleted) {
          // Update process yang soft deleted
          doc = await prisma.process.update({
            where: { id: existing.id },
            data: {
              ...processedData,
              isDeleted: false,
            },
          });
        } else {
          // Create process baru
          doc = await prisma.process.create({
            data: processedData,
          });
        }

        results.success.push(mapDoc(doc));
      } catch (error) {
        results.failed.push({
          data: processData,
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
    const { q, limit = 20 } = req.query;
    const where = { isDeleted: false };

    if (q) {
      where.OR = [
        { processCode: { contains: q, mode: 'insensitive' } },
        { processName: { contains: q, mode: 'insensitive' } },
      ];
    }

    const items = await prisma.process.findMany({
      where,
      select: {
        id: true,
        processCode: true,
        processName: true,
        costPerUnit: true,
        timePerUnit: true,
      },
      take: Number(limit),
      orderBy: { processCode: 'asc' },
    });

    res.json(items);
  } catch (e) {
    next(e);
  }
};
