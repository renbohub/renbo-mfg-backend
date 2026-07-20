const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");

const parseDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const ACTIVE_SCHEDULE_STATUSES = ["Draft", "Released", "In Progress", "Completed"];

const addDays = (date, days = 1) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const dayRange = (value = new Date()) => {
  const date = parseDate(value) || new Date();
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  return { start, end };
};

function resolveCycleMinutes(workOrder, machine, availableMinutes = 408) {
  const routingCycle = Number(workOrder?.cycleTime || 0);
  if (Number.isFinite(routingCycle) && routingCycle > 0) return routingCycle / 60;
  const machineCycleSeconds = Number(machine?.cycleTime || 0);
  if (Number.isFinite(machineCycleSeconds) && machineCycleSeconds > 0) return machineCycleSeconds / 60;
  const rate = Number(machine?.capacity || 0);
  const unit = String(machine?.capacityUnit || "").toLowerCase();
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  if (/jam|hour|hr/.test(unit)) return 60 / rate;
  if (/menit|minute|min/.test(unit)) return 1 / rate;
  if (/hari|day/.test(unit)) return availableMinutes / rate;
  return 0;
}

async function getAllocatedQtyByWorkOrder(tx, woIds = []) {
  if (!woIds.length) return new Map();

  const grouped = await tx.dailyProductionSchedule.groupBy({
    by: ["woId"],
    where: {
      woId: { in: woIds },
      isDeleted: false,
      status: { in: ACTIVE_SCHEDULE_STATUSES },
    },
    _sum: { plannedQty: true },
  });

  return new Map(
    grouped.map((row) => [row.woId, Number(row._sum?.plannedQty || 0)]),
  );
}

async function getMachineLoadMap(tx, machineIds = [], startDate, availableMinutes) {
  if (!machineIds.length) return new Map();

  const rows = await tx.dailyProductionSchedule.findMany({
    where: {
      machineId: { in: machineIds },
      scheduleDate: { gte: startDate },
      isDeleted: false,
      status: { in: ACTIVE_SCHEDULE_STATUSES },
    },
    select: {
      machineId: true,
      shift: true,
      scheduleDate: true,
      plannedQty: true,
      woId: true,
    },
  });

  const woIds = [...new Set(rows.map((row) => row.woId).filter(Boolean))];
  const [workOrders, machines] = await Promise.all([
    woIds.length ? tx.workOrder.findMany({ where: { id: { in: woIds } }, select: { id: true, cycleTime: true } }) : [],
    tx.machine.findMany({ where: { id: { in: machineIds } }, select: { id: true, capacity: true, capacityUnit: true, cycleTime: true } }),
  ]);
  const workOrderById = new Map(workOrders.map((row) => [row.id, row]));
  const machineById = new Map(machines.map((row) => [row.id, row]));

  const loadMap = new Map();
  for (const row of rows) {
    const { start } = dayRange(row.scheduleDate);
    const key = `${row.machineId}::${start.toISOString()}::${row.shift}`;
    const cycleMinutes = resolveCycleMinutes(workOrderById.get(row.woId), machineById.get(row.machineId), availableMinutes);
    loadMap.set(key, Number(loadMap.get(key) || 0) + Number(row.plannedQty || 0) * cycleMinutes);
  }
  return loadMap;
}

async function getWorkOrderPredecessorMap(tx, workOrders = []) {
  const moIds = [...new Set(workOrders.map((wo) => wo.moId).filter(Boolean))];
  if (!moIds.length) return new Map();

  const candidates = await tx.workOrder.findMany({
    where: {
      moId: { in: moIds },
      isDeleted: false,
    },
    select: {
      id: true,
      moId: true,
      sequence: true,
      qtyProduced: true,
      qtyGood: true,
      woNumber: true,
    },
    orderBy: [{ moId: "asc" }, { sequence: "asc" }],
  });

  const byMo = new Map();
  for (const row of candidates) {
    if (!byMo.has(row.moId)) byMo.set(row.moId, []);
    byMo.get(row.moId).push(row);
  }

  const predecessorMap = new Map();
  for (const wo of workOrders) {
    const rows = byMo.get(wo.moId) || [];
    const previous = [...rows]
      .filter(candidate => candidate.id !== wo.id && Number(candidate.sequence || 0) < Number(wo.sequence || 0))
      .sort((a, b) => Number(b.sequence || 0) - Number(a.sequence || 0))[0];
    if (previous) predecessorMap.set(wo.id, previous);
  }

  return predecessorMap;
}

async function generateScheduleNumber(tx = prisma, date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const prefix = `DPS-${y}${m}${d}`;
  const last = await tx.dailyProductionSchedule.findFirst({
    where: { scheduleNumber: { startsWith: prefix } },
    orderBy: { scheduleNumber: "desc" },
    select: { scheduleNumber: true },
  });
  const seq = last ? Number(last.scheduleNumber.split("-").pop()) + 1 : 1;
  return `${prefix}-${String(seq).padStart(3, "0")}`;
}

async function resolveWorkOrder(woNumber) {
  if (!woNumber) return null;
  return prisma.workOrder.findUnique({
    where: { woNumber },
    include: {
      manufacturingOrder: {
        include: { part: { select: { id: true, partCode: true } } },
      },
    },
  });
}

const scheduleInclude = {
  machine: {
    select: {
      id: true,
      machineCode: true,
      machineName: true,
      capacity: true,
      capacityUnit: true,
      cycleTime: true,
    },
  },
};

function mapScheduleDoc(schedule) {
  const doc = mapDoc(schedule);
  return {
    ...doc,
    machineCode: doc.machine?.machineCode || null,
    machineName: doc.machine?.machineName || null,
    machineCapacity: doc.machine?.capacity ?? null,
    machineCapacityUnit: doc.machine?.capacityUnit || null,
  };
}

exports.generateNumber = async (req, res, next) => {
  try {
    const date = parseDate(req.query.date) || new Date();
    res.json({ scheduleNumber: await generateScheduleNumber(prisma, date) });
  } catch (error) {
    next(error);
  }
};

exports.list = async (req, res, next) => {
  try {
    const { q, scheduleDate, shift, status, machineId, isDeleted, page = 1, limit = 100 } = req.query;
    const where = {
      isDeleted: isDeleted === undefined ? false : isDeleted === "true",
    };

    if (scheduleDate) {
      const { start, end } = dayRange(scheduleDate);
      where.scheduleDate = { gte: start, lte: end };
    }
    if (shift) where.shift = shift;
    if (status) where.status = Array.isArray(status) ? { in: status } : status;
    if (machineId) where.machineId = machineId;
    if (q) {
      where.OR = [
        { scheduleNumber: { contains: q, mode: "insensitive" } },
        { moNumber: { contains: q, mode: "insensitive" } },
        { woNumber: { contains: q, mode: "insensitive" } },
        { partCode: { contains: q, mode: "insensitive" } },
        { operatorName: { contains: q, mode: "insensitive" } },
      ];
    }

    const take = Number(limit);
    const skip = (Number(page) - 1) * take;
    const orderBy = buildSort(req.query) || [{ scheduleDate: "asc" }, { shift: "asc" }, { sequence: "asc" }];
    const [items, total] = await Promise.all([
      prisma.dailyProductionSchedule.findMany({ where, orderBy, skip, take, include: scheduleInclude }),
      prisma.dailyProductionSchedule.count({ where }),
    ]);

    res.json({ items: items.map(mapScheduleDoc), total, page: Number(page), limit: take });
  } catch (error) {
    next(error);
  }
};

exports.get = async (req, res, next) => {
  try {
    const schedule = await prisma.dailyProductionSchedule.findUnique({
      where: { scheduleNumber: req.params.scheduleNumber },
      include: scheduleInclude,
    });
    if (!schedule || schedule.isDeleted) return res.status(404).json({ message: "Daily production schedule tidak ditemukan" });
    res.json(mapScheduleDoc(schedule));
  } catch (error) {
    next(error);
  }
};

exports.create = async (req, res, next) => {
  try {
    const body = req.body || {};
    const scheduleDate = parseDate(body.scheduleDate);
    if (!scheduleDate || !body.shift || Number(body.plannedQty || 0) <= 0) {
      return res.status(400).json({ message: "scheduleDate, shift, dan plannedQty wajib diisi." });
    }

    const wo = await resolveWorkOrder(body.woNumber);
    const mo = wo?.manufacturingOrder || null;
    const scheduleNumber = body.scheduleNumber || (await generateScheduleNumber(prisma, scheduleDate));

    const schedule = await prisma.dailyProductionSchedule.create({
      data: {
        scheduleNumber,
        scheduleDate,
        shift: body.shift,
        moId: body.moId || mo?.id || null,
        moNumber: body.moNumber || mo?.moNumber || null,
        woId: body.woId || wo?.id || null,
        woNumber: body.woNumber || wo?.woNumber || null,
        partId: body.partId || mo?.partId || null,
        partCode: body.partCode || mo?.part?.partCode || null,
        processId: body.processId || wo?.processId || null,
        machineId: body.machineId || wo?.machineId || null,
        plannedQty: Number(body.plannedQty || wo?.plannedQty || 0),
        actualQty: Number(body.actualQty || 0),
        uomCode: body.uomCode || wo?.uomCode || mo?.uomCode || null,
        operatorName: body.operatorName || wo?.operatorName || null,
        sequence: Number(body.sequence || wo?.sequence || 0),
        notes: body.notes || null,
        createdBy: req.user?.username || null,
      },
      include: scheduleInclude,
    });

    res.status(201).json(mapScheduleDoc(schedule));
  } catch (error) {
    next(error);
  }
};

exports.update = async (req, res, next) => {
  try {
    const body = req.body || {};
    const schedule = await prisma.dailyProductionSchedule.update({
      where: { scheduleNumber: req.params.scheduleNumber },
      data: {
        ...(body.scheduleDate ? { scheduleDate: parseDate(body.scheduleDate) } : {}),
        ...(body.shift !== undefined ? { shift: body.shift } : {}),
        ...(body.machineId !== undefined ? { machineId: body.machineId || null } : {}),
        ...(body.operatorName !== undefined ? { operatorName: body.operatorName || null } : {}),
        ...(body.sequence !== undefined ? { sequence: Number(body.sequence || 0) } : {}),
        ...(body.plannedQty !== undefined ? { plannedQty: Number(body.plannedQty || 0) } : {}),
        ...(body.actualQty !== undefined ? { actualQty: Number(body.actualQty || 0) } : {}),
        ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
      },
      include: scheduleInclude,
    });
    res.json(mapScheduleDoc(schedule));
  } catch (error) {
    next(error);
  }
};

const setStatus = (status) => async (req, res, next) => {
  try {
    const schedule = await prisma.$transaction(async (tx) => {
      const updated = await tx.dailyProductionSchedule.update({
        where: { scheduleNumber: req.params.scheduleNumber },
        data: {
          status,
          ...(status === "Completed" ? { actualQty: Number(req.body?.actualQty || 0) } : {}),
        },
        include: scheduleInclude,
      });

      if (status === "In Progress" && updated.woId) {
        await tx.workOrder.updateMany({
          where: {
            id: updated.woId,
            isDeleted: false,
            status: { notIn: ["Completed", "Cancelled"] },
          },
          data: { status: "In Production" },
        });
      }

      return updated;
    });
    res.json(mapScheduleDoc(schedule));
  } catch (error) {
    next(error);
  }
};

exports.release = setStatus("Released");
exports.start = setStatus("In Progress");
exports.complete = setStatus("Completed");
exports.cancel = setStatus("Cancelled");

exports.dispatchFromWorkOrders = async (req, res, next) => {
  try {
    const { date, shift, workOrderNumbers = [], shiftHours = 8, efficiencyPercent = 85 } = req.body || {};
    const scheduleDate = parseDate(date);
    if (!scheduleDate || !shift) return res.status(400).json({ message: "date dan shift wajib diisi." });
    const { end: scheduleEnd } = dayRange(scheduleDate);
    const availableMinutesPerShift = Math.max(1, Number(shiftHours || 8) * 60 * Math.min(Math.max(Number(efficiencyPercent || 85), 1), 100) / 100);

    const where = {
      isDeleted: false,
      status: { in: ["Released", "Material Issued", "In Production", "Rework", "Planned", "In Progress"] },
      plannedDate: { lte: scheduleEnd },
      ...(workOrderNumbers.length ? { woNumber: { in: workOrderNumbers } } : {}),
    };

    const workOrders = await prisma.workOrder.findMany({
      where,
      include: {
        manufacturingOrder: { include: { part: { select: { id: true, partCode: true } } } },
        machine: {
          select: {
            id: true,
            machineCode: true,
            machineName: true,
            capacity: true,
            capacityUnit: true,
            cycleTime: true,
          },
        },
      },
      orderBy: [{ plannedDate: "asc" }, { sequence: "asc" }, { woNumber: "asc" }],
    });

    const result = await prisma.$transaction(async (tx) => {
      const rows = [];
      const warnings = [];
      const blocked = [];
      const allocatedMap = await getAllocatedQtyByWorkOrder(tx, workOrders.map(wo => wo.id));
      const predecessorMap = await getWorkOrderPredecessorMap(tx, workOrders);
      const machineLoadMap = await getMachineLoadMap(
        tx,
        [...new Set(workOrders.map(wo => wo.machineId).filter(Boolean))],
        dayRange(scheduleDate).start,
        availableMinutesPerShift,
      );

      for (const [index, wo] of workOrders.entries()) {
        const alreadyAllocatedQty = Number(allocatedMap.get(wo.id) || 0);
        const targetQty = Number(wo.plannedQty || 0);
        let remainingQty = Math.max(0, targetQty - alreadyAllocatedQty);

        const predecessor = predecessorMap.get(wo.id);
        if (predecessor) {
          const predecessorOutputQty = Number(
            predecessor.qtyGood ?? predecessor.qtyProduced ?? 0,
          );
          const predecessorAllocatable = Math.max(0, predecessorOutputQty - alreadyAllocatedQty);
          const qtyBeforeGating = remainingQty;
          remainingQty = Math.min(remainingQty, predecessorAllocatable);

          if (qtyBeforeGating > remainingQty) {
            blocked.push({
              woNumber: wo.woNumber,
              moNumber: wo.manufacturingOrder?.moNumber || null,
              sequence: Number(wo.sequence || 0),
              predecessorWoNumber: predecessor.woNumber,
              predecessorSequence: Number(predecessor.sequence || 0),
              predecessorOutputQty,
              alreadyAllocatedQty,
              dispatchableQty: remainingQty,
              unallocatedQty: Math.max(0, qtyBeforeGating - remainingQty),
              reason: "PREVIOUS_SEQUENCE_OUTPUT_NOT_READY",
            });
          }
        }

        if (remainingQty <= 0) continue;

        const cycleMinutes = resolveCycleMinutes(wo, wo.machine, availableMinutesPerShift);
        if (!wo.machineId) {
          warnings.push({
            woNumber: wo.woNumber,
            moNumber: wo.manufacturingOrder?.moNumber || null,
            sequence: Number(wo.sequence || 0),
            reason: "NO_MACHINE_ASSIGNED",
          });
          blocked.push({
            woNumber: wo.woNumber,
            moNumber: wo.manufacturingOrder?.moNumber || null,
            sequence: Number(wo.sequence || 0),
            unallocatedQty: remainingQty,
            reason: "NO_MACHINE_ASSIGNED",
          });
          continue;
        } else if (cycleMinutes <= 0) {
          warnings.push({
            woNumber: wo.woNumber,
            moNumber: wo.manufacturingOrder?.moNumber || null,
            sequence: Number(wo.sequence || 0),
            machineCode: wo.machine?.machineCode || null,
            reason: "NO_ROUTING_CYCLE_TIME",
          });
          blocked.push({
            woNumber: wo.woNumber,
            moNumber: wo.manufacturingOrder?.moNumber || null,
            sequence: Number(wo.sequence || 0),
            machineCode: wo.machine?.machineCode || null,
            unallocatedQty: remainingQty,
            reason: "NO_ROUTING_CYCLE_TIME",
          });
          continue;
        }
        let cursorDate = dayRange(scheduleDate).start;

        while (remainingQty > 0) {
          const dayStart = dayRange(cursorDate).start;
          let plannedQtyForRow = remainingQty;

          if (wo.machineId && cycleMinutes > 0) {
            const machineKey = `${wo.machineId}::${dayStart.toISOString()}::${shift}`;
            const usedMinutes = Number(machineLoadMap.get(machineKey) || 0);
            const availableMinutes = Math.max(0, availableMinutesPerShift - usedMinutes);

            if (availableMinutes <= 0) {
              cursorDate = addDays(cursorDate, 1);
              continue;
            }

            plannedQtyForRow = Math.min(remainingQty, availableMinutes / cycleMinutes);
            machineLoadMap.set(machineKey, usedMinutes + plannedQtyForRow * cycleMinutes);
          }

          rows.push(await tx.dailyProductionSchedule.create({
            data: {
              scheduleNumber: await generateScheduleNumber(tx, dayStart),
              scheduleDate: dayStart,
              shift,
              moId: wo.moId,
              moNumber: wo.manufacturingOrder?.moNumber || null,
              woId: wo.id,
              woNumber: wo.woNumber,
              partId: wo.manufacturingOrder?.partId || null,
              partCode: wo.manufacturingOrder?.part?.partCode || null,
              processId: wo.processId || null,
              machineId: wo.machineId || null,
              plannedQty: plannedQtyForRow,
              uomCode: wo.uomCode || wo.manufacturingOrder?.uomCode || null,
              operatorName: wo.operatorName || null,
              sequence: Number(wo.sequence || index + 1),
              status: "Draft",
              notes: null,
              createdBy: req.user?.username || null,
            },
            include: scheduleInclude,
          }));

          remainingQty -= plannedQtyForRow;

          if (remainingQty > 0) {
            cursorDate = addDays(cursorDate, 1);
          }
        }
      }
      return { rows, warnings, blocked };
    });

    res.status(201).json({
      items: result.rows.map(mapScheduleDoc),
      total: result.rows.length,
      summary: {
        createdCount: result.rows.length,
        warningCount: result.warnings.length,
        blockedCount: result.blocked.length,
      },
      warnings: result.warnings,
      blocked: result.blocked,
    });
  } catch (error) {
    next(error);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const schedule = await prisma.dailyProductionSchedule.update({
      where: { scheduleNumber: req.params.scheduleNumber },
      data: { isDeleted: true },
      include: scheduleInclude,
    });
    res.json(mapScheduleDoc(schedule));
  } catch (error) {
    next(error);
  }
};
