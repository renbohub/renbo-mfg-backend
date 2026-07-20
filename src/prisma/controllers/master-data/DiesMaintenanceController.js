const { prisma } = require("../../index");
const { Prisma } = require("@prisma/client");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { resetDiesShotCounter } = require("../../utils/diesShotCounter");

const MAINTENANCE_NUMBER_CONFLICT = "Nomor maintenance sudah digunakan.";
const MAINTENANCE_ALREADY_DELETED_CONFLICT = "Data maintenance sudah dihapus.";

// Generate maintenance number
exports.generateNumber = async (req, res, next) => {
  try {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const prefix = `MNT-${year}${month}`;

    // Find last maintenance number with this prefix
    const lastMaintenance = await prisma.diesMaintenance.findFirst({
      where: {
        maintenanceNumber: {
          startsWith: prefix,
        },
      },
      orderBy: {
        maintenanceNumber: "desc",
      },
    });

    let sequence = 1;
    if (lastMaintenance) {
      const lastSequence = parseInt(
        lastMaintenance.maintenanceNumber.split("-")[2],
      );
      if (!isNaN(lastSequence)) {
        sequence = lastSequence + 1;
      }
    }

    const maintenanceNumber = `${prefix}-${String(sequence).padStart(4, "0")}`;
    res.json({ maintenanceNumber });
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      return res.status(409).json({ message: MAINTENANCE_NUMBER_CONFLICT });
    }
    next(e);
  }
};

// List maintenance records
exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      page = 1,
      limit = 20,
      diesId,
      diesCode,
      maintenanceNumber,
      maintenanceType,
      vendorCode,
      startDate,
      endDate,
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

    if (maintenanceNumber) {
      where.maintenanceNumber = {
        contains: maintenanceNumber,
        mode: "insensitive",
      };
    }

    if (maintenanceType) {
      where.maintenanceType = maintenanceType;
    }

    if (vendorCode) {
      where.vendorCode = vendorCode;
    }

    if (startDate || endDate) {
      where.maintenanceDate = {};
      if (startDate) {
        where.maintenanceDate.gte = new Date(startDate);
      }
      if (endDate) {
        where.maintenanceDate.lte = new Date(endDate);
      }
    }

    if (diesCode) {
      where.dies = {
        diesCode: diesCode,
      };
    }

    if (q) {
      where.OR = [
        { maintenanceNumber: { contains: q, mode: "insensitive" } },
        { workDescription: { contains: q, mode: "insensitive" } },
        { performedBy: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query, {
      fieldMap: {
        diesCode: "dies.diesCode",
        diesName: "dies.diesName",
        diesNumber: "dies.diesNumber",
      },
      defaultSort: { maintenanceDate: "desc" },
    });
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.diesMaintenance.findMany({
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
            },
          },
        },
      }),
      prisma.diesMaintenance.count({ where }),
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

// Get single maintenance record
exports.get = async (req, res, next) => {
  try {
    const doc = await prisma.diesMaintenance.findFirst({
      where: {
        maintenanceNumber: req.params.maintenanceNumber,
        isDeleted: false,
      },
      include: {
        dies: {
          select: {
            id: true,
            diesCode: true,
            diesName: true,
            diesNumber: true,
            shotCounter: true,
          },
        },
      },
    });

    if (!doc)
      return res.status(404).json({ message: "Maintenance record not found" });
    res.json(mapDoc(doc));
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      return res.status(409).json({ message: MAINTENANCE_NUMBER_CONFLICT });
    }
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2025"
    ) {
      return res
        .status(404)
        .json({ message: "Data maintenance tidak ditemukan" });
    }
    next(e);
  }
};

// Create maintenance record
exports.create = async (req, res, next) => {
  try {
    const { diesId, shotCounterReset, ...maintenanceData } = req.body;

    // Start transaction
    const result = await prisma.$transaction(async (tx) => {
      // Get current dies info
      const dies = await tx.dies.findUnique({
        where: { id: diesId },
      });

      if (!dies) {
        throw new Error("Dies not found");
      }

      // Create maintenance record
      const maintenance = await tx.diesMaintenance.create({
        data: {
          ...maintenanceData,
          diesId,
          shotCounterReset: Boolean(shotCounterReset),
          shotCounterBefore: dies.shotCounter,
          statusBefore: dies.status,
          maintenanceDate: maintenanceData.maintenanceDate
            ? new Date(maintenanceData.maintenanceDate)
            : new Date(),
          startDate: maintenanceData.startDate
            ? new Date(maintenanceData.startDate)
            : null,
          endDate: maintenanceData.endDate
            ? new Date(maintenanceData.endDate)
            : null,
          nextMaintenanceDate: maintenanceData.nextMaintenanceDate
            ? new Date(maintenanceData.nextMaintenanceDate)
            : null,
        },
        include: {
          dies: {
            select: {
              diesCode: true,
              diesName: true,
            },
          },
        },
      });

      // Reset shot counter jika diminta
      if (shotCounterReset) {
        await resetDiesShotCounter(tx, diesId);
      }

      // Update data dies lain jika dibutuhkan
      const diesUpdate = {};

      // Update last maintenance date
      diesUpdate.lastMaintenanceDate = maintenance.maintenanceDate;

      // Update next maintenance date if provided
      if (maintenanceData.nextMaintenanceDate) {
        diesUpdate.nextMaintenanceDate = new Date(
          maintenanceData.nextMaintenanceDate,
        );
      }

      // Update status if provided
      if (maintenanceData.statusAfter) {
        diesUpdate.status = maintenanceData.statusAfter;
      }

      if (Object.keys(diesUpdate).length > 0) {
        await tx.dies.update({
          where: { id: diesId },
          data: diesUpdate,
        });
      }

      return maintenance;
    });

    res.status(201).json(mapDoc(result));
  } catch (e) {
    next(e);
  }
};

// Update maintenance record
exports.update = async (req, res, next) => {
  try {
    const doc = await prisma.diesMaintenance.update({
      where: { maintenanceNumber: req.params.maintenanceNumber },
      data: {
        ...req.body,
        maintenanceDate: req.body.maintenanceDate
          ? new Date(req.body.maintenanceDate)
          : undefined,
        startDate: req.body.startDate
          ? new Date(req.body.startDate)
          : undefined,
        endDate: req.body.endDate ? new Date(req.body.endDate) : undefined,
        nextMaintenanceDate: req.body.nextMaintenanceDate
          ? new Date(req.body.nextMaintenanceDate)
          : undefined,
      },
      include: {
        dies: {
          select: {
            diesCode: true,
            diesName: true,
          },
        },
      },
    });

    if (!doc)
      return res.status(404).json({ message: "Maintenance record not found" });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

// Soft delete maintenance record
exports.remove = async (req, res, next) => {
  try {
    const current = await prisma.diesMaintenance.findUnique({
      where: { maintenanceNumber: req.params.maintenanceNumber },
      select: { maintenanceNumber: true, isDeleted: true },
    });

    if (!current)
      return res
        .status(404)
        .json({ message: "Data maintenance tidak ditemukan" });
    if (current.isDeleted)
      return res
        .status(409)
        .json({ message: MAINTENANCE_ALREADY_DELETED_CONFLICT });

    const updated = await prisma.diesMaintenance.updateMany({
      where: {
        maintenanceNumber: req.params.maintenanceNumber,
        isDeleted: false,
      },
      data: { isDeleted: true },
    });

    if (updated.count === 0) {
      return res
        .status(409)
        .json({ message: MAINTENANCE_ALREADY_DELETED_CONFLICT });
    }

    res.json({ ok: true });
  } catch (e) {
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
    const result = await prisma.diesMaintenance.updateMany({
      where: { id: { in: ids }, isDeleted: false },
      data: { isDeleted: true },
    });
    res.json({ deletedCount: result.count });
  } catch (e) {
    next(e);
  }
};

// Get maintenance history for a dies
exports.history = async (req, res, next) => {
  try {
    const { diesId } = req.params;
    const { limit = 20 } = req.query;

    const items = await prisma.diesMaintenance.findMany({
      where: {
        diesId,
        isDeleted: false,
      },
      orderBy: { maintenanceDate: "desc" },
      take: Number(limit),
    });

    res.json(items.map(mapDoc));
  } catch (e) {
    next(e);
  }
};
