const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");

// Include config untuk subprocess
const includeSubProcess = {
  process: {
    select: {
      processCode: true,
      processName: true,
    },
  },
};

exports.generateCode = async (req, res, next) => {
  try {
    // Ambil semua subprocess codes
    const subProcesses = await prisma.subProcess.findMany({
      select: { subProcessCode: true },
    });

    // Parse semua codes jadi number, filter yang valid, dan sort
    const existingNumbers = subProcesses
      .map((s) => parseInt(s.subProcessCode))
      .filter((num) => !isNaN(num))
      .sort((a, b) => a - b);

    // Cari gap pertama dalam sequence
    let nextNumber = 1;
    for (const num of existingNumbers) {
      if (num === nextNumber) {
        nextNumber++;
      } else if (num > nextNumber) {
        break;
      }
    }

    const subProcessCode = String(nextNumber).padStart(3, "0");
    res.json({ subProcessCode });
  } catch (e) {
    next(e);
  }
};

exports.getAllCodes = async (req, res, next) => {
  try {
    const subProcesses = await prisma.subProcess.findMany({
      where: { isDeleted: false },
      select: { subProcessCode: true },
      orderBy: { subProcessCode: "asc" },
    });
    const codes = subProcesses.map((s) => s.subProcessCode);
    res.json(codes);
  } catch (e) {
    next(e);
  }
};

exports.list = async (req, res, next) => {
  try {
    const { q, isDeleted, processId, page = 1, limit = 20 } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    // Filter berdasarkan processId jika ada
    if (processId) {
      where.processId = processId;
    }

    if (q) {
      where.OR = [
        { subProcessCode: { contains: q, mode: "insensitive" } },
        { subProcessName: { contains: q, mode: "insensitive" } },
        { process: { processCode: { contains: q, mode: "insensitive" } } },
        { process: { processName: { contains: q, mode: "insensitive" } } },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.subProcess.findMany({
        where,
        include: includeSubProcess,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.subProcess.count({ where }),
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
    const doc = await prisma.subProcess.findFirst({
      where: { subProcessCode: req.params.subProcessCode, isDeleted: false },
      include: includeSubProcess,
    });
    if (!doc) return res.status(404).json({ message: "SubProcess tidak ditemukan" });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    if (req.body.subProcessCode) {
      req.body.subProcessCode = req.body.subProcessCode.toUpperCase();
    }

    // Cek apakah subprocess dengan subProcessCode yang sama sudah ada dan soft deleted
    const existing = await prisma.subProcess.findUnique({
      where: { subProcessCode: req.body.subProcessCode },
    });

    let doc;
    if (existing && existing.isDeleted) {
      // Jika ada dan soft deleted, restore dengan data baru
      doc = await prisma.subProcess.update({
        where: { id: existing.id },
        data: { ...req.body, isDeleted: false },
        include: includeSubProcess,
      });
    } else {
      doc = await prisma.subProcess.create({
        data: req.body,
        include: includeSubProcess,
      });
    }

    res.status(201).json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const current = await prisma.subProcess.findUnique({
      where: { id: req.params.id },
    });

    if (!current) {
      return res.status(404).json({ message: "SubProcess tidak ditemukan" });
    }

    // Jika subProcessCode berubah, cek apakah ada soft deleted dengan code yang sama
    if (req.body.subProcessCode && req.body.subProcessCode !== current.subProcessCode) {
      const existingSoftDeleted = await prisma.subProcess.findFirst({
        where: {
          subProcessCode: req.body.subProcessCode,
          isDeleted: true,
        },
      });

      if (existingSoftDeleted) {
        await prisma.subProcess.delete({
          where: { id: existingSoftDeleted.id },
        });
      }
    }

    const doc = await prisma.subProcess.update({
      where: { id: req.params.id },
      data: req.body,
      include: includeSubProcess,
    });

    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    await prisma.subProcess.update({
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
    const result = await prisma.subProcess.updateMany({
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
    const { subProcesses } = req.body;

    if (!Array.isArray(subProcesses) || subProcesses.length === 0) {
      return res.status(400).json({ message: "subProcesses array required" });
    }

    const results = {
      success: [],
      failed: [],
      duplicates: [],
      total: subProcesses.length,
    };

    for (const subProcessData of subProcesses) {
      try {
        const processedData = {
          ...subProcessData,
          subProcessCode: subProcessData.subProcessCode
            ? subProcessData.subProcessCode.toUpperCase()
            : subProcessData.subProcessCode,
        };

        const existing = await prisma.subProcess.findUnique({
          where: { subProcessCode: processedData.subProcessCode },
        });

        if (existing && !existing.isDeleted) {
          results.duplicates.push({
            subProcessCode: processedData.subProcessCode,
            existingId: existing.id,
          });
          continue;
        }

        let doc;
        if (existing && existing.isDeleted) {
          doc = await prisma.subProcess.update({
            where: { id: existing.id },
            data: { ...processedData, isDeleted: false },
            include: includeSubProcess,
          });
        } else {
          doc = await prisma.subProcess.create({
            data: processedData,
            include: includeSubProcess,
          });
        }

        results.success.push(mapDoc(doc));
      } catch (error) {
        results.failed.push({ data: subProcessData, error: error.message });
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
    const { q, limit = 20, processId } = req.query;
    const where = { isDeleted: false };

    if (processId) {
      where.processId = processId;
    }

    if (q) {
      where.OR = [
        { subProcessCode: { contains: q, mode: "insensitive" } },
        { subProcessName: { contains: q, mode: "insensitive" } },
      ];
    }

    const items = await prisma.subProcess.findMany({
      where,
      select: {
        id: true,
        subProcessCode: true,
        subProcessName: true,
        processId: true,
        process: {
          select: {
            processCode: true,
            processName: true,
          },
        },
      },
      take: Number(limit),
      orderBy: { subProcessCode: "asc" },
    });

    res.json(items);
  } catch (e) {
    next(e);
  }
};
