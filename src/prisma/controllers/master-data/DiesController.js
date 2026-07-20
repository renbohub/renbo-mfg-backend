const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { incrementDiesShotCounter, resetDiesShotCounter } = require("../../utils/diesShotCounter");
const { deleteDiesFile } = require("../../middleware/uploads");
const { convertNumericFields } = require("../../utils/numericConverter");
const { parseFilter } = require("../../utils/parseFilter");

// Field-field Die yang tipenya bukan string di schema Prisma
const DIES_NUMERIC_FIELDS = [
  'shotCounter', 'maxShotLifetime',
  'purchaseCost', 'depreciationRate',
  'maintenanceInterval',
  'cavity', 'tonnage', 'cycleTime',
];
const DIES_BOOLEAN_FIELDS = ['isDeleted'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Parse JSON string ke value; return fallback jika bukan string atau gagal parse
const parseJsonField = (value, fallback = null) => {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

// Map file upload ke file record berdasarkan subdir field
const toDiesFileRecord = (fieldname, f) => ({
  fileName: f.originalname,
  fileUrl: `/uploads/dies/${fieldname}/${f.filename}`,
  fileType: f.mimetype,
  fileSize: f.size,
});

// Hapus semua file dari sebuah JSON array field
const deleteJsonFiles = (arr) => {
  if (!Array.isArray(arr)) return;
  arr.forEach((item) => { if (item?.fileUrl) deleteDiesFile(item.fileUrl); });
};

// Hitung field JSON foto akhir: pertahankan yang ada di keptUrls, hapus sisanya
const resolveFileField = (dbArray, keptUrlsRaw, newFiles) => {
  const db = Array.isArray(dbArray) ? dbArray : [];
  const keptUrls = Array.isArray(keptUrlsRaw) ? keptUrlsRaw : db.map((f) => f.fileUrl);
  db.filter((f) => !keptUrls.includes(f.fileUrl)).forEach((f) => deleteDiesFile(f.fileUrl));
  const remaining = db.filter((f) => keptUrls.includes(f.fileUrl));
  return [...remaining, ...newFiles];
};

// Sanitasi data dari multipart form (semua nilai datang sebagai string)
const sanitizeDiesData = (data) => {
  let d = convertNumericFields(data, DIES_NUMERIC_FIELDS);
  DIES_BOOLEAN_FIELDS.forEach((field) => {
    if (d[field] !== undefined) d[field] = d[field] === true || d[field] === 'true';
  });
  return d;
};

exports.generateCode = async (req, res, next) => {
  try {
    // Ambil semua dies codes
    const diesList = await prisma.dies.findMany({
      select: {
        diesCode: true,
      },
    });

    // Parse semua codes jadi number, filter yang valid, dan sort
    const existingNumbers = diesList
      .map((d) => parseInt(d.diesCode))
      .filter((num) => !isNaN(num))
      .sort((a, b) => a - b);

    // Cari gap pertama dalam sequence
    let nextNumber = 1;
    for (const num of existingNumbers) {
      if (num === nextNumber) {
        nextNumber++;
      } else if (num > nextNumber) {
        // Found a gap
        break;
      }
    }

    const diesCode = String(nextNumber).padStart(3, "0");

    res.json({ diesCode });
  } catch (e) {
    next(e);
  }
};

exports.getAllCodes = async (req, res, next) => {
  try {
    // Fetch semua dies codes yang tidak soft deleted
    const diesList = await prisma.dies.findMany({
      where: { isDeleted: false },
      select: {
        diesCode: true,
      },
      orderBy: { diesCode: "asc" },
    });

    // Return array of dies codes
    const codes = diesList.map((d) => d.diesCode);
    res.json(codes);
  } catch (e) {
    next(e);
  }
};

exports.list = async (req, res, next) => {
  try {
    const { 
      q, 
      isDeleted, 
      page = 1, 
      limit = 20,
      ownerType,
      customerCode,
      category,
      status,
      warehouseCode
    } = req.query;
    
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    if (ownerType) {
      where.ownerType = ownerType;
    }

    if (customerCode) {
      where.customerCode = customerCode;
    }

    if (category) {
      where.category = category;
    }

    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;

    if (warehouseCode) {
      where.warehouseCode = warehouseCode;
    }

    if (q) {
      where.OR = [
        { diesCode: { contains: q, mode: "insensitive" } },
        { diesNumber: { contains: q, mode: "insensitive" } },
        { diesName: { contains: q, mode: "insensitive" } },
        { location: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.dies.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
        include: {
          diesParts: {
            where: { isActive: true },
            include: {
              part: {
                select: {
                  partCode: true,
                  partNumber: true,
                  partName: true,
                }
              }
            },
            orderBy: { isPrimary: 'desc' }
          }
        }
      }),
      prisma.dies.count({ where }),
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
    const doc = await prisma.dies.findFirst({
      where: { diesCode: req.params.diesCode, isDeleted: false },
      include: {
        diesParts: {
          include: {
            part: {
              select: {
                partCode: true,
                partNumber: true,
                partName: true,
                category: true,
              }
            }
          },
          orderBy: [
            { isPrimary: 'desc' },
            { effectiveDate: 'desc' }
          ]
        },
        maintenances: {
          orderBy: { maintenanceDate: 'desc' },
          take: 5
        },
        usages: {
          orderBy: { usageDate: 'desc' },
          take: 10
        }
      }
    });
    
    if (!doc) return res.status(404).json({ message: "Dies not found" });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { diesParts, existingPhotos, existingDrawings, existingSpecs, ...rawData } = req.body;
    const diesData = sanitizeDiesData(rawData);

    // Pasang file uploads ke JSON field masing-masing
    if (req.files?.photos?.length > 0)
      diesData.photos = req.files.photos.map((f) => toDiesFileRecord('photos', f));
    if (req.files?.drawings?.length > 0)
      diesData.drawings = req.files.drawings.map((f) => toDiesFileRecord('drawings', f));
    if (req.files?.specs?.length > 0)
      diesData.specs = req.files.specs.map((f) => toDiesFileRecord('specs', f));

    // Cek apakah dies dengan diesCode yang sama sudah ada dan soft deleted
    const existing = await prisma.dies.findUnique({
      where: { diesCode: diesData.diesCode },
    });

    let doc;
    if (existing && existing.isDeleted) {
      // Hapus file lama sebelum restore
      deleteJsonFiles(existing.photos);
      deleteJsonFiles(existing.drawings);
      deleteJsonFiles(existing.specs);
      doc = await prisma.dies.update({
        where: { id: existing.id },
        data: { ...diesData, isDeleted: false },
      });
    } else {
      doc = await prisma.dies.create({
        data: {
          ...diesData,
          diesParts: diesParts?.length > 0 ? {
            create: diesParts.map(dp => ({
              partId: dp.partId,
              isPrimary: dp.isPrimary || false,
              isActive: dp.isActive !== false,
              effectiveDate: dp.effectiveDate ? new Date(dp.effectiveDate) : new Date(),
              expiryDate: dp.expiryDate ? new Date(dp.expiryDate) : null,
              expectedOutput: dp.expectedOutput,
              notes: dp.notes
            }))
          } : undefined
        },
        include: {
          diesParts: {
            include: {
              part: { select: { partCode: true, partNumber: true, partName: true } }
            }
          }
        }
      });
    }

    res.status(201).json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const { diesParts, existingPhotos, existingDrawings, existingSpecs, ...rawData } = req.body;
    const diesData = sanitizeDiesData(rawData);

    // Cek current dies
    const currentDies = await prisma.dies.findUnique({
      where: { id: req.params.id },
    });

    if (!currentDies) {
      return res.status(404).json({ message: "Dies not found" });
    }

    // Jika diesCode berubah, cek apakah ada dies soft deleted dengan code yang sama
    if (diesData.diesCode && diesData.diesCode !== currentDies.diesCode) {
      const existingSoftDeleted = await prisma.dies.findFirst({
        where: { diesCode: diesData.diesCode, isDeleted: true },
      });
      if (existingSoftDeleted) {
        await prisma.dies.delete({ where: { id: existingSoftDeleted.id } });
      }
    }

    // Hitung field akhir: existing yang dipertahankan + file baru
    diesData.photos = resolveFileField(
      currentDies.photos,
      parseJsonField(existingPhotos, null),
      (req.files?.photos ?? []).map((f) => toDiesFileRecord('photos', f))
    );
    diesData.drawings = resolveFileField(
      currentDies.drawings,
      parseJsonField(existingDrawings, null),
      (req.files?.drawings ?? []).map((f) => toDiesFileRecord('drawings', f))
    );
    diesData.specs = resolveFileField(
      currentDies.specs,
      parseJsonField(existingSpecs, null),
      (req.files?.specs ?? []).map((f) => toDiesFileRecord('specs', f))
    );

    const doc = await prisma.dies.update({
      where: { id: req.params.id },
      data: diesData,
      include: {
        diesParts: {
          include: {
            part: { select: { partCode: true, partNumber: true, partName: true } }
          }
        }
      }
    });

    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

// Soft delete
exports.remove = async (req, res, next) => {
  try {
    const dies = await prisma.dies.findUnique({
      where: { id: req.params.id },
      select: { photos: true, drawings: true, specs: true },
    });
    const doc = await prisma.dies.update({
      where: { id: req.params.id },
      data: { isDeleted: true },
    });
    if (!doc) return res.status(404).json({ message: "Dies not found" });
    if (dies) {
      deleteJsonFiles(dies.photos);
      deleteJsonFiles(dies.drawings);
      deleteJsonFiles(dies.specs);
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
    const records = await prisma.dies.findMany({
      where: { id: { in: ids } },
      select: { photos: true, drawings: true, specs: true },
    });
    records.forEach((r) => {
      deleteJsonFiles(r.photos);
      deleteJsonFiles(r.drawings);
      deleteJsonFiles(r.specs);
    });
    const result = await prisma.dies.updateMany({
      where: { id: { in: ids } },
      data: { isDeleted: true },
    });
    res.json({ deletedCount: result.count });
  } catch (e) {
    next(e);
  }
};

exports.autocomplete = async (req, res, next) => {
  try {
    const { q, limit = 10, status = 'Active' } = req.query;
    const where = { isDeleted: false };

    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;

    if (q) {
      where.OR = [
        { diesCode: { contains: q, mode: "insensitive" } },
        { diesNumber: { contains: q, mode: "insensitive" } },
        { diesName: { contains: q, mode: "insensitive" } },
      ];
    }

    const items = await prisma.dies.findMany({
      where,
      select: {
        id: true,
        diesCode: true,
        diesNumber: true,
        diesName: true,
        status: true,
        cavity: true,
      },
      take: Number(limit),
      orderBy: { diesCode: "asc" },
    });

    res.json(items);
  } catch (e) {
    next(e);
  }
};

exports.stats = async (req, res, next) => {
  try {
    // Count total dan active dies
    const [total, active, deleted] = await Promise.all([
      prisma.dies.count(),
      prisma.dies.count({ where: { isDeleted: false } }),
      prisma.dies.count({ where: { isDeleted: true } }),
    ]);

    // Count by status
    const byStatus = await prisma.dies.groupBy({
      by: ["status"],
      where: { isDeleted: false },
      _count: { status: true },
    });

    // Count by ownerType
    const byOwner = await prisma.dies.groupBy({
      by: ["ownerType"],
      where: { isDeleted: false },
      _count: { ownerType: true },
    });

    // Dies yang perlu maintenance (nextMaintenanceDate <= 30 hari dari sekarang)
    const thirtyDaysFromNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const needsMaintenance = await prisma.dies.count({
      where: {
        isDeleted: false,
        nextMaintenanceDate: {
          lte: thirtyDaysFromNow,
        },
      },
    });

    // Dies dengan shot counter mendekati limit (>= 80% dari maxShotLifetime)
    const diesNearLimit = await prisma.$queryRaw`
      SELECT COUNT(*)::integer as count
      FROM tbl_dies
      WHERE is_deleted = false
        AND max_shot_lifetime IS NOT NULL
        AND shot_counter >= (max_shot_lifetime * 0.8)
    `;

    // Average shot counter
    const avgShots = await prisma.dies.aggregate({
      where: { isDeleted: false },
      _avg: { shotCounter: true },
    });

    // Total maintenance cost (last 12 months)
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const maintenanceCost = await prisma.diesMaintenance.aggregate({
      where: {
        isDeleted: false,
        maintenanceDate: { gte: oneYearAgo },
      },
      _sum: { cost: true },
    });

    // Recent maintenances
    const recentMaintenances = await prisma.diesMaintenance.findMany({
      where: { isDeleted: false },
      select: {
        maintenanceNumber: true,
        maintenanceDate: true,
        maintenanceType: true,
        cost: true,
        dies: {
          select: {
            diesCode: true,
            diesName: true,
          }
        }
      },
      orderBy: { maintenanceDate: "desc" },
      take: 10,
    });

    res.json({
      total,
      active,
      deleted,
      byStatus: byStatus.map(s => ({ status: s.status, count: s._count.status })),
      byOwner: byOwner.map(o => ({ ownerType: o.ownerType, count: o._count.ownerType })),
      needsMaintenance,
      nearShotLimit: diesNearLimit[0]?.count || 0,
      avgShotCounter: Math.round(avgShots._avg.shotCounter || 0),
      totalMaintenanceCost: maintenanceCost._sum.cost || 0,
      recentMaintenances: recentMaintenances.map(mapDoc),
    });
  } catch (e) {
    next(e);
  }
};

// Update shot counter (dipanggil setelah production)
exports.updateShotCounter = async (req, res, next) => {
  try {
    const { shotCount } = req.body;

    if (!shotCount || shotCount <= 0) {
      return res.status(400).json({ message: "shotCount required and must be > 0" });
    }

    const dies = await prisma.dies.findUnique({
      where: { id: req.params.id },
    });

    if (!dies) {
      return res.status(404).json({ message: "Dies not found" });
    }

    await incrementDiesShotCounter(prisma, req.params.id, shotCount);

    const doc = await prisma.dies.findUnique({
      where: { id: req.params.id },
    });

    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

// Reset shot counter (biasanya setelah overhaul)
exports.resetShotCounter = async (req, res, next) => {
  try {
    await resetDiesShotCounter(prisma, req.params.id);

    const doc = await prisma.dies.findUnique({
      where: { id: req.params.id },
    });

    if (!doc) return res.status(404).json({ message: "Dies not found" });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};
