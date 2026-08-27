const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { generateMovementNumber } = require("../../utils/movementNumberGenerator");
const { parseFilter } = require("../../utils/parseFilter");
const { assertStockBalanceNotFrozen, assertStockIdentityNotFrozen } = require("../inventory/utils/stockOpnameFreezeGuard");

function formatQtyWithUom(qty, uomCode) {
  return [qty, uomCode].filter((value) => value !== null && value !== undefined && value !== "").join(" ");
}

function normalizePartBaseOn(value) {
  return String(value || "").trim().toUpperCase();
}

function getPreferredPartBase(part = {}) {
  const bases = Array.isArray(part.partBases) ? part.partBases : [];
  return (
    bases.find((base) => normalizePartBaseOn(base.baseOn) === "ACTUAL") ||
    bases.find((base) => ["QTN", "QUOTATION"].includes(normalizePartBaseOn(base.baseOn))) ||
    bases[0] ||
    {}
  );
}

function resolvePartStockIdentity(part = {}) {
  const partBase = getPreferredPartBase(part);
  return {
    partNumber: part.partNumber || null,
    partName: part.partName || null,
    spec: part.material?.spec || null,
    thickness: partBase.thickness ?? null,
    width: partBase.width ?? null,
    CSP: partBase.CSP || null,
  };
}

function pickMovementPartIdentity(movement = {}) {
  return {
    partCode: movement.partCode || null,
    partNumber: movement.partNumber || null,
    partName: movement.partName || null,
    uomCode: movement.uomCode || null,
    warehouseCode: movement.warehouseCode || null,
    rackCode: movement.rackCode || null,
    lotNumber: movement.lotNumber || null,
  };
}

function mergePartIdentity(current = {}, next = {}) {
  return {
    partCode: current.partCode || next.partCode || null,
    partNumber: current.partNumber || next.partNumber || null,
    partName: current.partName || next.partName || null,
    uomCode: current.uomCode || next.uomCode || null,
    warehouseCode: current.warehouseCode || next.warehouseCode || null,
    rackCode: current.rackCode || next.rackCode || null,
    lotNumber: current.lotNumber || next.lotNumber || null,
  };
}

async function hydratePartIdentities(tx, identityByEntryId) {
  const partCodes = [
    ...new Set(
      [...identityByEntryId.values()]
        .map((identity) => identity.partCode)
        .filter(Boolean),
    ),
  ];
  if (partCodes.length === 0) return;

  const parts = await tx.part.findMany({
    where: { partCode: { in: partCodes }, isDeleted: false },
    select: { partCode: true, partNumber: true, partName: true },
  });
  const partByCode = new Map(parts.map((part) => [part.partCode, part]));

  for (const [entryId, identity] of identityByEntryId.entries()) {
    const part = partByCode.get(identity.partCode);
    if (!part) continue;
    identityByEntryId.set(entryId, mergePartIdentity(identity, part));
  }
}

async function resolveWipEntryPartIdentities(tx, entries = []) {
  const identityByEntryId = new Map();

  const setIdentity = (entryId, identity) => {
    if (!entryId || !identity?.partCode) return;
    identityByEntryId.set(
      entryId,
      mergePartIdentity(identityByEntryId.get(entryId), identity),
    );
  };

  for (const entry of entries) {
    setIdentity(entry.id, {
      partCode: entry.partCode || null,
      partNumber: entry.partNumber || null,
      partName: entry.partName || null,
      uomCode: entry.uomCode || null,
      warehouseCode: entry.warehouseCode || null,
      rackCode: entry.rackCode || null,
      lotNumber: entry.lotNumber || null,
    });
  }

  const productionInputEntries = entries.filter(
    (entry) => entry.sourceType === "ProductionInput" && entry.sourceRef,
  );
  const productionInputRefs = [...new Set(productionInputEntries.map((entry) => entry.sourceRef))];
  if (productionInputRefs.length > 0) {
    const movements = await tx.stockMovement.findMany({
      where: {
        referenceType: "PRODUCTION_LOG",
        referenceNumber: { in: productionInputRefs },
        transactionType: "PRODUCTION",
        movementType: "OUT",
        isDeleted: false,
      },
      orderBy: { createdAt: "desc" },
      select: {
        referenceNumber: true,
        partCode: true,
        partNumber: true,
        partName: true,
        uomCode: true,
        warehouseCode: true,
        rackCode: true,
        lotNumber: true,
      },
    });
    const movementByLog = new Map();
    for (const movement of movements) {
      if (!movementByLog.has(movement.referenceNumber)) {
        movementByLog.set(movement.referenceNumber, movement);
      }
    }
    for (const entry of productionInputEntries) {
      setIdentity(entry.id, pickMovementPartIdentity(movementByLog.get(entry.sourceRef)));
    }
  }

  const workOrderIds = [
    ...new Set(
      entries
        .filter((entry) => entry.woId && entry.sourceType === "WorkOrder")
        .map((entry) => entry.woId),
    ),
  ];
  if (workOrderIds.length > 0) {
    const logs = await tx.productionLog.findMany({
      where: { woId: { in: workOrderIds }, isDeleted: false },
      select: { logNumber: true, woId: true },
    });
    const logByNumber = new Map(logs.map((log) => [log.logNumber, log]));
    const logNumbers = logs.map((log) => log.logNumber).filter(Boolean);
    if (logNumbers.length > 0) {
      const movements = await tx.stockMovement.findMany({
        where: {
          referenceType: "PRODUCTION_LOG",
          referenceNumber: { in: logNumbers },
          transactionType: "QC_HOLD",
          movementType: "IN",
          isDeleted: false,
        },
        orderBy: { createdAt: "desc" },
        select: {
          referenceNumber: true,
          partCode: true,
          partNumber: true,
          partName: true,
          uomCode: true,
          warehouseCode: true,
          rackCode: true,
          lotNumber: true,
        },
      });
      const movementByWoId = new Map();
      for (const movement of movements) {
        const log = logByNumber.get(movement.referenceNumber);
        if (log?.woId && !movementByWoId.has(log.woId)) {
          movementByWoId.set(log.woId, movement);
        }
      }
      for (const entry of entries) {
        if (entry.sourceType === "WorkOrder") {
          setIdentity(entry.id, pickMovementPartIdentity(movementByWoId.get(entry.woId)));
        }
      }
    }
  }

  await hydratePartIdentities(tx, identityByEntryId);
  return identityByEntryId;
}

async function decorateWipEntries(tx, entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const partIdentityByEntryId = await resolveWipEntryPartIdentities(tx, entries);
  return entries.map((entry) => ({
    ...mapDoc(entry),
    ...(partIdentityByEntryId.get(entry.id) || {}),
  }));
}

// Generate nomor WIP entry: WIP-YYYYMMDD-0001
async function generateEntryNumber(tx) {
  const db = tx || prisma;
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const prefix = `WIP-${y}${m}${d}`;

  const last = await db.wIPEntry.findFirst({
    where: { entryNumber: { startsWith: prefix } },
    orderBy: { entryNumber: "desc" },
    select: { entryNumber: true },
  });

  let seq = 1;
  if (last) {
    const parts = last.entryNumber.split("-");
    seq = parseInt(parts[parts.length - 1], 10) + 1;
  }
  return `${prefix}-${String(seq).padStart(4, "0")}`;
}

// ============================================================
// CRUD + LIST
// ============================================================

exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      page = 1,
      limit = 20,
      moId,
      woId,
      costType,
      sourceType,
      direction,
      startDate,
      endDate,
    } = req.query;

    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    if (moId) where.moId = moId;
    if (woId) where.woId = woId;
    if (costType) where.costType = costType;
    if (sourceType) where.sourceType = sourceType;
    if (direction) where.direction = direction;

    if (startDate || endDate) {
      where.entryDate = {};
      if (startDate) where.entryDate.gte = new Date(startDate);
      if (endDate) where.entryDate.lte = new Date(endDate);
    }

    if (q) {
      where.OR = [
        { entryNumber: { contains: q, mode: "insensitive" } },
        { sourceRef: { contains: q, mode: "insensitive" } },
        { notes: { contains: q, mode: "insensitive" } },
        { manufacturingOrder: { moNumber: { contains: q, mode: "insensitive" } } },
      ];
    }

    const orderBy = buildSort(req.query, { defaultSort: { entryDate: "desc" } });
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.wIPEntry.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
        include: {
          manufacturingOrder: {
            select: { moNumber: true, status: true, part: { select: { partCode: true, partName: true } } },
          },
          workOrder: { select: { woNumber: true, status: true } },
        },
      }),
      prisma.wIPEntry.count({ where }),
    ]);

    res.json({
      items: await decorateWipEntries(prisma, items),
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
    const doc = await prisma.wIPEntry.findFirst({
      where: { entryNumber: req.params.entryNumber, isDeleted: false },
      include: {
        manufacturingOrder: {
          select: {
            moNumber: true, status: true, qtyPlanned: true,
            part: { select: { partCode: true, partNumber: true, partName: true } },
          },
        },
        workOrder: {
          select: { woNumber: true, status: true, machineId: true, processId: true,
            machine: { select: { machineCode: true, machineName: true } },
            process: { select: { processCode: true, processName: true } },
          },
        },
      },
    });

    if (!doc) return res.status(404).json({ message: "Data WIP Entry tidak ditemukan." });

    const [decorated] = await decorateWipEntries(prisma, [doc]);
    res.json(decorated);
  } catch (e) {
    next(e);
  }
};

// Manual WIP entry (untuk adjustment / overhead manual)
exports.create = async (req, res, next) => {
  try {
    const entryNumber = await generateEntryNumber();
    const doc = await prisma.wIPEntry.create({
      data: {
        ...req.body,
        entryNumber,
        createdBy: req.user?.username || null,
      },
      include: {
        manufacturingOrder: { select: { moNumber: true } },
        workOrder: { select: { woNumber: true } },
      },
    });
    res.status(201).json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const existing = await prisma.wIPEntry.findFirst({
      where: { entryNumber: req.params.entryNumber, isDeleted: false },
    });
    if (!existing) return res.status(404).json({ message: "Data WIP Entry tidak ditemukan." });

    const doc = await prisma.wIPEntry.update({
      where: { id: existing.id },
      data: req.body,
    });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const existing = await prisma.wIPEntry.findFirst({
      where: { entryNumber: req.params.entryNumber, isDeleted: false },
    });
    if (!existing) return res.status(404).json({ message: "Data WIP Entry tidak ditemukan." });

    await prisma.wIPEntry.update({
      where: { id: existing.id },
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
    const result = await prisma.wIPEntry.updateMany({
      where: { id: { in: ids }, isDeleted: false },
      data: { isDeleted: true },
    });
    res.json({ deletedCount: result.count });
  } catch (e) {
    next(e);
  }
};

exports.generateNumber = async (req, res, next) => {
  try {
    const entryNumber = await generateEntryNumber();
    res.json({ entryNumber });
  } catch (e) {
    next(e);
  }
};

// ============================================================
// WIP BALANCE PER MO (Saldo WIP per Manufacturing Order)
// ============================================================

exports.balanceByMO = async (req, res, next) => {
  try {
    const { moId } = req.params;

    const mo = await prisma.manufacturingOrder.findUnique({
      where: { id: moId },
      select: {
        id: true, moNumber: true, status: true, qtyPlanned: true,
        part: { select: { partCode: true, partName: true } },
      },
    });
    if (!mo) return res.status(404).json({ message: "Manufacturing Order tidak ditemukan." });

    // Aggregasi WIP per cost type
    const entries = await prisma.wIPEntry.findMany({
      where: { moId, isDeleted: false },
      select: { costType: true, direction: true, amount: true, qty: true },
    });

    const summary = { Material: 0, Labor: 0, Overhead: 0, Scrap: 0 };
    let totalIn = 0;
    let totalOut = 0;

    for (const e of entries) {
      const amt = Number(e.amount || 0);
      if (e.direction === "IN") {
        summary[e.costType] = (summary[e.costType] || 0) + amt;
        totalIn += amt;
      } else {
        summary[e.costType] = (summary[e.costType] || 0) - amt;
        totalOut += amt;
      }
    }

    const wipBalance = totalIn - totalOut;

    res.json({
      manufacturingOrder: mapDoc(mo),
      costBreakdown: summary,
      totalIn,
      totalOut,
      wipBalance,
      entryCount: entries.length,
    });
  } catch (e) {
    next(e);
  }
};

// ============================================================
// WIP SUMMARY (Dashboard overview semua MO aktif)
// ============================================================

exports.summary = async (req, res, next) => {
  try {
    // Ambil semua MO yang in progress
    const activeMOs = await prisma.manufacturingOrder.findMany({
      where: { status: "In Progress", isDeleted: false },
      select: { id: true, moNumber: true, part: { select: { partCode: true, partName: true } } },
    });

    const moIds = activeMOs.map((m) => m.id);

    // Aggregasi WIP entries per MO
    const entries = await prisma.wIPEntry.findMany({
      where: { moId: { in: moIds }, isDeleted: false },
      select: { moId: true, costType: true, direction: true, amount: true },
    });

    // Group by moId
    const moMap = new Map();
    for (const mo of activeMOs) {
      moMap.set(mo.id, {
        moNumber: mo.moNumber,
        partCode: mo.part?.partCode,
        partName: mo.part?.partName,
        Material: 0,
        Labor: 0,
        Overhead: 0,
        Scrap: 0,
        wipBalance: 0,
      });
    }

    for (const e of entries) {
      const row = moMap.get(e.moId);
      if (!row) continue;
      const amt = Number(e.amount || 0);
      if (e.direction === "IN") {
        row[e.costType] = (row[e.costType] || 0) + amt;
        row.wipBalance += amt;
      } else {
        row[e.costType] = (row[e.costType] || 0) - amt;
        row.wipBalance -= amt;
      }
    }

    const items = Array.from(moMap.values());
    const grandTotal = items.reduce((s, r) => s + r.wipBalance, 0);

    res.json({
      items,
      activeMoCount: items.length,
      grandTotalWIP: grandTotal,
    });
  } catch (e) {
    next(e);
  }
};

// ============================================================
// WIP QTY SUMMARY (Progress fisik qty per MO aktif)
// ============================================================

exports.qtySummary = async (req, res, next) => {
  try {
    const {
      partCode,
      status = "In Progress",
      startDate,
      endDate,
      page = 1,
      limit = 20,
    } = req.query;

    const where = { isDeleted: false };

    // Default: tampilkan MO yang In Progress; bisa di-override ke "Draft,In Progress,Completed" dll
    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;

    if (startDate || endDate) {
      where.plannedStartDate = {};
      if (startDate) where.plannedStartDate.gte = new Date(startDate);
      if (endDate)   where.plannedStartDate.lte = new Date(endDate);
    }

    if (partCode) {
      where.part = { partCode: { contains: partCode, mode: "insensitive" } };
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [mos, total] = await Promise.all([
      prisma.manufacturingOrder.findMany({
        where,
        skip,
        take: Number(limit),
        orderBy: { moDate: "desc" },
        select: {
          id: true,
          moNumber: true,
          moDate: true,
          status: true,
          qtyPlanned: true,
          qtyProduced: true,
          qtyGood: true,
          qtyReject: true,
          plannedStartDate: true,
          plannedEndDate: true,
          actualStartDate: true,
          actualEndDate: true,
          notes: true,
          part: {
            select: { partCode: true, partNumber: true, partName: true },
          },
          workOrders: {
            where: { isDeleted: false },
            orderBy: { sequence: "asc" },
            select: {
              id: true,
              woNumber: true,
              sequence: true,
              status: true,
              shift: true,
              plannedDate: true,
              plannedQty: true,
              qtyProduced: true,
              qtyGood: true,
              qtyReject: true,
              startTime: true,
              endTime: true,
              runningMinutes: true,
              process: { select: { processCode: true, processName: true } },
              machine: { select: { machineCode: true, machineName: true } },
            },
          },
        },
      }),
      prisma.manufacturingOrder.count({ where }),
    ]);

    // Hitung progress per MO
    const items = mos.map((mo) => {
      const qtyNgQueue = Math.max(0, Number(mo.qtyReject || 0));
      const qtyOpen = Math.max(0, Number(mo.qtyPlanned || 0) - Number(mo.qtyGood || 0));
      const qtyRemaining = Math.max(0, qtyOpen - qtyNgQueue);
      const progressPct =
        mo.qtyPlanned > 0
          ? Math.min(100, Math.round((mo.qtyGood / mo.qtyPlanned) * 100))
          : 0;

      // Tentukan proses yang sedang aktif (WO status In Progress)
      const activeWO = mo.workOrders.find((w) => w.status === "In Progress");

      return {
        moNumber: mo.moNumber,
        moDate: mo.moDate,
        status: mo.status,
        part: mo.part,
        qtyPlanned: mo.qtyPlanned,
        qtyProduced: mo.qtyProduced,
        qtyGood: mo.qtyGood,
        qtyReject: mo.qtyReject,
        qtyNgQueue,
        qtyOpen,
        qtyRemaining,
        progressPct,
        plannedStartDate: mo.plannedStartDate,
        plannedEndDate: mo.plannedEndDate,
        actualStartDate: mo.actualStartDate,
        actualEndDate: mo.actualEndDate,
        currentProcess: activeWO
          ? {
              woNumber: activeWO.woNumber,
              processCode: activeWO.process?.processCode || null,
              processName: activeWO.process?.processName || null,
              machineCode: activeWO.machine?.machineCode || null,
              shift: activeWO.shift,
            }
          : null,
        workOrders: mo.workOrders.map((wo) => ({
          woNumber: wo.woNumber,
          sequence: wo.sequence,
          status: wo.status,
          shift: wo.shift,
          plannedDate: wo.plannedDate,
          plannedQty: wo.plannedQty,
          qtyProduced: wo.qtyProduced,
          qtyGood: wo.qtyGood,
          qtyReject: wo.qtyReject,
          startTime: wo.startTime,
          endTime: wo.endTime,
          runningMinutes: wo.runningMinutes,
          processCode: wo.process?.processCode || null,
          processName: wo.process?.processName || null,
          machineCode: wo.machine?.machineCode || null,
          machineName: wo.machine?.machineName || null,
        })),
      };
    });

    // Aggregasi global
    const totalQtyPlanned   = items.reduce((s, r) => s + r.qtyPlanned, 0);
    const totalQtyGood      = items.reduce((s, r) => s + r.qtyGood, 0);
    const totalQtyOpen = items.reduce((s, r) => s + r.qtyOpen, 0);
    const totalQtyNgQueue = items.reduce((s, r) => s + r.qtyNgQueue, 0);
    const totalQtyRemaining = items.reduce((s, r) => s + r.qtyRemaining, 0);

    res.json({
      items,
      total,
      page: Number(page),
      limit: Number(limit),
      aggregate: {
        totalMO: total,
        totalQtyPlanned,
        totalQtyGood,
        totalQtyOpen,
        totalQtyNgQueue,
        totalQtyRemaining,
      },
    });
  } catch (e) {
    next(e);
  }
};

// ============================================================
// WIP TRANSFER
// Mengelola perpindahan fisik semi-finished goods antara:
//   TO_STOCK      - produksi → gudang WIP/semi-finished
//   FROM_STOCK    - gudang WIP → kembali ke lantai produksi
//   WO_HANDOFF    - serah terima qty antar WO (audit trail saja, tanpa stock movement)
//   MO_RETURN     - kembalikan sisa semi-finished ke gudang bahan baku saat MO cancel
// ============================================================

exports.wipTransfer = async (req, res, next) => {
  try {
    const {
      transferType,       // TO_STOCK | FROM_STOCK | WO_HANDOFF | MO_RETURN
      moId,
      woId,               // WO sumber (optional)
      toWoId,             // WO tujuan (untuk WO_HANDOFF)
      warehouseCode,      // wajib untuk TO_STOCK / FROM_STOCK / MO_RETURN
      rackCode,
      lotNumber,
      partCode,
      partNumber,
      partName,
      qty,
      uomCode,
      notes,
    } = req.body;

    const VALID_TYPES = ["TO_STOCK", "FROM_STOCK", "WO_HANDOFF", "MO_RETURN"];
    if (!transferType || !VALID_TYPES.includes(transferType)) {
      return res.status(400).json({
        message: `transferType harus salah satu dari: ${VALID_TYPES.join(", ")}`,
      });
    }
    if (!qty || Number(qty) <= 0) {
      return res.status(400).json({ message: "qty harus lebih dari 0" });
    }
    if (!moId) {
      return res.status(400).json({ message: "moId wajib diisi" });
    }
    if (["TO_STOCK", "FROM_STOCK", "MO_RETURN"].includes(transferType) && !warehouseCode) {
      return res.status(400).json({ message: "warehouseCode wajib untuk transfer fisik" });
    }
    if (!partCode) {
      return res.status(400).json({ message: "partCode wajib diisi" });
    }

    const mo = await prisma.manufacturingOrder.findUnique({
      where: { id: moId },
      select: { id: true, moNumber: true, status: true, uomCode: true },
    });
    if (!mo) return res.status(404).json({ message: "Manufacturing Order tidak ditemukan." });
    const part = await prisma.part.findFirst({
      where: { partCode, isDeleted: false },
      select: {
        partNumber: true,
        partName: true,
        material: { select: { spec: true } },
        partBases: {
          select: { baseOn: true, thickness: true, width: true, CSP: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    const stockIdentity = {
      ...resolvePartStockIdentity(part || {}),
      partNumber: partNumber || part?.partNumber || null,
      partName: partName || part?.partName || null,
    };

    const now = new Date();
    const performedBy = req.user?.username || "system";

    // ── WO_HANDOFF: hanya audit trail, tidak ada stock movement ──
    if (transferType === "WO_HANDOFF") {
      if (!toWoId) {
        return res.status(400).json({ message: "toWoId wajib untuk WO_HANDOFF" });
      }
      const fromWO = woId ? await prisma.workOrder.findUnique({ where: { id: woId }, select: { woNumber: true, uomCode: true } }) : null;
      const toWO   = await prisma.workOrder.findUnique({ where: { id: toWoId }, select: { woNumber: true, uomCode: true } });
      if (!toWO) return res.status(404).json({ message: "Work Order tujuan tidak ditemukan." });
      const resolvedUomCode = uomCode || fromWO?.uomCode || toWO.uomCode || mo.uomCode || null;
      const qtyText = formatQtyWithUom(Number(qty), resolvedUomCode);

      const entryNumber = await generateEntryNumber();
      const entry = await prisma.wIPEntry.create({
        data: {
          entryNumber,
          entryDate: now,
          moId,
          woId: woId || null,
          costType: "Material",
          sourceType: "WOHandoff",
          sourceRef: fromWO ? `${fromWO.woNumber} → ${toWO.woNumber}` : toWO.woNumber,
          qty: Number(qty),
          rate: 0,
          amount: 0,
          direction: "IN",
          notes: notes || `Handoff ${qtyText} ke ${toWO.woNumber}`,
          createdBy: performedBy,
        },
      });

      return res.status(201).json({
        ok: true,
        transferType,
        entry: mapDoc(entry),
        message: `Handoff ${formatQtyWithUom(qty, resolvedUomCode)} tercatat dari ${fromWO?.woNumber || "produksi"} ke ${toWO.woNumber}`,
      });
    }

    // ── TO_STOCK, FROM_STOCK, MO_RETURN: ada stock movement fisik ──
    const resolvedUomCode = uomCode || mo.uomCode || null;
    const stockKey = {
      warehouseCode,
      rackCode: rackCode || null,
      lotNumber: lotNumber || null,
      partCode,
      productId: null,
      description: null,
      ...stockIdentity,
      uomCode: resolvedUomCode,
    };

    const stockTypeValue = transferType === "MO_RETURN" ? "Material" : "WIP";

    const result = await prisma.$transaction(async (tx) => {
      const isIn = transferType === "FROM_STOCK"; // dari gudang ke produksi = stock keluar
      const movementDirection = transferType === "TO_STOCK" || transferType === "MO_RETURN" ? "IN" : "OUT";
      const transactionType   = transferType === "MO_RETURN" ? "RETURN" : "PRODUCTION";

      // Cari existing balance
      const existingBalance = await tx.stockBalance.findFirst({
        where: { ...stockKey, isDeleted: false },
        select: { id: true, qtyOnHand: true, qtyReserved: true, stockType: true },
      });

      const qtyNum    = Number(qty);
      const qtyBefore = Number(existingBalance?.qtyOnHand || 0);

      // Validasi: FROM_STOCK perlu stock yang cukup
      if (transferType === "FROM_STOCK") {
        const available = qtyBefore - Number(existingBalance?.qtyReserved || 0);
        if (available < qtyNum) {
          throw new Error(`Stock tidak cukup. Tersedia: ${available}, diminta: ${qtyNum}`);
        }
      }

      const qtyAfter = movementDirection === "IN"
        ? qtyBefore + qtyNum
        : qtyBefore - qtyNum;

      const qtyReserved = Number(existingBalance?.qtyReserved || 0);

      // Buat stock movement
      const movementNumber = await generateMovementNumber(movementDirection, tx);
      await tx.stockMovement.create({
        data: {
          movementNumber,
          movementDate: now,
          movementType: movementDirection,
          direction: movementDirection,
          transactionType,
          warehouseCode,
          rackCode: rackCode || null,
          lotNumber: lotNumber || null,
          partCode,
          ...stockIdentity,
          stockType: stockTypeValue,
          qty: qtyNum,
          deltaQty: movementDirection === "IN" ? qtyNum : -qtyNum,
          qtyBefore,
          qtyAfter,
          uomCode: resolvedUomCode,
          referenceType: "MANUFACTURING_ORDER",
          referenceNumber: mo.moNumber,
          notes: notes || `WIP ${transferType} — MO ${mo.moNumber}`,
          performedBy,
        },
      });

      // Update atau buat stock balance
      if (existingBalance) {
        await assertStockBalanceNotFrozen(tx, existingBalance.id);
        await tx.stockBalance.update({
          where: { id: existingBalance.id },
          data: {
            qtyOnHand: qtyAfter,
            qtyAvailable: Math.max(0, qtyAfter - qtyReserved),
            stockType: existingBalance.stockType || stockTypeValue,
            lastMovement: now,
          },
        });
      } else if (movementDirection === "IN") {
        // Hanya buat baru kalau arah IN
        await assertStockIdentityNotFrozen(tx, {
          warehouseCode,
          rackCode: rackCode || null,
          lotNumber: lotNumber || null,
          stockType: stockTypeValue,
        });
        await tx.stockBalance.create({
          data: {
            warehouseCode,
            rackCode: rackCode || null,
            lotNumber: lotNumber || null,
            partCode,
            ...stockIdentity,
            uomCode: resolvedUomCode,
            stockType: stockTypeValue,
            qtyOnHand: qtyNum,
            qtyReserved: 0,
            qtyAvailable: qtyNum,
            lastMovement: now,
          },
        });
      }

      // Catat WIP Entry sebagai audit trail nilai
      const entryNumber = await generateEntryNumber(tx);
      const wipDirection = transferType === "TO_STOCK" ? "OUT"  // WIP mengecil, fisik ke gudang
                         : transferType === "FROM_STOCK" ? "IN" // WIP bertambah lagi
                         : "OUT";                               // MO_RETURN = WIP selesai

      const entry = await tx.wIPEntry.create({
        data: {
          entryNumber,
          entryDate: now,
          moId,
          woId: woId || null,
          costType: "Material",
          sourceType: "WIPTransfer",
          sourceRef: mo.moNumber,
          qty: qtyNum,
          rate: 0,
          amount: 0,
          direction: wipDirection,
          notes: notes || `WIP ${transferType} — ${formatQtyWithUom(qtyNum, resolvedUomCode)} ${partCode}`,
          createdBy: performedBy,
        },
      });

      return { entry };
    });

    res.status(201).json({
      ok: true,
      transferType,
      entry: mapDoc(result.entry),
      message: `WIP Transfer (${transferType}) berhasil: ${formatQtyWithUom(qty, uomCode || mo.uomCode || null)} ${partCode}`,
    });
  } catch (e) {
    if (e.message?.startsWith("Stock tidak cukup")) {
      return res.status(400).json({ message: e.message });
    }
    next(e);
  }
};

// ============================================================
// WIP STOCK
// Melihat semua stock WIP di gudang. Semi-Finished/SFG tetap dibaca untuk data legacy.
// ============================================================

exports.semiFGStock = async (req, res, next) => {
  try {
    const { warehouseCode, partCode, page = 1, limit = 20 } = req.query;

    const where = { isDeleted: false, stockType: { in: ["WIP", "Semi-Finished", "Semi Finished", "SFG"] } };
    if (warehouseCode) where.warehouseCode = warehouseCode;
    if (partCode) where.partCode = { contains: partCode, mode: "insensitive" };

    const skip = (Number(page) - 1) * Number(limit);

    const [items, total] = await Promise.all([
      prisma.stockBalance.findMany({
        where,
        skip,
        take: Number(limit),
        orderBy: { lastMovement: "desc" },
        select: {
          id: true,
          warehouseCode: true,
          rackCode: true,
          lotNumber: true,
          partCode: true,
          uomCode: true,
          partNumber: true,
          partName: true,
          stockType: true,
          qtyOnHand: true,
          qtyReserved: true,
          qtyAvailable: true,
          lastMovement: true,
        },
      }),
      prisma.stockBalance.count({ where }),
    ]);

    res.json({ items: items.map(mapDoc), total, page: Number(page), limit: Number(limit) });
  } catch (e) {
    next(e);
  }
};

// ============================================================
// HELPER: createWIPEntry (dipanggil dari controller lain)
// ============================================================

exports.createWIPEntry = async (tx, data) => {
  const entryNumber = await generateEntryNumber(tx);
  return tx.wIPEntry.create({
    data: { entryNumber, ...data },
  });
};
