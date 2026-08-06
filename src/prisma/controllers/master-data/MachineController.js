const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { deleteMachineFile } = require("../../middleware/uploads");
const { convertNumericFields } = require("../../utils/numericConverter");
const { parseFilter } = require("../../utils/parseFilter");

// Field-field Machine yang tipenya bukan string di schema Prisma
const MACHINE_NUMERIC_FIELDS = [
  'capacity', 'tonnage', 'powerKw', 'voltage', 'cycleTime',
  'purchaseCost', 'depreciationRate', 'maintenanceInterval',
  'costingRate',
];
const MACHINE_BOOLEAN_FIELDS = ['isDeleted'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Parse JSON string ke value; return fallback jika bukan string atau gagal parse
const parseJsonField = (value, fallback = null) => {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

// Map file upload ke file record berdasarkan subdir field
const toMachineFileRecord = (fieldname, f) => ({
  fileName: f.originalname,
  fileUrl: `/uploads/machines/${fieldname}/${f.filename}`,
  fileType: f.mimetype,
  fileSize: f.size,
});

// Hapus semua file dari sebuah JSON array field
const deleteJsonFiles = (arr) => {
  if (!Array.isArray(arr)) return;
  arr.forEach((item) => { if (item?.fileUrl) deleteMachineFile(item.fileUrl); });
};

// Hitung field JSON foto akhir: pertahankan yang ada di keptUrls, hapus sisanya
const resolveFileField = (dbArray, keptUrlsRaw, newFiles) => {
  const db = Array.isArray(dbArray) ? dbArray : [];
  const keptUrls = Array.isArray(keptUrlsRaw) ? keptUrlsRaw : db.map((f) => f.fileUrl);
  db.filter((f) => !keptUrls.includes(f.fileUrl)).forEach((f) => deleteMachineFile(f.fileUrl));
  const remaining = db.filter((f) => keptUrls.includes(f.fileUrl));
  return [...remaining, ...newFiles];
};

// Sanitasi data dari multipart form (semua nilai datang sebagai string)
const sanitizeMachineData = (data) => {
  let d = convertNumericFields(data, MACHINE_NUMERIC_FIELDS);
  if (d.specificationDetails !== undefined) {
    d.specificationDetails = parseJsonField(d.specificationDetails, {});
  }
  ['machineFamily', 'machineSpecificationCode'].forEach((field) => {
    if (typeof d[field] === 'string') d[field] = d[field].trim().toUpperCase().replace(/\s+/g, '_');
  });
  if (typeof d.machineTechnology === 'string') d.machineTechnology = d.machineTechnology.trim().toUpperCase();
  MACHINE_BOOLEAN_FIELDS.forEach((field) => {
    if (d[field] !== undefined) d[field] = d[field] === true || d[field] === 'true';
  });
  return d;
};

const validateMachineSpecification = (data, current = {}) => {
  const merged = { ...current, ...data };
  const missing = ['machineSpecificationCode', 'machineSpecificationName', 'machineFamily'].filter((field) => !String(merged[field] || '').trim());
  if (!missing.length) return null;
  return `Machine Specification wajib lengkap: ${missing.join(', ')}.`;
};

exports.generateCode = async (req, res, next) => {
  try {
    // Ambil semua machine codes
    const machines = await prisma.machine.findMany({
      select: {
        machineCode: true,
      },
    });

    // Parse semua codes jadi number, filter yang valid (format M-XXX), dan sort
    const existingNumbers = machines
      .map((c) => {
        const match = c.machineCode.match(/^M-(\d+)$/i);
        return match ? parseInt(match[1], 10) : NaN;
      })
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

    const machineCode = `M-${String(nextNumber).padStart(3, "0")}`;

    res.json({ machineCode });
  } catch (e) {
    next(e);
  }
};

exports.list = async (req, res, next) => {
  try {
    const { q, isDeleted, page = 1, limit = 20, status, machineType } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;

    if (machineType) {
      where.machineType = machineType;
    }

    if (q) {
      where.OR = [
        { machineCode: { contains: q, mode: "insensitive" } },
        { machineName: { contains: q, mode: "insensitive" } },
        { machineType: { contains: q, mode: "insensitive" } },
        { machineFamily: { contains: q, mode: "insensitive" } },
        { machineSpecificationCode: { contains: q, mode: "insensitive" } },
        { machineSpecificationName: { contains: q, mode: "insensitive" } },
        { brand: { contains: q, mode: "insensitive" } },
        { serialNumber: { contains: q, mode: "insensitive" } },
        { location: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (Number(page) - 1) * Number(limit);

    const [items, total] = await Promise.all([
      prisma.machine.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.machine.count({ where }),
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
    const doc = await prisma.machine.findFirst({
      where: { machineCode: req.params.machineCode, isDeleted: false },
    });
    if (!doc) return res.status(404).json({ message: "Machine not found" });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { existingPhotos, existingDrawings, ...rawData } = req.body;
    const bodyData = sanitizeMachineData(rawData);
    if (bodyData.machineCode) bodyData.machineCode = bodyData.machineCode.toUpperCase();
    const specificationError = validateMachineSpecification(bodyData);
    if (specificationError) return res.status(400).json({ message: specificationError });

    // Pasang file uploads ke JSON field masing-masing
    if (req.files?.photos?.length > 0)
      bodyData.photos = req.files.photos.map((f) => toMachineFileRecord('photos', f));
    if (req.files?.drawings?.length > 0)
      bodyData.drawings = req.files.drawings.map((f) => toMachineFileRecord('drawings', f));

    // Cek apakah machine dengan machineCode yang sama sudah ada dan soft deleted
    const existing = await prisma.machine.findUnique({
      where: { machineCode: bodyData.machineCode },
    });

    let doc;
    if (existing && existing.isDeleted) {
      // Hapus file lama sebelum restore
      deleteJsonFiles(existing.photos);
      deleteJsonFiles(existing.drawings);
      doc = await prisma.machine.update({
        where: { id: existing.id },
        data: { ...bodyData, isDeleted: false },
      });
    } else {
      doc = await prisma.machine.create({ data: bodyData });
    }

    res.status(201).json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const { existingPhotos, existingDrawings, ...rawData } = req.body;
    const bodyData = sanitizeMachineData(rawData);

    const currentMachine = await prisma.machine.findUnique({
      where: { id: req.params.id },
    });

    if (!currentMachine) {
      return res.status(404).json({ message: "Machine not found" });
    }
    const specificationError = validateMachineSpecification(bodyData, currentMachine);
    if (specificationError) return res.status(400).json({ message: specificationError });

    // Jika machineCode berubah, cek duplikat soft-deleted
    if (bodyData.machineCode && bodyData.machineCode !== currentMachine.machineCode) {
      const existingSoftDeleted = await prisma.machine.findFirst({
        where: { machineCode: bodyData.machineCode, isDeleted: true },
      });
      if (existingSoftDeleted) {
        await prisma.machine.delete({ where: { id: existingSoftDeleted.id } });
      }
    }

    // Hitung field akhir: existing yang dipertahankan + file baru
    bodyData.photos = resolveFileField(
      currentMachine.photos,
      parseJsonField(existingPhotos, null),
      (req.files?.photos ?? []).map((f) => toMachineFileRecord('photos', f))
    );
    bodyData.drawings = resolveFileField(
      currentMachine.drawings,
      parseJsonField(existingDrawings, null),
      (req.files?.drawings ?? []).map((f) => toMachineFileRecord('drawings', f))
    );

    const doc = await prisma.machine.update({
      where: { id: req.params.id },
      data: bodyData,
    });

    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const machine = await prisma.machine.findUnique({
      where: { id: req.params.id },
      select: { photos: true, drawings: true },
    });
    await prisma.machine.update({
      where: { id: req.params.id },
      data: { isDeleted: true },
    });
    if (machine) {
      deleteJsonFiles(machine.photos);
      deleteJsonFiles(machine.drawings);
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
    const records = await prisma.machine.findMany({
      where: { id: { in: ids } },
      select: { photos: true, drawings: true },
    });
    records.forEach((r) => {
      deleteJsonFiles(r.photos);
      deleteJsonFiles(r.drawings);
    });
    const result = await prisma.machine.updateMany({
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
    const { q, limit = 20, status, machineType } = req.query;
    const where = { isDeleted: false };

    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;
    if (machineType) where.machineType = machineType;

    if (q) {
      where.OR = [
        { machineCode: { contains: q, mode: "insensitive" } },
        { machineName: { contains: q, mode: "insensitive" } },
      ];
    }

    const items = await prisma.machine.findMany({
      where,
      select: {
        id: true,
        machineCode: true,
        machineName: true,
        machineType: true,
        machineFamily: true,
        machineTechnology: true,
        machineSpecificationCode: true,
        machineSpecificationName: true,
        specificationDetails: true,
        status: true,
        tonnage: true,
        cycleTime: true,
        currencyCode: true,
        costingRate: true,
        costingRateType: true,
      },
      take: Number(limit),
      orderBy: { machineCode: "asc" },
    });

    res.json(items);
  } catch (e) {
    next(e);
  }
};

exports.getAllCodes = async (req, res, next) => {
  try {
    const machines = await prisma.machine.findMany({
      where: { isDeleted: false },
      select: { machineCode: true },
      orderBy: { machineCode: "asc" },
    });

    res.json(machines.map((m) => m.machineCode));
  } catch (e) {
    next(e);
  }
};
