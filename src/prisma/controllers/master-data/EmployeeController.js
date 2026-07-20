const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { parseFilter } = require("../../utils/parseFilter");
const { deleteEmployeeImage } = require("../../middleware/uploads");

// Include config untuk employee
const includeEmployee = {
  department: {
    select: {
      departmentCode: true,
      departmentName: true,
    },
  },
  division: {
    select: {
      id: true,
      divisionCode: true,
      divisionName: true,
    },
  },
  employeeDivisions: {
    include: {
      division: {
        select: {
          id: true,
          divisionCode: true,
          divisionName: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  },
};


const mapEmployeeDoc = (doc) => {
  const mapped = mapDoc(doc);
  const divisions = (doc.employeeDivisions || [])
    .map((item) => item.division)
    .filter(Boolean)
    .map(mapDoc);

  mapped.divisions = divisions;
  mapped.divisionIds = divisions.map((division) => division.id);
  if (!mapped.division && divisions.length > 0) mapped.division = divisions[0];
  delete mapped.employeeDivisions;

  return mapped;
};

const normalizeDivisionIds = (divisionIds, divisionId) => {
  const parsedDivisionIds = parseJsonField(divisionIds, undefined);
  const source = parsedDivisionIds !== undefined
    ? parsedDivisionIds
    : divisionId
      ? [divisionId]
      : undefined;

  if (source === undefined) return undefined;
  if (source === null || source === "") return [];

  const values = Array.isArray(source) ? source : [source];
  return [...new Set(values.filter(Boolean).map(String))];
};

const buildEmployeeWriteData = (data, divisionIds, mode = "create") => {
  if (divisionIds === undefined) return data;

  const writeData = {
    ...data,
    divisionId: divisionIds[0] || null,
  };

  const divisionCreates = divisionIds.map((divisionId) => ({
    division: { connect: { id: divisionId } },
  }));

  writeData.employeeDivisions = mode === "update"
    ? { deleteMany: {}, create: divisionCreates }
    : { create: divisionCreates };

  return writeData;
};
const parseJsonField = (value, fallback = null) => {
  if (value === undefined) return fallback;
  if (typeof value !== "string") return value === null || value === undefined ? fallback : value;
  if (value === "") return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const getFileUrl = (value) => {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.fileUrl || value.filePath || value.photoUrl || null;
};

const toEmployeeImageRecord = (fieldName, file) => {
  const subdir = fieldName === "profilePhoto" ? "profile" : "signature";
  return {
    fileName: file.originalname,
    fileUrl: `/uploads/employees/${subdir}/${file.filename}`,
    fileType: file.mimetype,
    fileSize: file.size,
  };
};

const normalizeEmployeeData = (data) => {
  const nullableFields = new Set([
    "firstName",
    "lastName",
    "fullName",
    "email",
    "phone",
    "nationalId",
    "birthPlace",
    "birthDate",
    "gender",
    "maritalStatus",
    "religion",
    "bloodType",
    "address",
    "position",
    "departmentId",
    "divisionId",
    "hireDate",
    "notes",
  ]);

  const intFields = new Set(["heightCm", "weightKg"]);

  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      if (nullableFields.has(key) && value === "") return [key, null];
      if (intFields.has(key)) {
        if (value === "" || value === null || value === undefined) return [key, null];
        const parsed = Number.parseInt(value, 10);
        return [key, Number.isNaN(parsed) ? null : parsed];
      }
      return [key, value];
    }),
  );
};

const applyUploadedEmployeeImages = ({ data, files, current = null, existingProfilePhoto, existingSignature }) => {
  const imageFields = [
    { field: "profilePhoto", existingField: existingProfilePhoto },
    { field: "signature", existingField: existingSignature },
  ];

  imageFields.forEach(({ field, existingField }) => {
    const upload = files?.[field]?.[0];
    const currentUrl = getFileUrl(current?.[field]);

    if (upload) {
      if (currentUrl) deleteEmployeeImage(currentUrl);
      data[field] = toEmployeeImageRecord(field, upload);
      return;
    }

    if (existingField !== undefined) {
      const keptUrl = getFileUrl(parseJsonField(existingField, null));
      if (!keptUrl && currentUrl) {
        deleteEmployeeImage(currentUrl);
        data[field] = null;
      }
    }
  });
};

exports.generateCode = async (req, res, next) => {
  try {
    // Ambil semua employee ids
    const employees = await prisma.employee.findMany({
      select: { employeeId: true },
    });

    // Coba parse angka di belakang prefix "MI"
    const existingNumbers = employees
      .map((e) => {
        const match = e.employeeId.match(/^MI(\d+)$/);
        return match ? parseInt(match[1]) : NaN;
      })
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

    const employeeId = `MI${String(nextNumber).padStart(3, "0")}`;
    res.json({ employeeId });
  } catch (e) {
    next(e);
  }
};

exports.getAllCodes = async (req, res, next) => {
  try {
    const employees = await prisma.employee.findMany({
      where: { isDeleted: false },
      select: { employeeId: true },
      orderBy: { employeeId: "asc" },
    });
    const codes = employees.map((e) => e.employeeId);
    res.json(codes);
  } catch (e) {
    next(e);
  }
};

exports.list = async (req, res, next) => {
  try {
    const { q, isDeleted, departmentId, divisionId, status, page = 1, limit = 20 } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    // Filter berdasarkan department
    if (departmentId) {
      where.departmentId = departmentId;
    }

    // Filter berdasarkan division
    if (divisionId) {
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { divisionId },
            { employeeDivisions: { some: { divisionId } } },
          ],
        },
      ];
    }

    // Filter berdasarkan status
    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;

    if (q) {
      where.OR = [
        { employeeId: { contains: q, mode: "insensitive" } },
        { fullName: { contains: q, mode: "insensitive" } },
        { firstName: { contains: q, mode: "insensitive" } },
        { lastName: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { position: { contains: q, mode: "insensitive" } },
        { department: { departmentName: { contains: q, mode: "insensitive" } } },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.employee.findMany({
        where,
        include: includeEmployee,
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.employee.count({ where }),
    ]);

    res.json({
      items: items.map(mapEmployeeDoc),
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
    const doc = await prisma.employee.findFirst({
      where: { employeeId: req.params.employeeId, isDeleted: false },
      include: includeEmployee,
    });
    if (!doc) return res.status(404).json({ message: "Karyawan tidak ditemukan" });
    res.json(mapEmployeeDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const rawData = { ...req.body };
    const existingProfilePhoto = rawData.existingProfilePhoto;
    const existingSignature = rawData.existingSignature;
    delete rawData.existingProfilePhoto;
    delete rawData.existingSignature;
    delete rawData.profilePhoto;
    delete rawData.signature;
    const divisionIds = normalizeDivisionIds(rawData.divisionIds, rawData.divisionId);
    delete rawData.divisionIds;
    const data = normalizeEmployeeData(rawData);
    applyUploadedEmployeeImages({
      data,
      files: req.files,
      existingProfilePhoto,
      existingSignature,
    });

    // Cek apakah employee dengan employeeId yang sama sudah ada dan soft deleted
    const existing = await prisma.employee.findUnique({
      where: { employeeId: data.employeeId },
    });

    let doc;
    if (existing && existing.isDeleted) {
      if (data.profilePhoto && getFileUrl(existing.profilePhoto)) {
        deleteEmployeeImage(getFileUrl(existing.profilePhoto));
      }
      if (data.signature && getFileUrl(existing.signature)) {
        deleteEmployeeImage(getFileUrl(existing.signature));
      }
      doc = await prisma.employee.update({
        where: { id: existing.id },
        data: buildEmployeeWriteData({ ...data, isDeleted: false }, divisionIds, "update"),
        include: includeEmployee,
      });
    } else {
      doc = await prisma.employee.create({
        data: buildEmployeeWriteData(data, divisionIds, "create"),
        include: includeEmployee,
      });
    }

    res.status(201).json(mapEmployeeDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const rawData = { ...req.body };
    const existingProfilePhoto = rawData.existingProfilePhoto;
    const existingSignature = rawData.existingSignature;
    delete rawData.existingProfilePhoto;
    delete rawData.existingSignature;
    delete rawData.profilePhoto;
    delete rawData.signature;
    const divisionIds = normalizeDivisionIds(rawData.divisionIds, rawData.divisionId);
    delete rawData.divisionIds;
    const data = normalizeEmployeeData(rawData);

    const current = await prisma.employee.findUnique({
      where: { id: req.params.id },
    });

    if (!current) {
      return res.status(404).json({ message: "Karyawan tidak ditemukan" });
    }

    applyUploadedEmployeeImages({
      data,
      files: req.files,
      current,
      existingProfilePhoto,
      existingSignature,
    });

    // Jika employeeId berubah, cek apakah ada soft deleted dengan id yang sama
    if (data.employeeId && data.employeeId !== current.employeeId) {
      const existingSoftDeleted = await prisma.employee.findFirst({
        where: {
          employeeId: data.employeeId,
          isDeleted: true,
        },
      });

      if (existingSoftDeleted) {
        await prisma.employee.delete({
          where: { id: existingSoftDeleted.id },
        });
      }
    }

    const doc = await prisma.employee.update({
      where: { id: req.params.id },
      data: buildEmployeeWriteData(data, divisionIds, "update"),
      include: includeEmployee,
    });

    res.json(mapEmployeeDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    await prisma.employee.update({
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
    const result = await prisma.employee.updateMany({
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
    const { employees } = req.body;

    if (!Array.isArray(employees) || employees.length === 0) {
      return res.status(400).json({ message: "employees array required" });
    }

    const results = {
      success: [],
      failed: [],
      duplicates: [],
      total: employees.length,
    };

    for (const employeeData of employees) {
      try {
        const rawEmployeeData = { ...employeeData };
        const divisionIds = normalizeDivisionIds(rawEmployeeData.divisionIds, rawEmployeeData.divisionId);
        delete rawEmployeeData.divisionIds;
        const data = normalizeEmployeeData(rawEmployeeData);

        const existing = await prisma.employee.findUnique({
          where: { employeeId: data.employeeId },
        });

        if (existing && !existing.isDeleted) {
          results.duplicates.push({
            employeeId: data.employeeId,
            existingId: existing.id,
          });
          continue;
        }

        let doc;
        if (existing && existing.isDeleted) {
          doc = await prisma.employee.update({
            where: { id: existing.id },
            data: buildEmployeeWriteData({ ...data, isDeleted: false }, divisionIds, "update"),
            include: includeEmployee,
          });
        } else {
          doc = await prisma.employee.create({
            data: buildEmployeeWriteData(data, divisionIds, "create"),
            include: includeEmployee,
          });
        }

        results.success.push(mapEmployeeDoc(doc));
      } catch (error) {
        results.failed.push({ data: employeeData, error: error.message });
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
    const { q, limit = 20, departmentId, divisionId, status } = req.query;
    const where = { isDeleted: false };

    if (departmentId) {
      where.departmentId = departmentId;
    }

    if (divisionId) {
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { divisionId },
            { employeeDivisions: { some: { divisionId } } },
          ],
        },
      ];
    }

    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;

    if (q) {
      where.OR = [
        { employeeId: { contains: q, mode: "insensitive" } },
        { fullName: { contains: q, mode: "insensitive" } },
        { position: { contains: q, mode: "insensitive" } },
      ];
    }

    const items = await prisma.employee.findMany({
      where,
      select: {
        id: true,
        employeeId: true,
        fullName: true,
        email: true,
        birthDate: true,
        gender: true,
        position: true,
        profilePhoto: true,
        signature: true,
        departmentId: true,
        department: {
          select: {
            departmentCode: true,
            departmentName: true,
          },
        },
        divisionId: true,
        division: {
          select: {
            id: true,
            divisionCode: true,
            divisionName: true,
          },
        },
        employeeDivisions: {
          include: {
            division: {
              select: {
                id: true,
                divisionCode: true,
                divisionName: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
      take: Number(limit),
      orderBy: { employeeId: "asc" },
    });

    res.json(items.map(mapEmployeeDoc));
  } catch (e) {
    next(e);
  }
};
