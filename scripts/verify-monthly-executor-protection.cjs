"use strict";
const assert = require('node:assert/strict');
const { affectedDocuments } = require('../src/prisma/services/planning/monthlyExecutorService');

const source = { id: 'a', planId: 'plan-1', mbomProcessId: 'route-1' };
const successor = { id: 'b', planId: 'plan-2', mbomProcessId: 'route-2' };
const pr = { id: 'pr', prNumber: 'PR-1', status: 'Draft', purchaseOrders: [] };
const detail = (value = {}) => ({ id: 'detail', pr, prNumber: pr.prNumber, poDetails: [], sourcingAllocations: [], ...value });

function fixture(data = {}) {
  const queries = {};
  const read = (name, rows = []) => async query => { queries[name] = query; return rows; };
  return {
    queries,
    db: {
      monthlyProductionPlan: { findMany: read('plans', [{ id: 'plan-1', planNumber: 'MPP-1' }, { id: 'plan-2', planNumber: 'MPP-2' }]) },
      manufacturingOrder: { findMany: read('mos', [{ id: 'mo-1', monthlyProductionPlanNumber: 'MPP-1' }, { id: 'mo-2', monthlyProductionPlanNumber: 'MPP-2' }]) },
      purchaseRequisitionDetail: { findMany: read('details', data.details) },
      dailyProductionSchedule: { findMany: read('schedules', data.schedules) },
      vendorProcessOrder: { findMany: read('vendors', data.vendors) },
      workOrder: { findMany: read('workOrders', data.workOrders) },
      materialIssue: { findMany: read('issues', data.issues) },
    },
  };
}

(async () => {
  const confirmedCancelledPr = fixture({ details: [detail({ pr: { ...pr, status: 'Cancelled' }, sourcingAllocations: [{ status: 'Confirmed', confirmedAt: new Date() }] })] });
  assert.equal((await affectedDocuments(confirmedCancelledPr.db, source))[0].blocking, true, 'cancelled PR must not hide a live sourcing commitment');
  const confirmedDraftSourcing = fixture({ details: [detail({ sourcingAllocations: [{ status: 'Draft', confirmedAt: new Date() }] })] });
  assert.equal((await affectedDocuments(confirmedDraftSourcing.db, source))[0].blocking, true, 'confirmation timestamp protects legacy Draft sourcing');
  const cancelled = fixture({ details: [detail({ pr: { ...pr, status: 'Cancelled' }, sourcingAllocations: [{ status: 'Cancelled', confirmedAt: new Date() }] })] });
  assert.equal((await affectedDocuments(cancelled.db, source)).length, 0);

  const po = { id: 'po', poNumber: 'PO-1', status: 'Approved' };
  const linkedPo = fixture({ details: [detail({ pr: { ...pr, purchaseOrders: [{ po }] }, poDetails: [{ po, poNumber: 'PO-1', qtyReceived: 10 }] })] });
  const poDoc = (await affectedDocuments(linkedPo.db, source)).find(row => row.type === 'PO Vendor');
  assert.equal(poDoc.executed, true, 'header duplicate must not downgrade physical receipt evidence');
  assert.equal(poDoc.url, '/modules/purchasing/purchase-order/PO-1');
  const headerOnly = fixture({ details: [detail({ pr: { ...pr, purchaseOrders: [{ po }] } })] });
  assert((await affectedDocuments(headerOnly.db, source)).some(row => row.type === 'PO Vendor' && row.blocking), 'legacy header-only PO must be visible');

  const issued = fixture({
    schedules: [{ id: 'dps', scheduleNumber: 'DPS-1', woId: 'wo-1', status: 'Cancelled', actualQty: 0, productionLogs: [] }],
    workOrders: [{ id: 'wo-1', woNumber: 'WO-1', status: 'Cancelled', startTime: new Date(), qtyProduced: 0, productionLogs: [] }],
    issues: [{ id: 'mi', issueNumber: 'MI-1', status: 'Cancelled', details: [{ qtyIssued: 100, qtyReturned: 40 }] }],
  });
  const issueDocs = await affectedDocuments(issued.db, source, [successor]);
  assert(issueDocs.some(row => row.type === 'Material Issue' && row.executed), 'cancelled schedule and issue cannot erase 60 issued units');
  assert(issueDocs.some(row => row.type === 'Work Order' && row.executed), 'cancelled WO with start evidence stays locked');
  assert(issued.queries.issues.where.OR.some(row => row.woId?.in.includes('wo-1')));
  assert(issued.queries.issues.where.OR.some(row => row.notes?.contains === '[DPS-CONSUME:DPS-1]'));
  assert(issued.queries.schedules.where.OR.some(row => row.productionPlanId === 'plan-2' && row.mbomProcessId === 'route-2'), 'legacy successor schedules must be included');
  assert(issued.queries.workOrders.where.OR.some(row => row.mbomProcessId === 'route-2' && row.moId.in.includes('mo-2')), 'successor legacy WO keeps its own Monthly Plan scope');
  assert(!issued.queries.workOrders.where.OR.find(row => row.mbomProcessId === 'route-1').moId.in.includes('mo-2'), 'do not match a common process under a different plan');
  assert(issued.queries.vendors.where.OR.some(row => row.mbomProcessId === 'route-1' && row.OR?.some(branch => branch.notes?.not?.contains === '[CAPACITY-VENDOR:')), 'legacy VPO fallback must exclude other exact allocated batches');

  const sent = fixture({ vendors: [{ id: 'vpo', orderNumber: 'VPO-1', status: 'Cancelled', isDeleted: true, qtySent: 25, qtyReceived: 0 }] });
  const vendorDoc = (await affectedDocuments(sent.db, source))[0];
  assert.equal(vendorDoc.executed, true);
  assert.equal(vendorDoc.url, '/modules/production/vendor-process-orders/VPO-1');
  console.log('PASS Monthly executor protection: sourcing commitments, header-only PO, exact successor scope, legacy vendor orders, canceled production and issued stock.');
})().catch(error => { console.error(error); process.exitCode = 1; });
