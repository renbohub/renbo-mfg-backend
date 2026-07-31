const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { assertQuantity } = require("../../utils/uomQuantity");
const {
  buildAvailability,
} = require("./services/productionWorkflowService");

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

/**
 * Resolve the consumable purchase/material children for one DPP process.
 *
 * A DPP process is executed by the parent MO, but its Material Issue must be
 * scoped to the BOM detail represented by that DPP.  Using the parent MO's
 * complete availability here would issue every material in the finished-good
 * BOM (and at the full MO quantity) for every daily process.
 */
async function buildScheduleMaterialAvailability(tx, schedule, mo) {
  const targetPartCode = String(schedule?.partCode || "").trim();
  if (!targetPartCode || !mo) return { items: [], mbomHeader: null };

  const [parentHeader, candidates] = await Promise.all([
    mo.partId
      ? tx.mBOMHeader.findFirst({
          where: { partId: mo.partId, isDeleted: false },
          select: { noReg: true },
          orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
        })
      : null,
    tx.mBOMDetail.findMany({
      where: {
        isDeleted: false,
        part: { partCode: targetPartCode },
        mbomHeader: { isDeleted: false },
      },
      select: {
        id: true,
        noReg: true,
        parentDetailId: true,
        mbomHeader: {
          select: { noReg: true, partId: true, revision: true, updatedAt: true },
        },
      },
    }),
  ]);
  if (!candidates.length) return { items: [], mbomHeader: null };

  // Prefer the parent MO BOM when the same process code exists in both the
  // parent and an attached child BOM; otherwise use the newest active BOM.
  const target = [...candidates].sort((left, right) => {
    const leftParent = left.noReg === parentHeader?.noReg ? 1 : 0;
    const rightParent = right.noReg === parentHeader?.noReg ? 1 : 0;
    if (leftParent !== rightParent) return rightParent - leftParent;
    return Number(right.mbomHeader?.revision || 0) - Number(left.mbomHeader?.revision || 0)
      || new Date(right.mbomHeader?.updatedAt || 0).getTime() - new Date(left.mbomHeader?.updatedAt || 0).getTime();
  })[0];

  const qtyPlanned = Number(schedule.plannedQty || 0);
  if (!Number.isFinite(qtyPlanned) || qtyPlanned <= 0) return { items: [], mbomHeader: target.mbomHeader };

  // Rebuild availability against the selected BOM and the DPP quantity. The
  // parent MO id is retained for stock context, but the quantity is daily.
  const scopedMo = {
    ...mo,
    partId: target.mbomHeader?.partId || mo.partId,
    qtyPlanned,
  };
  const availability = await buildAvailability(tx, scopedMo, {
    // Material production is issued in its purchasing/base weight unit (kg),
    // while PURCHASE_PART remains in the discrete BOM UOM (normally pcs).
    // Do not inherit an old MO-wide KG mode because a single production item
    // may have both material and purchase-part children.
    requirementUomMode: "BY_ITEM_TYPE",
    ignoreMaterialIssues: true,
    ignoreReservations: true,
    // Daily Production consumes every direct BOM child of the scheduled
    // production item. This includes raw/purchase material, WIP, child FG,
    // and FG COMP. Deeper descendants remain owned by their own Daily Plan.
    includeDirectProductionInputs: true,
  });

  // Scope strictly to one level below the scheduled production item. The
  // parentDetailId relation is the source of truth; item type/category is not
  // used to silently drop WIP/FG/COMP inputs.
  return {
    ...availability,
    items: (availability.items || []).filter((item) => item.parentDetailId === target.id),
    mbomHeader: target.mbomHeader,
  };
}

async function ensureMaterialIssueDraft(tx, schedule, performedBy = "system") {
  if (!schedule?.moId) return null;
  const existing = await tx.materialIssue.findFirst({
    where: { moId: schedule.moId, woId: schedule.woId || null, isDeleted: false, notes: { contains: `[DPS-CONSUME:${schedule.scheduleNumber}]` } },
    include: { details: { where: { isDeleted: false } } },
  });
  if (existing && existing.status !== "Draft") return existing;
  const warehouse = await tx.warehouse.findFirst({ where: { isDeleted: false, isActive: true, availableForProduction: true }, orderBy: { warehouseCode: "asc" }, select: { warehouseCode: true } });
  if (!warehouse) return existing || null;
  const mo = await tx.manufacturingOrder.findUnique({ where: { id: schedule.moId }, select: { id: true, moNumber: true, partId: true, qtyPlanned: true, uomCode: true, materialRequirementUomMode: true, inputSourceType: true, sourceStockBalanceId: true, sourceQtyPlanned: true, sourcePartCode: true, sourcePartNumber: true, sourceWarehouseCode: true, sourceRackCode: true, sourceLotNumber: true } });
  const availability = mo
    ? await buildScheduleMaterialAvailability(tx, schedule, mo)
    : { items: [] };
  const issueDetails = (availability.items || []).filter((item) => Number(item.qtyRemaining || item.qtyRequired || 0) > 0).map((item, index) => ({
    lineNumber: index + 1,
    partCode: item.partCode,
    partNumber: item.partNumber,
    partName: item.partName,
    spec: item.spec,
    thickness: item.thickness,
    width: item.width,
    CSP: item.CSP,
    stockBalanceId: item.stockBalanceId,
    requirementSource: item.requirementSource || "MBOM",
    rackCode: item.rackCode,
    qtyRequired: Number(item.qtyRemaining || item.qtyRequired || 0),
    qtyIssued: Number(item.qtyRemaining || item.qtyRequired || 0),
    uomCode: item.uomCode,
    lotNumber: item.lotNumber,
    notes: [
      "Prepared from Daily Production Plan consume",
      item.requirementSource ? `source=${item.requirementSource}` : null,
      item.parentPartCode ? `parent=${item.parentPartCode}` : null,
      item.itemType ? `itemType=${item.itemType}` : null,
    ].filter(Boolean).join("; "),
  }));
  if (existing) {
    // Reconcile an automatically prepared Draft created before material
    // scoping was process-aware. Issued/closed documents are never changed.
    await tx.materialIssueDetail.updateMany({
      where: { issueId: existing.id, isDeleted: false },
      data: { isDeleted: true },
    });
    if (issueDetails.length) {
      await tx.materialIssueDetail.createMany({
        data: issueDetails.map((detail) => ({ ...detail, issueId: existing.id })),
      });
    }
    return tx.materialIssue.findUnique({
      where: { id: existing.id },
      include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } },
    });
  }
  const day = schedule.scheduleDate instanceof Date ? schedule.scheduleDate : new Date(schedule.scheduleDate);
  const prefix = `MI-${day.getUTCFullYear()}${String(day.getUTCMonth() + 1).padStart(2, "0")}${String(day.getUTCDate()).padStart(2, "0")}`;
  const last = await tx.materialIssue.findFirst({ where: { issueNumber: { startsWith: prefix } }, orderBy: { issueNumber: "desc" }, select: { issueNumber: true } });
  const sequence = Number(last?.issueNumber?.split("-").pop() || 0) + 1;
  return tx.materialIssue.create({
    data: { issueNumber: `${prefix}-${String(sequence).padStart(3, "0")}`, issueDate: new Date(), moId: schedule.moId, woId: schedule.woId || null, warehouseCode: warehouse.warehouseCode, issuedBy: performedBy, status: "Draft", notes: `[DPS-CONSUME:${schedule.scheduleNumber}] Material issue dibuat otomatis; lakukan consume di Inventory.`, details: { create: issueDetails } },
    include: { details: { where: { isDeleted: false } } },
  });
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

const machineSelect = {
  id: true,
  machineCode: true,
  machineName: true,
  capacity: true,
  capacityUnit: true,
  cycleTime: true,
};

async function attachScheduleMachines(client, schedules = []) {
  const items = Array.isArray(schedules) ? schedules : [schedules];
  const machineIds = [...new Set(items.map((row) => row?.machineId).filter(Boolean))];
  const processIds = [...new Set(items.map((row) => row?.processId).filter(Boolean))];
  const [machines, processes] = await Promise.all([
    machineIds.length
      ? client.machine.findMany({ where: { id: { in: machineIds } }, select: machineSelect })
      : [],
    processIds.length
      ? client.process.findMany({
          where: { id: { in: processIds }, isDeleted: false },
          select: { id: true, processCode: true, processName: true },
        })
      : [],
  ]);
  const machineById = new Map(machines.map((row) => [row.id, row]));
  const processById = new Map(processes.map((row) => [row.id, row]));
  const hydrated = items.map((row) => row ? {
    ...row,
    machine: machineById.get(row.machineId) || null,
    process: processById.get(row.processId) || null,
  } : row);
  return Array.isArray(schedules) ? hydrated : hydrated[0];
}

function mapScheduleDoc(schedule) {
  const doc = mapDoc(schedule);
  const ppicMarker = String(doc.notes || "").match(/\[PPIC-DPP:([^:\]]+):(\d+):/);
  return {
    ...doc,
    machineCode: doc.machine?.machineCode || null,
    machineName: doc.machine?.machineName || null,
    machineCapacity: doc.machine?.capacity ?? null,
    machineCapacityUnit: doc.machine?.capacityUnit || null,
    processCode: doc.process?.processCode || null,
    processName: doc.process?.processName || null,
    sourceModule: ppicMarker ? "PPIC" : "Production",
    monthlyProductionPlanNumber: ppicMarker?.[1] || null,
    monthlyProductionPlanLineNumber: ppicMarker ? Number(ppicMarker[2]) : null,
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

    if (String(req.query.sourceModule || "").toUpperCase() === "PPIC") {
      where.notes = { contains: "[PPIC-DPP:" };
    }
    if (req.query.planNumber) {
      where.notes = { contains: `[PPIC-DPP:${String(req.query.planNumber).trim()}:` };
    }
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
      prisma.dailyProductionSchedule.findMany({ where, orderBy, skip, take }),
      prisma.dailyProductionSchedule.count({ where }),
    ]);
    const hydratedItems = await attachScheduleMachines(prisma, items);

    res.json({ items: hydratedItems.map(mapScheduleDoc), total, page: Number(page), limit: take });
  } catch (error) {
    next(error);
  }
};

exports.get = async (req, res, next) => {
  try {
    const schedule = await prisma.dailyProductionSchedule.findUnique({
      where: { scheduleNumber: req.params.scheduleNumber },
    });
    if (!schedule || schedule.isDeleted) return res.status(404).json({ message: "Daily production schedule tidak ditemukan" });
    if (String(req.query.sourceModule || "").toUpperCase() === "PPIC" && !String(schedule.notes || "").includes("[PPIC-DPP:")) {
      return res.status(404).json({ message: "Daily Production Plan PPIC tidak ditemukan" });
    }
    const [manufacturingOrder, workOrder, materialIssues, productionLogs] = await Promise.all([
      schedule.moId ? prisma.manufacturingOrder.findFirst({
        where: { id: schedule.moId, isDeleted: false },
        select: {
          id: true,
          moNumber: true,
          monthlyProductionPlanNumber: true,
          monthlyProductionPlanLineNumber: true,
          qtyPlanned: true,
          qtyProduced: true,
          qtyGood: true,
          qtyReject: true,
          status: true,
        },
      }) : null,
      schedule.woId ? prisma.workOrder.findFirst({
        where: { id: schedule.woId, isDeleted: false },
        select: {
          woNumber: true,
          status: true,
          sequence: true,
          outputPartCode: true,
          plannedQty: true,
          qtyProduced: true,
          process: { select: { processCode: true, processName: true } },
          machine: { select: { machineCode: true, machineName: true } },
        },
      }) : null,
      prisma.materialIssue.findMany({
        where: {
          isDeleted: false,
          notes: { contains: `[DPS-CONSUME:${schedule.scheduleNumber}]` },
        },
        select: {
          issueNumber: true,
          issueDate: true,
          warehouseCode: true,
          status: true,
          issuedBy: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.productionLog.findMany({
        where: {
          isDeleted: false,
          OR: [
            { dpsId: schedule.id },
            ...(schedule.woId ? [{ woId: schedule.woId }] : []),
          ],
        },
        select: {
          logNumber: true,
          logDate: true,
          shift: true,
          qtyProduced: true,
          qtyGood: true,
          qtyReject: true,
          status: true,
        },
        orderBy: [{ logDate: "asc" }, { createdAt: "asc" }],
      }),
    ]);
    const blockers = [
      ...(!manufacturingOrder ? [{
        severity: "BLOCKING",
        code: "MO_REFERENCE_MISSING",
        title: schedule.scheduleNumber,
        message: "Daily Production belum mempunyai reference Manufacturing Order.",
      }] : []),
      ...(!workOrder ? [{
        severity: "BLOCKING",
        code: "WO_REFERENCE_MISSING",
        title: schedule.partCode || schedule.scheduleNumber,
        message: "Daily Production belum mempunyai Work Order/process yang dapat dieksekusi.",
      }] : []),
      ...materialIssues
        .filter((issue) => !["Issued", "Partially Returned", "Closed"].includes(issue.status))
        .map((issue) => ({
          severity: "BLOCKING",
          code: "MATERIAL_ISSUE_NOT_POSTED",
          title: issue.issueNumber,
          message: `Material Issue masih ${issue.status}; lakukan Consume / Issue di Inventory sebelum Production Log disubmit.`,
          issueNumber: issue.issueNumber,
        })),
      ...(productionLogs.length > 0 && schedule.status === "Draft" ? [{
        severity: "WARNING",
        code: "DPS_STATUS_NOT_SYNCED",
        title: schedule.scheduleNumber,
        message: "Production Log sudah tersedia tetapi Daily Production masih Draft. Submit ulang log untuk menyinkronkan status.",
      }] : []),
    ];
    res.json({
      ...mapScheduleDoc(await attachScheduleMachines(prisma, schedule)),
      manufacturingOrderReference: manufacturingOrder,
      workOrderReference: workOrder,
      materialIssueReferences: materialIssues,
      productionLogReferences: productionLogs,
      blockers,
      references: {
        manufacturingOrder,
        workOrder,
        materialIssues,
        productionLogs,
      },
    });
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
    const uomCode = body.uomCode || wo?.uomCode || mo?.uomCode || null;
    assertQuantity(body.plannedQty || wo?.plannedQty || 0, uomCode, "Planned Qty");
    if (body.actualQty != null && Number(body.actualQty) > 0) assertQuantity(body.actualQty, uomCode, "Actual Qty");
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
        uomCode,
        operatorName: body.operatorName || wo?.operatorName || null,
        sequence: Number(body.sequence || wo?.sequence || 0),
        notes: body.notes || null,
        createdBy: req.user?.username || null,
      },
    });

    res.status(201).json(mapScheduleDoc(await attachScheduleMachines(prisma, schedule)));
  } catch (error) {
    next(error);
  }
};

exports.update = async (req, res, next) => {
  try {
    const body = req.body || {};
    const existing = await prisma.dailyProductionSchedule.findUnique({ where: { scheduleNumber: req.params.scheduleNumber }, select: { uomCode: true } });
    const uomCode = body.uomCode || existing?.uomCode || null;
    if (body.plannedQty !== undefined) assertQuantity(body.plannedQty, uomCode, "Planned Qty");
    if (body.actualQty !== undefined && Number(body.actualQty) > 0) assertQuantity(body.actualQty, uomCode, "Actual Qty");
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
    });
    res.json(mapScheduleDoc(await attachScheduleMachines(prisma, schedule)));
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

      return attachScheduleMachines(tx, updated);
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

// Production consumes the Daily Production Plan prepared by PPIC. This is
// intentionally separate from Inventory's Issue action: consume creates a
// Draft Material Issue for warehouse preparation, while Inventory later
// issues/consumes stock and records the outbound movement.
exports.consume = async (req, res, next) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const schedule = await tx.dailyProductionSchedule.findUnique({ where: { scheduleNumber: req.params.scheduleNumber } });
      if (!schedule || schedule.isDeleted) throw Object.assign(new Error("Daily production schedule tidak ditemukan"), { statusCode: 404 });
      if (!["Draft", "Released"].includes(schedule.status)) throw Object.assign(new Error(`Daily plan ${schedule.scheduleNumber} tidak dapat dikonsumsi dari status ${schedule.status}.`), { statusCode: 409 });
      const updated = schedule.status === "Draft" ? await tx.dailyProductionSchedule.update({ where: { scheduleNumber: schedule.scheduleNumber }, data: { status: "Released" } }) : schedule;
      if (updated.woId) await tx.workOrder.updateMany({ where: { id: updated.woId, isDeleted: false, status: { in: ["Draft", "Planned"] } }, data: { status: "Released" } });
      const materialIssue = await ensureMaterialIssueDraft(tx, updated, req.user?.username || req.user?.email || "system");
      return { schedule: mapScheduleDoc(await attachScheduleMachines(tx, updated)), materialIssue };
    });
    res.json(result);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

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
      const minimumSequenceByMo = new Map();
      for (const wo of workOrders) {
        const current = minimumSequenceByMo.get(wo.moId);
        if (current == null || Number(wo.sequence || 0) < current) {
          minimumSequenceByMo.set(wo.moId, Number(wo.sequence || 0));
        }
      }
      const materialAvailabilityByMo = new Map();
      for (const wo of workOrders) {
        if (!wo.manufacturingOrder || materialAvailabilityByMo.has(wo.moId)) continue;
        materialAvailabilityByMo.set(
          wo.moId,
          await buildAvailability(tx, wo.manufacturingOrder),
        );
      }
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

        const isFirstSequence = Number(wo.sequence || 0) === minimumSequenceByMo.get(wo.moId);
        const materialAvailability = materialAvailabilityByMo.get(wo.moId);
        if (isFirstSequence && materialAvailability && !materialAvailability.isAvailable) {
          const shortages = (materialAvailability.items || [])
            .filter((item) => Number(item.shortage || 0) > 0)
            .map((item) => ({
              partCode: item.partCode,
              requiredQty: Number(item.qtyRequired || 0),
              availableQty: Number(item.qtyAvailable || 0),
              shortageQty: Number(item.shortage || 0),
              uomCode: item.uomCode || null,
            }));
          blocked.push({
            woNumber: wo.woNumber,
            moNumber: wo.manufacturingOrder?.moNumber || null,
            sequence: Number(wo.sequence || 0),
            unallocatedQty: remainingQty,
            reason: "MATERIAL_NOT_AVAILABLE",
            shortages,
          });
          continue;
        }

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
      items: (await attachScheduleMachines(prisma, result.rows)).map(mapScheduleDoc),
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
    });
    res.json(mapScheduleDoc(await attachScheduleMachines(prisma, schedule)));
  } catch (error) {
    next(error);
  }
};
