const { userHasPermission } = require('../ai/permissionEvaluator');

function reorderThreshold(balance) {
  const point = Number(balance.reorderPoint), minimum = Number(balance.minStock);
  return Number.isFinite(point) && point > 0 ? point : (Number.isFinite(minimum) && minimum > 0 ? minimum : 0);
}
function reorderDecision(balance, previous, recipientIds) {
  const threshold = reorderThreshold(balance);
  const available = Number(balance.qtyAvailable);
  const isLow = !balance.isDeleted && threshold > 0 && Number.isFinite(available) && available < threshold;
  const already = new Set(previous?.isLow && Array.isArray(previous.notifiedUserIds) ? previous.notifiedUserIds : []);
  const targets = isLow ? [...new Set(recipientIds)].filter(id => !already.has(id)) : [];
  return { isLow, threshold, lastAvailable: Number.isFinite(available) ? available : 0,
    notifiedUserIds: isLow ? [...new Set([...already, ...targets])] : [], targets };
}

async function runReorderNotifications(db, broadcast = () => {}) {
  const notifications = await db.$transaction(async tx => {
    // One runner across all ERP processes; states and notifications commit together.
    const [lock] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(482, 1) AS locked`;
    if (!lock?.locked) return [];
    const [balances, previousRows, users] = await Promise.all([
      tx.stockBalance.findMany({ select: { id: true, isDeleted: true, warehouseCode: true, rackCode: true, lotNumber: true, partCode: true, materialCode: true, partName: true, materialName: true, description: true, uomCode: true, qtyAvailable: true, minStock: true, reorderPoint: true } }),
      tx.inventoryReorderState.findMany(),
      tx.user.findMany({ where: { isDeleted: false, partnerAccess: { is: null } }, include: { roleAssignments: { where: { isActive: true }, include: { role: { include: { permissions: { where: { isActive: true, isDeleted: false } } } } } } } }),
    ]);
    const recipients = users.filter(user => userHasPermission(user, { resourceCode: 'stockBalances', action: 'read', moduleCode: 'inventory', pageCode: 'stock-balances' })).map(user => user.id);
    const previous = new Map(previousRows.map(row => [row.stockBalanceId, row]));
    const created = [];
    for (const balance of balances) {
      const old = previous.get(balance.id), decision = reorderDecision(balance, old, recipients);
      if (!old && !decision.isLow) continue;
      const { targets, ...state } = decision;
      await tx.inventoryReorderState.upsert({ where: { stockBalanceId: balance.id }, create: { stockBalanceId: balance.id, ...state }, update: state });
      for (const userId of targets) created.push(await tx.notification.create({ data: {
        type: 'inventory_reorder', title: 'Persediaan perlu diisi kembali',
        message: `${balance.partCode || balance.materialCode || balance.description || balance.id} · ${balance.warehouseCode}${balance.rackCode ? ` / ${balance.rackCode}` : ''}${balance.lotNumber ? ` · Lot ${balance.lotNumber}` : ''}: tersedia ${decision.lastAvailable} ${balance.uomCode || ''}, batas pemesanan ${decision.threshold} ${balance.uomCode || ''}.`,
        userId, entityId: balance.id, entityUrl: '/modules/inventory/stock-balances', createdBy: 'system:reorder',
        metadata: { stockBalanceId: balance.id, available: decision.lastAvailable, threshold: decision.threshold, uomCode: balance.uomCode, warehouseCode: balance.warehouseCode, lotNumber: balance.lotNumber },
      } }));
    }
    return created;
  }, { timeout: 60000 });
  for (const notification of notifications) broadcast(notification);
  return { created: notifications.length };
}
module.exports = { reorderThreshold, reorderDecision, runReorderNotifications };
