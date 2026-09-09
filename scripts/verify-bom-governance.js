"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
process.env.NODE_ENV = 'test';
const { bomCompleteness, productionRevisionPolicy } = require('../src/prisma/services/mbomGovernanceService');
const { withBusinessDate } = require('../src/prisma/utils/businessClock');

function unit() {
  const child = { id: 'detail', partId: 'part', part: { id: 'part', partCode: 'P-1', supplierId: 'supplier' }, category: 'Purchase', qty: 1, uomCode: 'pcs' };
  const header = { id: 'bom', partId: 'root', part: { id: 'root' }, uomCode: 'pcs', details: [child] };
  const context = { machines: [], dies: [], costs: new Map([['bom', { lines: 1, covered: 1 }]]), headers: new Map(), vendorAssignments: [] };
  assert.equal(bomCompleteness(header, context).complete, true);
  assert.equal(bomCompleteness({ ...header, details: [] }, context).complete, false);
  assert.equal(bomCompleteness({ ...header, details: [{ ...child, qty: 0 }] }, context).complete, false);
  const supplied = { ...child, materialSupplyType: 'CUSTOMER_SUPPLIED', supplyCustomerId: 'customer' };
  assert.equal(bomCompleteness({ ...header, details: [supplied] }, context).complete, true);
  assert.equal(bomCompleteness({ ...header, details: [{ ...supplied, supplyCustomerId: null }] }, context).complete, false);
  context.costs.set('bom', { lines: 1, covered: 0 });
  assert(bomCompleteness(header, context).issues.some(row => row.group === 'Harga'));
  context.costs.clear();
  const inhouse = { ...child, category: 'inHouse', mbomProcesses: [] };
  assert(bomCompleteness({ ...header, details: [inhouse] }, context).issues.some(row => row.group === 'Routing'));
  const linked = { ...header, details: [{ ...child, part: { ...child.part, mbomHeaders: [{ id: 'nested', noReg: 'NESTED' }] } }] };
  context.headers.set('nested', { id: 'nested', details: [] });
  assert(bomCompleteness(linked, context).issues.some(row => row.group === 'BOM Turunan'));
  console.log('PASS completeness: complete, empty, invalid qty, customer ownership, missing cost, routing, child BOM');
}

// Opt-in DB integration: all fixture creation, controller saves, MRP dirty flags,
// production evidence, and new revisions are in one ALWAYS-ROLLED-BACK transaction.
// Numbering and notifications are replaced so no external counter/message changes.
async function integration() {
  const { prisma } = require('../src/prisma');
  const rollback = new Error('GOVERNANCE_TEST_ROLLBACK');
  const tag = `QA-BOM-${randomUUID()}`;
  try {
    await prisma.$transaction(async tx => {
      const master = await tx.mBOMHeader.findFirst({ where: { isDeleted: false, partId: { not: null }, uomCode: { not: null } }, include: { details: { where: { isDeleted: false, category: 'Purchase' } } } });
      assert(master?.details.length, 'An existing BOM with a purchase detail is required for FK-only fixtures');
      const max = await tx.mBOMHeader.aggregate({ where: { partId: master.partId }, _max: { revision: true } });
      const source = await tx.mBOMHeader.create({ data: { noReg: tag, partId: master.partId, uomCode: master.uomCode, revision: (max._max.revision || 1) + 1, effectiveDate: new Date('2026-07-01T00:00:00Z'), notes: 'Original fixture' } });
      const originalDetail = await tx.mBOMDetail.create({ data: { noReg: tag, partId: master.details[0].partId, uomCode: master.details[0].uomCode, qty: 1, category: 'Purchase' } });
      const mo = await tx.manufacturingOrder.create({ data: { moNumber: tag, qtyPlanned: 1, status: 'Draft' } });
      const wo = await tx.workOrder.create({ data: { woNumber: tag, moId: mo.id, mbomDetailId: originalDetail.id, plannedDate: new Date('2026-07-01'), plannedQty: 1, status: 'Planned' } });
      const fresh = () => tx.mBOMHeader.findUnique({ where: { id: source.id }, include: { part: true, details: { include: { mbomProcesses: true } } } });
      assert.equal((await productionRevisionPolicy(tx, await fresh())).usedInProduction, false, 'Draft/planned production must not force revision');

      const filename = path.resolve(__dirname, '../src/prisma/controllers/mbom/BOMController.js');
      const realRequire = createRequire(filename);
      const proxy = new Proxy(tx, { get(target, key) { return key === '$transaction' ? async callback => callback(tx) : target[key]; } });
      const module = { exports: {} };
      const fakeRequire = id => {
        if (id === '../../index') return { prisma: proxy };
        if (id === '../../services/numberingService') return { generateConfiguredNumber: async () => `${tag}-REV` };
        if (id === '../../utils/notificationHelper') return { notificationHelper: { notifyMBOM: async () => {} } };
        return realRequire(id);
      };
      vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: fakeRequire, module, exports: module.exports, console: { ...console, error() {} }, Date, Set, Map, Buffer }, { filename });
      const controller = module.exports;
      async function save(id, body) {
        let result, status = 200;
        const res = { status(value) { status = value; return this; }, json(value) { result = value; return this; } };
        await controller.update({ params: { id }, body, user: { username: 'rollback-test' } }, res, e => { throw e; });
        return { status, result };
      }
      const corrected = await save(source.id, { revisionMode: 'newRevision', header: { notes: 'Corrected fixture', revision: 9999 }, details: [{ ...originalDetail, qty: 2 }] });
      assert.equal(corrected.status, 200, JSON.stringify(corrected.result));
      assert.equal(corrected.result.id, source.id);
      assert.equal(corrected.result.revision, source.revision, 'Client revision and manual newRevision cannot override unused policy');
      assert.equal(corrected.result.savedAsNewRevision, false);
      assert.equal(corrected.result.details[0].id, originalDetail.id);
      assert.equal(corrected.result.details[0].qty, 2);

      await tx.workOrder.update({ where: { id: wo.id }, data: { status: 'Released' } });
      assert.equal((await productionRevisionPolicy(tx, await fresh())).usedInProduction, true);
      const before = await fresh();
      const revised = await save(source.id, { revisionMode: 'correction', header: { notes: 'New fixture', revisionNote: 'Change after WO release', effectiveDate: '2026-08-01', expirePreviousRevision: false }, details: [{ ...originalDetail, qty: 3 }] });
      assert.equal(revised.status, 201, JSON.stringify(revised.result));
      assert.equal(revised.result.savedAsNewRevision, true);
      assert.notEqual(revised.result.id, source.id);
      assert.equal(revised.result.revision, source.revision + 1);
      assert.equal(revised.result.revisionOfMbomId, source.id);
      assert.equal(revised.result.uomCode, source.uomCode, 'Partial edits must preserve header UOM on a new revision');
      assert.notEqual(revised.result.details[0].id, originalDetail.id);
      assert.equal(revised.result.details[0].qty, 3);
      const after = await fresh();
      assert.deepEqual(after.details, before.details, 'Original production details must remain unchanged');
      assert.equal(after.notes, before.notes);
      assert(after.expiryDate < new Date(revised.result.effectiveDate));
      assert.equal((await tx.workOrder.findUnique({ where: { id: wo.id } })).mbomDetailId, originalDetail.id);
      assert.equal((await save(source.id, { header: { notes: 'stale editor' } })).status, 409);
      assert.equal((await productionRevisionPolicy(tx, revised.result)).usedInProduction, false, 'Old revision usage must not leak onto its new revision');

      await tx.workOrder.update({ where: { id: wo.id }, data: { status: 'Cancelled', qtyProduced: 1, isDeleted: true } });
      assert.equal((await productionRevisionPolicy(tx, await fresh())).usedInProduction, true, 'Actual production stays evidence after cancellation/soft deletion');
      await tx.workOrder.update({ where: { id: wo.id }, data: { qtyProduced: 0 } });
      const vendor = await tx.vendorProcessOrder.create({ data: { orderNumber: tag, moId: mo.id, moNumber: mo.moNumber, mbomDetailId: originalDetail.id, status: 'Sent', qtySent: 1 } });
      assert.equal((await productionRevisionPolicy(tx, await fresh())).usedInProduction, true, 'Vendor detail-only evidence must be detected');
      await tx.vendorProcessOrder.update({ where: { id: vendor.id }, data: { status: 'Cancelled', qtySent: 0 } });
      assert.equal((await productionRevisionPolicy(tx, await fresh())).usedInProduction, false);
      console.log('PASS transactional integration: unused in-place edit, released WO auto-revision, immutable old details, exact revision references, historical edit conflict, cancelled actual production, vendor evidence');
      throw rollback;
    }, { timeout: 30000 });
  } catch (error) { if (error !== rollback) throw error; }
  finally {
    assert.equal(await prisma.mBOMHeader.count({ where: { noReg: { startsWith: tag } } }), 0, 'Fixture transaction must be rolled back');
    await prisma.$disconnect();
  }
  console.log('PASS rollback: no test BOM, production evidence, or MRP flags committed');
}

unit();
if (process.argv.includes('--integration')) withBusinessDate('2026-08-20', integration).then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
