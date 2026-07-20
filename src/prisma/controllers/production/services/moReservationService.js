// Service untuk auto-reservasi material saat MO direlease
// dan release reservasi saat MO di-cancel

const {
  normalizeText,
  resolveReservationBalanceWhere,
  generateReservationNumber,
  buildExcludeSpecialRackCondition,
} = require("../../inventory/utils/stockReservationHelpers");
const {
  assertStockBalanceNotFrozen,
  assertStockBalancesNotFrozen,
} = require("../../inventory/utils/stockOpnameFreezeGuard");

const AUTO_MO_NOTE_PREFIX = "[AUTO-MO]";
const QUANTITY_TOLERANCE = 0.005;
const ALLOCATION_STRATEGIES = new Set(["SMALLEST", "FIFO", "LIFO", "LARGEST", "MANUAL"]);

const buildMoLineReferenceNumber = (moNumber, lineNumber) =>
  `${moNumber}#${String(lineNumber)}`;

const roundQuantity = (value) => Math.round(Number(value || 0) * 1000000) / 1000000;
const isPositiveQuantity = (value) => roundQuantity(value) > QUANTITY_TOLERANCE;

const normalizeAllocationStrategy = (value) => {
  const strategy = String(value || "FIFO").trim().toUpperCase();
  return ALLOCATION_STRATEGIES.has(strategy) ? strategy : "FIFO";
};

const getAllocationOrderBy = (strategy) => {
  switch (normalizeAllocationStrategy(strategy)) {
    case "FIFO":
      return [{ lastMovement: "asc" }, { createdAt: "asc" }, { qtyAvailable: "asc" }];
    case "LIFO":
      return [{ lastMovement: "desc" }, { createdAt: "desc" }, { qtyAvailable: "asc" }];
    case "LARGEST":
      return [{ qtyAvailable: "desc" }, { lastMovement: "asc" }];
    case "SMALLEST":
    default:
      return [{ qtyAvailable: "asc" }, { lastMovement: "asc" }];
  }
};

const normalizeManualAllocations = (allocations = [], lineNumber = null) =>
  (Array.isArray(allocations) ? allocations : [])
    .filter((allocation) => {
      if (!allocation?.stockBalanceId) return false;
      if (lineNumber == null) return true;
      return Number(allocation.lineNumber) === Number(lineNumber);
    })
    .map((allocation) => ({
      stockBalanceId: allocation.stockBalanceId,
      qty: roundQuantity(allocation.qty),
    }))
    .filter((allocation) => allocation.qty > 0);

const findManualStockAllocations = async (tx, partCode, uomCode, qtyTarget, manualAllocations = []) => {
  const normalizedManualAllocations = normalizeManualAllocations(manualAllocations);
  if (normalizedManualAllocations.length === 0) {
    return { allocations: [], remaining: roundQuantity(qtyTarget) };
  }

  const balanceIds = [...new Set(normalizedManualAllocations.map((allocation) => allocation.stockBalanceId))];
  const balances = await tx.stockBalance.findMany({
    where: {
      AND: [
        {
          id: { in: balanceIds },
          partCode,
          uomCode: uomCode || null,
          isDeleted: false,
          qtyAvailable: { gt: 0 },
        },
        buildExcludeSpecialRackCondition(),
      ],
    },
  });
  const balanceMap = new Map(balances.map((balance) => [balance.id, balance]));

  let remaining = roundQuantity(qtyTarget);
  const allocations = [];

  for (const manualAllocation of normalizedManualAllocations) {
    if (!isPositiveQuantity(remaining)) break;

    const stockBalance = balanceMap.get(manualAllocation.stockBalanceId);
    if (!stockBalance) continue;

    const qtyAvailable = Number(stockBalance.qtyAvailable || 0);
    const qty = roundQuantity(Math.min(qtyAvailable, manualAllocation.qty, remaining));
    if (qty <= 0) continue;

    allocations.push({ stockBalance, qty });
    remaining = roundQuantity(remaining - qty);
  }

  return {
    allocations,
    remaining: isPositiveQuantity(remaining) ? remaining : 0,
  };
};

const findStockAllocations = async (tx, partCode, qtyTarget, options = {}) => {
  const manualAllocations = normalizeManualAllocations(options.manualAllocations);
  if (manualAllocations.length > 0) {
    return findManualStockAllocations(tx, partCode, options.uomCode, qtyTarget, manualAllocations);
  }

  const balances = await tx.stockBalance.findMany({
    where: {
      AND: [
        {
          partCode,
          uomCode: options.uomCode || null,
          isDeleted: false,
          qtyAvailable: { gt: 0 },
        },
        buildExcludeSpecialRackCondition(),
      ],
    },
    orderBy: getAllocationOrderBy(options.allocationStrategy),
  });

  let remaining = roundQuantity(qtyTarget);
  const allocations = [];

  for (const stockBalance of balances) {
    if (!isPositiveQuantity(remaining)) break;

    const qtyAvailable = Number(stockBalance.qtyAvailable || 0);
    const qty = roundQuantity(Math.min(qtyAvailable, remaining));
    if (qty <= 0) continue;

    allocations.push({ stockBalance, qty });
    remaining = roundQuantity(remaining - qty);
  }

  return {
    allocations,
    remaining: isPositiveQuantity(remaining) ? remaining : 0,
  };
};

/**
 * Buat auto reservation untuk material MBOM saat MO released.
 * Reserve semua part yang dibutuhkan berdasarkan MBOM detail × qty MO.
 */
const syncReservationsForMO = async (tx, mo, mbomDetails = [], options = {}) => {
  if (!mo?.moNumber) return;
  const allocationStrategy = normalizeAllocationStrategy(options.allocationStrategy);

  // Filter detail yang valid (ada partCode dan qty > 0)
  const normalizedDetails = mbomDetails
    .filter((d) => !d.isDeleted && d.part)
    .map((d, idx) => ({
      lineNumber: idx + 1,
      qty: roundQuantity(Number(d.qty || 0) * Number(mo.qtyPlanned || 0)),
      partCode: normalizeText(d.part.partCode),
      uomCode: normalizeText(d.uomCode),
      category: d.category,
      manualAllocations: normalizeManualAllocations(options.manualAllocations, idx + 1),
    }))
    .filter((d) => d.partCode && d.qty > 0);

  if (normalizedDetails.length === 0) return;

  const targetMap = new Map();
  for (const d of normalizedDetails) {
    const ref = buildMoLineReferenceNumber(mo.moNumber, d.lineNumber);
    targetMap.set(ref, d);
  }

  // Cek existing reservations untuk MO ini
  const existingReservations = await tx.stockReservation.findMany({
    where: {
      referenceType: "MANUFACTURING_ORDER",
      OR: [
        { referenceNumber: mo.moNumber },
        { referenceNumber: { startsWith: `${mo.moNumber}#` } },
      ],
      isDeleted: false,
    },
    orderBy: { createdAt: "asc" },
  });

  const existingMap = new Map(
    existingReservations.map((r) => [r.referenceNumber, r])
  );

  // Release reservation lama yang sudah tidak ada di detail terbaru
  for (const reservation of existingReservations) {
    if (reservation.referenceNumber === mo.moNumber) continue;
    const baseReferenceNumber = String(reservation.referenceNumber || "").split("@")[0];
    if (targetMap.has(baseReferenceNumber)) continue;

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
        notes: `${AUTO_MO_NOTE_PREFIX} Auto released`,
      },
    });
  }

  // Create / adjust reservation untuk setiap material line
  for (const [referenceNumber, detail] of targetMap.entries()) {
    const qtyTarget = Number(detail.qty || 0);
    const existingForLine = existingReservations.filter(
      (reservation) => String(reservation.referenceNumber || "").split("@")[0] === referenceNumber,
    );
    const existing = existingMap.get(referenceNumber);

    if (existingForLine.length === 0 && !existing) {
      const { allocations, remaining } = await findStockAllocations(tx, detail.partCode, qtyTarget, {
        allocationStrategy,
        manualAllocations: detail.manualAllocations,
        uomCode: detail.uomCode,
      });

      if (isPositiveQuantity(remaining)) {
        throw new Error(
          `Stok tidak mencukupi untuk reservasi MO ${mo.moNumber} part ${detail.partCode} (butuh ${roundQuantity(qtyTarget)})`
        );
      }

      for (const [allocationIndex, allocation] of allocations.entries()) {
        const { stockBalance, qty } = allocation;
        const sourceReferenceNumber = allocations.length === 1
          ? referenceNumber
          : `${referenceNumber}@${allocationIndex + 1}`;
        const reservationNumber = await generateReservationNumber(tx, new Date());
        await tx.stockReservation.create({
          data: {
            reservationNumber,
            reservationDate: new Date(),
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
            referenceType: "MANUFACTURING_ORDER",
            referenceNumber: sourceReferenceNumber,
            status: "Active",
            notes: `${AUTO_MO_NOTE_PREFIX} ${mo.moNumber} material ${detail.partCode} (${allocationStrategy})`,
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

    if (existingForLine.length > 1 && !existing) {
      const currentReserved = roundQuantity(
        existingForLine.reduce((sum, reservation) => sum + Number(reservation.qtyReserved || 0), 0),
      );
      if (currentReserved === roundQuantity(qtyTarget)) continue;

      throw new Error(
        `Reservasi split untuk MO ${mo.moNumber} part ${detail.partCode} sudah ada. Cancel/release dulu sebelum adjust qty.`
      );
    }

    // Adjust existing reservation jika qty berubah
    const currentReserved = Number(existing.qtyReserved || 0);
    const diff = roundQuantity(qtyTarget - currentReserved);

    if (isPositiveQuantity(diff)) {
      const stockBalance = await tx.stockBalance.findFirst({
        where: resolveReservationBalanceWhere(existing, {
          excludeSpecialRacks: true,
        }),
        select: { id: true, qtyAvailable: true },
      });

      if (!stockBalance || isPositiveQuantity(diff - Number(stockBalance.qtyAvailable))) {
        throw new Error(
          `Stok tidak mencukupi untuk adjust reservasi MO ${mo.moNumber} part ${detail.partCode}`
        );
      }

      await assertStockBalanceNotFrozen(tx, stockBalance.id);
      await tx.stockBalance.update({
        where: { id: stockBalance.id },
        data: {
          qtyReserved: { increment: diff },
          qtyAvailable: { decrement: diff },
        },
      });
    } else if (diff < 0) {
      const releaseQty = Math.abs(diff);
      const affectedBalances = await tx.stockBalance.findMany({
        where: resolveReservationBalanceWhere(existing),
        select: { id: true },
      });
      await assertStockBalancesNotFrozen(tx, affectedBalances.map((row) => row.id));
      await tx.stockBalance.updateMany({
        where: resolveReservationBalanceWhere(existing),
        data: {
          qtyReserved: { decrement: releaseQty },
          qtyAvailable: { increment: releaseQty },
        },
      });
    }

    const normalizedQtyTarget = isPositiveQuantity(qtyTarget - currentReserved)
      ? qtyTarget
      : currentReserved;

    await tx.stockReservation.update({
      where: { id: existing.id },
      data: {
        qtyReserved: normalizedQtyTarget,
        qtyReleased: Math.min(Number(existing.qtyReleased || 0), normalizedQtyTarget),
        status: "Active",
        notes: `${AUTO_MO_NOTE_PREFIX} ${mo.moNumber} material ${detail.partCode} (${allocationStrategy})`,
      },
    });
  }
};

/**
 * Reserve satu source WIP stock untuk MO yang input source-nya Existing WIP Stock.
 * Mengunci qtyAvailable supaya MO lain tidak bisa mengambil sumber WIP yang sama.
 */
const reserveSourceWipForMO = async (tx, mo) => {
  if (!mo?.moNumber || mo.inputSourceType !== "WIP_STOCK" || !mo.sourceStockBalanceId) return null;

  const qtyTarget = roundQuantity(Number(mo.sourceQtyPlanned || mo.qtyPlanned || 0));
  if (!isPositiveQuantity(qtyTarget)) return null;

  const stockBalance = await tx.stockBalance.findFirst({
    where: {
      id: mo.sourceStockBalanceId,
      uomCode: mo.uomCode || null,
      isDeleted: false,
      stockType: "WIP",
    },
  });
  if (!stockBalance) {
    throw new Error(`Source WIP stock untuk MO ${mo.moNumber} tidak ditemukan.`);
  }

  const existing = await tx.stockReservation.findFirst({
    where: {
      referenceType: "MANUFACTURING_ORDER",
      referenceNumber: mo.moNumber,
      stockBalanceId: stockBalance.id,
      isDeleted: false,
    },
    orderBy: { createdAt: "asc" },
  });

  if (!existing) {
    if (isPositiveQuantity(qtyTarget - Number(stockBalance.qtyAvailable || 0))) {
      throw new Error(
        `WIP stock tidak mencukupi untuk release MO ${mo.moNumber} (butuh ${qtyTarget}, available ${roundQuantity(stockBalance.qtyAvailable)}).`,
      );
    }

    const reservationNumber = await generateReservationNumber(tx, new Date());
    await tx.stockReservation.create({
      data: {
        reservationNumber,
        reservationDate: new Date(),
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
        qtyReserved: qtyTarget,
        qtyReleased: 0,
        referenceType: "MANUFACTURING_ORDER",
        referenceNumber: mo.moNumber,
        status: "Active",
        notes: `${AUTO_MO_NOTE_PREFIX} ${mo.moNumber} source WIP ${stockBalance.partCode || ""}`.trim(),
      },
    });

    await assertStockBalanceNotFrozen(tx, stockBalance.id);
    await tx.stockBalance.update({
      where: { id: stockBalance.id },
      data: {
        qtyReserved: { increment: qtyTarget },
        qtyAvailable: { decrement: qtyTarget },
      },
    });

    return { reservedQty: qtyTarget, stockBalanceId: stockBalance.id, created: true };
  }

  const currentReserved = Number(existing.qtyReserved || 0);
  const diff = roundQuantity(qtyTarget - currentReserved);
  if (isPositiveQuantity(diff)) {
    if (isPositiveQuantity(diff - Number(stockBalance.qtyAvailable || 0))) {
      throw new Error(
        `WIP stock tidak mencukupi untuk adjust release MO ${mo.moNumber} (tambahan ${diff}, available ${roundQuantity(stockBalance.qtyAvailable)}).`,
      );
    }
    await assertStockBalanceNotFrozen(tx, stockBalance.id);
    await tx.stockBalance.update({
      where: { id: stockBalance.id },
      data: {
        qtyReserved: { increment: diff },
        qtyAvailable: { decrement: diff },
      },
    });
  } else if (diff < 0) {
    const releaseQty = Math.abs(diff);
    await assertStockBalanceNotFrozen(tx, stockBalance.id);
    await tx.stockBalance.update({
      where: { id: stockBalance.id },
      data: {
        qtyReserved: { decrement: releaseQty },
        qtyAvailable: { increment: releaseQty },
      },
    });
  }

  await tx.stockReservation.update({
    where: { id: existing.id },
    data: {
      qtyReserved: qtyTarget,
      qtyReleased: Math.min(Number(existing.qtyReleased || 0), qtyTarget),
      status: "Active",
      notes: `${AUTO_MO_NOTE_PREFIX} ${mo.moNumber} source WIP ${stockBalance.partCode || ""}`.trim(),
    },
  });

  return { reservedQty: qtyTarget, stockBalanceId: stockBalance.id, created: false };
};

/**
 * Release semua reservasi MO saat MO di-cancel
 */
const releaseReservationsForMO = async (tx, moNumber, releaseStatus = "Released") => {
  const reservations = await tx.stockReservation.findMany({
    where: {
      referenceType: "MANUFACTURING_ORDER",
      OR: [
        { referenceNumber: moNumber },
        { referenceNumber: { startsWith: `${moNumber}#` } },
      ],
      isDeleted: false,
      status: { in: ["Active", "Released"] },
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
        notes: `${AUTO_MO_NOTE_PREFIX} Auto release karena MO ${releaseStatus === "Cancelled" ? "dibatalkan" : "selesai"}`,
      },
    });
  }
};

module.exports = {
  AUTO_MO_NOTE_PREFIX,
  ALLOCATION_STRATEGIES,
  buildMoLineReferenceNumber,
  normalizeAllocationStrategy,
  reserveSourceWipForMO,
  syncReservationsForMO,
  releaseReservationsForMO,
};
