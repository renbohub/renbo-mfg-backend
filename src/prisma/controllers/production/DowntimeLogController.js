const { prisma } = require("../../index");
const { Prisma } = require("@prisma/client");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { parseFilter } = require("../../utils/parseFilter");
const {
  calculateDurationMinutes,
  generateDailyNumber,
  resolveProductionRefs,
  toDateTime,
  toNumber,
} = require("./services/productionIntegrationHelpers");

function applyInputAliases(data = {}) {
  const normalized = { ...data };
  normalized.moNumber = normalized.moNumber || normalized.mo_number;
  normalized.woNumber = normalized.woNumber || normalized.wo_number;
  normalized.productionLogNumber =
    normalized.productionLogNumber || normalized.production_log_number;
  normalized.productionLogId =
    normalized.productionLogId || normalized.production_log_id;
  normalized.machineCode = normalized.machineCode || normalized.machine_code;
  normalized.operatorName = normalized.operatorName || normalized.operator_name;
  normalized.durationMinutes =
    normalized.durationMinutes ?? normalized.duration_minutes ?? normalized.duration;
  normalized.reason =
    normalized.reason || normalized.downtimeReason || normalized.downtime_reason;

  delete normalized.mo_number;
  delete normalized.wo_number;
  delete normalized.production_log_number;
  delete normalized.production_log_id;
  delete normalized.machine_code;
  delete normalized.operator_name;
  delete normalized.duration_minutes;
  delete normalized.duration;
  delete normalized.downtimeReason;
  delete normalized.downtime_reason;

  return normalized;
}

async function generateDowntimeNumber() {
  return generateDailyNumber(prisma, "downtimeLog", "downtimeNumber", "DT");
}

async function normalizeDowntimeLogInput(tx, data = {}, existing = {}) {
  const normalized = applyInputAliases(data);

  if (normalized.productionLogNumber) {
    const log = await tx.productionLog.findFirst({
      where: { logNumber: normalized.productionLogNumber, isDeleted: false },
      include: {
        workOrder: { select: { id: true, woNumber: true } },
        manufacturingOrder: { select: { id: true, moNumber: true } },
      },
    });
    if (!log) {
      throw Object.assign(new Error("Production Log tidak ditemukan."), {
        statusCode: 404,
      });
    }

    normalized.productionLogId = log.id;
    normalized.moId = log.moId;
    normalized.woId = log.woId || normalized.woId || null;
    normalized.shift = normalized.shift || log.shift || null;
    normalized.machineCode = normalized.machineCode || log.machineCode || null;
    normalized.operatorName = normalized.operatorName || log.operatorName || null;

    if (normalized.moNumber && log.manufacturingOrder?.moNumber !== normalized.moNumber) {
      throw Object.assign(
        new Error(`Production Log ${normalized.productionLogNumber} tidak terkait dengan MO ${normalized.moNumber}.`),
        { statusCode: 400 },
      );
    }
    if (normalized.woNumber && log.workOrder?.woNumber !== normalized.woNumber) {
      throw Object.assign(
        new Error(`Production Log ${normalized.productionLogNumber} tidak terkait dengan WO ${normalized.woNumber}.`),
        { statusCode: 400 },
      );
    }
  }

  Object.assign(normalized, await resolveProductionRefs(tx, normalized));

  const durationFromTime = calculateDurationMinutes(
    normalized.startTime ?? existing.startTime,
    normalized.endTime ?? existing.endTime,
    normalized.downtimeDate ?? existing.downtimeDate ?? new Date(),
  );
  if (normalized.durationMinutes === undefined && durationFromTime !== null) {
    normalized.durationMinutes = durationFromTime;
  }
  if (normalized.durationMinutes !== undefined) {
    normalized.durationMinutes = toNumber(normalized.durationMinutes);
  }

  delete normalized.downtimeNumber;
  delete normalized.moNumber;
  delete normalized.woNumber;
  delete normalized.productionLogNumber;

  if (!normalized.moId) {
    throw Object.assign(new Error("MO Number wajib diisi."), {
      statusCode: 400,
    });
  }
  if (!normalized.reason) {
    throw Object.assign(new Error("Reason downtime wajib diisi."), {
      statusCode: 400,
    });
  }
  if (normalized.durationMinutes < 0) {
    throw Object.assign(new Error("Duration downtime tidak boleh minus."), {
      statusCode: 400,
    });
  }

  return normalized;
}

function includeRelations() {
  return {
    manufacturingOrder: {
      select: {
        moNumber: true,
        status: true,
        part: { select: { partCode: true, partNumber: true, partName: true } },
      },
    },
    workOrder: { select: { woNumber: true, status: true } },
    productionLog: { select: { logNumber: true, status: true } },
  };
}

exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      page = 1,
      limit = 20,
      moId,
      moNumber,
      woId,
      woNumber,
      productionLogId,
      productionLogNumber,
      shift,
      machineCode,
      status,
      startDate,
      endDate,
    } = req.query;

    const where = {};
    where.isDeleted = isDeleted !== undefined ? isDeleted === "true" : false;

    if (moId) where.moId = moId;
    if (moNumber) where.manufacturingOrder = { moNumber };
    if (woId) where.woId = woId;
    if (woNumber) where.workOrder = { woNumber };
    if (productionLogId) where.productionLogId = productionLogId;
    if (productionLogNumber) where.productionLog = { logNumber: productionLogNumber };
    if (shift) where.shift = shift;
    if (machineCode) where.machineCode = { contains: machineCode, mode: "insensitive" };
    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;

    if (startDate || endDate) {
      where.downtimeDate = {};
      if (startDate) where.downtimeDate.gte = new Date(startDate);
      if (endDate) where.downtimeDate.lte = new Date(endDate);
    }

    if (q) {
      where.OR = [
        { downtimeNumber: { contains: q, mode: "insensitive" } },
        { reason: { contains: q, mode: "insensitive" } },
        { category: { contains: q, mode: "insensitive" } },
        { operatorName: { contains: q, mode: "insensitive" } },
        { machineCode: { contains: q, mode: "insensitive" } },
        { notes: { contains: q, mode: "insensitive" } },
        { manufacturingOrder: { moNumber: { contains: q, mode: "insensitive" } } },
        { workOrder: { woNumber: { contains: q, mode: "insensitive" } } },
        { productionLog: { logNumber: { contains: q, mode: "insensitive" } } },
      ];
    }

    const orderBy = buildSort(req.query, { defaultSort: { downtimeDate: "desc" } });
    const skip = (Number(page) - 1) * Number(limit);

    const [items, total] = await Promise.all([
      prisma.downtimeLog.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
        include: includeRelations(),
      }),
      prisma.downtimeLog.count({ where }),
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
    const doc = await prisma.downtimeLog.findFirst({
      where: { downtimeNumber: req.params.downtimeNumber, isDeleted: false },
      include: includeRelations(),
    });
    if (!doc) return res.status(404).json({ message: "Data Downtime Log tidak ditemukan." });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const {
      downtimeDate,
      downtime_date,
      startTime,
      start_time,
      endTime,
      end_time,
      status: _status,
      downtimeNumber: _downtimeNumber,
      downtime_number: _downtime_number,
      ...data
    } = req.body;

    const downtimeNumber = await generateDowntimeNumber();
    const resolvedDowntimeDate = downtimeDate || downtime_date;
    const resolvedStartTime = startTime || start_time;
    const resolvedEndTime = endTime || end_time;
    const doc = await prisma.$transaction(async (tx) => {
      const normalized = await normalizeDowntimeLogInput(tx, {
        ...data,
        downtimeDate: resolvedDowntimeDate,
        startTime: resolvedStartTime,
        endTime: resolvedEndTime,
      });
      return tx.downtimeLog.create({
        data: {
          ...normalized,
          downtimeNumber,
          downtimeDate: resolvedDowntimeDate ? new Date(resolvedDowntimeDate) : new Date(),
          startTime: toDateTime(resolvedStartTime, resolvedDowntimeDate || new Date()),
          endTime: toDateTime(resolvedEndTime, resolvedDowntimeDate || new Date()),
          status: "Open",
        },
        include: includeRelations(),
      });
    });

    res.status(201).json(mapDoc(doc));
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ message: "Nomor Downtime Log sudah digunakan." });
    }
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const {
      downtimeDate,
      downtime_date,
      startTime,
      start_time,
      endTime,
      end_time,
      downtimeNumber: _downtimeNumber,
      downtime_number: _downtime_number,
      ...data
    } = req.body;

    const resolvedDowntimeDate = downtimeDate || downtime_date;
    const resolvedStartTime = startTime || start_time;
    const resolvedEndTime = endTime || end_time;
    const existing = await prisma.downtimeLog.findFirst({
      where: { downtimeNumber: req.params.downtimeNumber, isDeleted: false },
      select: { id: true, startTime: true, endTime: true },
    });
    if (!existing) return res.status(404).json({ message: "Data Downtime Log tidak ditemukan." });

    const updateData = await prisma.$transaction((tx) =>
      normalizeDowntimeLogInput(tx, {
        ...data,
        downtimeDate: resolvedDowntimeDate,
        startTime: resolvedStartTime,
        endTime: resolvedEndTime,
      }, {
        downtimeDate: resolvedDowntimeDate,
        startTime: resolvedStartTime !== undefined ? resolvedStartTime : existing.startTime,
        endTime: resolvedEndTime !== undefined ? resolvedEndTime : existing.endTime,
      }),
    );
    if (resolvedDowntimeDate !== undefined) updateData.downtimeDate = resolvedDowntimeDate ? new Date(resolvedDowntimeDate) : null;
    if (resolvedStartTime !== undefined) updateData.startTime = toDateTime(resolvedStartTime, resolvedDowntimeDate || new Date());
    if (resolvedEndTime !== undefined) updateData.endTime = toDateTime(resolvedEndTime, resolvedDowntimeDate || new Date());

    const doc = await prisma.downtimeLog.update({
      where: { id: existing.id },
      data: updateData,
      include: includeRelations(),
    });

    res.json(mapDoc(doc));
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return res.status(404).json({ message: "Data Downtime Log tidak ditemukan." });
    }
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const existing = await prisma.downtimeLog.findUnique({
      where: { downtimeNumber: req.params.downtimeNumber },
      select: { id: true, isDeleted: true },
    });
    if (!existing || existing.isDeleted) {
      return res.status(404).json({ message: "Data Downtime Log tidak ditemukan." });
    }

    await prisma.downtimeLog.update({
      where: { id: existing.id },
      data: { isDeleted: true },
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
};

exports.generateNumber = async (_req, res, next) => {
  try {
    const downtimeNumber = await generateDowntimeNumber();
    res.json({ downtimeNumber });
  } catch (e) {
    next(e);
  }
};
