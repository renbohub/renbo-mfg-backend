const { prisma } = require("../../index");
const { mapDoc } = require("../../utils/mapDoc");
const { parseFilter } = require("../../utils/parseFilter");

const TOLERANCE = 0.000001;
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

const include = {
  productionLog: {
    include: {
      dailyProductionSchedule: { select: { scheduleNumber: true, scheduleDate: true, shift: true } },
      manufacturingOrder: {
        select: {
          moNumber: true,
          uomCode: true,
          part: { select: { partCode: true, partNumber: true, partName: true } },
        },
      },
      workOrder: { select: { woNumber: true, process: { select: { processCode: true, processName: true } } } },
    },
  },
  coilPhase: { select: { phaseNumber: true, coilNumber: true, inputLotNumber: true, productionLotNumber: true } },
};

const present = (row) => mapDoc({
  ...row,
  logNumber: row.productionLog?.logNumber,
  logDate: row.productionLog?.logDate,
  machineCode: row.productionLog?.machineCode,
  shift: row.productionLog?.shift,
  moNumber: row.productionLog?.manufacturingOrder?.moNumber,
  woNumber: row.productionLog?.workOrder?.woNumber,
  processCode: row.productionLog?.workOrder?.process?.processCode || row.productionLog?.processCode,
  processName: row.productionLog?.workOrder?.process?.processName,
  partCode: row.productionLog?.manufacturingOrder?.part?.partCode,
  partNumber: row.productionLog?.manufacturingOrder?.part?.partNumber,
  partName: row.productionLog?.manufacturingOrder?.part?.partName,
  uomCode: row.productionLog?.manufacturingOrder?.uomCode,
  productionLotNumber: row.coilPhase?.productionLotNumber,
  inputLotNumber: row.coilPhase?.inputLotNumber,
});

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(number(req.query.limit) || 20, 1), 500);
    const where = {
      isDeleted: false,
      productionLog: { is: { isDeleted: false, status: { in: ["Submitted", "Approved"] } } },
    };
    const status = parseFilter(req.query.status);
    if (status) where.status = status;
    const q = String(req.query.q || req.query.search || "").trim();
    if (q) {
      where.OR = [
        { reason: { contains: q, mode: "insensitive" } },
        { subReason: { contains: q, mode: "insensitive" } },
        { productionLog: { is: { logNumber: { contains: q, mode: "insensitive" } } } },
      ];
    }
    const [items, total] = await Promise.all([
      prisma.productionLogNgReason.findMany({
        where,
        include,
        orderBy: [{ status: "asc" }, { createdAt: "asc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.productionLogNgReason.count({ where }),
    ]);
    res.json({ items: items.map(present), total, page, limit });
  } catch (error) {
    next(error);
  }
};

exports.get = async (req, res, next) => {
  try {
    const item = await prisma.productionLogNgReason.findFirst({
      where: { id: req.params.id, isDeleted: false },
      include,
    });
    if (!item) return res.status(404).json({ message: "NG QC Judgment tidak ditemukan." });
    res.json(present(item));
  } catch (error) {
    next(error);
  }
};

exports.judge = async (req, res, next) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.productionLogNgReason.findFirst({
        where: { id: req.params.id, isDeleted: false },
        include: { productionLog: { select: { id: true, logNumber: true, status: true } } },
      });
      if (!current) throw Object.assign(new Error("NG QC Judgment tidak ditemukan."), { statusCode: 404 });
      if (current.status !== "PENDING_QC") {
        throw Object.assign(new Error(`NG sudah dijudgment dengan status ${current.status}.`), { statusCode: 409 });
      }
      if (!["Submitted", "Approved"].includes(current.productionLog.status)) {
        throw Object.assign(new Error("Production Log harus Submitted/Approved sebelum QC judgment."), { statusCode: 409 });
      }
      const qtyRework = Math.max(number(req.body.qtyRework), 0);
      const qtyReject = Math.max(number(req.body.qtyReject), 0);
      if (Math.abs(qtyRework + qtyReject - number(current.qtyNg)) > TOLERANCE) {
        throw Object.assign(new Error(`Qty Rework + Qty Reject harus sama dengan Qty NG ${current.qtyNg}.`), { statusCode: 400 });
      }
      const status = qtyRework > TOLERANCE && qtyReject > TOLERANCE
        ? "MIXED"
        : qtyRework > TOLERANCE ? "REWORK" : "REJECT";
      const updated = await tx.productionLogNgReason.update({
        where: { id: current.id },
        data: {
          qtyRework,
          qtyReject,
          status,
          qcNotes: String(req.body.qcNotes || "").trim() || null,
          judgedBy: req.user?.username || req.user?.email || "system",
          judgedAt: new Date(),
        },
        include,
      });
      const aggregate = await tx.productionLogNgReason.aggregate({
        where: { productionLogId: current.productionLogId, isDeleted: false },
        _sum: { qtyRework: true },
      });
      await tx.productionLog.update({
        where: { id: current.productionLogId },
        data: { qtyRework: number(aggregate._sum.qtyRework) },
      });
      return updated;
    });
    res.json({ message: "QC judgment NG tersimpan.", item: present(result) });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};
