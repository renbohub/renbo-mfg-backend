const assert = require('node:assert/strict');
const { test } = require('node:test');
const { processDiesIds, assertBomDiesPartRelations } = require('../src/prisma/services/bomDiesPartService');
const die = (id, partId, extra = {}) => ({ id, status: 'Active', isDeleted: false, diesParts: [{ partId, isActive: true }], ...extra });
function database(items, partId = 'child') {
  return {
    mBOMDetail: { findUnique: async ({ where }) => { assert.equal(where.id, 'detail'); return { partId }; } },
    dies: { findMany: async ({ where }) => {
      assert.equal(where.diesParts.some.partId, partId);
      assert.equal(where.diesParts.some.isActive, true);
      assert.equal(where.isDeleted, false);
      assert.equal(where.status, 'Active');
      return items.filter(d => where.id.in.includes(d.id) && !d.isDeleted && d.status === 'Active' && d.diesParts.some(p => p.partId === partId && p.isActive));
    } },
  };
}
const items = [die('correct', 'child'), die('other', 'different'), die('inactive', 'child', { diesParts: [{ partId: 'child', isActive: false }] }), die('deleted', 'child', { isDeleted: true }), die('retired', 'child', { status: 'Retired' })];
test('accept related dies in legacy, resource and nested alternative fields', async () => {
  const route = { diesId: 'correct', machinePlanningPolicy: { resources: [{ diesId: 'correct' }], execution: { inhouse: { diesId: 'correct', machinePlanningPolicy: { resources: [{ diesId: 'correct' }] } } } } };
  assert.deepEqual(processDiesIds(route), ['correct']);
  await assertBomDiesPartRelations(database(items), 'detail', [route]);
});
test('reject unlinked, inactive, deleted, retired and forged part selections', async () => {
  for (const id of ['other', 'inactive', 'deleted', 'retired', 'missing']) {
    const shapes = [ { diesId: id }, { machinePlanningPolicy: { resources: [{ diesId: id }] } }, { machinePlanningPolicy: { execution: { inhouse: { diesId: id } } } }, { machinePlanningPolicy: { execution: { inhouse: { machinePlanningPolicy: { resources: [{ diesId: id }] } } } } } ];
    for (const shape of shapes) await assert.rejects(() => assertBomDiesPartRelations(database(items), 'detail', [{ ...shape, mbomDetail: { partId: 'different' } }]), e => e.statusCode === 400);
  }
});
test('no tooling remains valid; malformed IDs/resources cannot bypass relation validation', async () => {
  await assertBomDiesPartRelations({}, 'detail', [{ cycleTime: 6 }, { diesId: null }]);
  assert.throws(() => processDiesIds({ diesId: { connect: { id: 'correct' } } }), /tidak valid/);
  assert.throws(() => processDiesIds({ machinePlanningPolicy: { resources: {} } }), /tidak valid/);
  await assert.rejects(() => assertBomDiesPartRelations(database(items, null), 'detail', [{ diesId: 'correct' }]), e => e.statusCode === 400);
});
