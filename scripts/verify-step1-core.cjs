const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const scope = require('../src/prisma/services/sales/salesDashboardScope');
const { assertGenericApprovalAllowed } = require('../src/prisma/services/sales/salesApprovalBoundary');
const { assertManualMovementAllowed } = require('../src/prisma/services/inventory/manualMovementPolicy');
const { reorderDecision, runReorderNotifications } = require('../src/prisma/services/inventory/reorderNotificationService');
const { canReadDashboard } = require('../src/prisma/services/dashboardAccess');
test('dashboard data requires module permission and system summary requires all constituent resources', () => {
  const sales = { listMenu: [{ resource: 'salesOrder', actions: ['read'] }] };
  assert.equal(canReadDashboard({}, 'sales'), false);
  assert.equal(canReadDashboard(sales, 'sales'), true);
  assert.equal(canReadDashboard(sales, 'system'), false);
  assert.equal(canReadDashboard({ isSuperAdmin: true }, 'system'), true);
  const byModule = { roleAssignments: [{ isActive: true, role: { isActive: true, permissions: ['sales', 'production', 'purchasing', 'inventory'].map(moduleCode => ({ moduleCode, pageCode: '*', resourceCode: '*', actions: ['read'] })) } }] };
  assert.equal(canReadDashboard(byModule, 'system'), true);
  for (const status of ['In Planning', 'In Production']) assert.equal(scope.BOOKED_STATUSES.includes(status), true);
  for (const status of ['Draft', 'In Approval', 'Superseded', 'Cancelled']) assert.equal(scope.BOOKED_STATUSES.includes(status), false);
});
function load(relative, overrides) {
  const file = path.resolve(__dirname, relative), local = createRequire(file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, require: name => name in overrides ? overrides[name] : local(name), console, process, Buffer, Date, Set, Map, URL }, { filename: file });
  return module.exports;
}
test('quarter/year totals reconcile with monthly quantities and zero plan has no invented attainment', () => {
  const values = Array.from({ length: 12 }, (_, i) => i + 1);
  assert.deepEqual(scope.aggregateMonths(values, 'QUARTER'), [6, 15, 24, 33]);
  assert.deepEqual(scope.aggregateMonths(values, 'YEAR'), [78]);
  const payload = { year: 2026, comparison: { modes: { QTY: [{ data: values }] } }, detailTables: [{ columns: [{}], rows: values.map(actual => ({ plan: 0, actual })) }] };
  assert.equal(scope.applyPeriod(payload, 'YEAR').detailTables[0].rows[0].attainment, null);
  assert.throws(() => scope.dashboardOptions({ period: 'WEEK' }), { statusCode: 400 });
  assert.throws(() => scope.dashboardOptions({ customerCode: '\u0000' }), { statusCode: 400 });
});
test('BOOKED filters draft/superseded and other customers; quarterly forecast and actual reconcile', async () => {
  const records = [
    { customerCode: 'A', status: 'Confirmed', qty: 10 }, { customerCode: 'A', status: 'Draft', qty: 900 },
    { customerCode: 'A', status: 'Submitted', qty: 800 }, { customerCode: 'A', status: 'Superseded', qty: 700 },
    { customerCode: 'B', status: 'Confirmed', qty: 600 },
  ];
  const db = {
    salesOrderHeader: { findMany: async ({ where }) => records.filter(row => row.customerCode === where.customerCode && where.status.in.includes(row.status)).map(row => ({ ...row, soDate: new Date(2026, 1, 2), currencyCode: 'IDR', totalAmount: row.qty * 100, details: [{ qty: row.qty, totalAmount: row.qty * 100 }] })) },
    forecast: { findMany: async ({ where }) => { assert.equal(where.customerCode, 'A'); assert.equal(where.isCurrentVersion, true); return [{ details: [{ unitPrice: 100, M1Forecast: new Date(2026, 1, 1), M1Qty: 20 }] }]; } },
    salesActualLedger: { findMany: async ({ where }) => { assert.equal(where.customerCode, 'A'); return []; } },
  };
  const controller = load('../src/prisma/controllers/dashboard/ExecutiveDashboardController.js', { '../../index': { prisma: db } });
  let result;
  await controller.get({ query: { year: '2026', customerCode: 'A', period: 'QUARTER' }, params: { module: 'sales' } }, { json: value => result = value }, error => { throw error; });
  assert.deepEqual(Array.from(result.comparison.modes.PLAN_QTY[1].data), [10, 0, 0, 0]);
  assert.equal(result.detailTables[0].rows[0].plan, 20);
  assert.equal(result.detailTables[0].rows[0].attainment, 50);
});
test('DELIVERED basis uses POD date, including next-year POD, and retains customer scoping', async () => {
  const db = {
    deliverySchedule: { findMany: async ({ where }) => { assert.equal(where.soHeader.is.customerCode, 'A'); return [{ actualDate: new Date(2025, 11, 31), deliveredAt: new Date(2026, 0, 3), soHeader: { currencyCode: 'IDR' }, details: [{ qtyDelivered: 3, soDetail: { unitPrice: 10 } }] }]; } },
    forecast: { findMany: async () => [] }, salesActualLedger: { findMany: async () => [] },
  };
  const controller = load('../src/prisma/controllers/dashboard/ExecutiveDashboardController.js', { '../../index': { prisma: db } });
  let result;
  await controller.get({ query: { year: '2026', customerCode: 'A', period: 'YEAR', actualBasis: 'DELIVERED' }, params: { module: 'sales' } }, { json: value => result = value }, error => { throw error; });
  assert.equal(result.comparison.modes.QTY[0].data[0], 3);
  assert.equal(result.comparison.modes.QTY[1].data[0], 0);
});
test('generic approvals cannot bypass Sales Order workflow; manual adjustment must use opname', () => {
  for (const value of [{ documentType: 'SalesOrderHeader' }, { moduleCode: 'sales', pageCode: 'sales-orders' }]) assert.throws(() => assertGenericApprovalAllowed(value), { statusCode: 409 });
  assert.doesNotThrow(() => assertGenericApprovalAllowed({ documentType: 'PurchaseOrder' }));
  assert.throws(() => assertManualMovementAllowed({ movementType: 'ADJUSTMENT' }), { statusCode: 409 });
  assert.doesNotThrow(() => assertManualMovementAllowed({ movementType: 'TRANSFER' }));
});
test('reorder alerts deduplicate per shortage and user, recover, then alert on a new shortage', () => {
  const balance = { qtyAvailable: 5, minStock: 10, reorderPoint: 20 };
  const first = reorderDecision(balance, null, ['u1', 'u1']);
  assert.deepEqual(first.targets, ['u1']); assert.equal(first.threshold, 20);
  assert.deepEqual(reorderDecision(balance, first, ['u1']).targets, []);
  assert.deepEqual(reorderDecision(balance, first, ['u1', 'u2']).targets, ['u2']);
  const recovery = reorderDecision({ ...balance, qtyAvailable: 20 }, first, ['u1']);
  assert.equal(recovery.isLow, false);
  assert.deepEqual(reorderDecision(balance, recovery, ['u1']).targets, ['u1']);
  assert.equal(reorderDecision({ ...balance, isDeleted: true }, first, ['u1']).isLow, false);
});
test('reorder persistence is targeted, transactionally deduplicated, and broadcasts only after commit', async () => {
  let states = [], notifications = [], committed = false;
  const balance = { id: 'B1', warehouseCode: 'W1', uomCode: 'KG', qtyAvailable: 1.5, minStock: 2, partCode: 'P1' };
  const db = { $transaction: async fn => {
    committed = false;
    const result = await fn({
      $queryRaw: async () => [{ locked: true }], stockBalance: { findMany: async () => [balance] },
      inventoryReorderState: { findMany: async () => states, upsert: async ({ create, update }) => { states = [{ ...create, ...update }]; } },
      user: { findMany: async ({ where }) => { assert.deepEqual(where.partnerAccess, { is: null }); return [{ id: 'warehouse', listMenu: [{ resource: 'stockBalances', actions: ['read'] }] }, { id: 'sales', listMenu: [{ resource: 'salesOrder', actions: ['read'] }] }]; } },
      notification: { create: async ({ data }) => { notifications.push(data); return data; } },
    }); committed = true; return result;
  } };
  let broadcasts = 0;
  const emit = notification => { assert.equal(committed, true); assert.equal(notification.userId, 'warehouse'); broadcasts++; };
  await runReorderNotifications(db, emit); await runReorderNotifications(db, emit);
  assert.equal(notifications.length, 1); assert.equal(broadcasts, 1);
  assert.equal(notifications[0].metadata.uomCode, 'KG');
});
test('partner restrictions follow live binding even when inactive and never fall back to internal APIs', async () => {
  let binding = { id: 'binding', isActive: false };
  const auth = load('../src/prisma/middleware/auth.js', {
    jsonwebtoken: { verify: () => ({ id: 'partner' }) },
    '../index': { prisma: { user: { findUnique: async () => ({ id: 'partner', roleAssignments: [] }) }, partnerAccess: { findUnique: async () => binding } } },
    '../utils/pageContext': { attachContextAudit() {}, resolvePageContext: () => ({}) },
  });
  async function request(url, method = 'GET') {
    let status = 200, next = false;
    await auth.auth({ headers: { authorization: 'Bearer test' }, originalUrl: url, method }, { status(code) { status = code; return this; }, json() {} }, () => { next = true; });
    return { status, next };
  }
  assert.deepEqual(await request('/api/sales/sales-orders'), { status: 403, next: false });
  assert.deepEqual(await request('/api/users/profile', 'PATCH'), { status: 403, next: false });
  assert.equal((await request('/api/users/profile')).next, true);
  assert.equal((await request('/api/partner-portal/me')).next, true);
  binding = null; assert.equal((await request('/api/sales/sales-orders')).next, true);
});
