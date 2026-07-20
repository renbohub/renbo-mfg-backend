const { prisma } = require("../../index");
const { Prisma } = require("@prisma/client");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");

// Pesan konflik standar
const ACTIVE_RELATION_CONFLICT = "Relasi aktif Dies-Part sudah ada. Nonaktifkan relasi lama atau update relasi yang ada.";
const ACTIVE_RELATION_CONFLICT_UPDATE = "Relasi aktif Dies-Part sudah ada. Nonaktifkan relasi aktif lain terlebih dahulu.";
const ALREADY_INACTIVE_CONFLICT = "Relasi Dies-Part sudah nonaktif.";

exports.list = async (req, res, next) => {
  try {
    const { q, diesId, partId, isActive, page = 1, limit = 20 } = req.query;
    const where = {};

    // Optional filter by diesId
    if (diesId) {
      where.diesId = diesId;
    }

    // Optional filter by partId
    if (partId) {
      where.partId = partId;
    }

    // Default: tampilkan semua (aktif & nonaktif), kecuali eksplisit filter isActive
    if (isActive !== undefined) {
      where.isActive = isActive === "true";
    }

    if (q) {
      where.OR = [
        { dies: { diesCode: { contains: q, mode: "insensitive" } } },
        { dies: { diesName: { contains: q, mode: "insensitive" } } },
        { part: { partCode: { contains: q, mode: "insensitive" } } },
        { part: { partNumber: { contains: q, mode: "insensitive" } } },
        { part: { partName: { contains: q, mode: "insensitive" } } },
        { notes: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.diesPart.findMany({
        where,
        include: {
          dies: {
            select: {
              diesCode: true,
              diesName: true,
            }
          },
          part: {
            select: {
              partCode: true,
              partNumber: true,
              partName: true,
              category: true,
            }
          }
        },
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.diesPart.count({ where }),
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
    const doc = await prisma.diesPart.findUnique({
      where: { id: req.params.id },
      include: {
        dies: {
          select: {
            diesCode: true,
            diesName: true,
          }
        },
        part: {
          select: {
            partCode: true,
            partNumber: true,
            partName: true,
            category: true,
          }
        }
      }
    });

    if (!doc) return res.status(404).json({ message: "Data relasi Dies-Part tidak ditemukan." });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    // Cek apakah sudah ada relasi aktif Dies-Part dengan kombinasi diesId dan partId yang sama
    if (req.body.isActive !== false) {
      const existing = await prisma.diesPart.findFirst({
        where: {
          diesId: req.body.diesId,
          partId: req.body.partId,
          isActive: true,
        },
      });
      if (existing) {
        return res.status(409).json({ message: ACTIVE_RELATION_CONFLICT });
      }
    }

    const doc = await prisma.diesPart.create({
      data: {
        ...req.body,
        effectiveDate: req.body.effectiveDate ? new Date(req.body.effectiveDate) : new Date(),
        expiryDate: req.body.expiryDate ? new Date(req.body.expiryDate) : null,
      },
      include: {
        dies: {
          select: {
            diesCode: true,
            diesName: true,
          }
        },
        part: {
          select: {
            partCode: true,
            partNumber: true,
            partName: true,
            category: true,
          }
        }
      }
    });

    res.status(201).json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const updateData = { ...req.body };
    
    if (req.body.effectiveDate) {
      updateData.effectiveDate = new Date(req.body.effectiveDate);
    }
    
    if (req.body.expiryDate) {
      updateData.expiryDate = new Date(req.body.expiryDate);
    }

    // Jika update mengaktifkan relasi, cek duplikasi aktif pada diesId+partId yang sama
    if (req.body.isActive === true) {
      const current = await prisma.diesPart.findUnique({
        where: { id: req.params.id },
        select: { diesId: true, partId: true },
      });
      if (current) {
        const diesId = req.body.diesId || current.diesId;
        const partId = req.body.partId || current.partId;
        const duplicate = await prisma.diesPart.findFirst({
          where: {
            diesId,
            partId,
            isActive: true,
            NOT: { id: req.params.id },
          },
        });
        if (duplicate) {
          return res.status(409).json({ message: ACTIVE_RELATION_CONFLICT_UPDATE });
        }
      }
    }

    const doc = await prisma.diesPart.update({
      where: { id: req.params.id },
      data: updateData,
      include: {
        dies: {
          select: {
            diesCode: true,
            diesName: true,
          }
        },
        part: {
          select: {
            partCode: true,
            partNumber: true,
            partName: true,
            category: true,
          }
        }
      }
    });

    res.json(mapDoc(doc));
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return res.status(404).json({ message: "Data relasi Dies-Part tidak ditemukan." });
    }
    next(e);
  }
};

// Deaktivasi relasi (bukan hapus fisik — histori tetap tersimpan)
exports.remove = async (req, res, next) => {
  try {
    const existing = await prisma.diesPart.findUnique({
      where: { id: req.params.id },
      select: { id: true, isActive: true },
    });

    if (!existing) {
      return res.status(404).json({ message: "Data relasi Dies-Part tidak ditemukan." });
    }

    if (!existing.isActive) {
      return res.status(409).json({ message: ALREADY_INACTIVE_CONFLICT });
    }

    // Guard race condition: hanya deaktivasi jika isActive masih true
    const result = await prisma.diesPart.updateMany({
      where: { id: req.params.id, isActive: true },
      data: { isActive: false },
    });

    if (result.count === 0) {
      return res.status(409).json({ message: ALREADY_INACTIVE_CONFLICT });
    }

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

    // Deaktivasi massal — histori tetap tersimpan
    const result = await prisma.diesPart.updateMany({
      where: { id: { in: ids }, isActive: true },
      data: { isActive: false },
    });

    res.json({ deactivatedCount: result.count });
  } catch (e) {
    next(e);
  }
};
