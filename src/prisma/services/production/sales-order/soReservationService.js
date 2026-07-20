const {
  normalizeText,
  resolveReservationBalanceWhere,
  generateReservationNumber,
  buildExcludeSpecialRackCondition,
} = require("../../../controllers/inventory/utils/stockReservationHelpers");
const {
  assertStockBalanceNotFrozen,
  assertStockBalancesNotFrozen,
} = require("../../../controllers/inventory/utils/stockOpnameFreezeGuard");
const { durationToWorkingDays } = require("../../../utils/duration");

const AUTO_SO_NOTE_PREFIX = "[AUTO-SO]";
const SO_CLOSE_STATUSES = new Set([
  "Cancelled",
  "Delivered",
  "Completed",
  "Closed",
  "Overdue",
]);

const SO_SHORTAGE_PLANNING_ENABLED =
  String(process.env.SO_SHORTAGE_PLANNING_ENABLED || "").toLowerCase() === "true";
const QUANTITY_TOLERANCE = 0.000001;

const SALES_STOCK_TYPE_PRIORITY = (process.env.SALES_STOCK_TYPE_PRIORITY ||
  "Finished Goods,Semi-Finished")
  .split(",")
  .map((value) => normalizeText(value))
  .filter(Boolean);

const buildSoLineReferenceNumber = (soNumber, lineNumber) =>
  `${soNumber}#${String(lineNumber)}`;

const extractSoLineReferenceFromRequirement = (requirement) => {
  if (requirement?.sourceType === "SO" && requirement?.sourceNumber) {
    return requirement.sourceNumber;
  }

  const notes = String(requirement?.notes || "");
  const match = notes.match(/Turunan dari\s+([^\s]+)/i);
  return match?.[1] || null;
};

const buildSoMRPRunNumber = (soNumber) => `MRP-${soNumber}`;

const buildSoReservationReferenceWhere = (soNumber) => ({
  OR: [
    { referenceNumber: soNumber },
    { referenceNumber: { startsWith: `${soNumber}#` } },
  ],
});

const findSoMrpRunNumbers = async (tx, soNumber, { includePlanRevisions = false } = {}) => {
  const soRunNumber = buildSoMRPRunNumber(soNumber);
  const runs = await tx.mRPRun.findMany({
    where: {
      isDeleted: false,
      OR: includePlanRevisions
        ? [
            { runNumber: soRunNumber },
            { planNumber: soRunNumber },
          ]
        : [{ runNumber: soRunNumber }],
    },
    select: { runNumber: true },
  });

  return [...new Set(runs.map((run) => run.runNumber).filter(Boolean))];
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const toSafeDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

// Plan horizon run SO dihitung dari jarak soDate ke cutoffDate (dalam hari).
const buildSoPlanHorizonDays = (soDate, cutoffDate) => {
  const start = toSafeDate(soDate);
  const end = toSafeDate(cutoffDate);
  if (!start || !end) return 0;
  return Math.max(Math.ceil((end.getTime() - start.getTime()) / MS_PER_DAY), 0);
};

const MAX_MBOM_DEPTH = 10;

const buildMbomValidityWhere = (targetDate) => ({
  AND: [
    {
      OR: [{ effectiveDate: null }, { effectiveDate: { lte: targetDate } }],
    },
    {
      OR: [{ expiryDate: null }, { expiryDate: { gte: targetDate } }],
    },
  ],
});

const findActiveMbomHeader = async (tx, partId, targetDate) => {
  if (!partId) return null;

  return tx.mBOMHeader.findFirst({
    where: {
      partId,
      isDeleted: false,
      ...buildMbomValidityWhere(targetDate),
    },
    orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
    select: { id: true, noReg: true, partId: true },
  });
};

const resolveMbomLeadTimeDays = async (tx, mbomHeaderId) => {
  if (!mbomHeaderId) return 0;

  const mbomHeader = await tx.mBOMHeader.findUnique({
    where: { id: mbomHeaderId },
    select: { noReg: true },
  });

  if (!mbomHeader?.noReg) return 0;

  const details = await tx.mBOMDetail.findMany({
    where: {
      noReg: mbomHeader.noReg,
      isDeleted: false,
    },
    select: { leadTime: true, leadTimeUnit: true },
  });
  return details.reduce((maximum, detail) => Math.max(maximum, durationToWorkingDays(detail.leadTime, detail.leadTimeUnit)), 0);
};

const deactivateSoRequirements = async (
  tx,
  soNumber,
  notes,
  { includePlanRevisions = false } = {},
) => {
  const runNumbers = await findSoMrpRunNumbers(tx, soNumber, {
    includePlanRevisions,
  });
  if (runNumbers.length === 0) return;

  await tx.mRPRequirement.updateMany({
    where: {
      runNumber: { in: runNumbers },
      isDeleted: false,
    },
    data: {
      isDeleted: true,
      notes,
    },
  });
};

const cancelPlannedOrdersByRunNumbers = async (tx, runNumbers, notes) => {
  if (!Array.isArray(runNumbers) || runNumbers.length === 0) return;

  await tx.plannedOrder.updateMany({
    where: {
      runNumber: { in: runNumbers },
      isDeleted: false,
      status: "Planned",
    },
    data: {
      status: "Cancelled",
      notes,
    },
  });
};

const retireSoMrpPlan = async (tx, soNumber, notes) => {
  const soRunNumber = buildSoMRPRunNumber(soNumber);
  const runNumbers = await findSoMrpRunNumbers(tx, soNumber, {
    includePlanRevisions: true,
  });

  await deactivateSoRequirements(tx, soNumber, notes, {
    includePlanRevisions: true,
  });
  await cancelPlannedOrdersByRunNumbers(tx, runNumbers, notes);

  await tx.mRPPegging.updateMany({
    where: {
      demandType: "SO",
      demandNumber: soNumber,
      status: "Active",
    },
    data: {
      status: "Closed",
      notes,
    },
  });

  await tx.mRPRun.updateMany({
    where: {
      isDeleted: false,
      OR: [
        { runNumber: soRunNumber },
        { planNumber: soRunNumber },
      ],
    },
    data: {
      isCurrentPlan: false,
      notes,
    },
  });
};

const cancelLegacySoPlannedOrders = async (tx, soNumber, notes) => {
  await tx.plannedOrder.updateMany({
    where: {
      referenceType: "SO",
      referenceNumber: { startsWith: `${soNumber}#` },
      // Legacy SO planned order lama tidak punya runNumber.
      // Planned order SO berbasis MRP run tetap dikelola via cancelPlannedOrdersByRunNumbers.
      runNumber: null,
      isDeleted: false,
      status: "Planned",
    },
    data: {
      status: "Cancelled",
      notes,
    },
  });
};

const upsertQtyMap = (map, partCode, qty) => {
  const code = normalizeText(partCode);
  if (!code) return;
  const safeQty = Number(qty || 0);
  if (safeQty <= 0) return;
  map[code] = Number(map[code] || 0) + safeQty;
};

const getSalesStockTypeRank = (stockType) => {
  const normalizedStockType = normalizeText(stockType);
  const index = SALES_STOCK_TYPE_PRIORITY.findIndex(
    (type) => type.toLowerCase() === normalizedStockType.toLowerCase()
  );
  return index === -1 ? SALES_STOCK_TYPE_PRIORITY.length : index;
};

const sortSalesStockBalances = (balances = []) =>
  [...balances].sort((a, b) => {
    const rankDiff = getSalesStockTypeRank(a.stockType) - getSalesStockTypeRank(b.stockType);
    if (rankDiff !== 0) return rankDiff;

    const aMovement = a.lastMovement ? new Date(a.lastMovement).getTime() : 0;
    const bMovement = b.lastMovement ? new Date(b.lastMovement).getTime() : 0;
    if (aMovement !== bMovement) return aMovement - bMovement;

    return Number(b.qtyAvailable || 0) - Number(a.qtyAvailable || 0);
  });

const buildSalesReservableStockWhere = (partCode, quantityField = "qtyAvailable") => ({
  AND: [
    {
      partCode,
      isDeleted: false,
      [quantityField]: { gt: 0 },
    },
    buildExcludeSpecialRackCondition(),
  ],
});

const allocateSalesStockBalances = async (tx, partCode, qtyNeeded) => {
  const targetQty = Number(qtyNeeded || 0);
  if (!partCode || targetQty <= 0) return { allocations: [], qtyAllocated: 0 };

  const balances = await tx.stockBalance.findMany({
    where: buildSalesReservableStockWhere(partCode, "qtyAvailable"),
  });

  let remaining = targetQty;
  const allocations = [];

  for (const stockBalance of sortSalesStockBalances(balances)) {
    if (remaining <= 0) break;

    const qtyAvailable = Number(stockBalance.qtyAvailable || 0);
    if (qtyAvailable <= 0) continue;

    const qty = Math.min(qtyAvailable, remaining);
    allocations.push({ stockBalance, qty });
    remaining -= qty;
  }

  return {
    allocations,
    qtyAllocated: targetQty - remaining,
  };
};

const getReservationOpenQty = (reservation) =>
  Math.max(
    0,
    Number(reservation?.qtyReserved || 0) - Number(reservation?.qtyReleased || 0)
  );

const reconcileActiveReservationsWithStock = async (tx, reservations = []) => {
  const activeReservations = (reservations || []).filter(
    (reservation) => reservation?.status === "Active"
  );
  const reservationsByBalance = new Map();

  for (const reservation of activeReservations) {
    if (!reservation.stockBalanceId || !reservation.stockBalance) continue;
    const rows = reservationsByBalance.get(reservation.stockBalanceId) || [];
    rows.push(reservation);
    reservationsByBalance.set(reservation.stockBalanceId, rows);
  }

  for (const [stockBalanceId, rows] of reservationsByBalance.entries()) {
    const stockBalance = rows[0].stockBalance;
    const currentBalanceReserved = Number(stockBalance.qtyReserved || 0);
    const currentGroupOpen = rows.reduce(
      (sum, reservation) => sum + getReservationOpenQty(reservation),
      0
    );
    const otherReserved = Math.max(0, currentBalanceReserved - currentGroupOpen);
    let remainingCapacity = Math.max(
      0,
      Number(stockBalance.qtyOnHand || 0) - Number(stockBalance.qtyQC || 0) - otherReserved
    );
    let totalReleaseQty = 0;

    for (const reservation of rows) {
      const openQty = getReservationOpenQty(reservation);
      const keepOpenQty = Math.min(openQty, remainingCapacity);
      const releaseQty = openQty - keepOpenQty;

      remainingCapacity = Math.max(0, remainingCapacity - keepOpenQty);
      if (releaseQty <= QUANTITY_TOLERANCE) continue;

      const nextReserved = Number(reservation.qtyReserved || 0) - releaseQty;
      const nextStatus =
        nextReserved <= Number(reservation.qtyReleased || 0) + QUANTITY_TOLERANCE
          ? "Released"
          : "Active";

      await tx.stockReservation.update({
        where: { id: reservation.id },
        data: {
          qtyReserved: nextReserved,
          status: nextStatus,
          notes: `${AUTO_SO_NOTE_PREFIX} Auto adjusted karena saldo stock sumber tidak lagi mencukupi`,
        },
      });

      reservation.qtyReserved = nextReserved;
      reservation.status = nextStatus;
      totalReleaseQty += releaseQty;
    }

    if (totalReleaseQty <= QUANTITY_TOLERANCE) continue;

    await assertStockBalanceNotFrozen(tx, stockBalanceId);
    const nextBalanceReserved = Math.max(0, currentBalanceReserved - totalReleaseQty);
    await tx.stockBalance.update({
      where: { id: stockBalanceId },
      data: {
        qtyReserved: nextBalanceReserved,
        qtyAvailable: Math.max(
          0,
          Number(stockBalance.qtyOnHand || 0) -
            nextBalanceReserved -
            Number(stockBalance.qtyQC || 0)
        ),
      },
    });

    stockBalance.qtyReserved = nextBalanceReserved;
  }

  return reservations.filter((reservation) => reservation.status === "Active");
};

const reconcileStockBalanceReservedQuantities = async (tx, partCodes = []) => {
  const normalizedPartCodes = [
    ...new Set((partCodes || []).map((partCode) => normalizeText(partCode)).filter(Boolean)),
  ];
  if (normalizedPartCodes.length === 0) return;

  const balances = await tx.stockBalance.findMany({
    where: {
      partCode: { in: normalizedPartCodes },
      isDeleted: false,
    },
    select: {
      id: true,
      qtyOnHand: true,
      qtyReserved: true,
      qtyQC: true,
    },
  });
  if (balances.length === 0) return;

  const activeReservations = await tx.stockReservation.findMany({
    where: {
      stockBalanceId: { in: balances.map((balance) => balance.id) },
      status: "Active",
      isDeleted: false,
    },
    select: {
      stockBalanceId: true,
      qtyReserved: true,
      qtyReleased: true,
    },
  });

  const reservedByBalanceId = new Map();
  for (const reservation of activeReservations) {
    const balanceId = reservation.stockBalanceId;
    if (!balanceId) continue;

    const openQty = getReservationOpenQty(reservation);
    reservedByBalanceId.set(
      balanceId,
      Number(reservedByBalanceId.get(balanceId) || 0) + openQty,
    );
  }

  for (const balance of balances) {
    const nextQtyReserved = Number(reservedByBalanceId.get(balance.id) || 0);
    if (Math.abs(Number(balance.qtyReserved || 0) - nextQtyReserved) <= QUANTITY_TOLERANCE) {
      continue;
    }

    await assertStockBalanceNotFrozen(tx, balance.id);
    await tx.stockBalance.update({
      where: { id: balance.id },
      data: {
        qtyReserved: nextQtyReserved,
        qtyAvailable: Math.max(
          0,
          Number(balance.qtyOnHand || 0) - nextQtyReserved - Number(balance.qtyQC || 0),
        ),
      },
    });
  }
};

const buildOpenSupplyMapForSO = async (
  tx,
  partCodes,
  cutoffDate,
  options = {}
) => {
  const normalizedCodes = [...new Set((partCodes || []).map((x) => normalizeText(x)).filter(Boolean))];
  if (normalizedCodes.length === 0) return {};

  const excludedRunNumbers = Array.isArray(options.excludeRunNumbers)
    ? options.excludeRunNumbers.filter(Boolean)
    : [];

  const plannedOrderWhere = {
    partCode: { in: normalizedCodes },
    isDeleted: false,
    status: "Planned",
    requiredDate: { lte: cutoffDate },
    NOT: { referenceType: "SO" },
  };
  if (excludedRunNumbers.length > 0) {
    plannedOrderWhere.AND = [{ NOT: { runNumber: { in: excludedRunNumbers } } }];
  }

  const [plannedOrders, manufacturingOrders, purchaseOrderDetails] = await Promise.all([
    tx.plannedOrder.findMany({
      where: plannedOrderWhere,
      select: {
        partCode: true,
        qty: true,
      },
    }),
    tx.manufacturingOrder.findMany({
      where: {
        isDeleted: false,
        status: { in: ["Draft", "In Progress"] },
        OR: [{ plannedEndDate: null }, { plannedEndDate: { lte: cutoffDate } }],
        part: {
          partCode: { in: normalizedCodes },
        },
      },
      select: {
        qtyPlanned: true,
        qtyProduced: true,
        part: {
          select: { partCode: true },
        },
      },
    }),
    tx.purchaseOrderDetail.findMany({
      where: {
        isDeleted: false,
        partCode: { in: normalizedCodes },
        po: {
          isDeleted: false,
          status: { in: ["Draft", "Sent", "Confirmed", "Partial Receipt", "Approved"] },
          deliveryDate: { lte: cutoffDate },
        },
      },
      select: {
        partCode: true,
        qty: true,
        qtyReceived: true,
      },
    }),
  ]);

  const supplyMap = {};

  for (const row of plannedOrders) {
    upsertQtyMap(supplyMap, row.partCode, row.qty);
  }

  for (const row of manufacturingOrders) {
    const remaining = Math.max(
      Number(row.qtyPlanned || 0) - Number(row.qtyProduced || 0),
      0
    );
    upsertQtyMap(supplyMap, row.part?.partCode, remaining);
  }

  for (const row of purchaseOrderDetails) {
    const openQty = Math.max(
      Number(row.qty || 0) - Number(row.qtyReceived || 0),
      0
    );
    upsertQtyMap(supplyMap, row.partCode, openQty);
  }

  return supplyMap;
};

async function explodeMbomForSO(
  tx,
  runNumber,
  mbomHeaderId,
  quantity,
  requiredDate,
  level,
  rootSourceNumber,
  visitedMbomIds = new Set(),
  projectedAvailableMap = {},
  mbomHeaderByPartCode = {},
  uomCodeByPartCode = {}
) {
  const requirements = [];

  if (level > MAX_MBOM_DEPTH) {
    console.warn(
      `[SO-MRP] explodeMbomForSO: max depth ${MAX_MBOM_DEPTH} tercapai di mbomHeaderId=${mbomHeaderId}`
    );
    return { requirements };
  }

  const mbomHeader = await tx.mBOMHeader.findFirst({
    where: {
      id: mbomHeaderId,
      isDeleted: false,
      ...buildMbomValidityWhere(requiredDate),
    },
    include: {
      details: {
        where: { isDeleted: false },
        include: { part: true },
      },
    },
  });

  if (!mbomHeader || !mbomHeader.details || mbomHeader.details.length === 0) {
    return { requirements };
  }

  const validDetails = mbomHeader.details.filter((detail) => detail.part != null);
  if (validDetails.length === 0) return { requirements };

  const allPartCodes = [...new Set(validDetails.map((detail) => detail.part.partCode))];
  const unresolvedPartCodes = allPartCodes.filter(
    (code) => projectedAvailableMap[code] === undefined
  );

  if (unresolvedPartCodes.length > 0) {
    const stockBalances = await tx.stockBalance.findMany({
      where: {
        AND: [
          { partCode: { in: unresolvedPartCodes }, isDeleted: false },
          buildExcludeSpecialRackCondition(),
        ],
      },
      select: { partCode: true, qtyAvailable: true },
    });

    const stockMap = stockBalances.reduce((acc, stock) => {
      acc[stock.partCode] =
        Number(acc[stock.partCode] || 0) + Number(stock.qtyAvailable || 0);
      return acc;
    }, {});
    const supplyMap = await buildOpenSupplyMapForSO(
      tx,
      unresolvedPartCodes,
      requiredDate,
      { excludeRunNumbers: [runNumber] }
    );

    for (const partCode of unresolvedPartCodes) {
      projectedAvailableMap[partCode] =
        Number(stockMap[partCode] || 0) + Number(supplyMap[partCode] || 0);
    }
  }

  for (const detail of validDetails) {
    const grossRequirement = Number(detail.qty || 0) * Number(quantity || 0);
    const partCode = detail.part.partCode;
    if (detail.uomCode) {
      uomCodeByPartCode[partCode] = detail.uomCode;
    }
    const availableBefore = projectedAvailableMap[partCode] || 0;
    const onHandQty = availableBefore;
    const netRequirement = Math.max(grossRequirement - onHandQty, 0);

    projectedAvailableMap[partCode] = Math.max(availableBefore - grossRequirement, 0);

    const orderType = detail.category === "inHouse" ? "Production" : "Purchase";
    const leadTime = durationToWorkingDays(detail.leadTime, detail.leadTimeUnit);
    const orderDate = new Date(requiredDate);
    orderDate.setDate(orderDate.getDate() - leadTime);

    requirements.push({
      runNumber,
      levelMBOM: level,
      partCode,
      partId: detail.part.id,
      requirementType: "Dependent",
      sourceType: "MBOM",
      sourceNumber: mbomHeader.noReg,
      requiredDate,
      grossRequirement,
      onHandQty,
      allocatedQty: 0,
      netRequirement,
      plannedOrderQty: netRequirement,
      orderType,
      leadTime,
      orderDate,
      notes: `${AUTO_SO_NOTE_PREFIX} Turunan dari ${rootSourceNumber} via MBOM ${mbomHeader.noReg}`,
      isDeleted: false,
    });

    if (detail.category === "inHouse" && netRequirement > 0) {
      const subMbom = await findActiveMbomHeader(tx, detail.part.id, orderDate);
      if (subMbom) {
        mbomHeaderByPartCode[detail.part.partCode] = subMbom.id;
      }

      if (subMbom && !visitedMbomIds.has(subMbom.id)) {
        visitedMbomIds.add(subMbom.id);
        const subExploded = await explodeMbomForSO(
          tx,
          runNumber,
          subMbom.id,
          netRequirement,
          orderDate,
          level + 1,
          rootSourceNumber,
          visitedMbomIds,
          projectedAvailableMap,
          mbomHeaderByPartCode,
          uomCodeByPartCode
        );
        requirements.push(...subExploded.requirements);
      }
    }
  }

  return { requirements };
};

const resolveSoSupplyPolicy = async (tx, detail, targetDate) => {
  if (detail?.partId) {
    const activeMbom = await tx.mBOMHeader.findFirst({
      where: {
        partId: detail.partId,
        isDeleted: false,
        ...buildMbomValidityWhere(targetDate),
      },
      select: { id: true },
    });

    if (activeMbom) {
      return { orderType: "Production", mbomHeaderId: activeMbom.id };
    }
  }

  return { orderType: "Purchase", mbomHeaderId: null };
};

// Sinkronisasi auto reservation untuk SO yang sudah Confirmed
// Returns: { warnings: [{ partCode, lineNumber, qtyRequired, qtyReserved, qtyShort }] }
const syncReservationsForConfirmedSO = async (tx, soHeader, details = []) => {
  const syncStartTime = Date.now();
  const reservationWarnings = [];
  const warnings = [];
  if (!soHeader?.soNumber) return { warnings };

  const normalizedDetails = details
    .filter((d) => !d.isDeleted)
    .map((d, idx) => ({
      lineNumber: d.lineNumber || idx + 1,
      qty: Math.max(0, Number(d.qty || 0) - Number(d.qtyDelivered || 0)),
      partCode: normalizeText(d.partCode),
      partId: d.partId || null,
      uomCode: d.uomCode || null,
    }))
    .filter((d) => d.partCode && d.qty > 0);

  // SalesOrderDetail tidak menyimpan partId, jadi resolve dari master Part berdasarkan partCode.
  const missingPartCodes = [
    ...new Set(
      normalizedDetails
        .filter((d) => !d.partId)
        .map((d) => d.partCode)
        .filter(Boolean)
    ),
  ];

  const partRows = missingPartCodes.length
    ? await tx.part.findMany({
        where: {
          partCode: { in: missingPartCodes },
          isDeleted: false,
        },
        select: { id: true, partCode: true },
      })
    : [];

  const partIdByCode = new Map(
    partRows.map((p) => [normalizeText(p.partCode), p.id])
  );

  const normalizedDetailsWithPart = normalizedDetails.map((d) => ({
    ...d,
    partId: d.partId || partIdByCode.get(d.partCode) || null,
  }));
  await reconcileStockBalanceReservedQuantities(
    tx,
    normalizedDetailsWithPart.map((detail) => detail.partCode),
  );

  const targetMap = new Map();
  for (const d of normalizedDetailsWithPart) {
    const ref = buildSoLineReferenceNumber(soHeader.soNumber, d.lineNumber);
    targetMap.set(ref, d);
  }

  let existingReservations = await tx.stockReservation.findMany({
    where: {
      referenceType: "SO",
      ...buildSoReservationReferenceWhere(soHeader.soNumber),
      isDeleted: false,
      // Penting: hanya sinkronisasi reservation yang masih aktif.
      // Reservation Cancelled/Released adalah histori dan tidak boleh diaktifkan ulang saat re-confirm.
      status: "Active",
    },
    orderBy: { createdAt: "asc" },
    include: {
      stockBalance: {
        select: {
          id: true,
          qtyOnHand: true,
          qtyReserved: true,
          qtyQC: true,
        },
      },
    },
  });
  existingReservations = await reconcileActiveReservationsWithStock(tx, existingReservations);

  const existingMap = new Map();
  for (const reservation of existingReservations) {
    if (!existingMap.has(reservation.referenceNumber)) {
      existingMap.set(reservation.referenceNumber, []);
    }
    existingMap.get(reservation.referenceNumber).push(reservation);
  }

  // Release reservation lama yang sudah tidak ada di detail terbaru
  for (const reservation of existingReservations) {
    if (reservation.referenceNumber === soHeader.soNumber) {
      continue;
    }

    if (targetMap.has(reservation.referenceNumber)) {
      continue;
    }

    const qtyStillReserved =
      Number(reservation.qtyReserved || 0) - Number(reservation.qtyReleased || 0);

    if (qtyStillReserved > 0) {
      const affectedBalances = await tx.stockBalance.findMany({
        where: resolveReservationBalanceWhere(reservation),
        select: { id: true },
      });
      await assertStockBalancesNotFrozen(tx, affectedBalances.map((row) => row.id));
      await tx.stockBalance.updateMany({
        where: resolveReservationBalanceWhere(reservation),
        data: {
          qtyReserved: { decrement: qtyStillReserved },
          qtyAvailable: { increment: qtyStillReserved },
        },
      });
    }

    await tx.stockReservation.update({
      where: { id: reservation.id },
      data: {
        status: "Released",
        qtyReleased: Number(reservation.qtyReserved || 0),
        notes: `${AUTO_SO_NOTE_PREFIX} Auto released karena line SO dihapus/diubah`,
      },
    });
  }

  // Create / adjust reservation sesuai qty detail terbaru
  for (const [referenceNumber, detail] of targetMap.entries()) {
    const qtyTarget = Number(detail.qty || 0);
    const existingList = existingMap.get(referenceNumber) || [];

    if (existingList.length === 0) {
      const { allocations, qtyAllocated } = await allocateSalesStockBalances(
        tx,
        detail.partCode,
        qtyTarget
      );
      const qtyShort = qtyTarget - qtyAllocated;

      // Catat warning jika ada shortage
      if (qtyShort > 0) {
        reservationWarnings.push({
          partCode: detail.partCode,
          lineNumber: detail.lineNumber,
          qtyRequired: qtyTarget,
          qtyReserved: qtyAllocated,
          qtyShort,
        });
      }

      // Buat reservation per stock balance supaya SO bisa ambil dari FG/Semi-Finished/lokasi berbeda.
      for (const { stockBalance, qty } of allocations) {
        const reservationNumber = await generateReservationNumber(tx, soHeader.soDate);
        await tx.stockReservation.create({
          data: {
            reservationNumber,
            reservationDate: soHeader.soDate || new Date(),
            stockBalanceId: stockBalance.id,
            warehouseCode: stockBalance.warehouseCode,
            rackCode: stockBalance.rackCode || null,
            lotNumber: stockBalance.lotNumber || null,
            partCode: stockBalance.partCode,
            partNumber: stockBalance.partNumber || null,
            partName: stockBalance.partName || null,
            productId: stockBalance.productId,
            description: stockBalance.description,
            spec: stockBalance.spec,
            thickness: stockBalance.thickness,
            width: stockBalance.width,
            CSP: stockBalance.CSP,
            qtyReserved: qty,
            qtyReleased: 0,
            referenceType: "SO",
            referenceNumber,
            status: "Active",
            notes: `${AUTO_SO_NOTE_PREFIX} ${soHeader.soNumber} line ${detail.lineNumber}${qtyShort > 0 ? ` (short: ${qtyShort})` : ""}`,
          },
        });

        await assertStockBalanceNotFrozen(tx, stockBalance.id);
        await tx.stockBalance.update({
          where: { id: stockBalance.id },
          data: {
            qtyReserved: { increment: qty },
            qtyAvailable: { decrement: qty },
          },
        });
      }
      continue;
    }

    const currentReserved = existingList.reduce(
      (sum, reservation) => sum + Number(reservation.qtyReserved || 0),
      0
    );
    const diff = qtyTarget - currentReserved;

    if (diff > 0) {
      const { allocations, qtyAllocated } = await allocateSalesStockBalances(
        tx,
        detail.partCode,
        diff
      );
      const qtyShort = diff - qtyAllocated;

      if (qtyShort > 0) {
        reservationWarnings.push({
          partCode: detail.partCode,
          lineNumber: detail.lineNumber,
          qtyRequired: qtyTarget,
          qtyReserved: currentReserved + qtyAllocated,
          qtyShort,
        });
      }

      for (const { stockBalance, qty } of allocations) {
        const matchingExisting = existingList.find(
          (reservation) => reservation.stockBalanceId === stockBalance.id
        );

        await assertStockBalanceNotFrozen(tx, stockBalance.id);
        await tx.stockBalance.update({
          where: { id: stockBalance.id },
          data: {
            qtyReserved: { increment: qty },
            qtyAvailable: { decrement: qty },
          },
        });

        if (matchingExisting) {
          const nextReserved = Number(matchingExisting.qtyReserved || 0) + qty;
          await tx.stockReservation.update({
            where: { id: matchingExisting.id },
            data: {
              qtyReserved: nextReserved,
              qtyReleased: Math.min(Number(matchingExisting.qtyReleased || 0), nextReserved),
              status: "Active",
              notes: `${AUTO_SO_NOTE_PREFIX} ${soHeader.soNumber} line ${detail.lineNumber}${qtyShort > 0 ? ` (short: ${qtyShort})` : ""}`,
            },
          });
        } else {
          const reservationNumber = await generateReservationNumber(tx, soHeader.soDate);
          await tx.stockReservation.create({
            data: {
              reservationNumber,
              reservationDate: soHeader.soDate || new Date(),
              stockBalanceId: stockBalance.id,
              warehouseCode: stockBalance.warehouseCode,
              rackCode: stockBalance.rackCode || null,
              lotNumber: stockBalance.lotNumber || null,
              partCode: stockBalance.partCode,
              partNumber: stockBalance.partNumber || null,
              partName: stockBalance.partName || null,
              productId: stockBalance.productId,
              description: stockBalance.description,
              spec: stockBalance.spec,
              thickness: stockBalance.thickness,
              width: stockBalance.width,
              CSP: stockBalance.CSP,
              qtyReserved: qty,
              qtyReleased: 0,
              referenceType: "SO",
              referenceNumber,
              status: "Active",
              notes: `${AUTO_SO_NOTE_PREFIX} ${soHeader.soNumber} line ${detail.lineNumber}${qtyShort > 0 ? ` (short: ${qtyShort})` : ""}`,
            },
          });
        }
      }
    } else if (diff < 0) {
      let remainingReleaseQty = Math.abs(diff);
      const releaseCandidates = [...existingList].sort(
        (a, b) => getSalesStockTypeRank(b.stockType) - getSalesStockTypeRank(a.stockType)
      );

      for (const reservation of releaseCandidates) {
        if (remainingReleaseQty <= 0) break;

        const currentLineReserved = Number(reservation.qtyReserved || 0);
        const releaseQty = Math.min(currentLineReserved, remainingReleaseQty);
        const nextReserved = currentLineReserved - releaseQty;

        const affectedBalances = await tx.stockBalance.findMany({
          where: resolveReservationBalanceWhere(reservation),
          select: { id: true },
        });
        await assertStockBalancesNotFrozen(tx, affectedBalances.map((row) => row.id));
        await tx.stockBalance.updateMany({
          where: resolveReservationBalanceWhere(reservation),
          data: {
            qtyReserved: { decrement: releaseQty },
            qtyAvailable: { increment: releaseQty },
          },
        });

        await tx.stockReservation.update({
          where: { id: reservation.id },
          data: {
            qtyReserved: nextReserved,
            qtyReleased: Math.min(Number(reservation.qtyReleased || 0), nextReserved),
            status: nextReserved > 0 ? "Active" : "Released",
            notes: `${AUTO_SO_NOTE_PREFIX} ${soHeader.soNumber} line ${detail.lineNumber}`,
          },
        });

        remainingReleaseQty -= releaseQty;
      }
    } else {
      // diff === 0, tidak ada perubahan qty, pastikan status Active
      for (const reservation of existingList) {
        await tx.stockReservation.update({
          where: { id: reservation.id },
          data: {
            status: "Active",
            notes: `${AUTO_SO_NOTE_PREFIX} ${soHeader.soNumber} line ${detail.lineNumber}`,
          },
        });
      }
    }
  }

  const soRunNumber = buildSoMRPRunNumber(soHeader.soNumber);
  const cutoffDate = soHeader.deliveryDate || soHeader.soDate || new Date();
  const soPlanHorizon = buildSoPlanHorizonDays(soHeader.soDate, cutoffDate);

  // Netting ke scheduled receipts terbuka supaya shortage SO tidak double terhadap supply forecast/MRP existing.
  const supplyPartCodes = [...new Set(reservationWarnings.map((w) => normalizeText(w.partCode)).filter(Boolean))];
  const openSupplyMap = await buildOpenSupplyMapForSO(tx, supplyPartCodes, cutoffDate, {
    excludeRunNumbers: [soRunNumber],
  });

  const warningRefMap = new Map();
  for (const warning of reservationWarnings) {
    const refNumber = buildSoLineReferenceNumber(soHeader.soNumber, warning.lineNumber);
    const availableOpenSupply = Number(openSupplyMap[warning.partCode] || 0);
    const qtyCoveredByOpenSupply = Math.min(availableOpenSupply, Number(warning.qtyShort || 0));
    const qtyShortAfterNetting = Math.max(
      Number(warning.qtyShort || 0) - qtyCoveredByOpenSupply,
      0
    );

    if (qtyCoveredByOpenSupply > 0) {
      openSupplyMap[warning.partCode] = Math.max(
        Number(openSupplyMap[warning.partCode] || 0) - qtyCoveredByOpenSupply,
        0
      );
    }

    if (qtyShortAfterNetting <= 0) {
      continue;
    }

    const finalWarning = {
      ...warning,
      qtyCoveredByOpenSupply,
      qtyShort: qtyShortAfterNetting,
    };
    warnings.push(finalWarning);
    warningRefMap.set(refNumber, finalWarning);
  }

  // Default flow terbaru: SO hanya sinkron reservasi + trigger dirty MRP.
  // Pembuatan requirement/planned order khusus SO dimatikan agar tidak bikin jalur planning ganda.
  if (!SO_SHORTAGE_PLANNING_ENABLED) {
    await deactivateSoRequirements(
      tx,
      soHeader.soNumber,
      `${AUTO_SO_NOTE_PREFIX} Requirement SO dinonaktifkan (mode netting MRP aktif)`
    );

    await cancelPlannedOrdersByRunNumbers(
      tx,
      [soRunNumber],
      `${AUTO_SO_NOTE_PREFIX} Planned order SO dinonaktifkan (mode netting MRP aktif)`
    );

    await cancelLegacySoPlannedOrders(
      tx,
      soHeader.soNumber,
      `${AUTO_SO_NOTE_PREFIX} Legacy planned order SO dibatalkan (mode netting MRP aktif)`
    );

    return { warnings };
  }

  // Sinkronisasi shortage ke MRPRequirement (run khusus SO)
  const legacyWarningRefMap = new Map(
    warnings.map((w) => [
      buildSoLineReferenceNumber(soHeader.soNumber, w.lineNumber),
      w,
    ])
  );

  const existingSoRun = await tx.mRPRun.findUnique({
    where: { runNumber: soRunNumber },
    select: { runNumber: true },
  });

  if (!existingSoRun) {
    await tx.mRPRun.create({
      data: {
        runNumber: soRunNumber,
        runDate: new Date(),
        planHorizon: soPlanHorizon,
        cutoffDate,
        status: "Completed",
        executionTime: 0,
        totalRequirements: 0,
        totalPlannedOrders: 0,
        runBy: "system",
        notes: `${AUTO_SO_NOTE_PREFIX} Run khusus shortage SO ${soHeader.soNumber}`,
      },
    });
  }

  // Nonaktifkan requirement SO lama, lalu re-create dari warning terbaru
  await deactivateSoRequirements(
    tx,
    soHeader.soNumber,
    `${AUTO_SO_NOTE_PREFIX} Requirement dinonaktifkan saat sinkronisasi terbaru`
  );

  const requirementRows = [];
  const supplyPolicyBySource = new Map();
  const projectedAvailableMap = {};
  const mbomHeaderByPartCode = {};
  const uomCodeByPartCode = {};
  for (const [refNumber, warning] of legacyWarningRefMap.entries()) {
    const detail = targetMap.get(refNumber);
    const supplyPolicy = await resolveSoSupplyPolicy(tx, detail, cutoffDate);
    supplyPolicyBySource.set(refNumber, supplyPolicy);
    const fgLeadTime =
      supplyPolicy.orderType === "Production" && supplyPolicy.mbomHeaderId
        ? await resolveMbomLeadTimeDays(tx, supplyPolicy.mbomHeaderId)
        : 0;
    const qtyCoveredByOpenSupply = Number(warning.qtyCoveredByOpenSupply || 0);
    const fgOrderDate = new Date(cutoffDate);
    fgOrderDate.setDate(fgOrderDate.getDate() - fgLeadTime);

    requirementRows.push({
      runNumber: soRunNumber,
      levelMBOM: 0,
      partCode: warning.partCode,
      partId: detail?.partId || null,
      requirementType: "Independent",
      sourceType: "SO",
      sourceNumber: refNumber,
      mpsDetailId: null,
      requiredDate: cutoffDate,
      grossRequirement: warning.qtyRequired,
      onHandQty: Number(warning.qtyReserved || 0) + qtyCoveredByOpenSupply,
      allocatedQty: Number(warning.qtyReserved || 0),
      netRequirement: warning.qtyShort,
      plannedOrderQty: warning.qtyShort,
      orderType: supplyPolicy.orderType,
      leadTime: fgLeadTime,
      orderDate: fgOrderDate,
      notes: `${AUTO_SO_NOTE_PREFIX} Shortage dari SO ${soHeader.soNumber} line ${warning.lineNumber} | reserved=${Number(warning.qtyReserved || 0)} | openSupplyCovered=${qtyCoveredByOpenSupply}`,
      isDeleted: false,
    });

    if (supplyPolicy.orderType === "Production" && supplyPolicy.mbomHeaderId) {
      mbomHeaderByPartCode[warning.partCode] = supplyPolicy.mbomHeaderId;
      const exploded = await explodeMbomForSO(
        tx,
        soRunNumber,
        supplyPolicy.mbomHeaderId,
        warning.qtyShort,
        cutoffDate,
        1,
        refNumber,
        new Set([supplyPolicy.mbomHeaderId]),
        projectedAvailableMap,
        mbomHeaderByPartCode,
        uomCodeByPartCode
      );
      requirementRows.push(...exploded.requirements);
    }
  }

  if (requirementRows.length > 0) {
    await tx.mRPRequirement.createMany({
      data: requirementRows,
    });
  }

  // Sinkronisasi planned order dari shortage terbaru (khusus run SO ini)
  await cancelPlannedOrdersByRunNumbers(
    tx,
    [soRunNumber],
    `${AUTO_SO_NOTE_PREFIX} Dibatalkan saat sinkronisasi ulang shortage SO`
  );

  let poSeq = 0;
  let moSeq = 0;
  const today = new Date();
  const dateStr = today.toISOString().split("T")[0].replace(/-/g, "");

  const lastPlo = await tx.plannedOrder.findFirst({
    where: { orderNumber: { startsWith: `PLO-${dateStr}-` } },
    orderBy: { orderNumber: "desc" },
    select: { orderNumber: true },
  });
  const lastPmo = await tx.plannedOrder.findFirst({
    where: { orderNumber: { startsWith: `PMO-${dateStr}-` } },
    orderBy: { orderNumber: "desc" },
    select: { orderNumber: true },
  });
  const extractSeq = (str) => parseInt(str?.match(/-(\d+)$/)?.[1] || "0", 10);
  poSeq = extractSeq(lastPlo?.orderNumber);
  moSeq = extractSeq(lastPmo?.orderNumber);

  const plannedOrderRows = [];
  for (const req of requirementRows) {
    if (Number(req.plannedOrderQty || 0) <= 0) continue;

    const orderType = req.orderType || "Production";
    const isProduction = orderType === "Production";
    const prefix = isProduction ? "PMO" : "PLO";
    if (isProduction) moSeq++; else poSeq++;
    const seq = isProduction ? moSeq : poSeq;
    const orderNumber = `${prefix}-${dateStr}-${String(seq).padStart(4, "0")}`;

    const sourceDetail = targetMap.get(req.sourceNumber);
    const soLineReference =
      extractSoLineReferenceFromRequirement(req) ||
      buildSoLineReferenceNumber(soHeader.soNumber, 1);
    plannedOrderRows.push({
      orderNumber,
      runNumber: soRunNumber,
      orderType,
      partCode: req.partCode,
      partId: req.partId || null,
      qty: req.plannedOrderQty,
      uomCode: sourceDetail?.uomCode || uomCodeByPartCode[req.partCode] || null,
      requiredDate: req.requiredDate,
      orderDate: req.orderDate || new Date(),
      mbomHeaderId:
        req.orderType === "Production"
          ? supplyPolicyBySource.get(req.sourceNumber)?.mbomHeaderId || mbomHeaderByPartCode[req.partCode] || null
          : null,
      referenceType: "SO",
      referenceNumber: soLineReference,
      status: "Planned",
      notes: `${AUTO_SO_NOTE_PREFIX} Auto planned order dari shortage SO ${soHeader.soNumber} (${req.sourceNumber}) | trace ${req.notes || "n/a"}`,
      priority: 1,
    });
  }

  if (plannedOrderRows.length > 0) {
    await tx.plannedOrder.createMany({
      data: plannedOrderRows,
    });
  }

  await tx.mRPRun.update({
    where: { runNumber: soRunNumber },
    data: {
      runDate: new Date(),
      planHorizon: soPlanHorizon,
      cutoffDate,
      status: "Completed",
      errorMessage: null,
      executionTime: Math.max(Math.round((Date.now() - syncStartTime) / 1000), 0),
      totalRequirements: requirementRows.length,
      totalPlannedOrders: plannedOrderRows.length,
      notes: `${AUTO_SO_NOTE_PREFIX} Sinkronisasi shortage SO ${soHeader.soNumber}`,
    },
  });

  // Matikan PlannedOrder legacy berbasis SO agar tidak double planning
  await cancelLegacySoPlannedOrders(
    tx,
    soHeader.soNumber,
    `${AUTO_SO_NOTE_PREFIX} Dibatalkan otomatis - sumber shortage dipindah ke MRPRequirement`
  );

  return { warnings };
};

// Release semua reservation SO saat SO Cancelled/Closed/Overdue
const releaseReservationsForSO = async (tx, soNumber, releaseStatus = "Released") => {
  const reservations = await tx.stockReservation.findMany({
    where: {
      referenceType: "SO",
      ...buildSoReservationReferenceWhere(soNumber),
      isDeleted: false,
      // Best practice: hanya reservation aktif yang boleh dimutasi.
      // Histori Released/Cancelled dibiarkan immutable untuk audit trail.
      status: "Active",
    },
  });

  for (const reservation of reservations) {
    const qtyStillReserved =
      Number(reservation.qtyReserved || 0) - Number(reservation.qtyReleased || 0);

    if (qtyStillReserved > 0) {
      const affectedBalances = await tx.stockBalance.findMany({
        where: resolveReservationBalanceWhere(reservation),
        select: { id: true },
      });
      await assertStockBalancesNotFrozen(tx, affectedBalances.map((row) => row.id));
      await tx.stockBalance.updateMany({
        where: resolveReservationBalanceWhere(reservation),
        data: {
          qtyReserved: { decrement: qtyStillReserved },
          qtyAvailable: { increment: qtyStillReserved },
        },
      });
    }

    await tx.stockReservation.update({
      where: { id: reservation.id },
      data: {
        status: releaseStatus,
        qtyReleased: Number(reservation.qtyReserved || 0),
        notes: `${AUTO_SO_NOTE_PREFIX} Auto release karena status SO`,
      },
    });
  }

  // Nonaktifkan demand MRP SO, termasuk hybrid plan revisions (planNumber MRP-{SO}).
  await retireSoMrpPlan(
    tx,
    soNumber,
    `${AUTO_SO_NOTE_PREFIX} Demand MRP SO ditutup/cancel`
  );

  await cancelLegacySoPlannedOrders(
    tx,
    soNumber,
    `${AUTO_SO_NOTE_PREFIX} Dibatalkan otomatis karena SO ditutup`
  );
};

module.exports = {
  AUTO_SO_NOTE_PREFIX,
  SO_CLOSE_STATUSES,
  SALES_STOCK_TYPE_PRIORITY,
  buildSoLineReferenceNumber,
  allocateSalesStockBalances,
  buildSalesReservableStockWhere,
  sortSalesStockBalances,
  syncReservationsForConfirmedSO,
  releaseReservationsForSO,
};

