const { prisma } = require("../../index");
const { Prisma } = require("@prisma/client");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const {
  incrementDiesShotCounter,
  decrementDiesShotCounter,
  adjustDiesShotCounter,
} = require("../../utils/diesShotCounter");

const USAGE_CHANGED_CONFLICT = "Data usage sudah diubah oleh proses lain. Silakan muat ulang lalu coba lagi.";
const USAGE_ALREADY_DELETED_CONFLICT = "Data usage sudah dihapus.";

// List usage records
exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      page = 1,
      limit = 20,
      diesId,
      diesCode,
      partId,
      referenceType,
      referenceNumber,
      machineCode,
      startDate,
      endDate
    } = req.query;

    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    if (diesId) {
      where.diesId = diesId;
    }

    if (partId) {
      where.partId = partId;
    }

    if (referenceType) {
      where.referenceType = referenceType;
    }

    if (referenceNumber) {
      where.referenceNumber = referenceNumber;
    }

    if (machineCode) {
      where.machineCode = machineCode;
    }

    if (startDate || endDate) {
      where.usageDate = {};
      if (startDate) {
        where.usageDate.gte = new Date(startDate);
      }
      if (endDate) {
        where.usageDate.lte = new Date(endDate);
      }
    }

    if (diesCode) {
      where.dies = {
        diesCode: diesCode
      };
    }

    if (q) {
      where.OR = [
        { referenceNumber: { contains: q, mode: "insensitive" } },
        { machineCode: { contains: q, mode: "insensitive" } },
        { operatorName: { contains: q, mode: "insensitive" } },
        { part: { partCode: { contains: q, mode: "insensitive" } } },
        { part: { partName: { contains: q, mode: "insensitive" } } },
      ];
    }

    const orderBy = buildSort(req.query, { defaultSort: { usageDate: 'desc' } });
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.diesUsage.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
        include: {
          dies: {
            select: {
              diesCode: true,
              diesName: true,
              diesNumber: true,
            }
          },
          part: {
            select: {
              partCode: true,
              partNumber: true,
              partName: true,
            }
          }
        }
      }),
      prisma.diesUsage.count({ where }),
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

// Get single usage record
exports.get = async (req, res, next) => {
  try {
    const doc = await prisma.diesUsage.findFirst({
      where: { id: req.params.id, isDeleted: false },
      include: {
        dies: {
          select: {
            id: true,
            diesCode: true,
            diesName: true,
            diesNumber: true,
            shotCounter: true,
          }
        },
        part: {
          select: {
            partCode: true,
            partNumber: true,
            partName: true,
          }
        }
      }
    });

    if (!doc) return res.status(404).json({ message: "Data usage tidak ditemukan." });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

// Create usage record (dan update shot counter)
exports.create = async (req, res, next) => {
  try {
    const { diesId, shotCount, ...usageData } = req.body;

    if (!shotCount || shotCount <= 0) {
      return res.status(400).json({ message: "shotCount required and must be > 0" });
    }

    // Start transaction
    const result = await prisma.$transaction(async (tx) => {
      // Get current dies
      const dies = await tx.dies.findUnique({
        where: { id: diesId },
      });

      if (!dies) {
        throw new Error("Dies not found");
      }

      // Create usage record
      const usage = await tx.diesUsage.create({
        data: {
          ...usageData,
          diesId,
          shotCount,
          usageDate: usageData.usageDate ? new Date(usageData.usageDate) : new Date(),
          startTime: usageData.startTime ? new Date(usageData.startTime) : null,
          endTime: usageData.endTime ? new Date(usageData.endTime) : null,
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
            }
          }
        }
      });

      // Update dies shot counter secara atomic
      await incrementDiesShotCounter(tx, diesId, shotCount);

      return usage;
    });

    res.status(201).json(mapDoc(result));
  } catch (e) {
    next(e);
  }
};

// Update usage record
exports.update = async (req, res, next) => {
  try {
    const { shotCount, diesId, ...usageData } = req.body;

    // Get current usage record
    const currentUsage = await prisma.diesUsage.findUnique({
      where: { id: req.params.id },
    });

    if (!currentUsage) {
      return res.status(404).json({ message: "Usage record not found" });
    }

    if (currentUsage.isDeleted) {
      return res.status(409).json({ message: USAGE_ALREADY_DELETED_CONFLICT });
    }

    // Start transaction jika shotCount berubah
    if (shotCount !== undefined && shotCount !== currentUsage.shotCount) {
      const result = await prisma.$transaction(async (tx) => {
        // Calculate shot difference
        const shotDiff = shotCount - currentUsage.shotCount;

        // Optimistic lock: hanya update jika shotCount lama masih sama
        const updated = await tx.diesUsage.updateMany({
          where: {
            id: req.params.id,
            isDeleted: false,
            shotCount: currentUsage.shotCount,
          },
          data: {
            ...usageData,
            shotCount,
            usageDate: usageData.usageDate ? new Date(usageData.usageDate) : undefined,
            startTime: usageData.startTime ? new Date(usageData.startTime) : undefined,
            endTime: usageData.endTime ? new Date(usageData.endTime) : undefined,
          },
        });

        if (updated.count === 0) {
          throw new Error(USAGE_CHANGED_CONFLICT);
        }

        // Update dies shot counter secara atomic
        await adjustDiesShotCounter(tx, currentUsage.diesId, shotDiff);

        const usage = await tx.diesUsage.findUnique({
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
              }
            }
          }
        });

        return usage;
      });

      res.json(mapDoc(result));
    } else {
      // Jika shotCount tidak berubah, update biasa
      const updated = await prisma.diesUsage.updateMany({
        where: { id: req.params.id, isDeleted: false },
        data: {
          ...usageData,
          usageDate: usageData.usageDate ? new Date(usageData.usageDate) : undefined,
          startTime: usageData.startTime ? new Date(usageData.startTime) : undefined,
          endTime: usageData.endTime ? new Date(usageData.endTime) : undefined,
        },
      });

      if (updated.count === 0) {
        return res.status(409).json({ message: USAGE_ALREADY_DELETED_CONFLICT });
      }

      const doc = await prisma.diesUsage.findUnique({
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
            }
          }
        }
      });

      res.json(mapDoc(doc));
    }
  } catch (e) {
    if (e.message === USAGE_CHANGED_CONFLICT) {
      return res.status(409).json({ message: e.message });
    }
    next(e);
  }
};

// Soft delete usage record
exports.remove = async (req, res, next) => {
  try {
    const usage = await prisma.diesUsage.findUnique({
      where: { id: req.params.id },
      select: { id: true, isDeleted: true },
    });

    if (!usage) return res.status(404).json({ message: "Data usage tidak ditemukan" });
    if (usage.isDeleted) return res.status(409).json({ message: USAGE_ALREADY_DELETED_CONFLICT });

    // Start transaction untuk soft delete dan adjust shot counter
    await prisma.$transaction(async (tx) => {
      // Soft delete usage hanya jika belum deleted
      const usageRows = await tx.$queryRaw`
        UPDATE tbl_dies_usage
        SET is_deleted = true
        WHERE id = ${req.params.id}
          AND is_deleted = false
        RETURNING dies_id, shot_count
      `;

      if (!usageRows.length) {
        throw new Error(USAGE_ALREADY_DELETED_CONFLICT);
      }

      // Reduce shot counter secara atomic (tidak boleh minus)
      await decrementDiesShotCounter(tx, usageRows[0].dies_id, usageRows[0].shot_count);
    });

    res.json({ ok: true });
  } catch (e) {
    if (e.message === USAGE_ALREADY_DELETED_CONFLICT) {
      return res.status(409).json({ message: e.message });
    }
    next(e);
  }
};

// Bulk remove
exports.bulkRemove = async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids array required" });
    }

    let deletedCount = 0;

    // Start transaction
    await prisma.$transaction(async (tx) => {
      // Soft delete dan ambil rows yang benar-benar terupdate
      const usageRows = await tx.$queryRaw`
        UPDATE tbl_dies_usage
        SET is_deleted = true
        WHERE id IN (${Prisma.join(ids)})
          AND is_deleted = false
        RETURNING id, dies_id, shot_count
      `;

      deletedCount = usageRows.length;

      if (!usageRows.length) {
        return;
      }

      // Group by diesId and sum shotCount
      const diesUpdates = {};
      for (const row of usageRows) {
        if (!diesUpdates[row.dies_id]) {
          diesUpdates[row.dies_id] = 0;
        }
        diesUpdates[row.dies_id] += row.shot_count;
      }

      // Update each dies shot counter secara atomic
      for (const [diesId, totalShots] of Object.entries(diesUpdates)) {
        await decrementDiesShotCounter(tx, diesId, totalShots);
      }
    });

    res.json({ deletedCount });
  } catch (e) {
    next(e);
  }
};

// Get usage history for a dies
exports.history = async (req, res, next) => {
  try {
    const { diesId } = req.params;
    const { limit = 20 } = req.query;

    const items = await prisma.diesUsage.findMany({
      where: {
        diesId,
        isDeleted: false,
      },
      orderBy: { usageDate: 'desc' },
      take: Number(limit),
      include: {
        part: {
          select: {
            partCode: true,
            partNumber: true,
            partName: true,
          }
        }
      }
    });

    res.json(items.map(mapDoc));
  } catch (e) {
    next(e);
  }
};

// Get usage summary for a dies
exports.summary = async (req, res, next) => {
  try {
    const { diesId } = req.params;
    const { startDate, endDate } = req.query;

    const where = {
      diesId,
      isDeleted: false,
    };

    if (startDate || endDate) {
      where.usageDate = {};
      if (startDate) {
        where.usageDate.gte = new Date(startDate);
      }
      if (endDate) {
        where.usageDate.lte = new Date(endDate);
      }
    }

    const summary = await prisma.diesUsage.aggregate({
      where,
      _sum: {
        shotCount: true,
        qtyProduced: true,
        qtyGood: true,
        qtyReject: true,
        runningMinutes: true,
      },
      _count: {
        id: true,
      },
    });

    // Calculate efficiency
    const totalProduced = summary._sum.qtyProduced || 0;
    const totalGood = summary._sum.qtyGood || 0;
    const totalReject = summary._sum.qtyReject || 0;
    const efficiency = totalProduced > 0 ? (totalGood / totalProduced) * 100 : 0;

    res.json({
      totalUsages: summary._count.id,
      totalShots: summary._sum.shotCount || 0,
      totalProduced,
      totalGood,
      totalReject,
      efficiency: Math.round(efficiency * 100) / 100,
      totalRunningMinutes: summary._sum.runningMinutes || 0,
    });
  } catch (e) {
    next(e);
  }
};
