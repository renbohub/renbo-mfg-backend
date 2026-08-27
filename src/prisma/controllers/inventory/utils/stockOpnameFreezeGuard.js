const { stockIdentityMatchesScope } = require("../../../services/inventory/stockOpnameDomain");

const ACTIVE_FROZEN_STO_STATUSES = [
  "DRAFT",
  "COUNTING",
  "WAITING_CHECK",
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

async function assertStockIdentityNotFrozen(tx, identity = {}, options = {}) {
  if (!identity.warehouseCode) return;
  const locks = await tx.stockOpnameHeader.findMany({
    where: {
      warehouseCode: identity.warehouseCode,
      isDeleted: false,
      inventoryFrozen: true,
      status: { in: ACTIVE_FROZEN_STO_STATUSES },
      ...(options.allowStoNo ? { stoNo: { not: options.allowStoNo } } : {}),
    },
    select: { stoNo: true, status: true, scopeJson: true },
  });
  const lock = locks.find((row) =>
    !row.scopeJson || stockIdentityMatchesScope(identity, row.scopeJson));
  if (lock) throwFrozenStockError({ header: lock });
}
async function assertWarehouseNotFrozen(tx, warehouseCode, options = {}) {
  if (!warehouseCode) return;
  const lock = await tx.stockOpnameHeader.findFirst({
    where: {
      warehouseCode,
      isDeleted: false,
      inventoryFrozen: true,
      status: { in: ACTIVE_FROZEN_STO_STATUSES },
      ...(options.allowStoNo ? { stoNo: { not: options.allowStoNo } } : {}),
    },
    select: { stoNo: true, status: true },
  });
  if (lock) throwFrozenStockError({ header: lock });
}

module.exports = {
  ACTIVE_FROZEN_STO_STATUSES,
  assertStockBalanceNotFrozen,
  assertStockBalancesNotFrozen,
  assertStockIdentityNotFrozen,
  assertWarehouseNotFrozen,
  findFrozenStockOpnameLock,
};
