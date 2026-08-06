function normalizeIdentityValue(value) {
  if (value === undefined || value === null || value === "") return "∅";
  if (value instanceof Date) return value.toISOString();
  return String(value).trim().toUpperCase();
}

function buildStockBalanceLockKey(identity = {}) {
  return Object.keys(identity)
    .filter((key) => key !== "isDeleted")
    .sort()
    .map((key) => `${key}=${normalizeIdentityValue(identity[key])}`)
    .join("|");
}

async function lockStockBalanceIdentity(tx, identity) {
  const key = buildStockBalanceLockKey(identity);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`STOCK_BALANCE|${key}`}, 0))`;
  return key;
}

module.exports = { buildStockBalanceLockKey, lockStockBalanceIdentity };
