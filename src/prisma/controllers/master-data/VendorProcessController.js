const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");

const VENDOR_PROCESS_CATEGORIES = new Set([
  "COATING",
  "PLATING",
  "HEAT_TREATMENT",
  "MACHINING",
  "WELDING",
  "ASSEMBLY",
  "INSPECTION",
  "OTHER",
]);

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

  if (data.vendorProcessCode) {
    data.vendorProcessCode = data.vendorProcessCode.toUpperCase().replace(/\s+/g, "_");
    if (!/^[A-Z0-9][A-Z0-9_-]{1,29}$/.test(data.vendorProcessCode)) {
      const error = new Error("Kode proses vendor harus 2-30 karakter: huruf kapital, angka, '-' atau '_'.");
      error.statusCode = 400;
      throw error;
    }
  }

  if (data.category) {
    data.category = data.category.toUpperCase();
    if (!VENDOR_PROCESS_CATEGORIES.has(data.category)) {
      const error = new Error("Kategori proses vendor tidak valid.");
      error.statusCode = 400;
      throw error;
    }
  }

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

const normalizeVendorIds = (value) => [...new Set((Array.isArray(value) ? value : [])
  .map((item) => String(item || "").trim())
  .filter(Boolean))];

const vendorProcessInclude = {
  entityProcesses: {
    where: { entityType: "vendor", vendorId: { not: null } },
    include: {
      vendor: {
        select: { id: true, vendorCode: true, vendorName: true, status: true, isDeleted: true },
      },
    },
  },
  _count: {
    select: {
      vendorPriceListDetails: {
        where: {
          isDeleted: false,
          vendorPriceList: { is: { isDeleted: false, isActive: true } },
        },
      },
    },
  },
};

const formatVendorProcess = (doc, routingProcess = null) => {
  if (!doc) return null;
  const vendors = (doc.entityProcesses || [])
    .map((item) => item.vendor)
    .filter(Boolean)
    .sort((left, right) => String(left.vendorCode).localeCompare(String(right.vendorCode)));
  const result = {
    ...mapDoc(doc),
    vendors,
    vendorIds: vendors.map((vendor) => vendor.id),
    vendorCodes: vendors.map((vendor) => vendor.vendorCode).join(", "),
    vendorNames: vendors.map((vendor) => vendor.vendorName || vendor.vendorCode).join(", "),
    vendorCount: vendors.length,
    priceListCount: Number(doc._count?.vendorPriceListDetails || 0),
    routingProcessName: routingProcess?.processName || null,
    routingLinked: Boolean(routingProcess),
  };
  delete result.entityProcesses;
  delete result._count;
  return result;
};

async function assertRoutingProcess(client, vendorProcessCode) {
  if (!vendorProcessCode) return null;
  const process = await client.process.findFirst({
    where: { processCode: vendorProcessCode, isDeleted: false },
    select: { id: true, processCode: true, processName: true },
  });
  if (!process) {
    const error = new Error(`Kode ${vendorProcessCode} belum tersedia di Master Data Proses. Buat proses routing terlebih dahulu.`);
    error.statusCode = 400;
    throw error;
  }
  return process;
}

async function assertVendors(client, vendorIds) {
  if (!vendorIds.length) return;
  const count = await client.vendor.count({
    where: { id: { in: vendorIds }, isDeleted: false, status: "Active" },
  });
  if (count !== vendorIds.length) {
    const error = new Error("Satu atau lebih vendor pelaksana tidak ditemukan atau sudah nonaktif.");
    error.statusCode = 400;
    throw error;
  }
}

async function replaceVendorAssignments(client, vendorProcessId, vendorIds) {
  await assertVendors(client, vendorIds);
  await client.entityVendorProcess.deleteMany({
    where: { vendorProcessId, entityType: "vendor" },
  });
  if (!vendorIds.length) return;
  await client.entityVendorProcess.createMany({
    data: vendorIds.map((vendorId) => ({ entityType: "vendor", vendorId, vendorProcessId })),
    skipDuplicates: true,
  });
}

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

    const orderBy = buildSort(req.query, {
      allowed: ["vendorProcessCode", "vendorProcessName", "category", "createdAt", "updatedAt"],
      default: { vendorProcessCode: "asc" },
    });
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.vendorProcess.findMany({
        where,
        include: vendorProcessInclude,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.vendorProcess.count({ where }),
    ]);

    const routingProcesses = await prisma.process.findMany({
      where: { processCode: { in: items.map((item) => item.vendorProcessCode) }, isDeleted: false },
      select: { processCode: true, processName: true },
    });
    const routingByCode = new Map(routingProcesses.map((process) => [process.processCode, process]));

    res.json({
      items: items.map((item) => formatVendorProcess(item, routingByCode.get(item.vendorProcessCode))),
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
      include: vendorProcessInclude,
    });
    if (!doc) return res.status(404).json({ message: "VendorProcess not found" });
    const routingProcess = await prisma.process.findFirst({
      where: { processCode: doc.vendorProcessCode, isDeleted: false },
      select: { processCode: true, processName: true },
    });
    res.json(formatVendorProcess(doc, routingProcess));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const vendorIds = normalizeVendorIds(req.body.vendorIds);
    const doc = await prisma.$transaction(async (tx) => {
      await assertRoutingProcess(tx, buildVendorProcessData(req.body).vendorProcessCode);
      const created = await tx.vendorProcess.create({
        data: buildVendorProcessData(req.body),
      });
      await replaceVendorAssignments(tx, created.id, vendorIds);
      return tx.vendorProcess.findUnique({ where: { id: created.id }, include: vendorProcessInclude });
    });
    const routingProcess = await prisma.process.findFirst({ where: { processCode: doc.vendorProcessCode, isDeleted: false } });
    res.status(201).json(formatVendorProcess(doc, routingProcess));
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

    const hasVendorAssignments = Object.prototype.hasOwnProperty.call(req.body, "vendorIds");
    const vendorIds = normalizeVendorIds(req.body.vendorIds);
    const doc = await prisma.$transaction(async (tx) => {
      const data = buildVendorProcessData(req.body, { partial: true });
      if (data.vendorProcessCode) await assertRoutingProcess(tx, data.vendorProcessCode);
      await tx.vendorProcess.update({
        where: { id: req.params.id },
        data,
      });
      if (hasVendorAssignments) await replaceVendorAssignments(tx, req.params.id, vendorIds);
      return tx.vendorProcess.findUnique({ where: { id: req.params.id }, include: vendorProcessInclude });
    });
    const routingProcess = await prisma.process.findFirst({ where: { processCode: doc.vendorProcessCode, isDeleted: false } });
    res.json(formatVendorProcess(doc, routingProcess));
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

        const vendorIds = normalizeVendorIds(process.vendorIds);
        const vendorProcess = await prisma.$transaction(async (tx) => {
          await assertRoutingProcess(tx, data.vendorProcessCode);
          const created = await tx.vendorProcess.create({ data });
          await replaceVendorAssignments(tx, created.id, vendorIds);
          return tx.vendorProcess.findUnique({ where: { id: created.id }, include: vendorProcessInclude });
        });
        success.push(formatVendorProcess(vendorProcess));
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
