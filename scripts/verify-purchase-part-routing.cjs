const test = require('node:test');
const assert = require('node:assert/strict');
const db = {};
require.cache[require.resolve('../src/prisma/index')] = { exports: { prisma: db } };
const controller = require('../src/prisma/controllers/engineering/RoutingController');
const service = require('../src/prisma/services/engineering/partRoutingService');
const { normalizePurchasePartCategory } = require('../src/prisma/services/engineering/purchasePartCategory');
const { currentVendorPartIds, assertEligiblePricePart, priceEligibility } = require('../src/prisma/services/pricing/bomVendorPartEligibility');

const part = { id: 'part-a', partCode: 'PART-A', partName: 'Fixture', itemType: 'RAW', rawType: 'PURCHASE_PART', category: 'PD', status: 'Active', isDeleted: false };
const proc = { id: 'process-a', processCode: 'PROC-A', processName: 'Fixture process', isDeleted: false };
const body = () => ({ routingCode: 'ROUTE-A', partId: part.id, status: 'ACTIVE', operations: [{ sequence: 20, processId: proc.id }, { sequence: 10, processId: proc.id, isSubcontract: true }] });
const existing = () => ({ id: 'route-a', ...body(), revision: '1', updatedAt: new Date('2026-08-01'), isDeleted: false, part, operations: body().operations.map((op, i) => ({ ...op, id: `operation-${i}`, isActive: true })) });
function fixture({ row = null, linked = 0, processMissing = false, centerMissing = false } = {}) {
  const state = { row, writes: [], locks: 0, linked };
  const tx = {
    $queryRaw: async () => { state.locks++; return []; },
    part: { findFirst: async ({ where }) => where.OR.some(condition => Object.values(condition).includes(part.id) || Object.values(condition).includes(part.partCode)) ? part : { ...part, id: 'part-b' } },
    process: { findMany: async ({ where }) => processMissing ? [] : where.id.in.includes(proc.id) ? [proc] : [] },
    workCenter: { count: async ({ where }) => { assert.equal(where.isActive, true); return centerMissing ? 0 : where.id.in.length; } },
    mBOMProcess: { count: async () => state.linked },
    routingOperation: {
      deleteMany: async args => { state.writes.push(['deleteOperations', args]); return { count: state.row.operations.length }; },
      updateMany: async args => { state.writes.push(['deactivateOperations', args]); return { count: state.row.operations.length }; },
    },
    routingHeader: {
      findFirst: async () => state.row,
      findUnique: async () => state.row,
      create: async ({ data }) => {
        state.writes.push(['create', data]);
        state.row = { id: 'route-a', ...data, updatedAt: new Date(), part, operations: data.operations.create.map((op, i) => ({ ...op, id: `new-operation-${i}` })) };
        return state.row;
      },
      update: async ({ data }) => {
        state.writes.push(['update', data]);
        state.row = { ...state.row, ...data, ...(data.operations ? { operations: data.operations.create.map((op, i) => ({ ...op, id: `new-operation-${i}` })) } : {}) };
        return state.row;
      },
      findMany: async () => state.row ? [state.row] : [],
    },
  };
  const client = { ...tx, $transaction: async (fn, options) => { assert.equal(options.isolationLevel, 'Serializable'); return fn(tx); } };
  return { client, tx, state };
}
function response() { return { code: 200, body: null, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } }; }
async function runController(name, request, client) {
  for (const key of Object.keys(db)) delete db[key]; Object.assign(db, client);
  const res = response(); let error;
  await controller[name]({ params: {}, query: {}, ...request }, res, e => { error = e; });
  return { res, error };
}

test('purchase categories normalize PD/WD/MD while preserving unmapped and unchanged legacy values', () => {
  for (const category of [' pd ', 'wd', 'MD']) assert.equal(normalizePurchasePartCategory({ ...part, category }).category, category.trim().toUpperCase());
  assert.equal(normalizePurchasePartCategory({ category: 'wd' }, part).category, 'WD');
  assert.deepEqual(normalizePurchasePartCategory({ partName: 'Changed' }, { ...part, category: null }), { partName: 'Changed' });
  assert.equal(normalizePurchasePartCategory({ category: 'Legacy' }, { ...part, category: 'Legacy' }).category, 'Legacy');
  assert.throws(() => normalizePurchasePartCategory({ ...part, category: 'UNKNOWN' }), e => e.statusCode === 400);
});

test('vendor scope selects current highest BOM revision and excludes routing-only Vendor, deleted and future entries', () => {
  const header = (id, revision, details, extra = {}) => ({ id, partId: 'fg-a', revision, effectiveDate: new Date('2026-01-01'), details, ...extra });
  const vendor = partId => ({ partId, category: 'Vendor', isDeleted: false });
  const headers = [
    header('old', 1, [vendor('old-vendor')]),
    header('current', 2, [vendor('current-vendor'), { partId: 'routing-only', category: 'Purchase', mbomProcesses: [{ routingMode: 'VENDOR' }] }, { ...vendor('deleted'), isDeleted: true }]),
    header('future', 3, [vendor('future-vendor')], { effectiveDate: new Date('2027-01-01') }),
    header('expired', 9, [vendor('expired-vendor')], { expiryDate: new Date('2026-07-01') }),
    header('deleted-header', 4, [vendor('deleted-header-vendor')], { isDeleted: true }),
    header('inactive-root', 1, [vendor('inactive-root-vendor')], { partId: 'fg-inactive', part: { status: 'Inactive' } }),
  ];
  assert.deepEqual(currentVendorPartIds(headers, new Date('2026-08-20')), ['current-vendor']);
  headers[1].details = [{ partId: 'current-vendor', category: 'inHouse' }];
  assert.deepEqual(currentVendorPartIds(headers, new Date('2026-08-20')), [], 'an older Vendor revision must not keep a price eligible');
});

test('price guard enforces active Purchase Part and current Vendor BOM, rejecting nested relation bypass', async () => {
  const client = { part: { findFirst: async () => part }, mBOMHeader: { findMany: async () => [{ id: 'bom', partId: 'fg', revision: 1, details: [{ partId: part.id, category: 'Vendor' }] }] } };
  assert.equal((await assertEligiblePricePart(client, { partId: part.id }, { purchaseOnly: true })).id, part.id);
  for (const key of ['part', 'supplier', 'vendor', 'customer', 'currency']) await assert.rejects(() => assertEligiblePricePart(client, { partId: part.id, [key]: { connect: { id: 'bypass' } } }), e => e.code === 'BOM_VENDOR_PART_REQUIRED');
  client.mBOMHeader.findMany = async () => [];
  await assert.rejects(() => assertEligiblePricePart(client, { partId: part.id }), /kategori Vendor/);
  client.part.findFirst = async () => ({ ...part, status: 'Inactive' });
  await assert.rejects(() => assertEligiblePricePart(client, { partId: part.id }), /tidak aktif/);
  client.part.findFirst = async () => ({ ...part, rawType: 'MATERIAL' });
  await assert.rejects(() => assertEligiblePricePart(client, { partId: part.id }, { purchaseOnly: true }), /Purchase Part/);
  assert.equal(priceEligibility(part, []).label, 'Histori saja');
  assert.equal(priceEligibility(part, [part.id], true).eligible, true);
});

test('routing input rejects malformed rows, duplicate sequences, invalid flags/numbers and nested mutations', () => {
  for (const input of [null, [], { ...body(), operations: [null] }, { ...body(), operations: ['bad'] }, { ...body(), operations: [[]] }, { ...body(), operations: [{ sequence: 1, processId: proc.id }, { sequence: 1, processId: proc.id }] }, { ...body(), operations: [{ sequence: 1, processId: proc.id, isSubcontract: 'false' }] }, { ...body(), operations: [{ sequence: 1, processId: proc.id, yieldPercent: 101 }] }, { ...body(), operations: [{ sequence: 1, processId: proc.id, cycleSeconds: -1 }] }, { ...body(), operations: [] }, { ...body(), part: { connect: { id: 'other' } } }]) assert.throws(() => service.routingInput(input), e => e.statusCode === 400);
  const input = service.routingInput(body());
  assert.deepEqual(input.operations.map(op => op.sequence), [10, 20]);
  assert.equal(input.operations[0].isSubcontract, true);
});

test('create controller saves ordered process references in purchase-part context and enriches the result', async () => {
  const f = fixture(); const { res, error } = await runController('createRouting', { params: { partKey: part.partCode }, body: body() }, f.client);
  assert.equal(error, undefined); assert.equal(res.code, 201);
  assert.deepEqual(res.body.operations.map(op => op.sequence), [10, 20]);
  assert.equal(res.body.operations[0].process.processCode, proc.processCode);
  assert.equal(f.state.writes[0][1].partId, part.id);
});

test('update controller locks and replaces unused routing operations with optimistic concurrency', async () => {
  const f = fixture({ row: existing() });
  const { res, error } = await runController('updateRouting', { params: { key: 'route-a', partKey: part.id }, body: { ...body(), expectedUpdatedAt: '2026-08-01T00:00:00.000Z', notes: 'Updated' } }, f.client);
  assert.equal(error, undefined); assert.equal(res.body.notes, 'Updated'); assert.equal(f.state.locks, 1);
  assert.deepEqual(f.state.writes.map(row => row[0]), ['deleteOperations', 'update']);
});

test('delete controller soft-deletes unused header and disables operations without deleting price or part records', async () => {
  const f = fixture({ row: existing() });
  const { res, error } = await runController('removeRouting', { params: { key: 'route-a', partKey: part.id } }, f.client);
  assert.equal(error, undefined); assert.equal(res.body.ok, true);
  assert.deepEqual(f.state.writes.map(row => row[0]), ['deactivateOperations', 'update']);
  assert.deepEqual(f.state.writes[1][1], { isDeleted: true, status: 'INACTIVE' });
});

test('routing used by any BOM cannot be changed or deleted', async () => {
  for (const name of ['updateRouting', 'removeRouting']) {
    const f = fixture({ row: existing(), linked: 1 });
    const { error } = await runController(name, { params: { key: 'route-a', partKey: part.id }, body: body() }, f.client);
    assert.equal(error.statusCode, 409); assert.equal(f.state.writes.length, 0);
  }
});

test('purchase routing rejects cross-part edits and spoofed part IDs before writes', async () => {
  let f = fixture({ row: { ...existing(), partId: 'part-b' } });
  await assert.rejects(() => service.saveRouting(f.client, body(), { key: 'route-a', partKey: part.id }), e => e.statusCode === 404);
  assert.equal(f.state.writes.length, 0);
  f = fixture(); await assert.rejects(() => service.saveRouting(f.client, { ...body(), partId: 'part-b' }, { partKey: part.id }), e => e.statusCode === 400);
  assert.equal(f.state.writes.length, 0);
  f = fixture({ row: { ...existing(), partId: 'part-b' } }); await assert.rejects(() => service.removeRouting(f.client, 'route-a', part.id), e => e.statusCode === 404);
  assert.equal(f.state.writes.length, 0);
});

test('stale edits and missing/inactive master references cannot modify a routing', async () => {
  let f = fixture({ row: existing() });
  await assert.rejects(() => service.saveRouting(f.client, { ...body(), expectedUpdatedAt: '2026-01-01' }, { key: 'route-a' }), e => e.statusCode === 409); assert.equal(f.state.writes.length, 0);
  f = fixture({ processMissing: true }); await assert.rejects(() => service.saveRouting(f.client, body()), /Proses tidak ditemukan/); assert.equal(f.state.writes.length, 0);
  f = fixture({ centerMissing: true }); await assert.rejects(() => service.saveRouting(f.client, { ...body(), operations: [{ sequence: 10, processId: proc.id, workCenterId: 'inactive-center' }] }), /Work center tidak aktif/); assert.equal(f.state.writes.length, 0);
});

function linkFixture(override = {}) {
  const state = { writes: [], locks: 0 };
  const operation = { id: 'operation-a', isActive: true, yieldPercent:100, isSubcontract:false, processId: proc.id, routingHeaderId: 'route-a', routingHeader: { id: 'route-a', partId: part.id, status: 'ACTIVE', isDeleted: false }, ...override.operation };
  const bom = { id: 'bom-process', processId: proc.id, process: proc, mbomDetail: { partId: part.id, isDeleted: false, part, mbomHeader: { isDeleted: false } }, ...override.bom };
  const tx = { workOrder:{count:async()=>override.used?1:0},dailyProductionSchedule:{count:async()=>0},vendorProcessOrder:{count:async()=>0},$queryRaw: async () => { state.locks++; return []; }, routingOperation: { findUnique: async () => operation }, mBOMProcess: { findFirst: async () => bom, update: async ({ data }) => { state.writes.push(data); return { ...bom, ...data }; } } };
  return { state, client: { $transaction: async (fn, options) => { assert.equal(options.isolationLevel, 'Serializable'); return fn(tx); } } };
}
test('BOM routing link checks same component part and process, then permits explicit unlink', async () => {
  const f = linkFixture(); const linked = await service.linkMbomProcess(f.client, 'bom-process', { routingOperationId: 'operation-a' });
  assert.equal(linked.routingOperationId, 'operation-a'); assert.equal(f.state.locks, 2);
  const unlinked = await service.linkMbomProcess(f.client, 'bom-process', { routingOperationId: null });
  assert.equal(unlinked.routingOperationId, null); assert.equal(f.state.locks, 3);
});

test('BOM routing links reject cross-part/process, inactive/deleted master and omitted unlink value without writes', async () => {
  for (const override of [
    { operation: { routingHeader: { partId: 'other', status: 'ACTIVE' } } },
    { operation: { processId: 'other-process' } },
    { operation: { isActive: false } },
    { operation: { routingHeader: { partId: part.id, status: 'DRAFT' } } },
    { operation: { routingHeader: { partId: part.id, status: 'ACTIVE', isDeleted: true } } },
    { bom: { process: { ...proc, isDeleted: true } } },
    { bom: { mbomDetail: { partId: part.id, isDeleted: true } } },
  ]) {
    const f = linkFixture(override); await assert.rejects(() => service.linkMbomProcess(f.client, 'bom-process', { routingOperationId: 'operation-a' }), e => [400, 404, 409].includes(e.statusCode)); assert.equal(f.state.writes.length, 0);
  }
  for (const body of [{}, { routingOperationId: '' }, { routingOperationId: null, processId: proc.id }]) await assert.rejects(() => service.linkMbomProcess({}, 'bom-process', body), e => e.statusCode === 400);
});

test('BOM operation links reject execution references, stale version, mode mismatch and zero yield',async()=>{for(const override of [{used:true},{bom:{updatedAt:'2026-09-02'}},{operation:{isSubcontract:true}},{operation:{yieldPercent:0}}]){const f=linkFixture(override);await assert.rejects(()=>service.linkMbomProcess(f.client,'bom-process',{routingOperationId:'operation-a',...(override.bom?{expectedUpdatedAt:'2026-09-01'}:{})}),e=>[400,409].includes(e.statusCode));assert.equal(f.state.writes.length,0);}});
