const ACTIVE_FROZEN_STO_STATUSES = [
  "DRAFT",
  "COUNTING",
  "WAITING_APPROVAL",
  "APPROVED",
];

function throwFrozenStockError(lock) {
  const stoNo = lock?.header?.stoNo || "STO aktif";
  const err = new Error(
    `Stock balance sedang frozen oleh ${stoNo}. Selesaikan atau batalkan stock opname sebelum melakukan transaksi stok.`,
  );
  err.statusCode = 409;
  throw err;
}

async function findFrozenStockOpnameLock(tx, stockBalanceIds = [], options = {}) {
  const ids = [...new Set(stockBalanceIds.filter(Boolean))];
  if (!ids.length) return null;

  const lock = await tx.stockOpnameDetail.findFirst({
    where: {
      stockBalanceId: { in: ids },
      isDeleted: false,
      header: {
        isDeleted: false,
        inventoryFrozen: true,
        status: { in: ACTIVE_FROZEN_STO_STATUSES },
        ...(options.allowStoNo ? { stoNo: { not: options.allowStoNo } } : {}),
      },
    },
    select: {
      stockBalanceId: true,
      header: {
        select: {
          stoNo: true,
          status: true,
        },
      },
    },
  });

  return lock;
}

async function assertStockBalancesNotFrozen(tx, stockBalanceIds = [], options = {}) {
  const lock = await findFrozenStockOpnameLock(tx, stockBalanceIds, options);
  if (lock) throwFrozenStockError(lock);
}

async function assertStockBalanceNotFrozen(tx, stockBalanceId, options = {}) {
  await assertStockBalancesNotFrozen(tx, [stockBalanceId], options);
}

module.exports = {
  ACTIVE_FROZEN_STO_STATUSES,
  assertStockBalanceNotFrozen,
  assertStockBalancesNotFrozen,
  findFrozenStockOpnameLock,
};
