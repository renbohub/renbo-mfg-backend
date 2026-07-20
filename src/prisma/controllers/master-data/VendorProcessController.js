const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");

const normalizeText = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
};

const buildVendorProcessData = (body = {}, { partial = false } = {}) => {
  const data = {};
  const fields = ["vendorProcessCode", "vendorProcessName", "category", "notes", "isDeleted"];

  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      data[field] = field === "isDeleted" ? Boolean(body[field]) : normalizeText(body[field]);
    }
  });

  if (!partial) {
    if (!data.vendorProcessCode) {
      const error = new Error("vendorProcessCode is required");
      error.statusCode = 400;
      throw error;
    }
    if (!data.vendorProcessName) {
      const error = new Error("vendorProcessName is required");
      error.statusCode = 400;
      throw error;
    }
  }

  return data;
};

const getVendorProcessCodeCandidates = (rawValue) => {
  if (!rawValue || typeof rawValue !== "string") return [];

  const decoded = decodeURIComponent(rawValue).trim();
  if (!decoded) return [];

  return [...new Set([decoded])];
};

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
        { vendorProcessCode: { contains: q, mode: "insensitive" } },
        { vendorProcessName: { contains: q, mode: "insensitive" } },
        { category: { contains: q, mode: "insensitive" } },
        { notes: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.vendorProcess.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.vendorProcess.count({ where }),
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
    const candidates = getVendorProcessCodeCandidates(req.params.vendorProcessCode);

    const doc = await prisma.vendorProcess.findFirst({
      where: { vendorProcessCode: { in: candidates }, isDeleted: false },
    });
    if (!doc) return res.status(404).json({ message: "VendorProcess not found" });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const doc = await prisma.vendorProcess.create({
      data: buildVendorProcessData(req.body),
    });

    res.status(201).json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const currentVendorProcess = await prisma.vendorProcess.findUnique({
      where: { id: req.params.id },
    });

    if (!currentVendorProcess) {
      return res.status(404).json({ message: "VendorProcess not found" });
    }

    const doc = await prisma.vendorProcess.update({
      where: { id: req.params.id },
      data: buildVendorProcessData(req.body, { partial: true }),
    });

    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    await prisma.vendorProcess.update({
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
    const result = await prisma.vendorProcess.updateMany({
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
    const { vendorProcesses } = req.body;

    if (!Array.isArray(vendorProcesses) || vendorProcesses.length === 0) {
      return res.status(400).json({ message: "vendorProcesses array required" });
    }

    const success = [];
    const failed = [];
    const duplicates = [];

    for (const [index, process] of vendorProcesses.entries()) {
      try {
        const data = buildVendorProcessData(process);
        const existing = await prisma.vendorProcess.findFirst({
          where: { vendorProcessCode: data.vendorProcessCode },
        });

        if (existing) {
          duplicates.push({ row: index + 1, vendorProcessCode: data.vendorProcessCode, data });
          continue;
        }

        const vendorProcess = await prisma.vendorProcess.create({ data });
        success.push(mapDoc(vendorProcess));
      } catch (error) {
        failed.push({
          row: index + 1,
          data: process,
          error: error.message || "Failed to create vendor process",
        });
      }
    }

    res.status(201).json({
      total: vendorProcesses.length,
      success,
      failed,
      duplicates,
      created: success.length,
      items: success,
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
        { vendorProcessCode: { contains: q, mode: "insensitive" } },
        { vendorProcessName: { contains: q, mode: "insensitive" } },
        { category: { contains: q, mode: "insensitive" } },
      ];
    }

    const items = await prisma.vendorProcess.findMany({
      where,
      select: {
        id: true,
        vendorProcessCode: true,
        vendorProcessName: true,
        category: true,
      },
      take: Number(limit),
      orderBy: { vendorProcessName: "asc" },
    });

    res.json(items);
  } catch (e) {
    next(e);
  }
};