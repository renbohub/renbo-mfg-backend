const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { convertPriceListFields } = require("../../utils/numericConverter");
const { deleteQuotationFile } = require("../../middleware/uploads");

const MONTH_FIELDS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Parse JSON string ke value; return fallback jika bukan string atau gagal parse
const parseJsonField = (value, fallback = null) => {
  if (typeof value !== "string") return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

// Map file upload ke quotation file record
const toQuotationFileRecord = (f) => ({
  fileName: f.originalname,
  fileUrl: `/uploads/quotations/${f.filename}`,
  fileType: f.mimetype,
  fileSize: f.size,
});

// Hapus semua file dari JSON array quotationFiles
const deleteAllQuotationFiles = (arr) => {
  if (!Array.isArray(arr)) return;
  arr.forEach((item) => {
    if (item?.fileUrl) deleteQuotationFile(item.fileUrl);
  });
};

// Helper function untuk format vendor price list dengan detail process prices
const formatVendorPriceList = (priceList) => {
  if (!priceList) return null;

  const transformed = mapDoc(priceList);

  transformed.details = Array.isArray(priceList.details)
    ? priceList.details.map((detail) => mapDoc(detail))
    : [];
  transformed.treatments = transformed.details
    .map((detail) => detail.vendorProcess)
    .filter(Boolean);
  transformed.entityProcesses = undefined;

  return transformed;
};

// Helper function untuk convert field types
const sanitizeVendorPriceListData = (data) => {
  // Convert monthly prices & pricingYear menggunakan utility
  let sanitized = convertPriceListFields(data);
  MONTH_FIELDS.forEach((field) => {
    delete sanitized[field];
  });
  delete sanitized.treatments;
  delete sanitized.details;

  // Convert isDeleted ke Boolean
  if (sanitized.isDeleted !== undefined) {
    sanitized.isDeleted =
      sanitized.isDeleted === "true" || sanitized.isDeleted === true;
  }

  return sanitized;
};

// Include config untuk vendorpricelist
const includeVendorPriceList = {
  vendor: true,
  customer: true,
  currency: true,
  part: true,
  details: {
    where: { isDeleted: false },
    orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
    include: {
      vendorProcess: {
        select: {
          id: true,
          vendorProcessCode: true,
          vendorProcessName: true,
        },
      },
    },
  },
};

const sanitizeVendorPriceListDetails = (rawDetails) => {
  const parsed = parseJsonField(rawDetails, rawDetails);
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((detail, index) => {
      const data = convertPriceListFields(detail || {});
      return {
        vendorProcessId: data.vendorProcessId || data.id,
        sequence: Number(data.sequence) || index + 1,
        january: data.january ?? null,
        february: data.february ?? null,
        march: data.march ?? null,
        april: data.april ?? null,
        may: data.may ?? null,
        june: data.june ?? null,
        july: data.july ?? null,
        august: data.august ?? null,
        september: data.september ?? null,
        october: data.october ?? null,
        november: data.november ?? null,
        december: data.december ?? null,
        notes: data.notes || null,
      };
    })
    .filter((detail) => detail.vendorProcessId);
};

exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      page = 1,
      limit = 20,
      partId,
      partCode,
      vendorCode,
      vendorProcessCode,
      vendorProcessName,
      pricingYear,
    } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    if (partId) where.partId = partId;
    if (partCode) {
      where.part = {
        ...(where.part || {}),
        partCode,
      };
    }
    if (vendorCode) where.vendor = { vendorCode };
    if (pricingYear) where.pricingYear = Number(pricingYear);
    if (vendorProcessCode || vendorProcessName) {
      where.details = {
        some: {
          vendorProcess: {
            is: {
              ...(vendorProcessCode || vendorProcessName
                ? {
                    OR: [
                      ...(vendorProcessCode
                        ? [{ vendorProcessCode: { equals: vendorProcessCode, mode: "insensitive" } }]
                        : []),
                      ...(vendorProcessName
                        ? [{ vendorProcessName: { equals: vendorProcessName, mode: "insensitive" } }]
                        : []),
                    ],
                  }
                : {}),
            },
          },
        },
      };
    }

    if (q) {
      const containsQuery = { contains: q, mode: "insensitive" };
      where.OR = [
        { vendor: { is: { vendorCode: containsQuery } } },
        { vendor: { is: { vendorName: containsQuery } } },
        { part: { is: { partCode: containsQuery } } },
        { part: { is: { partNumber: containsQuery } } },
        { part: { is: { partName: containsQuery } } },
        { customer: { is: { customerCode: containsQuery } } },
        { customer: { is: { customerName: containsQuery } } },
        {
          details: {
            some: {
              vendorProcess: {
                is: {
                  OR: [
                    { vendorProcessCode: containsQuery },
                    { vendorProcessName: containsQuery },
                  ],
                },
              },
            },
          },
        },
        { category: containsQuery },
        { notes: containsQuery },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.vendorPriceList.findMany({
        where,
        include: includeVendorPriceList,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.vendorPriceList.count({ where }),
    ]);

    res.json({
      items: items.map(formatVendorPriceList),
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
    const doc = await prisma.vendorPriceList.findFirst({
      where: { id: req.params.id, isDeleted: false },
      include: includeVendorPriceList,
    });
    if (!doc)
      return res.status(404).json({ message: "VendorPriceList not found" });

    res.json(formatVendorPriceList(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { details: rawDetails, ...priceListData } = req.body;
    const details = sanitizeVendorPriceListDetails(rawDetails);
    const data = sanitizeVendorPriceListData(priceListData);

    // Map uploaded quotation files ke JSON array
    if (req.files?.quotationFiles?.length > 0) {
      data.quotationFiles = req.files.quotationFiles.map(toQuotationFileRecord);
    }

    if (details.length > 0) {
      data.details = {
        create: details,
      };
    }

    const doc = await prisma.vendorPriceList.create({
      data,
      include: includeVendorPriceList,
    });

    res.status(201).json(formatVendorPriceList(doc));
  } catch (e) {
    // Cleanup uploaded files jika gagal
    if (req.files?.quotationFiles)
      deleteAllQuotationFiles(
        req.files.quotationFiles.map(toQuotationFileRecord),
      );
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    // Cek current vendorPriceList
    const currentVendorPriceList = await prisma.vendorPriceList.findFirst({
      where: { id: req.params.id },
    });

    if (!currentVendorPriceList) {
      // Cleanup uploaded files jika record tidak ditemukan
      if (req.files?.quotationFiles)
        deleteAllQuotationFiles(
          req.files.quotationFiles.map(toQuotationFileRecord),
        );
      return res.status(404).json({ message: "VendorPriceList not found" });
    }

    const {
      details: rawDetails,
      existingQuotationFiles,
      ...priceListData
    } = req.body;
    const details = rawDetails !== undefined ? sanitizeVendorPriceListDetails(rawDetails) : undefined;
    const data = sanitizeVendorPriceListData(priceListData);

    // Hitung quotationFiles akhir: existing yang dipertahankan + file baru
    const dbFiles = Array.isArray(currentVendorPriceList.quotationFiles)
      ? currentVendorPriceList.quotationFiles
      : [];
    const keptUrls = (() => {
      const parsed = parseJsonField(existingQuotationFiles, null);
      return Array.isArray(parsed) ? parsed : dbFiles.map((f) => f.fileUrl);
    })();
    dbFiles
      .filter((f) => !keptUrls.includes(f.fileUrl))
      .forEach((f) => deleteQuotationFile(f.fileUrl));
    const remaining = dbFiles.filter((f) => keptUrls.includes(f.fileUrl));
    const newFiles = (req.files?.quotationFiles ?? []).map(
      toQuotationFileRecord,
    );
    data.quotationFiles = [...remaining, ...newFiles];

    if (details !== undefined) {
      data.details = {
        deleteMany: {},
        create: details,
      };
    }

    // Sekarang baru update
    const doc = await prisma.vendorPriceList.update({
      where: { id: req.params.id },
      data,
      include: includeVendorPriceList,
    });

    res.json(formatVendorPriceList(doc));
  } catch (e) {
    // Cleanup uploaded files jika gagal
    if (req.files?.quotationFiles)
      deleteAllQuotationFiles(
        req.files.quotationFiles.map(toQuotationFileRecord),
      );
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const doc = await prisma.vendorPriceList.findUnique({
      where: { id: req.params.id },
    });

    if (!doc) {
      return res.status(404).json({ message: "VendorPriceList not found" });
    }

    // Hapus semua quotation files
    deleteAllQuotationFiles(doc.quotationFiles);

    await prisma.vendorPriceList.update({
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

    // Get all records untuk delete files
    const records = await prisma.vendorPriceList.findMany({
      where: { id: { in: ids } },
      select: { id: true, quotationFiles: true },
    });

    // Hapus semua quotation files
    records.forEach((record) => deleteAllQuotationFiles(record.quotationFiles));

    const result = await prisma.vendorPriceList.updateMany({
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
    const { vendorPriceLists } = req.body;

    if (!Array.isArray(vendorPriceLists) || vendorPriceLists.length === 0) {
      return res
        .status(400)
        .json({ message: "vendorPriceLists array required" });
    }

    const results = {
      success: [],
      failed: [],
      total: vendorPriceLists.length,
    };

    // Process setiap vendor price list
    for (const priceListData of vendorPriceLists) {
      try {
        const { details: rawDetails, treatments, ...dataWithoutDetails } = priceListData;
        const details = sanitizeVendorPriceListDetails(rawDetails || treatments);

        // Sanitize data (convert numeric fields)
        const data = sanitizeVendorPriceListData(dataWithoutDetails);

        // Resolve vendorId dari vendorCode jika vendorId kosong
        if (!data.vendorId && data.vendorCode) {
          const vendor = await prisma.vendor.findUnique({
            where: { vendorCode: data.vendorCode },
            select: { id: true },
          });
          if (vendor) {
            data.vendorId = vendor.id;
          }
        }

        // Resolve partId dari partCode jika partId kosong
        if (!data.partId && data.partCode) {
          const part = await prisma.part.findUnique({
            where: { partCode: data.partCode },
            select: { id: true },
          });
          if (part) {
            data.partId = part.id;
          }
        }

        // Resolve customerId dari customerCode jika customerId kosong
        if (!data.customerId && data.customerCode) {
          const customer = await prisma.customer.findUnique({
            where: { customerCode: data.customerCode },
            select: { id: true },
          });
          if (customer) {
            data.customerId = customer.id;
          }
        }

        if (details.length > 0) {
          data.details = {
            create: details,
          };
        }

        // Create vendor price list baru
        const doc = await prisma.vendorPriceList.create({
          data,
          include: includeVendorPriceList,
        });

        results.success.push(formatVendorPriceList(doc));
      } catch (error) {
        results.failed.push({
          data: priceListData,
          error: error.message,
        });
      }
    }

    res.status(201).json({
      message: `Bulk create completed: ${results.success.length} success, ${results.failed.length} failed`,
      ...results,
    });
  } catch (e) {
    next(e);
  }
};

